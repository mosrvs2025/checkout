import { STORE, CATALOG, byKey, byUpc, money, uid, totals, count, hashNum, haptic, el, bus, decidePass, fmtDuration } from './shared.js';
import { openScanner } from './scanner.js';

const KEY = 'exitpass.trip';
const AVG_LINE_MS = 7 * 60e3 + 40e3; // today's simulated average wait in a staffed lane

let trip = load();
let root;
let tick;

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } }
function save(publish = true) {
  try { localStorage.setItem(KEY, JSON.stringify(trip)); } catch {}
  if (publish && trip) bus.send({ type: 'trip', trip });
}

function newTrip() {
  trip = {
    id: uid(), name: 'You', real: true, status: 'shopping',
    startedAt: Date.now(), items: [], trust: 0.9, sensor: null,
    zone: 'Entrance', progress: 0.05,
  };
  save();
}

export function mountShopper(r) {
  root = r;
  document.body.className = 'shopper-body';
  bus.on((msg) => {
    if (!trip) return;
    if (msg.type === 'verify' && msg.tripId === trip.id && trip.status === 'pass') {
      trip.status = 'done'; trip.doneAt = Date.now(); trip.verifiedBy = msg.by;
      save(); haptic([20, 40, 20]); render();
    }
    if (msg.type === 'reset') { trip = null; try { localStorage.removeItem(KEY); } catch {} render(); }
    if (msg.type === 'help-ack' && msg.tripId === trip.id) toast(`${msg.by} is on the way`);
  });
  render();
}

function render() {
  clearInterval(tick);
  const aisleX = root.querySelector('#aisle')?.scrollLeft || 0, y = scrollY;
  root.innerHTML = '';
  requestAnimationFrame(() => { const a = root.querySelector('#aisle'); if (a) { a.scrollLeft = aisleX; scrollTo(0, y); } });
  if (!trip) return root.append(welcome());
  if (trip.status === 'shopping') return root.append(shop());
  if (trip.status === 'pass') return root.append(pass());
  if (trip.status === 'done') return root.append(done());
}

// ---------------- Welcome ----------------
function welcome() {
  const v = el(`
    <main class="screen welcome">
      <div class="welcome-top">
        <div class="store-chip"><span class="dot live"></span> ${STORE.name} · ${STORE.city} #${STORE.number}</div>
      </div>
      <div class="welcome-hero">
        <div class="hero-pass">
          <div class="hp-ring"></div>
          <div class="hp-check">✓</div>
        </div>
        <h1>Checkout happens<br/>while you shop.</h1>
        <p class="lede">Scan as things go in your cart. When you're done, you're already paid — just walk out with your Exit Pass.</p>
      </div>
      <div class="welcome-steps">
        <div><b>1</b><span>Scan into your cart</span></div>
        <div><b>2</b><span>Tap Done — paid instantly</span></div>
        <div><b>3</b><span>Walk out. No line.</span></div>
      </div>
      <button class="btn primary xl" id="go">Start shopping</button>
      <p class="fine">Simulated prototype · No real payment is taken</p>
    </main>`);
  v.querySelector('#go').onclick = () => { haptic(); newTrip(); render(); };
  return v;
}

