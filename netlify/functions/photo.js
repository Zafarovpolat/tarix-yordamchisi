// Поиск фотографии к теме вопроса — отдельная функция, не часть answer.js.
//
// ПОЧЕМУ ОТДЕЛЬНО:
// 1) Все 689 записей facts-db.json имеют пустой photo_url. Значит на самом
//    частом пути (проверенная школьная программа) киоск НИКОГДА не показывал
//    фото — только заглушку с буквой. Именно это и есть «проблема с фото».
// 2) Найти картинку и её лицензию — это два запроса к Wikimedia (~0.6-1.2 с).
//    Внутри answer.js они задержали бы и текст ответа, и старт озвучки.
//    Поэтому фронтенд дёргает /photo ПАРАЛЛЕЛЬНО с /answer, и фото догоняет
//    уже говорящего аватара, встраиваясь в заранее зарезервированную рамку.
// 3) Лицензия. Киоск стоит в государственном учреждении, поэтому вместе с
//    фотографией мы отдаём автора и лицензию, а несвободные (fair use) файлы
//    не отдаём вообще — см. isFreeLicense.
//
// Зависимостей нет (как и в остальных функциях проекта), формат Netlify V1.

// Что и куда обрезаем. Тема приходит от пользователя, поэтому длину режем:
// поисковый запрос к Wikipedia с мегабайтом текста бессмыслен, но трафик
// оплачивался бы нами.
const MAX_TOPIC_LEN = 300;
// Ширина картинки под киоск: экран большой, но 800px хватает даже на половину
// ландшафтного макета, а вес файла остаётся приемлемым для мобильной сети.
const THUMB_WIDTH = 800;
// Wikipedia требует описательный User-Agent от серверных клиентов — без него
// отдаёт HTML с ошибкой вместо JSON (та же причина, что в answer.js).
const WIKI_UA = 'TarixYordamchisi-kiosk/1.0 (educational kiosk; https://tarix-yordamchisi-ai.netlify.app)';
// Таймаут на каждый запрос к Wikimedia. Фото — украшение ответа: лучше
// вернуть has_photo:false за 4 секунды, чем держать соединение до конца
// лимита функции и ничего не показать.
const WIKI_TIMEOUT_MS = 4000;
// Сколько результатов поиска просматриваем. У первой статьи картинки может не
// быть вообще (проверено: у uz-статьи «Registon» её нет, у ru-«Регистан» есть),
// поэтому берём три и выбираем первую статью С картинкой.
const SEARCH_LIMIT = 3;

// Кэш в памяти инстанса. То же честное ограничение, что у кэша в answer.js:
// инстансы изолированы и засыпают, поэтому кэш выручает только повторный вопрос
// в тёплый инстанс — для киоска, где подряд спрашивают одно и то же, это
// типичный случай. Отрицательный результат кэшируем тоже (и короче): без этого
// каждая тема без фото стоила бы два запроса к Wikimedia при каждом показе.
const CACHE_MAX = 300;
const CACHE_TTL_OK_MS = 24 * 60 * 60 * 1000; // 24 часа: фото у статьи меняются редко
const CACHE_TTL_MISS_MS = 30 * 60 * 1000;    // 30 минут: вдруг картинку добавили
const photoCache = new Map();

function cacheGet(key) {
  const hit = photoCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    photoCache.delete(key);
    return null;
  }
  return hit.payload;
}

function cacheSet(key, payload) {
  // Map хранит порядок вставки, поэтому первый ключ — самый старый.
  if (photoCache.size >= CACHE_MAX) {
    photoCache.delete(photoCache.keys().next().value);
  }
  const ttl = payload.has_photo ? CACHE_TTL_OK_MS : CACHE_TTL_MISS_MS;
  photoCache.set(key, { payload, expires: Date.now() + ttl });
}

// ============================================================================
// ЛИЦЕНЗИИ
// ============================================================================
// Свободные лицензии, которые реально встречаются в Wikimedia (проверено
// живыми запросами): cc-by-sa-3.0, cc-by-4.0, cc0, pd (public domain),
// gfdl, attribution. Поле License у файла — машинный код лицензии.
const FREE_LICENSE_RE = /^(cc|pd|public|attribution|gfdl|fal)/i;
// Несвободные пометки. Такие файлы в госучреждении показывать нельзя: разрешение
// «добросовестного использования» распространяется на статью Wikipedia, а не на
// наш киоск.
const NON_FREE_RE = /(fair.?use|non.?free|nonfree|with.?permission|all rights reserved)/i;

