// End-to-end tests: real browsers driving every screen, with separate browser contexts
// standing in for separate devices (phone, register, door) talking only through /api/sync.
//
//   npm test                         (needs Playwright: npm i -D playwright && npx playwright install chromium)
//   PLAYWRIGHT=/path/to/playwright/index.mjs npm test   (use an existing install)
//
// Starts its own server on a spare port. Exits non-zero if any step fails.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const U = `http://localhost:${PORT}/`;
const TMP = mkdtempSync(join(tmpdir(), 'exitpass-'));
const { chromium, devices } = await import(process.env.PLAYWRIGHT || 'playwright');
const PHONE = devices['iPhone 13'];

let failed = 0;
const errs = [];
async function step(name, fn) {
  try { await fn(); console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '—', e.message.split('\n')[0]); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const watch = (p, n) => p.on('pageerror', (e) => errs.push(`${n}: ${e.message}`));

async function phone(browser, name = 'phone') {
  const p = await (await browser.newContext({ ...PHONE })).newPage(); watch(p, name);
  await p.goto(U);
  await p.evaluate(() => { localStorage.setItem('exitpass.profile', JSON.stringify({ name: 'Test', card: 'Visa ···· 4242', member: true, phone: '(626) 555-0142' })); localStorage.setItem('exitpass.camok', 'true'); });
  await p.reload();
  return p;
}
const tile = (p, text) => p.locator('.tile', { hasText: text }).first().click();
async function pay(p, force) {
  await p.evaluate((f) => (f ? sessionStorage.setItem('exitpass.force', f) : sessionStorage.removeItem('exitpass.force')), force);
  await p.click('#done'); await p.waitForTimeout(400); await p.click('#confirm');
  await p.waitForSelector(force === 'green' ? '.pass-card.green' : '.pass-card', { timeout: 6000 });
  await p.waitForTimeout(400);
}

// A fake camera: EAN-13 barcode frames in YUV4MPEG for Chromium's fake capture device.
function ean13y4m(code, file, pattern = Array(20).fill(true)) {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  const P = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  let bits = '101';
  [...code.slice(1, 7)].forEach((d, i) => { bits += (P[+code[0]][i] === 'L' ? L : G)[+d]; });
  bits += '01010';
  for (const d of code.slice(7)) bits += R[+d];
  bits += '101';
  const W = 640, H = 480, mod = 4, x0 = (W - bits.length * mod) >> 1;
  const row = Buffer.alloc(W, 235);
  [...bits].forEach((b, i) => { if (b === '1') row.fill(20, x0 + i * mod, x0 + (i + 1) * mod); });
  const Y = Buffer.concat(Array.from({ length: H }, (_, y) => (y > 160 && y < 320 ? row : Buffer.alloc(W, 235))));
  const UV = Buffer.alloc((W * H) / 4, 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, UV, UV]);
  const blank = Buffer.concat([Buffer.from('FRAME\n'), Buffer.alloc(W * H, 235), UV, UV]);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`), ...pattern.map((on) => (on ? frame : blank))]));
}

// ---------------------------------------------------------------------------------------
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { if ((await fetch(U + 'api/sync')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const browser = await chromium.launch();

console.log('\nShopper');
{
  const p = await phone(browser);
  await step('shopping list ticks itself off as items are scanned', async () => {
    for (const t of ['milk', 'coffee']) { await p.fill('#ladd input', t); await p.press('#ladd input', 'Enter'); await p.waitForTimeout(100); }
    await p.click('#go');
    await tile(p, 'Milk'); await tile(p, 'Starbucks'); await p.waitForTimeout(200);
    assert((await p.textContent('.list-bar summary')).includes('List complete'), 'list not complete');
  });
  await step('undo after add', async () => {
    await tile(p, 'Strawberries'); await p.click('.sn-undo'); await p.waitForTimeout(200);
    assert(!(await p.textContent('.list')).includes('Strawberries'), 'undo failed');
  });
  await step('produce by PLU with weight', async () => {
    await p.click('#produce'); await p.fill('#q', '4093'); await p.click('.prod'); await p.click('[data-lb="2"]'); await p.waitForTimeout(200);
    assert((await p.textContent('.list')).includes('2 lb'), 'no weighed onions');
  });
  await step('multi-buy deal and member pricing in total', async () => {
    await tile(p, 'Coca-Cola'); await tile(p, 'Coca-Cola'); await p.waitForTimeout(200);
    // milk 4.79 + coffee 10.99 + onions 2.58 + 2 coke for 16.00 = 34.36 → ×1.0725 = 36.85
    assert((await p.textContent('#total')).includes('36.85'), await p.textContent('#total'));
  });
  await step('offline: Done disabled, re-enabled when back online', async () => {
    await p.context().setOffline(true); await p.waitForTimeout(300);
    assert(await p.locator('#done[disabled]').count(), 'Done enabled offline');
    await p.context().setOffline(false); await p.waitForTimeout(500);
    assert(!(await p.locator('#done[disabled]').count()), 'Done still disabled');
  });
  await step('bags + green pass + scan-out → receipt adds up', async () => {
    await p.evaluate(() => sessionStorage.setItem('exitpass.force', 'green'));
    await p.click('#done'); await p.waitForTimeout(400); await p.click('[data-b="1"]'); await p.click('#confirm');
    await p.waitForSelector('.pass-card.green .pc-code svg', { timeout: 6000 });
    await p.click('#demo-out'); await p.waitForSelector('.receipt');
    const r = await p.textContent('.receipt');
    assert(r.includes('Paper Bag') && r.includes('Vons for U deals'), 'receipt missing bag or deal');
  });
  await p.context().close();
}

console.log('\nRegister lane (separate devices)');
{
  const p = await phone(browser);
  const pos = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(pos, 'pos');
  await p.click('#go'); await tile(p, 'Josh'); await tile(p, 'Avocado'); await pay(p);
  const recall = (await p.textContent('.pc-recall')).replace(/\s/g, '');
  await pos.goto(U + '#/pos');
  await step('recall by keyed 12-digit number', async () => {
    for (const d of recall) await pos.click(`[data-k="${d}"]`);
    await pos.click('[data-k="ENTER"]'); await pos.waitForSelector('.ep-banner', { timeout: 6000 });
    await p.waitForSelector('.lane-banner', { timeout: 6000 });
  });
  await step('missed item charged to shopper card, phone notified', async () => {
    for (const d of '000000221474') await pos.click(`[data-k="${d}"]`);
    await pos.click('[data-k="ENTER"]'); await p.waitForSelector('.toast', { timeout: 6000 });
  });
  await step('void a line → shopper refunded, item leaves their cart', async () => {
    pos.once('dialog', (d) => d.accept());
    await pos.locator('[data-line]', { hasText: 'Avocado' }).click();
    await pos.waitForTimeout(1200);
    assert(!(await p.textContent('.pass-screen')).includes('3 items'), 'phone not updated');
    await p.waitForSelector('.toast', { timeout: 6000 });
  });
  await step('complete blocked until checks, then phone gets receipt', async () => {
    assert(await pos.locator('#complete[disabled]').count(), 'complete enabled with open checks');
    for (const c of await pos.locator('.chk-btn').all()) await c.click();
    await pos.click('#complete'); await p.waitForSelector('.receipt', { timeout: 6000 });
    const r = await p.textContent('.receipt');
    assert(r.includes('Lane 4'), 'no lane on receipt');
    assert(r.includes('Refunded at Lane 4'), 'no refund line');
  });
  await step('used pass is rejected', async () => {
    await pos.waitForSelector('.sky-idle', { timeout: 8000 });
    for (const d of recall) await pos.click(`[data-k="${d}"]`);
    await pos.click('[data-k="ENTER"]'); await pos.waitForTimeout(1200);
    assert(!(await pos.locator('.ep-banner').count()), 'used pass recalled again');
    assert((await pos.textContent('.si-msg')).includes('already used'), await pos.textContent('.si-msg'));
  });
  await step('regular sale still works', async () => {
    await pos.click('[data-k="CLEAR"]');
    await pos.locator('.qk button', { hasText: 'Bananas' }).click(); await pos.click('#subtotal');
    await pos.waitForSelector('.paper', { timeout: 6000 });
  });
  await p.context().close(); await pos.context().close();
}

console.log('\nExit + self-checkout');
{
  const p = await phone(browser);
  const door = await (await browser.newContext({ ...PHONE })).newPage(); watch(door, 'door');
  await step('green pass scans out at the door', async () => {
    await p.click('#go'); await tile(p, 'Bananas'); await pay(p, 'green');
    await door.goto(U + '#/exit'); await door.waitForSelector('.arr.green', { timeout: 6000 });
    await door.click('.arr.green'); await p.waitForSelector('.receipt', { timeout: 6000 });
  });
  await step('amber pass: check at the door, then release', async () => {
    await p.click('#again'); await p.click('#go'); await tile(p, 'Josh'); await pay(p);
    await door.waitForSelector('.arr:not(.green)', { timeout: 8000 }); await door.click('.arr:not(.green)');
    await door.click('.exit-chk'); await p.waitForSelector('.receipt', { timeout: 6000 });
  });
  await step('self-checkout with attendant approval', async () => {
    await p.click('#again'); await p.click('#go'); await tile(p, 'Modelo'); await pay(p);
    await door.goto(U + '#/sco'); await door.waitForSelector('.arr', { timeout: 6000 }); await door.click('.arr');
    await door.click('#att'); await p.waitForSelector('.receipt', { timeout: 6000 });
  });
  await p.context().close(); await door.context().close();
}

console.log('\nSecurity');
{
  await step('sync API rejects unknown types and unauthenticated reset', async () => {
    const post = (m) => fetch(U + 'api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) });
    assert((await post({ type: 'evil' })).status === 400, 'unknown type accepted');
    assert((await post({ type: 'reset' })).status === 403, 'reset without key accepted');
  });
  await step('HTML injected through sync renders as text on every screen', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const trip = { id: 'EVIL01', status: 'pass', items: [{ key: 'k', name: evil, price: 1, qty: 1, emoji: evil }], pass: { tier: 'amber', checks: [{ key: 'k', name: evil, emoji: 'x', reason: evil, kind: 'id' }], lane: evil, code: 'C' }, arrivedAt: Date.now(), paidAt: Date.now() };
    await fetch(U + 'api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'trip', trip }) });
    for (const r of ['#/store', '#/associate', '#/pos', '#/exit']) {
      const pg = await browser.newPage(); await pg.goto(U + r); await pg.waitForTimeout(2000);
      if (r === '#/pos' || r === '#/exit') { const a = pg.locator('.arr'); if (await a.count()) { await a.first().click(); await pg.waitForTimeout(1000); } }
      assert(!(await pg.evaluate(() => window.__pwned)), `script ran on ${r}`);
      await pg.close();
    }
  });
  await step('security headers present', async () => {
    const h = (await fetch(U)).headers;
    assert(h.get('content-security-policy')?.includes("script-src 'self'"), 'no CSP');
    assert(h.get('x-content-type-options') === 'nosniff', 'no nosniff');
  });
}

console.log('\nCamera scanning (fake camera feeds)');
{
  await step('product barcode from video → Coca-Cola in cart', async () => {
    const f = join(TMP, 'coke.y4m'); ean13y4m('0049000028911', f);
    const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${f}`] });
    const p = await (await b.newContext({ ...PHONE, permissions: ['camera'] })).newPage(); watch(p, 'cam');
    await p.goto(U); await p.evaluate(() => localStorage.setItem('exitpass.profile', JSON.stringify({ name: 'T', card: 'Visa ···· 4242' }))); await p.reload();
    await p.click('#go'); await p.click('#scan');
    await p.click('#ok'); // one-time camera explainer
    await p.waitForSelector('.item', { timeout: 15000 });
    assert((await p.textContent('.list')).includes('Coca-Cola'), 'wrong product');
    // Continuous mode: camera stays open, same code isn't double-added, summary shows the total
    assert(await p.locator('.scanner').count(), 'scanner closed after one scan');
    await p.waitForTimeout(4000); // same can held in view for 4s must still count once
    assert((await p.locator('.item').count()) === 1 && (await p.textContent('.qty span')) === '1', 'double-added');
    assert((await p.textContent('#sdone')).includes('1 item'), await p.textContent('#sdone'));
    await p.click('#sdone'); await p.waitForTimeout(300);
    assert(!(await p.locator('.scanner').count()), 'Done did not close the scanner');
    await b.close();
  });
  await step('second can (barcode leaves view, comes back) adds again', async () => {
    const f = join(TMP, 'coke2.y4m');
    ean13y4m('0049000028911', f, [...Array(30).fill(true), ...Array(75).fill(false)]); // 1s in view, 2.5s away, loops
    const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${f}`] });
    const p = await (await b.newContext({ ...PHONE, permissions: ['camera'] })).newPage(); watch(p, 'cam2');
    await p.goto(U); await p.evaluate(() => { localStorage.setItem('exitpass.profile', JSON.stringify({ name: 'T', card: 'Visa ···· 4242' })); localStorage.setItem('exitpass.camok', 'true'); }); await p.reload();
    await p.click('#go'); await p.click('#scan');
    await p.waitForFunction(() => +document.querySelector('.qty span')?.textContent >= 2, null, { timeout: 15000 });
    await b.close();
  });
  await step('register reads the Exit Pass QR off the phone', async () => {
    const p = await phone(browser);
    await p.click('#go'); await tile(p, 'Josh'); await pay(p);
    const svg = await p.innerHTML('.pc-code');
    const cam = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await cam.setContent(`<body style="margin:0;background:#ccc;display:grid;place-items:center;height:480px"><div style="background:#fff;padding:24px;width:260px;height:260px">${svg}</div></body>`);
    const jpg = await cam.screenshot({ type: 'jpeg', quality: 90 });
    const f = join(TMP, 'qr.mjpeg'); writeFileSync(f, Buffer.concat(Array(40).fill(jpg)));
    const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${f}`] });
    const pos = await (await b.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera'] })).newPage(); watch(pos, 'pos-cam');
    await pos.goto(U + '#/pos'); await pos.waitForTimeout(1200); await pos.click('#scan');
    await pos.waitForSelector('.ep-banner', { timeout: 15000 });
    assert((await pos.textContent('.ep-banner')).includes('scanned from phone'), 'not a 2D scan');
    await b.close(); await p.context().close();
  });
}

await browser.close();
server.kill();
if (errs.length) { failed += errs.length; console.log('\nPage errors:\n ', errs.join('\n  ')); }
console.log(failed ? `\n${failed} failing` : '\nAll passing');
process.exit(failed ? 1 : 0);