// ---------------- Shopping ----------------
function shop() {
  const { total } = totals(trip.items);
  const n = count(trip.items);
  const v = el(`
    <main class="screen shop">
      <header class="shop-head">
        <div class="store-chip"><span class="dot live"></span> ${STORE.name} #${STORE.number}</div>
        <button class="icon-btn" id="help" aria-label="Get help">?</button>
      </header>
      <section class="total-card">
        <div class="tc-label">Your cart</div>
        <div class="tc-total" id="total">${money(total)}</div>
        <div class="tc-sub">${n ? `${n} item${n > 1 ? 's' : ''} · tax included · ready to pay` : 'Scan your first item to begin'}</div>
        <div class="tc-status ${trip.sensor?.open ? 'warn' : ''}">
          ${trip.sensor?.open
            ? '<span class="dot amber"></span> Your cart felt something we didn\'t see'
            : `<span class="dot green"></span> ${n ? 'Cart verified — Exit Pass ready' : 'Smart cart connected'}`}
        </div>
      </section>
      ${trip.sensor?.open ? sensorCard() : ''}
      <section class="list" id="list">
        ${trip.items.length ? '' : `<div class="empty">
          <div class="empty-art">🛒</div>
          <p>Tap <b>Scan</b> and point at any barcode.<br/>Or tap a product below to simulate it.</p>
        </div>`}
      </section>
      <section class="aisle">
        <div class="aisle-head"><span>Quick add · simulate scanning</span></div>
        <div class="aisle-row" id="aisle"></div>
      </section>
      <footer class="dock">
        <button class="btn scan" id="scan"><span class="scan-ic"></span> Scan</button>
        <button class="btn primary done" id="done" ${n ? '' : 'disabled'}>Done · ${money(total)}</button>
      </footer>
    </main>`);

  const list = v.querySelector('#list');
  [...trip.items].reverse().forEach((i) => list.append(itemRow(i)));

  const aisle = v.querySelector('#aisle');
  for (const p of CATALOG) {
    const b = el(`<button class="tile" style="--tint:${p.tint}"><span class="tile-emoji">${p.emoji}</span><span class="tile-name">${p.name}</span><span class="tile-price">${money(p.price)}</span></button>`);
    b.onclick = () => addItem(p, b);
    aisle.append(b);
  }

  v.querySelector('#scan').onclick = () => openScanner({ onCode: onBarcode });
  v.querySelector('#done').onclick = finish;
  v.querySelector('#help').onclick = helpSheet;
  v.querySelector('#resolve')?.addEventListener('click', () => resolveSensor(v));
  v.querySelector('#nothing')?.addEventListener('click', () => { trip.sensor = { ...trip.sensor, open: true, disputed: true }; toast('No problem — an associate will take a quick look at the exit'); save(); });
  return v;
}

function sensorCard() {
  return `<section class="sensor-card">
    <div class="sc-ic">⚖️</div>
    <div class="sc-body">
      <b>Something went in without a scan</b>
      <span>Your cart weighed ~${trip.sensor.grams}g more than expected. Happens all the time.</span>
      <div class="sc-actions">
        <button class="btn sm primary" id="resolve">Scan it now</button>
        <button class="btn sm ghost" id="nothing">I didn't add anything</button>
      </div>
    </div>
  </section>`;
}

function resolveSensor() {
  openScanner({ onCode: (code) => { trip.sensor = null; onBarcode(code); } , hint: 'Scan the item you just added' });
}

function itemRow(i) {
  const row = el(`
    <div class="item" data-key="${i.key}">
      <div class="item-art" style="--tint:${i.tint || '#eee'}">${i.image ? `<img src="${i.image}" alt="" loading="lazy" onerror="this.replaceWith('${i.emoji}')">` : i.emoji}</div>
      <div class="item-body">
        <div class="item-name">${i.name}${i.age ? ' <span class="tag">21+</span>' : ''}</div>
        <div class="item-detail">${i.detail || ''}</div>
      </div>
      <div class="qty">
        <button aria-label="Remove one" data-d="-1">−</button><span>${i.qty}</span><button aria-label="Add one" data-d="1">+</button>
      </div>
      <div class="item-price">${money(i.price * i.qty)}</div>
    </div>`);
  row.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => {
    i.qty += +b.dataset.d;
    if (i.qty <= 0) trip.items = trip.items.filter((x) => x !== i);
    haptic(8); save(); render();
  });
  return row;
}

function addItem(p, fromEl) {
  const existing = trip.items.find((i) => i.key === p.key);
  if (existing) existing.qty++;
  else trip.items.push({ ...p, qty: 1, addedAt: Date.now() });
  // Move the shopper through the store for the dashboard's map.
  trip.zone = p.aisle; trip.progress = Math.min(0.85, 0.1 + trip.items.length * 0.07);
  haptic([10, 30, 10]);
  if (fromEl) flyToTotal(fromEl, p.emoji);

  // Demo the cart's weight sensor: occasionally the cart notices an unscanned item.
  const n = count(trip.items);
  if (!trip.sensorShown && n === 5) { trip.sensor = { open: true, grams: 340 + (hashNum(trip.id) % 300) }; trip.sensorShown = true; haptic([30, 60, 30]); }

  save();
  render();
  const row = root.querySelector(`.item[data-key="${p.key}"]`);
  row?.classList.add('just-added');
  bumpTotal();
}

function bumpTotal() { const t = root.querySelector('#total'); t?.classList.remove('bump'); void t?.offsetWidth; t?.classList.add('bump'); }

