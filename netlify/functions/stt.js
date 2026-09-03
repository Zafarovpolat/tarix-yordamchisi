// Серверная функция распознавания речи (STT).
//
// Для УЗБЕКСКОГО языка основной движок — Google Cloud Speech-to-Text v2 с
// моделью Chirp 2 (Universal Speech Model). Она заметно точнее Whisper на
// узбекском, потому что обучалась в том числе на малоресурсных языках. Если
// ключ Google не задан ИЛИ запрос к Google не удался — функция автоматически
// откатывается на прежний путь (Groq Whisper large-v3). То есть распознавание
// работает всегда, а Google лишь ПОВЫШАЕТ качество, когда подключён.
//
// Русский по-прежнему идёт через Whisper: он распознаёт русский уверенно, и
// менять рабочий путь без нужды не будем (жалоба была только на узбекский).
//
// Whisper для узбекского выдаёт ЛАТИНИЦУ — ровно то, что нужно дальше по
// цепочке (озвучка uz-UZ-MadinaNeural обучена на латинице, keywords_uz в базе
// фактов тоже на латинице). Chirp 2 для uz-UZ (Latin) отдаёт латиницу так же.
//
// Аутентификация Google v2: ТОЛЬКО OAuth2 Bearer от сервисного аккаунта
// (обычный API-ключ v2 не принимает). Токен получаем сами, без сторонних
// пакетов: подписываем короткоживущий JWT приватным ключом сервис-аккаунта
// (RS256 через встроенный модуль crypto) и меняем его на access_token у Google.
// Всё на глобалах Node 18+ (crypto, fetch, URLSearchParams, FormData, Blob) —
// зависимостей у функции по-прежнему нет, drag-and-drop деплой цел.
//
// Формат V1 (exports.handler). Аудио приходит как JSON { audio: base64, mime,
// lang } — не multipart, так надёжнее при любом бандлере и не нужен парсер.

const crypto = require('crypto');

// ── Настройки Google STT (всё из переменных окружения) ─────────────────────
// GCP_SA_KEY      — JSON сервисного аккаунта целиком (или его base64). Если
//                   пусто — путь Google выключен, работает только Whisper.
// GCP_STT_LOCATION— регион с поддержкой Chirp 2: us-central1 (по умолчанию),
//                   europe-west4 или asia-southeast1.
// GCP_STT_MODEL   — модель распознавания (по умолчанию chirp_2; при проблемах
//                   с регионом/языком можно указать chirp).
const GCP_LOCATION = process.env.GCP_STT_LOCATION || 'us-central1';
const GCP_MODEL = process.env.GCP_STT_MODEL || 'chirp_2';

// ── Ограничения входящего аудио ────────────────────────────────────────────
// Вопрос посетителя длится секунды и весит десятки килобайт: 3 МБ — это уже
// минуты записи с большим запасом. Прежний предел был 25 МБ (как у Groq), то
// есть одним запросом можно было заставить функцию выделить 25 МБ и отправить
// их наружу. Для киоска это лишнее, поэтому предел снижен до реальных нужд.
const MAX_AUDIO_MB = 3;
const MAX_AUDIO_BYTES = MAX_AUDIO_MB * 1024 * 1024;
// base64 тратит 4 символа на каждые 3 байта. Считаем предел ещё и по длине
// строки, чтобы отсечь перебор ДО выделения буфера; +64 — запас на padding.
const MAX_BASE64_CHARS = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 64;
// Меньше половины килобайта — это не речь, а обрывок: пустой blob, отменённая
// запись или битая передача. Отвечаем понятной ошибкой, не тратя вызов Groq.
const MIN_AUDIO_BYTES = 512;

// Белый список контейнеров. Это не только про размер: значение mime уходит в
// Content-Type части multipart к Groq и в имя файла audio.<ext>, то есть
// строка из запроса попадала бы прямо в заголовок. MediaRecorder присылает вид
// 'audio/webm;codecs=opus', поэтому параметры отбрасываем и сверяем базовый тип.
const ALLOWED_AUDIO_MIME = [
  'audio/webm',   // Chrome/Firefox/Android — основной путь
  'audio/ogg',    // Firefox
  'audio/mp4',    // Safari/iOS
  'audio/m4a',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/aac',
  'audio/flac',
];

