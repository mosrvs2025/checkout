import { STORE, CATALOG, byUpc, money, uid, totals, savings, count, hashNum, haptic, el, bus, decidePass, fmtDuration, passPayload, recallCode } from './shared.js';
import { openScanner } from './scanner.js';
import { itemFromCode, clean } from './products.js';
import qrcode from '../vendor/qrcode.js';

const KEY = 'exitpass.trip';
const PROFILE = 'exitpass.profile';
const HISTORY = 'exitpass.history';
const AVG_LINE_MS = 10 * 60e3 + 40e3; // today's simulated wait in a staffed lane

const read = (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let trip = read(KEY);
let profile = read(PROFILE);
let history = read(HISTORY, []);
let root, tick;
let tab = 'home', viewing = null, onboardStep = 0, laneBanner = null;

function save(publish = true) {
  write(KEY, trip);
  if (publish && trip) bus.send({ type: 'trip', trip });
}

function newTrip() {
  trip = {
    id: uid(), name: 'You', real: true, status: 'shopping', shopperName: profile?.name || 'Guest',
    card: profile?.card || 'Visa ···· 4242', startedAt: Date.now(), items: [], trust: 0.9, sensor: null,
    zone: 'Entrance', progress: 0.05, adjustments: [], smartCart: smartCartOn(),
  };
  save();
}

// Demo setting: is the shopper using a smart cart (Caper/Shopic-style scale + sensors)?
// Off by default — Exit Pass works phone-only; the cart just lowers how often we spot-check.
function smartCartOn() { try { return localStorage.getItem('exitpass.smartcart') === '1'; } catch { return false; } }

function endTrip() {
  if (trip && trip.status === 'done' && !history.find((h) => h.id === trip.id)) {
    history = [{ ...trip, archivedAt: Date.now() }, ...history].slice(0, 25);
    write(HISTORY, history);
  }
  trip = null; laneBanner = null; write(KEY, null); tab = 'home';
}

export function mountShopper(r) {
  root = r;
  document.body.className = 'shopper-body';
  // Dead zones are common in stores: keep scanning offline, re-sync the moment signal returns.
  addEventListener('online', () => { if (trip) save(); toast('Back online'); render(); });
  addEventListener('offline', () => render());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(!!root.querySelector('.pass-screen')); });
  bus.on((msg) => {
    if (!trip || msg.tripId !== trip.id) { if (msg.type === 'reset' && trip) { trip = null; write(KEY, null); render(); } return; }
    if (msg.type === 'verify' && trip.status === 'pass') {
      trip.status = 'done'; trip.doneAt = Date.now(); trip.verifiedBy = msg.by;
      save(); haptic([20, 40, 20]); render();
    }
    if (msg.type === 'pos.recall' && (trip.status === 'pass' || trip.status === 'exit')) { laneBanner = msg.laneName; haptic(15); render(); }
    if (msg.type === 'pos.adjust') {
      const ex = trip.items.find((i) => i.key === msg.item.key);
      if (msg.kind === 'add') ex ? ex.qty++ : trip.items.push({ ...msg.item, qty: 1, addedAtLane: msg.laneName });
      if (msg.kind === 'void' && ex) { ex.qty--; if (ex.qty <= 0) trip.items = trip.items.filter((i) => i !== ex); }
      trip.adjustments = [...(trip.adjustments || []), { kind: msg.kind, name: msg.item.name, amount: msg.amount, lane: msg.laneName }];
      save(); haptic([10, 30, 10]); render();
      toast(msg.kind === 'add' ? `${msg.laneName} added ${msg.item.name} · ${money(msg.amount)} charged` : `${msg.item.name} removed · ${money(-msg.amount)} refunded`, 3500);
    }
    if (msg.type === 'pos.close' && trip.status !== 'done') {
      trip.status = 'done'; trip.doneAt = Date.now(); trip.verifiedBy = `${msg.laneName} · ${msg.by}`; trip.closedTxn = msg.txnId;
      save(); haptic([20, 40, 20]); render();
    }
    if (msg.type === 'help-ack') toast(`${msg.by} is on the way`);
  });
  render();
}

// Keep the screen on while a pass is showing — nobody wants to unlock their phone at the door.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}