// Правило допуска. Помимо кода лицензии учитываем, ГДЕ лежит файл: Wikimedia
// Commons по своим правилам принимает только свободные файлы, поэтому файл с
// Commons безопасен даже если поле лицензии пустое. А вот файл, загруженный в
// локальную вики (ru.wikipedia.org/wiki/File:...), может быть именно fair use —
// такой без явно свободной лицензии не берём.
function isFreeLicense(meta) {
  const haystack = [meta.license, meta.licenseShort, meta.usageTerms]
    .filter(Boolean)
    .join(' ');
  if (NON_FREE_RE.test(haystack)) return false;
  if (FREE_LICENSE_RE.test(meta.license || '')) return true;
  if (FREE_LICENSE_RE.test(meta.licenseShort || '')) return true;
  return /^https:\/\/commons\.wikimedia\.org\//.test(meta.filePage || '');
}

// Поля extmetadata приходят с HTML внутри: автор бывает ссылкой
// (<a href="...">Ekrem Canli</a>), а иногда дублируется в скрытом span
// (<span style="display: none;">Unknown author</span>) — при наивной вырезке
// тегов получилось бы «Unknown authorUnknown author». Поэтому скрытые блоки
// удаляем целиком ДО удаления остальных тегов.
function stripHtml(value) {
  if (!value) return '';
  return String(value)
    .replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// ЧИСТКА ПОИСКОВОГО ЗАПРОСА
// ============================================================================
// Те же наборы слов-филлеров, что в answer.js (сознательное дублирование:
// функции проекта самостоятельны и не тянут общий модуль). «Расскажи про
// Регистан» → «Регистан», «Amir Temur haqida gapirib ber» → «Amir Temur».
const FILLERS_RU = new Set([
  'подробно', 'подробнее', 'кратко', 'вкратце', 'коротко', 'расскажи', 'расскажите',
  'поведай', 'опиши', 'объясни', 'объясните', 'пожалуйста', 'про', 'об', 'обо', 'о',
  'мне', 'что', 'такое', 'кто', 'такой', 'такая', 'такие', 'это', 'знаешь', 'можешь',
  'дай', 'информацию', 'информация', 'известно', 'когда', 'где', 'почему', 'зачем',
  'как', 'сколько', 'какой', 'какая', 'какие', 'какое', 'и', 'её', 'его', 'их',
]);
const FILLERS_UZ = new Set([
  'haqida', "to'g'risida", 'batafsil', 'qisqacha', 'gapirib', 'gapir', "so'zla",
  "so'zlab", 'ayt', 'aytib', "ma'lumot", "ma'lumotlar", 'yoz', 'tushuntir',
  'tushuntirib', 'ber', 'bering', 'nima', 'kim', 'qachon', 'qayerda', 'nega',
  'qanday', 'edi', "bo'lgan", "bo'ladi", 'menga', 'iltimos', 'va', 'uning',
]);

function cleanQuery(topic, lang) {
  const fillers = lang === 'uz' ? FILLERS_UZ : FILLERS_RU;
  // Узбекский апостроф пишут пятью разными знаками — приводим к прямому,
  // иначе токен «to'g'risida» не совпал бы с набором филлеров.
  const norm = lang === 'uz'
    ? (tok) => tok.replace(/[ʻʼ‘’`´']/g, "'")
    : (tok) => tok;

  const kept = String(topic)
    .replace(/[?!.,;:()"«»]/gu, ' ')
    .split(/\s+/)
    .filter((tok) => tok && !fillers.has(norm(tok.toLowerCase())));

  const q = kept.join(' ').trim();
  return q.length >= 2 ? q : String(topic).trim();
}

// ============================================================================
// ЗАПРОСЫ К WIKIMEDIA
// ============================================================================
// Один GET к api.php с таймаутом. AbortController, а не AbortSignal.timeout(),
// чтобы не зависеть от версии Node в рантайме Netlify.
async function wikiApi(lang, params) {
  const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WIKI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': WIKI_UA },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Wikipedia (${lang}) вернула ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Ищет статью и берёт имя её главной картинки (pageimage). Просматриваем
// SEARCH_LIMIT результатов и выбираем первый С картинкой: у самой релевантной
// статьи её может не быть. Порядок релевантности — поле index, которое
// generator=search кладёт в каждую страницу; сам объект pages не упорядочен.
async function searchPageImage(query, lang) {
  const data = await wikiApi(lang, {
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: String(SEARCH_LIMIT),
    prop: 'pageimages',
    piprop: 'thumbnail|name',
    pithumbsize: String(THUMB_WIDTH),
    format: 'json',
    formatversion: '1',
  });

  const pages = data && data.query && data.query.pages;
  if (!pages) return null;

  const ordered = Object.values(pages).sort((a, b) => (a.index || 0) - (b.index || 0));
  const withImage = ordered.find((p) => p.pageimage);
  if (!withImage) return null;

  return {
    title: withImage.title,
    fileName: withImage.pageimage,
    // thumbnail от pageimages — резерв, если imageinfo не отдаст свой thumburl.
    fallbackUrl: withImage.thumbnail ? withImage.thumbnail.source : null,
  };
}

// Забирает URL нужного размера + лицензию и автора файла. iiurlwidth заставляет
// Wikimedia отдать уменьшенную копию; для картинок уже меньше THUMB_WIDTH
// приходит оригинал (проверено на файле 590x892).
async function fetchFileMeta(fileName, lang) {
  const data = await wikiApi(lang, {
    action: 'query',
    titles: 'File:' + fileName,
    prop: 'imageinfo',
    iiprop: 'extmetadata|url|size',
    iiurlwidth: String(THUMB_WIDTH),
    iiextmetadatafilter: 'LicenseShortName|License|LicenseUrl|Artist|Credit|UsageTerms',
    format: 'json',
    formatversion: '1',
  });

  const pages = data && data.query && data.query.pages;
  if (!pages) return null;
  const info = (Object.values(pages)[0] || {}).imageinfo;
  if (!info || !info[0]) return null;

  const item = info[0];
  const em = item.extmetadata || {};
  const val = (key) => (em[key] ? em[key].value : '');

  return {
    url: item.thumburl || item.url || null,
    width: item.thumbwidth || item.width || null,
    height: item.thumbheight || item.height || null,
    filePage: item.descriptionurl || '',
    license: String(val('License') || ''),
    licenseShort: stripHtml(val('LicenseShortName')),
    licenseUrl: String(val('LicenseUrl') || ''),
    usageTerms: stripHtml(val('UsageTerms')),
    author: stripHtml(val('Artist')) || stripHtml(val('Credit')),
  };
}

// ============================================================================
// ПОИСК ФОТО С КРОСС-ЯЗЫЧНЫМ ЗАПАСОМ
// ============================================================================
// Сначала ищем в вики языка вопроса, потом во второй. Это не формальность:
// у узбекской статьи «Registon» картинки нет вообще, а у русского «Регистан
// (Самарканд)» есть — проверено живым запросом. Фотография от языка не зависит,
// поэтому взять её из соседней вики честно; какую использовали, возвращаем в
// поле lang_used.
async function lookupPhoto(query, lang) {
  const order = lang === 'uz' ? ['uz', 'ru'] : ['ru', 'uz'];

  for (const wikiLang of order) {
    let found;
    try {
      found = await searchPageImage(query, wikiLang);
    } catch (err) {
      console.error(`Поиск картинки (${wikiLang}) не удался:`, err.message);
      continue;
    }
    if (!found) continue;

    let meta = null;
    try {
      meta = await fetchFileMeta(found.fileName, wikiLang);
    } catch (err) {
      console.error(`Метаданные файла (${wikiLang}) не получены:`, err.message);
    }

    // Без метаданных лицензия неизвестна — показывать нельзя. Резервный URL из
    // pageimages тут не спасает: проблема не в ссылке, а в правах.
    if (!meta || !meta.url) continue;
    if (!isFreeLicense(meta)) {
      console.log(`Файл ${found.fileName} пропущен: лицензия "${meta.license || meta.licenseShort || 'неизвестна'}"`);
      continue;
    }

    return {
      has_photo: true,
      photo_url: meta.url || found.fallbackUrl,
      width: meta.width,
      height: meta.height,
      // alt для скринридера и для случая, когда картинка не загрузилась.
      alt: found.title,
      title: found.title,
      author: meta.author || '',
      license: meta.licenseShort || meta.usageTerms || '',
      license_url: meta.licenseUrl || '',
      file_page: meta.filePage || '',
      lang_used: wikiLang,
    };
  }

  return { has_photo: false };
}

// ============================================================================
// ОБРАБОТЧИК
// ============================================================================
exports.handler = async (event) => {
  const origin = event.headers ? (event.headers.origin || event.headers.Origin) : '';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, origin);
  }

  // Тот же необязательный токен-фильтр от случайных ботов, что в answer.js и
  // tts.js: пока APP_SHARED_TOKEN не задан в окружении, проверки нет.
  const expectedToken = process.env.APP_SHARED_TOKEN;
  if (expectedToken) {
    const providedToken = event.headers && event.headers['x-app-token'];
    if (providedToken !== expectedToken) {
      return json({ error: 'Unauthorized' }, 401, origin);
    }
  }

  // Тему принимаем из тела POST (основной путь) и из query GET (ручная
  // проверка в браузере). Поле question — синоним: фронтенд посылает сырой
  // вопрос ещё до того, как узнал тему ответа.
  let topic = '';
  let lang = 'ru';
  if (event.httpMethod === 'POST') {
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      return json({ error: 'Тело запроса не является JSON' }, 400, origin);
    }
    topic = typeof body.topic === 'string' ? body.topic : (typeof body.question === 'string' ? body.question : '');
    if (typeof body.lang === 'string') lang = body.lang;
  } else {
    const q = event.queryStringParameters || {};
    topic = typeof q.topic === 'string' ? q.topic : (typeof q.question === 'string' ? q.question : '');
    if (typeof q.lang === 'string') lang = q.lang;
  }

  topic = topic.trim();
  lang = lang === 'uz' ? 'uz' : 'ru';

  if (!topic) {
    return json({ error: 'Поле topic обязательно' }, 400, origin);
  }
  if (topic.length > MAX_TOPIC_LEN) {
    return json({ error: `Тема слишком длинная: максимум ${MAX_TOPIC_LEN} символов` }, 413, origin);
  }

  const query = cleanQuery(topic, lang);
  const key = lang + '|' + query.toLowerCase();

  const cached = cacheGet(key);
  if (cached) {
    console.log(`Фото из кэша инстанса: "${query}" (${lang})`);
    return json(cached, 200, origin);
  }

  let payload;
  try {
    payload = await lookupPhoto(query, lang);
  } catch (err) {
    console.error('Поиск фото сорвался:', err.message);
    // 200 с has_photo:false, а не 5xx: отсутствие фото — не ошибка киоска,
    // ответ и озвучка работают без него. Такой результат не кэшируем.
    return json({ has_photo: false }, 200, origin);
  }

  cacheSet(key, payload);
  console.log(payload.has_photo
    ? `Фото найдено: "${payload.title}" (${payload.lang_used}), лицензия ${payload.license || 'не указана'}`
    : `Фото не найдено: "${query}" (${lang})`);

  return json(payload, 200, origin);
};

// ============================================================================
// CORS И ОТВЕТЫ
// ============================================================================
// Список тот же, что в tts.js: киоск обращается к функции со своего домена,
// поэтому строгий список не ломает основной сценарий, но закрывает функцию от
// чужих сайтов, которые иначе гоняли бы через неё свой поиск по Wikimedia.
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

// Origin возвращаем эхом только если он в списке, иначе отдаём первый из списка
// — браузер чужого сайта такой ответ отбросит сам. Vary: Origin обязателен:
// без него CDN раздал бы закэшированный заголовок всем подряд.
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-app-token',
    Vary: 'Origin',
  };
}

function json(obj, statusCode, origin) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Ответ зависит только от темы и языка, поэтому его спокойно кэширует и
      // CDN — при этом сам поиск по Wikimedia не повторяется. Ошибки (400, 413,
      // 405) не кэшируем вообще: иначе клиент, исправивший запрос, получал бы
      // из CDN прежнюю ошибку.
      ...(statusCode === 200
        ? { 'Cache-Control': obj && obj.has_photo ? 'public, max-age=86400' : 'public, max-age=1800' }
        : { 'Cache-Control': 'no-store' }),
      ...corsHeaders(origin),
    },
    body: JSON.stringify(obj),
  };
}
