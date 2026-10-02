// Lane simulators: a staffed register modeled on the Toshiba TCx SKY lanes (4:3 screen,
// POS keypad, Datalogic Magellan scanner) and a self-checkout kiosk. Both run the same
// Exit Pass POS extension (pos-gateway.js) — what changes is who's driving.

import { STORE, CATALOG, byUpc, byPlu, money, totals, count, el, bus, haptic } from './shared.js';
import { openScanner } from './scanner.js';
import { itemFromCode } from './products.js';
import * as gw from './pos-gateway.js';

let root, lane, state, clockTimer;
const QUICK = ['bananas', 'avocado', 'milk', 'bread', 'eggs', 'coke', 'bag', 'wine'].map((k) => CATALOG.find((c) => c.key === k));

export function mountPos(r, { kind = 'register', laneId } = {}) {
  root = r;
  lane = kind === 'sco' ? { id: laneId || 'SCO7', name: `Self-checkout ${String(laneId || '7').replace('SCO', '')}`, kind }
    : kind === 'exit' ? { id: 'EXIT1', name: 'Exit', kind }
    : { id: laneId || '4', name: `Lane ${laneId || '4'}`, kind };
  document.body.className = kind === 'sco' ? 'sco-body' : kind === 'exit' ? 'exit-body' : 'pos-body';
  state = { mode: 'idle', input: '', msg: null, txn: null, sale: [], journal: [], receipt: null, busy: false };
  bus.on((m) => {
    if (m.type === 'pos.journal' && m.lane === lane.id) { state.journal.unshift({ t: m.at || Date.now(), text: m.text }); state.journal.length = Math.min(state.journal.length, 40); }
    if (m.type === 'trip' || m.type === 'pos.close' || m.type === 'pos.journal') paintArriving();
    if (m.type === 'pos.journal' && m.lane === lane.id) paintJournal();
  });
  if (kind === 'register') window.addEventListener('keydown', onKey);
  render();
  clearInterval(clockTimer);
  clockTimer = setInterval(() => { const c = root.querySelector('#pclock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }, 1000);
}

// ---------------- shared actions ----------------
function flash(text, tone = 'info') { state.msg = { text, tone }; render(); }

async function doRecall(code) {
  if (state.busy) return;
  state.busy = true; flash('Recalling Exit Pass basket…', 'info');
  try {
    state.txn = await gw.recall(code, lane);
    state.mode = 'exitpass'; state.msg = null;
    haptic([20, 40, 20]); beep();
    // At the door a green pass needs nothing else: release it immediately.
    if (lane.kind === 'exit' && !state.txn.checks.length) { state.busy = false; return completeExitPass(); }
  } catch (e) {
    state.msg = { text: e.message, tone: 'err' }; beep(true);
  }
  state.busy = false; state.input = ''; render();
}

async function addByCode(code) {
  const plu = byPlu[code];
  const res = plu ? { item: plu } : byUpc[code] ? { item: byUpc[code] } : await itemFromCode(code);
  return addLine(res.item || { ...res.base, name: `ITEM ${code}`, detail: 'Not on file · keyed price', emoji: '🏷️' });
}

async function addLine(item) {
  beep();
  if (state.mode === 'exitpass') {
    state.busy = true; flash(`Adding ${item.name} to Exit Pass…`);
    await gw.addItem(state.txn, item);
    state.busy = false; state.msg = { text: `${item.name} added · charged to shopper's card`, tone: 'ok' };
  } else {
    if (state.mode !== 'sale') { state.mode = 'sale'; state.sale = []; }
    const ex = state.sale.find((l) => l.key === item.key);
    ex ? ex.qty++ : state.sale.push({ ...item, qty: 1 });
    state.msg = null;
  }
  state.input = ''; render();
}

async function enter() {
  const v = state.input.trim();
  if (!v) return;
  if (gw.isPassCode(v) && state.mode !== 'exitpass') return doRecall(v);
  if (/^\d{4,14}$/.test(v)) return addByCode(v.length === 13 && v[0] === '0' ? v.slice(1) : v);
  flash('Not a valid item or pass code', 'err');
}

async function completeExitPass() {
  try {
    state.busy = true; flash('Closing transaction…');
    state.receipt = await gw.close(state.txn, lane.kind === 'sco' ? 'SCO' : lane.kind === 'exit' ? 'Greeter' : 'Maria');
    state.mode = 'receipt'; state.msg = null; haptic([20, 40, 20]); beep();
    setTimeout(() => { if (state.mode === 'receipt') reset(); }, lane.kind === 'sco' ? 6000 : lane.kind === 'exit' ? 2500 : 4500);
  } catch (e) { state.msg = { text: e.message, tone: 'err' }; }
  state.busy = false; render();
}

async function tenderSale() {
  if (!state.sale.length) return;
  state.mode = 'tender'; render();
  const r = await gw.tenderCard(lane, state.sale);
  state.receipt = { ...r, lane: lane.name, closedAt: Date.now(), regular: true, items: count(state.sale) };
  state.mode = 'receipt'; beep(); render();
  setTimeout(() => { if (state.mode === 'receipt') reset(); }, 4500);
}

function reset() { state = { ...state, mode: 'idle', input: '', msg: null, txn: null, sale: [], receipt: null, busy: false }; render(); }

function scan() {
  openScanner({
    qr: true, accept: gw.isPassCode,
    hint: lane.kind === 'register' ? 'Magellan · scan pass or item' : 'Hold the Exit Pass up to the camera',
    placeholder: 'Pass code, recall # or UPC',
    onCode: (code) => (gw.isPassCode(code) && state.mode !== 'exitpass' ? doRecall(code) : addByCode(code)),
  });
}

function onKey(e) {
  if (document.querySelector('.scanner') || e.target.tagName === 'INPUT') return;
  if (/^[0-9A-Za-z:]$/.test(e.key)) { state.input = (state.input + e.key.toUpperCase()).slice(0, 40); paintInput(); }
  else if (e.key === 'Backspace') { state.input = state.input.slice(0, -1); paintInput(); }
  else if (e.key === 'Enter') enter();
  else if (e.key === 'Escape') key('CANCEL');
}

function key(k) {
  haptic(6);
  if (/^\d$/.test(k)) { state.input = (state.input + k).slice(0, 40); return paintInput(); }
  if (k === 'CLEAR') { state.input = ''; return paintInput(); }
  if (k === 'ENTER') return enter();
  if (k === 'SUBTOTAL') { if (state.mode === 'sale') return tenderSale(); if (state.mode === 'exitpass') return completeExitPass(); return; }
  if (k === 'CANCEL') { if (state.input) { state.input = ''; return paintInput(); } if (state.mode === 'sale' || state.mode === 'exitpass') return reset(); }
}

let actx;
function beep(err) {
  try {
    actx ||= new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = err ? 220 : 1760; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.04, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (err ? 0.35 : 0.09));
    o.start(); o.stop(actx.currentTime + (err ? 0.35 : 0.09));
  } catch {}
}

// ---------------- rendering ----------------
function render() { lane.kind === 'sco' ? renderSco() : lane.kind === 'exit' ? renderExit() : renderRegister(); }

function arrivingTrips() {
  // Lanes see shoppers who need a check; the exit sees everyone who's paid (green passes scan out there).
  const ok = (t) => t.status === 'pass' || (lane.kind === 'exit' && t.status === 'exit');
  return [...bus.trips.values()].filter((t) => t.pass && ok(t) && t.id !== state.txn?.tripId).sort((a, b) => (b.paidAt || 0) - (a.paidAt || 0)).slice(0, 4);
}

function paintArriving() {
  const box = root.querySelector('#arriving');
  if (!box) return;
  const list = arrivingTrips();
  box.innerHTML = list.length ? '' : `<span class="arr-empty">${lane.kind === 'sco' ? 'No Exit Pass shoppers waiting' : 'No Exit Pass shoppers at the front'}</span>`;
  for (const t of list) {
    const b = el(`<button class="arr ${t.status === 'exit' ? 'green' : ''}"><b>#${t.id}</b><span>${count(t.items)} items · ${money(totals(t.items).total)} · ${t.pass.checks.length ? `${t.pass.checks.length} check${t.pass.checks.length === 1 ? '' : 's'}` : 'green · scan out'}</span></button>`);
    b.onclick = () => doRecall(t.id);
    box.append(b);
  }
}

function paintInput() { const i = root.querySelector('#pinput'); if (i) i.textContent = state.input || ' '; }
function paintJournal() {
  const j = root.querySelector('#journal');
  if (j) j.innerHTML = state.journal.slice(0, 8).map((e) => `<div><span>${new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>${e.text}</div>`).join('') || '<div class="muted">Electronic journal is empty</div>';
}

function linesHtml(lines, txn) {
  return lines.map((l) => {
    const chk = txn?.checks?.find((c) => c.key === l.key);
    const added = txn?.adjustments?.some((a) => a.kind === 'add' && a.item.key === l.key);
    return `<div class="pl ${chk ? (chk.done ? 'chk done' : 'chk') : ''} ${added ? 'added' : ''}">
      <span class="pl-q">${l.qty}</span><span class="pl-d">${l.name}${chk ? ` <em>${chk.done ? '✓ ' : '◆ '}${chk.reason.toUpperCase()}</em>` : ''}${added ? ' <em class="add">ADDED AT LANE</em>' : ''}</span>
      <span class="pl-p">${money(l.price * l.qty)}</span>${l.reg ? `<span class="pl-s">MEMBER SAVINGS -${money((l.reg - l.price) * l.qty)}</span>` : ''}</div>`;
  }).join('');
}

function renderRegister() {
  const s = state;
  const lines = s.mode === 'exitpass' ? s.txn.lines : s.sale;
  const t = s.mode === 'exitpass' ? gw.recompute(s.txn) : { ...totals(s.sale), items: count(s.sale), tendered: 0, balance: totals(s.sale).total };
  const ep = s.mode === 'exitpass';
  const sensor = ep && s.txn.checks.find((c) => c.key === 'sensor');
  root.innerHTML = '';
  const v = el(`
    <div class="lane">
      <div class="pos-topbar"><span>${STORE.name} #${STORE.number} · ${lane.name}</span><span class="pos-net"><i></i>${bus.live ? `Online · sync ${bus.backend}` : 'This device'}</span><a href="#/store" class="pos-link">Store ▸</a></div>
      <div class="terminal">
        <div class="screen43">
          <div class="sky-head">
            <div class="sky-logo">TCx<b>SKY</b><span>+ Exit Pass</span></div>
            <div class="sky-meta"><span>OP: Maria (2231)</span><span>TRM ${String(lane.id).padStart(3, '0')}</span><span id="pclock">${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>
          </div>
          <div class="sky-body">
            <div class="sky-left">
              ${ep ? `<div class="ep-banner ${s.txn.tier}">
                  <div><b>EXIT PASS · PREPAID</b><span>#${s.txn.tripId} · ${s.txn.method === 'scan-2d' ? 'scanned from phone' : 'keyed'} · ${s.txn.tenders[0].label}</span></div>
                  <div class="ep-bal">BAL DUE<b>${money(Math.max(0, t.balance))}</b></div>
                </div>` : ''}
              <div class="sky-lines" id="lines">
                ${lines.length ? linesHtml(lines, ep && s.txn) : s.mode === 'receipt' ? '' : `<div class="sky-idle">
                    <div class="idle-big">Scan Exit Pass or first item</div>
                    <div class="idle-sub">Exit Pass shoppers are already paid — scan the QR on their phone or key the 12-digit recall number.</div>
                  </div>`}
                ${s.mode === 'receipt' ? receiptHtml() : ''}
                ${s.mode === 'tender' ? '<div class="tender-wait"><div class="spinner"></div>INSERT, TAP OR SWIPE · PIN PAD</div>' : ''}
              </div>
              <div class="sky-totals">
                <div><span>ITEMS</span><b>${t.items || 0}</b></div>
                <div><span>SUBTOTAL${t.deals ? ' (DEALS)' : ''}</span><b>${money((t.sub || 0) - (t.deals || 0))}</b></div>
                <div><span>TAX</span><b>${money(t.tax || 0)}</b></div>
                <div class="tot"><span>${ep ? 'PAID' : 'TOTAL'}</span><b>${money(t.total || 0)}</b></div>
              </div>
            </div>
            <div class="sky-right">
              ${ep ? `<div class="sky-panel">
                  <div class="sp-h">CHECKS (${s.txn.checks.filter((c) => c.done).length}/${s.txn.checks.length})</div>
                  ${s.txn.checks.length ? s.txn.checks.map((c) => `<button class="chk-btn ${c.done ? 'done' : ''}" data-chk="${c.key}"><span>${c.emoji}</span><div><b>${c.name}</b><small>${c.reason}</small></div><i>${c.done ? '✓' : 'TAP'}</i></button>`).join('') : '<div class="sp-none">No checks — just hand over the receipt.</div>'}
                  ${sensor && !sensor.done ? '<div class="sp-hint">Cart scale flagged extra weight. Find the item and key or scan it — it\'s charged to their card automatically.</div>' : ''}
                </div>
                <button class="sky-btn go" id="complete" ${s.txn.checks.some((c) => !c.done) ? 'disabled' : ''}>COMPLETE · RELEASE SHOPPER</button>` : `
                <div class="sky-panel"><div class="sp-h">QUICK KEYS</div><div class="qk">${QUICK.map((q) => `<button data-q="${q.key}">${q.plu ? `<small>PLU ${q.plu}</small>` : ''}${q.name}</button>`).join('')}</div></div>
                ${s.mode === 'sale' ? '<button class="sky-btn go" id="subtotal">SUB TOTAL · TENDER</button>' : ''}`}
              <div class="sky-panel arr-panel"><div class="sp-h">EXIT PASS · AT THE FRONT</div><div id="arriving"></div></div>
            </div>
          </div>
          <div class="sky-input">
            <span class="si-l">${ep ? 'SCAN/KEY MISSED ITEM' : 'ENTER ITEM / PASS #'}</span>
            <span class="si-v" id="pinput">${state.input || ' '}</span>
            <span class="si-msg ${s.msg?.tone || ''}">${s.msg?.text || ''}</span>
          </div>
        </div>
        <div class="keypad">
          <div class="kp-grid">
            ${['7', '8', '9', 'CLEAR', '4', '5', '6', 'SUBTOTAL', '1', '2', '3', 'ENTER', '0', '00', 'CANCEL'].map((k) => `<button data-k="${k}" class="k-${k.toLowerCase()}">${{ SUBTOTAL: 'Sub<br>Total', CLEAR: 'Clear', CANCEL: 'Cancel', ENTER: 'Enter' }[k] || k}</button>`).join('')}
          </div>
        </div>
      </div>
      <button class="magellan" id="scan"><span class="mg-glass"></span><span class="mg-label">Datalogic Magellan · tap to scan with camera</span></button>
      <details class="journal-wrap"><summary>Electronic journal (TLOG)</summary><div id="journal" class="journal"></div></details>
    </div>`);
  root.append(v);
  v.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { if (b.dataset.k === '00') { key('0'); key('0'); } else key(b.dataset.k); });
  v.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => addLine(CATALOG.find((c) => c.key === b.dataset.q)));
  v.querySelectorAll('[data-chk]').forEach((b) => b.onclick = async () => { await gw.confirmCheck(state.txn, b.dataset.chk); beep(); render(); });
  v.querySelector('#complete')?.addEventListener('click', completeExitPass);
  v.querySelector('#subtotal')?.addEventListener('click', tenderSale);
  v.querySelector('#scan').onclick = scan;
  paintArriving(); paintJournal();
  const l = v.querySelector('#lines'); l.scrollTop = l.scrollHeight;
}