// Приводит MIME к безопасному виду: обрезает параметры (;codecs=…), приводит к
// нижнему регистру и возвращает значение ИЗ СПИСКА либо null. Наружу уходит
// именно элемент списка, а не строка клиента.
function normalizeAudioMime(raw) {
  const base = String(raw || '').split(';')[0].trim().toLowerCase();
  if (!base) return 'audio/webm'; // как и раньше: значение по умолчанию
  const i = ALLOWED_AUDIO_MIME.indexOf(base);
  return i === -1 ? null : ALLOWED_AUDIO_MIME[i];
}

// Кэш access_token в памяти процесса: токен живёт час, повторно используем его
// между вызовами одного «тёплого» инстанса функции, чтобы не дёргать обмен
// JWT на каждый запрос.
let cachedToken = null; // { value: string, exp: number(sec) }

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

  // Тот же общий токен-фильтр от случайных ботов, что у answer.js и tts.js
  // (по умолчанию выключен — проверка включается, только если задан env).
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

  // Тип проверяем явно: если audio пришло числом или объектом, дальше по
  // цепочке это обернулось бы невнятной ошибкой Buffer.from.
  const base64 = typeof body.audio === 'string' ? body.audio : '';
  // Whisper/Chirp принимают язык в формате ISO/BCP-47. Функция нужна прежде
  // всего для узбекского; параметр гибкий на случай русского.
  const lang = body.lang === 'ru' ? 'ru' : 'uz';

  if (!base64) {
    return json({ error: 'Поле audio обязательно (строка base64)' }, 400, origin);
  }

  // Размер сначала по ДЛИНЕ СТРОКИ, до декодирования: буфер на несколько
  // мегабайт не выделяется вообще, если запрос заведомо великоват.
  if (base64.length > MAX_BASE64_CHARS) {
    return json({ error: `Аудио слишком большое (>${MAX_AUDIO_MB} МБ)` }, 413, origin);
  }

  // MIME берём только из белого списка (см. normalizeAudioMime): дальше он
  // уходит в заголовок multipart-части к Groq и в имя файла.
  const mime = normalizeAudioMime(body.mime);
  if (!mime) {
    return json({ error: 'Неподдерживаемый формат аудио' }, 415, origin);
  }

  // base64 → бинарный буфер аудио
  const buf = Buffer.from(base64, 'base64');

  // Повторная проверка после декодирования: строку могли «раздуть» переводами
  // строк и пробелами, которые Buffer молча выбрасывает.
  if (buf.length > MAX_AUDIO_BYTES) {
    return json({ error: `Аудио слишком большое (>${MAX_AUDIO_MB} МБ)` }, 413, origin);
  }
  if (buf.length < MIN_AUDIO_BYTES) {
    return json({ error: 'Аудио слишком короткое или повреждено' }, 400, origin);
  }

  try {
    let text;
    const sa = loadServiceAccount();

    // Узбекский: сначала Google Chirp 2 (если подключён), при любой осечке —
    // Whisper. Русский и «Google не настроен» — сразу Whisper.
    if (lang === 'uz' && sa) {
      try {
        text = await googleTranscribe(buf, mime, lang, sa);
        console.log(`Google STT (${lang}): "${text}"`);
      } catch (gErr) {
        console.warn('Google STT не удался, откат на Whisper:', gErr.message);
        text = await whisperTranscribe(buf, mime, lang);
        console.log(`Whisper STT (${lang}, fallback): "${text}"`);
      }
    } else {
      text = await whisperTranscribe(buf, mime, lang);
      console.log(`Whisper STT (${lang}): "${text}"`);
    }

    return json({ text }, 200, origin);
  } catch (err) {
    console.error('Ошибка распознавания речи:', err.message);
    return json({ error: 'Ошибка распознавания: ' + err.message }, 502, origin);
  }
};

// ── Google Cloud Speech-to-Text v2 (Chirp 2) ───────────────────────────────