function render() {
  clearInterval(tick);
  queueMicrotask(() => keepAwake(!!root.querySelector('.pass-screen')));
  const aisleX = root.querySelector('#aisle')?.scrollLeft || 0, y = scrollY;
  root.innerHTML = '';
  requestAnimationFrame(() => { const a = root.querySelector('#aisle'); if (a) { a.scrollLeft = aisleX; scrollTo(0, y); } });
  if (!profile) return root.append(onboarding());
  if (viewing) return root.append(receiptView(viewing, { fromHistory: true }));
  if (!trip) return root.append(home());
  if (trip.status === 'shopping') return root.append(shop());
  if (trip.status === 'pass') return root.append(pass());
  if (trip.status === 'exit') return root.append(exitPass());
  if (trip.status === 'done') return root.append(done());
}

// ---------------- Onboarding ----------------
function onboarding() {
  const steps = [welcomeStep, phoneStep, codeStep, payStep];
  return steps[onboardStep]();
}
const next = () => { onboardStep++; haptic(); render(); };

function welcomeStep() {
  const v = el(`
    <main class="screen welcome">
      <div class="welcome-top"><div class="store-chip"><span class="dot live"></span> ${STORE.name} · ${STORE.city} #${STORE.number}</div></div>
      <div class="welcome-hero">
        <div class="hero-pass"><div class="hp-ring"></div><div class="hp-check">✓</div></div>
        <h1>Checkout happens<br/>while you shop.</h1>
        <p class="lede">Scan as things go in your cart. When you're done, you're already paid — just scan out at the door with your Exit Pass.</p>
      </div>
      <div class="welcome-steps">
        <div><b>1</b><span>Scan into your cart</span></div>
        <div><b>2</b><span>Tap Done — paid instantly</span></div>
        <div><b>3</b><span>Scan out at the door. No line.</span></div>
      </div>
      <button class="btn primary xl" id="go">Get started</button>
      <p class="fine">Simulated prototype · No real payment is taken</p>
    </main>`);
  v.querySelector('#go').onclick = next;
  return v;
}

function phoneStep() {
  const v = el(`
    <main class="screen onb">
      <div class="onb-top"><span class="onb-dots"><i class="on"></i><i></i><i></i></span></div>
      <div class="vfu">vons <b>for U</b></div>
      <h2>Sign in with your Vons for U number</h2>
      <p class="muted">Your member prices and rewards apply automatically.</p>
      <form id="f"><input class="text-in big" type="tel" inputmode="tel" autocomplete="tel" placeholder="(626) 555-0142" id="ph" /><button class="btn primary xl">Send code</button></form>
      <button class="link onb-skip" id="guest">Continue as guest</button>
    </main>`);
  const ph = v.querySelector('#ph');
  ph.oninput = () => { const d = ph.value.replace(/\D/g, '').slice(0, 10); ph.value = d.length > 6 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d.length > 3 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : d; };
  v.querySelector('#f').onsubmit = (e) => { e.preventDefault(); onbPhone = ph.value || '(626) 555-0142'; next(); };
  v.querySelector('#guest').onclick = () => { onbPhone = ''; onboardStep = 3; render(); };
  return v;
}
let onbPhone = '';

function codeStep() {
  const v = el(`
    <main class="screen onb">
      <div class="onb-top"><button class="link" id="back">‹ Back</button><span class="onb-dots"><i></i><i class="on"></i><i></i></span></div>
      <h2>Enter the code we texted to ${onbPhone}</h2>
      <div class="otp">${'<span></span>'.repeat(6)}</div>
      <p class="muted center" id="hint">From Messages…</p>
    </main>`);
  v.querySelector('#back').onclick = () => { onboardStep = 1; render(); };
  const code = String(100000 + (hashNum(onbPhone) % 899999));
  const boxes = v.querySelectorAll('.otp span');
  [...code].forEach((d, i) => setTimeout(() => { boxes[i].textContent = d; boxes[i].classList.add('on'); haptic(5); if (i === 5) setTimeout(next, 450); }, 900 + i * 90));
  return v;
}

