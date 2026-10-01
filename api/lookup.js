// GET /api/lookup?code=049000028911 -> { found, name, brand, size, image, category, source }
// Runs as a Vercel serverless function, and is also mounted by server.js for local dev.
// Queries several open product databases in parallel and returns the best match.

const UA = 'ExitPass/0.1 (grocery checkout prototype)';
const TIMEOUT = 4000;

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// Open Food Facts and its sister databases (beauty, pet food, general products) share one API.
async function openFacts(host, code) {
  const fields = 'product_name,product_name_en,generic_name,brands,quantity,image_front_small_url,image_front_url,categories_tags';
  for (const c of code.length === 12 ? [code, '0' + code] : [code]) {
    try {
      const d = await getJson(`https://${host}/api/v2/product/${c}.json?fields=${fields}`);
      const p = d.product;
      const name = p && (p.product_name_en || p.product_name || p.generic_name);
      if (name) {
        return {
          name: name.trim(), brand: (p.brands || '').split(',')[0].trim(), size: p.quantity || '',
          image: p.image_front_small_url || p.image_front_url || '', category: (p.categories_tags || []).join(' '), source: host.split('.')[1],
        };
      }
    } catch {}
  }
  return null;
}

async function upcItemDb(code) {
  try {
    const d = await getJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`);
    const it = d.items?.[0];
    if (!it?.title) return null;
    return { name: it.title.trim(), brand: it.brand || '', size: it.size || '', image: (it.images || []).find((u) => u.startsWith('https')) || '', category: it.category || '', source: 'upcitemdb' };
  } catch { return null; }
}

async function lookup(code) {
  const results = await Promise.all([
    openFacts('world.openfoodfacts.org', code),
    upcItemDb(code),
    openFacts('world.openproductsfacts.org', code),
    openFacts('world.openbeautyfacts.org', code),
    openFacts('world.openpetfoodfacts.org', code),
  ]);
  const hit = results.filter(Boolean);
  if (!hit.length) return { found: false, code };
  // Prefer a record that has a photo; fill gaps from the others.
  const best = { ...(hit.find((h) => h.image) || hit[0]) };
  for (const h of hit) for (const k of ['brand', 'size', 'image', 'category']) best[k] ||= h[k];
  return { found: true, code, ...best };
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const code = (url.searchParams.get('code') || '').replace(/\D/g, '');
  res.setHeader('Content-Type', 'application/json');
  if (code.length < 8 || code.length > 14) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad code' })); }
  const out = await lookup(code);
  res.setHeader('Cache-Control', out.found ? 'public, s-maxage=604800, max-age=86400' : 'public, s-maxage=3600');
  res.statusCode = 200;
  res.end(JSON.stringify(out));
}

module.exports = handler;
module.exports.lookup = lookup;
