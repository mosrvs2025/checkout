import { STORE, CATALOG, money, uid, totals, count, hashNum, el, bus, decidePass, fmtDuration, haptic } from './shared.js';

// The store's side of the system. One screen for the front-end lead (radar, forecast,
// staffing) and a focused associate mode (#/associate) for whoever is at Express Check.

const NAMES = ['Priya', 'Marcus', 'Elena', 'Jordan', 'Wei', 'Sofia', 'Andre', 'Hannah', 'Luis', 'Grace', 'Omar', 'Tess', 'Kenji', 'Dana', 'Ravi', 'Chloe', 'Sam', 'Nora', 'Mateo', 'Ivy'];
const ZONES = {
  Entrance: [94, 50], Produce: [8, 22], Dairy: [52, 5], Bakery: [92, 14], Meat: [30, 5], Seafood: [40, 5],
  Wine: [70, 30], Beer: [76, 30], Frozen: [64, 5], Floral: [92, 34], Front: [84, 50],
};
const zonePos = (z) => ZONES[z] || (z?.startsWith('Aisle') ? [20 + (+z.split(' ')[1] % 11) * 5.5 + 2.7, 24] : [50, 24]);
const LANES = [{ x: 24, label: '1' }, { x: 34, label: '2' }, { x: 44, label: '3' }, { x: 54, label: '4' }];

const trips = new Map(); // id -> trip (real + simulated)
const feed = [];
const stats = { exitTimes: [9, 11, 6, 14, 8, 10, 22, 7], passTrips: 41, laneTrips: 23, verified: 12, helps: [] };
let mode, root;

export function mountStore(r, opts) {
  root = r; mode = opts.mode;
  document.body.className = 'store-body';
  root.innerHTML = layout();
  bus.on(onMsg);
  seed();
  setInterval(simulate, 1000);
  setInterval(paint, 500);
  paint();
}

function log(text, tone = '') { feed.unshift({ t: Date.now(), text, tone }); feed.length = Math.min(feed.length, 30); }

function onMsg(msg) {
  if (msg.type === 'trip') {
    const prev = trips.get(msg.trip.id);
    const t = { ...msg.trip, x: prev?.x, y: prev?.y };
    if (!prev && t.status === 'shopping') log(`${t.name === 'You' ? 'A shopper' : t.name} started an Exit Pass trip`, 'info');
    if (prev?.status === 'shopping' && t.status !== 'shopping') {
      const total = money(totals(t.items).total);
      if (t.pass?.tier === 'green') { log(`Exit Pass ✓ — ${count(t.items)} items, ${total}, walked straight out`, 'good'); stats.passTrips++; }
      else { log(`Exit Pass → ${t.pass.lane}: check ${t.pass.checks.map((c) => c.name).join(', ')}`, 'warn'); haptic(30); chime(); }
    }
    if (prev && !prev.sensor?.open && t.sensor?.open) log(`Cart sensor: unscanned weight in ${t.name === 'You' ? 'a cart' : t.name + "'s cart"} (${t.zone})`, 'warn');
    if (prev?.status === 'pass' && t.status === 'done') { stats.exitTimes.push(Math.round((t.doneAt - t.arrivedAt) / 1000)); stats.verified++; }
    trips.set(t.id, t);
  }
  if (msg.type === 'verify') {
    const t = trips.get(msg.tripId);
    if (t && t.status === 'pass') { t.status = 'done'; t.doneAt = Date.now(); stats.exitTimes.push(Math.round((t.doneAt - t.arrivedAt) / 1000)); stats.verified++; log(`${msg.by} verified #${t.id} in ${fmtDuration(t.doneAt - t.arrivedAt)}`, 'good'); }
  }
  if (msg.type === 'help') { stats.helps.unshift({ ...msg, t: Date.now(), id: uid() }); log(`Help: "${msg.kind}" near ${msg.aisle}`, 'warn'); chime(); }
  if (msg.type === 'reset') { for (const [id, t] of trips) if (!t.sim) trips.delete(id); }
}

let audio;
function chime() {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(0.06, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.4);
    o.start(); o.stop(audio.currentTime + 0.4);
  } catch {}
}