// Разбирает GCP_SA_KEY: принимает как «сырой» JSON сервис-аккаунта, так и его
// base64. Возвращает объект или null (тогда путь Google просто выключен).
function loadServiceAccount() {
  const raw = process.env.GCP_SA_KEY;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf-8');
    const sa = JSON.parse(text);
    if (!sa.client_email || !sa.private_key || !sa.project_id || !sa.token_uri) {
      console.error('GCP_SA_KEY: в JSON не хватает полей сервис-аккаунта');
      return null;
    }
    return sa;
  } catch (e) {
    console.error('GCP_SA_KEY: не удалось разобрать JSON:', e.message);
    return null;
  }
}

// base64url без паддинга — формат для частей JWT и подписи.
function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// Возвращает OAuth2 access_token сервис-аккаунта (scope cloud-platform).
// Сам подписывает JWT приватным ключом (RS256) и меняет его на токен у Google
// по стандартному потоку jwt-bearer. Кэширует токен на время жизни инстанса.
async function getGoogleToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.value;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer
    .sign(sa.private_key)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google token ${res.status}: ${errText.slice(0, 200)}`);
  }
  const tok = await res.json();
  cachedToken = { value: tok.access_token, exp: now + (tok.expires_in || 3600) };
  return cachedToken.value;
}

// Синхронное распознавание через Speech-to-Text v2 и «пустой» распознаватель
// `_` (не нужно заранее создавать Recognizer). autoDecodingConfig сам
// определит контейнер (WEBM_OPUS от MediaRecorder поддерживается).
async function googleTranscribe(buf, mime, lang, sa) {
  const token = await getGoogleToken(sa);
  const url = `https://${GCP_LOCATION}-speech.googleapis.com/v2/projects/`
    + `${sa.project_id}/locations/${GCP_LOCATION}/recognizers/_:recognize`;

  const reqBody = {
    config: {
      model: GCP_MODEL,
      languageCodes: [lang === 'uz' ? 'uz-UZ' : 'ru-RU'],
      autoDecodingConfig: {},
    },
    content: buf.toString('base64'),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google STT ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  // Ответ v2: results[].alternatives[0].transcript — склеиваем куски.
  const text = (data.results || [])
    .map((r) => (r.alternatives && r.alternatives[0] && r.alternatives[0].transcript) || '')
    .join(' ')
    .trim();
  if (!text) throw new Error('Google STT вернул пустой результат');
  return text;
}

// ── Groq Whisper large-v3 (резерв / русский) ───────────────────────────────

// Распознавание через Groq Whisper. FormData/Blob — встроенные в Node 18
// (undici), сторонних пакетов не требуется. fetch с телом FormData сам
// проставит корректный Content-Type: multipart/form-data с boundary.
async function whisperTranscribe(buf, mime, lang) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY не задан — распознавание невозможно');

  // Имя файла с расширением по MIME — Groq по нему определяет контейнер.
  // mime здесь уже нормализован белым списком (normalizeAudioMime в начале
  // файла), произвольной строки из запроса тут быть не может.
  const ext = mime.includes('ogg') ? 'ogg'
    : (mime.includes('mp4') || mime.includes('m4a')) ? 'm4a'
    : mime.includes('wav') ? 'wav'
    : (mime.includes('mpeg') || mime.includes('mp3')) ? 'mp3'
    : mime.includes('flac') ? 'flac'
    : mime.includes('aac') ? 'aac'
    : 'webm';

  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `audio.${ext}`);
  form.append('model', 'whisper-large-v3'); // самая точная мультиязычная модель
  form.append('language', lang);
  form.append('response_format', 'json');
  form.append('temperature', '0');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq STT ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

// ── CORS ───────────────────────────────────────────────────────────────────
// Белый список тот же, что в tts.js и photo.js. Киоск обращается к функции со
// своего домена, поэтому список ничего не ломает в рабочем сценарии, но
// закрывает распознавание речи от чужих сайтов: без него любая страница в
// интернете могла бы гонять своё аудио через нашу функцию за нашу квоту Groq.
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
      // Расшифровку кэшировать нечем и незачем: каждое обращение несёт новое
      // аудио, а ответ уникален для посетителя. Явный no-store страхует от
      // случайного кэширования ошибок на CDN.
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
    body: JSON.stringify(obj),
  };
}
