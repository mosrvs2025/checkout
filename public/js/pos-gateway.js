// Exit Pass POS Gateway (simulated).
//
// This is the contract a real lane would integrate against. On a Toshiba TCx SKY lane the
// Datalogic Magellan scanner hands the POS application a scanned string; a small POS
// extension recognises Exit Pass codes and calls these operations on the Basket API:
//
//   recall(code, lane)            -> Transaction   basket arrives pre-tendered (balance $0.00)
//   addItem(txn, item)            -> Transaction   missed item; incremental capture on the shopper's card
//   voidItem(txn, upcOrKey)       -> Transaction   refund to the shopper's card
//   confirmCheck(txn, checkKey)   -> Transaction   ID / spot check done (cashier keyed or tapped)
//   close(txn)                    -> Receipt       closes the TLOG transaction and releases the shopper
//
// Every operation writes an electronic-journal (EJ) entry and emits a `pos.*` event so the
// shopper's phone and the store dashboard update live. See docs/POS_INTEGRATION.md.

import { bus, totals, count, money, uid, tokenValid, recallCode, STORE } from './shared.js';

export class PosError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Passes closed anywhere in the store (any lane, SCO or the door) — so a reused pass gets a
// clear answer instead of "not found".
const closedAt = new Map();
bus.on((m) => { if (m.type === 'pos.close') closedAt.set(m.tripId, m.laneName); });

const latency = (min = 180, max = 520) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const auth = () => String(Math.floor(100000 + Math.random() * 899999));

export function parseCode(raw) {
  const s = String(raw).trim().toUpperCase();
  let m = s.match(/^EP1:([A-Z0-9]{6}):([A-Z0-9]+)$/);
  if (m) return { tripId: m[1], token: m[2], method: 'scan-2d' };
  if (/^98\d{10}$/.test(s)) {
    for (const t of bus.trips.values()) if (recallCode(t.id) === s) return { tripId: t.id, method: 'keyed-recall' };
    for (const id of closedAt.keys()) if (recallCode(id) === s) return { tripId: id, method: 'keyed-recall' };
    return { tripId: null, method: 'keyed-recall' };
  }
  if (/^[A-Z0-9]{6}$/.test(s)) return { tripId: s, method: 'keyed-id' };
  return null;
}

export const isPassCode = (raw) => !!parseCode(raw);

function ej(lane, text, extra = {}) {
  bus.send({ type: 'pos.journal', lane, text, ...extra });
}

function txnFrom(trip, lane, method) {
  const t = totals(trip.items);
  return {
    txnId: `${STORE.number}-${lane.id}-${String(Date.now()).slice(-6)}`,
    lane, method, tripId: trip.id, shopper: trip.shopperName || 'Exit Pass shopper',
    openedAt: Date.now(),
    lines: trip.items.map((i) => ({ ...i, ext: i.price * i.qty })),
    checks: (trip.pass?.checks || []).map((c) => ({ ...c, done: false })),
    tenders: [{ type: 'EXIT_PASS_PREAUTH', label: `Exit Pass · ${trip.card || 'Visa ···· 4242'}`, amount: t.total, auth: trip.authCode || auth() }],
    adjustments: [],
    tier: trip.pass?.tier || 'green',
  };
}

export function recompute(txn) {
  const t = totals(txn.lines);
  const tendered = txn.tenders.reduce((s, x) => s + x.amount, 0);
  return { ...t, items: count(txn.lines), tendered, balance: Math.round((t.total - tendered) * 100) / 100 };
}

export async function recall(raw, lane) {
  await latency();
  const parsed = parseCode(raw);
  if (!parsed) throw new PosError('E_FORMAT', 'Not an Exit Pass code');
  const trip = parsed.tripId && bus.trips.get(parsed.tripId);
  if (!trip && closedAt.has(parsed.tripId)) throw new PosError('E_CLOSED', `Pass already used at ${closedAt.get(parsed.tripId)}`);
  if (!trip) {
    // On Vercel without Upstash, each serverless instance has its own memory: devices don't see each other.
    const hint = bus.backend === 'memory' && !/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)
      ? ' Devices may not be sharing sync — add Upstash Redis in Vercel → Storage, or key the pass on the same device.' : '';
    throw new PosError('E_NOT_FOUND', 'Basket not found. Ask the shopper to refresh their pass.' + hint);
  }
  if (trip.status === 'shopping' || !trip.pass) throw new PosError('E_NOT_PAID', 'Shopper hasn\'t tapped Done yet');
  if (trip.status !== 'pass' && trip.status !== 'exit') throw new PosError('E_CLOSED', 'This pass was already used');
  if (parsed.token && !tokenValid(trip, parsed.token)) throw new PosError('E_TOKEN', 'Pass code expired — ask for a fresh screen (screenshot?)');
  const txn = txnFrom(trip, lane, parsed.method);
  bus.send({ type: 'pos.recall', tripId: trip.id, lane: lane.id, laneName: lane.name, txnId: txn.txnId, method: parsed.method });
  ej(lane.id, `RECALL ${txn.txnId} · Exit Pass ${trip.id} · ${txn.lines.length} lines · ${money(recompute(txn).total)} PREAUTH ${txn.tenders[0].auth} · ${parsed.method}`);
  return txn;
}