// ---------------- Simulation ----------------
function simTrip(progress = 0) {
  const id = uid();
  const n = 3 + (hashNum(id) % 14);
  const items = [];
  for (let k = 0; k < n; k++) {
    const p = CATALOG[hashNum(id + k) % CATALOG.length];
    const ex = items.find((i) => i.key === p.key);
    ex ? ex.qty++ : items.push({ ...p, qty: 1 });
  }
  const usesPass = hashNum(id + 'p') % 100 < 66;
  const [x, y] = zonePos('Entrance');
  return {
    id, sim: true, name: NAMES[hashNum(id) % NAMES.length], usesPass, items, status: 'shopping',
    startedAt: Date.now() - progress * 90e3, progress, duration: 60e3 + (hashNum(id + 'd') % 90) * 1e3,
    x: progress ? 10 + (hashNum(id + 'x') % 80) : x, y: progress ? 8 + (hashNum(id + 'y') % 30) : y,
    target: null, trust: 0.85 + (hashNum(id + 't') % 15) / 100,
  };
}

function seed() {
  for (let i = 0; i < 14; i++) { const t = simTrip((i % 7) / 8); trips.set(t.id, t); }
  // A couple already waiting in lanes, one waiting for verification.
  for (let i = 0; i < 5; i++) { const t = simTrip(1); t.usesPass = false; arrive(t, true); trips.set(t.id, t); }
  const a = simTrip(1); a.usesPass = true; a.items.push({ ...CATALOG.find((c) => c.key === 'wine'), qty: 1 }); arrive(a, true); trips.set(a.id, a);
  log('Front end online — 4 lanes, Express Check, Exit gate', 'info');
}

function arrive(t, quiet) {
  t.arrivedAt = Date.now() - (quiet ? hashNum(t.id) % 40e3 : 0);
  t.progress = 1;
  if (t.usesPass) {
    t.pass = decidePass(t);
    if (t.pass.tier === 'green') { t.status = 'leaving'; t.doneAt = t.arrivedAt + (5 + (hashNum(t.id) % 9)) * 1000; if (!quiet) { stats.passTrips++; log(`${t.name} walked out with Exit Pass — ${count(t.items)} items, ${money(totals(t.items).total)}`, 'good'); } }
    else { t.status = 'pass'; if (!quiet) log(`${t.name} → ${t.pass.lane}: check ${t.pass.checks.map((c) => c.name).join(', ')}`, 'warn'); }
  } else {
    const lane = LANES.reduce((best, l) => (laneCount(l.label) < laneCount(best.label) ? l : best), LANES[0]);
    t.lane = lane.label; t.status = 'lane'; t.laneDone = Date.now() + (laneCount(lane.label) + 1) * (70e3 + count(t.items) * 2e3);
    if (!quiet) { stats.laneTrips++; log(`${t.name} joined Lane ${t.lane} (${laneCount(lane.label)} ahead) — no Exit Pass`, ''); }
  }
}
const laneCount = (label) => [...trips.values()].filter((t) => t.status === 'lane' && t.lane === label).length;

function simulate() {
  const now = Date.now();
  if ([...trips.values()].filter((t) => t.status === 'shopping').length < 16 && Math.random() < 0.25) { const t = simTrip(); trips.set(t.id, t); }
  for (const t of trips.values()) {
    if (!t.sim) continue;
    if (t.status === 'shopping') {
      t.progress = Math.min(1, (now - t.startedAt) / t.duration);
      if (t.progress >= 1) arrive(t);
    }
    if (t.status === 'leaving' && now > t.doneAt) { t.status = 'gone'; stats.exitTimes.push(Math.round((t.doneAt - t.arrivedAt) / 1000)); }
    if (t.status === 'lane' && now > t.laneDone) { t.status = 'gone'; }
  }
  for (const t of trips.values()) if (!t.sim && t.status === 'done' && now - (t.doneAt || now) > 25e3) t.status = 'gone';
  for (const t of trips.values()) {
    if (!t.sim) continue;
    // Sim associates clear sim checks if nobody's interacting after a while.
    if (t.status === 'pass' && now - t.arrivedAt > 45e3) { t.status = 'gone'; stats.verified++; stats.exitTimes.push(12 + (hashNum(t.id) % 10)); log(`Ana verified ${t.name} at ${t.pass.lane}`, 'good'); }
  }
  for (const [id, t] of trips) if (t.status === 'gone') trips.delete(id);
}