function payStep() {
  const v = el(`
    <main class="screen onb">
      <div class="onb-top"><span class="onb-dots"><i></i><i></i><i class="on"></i></span></div>
      <h2>How should we pay when you tap Done?</h2>
      <input class="text-in big" id="nm" placeholder="Your first name" autocomplete="given-name" />
      <div class="pay-opts">
        <button class="pay-opt on" data-c="Apple Pay"><span class="po-logo"></span><div><b>Apple Pay</b><small>Face ID at Done</small></div></button>
        <button class="pay-opt" data-c="Visa ···· 4242"><span class="po-logo visa">VISA</span><div><b>Visa ···· 4242</b><small>Saved card</small></div></button>
        <button class="pay-opt" data-c="Vons Rewards Mastercard ···· 8810"><span class="po-logo mc">●●</span><div><b>Rewards Mastercard ···· 8810</b><small>2× points on groceries</small></div></button>
      </div>
      <button class="btn primary xl" id="done">Start using Exit Pass</button>
      <p class="fine">Nothing is charged until you tap Done in the store.</p>
    </main>`);
  let card = 'Apple Pay';
  v.querySelectorAll('.pay-opt').forEach((b) => b.onclick = () => { card = b.dataset.c; v.querySelectorAll('.pay-opt').forEach((x) => x.classList.toggle('on', x === b)); haptic(6); });
  v.querySelector('#done').onclick = () => {
    profile = { name: clean(v.querySelector('#nm').value) || 'there', phone: onbPhone, member: !!onbPhone, card, since: Date.now() };
    write(PROFILE, profile); onboardStep = 0; haptic([10, 30, 10]); render();
  };
  return v;
}

// ---------------- Home (no active trip) ----------------
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }

function home() {
  const savedMin = Math.round(history.reduce((s, t) => s + Math.max(0, AVG_LINE_MS - ((t.doneAt || 0) - (t.arrivedAt || 0))), 0) / 60e3);
  const memberSaved = history.reduce((s, t) => s + savings(t.items), 0);
  const v = el(`
    <main class="screen home">
      <header class="home-head"><div><div class="muted sm">${greeting()}</div><h1>${profile.name === 'there' ? 'Welcome' : profile.name}</h1></div><button class="avatar-btn" id="acct">${(profile.name[0] || 'G').toUpperCase()}</button></header>
      ${tab === 'home' ? `
        <section class="store-card">
          <div class="sc-row"><span class="dot live"></span><span>You're at <b>${STORE.name} ${STORE.city}</b> · #${STORE.number}</span></div>
          <div class="sc-meta">Lanes right now: ~${fmtDuration(AVG_LINE_MS)} wait · Exit Pass: no wait</div>
          <button class="btn primary xl" id="go">Start shopping</button>
        </section>
        <section class="stat-row">
          <div class="stat"><b>${savedMin}<small> min</small></b><span>line time skipped</span></div>
          <div class="stat"><b>${money(memberSaved)}</b><span>${profile.member ? 'Vons for U savings' : 'join Vons for U to save'}</span></div>
          <div class="stat"><b>${history.length}</b><span>trips</span></div>
        </section>
        ${history.length ? `<h3 class="sec-h">Recent</h3>${historyList(3)}` : `<div class="hint-card"><b>Tip</b> Point your camera at any barcode in the store. Name brands are recognized automatically.</div>`}
      ` : ''}
      ${tab === 'trips' ? `<h3 class="sec-h">Your trips</h3>${history.length ? historyList(25) : '<div class="empty"><div class="empty-art">🧾</div><p>Receipts from your Exit Pass trips show up here.</p></div>'}` : ''}
      ${tab === 'account' ? accountHtml() : ''}
      <nav class="tabbar">
        <button data-t="home" class="${tab === 'home' ? 'on' : ''}"><i>⌂</i>Home</button>
        <button data-t="trips" class="${tab === 'trips' ? 'on' : ''}"><i>🧾</i>Trips</button>
        <button data-t="account" class="${tab === 'account' ? 'on' : ''}"><i>◎</i>Account</button>
      </nav>
    </main>`);
  v.querySelector('#go')?.addEventListener('click', () => { haptic(); newTrip(); render(); });
  v.querySelector('#acct').onclick = () => { tab = 'account'; render(); };
  v.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { tab = b.dataset.t; haptic(5); render(); });
  v.querySelectorAll('[data-h]').forEach((b) => b.onclick = () => { viewing = history.find((h) => h.id === b.dataset.h); render(); });
  v.querySelector('#signout')?.addEventListener('click', () => { if (confirm('Sign out and clear trips on this phone?')) { write(PROFILE, null); write(HISTORY, null); profile = null; history = []; tab = 'home'; render(); } });
  bindDemoControls(v);
  return v;
}

