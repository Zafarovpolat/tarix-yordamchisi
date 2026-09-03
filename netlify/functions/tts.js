// Серверный прокси озвучивания (TTS).
//
// Зачем он нужен:
// 1. Узбекский голос. Браузерный speechSynthesis почти нигде не умеет
//    произносить узбекский. Google Translate TTS — тоже НЕ умеет (проверено:
//    tl=uz возвращает 400). Рабочий бесплатный источник узбекского — нейро-
//    голоса Microsoft Edge Read-Aloud (тот же движок, что Azure Neural TTS),
//    доступные без ключа и без карты через недокументированный WebSocket-
//    эндпоинт. Голос: uz-UZ-MadinaNeural.
// 2. Настоящий липсинк. Липсинк по амплитуде требует доступа к аудиопотоку
//    через Web Audio AnalyserNode, а это работает только если аудио отдаётся
//    с того же домена (иначе поток "запятнан" CORS). Поэтому mp3 тянем на
//    сервере и отдаём фронтенду уже со своего домена /.netlify/functions/tts.
//
// Языки:
//   • uz → Edge neural (uz-UZ-MadinaNeural) — единственный источник узбекского.
//   • ru → Edge neural (ru-RU-SvetlanaNeural) с автооткатом на Google
//          Translate TTS, если Edge недоступен. Так русский звучит лучше
//          (нейро-голос), но проверенный путь Google остаётся страховкой.
//   Если сервер не смог озвучить вовсе (502) — фронтенд сам откатывается на
//   встроенный браузерный speechSynthesis (см. index.html).
//
// Технически: свой минимальный WebSocket-клиент поверх встроенного модуля tls
// — БЕЗ внешних зависимостей (никакого npm install, drag-and-drop деплой цел)
// и без опоры на глобальный WebSocket (его наличие на рантайме Netlify не
// гарантировано). Формат V1 (exports.handler) — как и answer.js.
//
// ОСНОВНОЙ (стабильный) путь: если заданы AZURE_SPEECH_KEY и AZURE_SPEECH_REGION,
// озвучка идёт напрямую через официальный Azure Speech (тот же нейро-голос
// uz-UZ-MadinaNeural, что и у Edge, но по документированному API — стабильнее и
// с управлением темпом через SSML: чуть медленнее → звучит менее «роботно»).
// Если ключа Azure нет или запрос к нему упал — автоматический откат на прежние
// бесплатные источники (Edge, затем Google для русского). Форма ответа
// (audio/mpeg, mp3 24кГц) у всех путей одинаковая — фронтенд менять не нужно.
//
// ВАЖНО: Edge и Google — недокументированные бесплатные эндпоинты, не
// гарантированные. Если всё серверное недоступно — сработает браузерный резерв
// (speechSynthesis в index.html).

const crypto = require('crypto');
const tls = require('tls');

// ── Голоса ───────────────────────────────────────────────────────────────
// Оба голоса каждого языка — одна «персона» аватара: женский по умолчанию,
// мужской по выбору пользователя. Мужские проверены живым запросом к списку
// голосов Edge: uz-UZ-SardorNeural и ru-RU-DmitryNeural отдаются бесплатно,
// ключи Azure для них не нужны. Раньше здесь лежали две константы (только
// женские), и на бесплатном пути выбор пола терялся: узбекский всегда звучал
// голосом Мадины, а русского мужского не было вовсе.
const VOICES = {
  uz: { female: 'uz-UZ-MadinaNeural', male: 'uz-UZ-SardorNeural' },
  ru: { female: 'ru-RU-SvetlanaNeural', male: 'ru-RU-DmitryNeural' },
};

// Пол берём только из двух известных значений: на любое другое (или пустое)
// отдаём женский голос — киоск должен заговорить даже при мусоре в запросе.
function pickVoice(lang, voicePref) {
  const set = VOICES[lang] || VOICES.ru;
  return voicePref === 'male' ? set.male : set.female;
}

// ── Константы эндпоинта Edge Read-Aloud ────────────────────────────────────
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_HOST = 'speech.platform.bing.com';
const EDGE_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const SEC_MS_GEC_VERSION = '1-143.0.3650.75';
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const EDGE_TIMEOUT_MS = 12000; // с запасом под лимит функции Netlify (~10-26с)

