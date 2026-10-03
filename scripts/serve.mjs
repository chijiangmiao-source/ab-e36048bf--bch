/**
 * serve.mjs — 零依赖静态文件服务器（含健康响应）。
 *
 *   PORT            监听端口（默认 8080）
 *   HOST            监听地址（默认 0.0.0.0）
 *   STATIC_DIR      静态目录（默认 dist，不存在时回退 src）
 *
 * 路由：
 *   GET /healthz -> 200 {"status":"ok",...}（不依赖任何静态文件）
 *   GET /        -> index.html
 *   GET /<file>  -> 静态资源（限定在静态目录内，拒绝路径穿越）
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

function pickStaticDir() {
  const env = process.env.STATIC_DIR;
  const candidates = env
    ? [path.resolve(env)]
    : [path.join(root, 'dist'), path.join(root, 'src')];
  for (const d of candidates) {
    if (existsSync(d) && statSync(d).isDirectory()) return d;
  }
  return path.join(root, 'src');
}

const STATIC_DIR = pickStaticDir();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { status: 'error', error: 'method-not-allowed' });
  }

  if (pathname === '/healthz' || pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'narrow-bch-verify',
      time: new Date().toISOString(),
      staticDir: path.relative(root, STATIC_DIR) || '.',
    });
  }

  // 静态文件：规范化后必须仍在 STATIC_DIR 内（防穿越）
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(STATIC_DIR, rel));
  if (!filePath.startsWith(STATIC_DIR + path.sep) && filePath !== STATIC_DIR) {
    return sendJson(res, 403, { status: 'error', error: 'forbidden' });
  }

  let data;
  try {
    data = await readFile(filePath);
  } catch {
    return sendJson(res, 404, { status: 'error', error: 'not-found', path: rel });
  }

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    // 静态资源带内容指纹时可长缓存；这里整体不缓存，便于 verify 后即时刷新
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
});

server.listen(PORT, HOST, () => {
  const actual = server.address().port;
  console.log(`[serve] 窄义 BCH 静态页监听 http://${HOST}:${actual}`);
  console.log(`[serve] 静态目录: ${STATIC_DIR}`);
  console.log(`[serve] 健康检查: http://${HOST}:${actual}/healthz`);
});

const shutdown = (sig) => {
  console.log(`[serve] 收到 ${sig}，关闭`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