// Position each dot: shoppers wander aisles, then walk to their lane / gate.
function target(t) {
  if (t.status === 'lane') { const l = LANES.find((x) => x.label === t.lane); const pos = [...trips.values()].filter((o) => o.status === 'lane' && o.lane === t.lane && o.laneDone < t.laneDone).length; return [l.x, 46 - pos * 3.2]; }
  if (t.status === 'pass') return [68 + (hashNum(t.id) % 3) * 1.5, 50];
  if (t.status === 'leaving' || (t.status === 'done' && !t.sim)) return [93, 56];
  if (!t.sim) return zonePos(t.zone);
  if (!t.target || Math.hypot(t.target[0] - t.x, t.target[1] - t.y) < 1.5) {
    const k = Math.floor(Date.now() / 7000) + hashNum(t.id);
    t.target = Object.values(ZONES).concat([[25, 24], [42, 24], [58, 24]])[k % 14];
  }
  return t.target;
}

// ---------------- Rendering ----------------
function layout() {
  if (mode === 'associate') return `
    <div class="ops assoc">
      <header class="ops-head">
        <div class="brand"><span class="logo">✓</span> Express Check <span class="muted">· ${STORE.name} #${STORE.number}</span></div>
        <div class="ops-meta"><span class="dot live"></span> <span id="clock"></span></div>
      </header>
      <div class="assoc-sub" id="assoc-sub"></div>
      <section id="queue" class="queue big"></section>
      <section class="panel"><h3>Help requests</h3><div id="helps"></div></section>
    </div>`;
  return `
    <div class="ops">
      <header class="ops-head">
        <div class="brand"><span class="logo">✓</span> Front End <span class="muted">· ${STORE.name} ${STORE.city} #${STORE.number}</span></div>
        <div class="ops-meta"><span id="relay"></span><span class="dot live"></span> <span id="clock"></span></div>
      </header>
      <section class="kpis" id="kpis"></section>
      <div class="ops-grid">
        <section class="panel map-panel">
          <div class="panel-head"><h3>Store radar</h3><div class="legend"><span><i class="lg pass"></i>Exit Pass</span><span><i class="lg lane"></i>Traditional</span><span><i class="lg you"></i>Live demo shopper</span></div></div>
          <svg id="map" viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet"></svg>
          <div class="forecast" id="forecast"></div>
        </section>
        <aside class="side">
          <section class="panel"><div class="panel-head"><h3>Verify now</h3><span class="muted sm" id="qcount"></span></div><div id="queue" class="queue"></div></section>
          <section class="panel"><h3>Help requests</h3><div id="helps"></div></section>
          <section class="panel feed-panel"><h3>Live</h3><div id="feed" class="feed"></div></section>
        </aside>
      </div>
    </div>`;
}

const $ = (s) => root.querySelector(s);

function paint() {
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  if ($('#relay')) $('#relay').textContent = bus.live ? 'Multi-device relay on · ' : 'This device only · ';
  for (const t of trips.values()) {
    if (t.x == null) { [t.x, t.y] = zonePos('Entrance'); }
    const [tx, ty] = target(t);
    const sp = t.status === 'shopping' ? 0.08 : 0.18;
    t.x += (tx - t.x) * sp; t.y += (ty - t.y) * sp;
  }
  paintQueue(); paintHelps();
  if (mode === 'associate') {
    const n = queue().length;
    $('#assoc-sub').textContent = n ? `${n} shopper${n > 1 ? 's' : ''} waiting · avg ${avgExit()}s per check` : 'All clear. Exit Pass shoppers are walking straight out.';
    return;
  }
  paintKpis(); paintMap(); paintFeed(); paintForecast();
}

const all = () => [...trips.values()];
const queue = () => all().filter((t) => t.status === 'pass').sort((a, b) => (b.sim ? 0 : 1) - (a.sim ? 0 : 1) || a.arrivedAt - b.arrivedAt);
const avgExit = () => Math.round(stats.exitTimes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, stats.exitTimes.length));