// ── Google Translate TTS (резерв для русского) ─────────────────────────────
const GOOGLE_BASE = 'https://translate.google.com/translate_tts';

// ── Azure Speech (основной платный путь, включается по env) ────────────────
// AZURE_SPEECH_KEY   — ключ ресурса Speech.
// AZURE_SPEECH_REGION— регион ресурса (например eastus, westeurope).
// AZURE_UZ_VOICE     — женский узбекский голос (по умолчанию Madina — единая
//                      «персона» аватара).
// AZURE_UZ_VOICE_MALE— мужской узбекский голос для опции voice:'male'.
// AZURE_RU_VOICE     — женский русский голос.
// AZURE_RU_VOICE_MALE— мужской русский голос для опции voice:'male'.
// AZURE_TTS_RATE     — относительное замедление темпа (SSML prosody rate):
//                      небольшой минус делает речь разборчивее и живее.
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION;
const AZURE_UZ_VOICE = process.env.AZURE_UZ_VOICE || 'uz-UZ-MadinaNeural';
const AZURE_UZ_VOICE_MALE = process.env.AZURE_UZ_VOICE_MALE || 'uz-UZ-SardorNeural';
const AZURE_RU_VOICE = process.env.AZURE_RU_VOICE || 'ru-RU-SvetlanaNeural';
const AZURE_RU_VOICE_MALE = process.env.AZURE_RU_VOICE_MALE || 'ru-RU-DmitryNeural';
const AZURE_RATE = process.env.AZURE_TTS_RATE || '-8%';

// Токен Sec-MS-GEC: SHA256(ticks + trustedToken) в верхнем регистре, где ticks
// — windows-filetime текущего времени, округлённого вниз до 5 минут, в
// интервалах по 100 нс. Алгоритм сверен с исходником edge-tts (drm.py).
function generateSecMsGec() {
  const WIN_EPOCH = 11644473600n; // секунды между 1601-01-01 и 1970-01-01
  let ticks = BigInt(Math.floor(Date.now() / 1000)) + WIN_EPOCH;
  ticks = ticks - (ticks % 300n); // вниз до 5-минутной границы
  ticks = ticks * 10000000n;      // секунды → интервалы по 100 нс (1e9/100)
  return crypto
    .createHash('sha256')
    .update(ticks.toString() + TRUSTED_CLIENT_TOKEN, 'ascii')
    .digest('hex')
    .toUpperCase();
}

