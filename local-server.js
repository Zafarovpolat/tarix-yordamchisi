#!/usr/bin/env node
/**
 * Tarix yordamchisi — локальный сервер разработки и показа
 * Поддерживает раздачу статики и эмуляцию Netlify-функций (/api/* и /.netlify/functions/*).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;

// ── Чтение .env без внешних зависимостей ──────────────────────────────────────
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const idx = trimmed.indexOf('=');
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        if (!process.env[k]) {
          process.env[k] = v.replace(/^["'](.*)["']$/, '$1');
        }
      }
    }
  } catch (err) {
    console.warn('[env] Не удалось прочитать .env:', err.message);
  }
}

// Разрешаем все origin для локальной разработки
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// ── Подключение серверных функций ─────────────────────────────────────────────
const answerHandler = require('./netlify/functions/answer').handler;
const ttsHandler = require('./netlify/functions/tts').handler;
const photoHandler = require('./netlify/functions/photo').handler;
const sttHandler = require('./netlify/functions/stt').handler;

const FN_MAP = {
  '/api/answer': answerHandler,
  '/.netlify/functions/answer': answerHandler,
  '/api/tts': ttsHandler,
  '/.netlify/functions/tts': ttsHandler,
  '/api/photo': photoHandler,
  '/.netlify/functions/photo': photoHandler,
  '/api/stt': sttHandler,
  '/.netlify/functions/stt': sttHandler,
};

// ── MIME-типы ─────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

// SVG-фавикон по умолчанию
const DEFAULT_FAVICON = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🏛️</text></svg>`,
  'utf-8'
);

// ── Вызов API-функции (Netlify-эмуляция) ───────────────────────────────────────
async function runApi(route, req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-app-token',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8');

    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const query = {};
    for (const [key, value] of u.searchParams.entries()) {
      query[key] = value;
    }

    const event = {
      path: route,
      httpMethod: req.method,
      headers: req.headers,
      queryStringParameters: query,
      body: rawBody,
      isBase64Encoded: false,
    };

    const handler = FN_MAP[route];
    const result = await handler(event, {});

    let statusCode = result.statusCode || 200;
    let headers = Object.assign({}, result.headers || {});
    let body = result.body || '';

    if (result.isBase64Encoded && typeof body === 'string') {
      body = Buffer.from(body, 'base64');
    }

    if (!('content-type' in headers) && !('Content-Type' in headers)) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }

    if (!headers['Access-Control-Allow-Origin']) {
      headers['Access-Control-Allow-Origin'] = '*';
    }

    res.writeHead(statusCode, headers);
    res.end(body);
  } catch (e) {
    console.error(`[api ${route}]`, e);
    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: e.message || 'Внутренняя ошибка' }));
  }
}

// ── Статика (с защитой от выхода за корень) ──────────────────────────────────
function serveStatic(req, res) {
  const u = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    res.writeHead(400);
    return res.end('400');
  }

  // Обработка фавиконки и иконок apple без 404
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    const file = path.join(ROOT, pathname);
    if (!fs.existsSync(file)) {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(DEFAULT_FAVICON);
    }
  }
  if (pathname.startsWith('/apple-touch-icon')) {
    const file = path.join(ROOT, pathname);
    if (!fs.existsSync(file)) {
      res.writeHead(204);
      return res.end();
    }
  }

  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('403 Forbidden');
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404: ' + pathname);
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Access-Control-Allow-Origin': '*',
      // Модели/транскодер не меняются при разработке — кешируем жёстко
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ── Сервер ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (FN_MAP[route]) {
    runApi(route, req, res);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('405: только GET для статики, POST — на /api/*');
});

server.listen(PORT, HOST, () => {
  console.log('────────────────────────────────────────────');
  console.log(' Tarix yordamchisi — локальный сервер (Netlify не нужен)');
  console.log(`   http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') console.log(`   (доступен в локальной сети по IP вашего компьютера)`);
  console.log(' AISHA_API_KEY:', process.env.AISHA_API_KEY ? 'задан (узбекский STT + TTS через aisha.group)' : 'не задан (резерв: Google / Groq / Edge)');
  console.log(' GROQ_API_KEY:', process.env.GROQ_API_KEY ? 'задан (STT + LLM-ответы)' : 'не задан — работает база фактов, фото и озвучка');
  console.log(' Остановить: Ctrl+C');
  console.log('────────────────────────────────────────────');
});
