// Live sync between devices (shopper phone, registers, associate handhelds, store screen).
// Protocol: clients GET once with no `since` for a snapshot, POST messages, and poll
// `GET ?since=<seq>` about once a second.
// Backends:
//   - Upstash Redis (Vercel Marketplace → Storage → Upstash). Reliable across serverless instances.
//   - In-memory. Perfect for `npm start`; on Vercel it only works while one warm instance serves everyone.

const MAX_MSGS = 400;
const TTL_S = 3 * 3600;
const TRIP_STALE_MS = 45 * 60e3;

function applyTrip(msg, setTrip, delTrip) {
  if (msg.type !== 'trip' || !msg.trip?.id) return;
  if (msg.trip.status === 'done') return delTrip(msg.trip.id);
  return setTrip(msg.trip.id, { ...msg.trip, _seen: Date.now() });
}
const fresh = (t) => Date.now() - (t._seen || 0) < TRIP_STALE_MS;

function memoryStore() {
  let seq = 0;
  const msgs = [];
  const trips = new Map();
  return {
    name: 'memory',
    async publish(msg) {
      seq++;
      msgs.push({ seq, msg });
      if (msgs.length > MAX_MSGS) msgs.shift();
      if (msg.type === 'reset') trips.clear();
      applyTrip(msg, (id, t) => trips.set(id, t), (id) => trips.delete(id));
      return seq;
    },
    async since(n) {
      if (n == null || n > seq) return { seq, reset: true, trips: [...trips.values()].filter(fresh), msgs: [] };
      return { seq, msgs: msgs.filter((m) => m.seq > n).map((m) => m.msg) };
    },
  };
}

function upstashStore(url, token) {
  const redis = async (cmds) => {
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds),
    });
    if (!r.ok) throw new Error('upstash ' + r.status);
    return (await r.json()).map((x) => { if (x.error) throw new Error(x.error); return x.result; });
  };
  return {
    name: 'upstash',
    async publish(msg) {
      const [seq] = await redis([['INCR', 'ep:seq'], ['EXPIRE', 'ep:seq', TTL_S]]);
      const cmds = [
        ['ZADD', 'ep:msgs', seq, JSON.stringify({ seq, msg })],
        ['ZREMRANGEBYRANK', 'ep:msgs', 0, -(MAX_MSGS + 1)],
        ['EXPIRE', 'ep:msgs', TTL_S],
      ];
      if (msg.type === 'reset') cmds.push(['DEL', 'ep:trips']);
      applyTrip(msg, (id, t) => cmds.push(['HSET', 'ep:trips', id, JSON.stringify(t)], ['EXPIRE', 'ep:trips', TTL_S]), (id) => cmds.push(['HDEL', 'ep:trips', id]));
      await redis(cmds);
      return seq;
    },
    async since(n) {
      const [seqRaw] = await redis([['GET', 'ep:seq']]);
      const seq = +seqRaw || 0;
      if (n == null || n > seq) {
        const [vals] = await redis([['HVALS', 'ep:trips']]);
        return { seq, reset: true, trips: (vals || []).map((v) => JSON.parse(v)).filter(fresh), msgs: [] };
      }
      const [rows] = await redis([['ZRANGEBYSCORE', 'ep:msgs', '(' + n, '+inf']]);
      return { seq, msgs: (rows || []).map((r) => JSON.parse(r).msg) };
    },
  };
}

let store;
function getStore() {
  if (store) return store;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  store = url && token ? upstashStore(url, token) : memoryStore();
  return store;
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 256e3) throw new Error('too big'); }
  return JSON.parse(raw || '{}');
}

async function handler(req, res) {
  const s = getStore();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('x-sync-backend', s.name);
  try {
    if (req.method === 'POST') {
      const msg = await readBody(req);
      if (!msg || typeof msg.type !== 'string') { res.statusCode = 400; return res.end('{"error":"bad message"}'); }
      const seq = await s.publish(msg);
      res.statusCode = 200; return res.end(JSON.stringify({ seq }));
    }
    // No `since` = new client asking for the snapshot of live trips; `since=N` = messages after N.
    const raw = new URL(req.url, 'http://x').searchParams.get('since');
    const since = raw == null || raw === '' ? null : +raw || 0;
    res.statusCode = 200;
    return res.end(JSON.stringify({ backend: s.name, ...(await s.since(since)) }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}

module.exports = handler;
module.exports.memoryStore = memoryStore;