// Экранирование текста для вставки в SSML/XML (иначе & < > ломают разметку).
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Собирает клиентский WebSocket-кадр (клиент ОБЯЗАН маскировать нагрузку по RFC).
function buildFrame(payloadStr) {
  const payload = Buffer.from(payloadStr, 'utf-8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Синтез фразы через Edge Read-Aloud. Возвращает Promise<Buffer> с mp3.
// Открывает одну TLS+WebSocket-сессию на весь текст (до 1200 символов Edge
// принимает без проблем), шлёт speech.config + ssml, склеивает бинарные
// аудио-кадры до сигнала turn.end.
function edgeSynthesize(text, voice, xmlLang) {
  return new Promise((resolve, reject) => {
    const gec = generateSecMsGec();
    const connId = crypto.randomUUID().replace(/-/g, '');
    const query = `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
      + `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connId}`;

    const socket = tls.connect({
      host: EDGE_HOST, port: 443, servername: EDGE_HOST, ALPNProtocols: ['http/1.1'],
    });
    const audio = [];
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    let settled = false;

    const done = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch (e) { /* уже закрыт */ }
      if (err) reject(err); else resolve(result);
    };
    const timer = setTimeout(() => done(new Error('Edge TTS таймаут')), EDGE_TIMEOUT_MS);

    socket.on('secureConnect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      const req =
        `GET ${EDGE_PATH}${query} HTTP/1.1\r\n` +
        `Host: ${EDGE_HOST}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Origin: ${EDGE_ORIGIN}\r\n` +
        `User-Agent: ${EDGE_UA}\r\n` +
        `Pragma: no-cache\r\n` +
        `Cache-Control: no-cache\r\n` +
        `Accept-Language: en-US,en;q=0.9\r\n` +
        `\r\n`;
      socket.write(req);
    });

    // Прикладные сообщения после апгрейда до WebSocket.
    function sendMessages() {
      const ts = new Date().toString();
      const cfg =
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
      socket.write(buildFrame(cfg));
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'>` +
        `<voice name='${voice}'>${escapeXml(text)}</voice></speak>`;
      const msg =
        `X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`;
      socket.write(buildFrame(msg));
    }

    // Разбор входящих серверных кадров (сервер шлёт немаскированные кадры).
    function parseFrames() {
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
        if (buf.length < offset + len) return; // кадр пришёл не целиком — ждём ещё
        const payload = buf.subarray(offset, offset + len);
        buf = buf.subarray(offset + len);
        if (opcode === 0x8) { // close
          return done(new Error('Edge закрыл соединение до окончания синтеза'));
        }
        if (opcode === 0x1) { // текст: turn.start / response / turn.end
          if (payload.includes('Path:turn.end')) {
            const mp3 = Buffer.concat(audio);
            if (!mp3.length) return done(new Error('Edge вернул пустой аудиопоток'));
            return done(null, mp3);
          }
        } else if (opcode === 0x2) { // бинарный аудио-кадр
          // Формат: [2 байта длины заголовка][заголовок ASCII][mp3-байты].
          const headerLen = payload.readUInt16BE(0);
          audio.push(payload.subarray(2 + headerLen));
        }
        // opcode 0x9 (ping) можно игнорировать: сессия короткая, сервер не пингует.
      }
    }

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return; // заголовки ответа ещё не целиком
        const head = buf.subarray(0, idx).toString('utf-8');
        if (!/HTTP\/1\.1 101/.test(head)) {
          return done(new Error('Edge рукопожатие не 101: ' + head.split('\r\n')[0]));
        }
        handshakeDone = true;
        buf = buf.subarray(idx + 4);
        sendMessages();
      }
      parseFrames();
    });

    socket.on('error', (e) => done(e));
    socket.on('close', () => {
      if (!settled) done(new Error('соединение с Edge закрылось преждевременно'));
    });
  });
}

// ── Azure Speech: официальный синтез по REST ───────────────────────────────

// Собирает SSML с управлением темпом. Небольшое замедление (prosody rate) и
// явные паузы после точек делают речь спокойнее и разборчивее — уходит эффект
// «строчит без остановки», на который жалуются в узбекском.
function buildAzureSsml(text, voice, xmlLang) {
  // Пауза после конца предложения — вставляем break тегом. Текст экранируем.
  const withPauses = escapeXml(text).replace(/([.!?…])\s+/g, '$1<break time="300ms"/> ');
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' `
    + `xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='${xmlLang}'>`
    + `<voice name='${voice}'>`
    + `<prosody rate='${AZURE_RATE}'>${withPauses}</prosody>`
    + `</voice></speak>`;
}