function flyToTotal(fromEl, emoji) {
  const r = fromEl.getBoundingClientRect();
  const f = el(`<div class="flyer">${emoji}</div>`);
  f.style.left = r.left + r.width / 2 + 'px'; f.style.top = r.top + 'px';
  document.body.append(f);
  requestAnimationFrame(() => { f.style.transform = `translate(${-r.left - r.width / 2 + innerWidth / 2}px, ${-r.top + 120}px) scale(.4)`; f.style.opacity = '0'; });
  setTimeout(() => f.remove(), 650);
}

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

const clean = (v) => String(v || '').replace(/[<>"'`&\\]/g, '').trim();

async function onBarcode(code) {
  const known = byUpc[code];
  if (known) return addItem(known);
  const done = toast(`Identifying ${code}…`, 8000);
  const raw = await lookupProduct(code);
  const info = { ...raw, name: clean(raw.name), brand: clean(raw.brand), size: clean(raw.size), image: /^https:\/\//.test(raw.image || '') ? clean(raw.image) : '' };
  done();
  // Real prices need the store's price file; until then, a stable simulated price per UPC.
  const price = +(1.99 + (hashNum(code) % 1200) / 100).toFixed(2);
  const base = { key: 'upc-' + code, upc: code, price, tint: '#F2F3F5', aisle: 'Aisle ' + (1 + (hashNum(code) % 14)) };
  if (info.found) {
    const brand = info.brand && !info.name.toLowerCase().includes(info.brand.toLowerCase()) ? info.brand + ' ' : '';
    addItem({ ...base, name: (brand + info.name).slice(0, 48), detail: [info.size, `UPC ${code}`].filter(Boolean).join(' · '), image: info.image, emoji: guessEmoji(info.category), age: isAlcohol(info.category) ? 21 : undefined });
  } else {
    nameUnknown(code, base, info.offline);
  }
}

function nameUnknown(code, base, offline) {
  const s = el(`
    <div class="sheet-wrap">
      <form class="sheet">
        <div class="grab"></div>
        <h3>${offline ? 'No signal to look this up' : 'New product to us'}</h3>
        <p class="muted" style="margin:-8px 0 14px">UPC ${code} isn't in the product databases yet. What is it?</p>
        <input class="text-in" placeholder="e.g. Signature Select Tortilla Chips" autofocus />
        <button class="btn primary xl" style="margin-top:14px">Add to cart</button>
      </form>
    </div>`);
  document.body.append(s);
  requestAnimationFrame(() => s.classList.add('open'));
  const close = () => { s.classList.remove('open'); setTimeout(() => s.remove(), 300); };
  s.onclick = (e) => { if (e.target === s) close(); };
  s.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    const name = clean(s.querySelector('input').value) || `Item ${code.slice(-5)}`;
    close();
    addItem({ ...base, name, detail: `UPC ${code} · named by you`, emoji: '🏷️' });
  };
}

// ---------------- Finish: pay + issue pass ----------------
function finish() {
  const { total } = totals(trip.items);
  const sheet = el(`
    <div class="sheet-wrap">
      <div class="sheet pay">
        <div class="grab"></div>
        <div class="pay-row"><span class="pay-logo"> Pay</span><button class="link" id="x">Cancel</button></div>
        <div class="pay-line"><span>VONS #${STORE.number}</span><b>${money(total)}</b></div>
        <div class="pay-line muted"><span>Card</span><span>Visa ···· 4242</span></div>
        <div class="pay-line muted"><span>Items</span><span>${count(trip.items)} · verified by smart cart</span></div>
        <button class="btn primary xl" id="confirm">Confirm & get Exit Pass</button>
        <div class="pay-progress"><div class="spinner"></div><span>Authorizing…</span></div>
      </div>
    </div>`);
  document.body.append(sheet);
  requestAnimationFrame(() => sheet.classList.add('open'));
  const close = () => { sheet.classList.remove('open'); setTimeout(() => sheet.remove(), 300); };
  sheet.querySelector('#x').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  sheet.querySelector('#confirm').onclick = () => {
    sheet.querySelector('.sheet').classList.add('paying');
    haptic(15);
    setTimeout(() => {
      sheet.querySelector('.pay-progress').innerHTML = '<div class="paid-check">✓</div><span>Paid</span>';
      haptic([10, 40, 10]);
      setTimeout(() => {
        close();
        trip.paidAt = Date.now();
        trip.arrivedAt = Date.now();
        trip.pass = decidePass(trip, { force: forced() });
        trip.status = trip.pass.tier === 'green' ? 'done' : 'pass';
        if (trip.status === 'done') trip.doneAt = Date.now() + 9000; // walking to the door
        trip.zone = 'Front'; trip.progress = 1;
        save();
        revealPass();
      }, 650);
    }, 1100);
  };
}

// Hidden demo control: long-press the store chip on the welcome/shop header to cycle outcomes.
function forced() { try { return sessionStorage.getItem('exitpass.force') || undefined; } catch { return undefined; } }

function revealPass() {
  const flash = el(`<div class="reveal ${trip.pass.tier}"></div>`);
  document.body.append(flash);
  setTimeout(() => flash.remove(), 900);
  if (trip.status === 'done') renderGreenWalkout(); else render();
}

// ---------------- The pass ----------------
function passCode(seed) {
  // A live, rotating visual code — screenshots go stale, like a transit pass.
  const n = 21, cells = [];
  const finder = (x, y) => [[0, 0], [n - 7, 0], [0, n - 7]].some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
  const finderOn = (x, y) => { const fx = x < 7 ? x : x - (n - 7), fy = y < 7 ? y : y - (n - 7); const d = Math.max(Math.abs(fx - 3), Math.abs(fy - 3)); return d !== 2; };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const on = finder(x, y) ? finderOn(x, y) : hashNum(seed + ':' + x + ',' + y) % 2 === 0;
    if (on) cells.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02"/>`);
  }
  return `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">${cells.join('')}</svg>`;
}

function pass() {
  const p = trip.pass;
  const { total } = totals(trip.items);
  const v = el(`
    <main class="screen pass-screen amber">
      <div class="pass-card amber">
        <div class="pc-top">
          <span class="pc-brand">EXIT PASS</span>
          <span class="pc-live"><span class="dot pulse"></span><span id="clock"></span></span>
        </div>
        <div class="pc-title">Paid. Quick check<br/>on the way out.</div>
        <div class="pc-lane">Head to <b>${p.lane}</b> · ~10 sec</div>
        <div class="pc-code" id="code">${passCode(p.code + Math.floor(Date.now() / 5000))}</div>
        <div class="pc-checks">
          <div class="pcc-head">Associate checks ${p.checks.length === 1 ? 'just this' : `only these ${p.checks.length}`}</div>
          ${p.checks.map((c) => `<div class="pcc"><span class="pcc-e">${c.emoji}</span><span class="pcc-n">${c.name}</span><span class="pcc-r">${c.reason}</span></div>`).join('')}
        </div>
        <div class="pc-foot"><span>${count(trip.items)} items · ${money(total)} paid</span><span>#${trip.id}</span></div>
      </div>
      <p class="pass-note">${count(trip.items) > p.checks.length ? `Not ${count(trip.items)} items re-scanned. Just ${p.checks.length}.` : 'A 10-second glance, no re-scanning.'} Your receipt is already on your phone.</p>
      <button class="btn ghost" id="demo-verify">Simulate associate tap ✓</button>
    </main>`);
  const clock = v.querySelector('#clock');
  const update = () => {
    clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    v.querySelector('#code').innerHTML = passCode(p.code + Math.floor(Date.now() / 5000));
  };
  update(); tick = setInterval(update, 1000);
  v.querySelector('#demo-verify').onclick = () => {
    trip.status = 'done'; trip.doneAt = Date.now(); trip.verifiedBy = 'Maria';
    save(); haptic([20, 40, 20]); render();
  };
  return v;
}

function renderGreenWalkout() {
  clearInterval(tick);
  root.innerHTML = '';
  const v = el(`
    <main class="screen pass-screen green">
      <div class="pass-card green">
        <div class="pc-top">
          <span class="pc-brand">EXIT PASS</span>
          <span class="pc-live"><span class="dot pulse"></span><span id="clock"></span></span>
        </div>
        <div class="go-mark"><svg viewBox="0 0 52 52"><path d="M14 27l8 8 17-18"/></svg></div>
        <div class="pc-title center">You're done.<br/>Walk out.</div>
        <div class="pc-lane center">No line. No scan. The door knows.</div>
        <div class="pc-foot"><span>${count(trip.items)} items · ${money(totals(trip.items).total)} paid</span><span>#${trip.id}</span></div>
      </div>
      <button class="btn primary xl" id="receipt">I'm out the door</button>
    </main>`);
  const clock = v.querySelector('#clock');
  const update = () => { clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); };
  update(); tick = setInterval(update, 1000);
  v.querySelector('#receipt').onclick = () => { trip.doneAt = Math.min(trip.doneAt, Date.now()); trip.exited = true; save(); render(); };
  root.append(v);
}

