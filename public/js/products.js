// Product identification shared by the shopper app and the POS lanes.
import { byUpc, hashNum } from './shared.js';

const CATEGORY_EMOJI = [
  [/beverage|drink|soda|water|juice|coffee|tea/, '🥤'], [/dair|milk|cheese|yogurt|butter/, '🥛'], [/snack|chip|crisp|cracker/, '🍿'],
  [/cereal|breakfast|oat/, '🥣'], [/chocolate|candy|confection|sweet|cookie|biscuit/, '🍫'], [/bread|bakery/, '🍞'],
  [/pasta|noodle|rice/, '🍝'], [/sauce|condiment|spread|ketchup|dressing/, '🫙'], [/frozen|ice-cream/, '🧊'],
  [/fruit|vegetable|produce/, '🥕'], [/meat|poultry|sausage|chicken|beef/, '🥩'], [/fish|seafood/, '🐟'],
  [/wine|beer|alcohol|spirit/, '🍷'], [/beauty|cosmetic|shampoo|soap|hygiene/, '🧴'], [/pet|dog|cat/, '🐾'],
];
const guessEmoji = (cat = '') => (CATEGORY_EMOJI.find(([re]) => re.test(cat.toLowerCase())) || [0, '🏷️'])[1];
const isAlcohol = (cat = '') => /en:(wines|beers|alcoholic-beverages|spirits)|alcohol/i.test(cat);
const lookupCache = new Map();

export async function lookupProduct(code) {
  if (lookupCache.has(code)) return lookupCache.get(code);
  let out = null;
  try { // Server-side lookup across several product databases (Vercel function / local server).
    const r = await fetch(`api/lookup?code=${code}`, { signal: AbortSignal.timeout(7000) });
    if (r.ok && r.headers.get('content-type')?.includes('json')) out = await r.json();
  } catch {}
  if (!out) { // Static hosting without functions: query Open Food Facts straight from the browser.
    try {
      const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_en,brands,quantity,image_front_small_url,categories_tags`, { signal: AbortSignal.timeout(5000) });
      const p = (await r.json()).product;
      const name = p && (p.product_name_en || p.product_name);
      out = name ? { found: true, name, brand: (p.brands || '').split(',')[0], size: p.quantity || '', image: p.image_front_small_url || '', category: (p.categories_tags || []).join(' ') } : { found: false };
    } catch { out = { found: false, offline: true }; }
  }
  if (out.found) lookupCache.set(code, out);
  return out;
}

export const clean = (v) => String(v || '').replace(/[<>"'`&\\]/g, '').trim();


// Real prices need the store's price file; until then, a stable simulated price per UPC.
export const priceFor = (code) => +(1.99 + (hashNum(code) % 1200) / 100).toFixed(2);

// -> { item } when identified, else { base, offline } so the caller can ask for a name.
export async function itemFromCode(code) {
  if (byUpc[code]) return { item: byUpc[code] };
  const raw = await lookupProduct(code);
  const info = { ...raw, name: clean(raw.name), brand: clean(raw.brand), size: clean(raw.size), image: /^https:\/\//.test(raw.image || '') ? clean(raw.image) : '' };
  const base = { key: 'upc-' + code, upc: code, price: priceFor(code), tint: '#F2F3F5', aisle: 'Aisle ' + (1 + (hashNum(code) % 14)) };
  if (!info.found) return { base, offline: raw.offline };
  const brand = info.brand && !info.name.toLowerCase().includes(info.brand.toLowerCase()) ? info.brand + ' ' : '';
  return { item: { ...base, name: (brand + info.name).slice(0, 48), detail: [info.size, `UPC ${code}`].filter(Boolean).join(' · '), image: info.image, emoji: guessEmoji(info.category), age: isAlcohol(info.category) ? 21 : undefined } };
}