function historyList(n) {
  return `<div class="hist">${history.slice(0, n).map((t) => `
    <button class="hist-row" data-h="${t.id}">
      <div class="hr-ic ${t.pass?.tier || 'green'}">✓</div>
      <div class="hr-b"><b>${STORE.name} ${STORE.city}</b><span>${new Date(t.paidAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${count(t.items)} items · out in ${fmtDuration(Math.max(4000, (t.doneAt || 0) - (t.arrivedAt || 0)))}</span></div>
      <div class="hr-p">${money(totals(t.items).total)}</div>
    </button>`).join('')}</div>`;
}

function accountHtml() {
  return `
    <section class="acct">
      <div class="acct-row"><span>Name</span><b>${profile.name}</b></div>
      <div class="acct-row"><span>Vons for U</span><b>${profile.member ? profile.phone : 'Not linked'}</b></div>
      <div class="acct-row"><span>Pays with</span><b>${profile.card}</b></div>
      <button class="btn block ghost" id="signout">Sign out</button>
    </section>
    ${demoControlsHtml()}`;
}

function demoControlsHtml() {
  return `<div class="demo-tools">
    <div class="dt-head">Demo controls</div>
    <div class="seg" id="force"><button data-f="">Natural</button><button data-f="green">Force green</button><button data-f="audit">Force spot-check</button></div>
    <div class="seg" id="cart"><button data-cart="0">Phone only</button><button data-cart="1">With smart cart</button></div>
    <div class="dt-note">Smart cart applies to the next trip you start.</div>
    <div class="dt-links"><a href="#/exit">Exit scanner</a><a href="#/pos">Register (Lane 4)</a><a href="#/sco">Self-checkout</a><a href="#/associate">Associate</a><a href="#/store">Store</a><a href="#/demo">Demo view</a></div>
    <div class="dt-sync">Sync: ${bus.live ? `cross-device (${bus.backend})` : 'this device only'}</div>
  </div>`;
}

function bindDemoControls(v) {
  const cur = forced() || '';
  v.querySelectorAll('[data-f]').forEach((b) => {
    b.classList.toggle('on', b.dataset.f === cur);
    b.onclick = () => { try { b.dataset.f ? sessionStorage.setItem('exitpass.force', b.dataset.f) : sessionStorage.removeItem('exitpass.force'); } catch {} v.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); };
  });
  const cart = smartCartOn() ? '1' : '0';
  v.querySelectorAll('[data-cart]').forEach((b) => {
    b.classList.toggle('on', b.dataset.cart === cart);
    b.onclick = () => { try { localStorage.setItem('exitpass.smartcart', b.dataset.cart); } catch {} v.querySelectorAll('[data-cart]').forEach((x) => x.classList.toggle('on', x === b)); };
  });
  v.querySelectorAll('.dt-links a').forEach((a) => a.onclick = (e) => { e.preventDefault(); location.hash = a.getAttribute('href'); });
}

// ---------------- Shopping ----------------
function shop() {
  const { total } = totals(trip.items);
  const n = count(trip.items);
  const v = el(`
    <main class="screen shop">
      <header class="shop-head">
        <div class="store-chip"><span class="dot live"></span> ${STORE.name} #${STORE.number}</div>
        <button class="icon-btn" id="help" aria-label="Help and options">⋯</button>
      </header>
      <section class="total-card">
        <div class="tc-label">Your cart</div>
        <div class="tc-total" id="total" aria-live="polite">${money(total)}</div>
        <div class="tc-sub">${n ? `${n} item${n > 1 ? 's' : ''} · tax included · ready to pay` : 'Scan your first item to begin'}</div>
        ${savings(trip.items) > 0 ? `<div class="tc-save">Vons for U savings <b>−${money(savings(trip.items))}</b></div>` : ''}
        <div class="tc-status ${trip.sensor?.open ? 'warn' : ''}">
          ${trip.sensor?.open
            ? '<span class="dot amber"></span> Your cart felt something we didn\'t see'
            : trip.smartCart
              ? `<span class="dot green"></span> ${n ? 'Smart cart weight matches your scans' : 'Smart cart connected'}`
              : `<span class="dot green"></span> ${n ? 'Scanned by you · scan out at the exit' : 'Scan items as they go in your cart'}`}
        </div>
      </section>
      ${trip.sensor?.open ? sensorCard() : ''}
      <section class="list" id="list">
        ${trip.items.length ? '' : `<div class="empty">
          <div class="empty-art">🛒</div>
          <p>Tap <b>Scan</b> and point at any barcode.<br/>Loose produce? Tap <b>🥕</b>. Or tap a product below to simulate a scan.</p>
        </div>`}
      </section>
      <section class="aisle">
        <div class="aisle-head"><span>Quick add · simulate scanning</span></div>
        <div class="aisle-row" id="aisle"></div>
      </section>
      <footer class="dock">
        ${navigator.onLine ? '' : '<div class="offline-pill">No signal · keep scanning, pay when you\'re back online</div>'}
        <button class="btn scan" id="scan" aria-label="Scan a barcode"><span class="scan-ic"></span> Scan</button>
        <button class="btn nobar" id="produce" aria-label="Add produce or items without a barcode">🥕</button>
        <button class="btn primary done" id="done" ${n && navigator.onLine ? '' : 'disabled'}>Done · ${money(total)}</button>
      </footer>
    </main>`);

  const list = v.querySelector('#list');
  [...trip.items].reverse().forEach((i) => list.append(itemRow(i)));

  const aisle = v.querySelector('#aisle');
  for (const p of CATALOG.filter((x) => !x.hidden)) {
    const b = el(`<button class="tile" style="--tint:${p.tint}"><span class="tile-emoji">${p.emoji}</span><span class="tile-name">${p.name}</span><span class="tile-price">${p.reg ? `<s>${money(p.reg)}</s> ` : ''}${money(p.price)}</span></button>`);
    b.onclick = () => addItem(p, b);
    aisle.append(b);
  }

  v.querySelector('#scan').onclick = () => openScanner({ onCode: onBarcode });
  v.querySelector('#produce').onclick = produceSheet;
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
      <div class="item-art" style="--tint:${i.tint || '#eee'}">${i.image ? `<img src="${i.image}" alt="" loading="lazy">` : i.emoji}</div>
      <div class="item-body">
        <div class="item-name">${i.name}${i.age ? ' <span class="tag">21+</span>' : ''}</div>
        <div class="item-detail">${i.reg ? `<span class="club">Vons for U</span> ` : ''}${i.detail || ''}</div>
      </div>
      <div class="qty">
        <button aria-label="Remove one" data-d="-1">−</button><span>${i.qty}</span><button aria-label="Add one" data-d="1">+</button>
      </div>
      <div class="item-price">${money(i.price * i.qty)}</div>
    </div>`);
  row.querySelector('img')?.addEventListener('error', (e) => e.target.replaceWith(i.emoji || '🏷️'));
  row.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => {
    const before = trip.items.map((x) => ({ ...x }));
    i.qty += +b.dataset.d;
    if (i.qty <= 0) {
      trip.items = trip.items.filter((x) => x !== i);
      snack(i, 'Removed', () => { trip.items = before; save(); render(); });
    }
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
  if (trip.smartCart && !trip.sensorShown && n === 5) { trip.sensor = { open: true, grams: 340 + (hashNum(trip.id) % 300) }; trip.sensorShown = true; haptic([30, 60, 30]); }

  save();
  render();
  const row = root.querySelector(`.item[data-key="${p.key}"]`);
  row?.classList.add('just-added');
  bumpTotal();
  snack(p, money(p.price), () => {
    const it = trip.items.find((x) => x.key === p.key);
    if (it) { it.qty--; if (it.qty <= 0) trip.items = trip.items.filter((x) => x !== it); }
    save(); render();
  });
}

// Bottom confirmation for every add/remove, with Undo — mis-scans and double-scans happen.
let snackTimer;
function snack(item, label, undo) {
  document.querySelector('.snack')?.remove();
  clearTimeout(snackTimer);
  const s = el(`<div class="snack" role="status"><span class="sn-art">${item.image ? `<img src="${item.image}" alt="">` : item.emoji || '🏷️'}</span><span class="sn-t"><b>${item.name}</b><small>${label}</small></span><button class="sn-undo">Undo</button></div>`);
  s.querySelector('img')?.addEventListener('error', (e) => e.target.replaceWith(item.emoji || '🏷️'));
  s.querySelector('.sn-undo').onclick = () => { s.remove(); haptic(8); undo(); };
  document.body.append(s);
  requestAnimationFrame(() => s.classList.add('in'));
  snackTimer = setTimeout(() => { s.classList.remove('in'); setTimeout(() => s.remove(), 250); }, 3500);
}

// Loose produce and anything else without a barcode: search by name or PLU sticker.
function produceSheet() {
  const s = el(`
    <div class="sheet-wrap">
      <div class="sheet tall">
        <div class="grab"></div>
        <h3>No barcode?</h3>
        <input class="text-in" id="q" placeholder="Search, or type the PLU on the sticker (e.g. 4011)" inputmode="search" autocomplete="off" />
        <div class="prod-grid" id="pg"></div>
      </div>
    </div>`);
  document.body.append(s);
  requestAnimationFrame(() => s.classList.add('open'));
  const close = () => { s.classList.remove('open'); setTimeout(() => s.remove(), 300); };
  s.onclick = (e) => { if (e.target === s) close(); };
  const pg = s.querySelector('#pg');
  const paint = (q = '') => {
    q = q.trim().toLowerCase();
    const list = CATALOG.filter((c) => c.produce || (!c.upc && !c.hidden))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.plu === q);
    pg.innerHTML = list.length ? '' : '<div class="muted sm">Nothing matches. Ask an associate with the ⋯ menu.</div>';
    for (const c of list) {
      const b = el(`<button class="prod" style="--tint:${c.tint}"><span>${c.emoji}</span><b>${c.name}</b><small>${c.plu ? `PLU ${c.plu} · ` : ''}${c.perLb ? `${money(c.perLb)}/lb` : c.each ? `${money(c.price)} each` : money(c.price)}</small></button>`);
      b.onclick = () => (c.perLb ? weighSheet(c, close) : (close(), addItem(c)));
      pg.append(b);
    }
  };
  s.querySelector('#q').oninput = (e) => paint(e.target.value);
  paint();
}

function weighSheet(c, closeParent) {
  const host = document.querySelector('.sheet.tall');
  const opts = [0.5, 1, 1.5, 2, 3, 4];
  host.innerHTML = `
    <div class="grab"></div>
    <h3>${c.emoji} ${c.name}</h3>
    <p class="muted" style="margin:-8px 0 12px">About how much? ${money(c.perLb)}/lb. Use the scale in produce, or estimate — it's checked if your trip is spot-checked.</p>
    <div class="wt-grid">${opts.map((lb) => `<button data-lb="${lb}"><b>${lb} lb</b><small>${money(lb * c.perLb)}</small></button>`).join('')}</div>`;
  host.querySelectorAll('[data-lb]').forEach((b) => b.onclick = () => {
    const lb = +b.dataset.lb;
    closeParent();
    addItem({ ...c, key: `${c.key}-${lb}`, price: +(lb * c.perLb).toFixed(2), detail: `${lb} lb @ ${money(c.perLb)}/lb${c.plu ? ` · PLU ${c.plu}` : ''}`, weighed: lb });
  });
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

async function onBarcode(code) {
  const hide = byUpc[code] ? () => {} : toast(`Identifying ${code}…`, 8000);
  const res = await itemFromCode(code);
  hide();
  if (res.item) addItem(res.item);
  else nameUnknown(code, res.base, res.offline);
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
  if (!navigator.onLine) return toast('Paying needs a connection — try near the front of the store');
  const { total } = totals(trip.items);
  const sheet = el(`
    <div class="sheet-wrap">
      <div class="sheet pay">
        <div class="grab"></div>
        <div class="pay-row"><span class="pay-logo">${(trip.card || '').startsWith('Apple') ? ' Pay' : 'Exit Pass'}</span><button class="link" id="x">Cancel</button></div>
        <div class="pay-line"><span>VONS #${STORE.number}</span><b>${money(total)}</b></div>
        <div class="pay-line muted"><span>Pay with</span><span>${trip.card}</span></div>
        ${savings(trip.items) > 0 ? `<div class="pay-line muted"><span>Vons for U savings</span><span class="green-t">−${money(savings(trip.items))}</span></div>` : ''}
        <div class="pay-line muted"><span>Items</span><span>${count(trip.items)} · ${trip.smartCart ? 'weight-checked by smart cart' : 'scanned by you'}</span></div>
        <button class="btn primary xl" id="confirm">${(trip.card || '').startsWith('Apple') ? 'Pay with Face ID' : 'Pay & get Exit Pass'}</button>
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
        trip.paidAt = Date.now(); trip.authCode = String(100000 + Math.floor(Math.random() * 899999));
        trip.arrivedAt = Date.now();
        trip.pass = decidePass(trip, { force: forced() });
        // Green: paid, scan out at the door in ~2s. Amber: paid, 1–3 items checked first.
        trip.status = trip.pass.tier === 'green' ? 'exit' : 'pass';
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
  render();
}

// ---------------- The pass ----------------
function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}
const fmtRecall = (c) => `${c.slice(0, 2)} ${c.slice(2, 6)} ${c.slice(6, 10)} ${c.slice(10)}`;

