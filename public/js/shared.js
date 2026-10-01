// Shared model: catalog, live sync bus, the Exit Pass decision engine, and helpers.

export const STORE = { name: 'Vons', number: '2118', city: 'Pasadena' };

// Real UPCs where we know them, so scanning the actual product in-store hits the catalog.
// Anything else that's scanned is looked up on Open Food Facts and priced deterministically.
export const CATALOG = [
  { key: 'bananas', name: 'Organic Bananas', detail: '2.1 lb · $0.79/lb', price: 1.66, emoji: '🍌', tint: '#FFF3C4', aisle: 'Produce' },
  { key: 'avocado', name: 'Hass Avocados', detail: 'Bag of 4', price: 5.99, emoji: '🥑', tint: '#E3F2D5', aisle: 'Produce' },
  { key: 'strawberries', name: 'Strawberries', detail: '1 lb clamshell', price: 4.49, emoji: '🍓', tint: '#FDE0E0', aisle: 'Produce' },
  { key: 'milk', upc: '041303001110', name: 'Lucerne 2% Milk', detail: '1 gallon', price: 4.79, emoji: '🥛', tint: '#E8F0FB', aisle: 'Dairy' },
  { key: 'eggs', name: 'Large Brown Eggs', detail: 'Dozen, cage-free', price: 6.29, emoji: '🥚', tint: '#F6EBDD', aisle: 'Dairy' },
  { key: 'bread', name: 'Sourdough Loaf', detail: 'Bakery, baked today', price: 4.99, emoji: '🍞', tint: '#F6E6D2', aisle: 'Bakery' },
  { key: 'coffee', upc: '762111206329', name: 'Starbucks Pike Place', detail: '12 oz ground', price: 10.99, emoji: '☕️', tint: '#EADFD6', aisle: 'Aisle 7' },
  { key: 'coke', upc: '049000028911', name: 'Coca-Cola 12 pack', detail: '12 fl oz cans', price: 8.99, emoji: '🥤', tint: '#FBE0E0', aisle: 'Aisle 9' },
  { key: 'pasta', name: 'Barilla Spaghetti', detail: '16 oz', price: 2.29, emoji: '🍝', tint: '#FCEFD3', aisle: 'Aisle 4' },
  { key: 'salmon', name: 'Atlantic Salmon', detail: '1.4 lb · $13.99/lb', price: 19.59, emoji: '🐟', tint: '#FFE5DA', aisle: 'Seafood', highValue: true },
  { key: 'ribeye', name: 'USDA Prime Ribeye', detail: '2 steaks · 1.8 lb', price: 41.38, emoji: '🥩', tint: '#FBDCDC', aisle: 'Meat', highValue: true },
  { key: 'wine', name: 'Josh Cabernet', detail: '750 ml', price: 14.99, emoji: '🍷', tint: '#EBDDF0', aisle: 'Wine', age: 21 },
  { key: 'beer', name: 'Modelo Especial', detail: '12 pack bottles', price: 19.99, emoji: '🍺', tint: '#FFF1CC', aisle: 'Beer', age: 21 },
  { key: 'icecream', name: "Ben & Jerry's", detail: 'Half Baked, pint', price: 5.99, emoji: '🍨', tint: '#F1E8FA', aisle: 'Frozen' },
  { key: 'chips', name: 'Kettle Chips', detail: 'Sea salt, 8 oz', price: 4.29, emoji: '🥔', tint: '#FDF0D0', aisle: 'Aisle 10' },
  { key: 'flowers', name: 'Sunflower Bouquet', detail: 'Floral', price: 12.99, emoji: '🌻', tint: '#FFF2C2', aisle: 'Floral' },
];
export const byKey = Object.fromEntries(CATALOG.map((p) => [p.key, p]));
export const byUpc = Object.fromEntries(CATALOG.filter((p) => p.upc).map((p) => [p.upc, p]));

export const TAX = 0.0725;
export const money = (n) => '$' + (Math.round(n * 100) / 100).toFixed(2);
export const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
export const sum = (items) => items.reduce((s, i) => s + i.price * i.qty, 0);
export const count = (items) => items.reduce((s, i) => s + i.qty, 0);
export const totals = (items) => { const sub = sum(items); const tax = sub * TAX; return { sub, tax, total: sub + tax }; };

export function hashNum(str) { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return Math.abs(h); }

export function haptic(p = 12) { try { navigator.vibrate?.(p); } catch {} }

export function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

// ---------- Live sync bus ----------
// BroadcastChannel always (same-device tabs/iframes). Plus the relay server if present
// (cross-device: shopper phone + associate tablet + store screen).
const listeners = new Set();
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('exitpass') : null;
let serverUp = false;
const seen = new Set();

function deliver(msg) {
  if (msg._id) { if (seen.has(msg._id)) return; seen.add(msg._id); if (seen.size > 500) seen.clear(); }
  listeners.forEach((fn) => fn(msg));
}
bc?.addEventListener('message', (e) => deliver(e.data));

export const bus = {
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  send(msg) {
    msg = { ...msg, _id: uid() + uid() };
    seen.add(msg._id);
    bc?.postMessage(msg);
    if (serverUp) fetch('/api/publish', { method: 'POST', body: JSON.stringify(msg), headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  },
  get live() { return serverUp; },
};

export async function connectRelay() {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    if (!r.ok) return false;
    serverUp = true;
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'snapshot') msg.trips.forEach((trip) => listeners.forEach((fn) => fn({ type: 'trip', trip })));
      else deliver(msg);
    };
    return true;
  } catch { return false; }
}

// ---------- The Exit Pass engine ----------
// The core product idea: verification is targeted, not exhaustive. Instead of re-scanning
// every item, the store decides — per trip — whether you simply walk out, or which
// one-to-three specific items an associate should glance at.
export function decidePass(trip, { force } = {}) {
  const checks = [];
  const add = (item, reason, kind) => { if (!checks.find((c) => c.key === item.key)) checks.push({ key: item.key, name: item.name, emoji: item.emoji, reason, kind }); };

  for (const i of trip.items) if (i.age) add(i, `Check ID · ${i.age}+`, 'id');
  if (trip.sensor?.open) checks.push({ key: 'sensor', name: 'Unmatched item in cart', emoji: '⚖️', reason: 'Cart scale saw weight with no scan', kind: 'sensor' });

  const pricey = trip.items.filter((i) => i.highValue).sort((a, b) => b.price - a.price)[0];
  if (pricey && (trip.trust ?? 0.9) < 0.95) add(pricey, 'High-value spot check', 'value');

  // Random audit keeps everyone honest; seeded per-trip so it's stable across devices.
  const audit = force === 'audit' || (force == null && hashNum(trip.id) % 10 === 0);
  if (audit && trip.items.length >= 4) {
    const pool = [...trip.items].sort((a, b) => hashNum(trip.id + a.key) - hashNum(trip.id + b.key));
    for (const i of pool.slice(0, 2)) add(i, 'Random spot check', 'audit');
  }

  if (force === 'green') checks.length = 0;
  const final = checks.slice(0, 3);
  const tier = final.length ? 'amber' : 'green';
  return {
    tier,
    checks: final,
    lane: tier === 'green' ? 'Exit' : 'Express Check ' + (1 + (hashNum(trip.id) % 3)),
    code: uid(),
    issuedAt: Date.now(),
    confidence: tier === 'green' ? 0.97 + (hashNum(trip.id) % 3) / 100 : 0.8 + (hashNum(trip.id) % 12) / 100,
  };
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
export const ago = (t) => fmtDuration(Date.now() - t);
