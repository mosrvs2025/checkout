import { connectRelay } from './shared.js';
import { mountShopper } from './shopper.js';
import { mountStore } from './store.js';

const app = document.getElementById('app');

function mountDemo(root) {
  document.body.className = 'demo-body';
  root.innerHTML = `
    <div class="demo">
      <header class="demo-head">
        <div class="brand"><span class="logo">✓</span> Exit Pass <span class="muted">— live demo</span></div>
        <div class="demo-hint">Shop on the phone. Watch the store react. Verify on the right.</div>
        <button class="btn ghost sm" id="reset">Reset demo</button>
      </header>
      <div class="demo-stage">
        <div class="phone"><div class="notch"></div><iframe src="./#/" title="Shopper"></iframe></div>
        <iframe class="store-frame" src="./#/store" title="Store"></iframe>
      </div>
    </div>`;
  root.querySelector('#reset').onclick = () => {
    try { localStorage.removeItem('exitpass.trip'); } catch {}
    root.querySelectorAll('iframe').forEach((f) => f.contentWindow.location.reload());
  };
}

async function route() {
  const r = location.hash.replace(/^#\/?/, '');
  app.innerHTML = '';
  document.body.className = '';
  if (r.startsWith('demo')) return mountDemo(app);
  if (r.startsWith('store')) return mountStore(app, { mode: 'store' });
  if (r.startsWith('associate')) return mountStore(app, { mode: 'associate' });
  return mountShopper(app);
}

if (window.top !== window) document.documentElement.classList.add('in-frame');
connectRelay().finally(route);
window.addEventListener('hashchange', () => location.reload());