function receiptHtml() {
  const r = state.receipt;
  return `<div class="paper">
    <div class="pp-c"><b>VONS</b><br>${STORE.city.toUpperCase()} #${STORE.number}<br>${new Date(r.closedAt).toLocaleString()}</div>
    <div class="pp-r"><span>${r.items} ITEMS</span><span>${money(r.total)}</span></div>
    <div class="pp-r"><span>${r.regular ? 'CARD' : 'EXIT PASS PREPAID'}</span><span>${money(r.total)}</span></div>
    ${r.regular ? '' : `<div class="pp-r"><span>CHECKOUT TIME</span><span>${r.seconds}s</span></div>`}
    <div class="pp-c">TXN ${r.txnId}<br>${r.regular ? 'THANK YOU' : 'RECEIPT SENT TO PHONE · THANK YOU'}</div>
  </div>`;
}

function renderSco() {
  const s = state;
  root.innerHTML = '';
  const ep = s.mode === 'exitpass';
  const t = ep ? gw.recompute(s.txn) : null;
  const pending = ep && s.txn.checks.filter((c) => !c.done);
  const v = el(`
    <div class="sco">
      <header class="sco-head"><div class="sco-brand">VONS <span>Self-checkout ${String(lane.id).replace('SCO', '')}</span></div><div class="sco-net">${bus.live ? 'Online' : 'This device'} · <span id="pclock"></span></div></header>
      ${s.mode === 'idle' ? `
        <main class="sco-main">
          <div class="sco-hero">
            <div class="sco-qr">▣</div>
            <h1>Already paid with Exit Pass?</h1>
            <p>Hold your phone's pass up to the scanner. That's it.</p>
            <button class="btn primary xl" id="scan">Scan my Exit Pass</button>
            <div class="sco-or">or <button class="link" id="regular">start a regular checkout</button></div>
          </div>
          <div class="sco-arr"><div class="sp-h">Demo · Exit Pass shoppers nearby</div><div id="arriving"></div></div>
        </main>` : ''}
      ${ep ? `
        <main class="sco-main">
          <div class="sco-card">
            <div class="sco-ok">✓</div>
            <h1>${pending.length ? 'Almost there' : 'You\'re all set'}</h1>
            <p>${t.items} items · <b>${money(t.total)}</b> already paid with ${s.txn.tenders[0].label.replace('Exit Pass · ', '')}</p>
            ${pending.length ? `<div class="sco-att"><div class="att-light"></div><div><b>Attendant notified</b><span>${pending.map((c) => `${c.emoji} ${c.reason}`).join(' · ')}</span></div></div>
              <button class="btn ghost" id="att">Attendant: approve (demo)</button>` : '<button class="btn primary xl" id="complete">Finish & print receipt</button>'}
          </div>
        </main>` : ''}
      ${s.mode === 'receipt' ? `<main class="sco-main"><div class="sco-card"><div class="sco-ok big">✓</div><h1>Thanks for shopping!</h1><p>Receipt is on your phone. Have a great day.</p>${receiptHtml()}</div></main>` : ''}
      ${s.mode === 'sale' || s.mode === 'tender' ? `<main class="sco-main"><div class="sco-card"><h1>Regular checkout</h1><div class="sky-lines">${linesHtml(s.sale)}</div><p>${s.mode === 'tender' ? 'Tap or insert card on the pin pad…' : `Total ${money(totals(s.sale).total)}`}</p>
        <div class="sco-row"><button class="btn" id="scan">Scan item</button><button class="btn primary" id="subtotal" ${s.sale.length ? '' : 'disabled'}>Pay</button><button class="btn ghost" id="cancel">Cancel</button></div></div></main>` : ''}
      ${s.msg ? `<div class="sco-msg ${s.msg.tone}">${s.msg.text}</div>` : ''}
    </div>`);
  root.append(v);
  v.querySelector('#scan')?.addEventListener('click', scan);
  v.querySelector('#regular')?.addEventListener('click', () => { state.mode = 'sale'; state.sale = []; render(); });
  v.querySelector('#complete')?.addEventListener('click', completeExitPass);
  v.querySelector('#subtotal')?.addEventListener('click', tenderSale);
  v.querySelector('#cancel')?.addEventListener('click', reset);
  v.querySelector('#att')?.addEventListener('click', async () => { for (const c of state.txn.checks) await gw.confirmCheck(state.txn, c.key); completeExitPass(); });
  const c = v.querySelector('#pclock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  paintArriving();
}


// Exit station: a phone/tablet on a stand by the doors, or the greeter's handheld.
function renderExit() {
  const s = state;
  root.innerHTML = '';
  const ep = s.mode === 'exitpass';
  const pending = ep ? s.txn.checks.filter((c) => !c.done) : [];
  const v = el(`
    <div class="exit">
      <header class="exit-head"><b>EXIT</b><span>${STORE.name} #${STORE.number}</span><span class="exit-net">${bus.live ? 'Online' : 'This device'}</span></header>
      ${s.mode === 'idle' ? `
        <button class="exit-scan" id="scan"><div class="es-ring"></div><b>Scan Exit Pass</b><span>Hold the phone's code to the camera</span></button>
        <div class="exit-arr"><div class="sp-h">Paid · heading out (tap for demo)</div><div id="arriving"></div></div>` : ''}
      ${ep && pending.length ? `
        <div class="exit-card amber">
          <div class="ec-big">Quick check</div>
          <div class="ec-sub">#${s.txn.tripId} · ${gw.recompute(s.txn).items} items paid · check only these:</div>
          ${s.txn.checks.map((c) => `<button class="exit-chk ${c.done ? 'done' : ''}" data-chk="${c.key}"><span>${c.emoji}</span><div><b>${c.name}</b><small>${c.reason}</small></div><i>${c.done ? '✓' : 'Tap when checked'}</i></button>`).join('')}
          <button class="btn ghost" id="cancel">Send to Express Check instead</button>
        </div>` : ''}
      ${ep && !pending.length ? '<div class="exit-card green"><div class="spinner light"></div></div>' : ''}
      ${s.mode === 'receipt' ? `<div class="exit-card green"><div class="ec-ok">✓</div><div class="ec-big">Have a great day</div><div class="ec-sub">${s.receipt.items} items · ${money(s.receipt.total)} paid · ${s.receipt.seconds}s at the door</div></div>` : ''}
      ${s.msg && s.mode !== 'exitpass' ? `<div class="exit-msg ${s.msg.tone}">${s.msg.text}</div>` : ''}
    </div>`);
  root.append(v);
  v.querySelector('#scan')?.addEventListener('click', scan);
  v.querySelector('#cancel')?.addEventListener('click', reset);
  v.querySelectorAll('[data-chk]').forEach((b) => b.onclick = async () => {
    await gw.confirmCheck(state.txn, b.dataset.chk); beep();
    if (state.txn.checks.every((c) => c.done)) completeExitPass(); else render();
  });
  paintArriving();
}
