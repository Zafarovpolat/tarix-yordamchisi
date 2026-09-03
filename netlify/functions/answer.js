// Серверная функция: единственное место, где используется API-ключ Groq.
// Браузер сюда шлёт вопрос + язык. Сначала функция проверяет проверенную
// базу фактов школьной программы (facts-db.json) — при совпадении отвечает
// мгновенно и бесплатно, без обращения к Wikipedia и Groq. Только если
// совпадения нет — идёт резервный путь через Wikipedia + Groq.
//
// Формат V1 (exports.handler) — намеренно, ради надёжности при обычном
// перетаскивании папки на Netlify без сборки. Groq-API бесплатный, поэтому
// отдельной защиты от денежных трат не требуется; у бесплатного тарифа есть
// только лимиты запросов в минуту (см. README).

// База фактов инлайнится прямо в бандл функции через require — иначе Netlify
// не кладёт JSON рядом с собранной функцией, и чтение с диска (readFileSync)
// падает с ENOENT: /var/task/facts-db.json. require() esbuild инлайнит, а nft
// трассирует как зависимость — работает при любом бандлере.
const factsDb = require('./facts-db.json');

// Все варианты апострофа, которыми на практике пишут узбекскую латиницу:
// ʻ (U+02BB) и ʼ (U+02BC) — орфографически правильные, ’ (U+2019) — из Word,
// ' (U+0027) и обратная кавычка (U+0060) — с обычной клавиатуры. В нашей базе
// фактов их 595 в ключевых словах и 6969 в узбекских ответах.
const APOSTROPHES = /[\u02BB\u02BC\u2018\u2019\u0060\u00B4']/g;

// Убирает пунктуацию и лишние пробелы, приводит к нижнему регистру — нужно,
// чтобы сравнение вопроса с ключевыми словами не зависело от знаков препинания
// или регистра букв.
//
// ГЛАВНОЕ ОТЛИЧИЕ ОТ ОБЫЧНОЙ НОРМАЛИЗАЦИИ: апостроф УДАЛЯЕТСЯ, а не заменяется
// пробелом. В узбекской латинице апостроф — часть буквы (oʻ, gʻ) или гортанная
// смычка (aʼ), то есть часть слова, а не знак препинания. При этом
// распознавание речи (Whisper) его почти никогда не ставит: сказанное
// «tugʻilgan» приходит текстом как «tugilgan». Пока апостроф превращался в
// пробел, ключ «tug'ilgan» давал «tug ilgan» и не совпадал ни с чем — так
// терялась четверть узбекских ключевых слов (443 из 1768). Теперь и ключ, и
// вопрос сводятся к «tugilgan» и совпадают. Заодно снимается разнобой в самих
// апострофах: oʻzbek / o'zbek / o’zbek — после нормализации это одна строка.
function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Пределы, от которых зависит поиск по базе фактов.
// MIN_KEYWORD_LEN — страховка на будущее: сейчас в базе нет ключей короче
// четырёх символов (самые короткие — «гёзы», «илоты», «miken»), но если кто-то
// добавит ключ вроде «рим», он начнёт совпадать со всем подряд.
const MIN_KEYWORD_LEN = 4;
// MAX_SUFFIX_LEN — сколько букв слово может продолжаться после ключа (см.
// keywordMatches ниже). 6 выбрано под узбекские цепочки аффиксов («-lariga»).
const MAX_SUFFIX_LEN = 6;

// Ключевые слова нормализуются ОДИН РАЗ при загрузке функции, а не на каждый
// запрос. Раньше normalize() вызывался ~1800 раз на каждый вопрос — по одному
// на каждое ключевое слово нужного языка, по три регулярки на строку. Теперь
// это делается один раз за время жизни инстанса функции, а сам поиск сводится
// к сравнению готовых строк. Сортируем по длине: при прочих равных первым
// срабатывает более конкретное (длинное) совпадение.
function prepareKeywords(list) {
  const seen = new Set();
  const out = [];
  for (const kw of list || []) {
    const norm = normalize(kw);
    if (norm.length < MIN_KEYWORD_LEN || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.sort((a, b) => b.length - a.length);
}

const FACTS_INDEX = factsDb.map((entry) => ({
  entry,
  ru: prepareKeywords(entry.keywords_ru),
  uz: prepareKeywords(entry.keywords_uz),
}));

// Проверяет, встречается ли ключ в вопросе КАК СЛОВО, а не как случайная
// подстрока. Раньше проверка была q.includes(kw), и короткий ключ мог
// «найтись» в середине постороннего слова. Теперь ключ обязан начинаться на
// границе слова, но слово может продолжаться после него не больше чем на
// MAX_SUFFIX_LEN букв — это грамматическое окончание, а не другое слово:
//   «тамерлан»   + «е»      -> «о тамерлане»    совпадает (русский падеж)
//   «temuriylar» + «ning»   -> «temuriylarning» совпадает (узбекский аффикс)
//   «микены»     + «частью» -> «микенычастью»   НЕ совпадает
// Вопрос приходит уже с ведущим пробелом (padded) — так и первое слово вопроса
// считается началом слова.
function keywordMatches(padded, kw) {
  let from = 0;
  for (;;) {
    const at = padded.indexOf(' ' + kw, from);
    if (at === -1) return false;
    const end = at + 1 + kw.length;
    let tail = 0;
    while (end + tail < padded.length && padded[end + tail] !== ' ') tail += 1;
    if (tail <= MAX_SUFFIX_LEN) return true;
    from = at + 1;
  }
}

// Ищет в базе фактов запись, наиболее релевантную вопросу. Осознанно без
// эмбеддингов и векторного поиска — для базы на несколько сотен тем хватает
// сравнения ключевых слов, зато нет ни одной лишней зависимости.
//
// Вес совпадения — ЕГО ДЛИНА В СИМВОЛАХ, а не единица. Раньше все совпадения
// весили одинаково, поэтому запись, зацепившаяся коротким общим ключом,
// выигрывала у записи с длинным конкретным ключом просто потому, что шла раньше
// в базе. Теперь «когда родился амир темур» (24 символа) уверенно перебивает
// случайное «микены» (6), а несколько совпадений внутри одной записи
// складываются.
function findInFactsDb(question, lang) {
  const q = normalize(question);
  if (!q) return null;
  const padded = ' ' + q;
  let best = null;
  let bestScore = 0;
  for (const row of FACTS_INDEX) {
    let score = 0;
    for (const kw of row[lang]) {
      if (keywordMatches(padded, kw)) score += kw.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = row.entry;
    }
  }
  return best;
}

// Наборы слов-филлеров — разговорных обёрток, которые сами по себе не несут
// темы, но ломают полнотекстовый поиск Wikipedia (он считает «расскажи»,
// «подробно», «haqida» значимыми словами и выдаёт по ним мусорные статьи —
// проверено: «Подробно расскажи про Вторую мировую войну» находило
// «Автобиографию Кристи»). Удаляем эти слова в ЛЮБОМ месте фразы, а не только
// по краям, — так одинаково чисто обрабатываются и «Подробно расскажи про X»,
// и «X haqida batafsil gapir». Узбекские слова храним с прямым апострофом (').
const QUERY_FILLERS_RU = new Set([
  'подробно', 'подробнее', 'кратко', 'вкратце', 'коротко', 'расскажи', 'расскажите',
  'поведай', 'опиши', 'объясни', 'объясните', 'пожалуйста', 'про', 'об', 'обо', 'о',
  'мне', 'что', 'такое', 'кто', 'такой', 'такая', 'такие', 'это', 'знаешь', 'можешь',
  'дай', 'информацию', 'информация', 'известно', 'когда', 'где', 'почему', 'зачем',
  'как', 'сколько', 'какой', 'какая', 'какие', 'какое', 'и', 'её', 'его', 'их',
]);
const QUERY_FILLERS_UZ = new Set([
  'haqida', "to'g'risida", 'batafsil', 'qisqacha', 'gapirib', 'gapir', "so'zla",
  "so'zlab", 'ayt', 'aytib', "ma'lumot", "ma'lumotlar", 'yoz', 'tushuntir',
  'tushuntirib', 'ber', 'bering', 'nima', 'kim', 'qachon', 'qayerda', 'nega',
  'qanday', 'edi', "bo'lgan", "bo'ladi", 'menga', 'iltimos', 'va', 'uning',
]);

// Приводит разговорный вопрос к чистому поисковому запросу для Wikipedia,
// вырезая слова-филлеры (см. наборы выше). «Подробно расскажи про Вторую
// мировую войну» → «Вторую мировую войну …», «Amir Temur haqida gapirib ber»
// → «Amir Temur». Оригинальный вопрос при этом НЕ меняется и уходит в модель
// как есть — чистка нужна только для поискового запроса к Wikipedia.
function cleanQuery(question, lang) {
  const fillers = lang === 'uz' ? QUERY_FILLERS_UZ : QUERY_FILLERS_RU;
  // Узбекские апострофы пишут по-разному (oʻ / o' / o`) — приводим к прямому ('),
  // чтобы сравнение токенов с набором филлеров было надёжным.
  const normalizeToken = lang === 'uz'
    ? (tok) => tok.replace(/[ʻʼ`']/g, "'")
    : (tok) => tok;

  const kept = question
    .replace(/[?!.,;:()"«»]/gu, ' ') // пунктуацию превращаем в пробелы
    .split(/\s+/)
    .filter((tok) => tok && !fillers.has(normalizeToken(tok.toLowerCase())));

  const q = kept.join(' ').trim();
  // Если после чистки почти ничего не осталось (вопрос был из одних филлеров) —
  // безопаснее искать по оригиналу.
  return q.length >= 2 ? q : question.trim();
}

// Максимальная длина вопроса — проверка в обработчике ниже.
const MAX_QUESTION_LEN = 300;

// Кэш ответов РЕЗЕРВНОГО пути (Wikipedia + Groq) в памяти инстанса функции.
// Путь по базе фактов кэшировать нечего — он и так локальный и быстрый.
// ЧЕСТНОЕ ОГРАНИЧЕНИЕ: инстансы Netlify Functions изолированы и засыпают,
// поэтому кэш ускоряет только повторный вопрос в «тёплый» инстанс — типичный
// случай для киоска, где подряд спрашивают одно и то же. Постоянного кэша
// между запусками он не заменяет; для этого нужна внешняя база.
const ANSWER_CACHE_MAX = 200;
const ANSWER_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 часов
const answerCache = new Map();

// Ключ строим из нормализованного вопроса, поэтому «Кто такой Амир Темур?» и
// «кто такой амир темур» — одна и та же запись кэша.
function cacheKey(question, lang) {
  return lang + '|' + normalize(question);
}

function cacheGet(key) {
  const hit = answerCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ANSWER_CACHE_TTL_MS) {
    answerCache.delete(key);
    return null;
  }
  return hit.payload;
}

function cacheSet(key, payload) {
  // Map хранит ключи в порядке вставки, поэтому первый ключ итератора — самый
  // старый: его и вытесняем, когда кэш дорос до лимита.
  if (answerCache.size >= ANSWER_CACHE_MAX) {
    answerCache.delete(answerCache.keys().next().value);
  }
  answerCache.set(key, { at: Date.now(), payload });
}

exports.handler = async (event) => {
  // Netlify приводит имена заголовков к нижнему регистру; Origin нужен в КАЖДОМ
  // ответе, включая ошибки, иначе браузер не покажет их фронтенду.
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';

  // Предзапрос CORS: браузер отправляет его ДО основного запроса, без тела, и
  // ждёт только заголовки. Без этой ветки обращение с другого домена упиралось
  // бы в 405 ещё до POST.
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, origin);
  }

  // Простой общий токен между фронтендом и функцией — не настоящая
  // авторизация (виден в коде страницы), но отсекает случайных ботов,
  // которые просто перебирают адреса функций без загрузки самого сайта.
  const expectedToken = process.env.APP_SHARED_TOKEN;
  if (expectedToken) {
    const providedToken = event.headers['x-app-token'];
    if (providedToken !== expectedToken) {
      return json({ error: 'Unauthorized' }, 401, origin);
    }
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('Ошибка парсинга тела запроса:', e.message);
    return json({ error: 'Некорректный JSON' }, 400, origin);
  }

  const question = (body.question || '').trim();
  const lang = body.lang === 'uz' ? 'uz' : 'ru';
  console.log(`Вопрос: "${question}" | язык: ${lang}`);

  if (!question) {
    return json({ error: 'Поле question обязательно' }, 400, origin);
  }

  // Ограничение длины вопроса. Без него сюда можно отправить мегабайт текста:
  // он целиком ушёл бы и в поисковый запрос к Wikipedia, и в промпт Groq — то
  // есть чужой трафик оплачивался бы нашей квотой токенов. 300 символов с
  // запасом покрывают живой вопрос школьника (самый длинный ключ в базе
  // фактов — 77 символов).
  if (question.length > MAX_QUESTION_LEN) {
    return json({ error: `Вопрос слишком длинный: максимум ${MAX_QUESTION_LEN} символов` }, 413, origin);
  }

  console.log('Проверка ключа: GROQ_API_KEY', process.env.GROQ_API_KEY ? 'задан' : 'ОТСУТСТВУЕТ');

  // Шаг 1: проверенная база фактов школьной программы — быстро и бесплатно
  const factsMatch = findInFactsDb(question, lang);
  if (factsMatch) {
    console.log('Совпадение в базе фактов:', factsMatch.id);
    return json({
      has_answer: true,
      answer_text: lang === 'uz' ? factsMatch.answer_uz : factsMatch.answer_ru,
      topic: lang === 'uz' ? factsMatch.topic_uz : factsMatch.topic_ru,
      photo_url: factsMatch.photo_url || null,
      source_url: null,
      source_label: 'Проверено по школьной программе',
    }, 200, origin);
  }
  console.log('В базе фактов совпадений не найдено, идём в Wikipedia');

  const key = cacheKey(question, lang);
  const cachedPayload = cacheGet(key);
  if (cachedPayload) {
    console.log('Ответ взят из кэша инстанса');
    return json(cachedPayload, 200, origin);
  }

  // Шаг 2: резерв — Wikipedia + Groq. Ищем статью по очищенному запросу
  // (без разговорных обёрток), но оригинальный вопрос сохраняем для модели.
  const searchQuery = cleanQuery(question, lang);
  console.log(`Поисковый запрос к Wikipedia: "${searchQuery}"`);
  let wiki;
  try {
    wiki = await fetchWikiContext(searchQuery, lang);
    console.log('Wikipedia:', wiki ? `найдена статья "${wiki.title}" (${wiki.extract.length} симв.)` : 'ничего не найдено');

    // Узбекская Wikipedia намного меньше русской — если там не нашлось
    // ничего внятного, пробуем русскую версию как источник. Модель всё
    // равно отвечает на языке вопроса (см. системный промпт ниже), просто
    // опираясь на более богатый источник фактов.
    const tooShort = wiki && wiki.extract.length < 200;
    if (lang === 'uz' && (!wiki || tooShort)) {
      const ruFallback = await fetchWikiContext(searchQuery, 'ru');
      if (ruFallback && (!wiki || ruFallback.extract.length > wiki.extract.length)) {
        console.log('Узбекская статья недостаточна, используем русскую как источник:', ruFallback.title);
        wiki = ruFallback;
      }
    }
  } catch (err) {
    console.error('Ошибка запроса к Wikipedia:', err.message);
    return json({ error: 'Wikipedia недоступна: ' + err.message }, 502, origin);
  }

  if (!wiki) {
    return json({ has_answer: false }, 200, origin);
  }

  let result;
  try {
    result = await askGroq(question, lang, wiki.extract);
    console.log('Ответ Groq:', JSON.stringify(result));
  } catch (err) {
    console.error('Ошибка обращения к Groq API:', err.message);
    return json({ error: 'Groq API недоступен: ' + err.message }, 502, origin);
  }

  const payload = {
    has_answer: result.has_answer,
    answer_text: result.answer_text,
    topic: wiki.title,
    photo_url: wiki.thumbnail,
    source_url: wiki.sourceUrl,
    source_label: 'Wikipedia',
  };
  // Кэшируем только удачные ответы: «не знаю» лучше перепроверить в следующий
  // раз — Wikipedia могла просто не найти статью по неудачной формулировке.
  if (result.has_answer) cacheSet(key, payload);
  return json(payload, 200, origin);
};

// ── CORS ───────────────────────────────────────────────────────────────────
// Белый список тот же, что в tts.js, stt.js и photo.js. Киоск обращается к
// функции со своего домена, поэтому в рабочем сценарии список ничего не меняет,
// но закрывает главный расход: без него любая страница в интернете могла бы
// задавать вопросы через нашу функцию и жечь нашу квоту Groq и Wikipedia.
// ALLOWED_ORIGINS — список через запятую в переменных окружения Netlify;
// значение '*' в этом списке возвращает прежнее «разрешено всем».
const DEFAULT_ORIGINS = [
  'https://tarix-yordamchisi-ai.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000',
];
const ORIGIN_LIST = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = ORIGIN_LIST.length ? ORIGIN_LIST : DEFAULT_ORIGINS;

// Origin возвращаем эхом только если он в списке, иначе отдаём первый из
// списка — браузер чужого сайта такой ответ отбросит сам. Vary: Origin
// обязателен: без него CDN раздал бы закэшированный заголовок всем подряд.
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    // Функция принимает только POST (плюс предзапрос) — GET здесь нет.
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-app-token',
    Vary: 'Origin',
  };
}

function json(obj, statusCode, origin) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Ответы уникальны для вопроса и языка, а POST на CDN и так не кэшируется;
      // явный no-store страхует от кэширования ошибок промежуточными прокси.
      // Повторные одинаковые вопросы всё равно отдаются мгновенно — из кэша
      // тёплого инстанса (answerCache выше).
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
    body: JSON.stringify(obj),
  };
}

// Находит наиболее релевантную статью Wikipedia и возвращает её текст+фото
// одним запросом (generator=search + extracts + pageimages).
async function fetchWikiContext(query, lang) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search`
    + `&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1`
    + `&prop=extracts|pageimages&exintro=1&explaintext=1&exchars=1500`
    + `&piprop=thumbnail&pithumbsize=500&format=json&origin=*`;

  // Wikipedia API требует описательный User-Agent от серверных клиентов —
  // без него отдаёт HTML-страницу с ошибкой вместо JSON.
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'TarixYordamchisi-prototype/1.0 (educational demo; https://tarix-yordamchisi.netlify.app)',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wikipedia вернула ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const pages = data.query && data.query.pages;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  if (!page || !page.extract) return null;
  return {
    title: page.title,
    extract: page.extract,
    thumbnail: page.thumbnail ? page.thumbnail.source : null,
    sourceUrl: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
  };
}

// Просим модель Groq ответить СТРОГО по найденному контексту, на языке вопроса,
// в формате JSON — так браузеру не нужно ничего парсить из свободного текста.
// Groq — бесплатный OpenAI-совместимый API (ключ GROQ_API_KEY, см. README).
async function askGroq(question, lang, context) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('переменная окружения GROQ_API_KEY не задана');

  const languageName = lang === 'ru' ? 'русский' : "o'zbek tili (узбекский)";

  const systemPrompt = `Ты — образовательный голосовой ассистент по истории для школьников в Узбекистане.
Отвечай, опираясь на текст в разделе "КОНТЕКСТ" ниже. Не добавляй факты, даты, имена
или события, которых нет в контексте, даже если знаешь их из общих данных.

Правила:
1. Если КОНТЕКСТ рассказывает о том же предмете, о котором спрашивает ученик — дай
   понятный краткий ответ (2-4 предложения, понятный школьнику) на языке: ${languageName},
   обобщив то, что есть в контексте. Даже если контекст раскрывает не все детали вопроса,
   всё равно ответь тем, что в нём есть, — не отказывай из-за нехватки подробностей.
2. Верни has_answer: false и пустой answer_text ТОЛЬКО если КОНТЕКСТ совсем о другом
   предмете (не о том, о ком/чём спрашивают), либо пуст, либо вопрос вообще не относится
   к истории или образованию.
3. Не давай личных оценок и не сравнивай исторических личностей или события в
   категориях "лучше/хуже", "правильно/неправильно".
4. Ответь СТРОГО в виде JSON, без каких-либо пояснений до или после, без markdown-разметки:
{"has_answer": true или false, "answer_text": "..."}`;

  const userMessage = `КОНТЕКСТ:\n${context}\n\nВОПРОС УЧЕНИКА:\n${question}`;

  // Groq использует OpenAI-совместимый формат: системный промпт идёт
  // отдельным сообщением с role: 'system'. response_format json_object
  // гарантирует, что модель вернёт валидный JSON (слово «JSON» в промпте —
  // обязательное требование этого режима, оно уже есть в правиле №4).
  //
  // Про модель: Groq периодически снимает старые модели с обслуживания и
  // меняет имена — если однажды придёт ошибка "model_not_found", актуальный
  // список моделей для вашего ключа можно получить так:
  //   curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
  // и подставить сюда любую чат-модель из списка (например, openai/gpt-oss-20b —
  // легче и быстрее). gpt-oss-120b выбрана как самая сильная в мультиязычии
  // (русский + узбекский) и следовании инструкциям.
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      max_tokens: 800,
      temperature: 0.2,
      // gpt-oss — reasoning-модель: по умолчанию тратит ~600 токенов на
      // внутренние рассуждения. На плотном контексте Wikipedia это исчерпывает
      // бюджет ещё до вывода JSON, и Groq возвращает 400 json_validate_failed
      // с пустым ответом. Для задачи «ответь по контексту в JSON» глубокое
      // рассуждение не нужно — reasoning_effort:'low' срезает его до ~50 токенов
      // и делает вывод стабильным (значения low/medium/high — см. доку Groq).
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${res.status} ${errText}`);
  }

  const data = await res.json();
  const raw = (data.choices && data.choices[0] && data.choices[0].message.content) || '{}';
  const cleaned = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return { has_answer: false, answer_text: '' };
  }
}