function pass() {
  const p = trip.pass;
  const { total } = totals(trip.items);
  const v = el(`
    <main class="screen pass-screen amber">
      ${laneBanner ? `<div class="lane-banner"><div class="spinner light"></div><span><b>${laneBanner}</b> has your basket</span></div>` : ''}
      <div class="pass-card amber">
        <div class="pc-top">
          <span class="pc-brand">EXIT PASS</span>
          <span class="pc-live"><span class="dot pulse"></span><span id="clock"></span></span>
        </div>
        <div class="pc-title">Paid. Quick check<br/>on the way out.</div>
        <div class="pc-lane">Show this at <b>${p.lane}</b>, any lane, or self-checkout</div>
        <div class="pc-code" id="code"></div>
        <div class="pc-recall">${fmtRecall(recallCode(trip.id))}</div>
        <div class="pc-checks">
          <div class="pcc-head">They'll check ${p.checks.length === 1 ? 'just this' : `only these ${p.checks.length}`}</div>
          ${p.checks.map((c) => `<div class="pcc"><span class="pcc-e">${c.emoji}</span><span class="pcc-n">${c.name}</span><span class="pcc-r">${c.reason}</span></div>`).join('')}
        </div>
        <div class="pc-foot"><span>${count(trip.items)} items · ${money(total)} paid</span><span>#${trip.id}</span></div>
      </div>
      <p class="pass-note">${count(trip.items) > p.checks.length ? `Not ${count(trip.items)} items re-scanned. Just ${p.checks.length}.` : 'A 10-second glance, no re-scanning.'} Turn your brightness up for the scanner.</p>
      <button class="link center" id="demo-verify">Demo: simulate the check</button>
    </main>`);
  const clock = v.querySelector('#clock');
  let lastPayload = '';
  const update = () => {
    clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const payload = passPayload(trip);
    if (payload !== lastPayload) { lastPayload = payload; v.querySelector('#code').innerHTML = qrSvg(payload); }
  };
  update(); tick = setInterval(update, 1000);
  v.querySelector('#demo-verify').onclick = () => {
    trip.status = 'done'; trip.doneAt = Date.now(); trip.verifiedBy = 'Maria (handheld)';
    save(); haptic([20, 40, 20]); render();
  };
  return v;
}