function paintKpis() {
  const shopping = all().filter((t) => t.status === 'shopping');
  const soon = shopping.filter((t) => (t.sim ? t.progress > 0.6 : count(t.items) > 0));
  const laneWait = Math.max(...LANES.map((l) => laneCount(l.label))) * 95;
  const share = Math.round((stats.passTrips / (stats.passTrips + stats.laneTrips)) * 100);
  const inCarts = shopping.reduce((s, t) => s + totals(t.items).total * (t.sim ? t.progress : 1), 0);
  $('#kpis').innerHTML = [
    ['In store', all().filter((t) => t.status !== 'gone').length, `${shopping.filter((t) => t.usesPass || !t.sim).length} on Exit Pass`],
    ['Arriving at front ≤ 3 min', soon.length, `${soon.filter((t) => t.sim && !t.usesPass).length} headed to lanes`],
    ['Exit Pass: Done → door', `${avgExit()}s`, 'avg, last 20 trips', 'good'],
    ['Longest lane wait', fmtDuration(laneWait * 1000), `${LANES.reduce((s, l) => s + laneCount(l.label), 0)} people in lanes`, laneWait > 300 ? 'bad' : ''],
    ['Trips with no checkout', `${share}%`, `${stats.passTrips} today`, 'good'],
    ['Already paid, in carts', money(inCarts).replace(/\.\d+$/, ''), 'pre-authorized revenue'],
  ].map(([l, v, s, tone = '']) => `<div class="kpi ${tone}"><div class="k-l">${l}</div><div class="k-v">${v}</div><div class="k-s">${s}</div></div>`).join('');
}

function paintMap() {
  const aisles = Array.from({ length: 11 }, (_, i) => `<rect class="aisle-r" x="${20 + i * 5.5}" y="11" width="2.4" height="28" rx=".6"/>`).join('');
  const labels = [['Produce', 8, 12], ['Meat · Seafood', 35, 3], ['Dairy · Frozen', 58, 3], ['Bakery', 92, 8], ['Wine & Beer', 73, 41], ['Floral', 92, 40]]
    .map(([t, x, y]) => `<text class="zone-l" x="${x}" y="${y}" text-anchor="middle">${t}</text>`).join('');
  const lanes = LANES.map((l) => `<rect class="lane-r ${laneCount(l.label) >= 3 ? 'hot' : ''}" x="${l.x - 2}" y="48" width="4" height="7" rx=".8"/><text class="lane-l" x="${l.x}" y="58.8" text-anchor="middle">${l.label}</text><text class="lane-c" x="${l.x}" y="52.6" text-anchor="middle">${laneCount(l.label) || ''}</text>`).join('');
  const dots = all().map((t) => {
    const cls = !t.sim ? 'you' : t.usesPass ? 'pass' : 'lane';
    const flag = t.status === 'pass' ? 'checking' : t.sensor?.open ? 'checking' : '';
    return `<g transform="translate(${t.x.toFixed(2)} ${t.y.toFixed(2)})" class="dot-g ${cls} ${flag}">${!t.sim ? '<circle r="3.2" class="you-ring"/>' : ''}<circle r="${!t.sim ? 1.6 : 1.1}"/>${!t.sim ? `<text y="-3.6" text-anchor="middle" class="you-l">${money(totals(t.items).total)}</text>` : ''}</g>`;
  }).join('');
  $('#map').innerHTML = `
    <rect class="floor" x="1" y="1" width="98" height="58" rx="2"/>
    ${aisles}${labels}
    <rect class="front-zone" x="16" y="44" width="80" height="15" rx="1"/>
    ${lanes}
    <rect class="express-r" x="64" y="48" width="10" height="7" rx=".8"/><text class="lane-l" x="69" y="58.8" text-anchor="middle">Express Check</text>
    <rect class="gate-r" x="86" y="53" width="12" height="5" rx=".8"/><text class="gate-l" x="92" y="56.3" text-anchor="middle">EXIT ✓</text>
    ${dots}`;
}

function paintForecast() {
  const shopping = all().filter((t) => t.status === 'shopping' && t.sim);
  const buckets = Array.from({ length: 10 }, () => ({ pass: 0, lane: 0 }));
  for (const t of shopping) {
    const eta = (1 - t.progress) * t.duration;
    const b = Math.min(9, Math.floor(eta / 15e3));
    buckets[b][t.usesPass ? 'pass' : 'lane']++;
  }
  const max = Math.max(3, ...buckets.map((b) => b.pass + b.lane));
  const laneSoon = buckets.slice(0, 6).reduce((s, b) => s + b.lane, 0);
  const inLanes = LANES.reduce((s, l) => s + laneCount(l.label), 0);
  const rec = laneSoon + inLanes > 7 ? { tone: 'bad', text: `Open Lane 5 now — ${laneSoon} traditional carts arrive in the next 90s on top of ${inLanes} waiting.` }
    : laneSoon + inLanes > 4 ? { tone: 'warn', text: `Lanes stay under 3 deep for the next 2 min. Keep 1 associate on Express Check.` }
    : { tone: 'good', text: `Front end is ahead of demand. One cashier can move to stocking.` };
  $('#forecast').innerHTML = `
    <div class="fc-head"><h3>Arrivals at the front · next 2½ min</h3><span class="muted sm">predicted from live carts</span></div>
    <div class="fc-bars">${buckets.map((b, i) => `<div class="fc-col"><div class="fc-stack" style="height:${((b.pass + b.lane) / max) * 100}%"><i class="lane" style="flex:${b.lane}"></i><i class="pass" style="flex:${b.pass}"></i></div><span>${i % 2 ? '' : `${i * 15}s`}</span></div>`).join('')}</div>
    <div class="rec ${rec.tone}"><b>Recommendation</b> ${rec.text}</div>`;
}