function done() {
  if (!trip.exited && trip.pass?.tier === 'green') { renderGreenWalkout(); return document.createComment(''); }
  const { sub, tax, total } = totals(trip.items);
  const exitMs = Math.max(4000, (trip.doneAt || Date.now()) - (trip.arrivedAt || trip.paidAt || Date.now()));
  const saved = Math.max(0, AVG_LINE_MS + 3 * 60e3 - exitMs);
  const v = el(`
    <main class="screen receipt">
      <div class="r-hero">
        <div class="r-check">✓</div>
        <div class="r-big">${fmtDuration(exitMs)}</div>
        <div class="r-cap">from "Done" to out the door</div>
      </div>
      <div class="compare">
        <div class="cmp-row"><span>You, with Exit Pass</span><div class="bar"><i style="width:${Math.max(3, (exitMs / (AVG_LINE_MS + 3 * 60e3)) * 100)}%" class="g"></i></div><b>${fmtDuration(exitMs)}</b></div>
        <div class="cmp-row"><span>Lane 4 right now</span><div class="bar"><i style="width:100%" class="r"></i></div><b>${fmtDuration(AVG_LINE_MS + 3 * 60e3)}</b></div>
        <div class="cmp-save">You skipped about <b>${Math.round(saved / 60e3)} minutes</b> of standing in line.</div>
      </div>
      ${trip.verifiedBy ? `<div class="verified-by">Verified by ${trip.verifiedBy} · ${trip.pass.checks.length} item${trip.pass.checks.length > 1 ? 's' : ''} checked</div>` : ''}
      <section class="r-card">
        <div class="r-head"><b>${STORE.name} #${STORE.number}</b><span>${new Date(trip.paidAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>
        ${trip.items.map((i) => `<div class="r-line"><span>${i.emoji} ${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}</span><span>${money(i.price * i.qty)}</span></div>`).join('')}
        <div class="r-line sep"><span>Subtotal</span><span>${money(sub)}</span></div>
        <div class="r-line"><span>Tax</span><span>${money(tax)}</span></div>
        <div class="r-line total"><span>Paid · Visa 4242</span><span>${money(total)}</span></div>
      </section>
      <button class="btn primary xl" id="again">Start a new trip</button>
    </main>`);
  v.querySelector('#again').onclick = () => { trip = null; try { localStorage.removeItem(KEY); } catch {} render(); };
  return v;
}