function exitPass() {
  const v = el(`
    <main class="screen pass-screen green">
      ${laneBanner ? `<div class="lane-banner"><div class="spinner light"></div><span>Scanning at <b>${laneBanner}</b>…</span></div>` : ''}
      <div class="pass-card green">
        <div class="pc-top">
          <span class="pc-brand">EXIT PASS</span>
          <span class="pc-live"><span class="dot pulse"></span><span id="clock"></span></span>
        </div>
        <div class="pc-title">Paid. You're good to go.</div>
        <div class="pc-lane">Scan out at the exit — about 2 seconds, no checks.</div>
        <div class="pc-code" id="code"></div>
        <div class="pc-recall">${fmtRecall(recallCode(trip.id))}</div>
        <div class="pc-foot"><span>${count(trip.items)} items · ${money(totals(trip.items).total)} paid</span><span>#${trip.id}</span></div>
      </div>
      <p class="pass-note">Hold this up to the scanner at the door, or show the greeter. Turn your brightness up.</p>
      <button class="link center" id="demo-out">Demo: simulate scan-out</button>
    </main>`);
  const clock = v.querySelector('#clock');
  let lastPayload = '';
  const update = () => {
    clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const payload = passPayload(trip);
    if (payload !== lastPayload) { lastPayload = payload; v.querySelector('#code').innerHTML = qrSvg(payload); }
  };
  update(); tick = setInterval(update, 1000);
  v.querySelector('#demo-out').onclick = () => {
    trip.status = 'done'; trip.doneAt = Date.now(); trip.verifiedBy = 'Exit';
    save(); haptic([20, 40, 20]); render();
  };
  return v;
}

