import { connectRelay } from './shared.js';
import { mountShopper } from './shopper.js';
import { mountStore } from './store.js';
import { mountPos } from './pos.js';

const app = document.getElementById('app');

const PANELS = [
  ['store', 'Store'],
  ['pos', 'Register · Lane 4'],
  ['exit', 'Exit'],
  ['sco', 'Self-checkout'],
  ['associate', 'Associate'],
];

function mountDemo(root) {
  document.body.className = 'demo-body';
  root.innerHTML = `
    <div class="demo">
      <header class="demo-head">
        <div class="brand"><span class="logo">✓</span> Exit Pass <span class="muted">— live demo</span></div>
        <div class="seg dark" id="panels">${PANELS.map(([k, l], i) => `<button data-p="${k}" class="${i ? '' : 'on'}">${l}</button>`).join('')}</div>
        <button class="btn ghost sm" id="reset">Reset demo</button>
      </header>
      <div class="demo-stage">
        <div class="phone"><div class="notch"></div><iframe src="./#/" title="Shopper"></iframe></div>
        <iframe class="store-frame" id="right" src="./#/store" title="Store"></iframe>
      </div>
    </div>`;
  const right = root.querySelector('#right');
  root.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => {
    root.querySelectorAll('[data-p]').forEach((x) => x.classList.toggle('on', x === b));
    right.src = `./#/${b.dataset.p}`;
  });
  root.querySelector('#reset').onclick = () => {
    try { localStorage.removeItem('exitpass.trip'); } catch {}
    root.querySelectorAll('iframe').forEach((f) => f.contentWindow.location.reload());
  };
}

function route() {
  const [r, arg] = location.hash.replace(/^#\/?/, '').split('/');
  app.innerHTML = '';
  document.body.className = '';
  if (r === 'demo') return mountDemo(app);
  if (r === 'store') return mountStore(app, { mode: 'store' });
  if (r === 'associate') return mountStore(app, { mode: 'associate' });
  if (r === 'pos') return mountPos(app, { kind: 'register', laneId: arg });
  if (r === 'exit') return mountPos(app, { kind: 'exit' });
  if (r === 'sco') return mountPos(app, { kind: 'sco', laneId: arg && 'SCO' + arg });
  return mountShopper(app);
}

if (window.top !== window) document.documentElement.classList.add('in-frame');
if ('serviceWorker' in navigator && location.hostname !== 'localhost' && window.top === window) navigator.serviceWorker.register('sw.js').catch(() => {});
connectRelay().finally(route);
window.addEventListener('hashchange', () => location.reload());