// Синтез через Azure Speech (тот же mp3-профиль 24кГц/48кбит, что у Edge).
// Аутентификация простейшая — ключ ресурса в заголовке, без обмена на токен.
async function azureSynthesize(text, voice, xmlLang) {
  const url = `https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'TarixYordamchisi',
    },
    body: buildAzureSsml(text, voice, xmlLang),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Azure TTS ${res.status}: ${errText.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Azure TTS вернул пустой аудиопоток');
  return buf;
}

// Google TTS принимает примерно до ~200 символов за запрос. Режем текст по
// границам предложений, чтобы не рвать слова и сохранить естественную интонацию.
function chunkText(text, max = 180) {
  const sentences = text.match(/[^.!?…]+[.!?…]*/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    const part = s.trim();
    if (!part) continue;
    // Одно предложение длиннее лимита — режем его по словам.
    if (part.length > max) {
      if (cur) { chunks.push(cur.trim()); cur = ''; }
      let line = '';
      for (const word of part.split(/\s+/)) {
        if ((line + ' ' + word).trim().length > max && line) {
          chunks.push(line.trim());
          line = word;
        } else {
          line = line ? line + ' ' + word : word;
        }
      }
      if (line.trim()) cur = line.trim();
      continue;
    }
    if ((cur + ' ' + part).length > max && cur) {
      chunks.push(cur.trim());
      cur = part;
    } else {
      cur = cur ? cur + ' ' + part : part;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}

// Тянет один кусок текста как mp3 через Google. Требует "браузерный"
// User-Agent и client=tw-ob — без них Google отдаёт 403 вместо аудио.
async function fetchGoogleChunk(chunk, lang) {
  const url = `${GOOGLE_BASE}?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}`
    + `&q=${encodeURIComponent(chunk)}&textlen=${chunk.length}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Referer': 'https://translate.google.com/',
    },
  });
  if (!res.ok) {
    throw new Error(`Google TTS вернул ${res.status} для куска "${chunk.slice(0, 40)}…"`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Google TTS вернул пустой аудиопоток');
  return buf;
}

// Синтез через Google целиком (по кускам). Используется как резерв для русского.
async function googleSynthesize(text, lang) {
  const buffers = [];
  for (const chunk of chunkText(text)) {
    buffers.push(await fetchGoogleChunk(chunk, lang));
  }
  return Buffer.concat(buffers);
}

// ЗАЩИТА УЗБЕКСКОГО ТЕКСТА ПЕРЕД СИНТЕЗОМ.
// Голос uz-UZ обучен на латинице, и два вида символов глушат его наглухо:
//   1. кириллица — движок отдаёт пустое аудио, а прокси падает в 502;
//   2. типографские апострофы (ʻ U+02BB в «oʻ/gʻ», ʼ U+02BC в «maʼno»,
//      ’ U+2019) — в бою проверен только прямой U+0027.
// В самой базе фактов узбекские поля уже вычищены, но текст сюда приходит ещё
// и от пользователя, и от LLM, поэтому чистка стоит на входе в синтезатор, а
// не в данных: одна испорченная запись больше не оставит киоск без звука.
// Транслитерация посимвольная — узбекская кириллица однозначно отображается на
// латиницу (ў → oʻ, қ → q, ғ → gʻ, ҳ → h).
const CYR_TO_LAT = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'j', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'x', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sh', 'ы': 'i',
  'э': 'e', 'ю': 'yu', 'я': 'ya', 'ў': "o'", 'қ': 'q', 'ғ': "g'", 'ҳ': 'h',
  'ъ': "'", 'ь': '',
};

