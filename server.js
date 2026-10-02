// Zero-dependency local server: serves /public plus the same API routes Vercel runs
// (/api/sync for live multi-device sync, /api/lookup for product identification).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sync = require('./lib/sync.js');
const lookup = require('./api/lookup.js');

const PORT = process.env.PORT || 5173;
const ROOT = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.wasm': 'application/wasm',
};
// Same security headers Vercel sends (see vercel.json), so local testing matches production.
const SECURITY = {"Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self' https://world.openfoodfacts.org; media-src 'self' blob: mediastream:; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=()", "X-Frame-Options": "SAMEORIGIN"};
const API = { '/api/sync': sync, '/api/lookup': lookup };

const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  const api = API[url.pathname];
  if (api) { Promise.resolve(api(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); return; }

  let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Exit Pass running:\n    http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces()))
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) console.log(`    http://${n.address}:${PORT}   <- same Wi-Fi`);
  console.log(`\n  Shopper /   Register /#/pos   Self-checkout /#/sco   Associate /#/associate   Store /#/store   Demo /#/demo\n`);
});