let lastQueueSig = '';
function paintQueue() {
  const q = queue();
  const sig = q.map((t) => t.id + t.status).join('|');
  if ($('#qcount')) $('#qcount').textContent = q.length ? `${q.length} waiting` : '';
  // Re-render only on change so buttons stay tappable; update timers in place.
  if (sig !== lastQueueSig) {
    lastQueueSig = sig;
    const box = $('#queue');
    box.innerHTML = q.length ? '' : '<div class="empty-q"><div class="eq-ic">✓</div>No checks needed right now</div>';
    for (const t of q) box.append(queueCard(t));
  }
  root.querySelectorAll('[data-wait]').forEach((n) => { const t = trips.get(n.dataset.wait); if (t) n.textContent = fmtDuration(Date.now() - t.arrivedAt); });
}

function queueCard(t) {
  const { total } = totals(t.items);
  const c = el(`
    <div class="qcard ${t.sim ? '' : 'real'}">
      <div class="qc-top">
        <div class="qc-who"><span class="avatar">${t.sim ? t.name[0] : '★'}</span><div><b>${t.sim ? t.name : 'Demo shopper'}</b><span>${count(t.items)} items · ${money(total)} paid · ${t.pass.lane}</span></div></div>
        <div class="qc-wait" data-wait="${t.id}"></div>
      </div>
      <div class="qc-checks">${t.pass.checks.map((ch) => `<div class="qcc ${ch.kind}"><span class="qcc-e">${ch.emoji}</span><div><b>${ch.name}</b><span>${ch.reason}</span></div></div>`).join('')}</div>
      <div class="qc-skip">Skip re-scanning the other ${Math.max(0, count(t.items) - t.pass.checks.filter((c) => c.key !== 'sensor').length)} items — cart weight matches.</div>
      <div class="qc-actions"><button class="btn ok">✓ Looks good</button><button class="btn ghost issue">Issue</button></div>
    </div>`);
  c.querySelector('.ok').onclick = () => {
    haptic(15);
    c.classList.add('cleared');
    setTimeout(() => {
      if (t.sim) { t.status = 'gone'; trips.delete(t.id); stats.verified++; stats.exitTimes.push(Math.round((Date.now() - t.arrivedAt) / 1000)); log(`You verified ${t.name} in ${fmtDuration(Date.now() - t.arrivedAt)}`, 'good'); }
      else bus.send({ type: 'verify', tripId: t.id, ok: true, by: 'Maria' }), onMsg({ type: 'verify', tripId: t.id, by: 'Maria' });
      lastQueueSig = ''; paint();
    }, 350);
  };
  c.querySelector('.issue').onclick = () => {
    c.querySelector('.qc-skip').innerHTML = '<b>Resolve on the spot:</b> add the item to their cart from here and they\'re charged automatically — no void, no re-ring.';
  };
  return c;
}

let lastHelpSig = '';
function paintHelps() {
  const sig = stats.helps.map((h) => h.id).join();
  if (sig === lastHelpSig) return;
  lastHelpSig = sig;
  const box = $('#helps');
  box.innerHTML = stats.helps.length ? '' : '<div class="muted sm">Nobody needs help.</div>';
  for (const h of stats.helps.slice(0, 4)) {
    const row = el(`<div class="help-row"><span>🙋 <b>${h.kind}</b> · ${h.aisle}</span><button class="btn sm">On my way</button></div>`);
    row.querySelector('button').onclick = () => { bus.send({ type: 'help-ack', tripId: h.tripId, by: 'Maria' }); stats.helps = stats.helps.filter((x) => x !== h); lastHelpSig = ''; paintHelps(); };
    box.append(row);
  }
}

function paintFeed() {
  $('#feed').innerHTML = feed.slice(0, 12).map((f) => `<div class="fe ${f.tone}"><span class="fe-t">${new Date(f.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>${f.text}</div>`).join('');
}