function done() {
  return receiptView(trip, {});
}

function receiptView(t, { fromHistory }) {
  const { sub, tax, total } = totals(t.items);
  const saved = savings(t.items);
  const exitMs = Math.max(4000, (t.doneAt || Date.now()) - (t.arrivedAt || t.paidAt || Date.now()));
  const skipped = Math.max(0, AVG_LINE_MS - exitMs);
  const v = el(`
    <main class="screen receipt">
      ${fromHistory ? '<div class="r-nav"><button class="link" id="back">‹ Trips</button></div>' : ''}
      <div class="r-hero">
        <div class="r-check">✓</div>
        <div class="r-big">${fmtDuration(exitMs)}</div>
        <div class="r-cap">from "Done" to out the door</div>
      </div>
      <div class="compare">
        <div class="cmp-row"><span>Exit Pass</span><div class="bar"><i style="width:${Math.max(3, (exitMs / AVG_LINE_MS) * 100)}%" class="g"></i></div><b>${fmtDuration(exitMs)}</b></div>
        <div class="cmp-row"><span>Staffed lanes</span><div class="bar"><i style="width:100%" class="r"></i></div><b>${fmtDuration(AVG_LINE_MS)}</b></div>
        <div class="cmp-save">You skipped about <b>${Math.round(skipped / 60e3)} minutes</b> in line.</div>
      </div>
      ${t.verifiedBy ? `<div class="verified-by">Checked out at ${t.verifiedBy}${t.pass?.checks?.length ? ` · ${t.pass.checks.length} item${t.pass.checks.length > 1 ? 's' : ''} checked` : ''}</div>` : ''}
      <section class="r-card">
        <div class="r-head"><b>${STORE.name} #${STORE.number}</b><span>${new Date(t.paidAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>
        ${t.items.map((i) => `<div class="r-line"><span>${i.emoji || '🏷️'} ${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}${i.addedAtLane ? ` <small class="muted">· added at ${i.addedAtLane}</small>` : ''}</span><span>${money(i.price * i.qty)}</span></div>`).join('')}
        <div class="r-line sep"><span>Subtotal</span><span>${money(sub + saved)}</span></div>
        ${saved > 0 ? `<div class="r-line green-t"><span>Vons for U savings</span><span>−${money(saved)}</span></div>` : ''}
        <div class="r-line"><span>Tax</span><span>${money(tax)}</span></div>
        <div class="r-line total"><span>Paid · ${t.card || 'Visa ···· 4242'}</span><span>${money(total)}</span></div>
        ${(t.adjustments || []).map((a) => `<div class="r-line muted sm"><span>${a.kind === 'add' ? 'Added' : 'Refunded'} at ${a.lane}: ${a.name}</span><span>${money(a.amount)}</span></div>`).join('')}
        <div class="r-foot">Auth ${t.authCode || '—'}${t.closedTxn ? ` · POS txn ${t.closedTxn}` : ''} · Exit Pass #${t.id}</div>
      </section>
      <button class="btn ghost" id="share">Share or save receipt</button>
      ${fromHistory ? '' : '<button class="btn primary xl" id="again">Done</button>'}
    </main>`);
  v.querySelector('#again')?.addEventListener('click', () => { endTrip(); render(); });
  v.querySelector('#share').onclick = async () => {
    const tmp = document.createElement('textarea');
    const lines = [`${STORE.name} #${STORE.number} · ${new Date(t.paidAt).toLocaleString()}`, ...t.items.map((i) => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ''}  ${money(i.price * i.qty)}`), `Total paid ${money(total)} · ${t.card || ''}`, `Exit Pass #${t.id}`];
    tmp.innerHTML = lines.join('\n'); // decode any entities from synced names
    const text = tmp.value;
    try { if (navigator.share) await navigator.share({ title: 'Vons receipt', text }); else { await navigator.clipboard.writeText(text); toast('Receipt copied'); } } catch {}
  };
  v.querySelector('#back')?.addEventListener('click', () => { viewing = null; tab = 'trips'; render(); });
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
        <button class="btn block ghost danger" id="cancel">Cancel this trip</button>
        ${demoControlsHtml()}
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
  bindDemoControls(s);
  s.querySelectorAll('.dt-links a').forEach((a) => a.addEventListener('click', close));
  s.querySelector('#cancel').onclick = () => {
    if (trip.items.length && !confirm(`Cancel this trip? Your ${count(trip.items)} scanned items will be cleared. Nothing has been charged.`)) return;
    close(); trip.status = 'done'; save(); trip = null; write(KEY, null); render();
  };
}

export function toast(msg, ms = 2600) {
  const t = el(`<div class="toast">${msg}</div>`);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  const hide = () => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); };
  setTimeout(hide, ms);
  return hide;
}