// Все варианты апострофа приводим к одному прямому U+0027 (тот же набор, что в
// cleanQuery из answer.js).
const APOSTROPHE_VARIANTS = /[ʻʼ‘’`´']/g;

function normalizeUzForVoice(text) {
  let out = '';
  for (const ch of text) {
    const low = ch.toLowerCase();
    const mapped = CYR_TO_LAT[low];
    if (mapped === undefined) {
      out += ch;
      continue;
    }
    // Заглавную кириллическую букву отдаём заглавной латинской, иначе
    // «Ўзбекистон» превратилось бы в «oʻzbekiston» посреди предложения.
    out += ch === low ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }
  return out.replace(APOSTROPHE_VARIANTS, "'");
}

// Единая точка синтеза: выбирает движок по языку с приоритетом Azure и
// каскадным откатом. voicePref ('male' | 'female') доходит до КАЖДОГО движка —
// и до платного Azure, и до бесплатного Edge.
async function synthesize(text, lang, voicePref) {
  const azureOn = Boolean(AZURE_KEY && AZURE_REGION);
  const edgeVoice = pickVoice(lang, voicePref);

  if (lang === 'uz') {
    const speech = normalizeUzForVoice(text);
    if (azureOn) {
      const uzVoice = voicePref === 'male' ? AZURE_UZ_VOICE_MALE : AZURE_UZ_VOICE;
      try {
        return await azureSynthesize(speech, uzVoice, 'uz-UZ');
      } catch (err) {
        console.warn('Azure (uz) не удался, откат на Edge:', err.message);
      }
    }
    return await edgeSynthesize(speech, edgeVoice, 'uz-UZ');
  }

  if (azureOn) {
    const ruVoice = voicePref === 'male' ? AZURE_RU_VOICE_MALE : AZURE_RU_VOICE;
    try {
      return await azureSynthesize(text, ruVoice, 'ru-RU');
    } catch (err) {
      console.warn('Azure (ru) не удался, откат на Edge:', err.message);
    }
  }
  try {
    return await edgeSynthesize(text, edgeVoice, 'ru-RU');
  } catch (err) {
    console.warn('Edge (ru) не удался, откат на Google:', err.message);
    // У Google TTS выбора пола нет — это аварийный путь, и лучше ответить не
    // тем голосом, чем не ответить совсем.
    return await googleSynthesize(text, 'ru');
  }
}

exports.handler = async (event) => {
  // Netlify приводит имена заголовков к нижнему регистру; Origin нужен в
  // КАЖДОМ ответе, включая ошибки, иначе браузер не покажет их фронтенду.
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';

  // Предзапрос CORS (на случай обращения не с того же домена).
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, origin);
  }

  // Тот же опциональный токен-фильтр от случайных ботов, что и в answer.js.
  const expectedToken = process.env.APP_SHARED_TOKEN;
  if (expectedToken) {
    const providedToken = event.headers['x-app-token'];
    if (providedToken !== expectedToken) {
      return json({ error: 'Unauthorized' }, 401, origin);
    }
  }

  // Текст и язык принимаем и из тела POST (основной путь), и из query GET
  // (удобно для ручной проверки в браузере). voice ('male'|'female') —
  // выбор голоса, работает на ОБА языка (по умолчанию женский).
  let text = '';
  let lang = 'ru';
  let voice = 'female';
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      text = (body.text || '').trim();
      lang = body.lang === 'uz' ? 'uz' : 'ru';
      voice = body.voice === 'male' ? 'male' : 'female';
    } catch (e) {
      return json({ error: 'Некорректный JSON' }, 400, origin);
    }
  } else {
    const q = event.queryStringParameters || {};
    text = (q.text || '').trim();
    lang = q.lang === 'uz' ? 'uz' : 'ru';
    voice = q.voice === 'male' ? 'male' : 'female';
  }

  if (!text) return json({ error: 'Поле text обязательно' }, 400, origin);
  // Разумный потолок, чтобы прокси не превратили в бесплатный TTS-сервис.
  if (text.length > 1200) text = text.slice(0, 1200);

  console.log(`TTS: язык=${lang}, голос=${voice}, символов=${text.length}`);

  try {
    const combined = await synthesize(text, lang, voice);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        // Одинаковый вопрос из базы фактов → одинаковый ответ → одинаковое
        // аудио: кэшируем на сутки, чтобы не дёргать источник повторно.
        'Cache-Control': 'public, max-age=86400',
        ...corsHeaders(origin),
      },
      body: combined.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('Ошибка TTS-прокси:', err.message);
    // 502 — фронтенд поймёт, что озвучку надо взять из резервного
    // speechSynthesis, а не показывать ошибку пользователю.
    return json({ error: 'TTS недоступен: ' + err.message }, 502, origin);
  }
};

// CORS. Киоск обращается к функции с того же домена, поэтому строгий список
// origin не ломает основной сценарий — он закрывает бесплатный TTS-прокси от
// чужих сайтов, которые иначе гоняли бы через него свой трафик за наш счёт.
// ALLOWED_ORIGINS — список через запятую в переменных окружения Netlify;
// значение '*' в этом списке возвращает прежнее «разрешено всем» (пригодится,
// если клиент решит встроить киоск в сторонний сайт).
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
      // Через json() уходят только ошибки (405, 401, 400, 502): успешный ответ —
      // это аудио со своим Cache-Control выше. Отказы не кэшируем вообще, иначе
      // промежуточный прокси мог бы придержать 405 или 502 (по RFC 9110 такие
      // коды кэшируемы по умолчанию) и киоск получал бы старый отказ.
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
    body: JSON.stringify(obj),
  };
}