// ---------------- Help + toasts ----------------
function helpSheet() {
  const s = el(`
    <div class="sheet-wrap">
      <div class="sheet">
        <div class="grab"></div>
        <h3>Need a hand?</h3>
        <button class="btn block" data-h="price">Price looks wrong</button>
        <button class="btn block" data-h="find">Can't find something</button>
        <button class="btn block" data-h="scan">Barcode won't scan</button>
        <div class="demo-tools">
          <div class="dt-head">Demo controls</div>
          <div class="seg" id="force">
            <button data-f="">Natural</button><button data-f="green">Force green</button><button data-f="audit">Force spot-check</button>
          </div>
          <button class="btn sm ghost" id="restart">Restart trip</button>
        </div>
      </div>
    </div>`);
  document.body.append(s);
  requestAnimationFrame(() => s.classList.add('open'));
  const close = () => { s.classList.remove('open'); setTimeout(() => s.remove(), 300); };
  s.onclick = (e) => { if (e.target === s) close(); };
  s.querySelectorAll('[data-h]').forEach((b) => b.onclick = () => {
    bus.send({ type: 'help', tripId: trip.id, kind: b.textContent, aisle: trip.zone });
    close(); toast('An associate has been pinged with your location');
  });
  const cur = forced() || '';
  s.querySelectorAll('[data-f]').forEach((b) => {
    b.classList.toggle('on', b.dataset.f === cur);
    b.onclick = () => { try { b.dataset.f ? sessionStorage.setItem('exitpass.force', b.dataset.f) : sessionStorage.removeItem('exitpass.force'); } catch {} s.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); };
  });
  s.querySelector('#restart').onclick = () => { close(); trip = null; try { localStorage.removeItem(KEY); } catch {} render(); };
}

export function toast(msg, ms = 2600) {
  const t = el(`<div class="toast">${msg}</div>`);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  const hide = () => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); };
  setTimeout(hide, ms);
  return hide;
}