export async function addItem(txn, item) {
  await latency(150, 380);
  const line = { ...item, qty: 1, ext: item.price, addedAt: Date.now(), addedAtLane: txn.lane.name };
  const existing = txn.lines.find((l) => l.key === item.key);
  if (existing) { existing.qty++; existing.ext = existing.price * existing.qty; } else txn.lines.push(line);
  const amount = Math.round(item.price * 1.0725 * 100) / 100;
  const tender = { type: 'EXIT_PASS_INCREMENTAL', label: `Added to card · ${item.name}`, amount, auth: auth() };
  txn.tenders.push(tender);
  txn.adjustments.push({ kind: 'add', item: line, amount });
  bus.send({ type: 'pos.adjust', tripId: txn.tripId, lane: txn.lane.id, laneName: txn.lane.name, kind: 'add', item: strip(line), amount });
  ej(txn.lane.id, `ITEM ${item.upc || item.key} ${item.name} ${money(item.price)} · INCREMENTAL CAPTURE ${money(amount)} AUTH ${tender.auth}`);
  return txn;
}

export async function voidItem(txn, key) {
  await latency(150, 380);
  const line = txn.lines.find((l) => l.key === key);
  if (!line) throw new PosError('E_NO_LINE', 'Item not in basket');
  line.qty--; line.ext = line.price * line.qty;
  if (line.qty <= 0) txn.lines = txn.lines.filter((l) => l !== line);
  const amount = -Math.round(line.price * 1.0725 * 100) / 100;
  txn.tenders.push({ type: 'EXIT_PASS_REFUND', label: `Refunded · ${line.name}`, amount, auth: auth() });
  txn.adjustments.push({ kind: 'void', item: line, amount });
  bus.send({ type: 'pos.adjust', tripId: txn.tripId, lane: txn.lane.id, laneName: txn.lane.name, kind: 'void', item: strip(line), amount });
  ej(txn.lane.id, `VOID ${line.name} · REFUND ${money(-amount)}`);
  return txn;
}

export async function confirmCheck(txn, key) {
  const c = txn.checks.find((x) => x.key === key);
  if (c) { c.done = true; ej(txn.lane.id, `CHECK OK · ${c.name} · ${c.reason}`); }
  return txn;
}

export async function close(txn, operator = 'Maria') {
  if (txn.checks.some((c) => !c.done)) throw new PosError('E_CHECKS', 'Finish the checks first');
  await latency(250, 600);
  const r = recompute(txn);
  closedAt.set(txn.tripId, txn.lane.name);
  const receipt = { txnId: txn.txnId, lane: txn.lane.name, operator, closedAt: Date.now(), seconds: Math.round((Date.now() - txn.openedAt) / 1000), ...r };
  bus.send({ type: 'pos.close', tripId: txn.tripId, lane: txn.lane.id, laneName: txn.lane.name, txnId: txn.txnId, by: operator, seconds: receipt.seconds, total: r.total });
  ej(txn.lane.id, `CLOSE ${txn.txnId} · ${r.items} items · ${money(r.total)} · ${receipt.seconds}s · OP ${operator}`);
  return receipt;
}

// Regular (non-app) sale — the lane still works the old way for everyone else.
export async function tenderCard(lane, lines) {
  await latency(900, 1600);
  const r = totals(lines);
  const id = `${STORE.number}-${lane.id}-${String(Date.now()).slice(-6)}`;
  bus.send({ type: 'pos.sale', lane: lane.id, laneName: lane.name, txnId: id, items: count(lines), total: r.total });
  ej(lane.id, `SALE ${id} · ${count(lines)} items · ${money(r.total)} · CARD AUTH ${auth()}`);
  return { txnId: id, ...r };
}

const strip = ({ key, upc, name, price, qty, emoji, image, detail, tint }) => ({ key, upc, name, price, qty, emoji, image, detail, tint });
export const newId = uid;
