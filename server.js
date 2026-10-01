// Zero-dependency dev server: serves /public and relays live trip state between
// devices (shopper phone <-> associate tablet <-> store dashboard) over SSE.
// Without this server the app still works; tabs on one device sync via BroadcastChannel.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 5173;
const ROOT = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

const trips = new Map(); // tripId -> latest trip snapshot
const clients = new Set();

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', trips: [...trips.values()] })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (url.pathname === '/api/publish' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        if (msg.type === 'trip' && msg.trip?.id) {
          if (msg.trip.status === 'done') trips.delete(msg.trip.id);
          else trips.set(msg.trip.id, { ...msg.trip, _seen: Date.now() });
        }
        for (const [id, t] of trips) if (Date.now() - t._seen > 30 * 60e3) trips.delete(id);
        if (msg.type === 'reset') trips.clear();
        broadcast(msg);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }

  if (url.pathname === '/api/ping') { res.writeHead(200).end('ok'); return; }

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
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) console.log(`    http://${n.address}:${PORT}   <- open on your phone (same Wi-Fi)`);
  console.log(`\n  Shopper: /   Associate: /#/associate   Store: /#/store   Demo: /#/demo\n`);
});
