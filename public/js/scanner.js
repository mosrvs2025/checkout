import { el, haptic } from './shared.js';

// Camera barcode scanner. Uses the native BarcodeDetector (Chrome/Android) and falls back
// to ZXing (iOS Safari). Needs HTTPS for camera access; otherwise shows manual entry.
let zxingLoading;
function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  zxingLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
    s.onload = () => res(window.ZXing); s.onerror = rej;
    document.head.append(s);
  });
  return zxingLoading;
}

export function openScanner({ onCode, hint = 'Point at a barcode' }) {
  const v = el(`
    <div class="scanner">
      <video playsinline muted autoplay></video>
      <div class="scan-shade"></div>
      <div class="scan-frame"><i></i><i></i><i></i><i></i><div class="scan-laser"></div></div>
      <div class="scan-top"><button class="icon-btn dark" id="close" aria-label="Close">✕</button><span>${hint}</span><span></span></div>
      <div class="scan-msg" id="msg"></div>
      <form class="scan-manual" id="manual">
        <input inputmode="numeric" pattern="[0-9]*" placeholder="Or type a UPC" />
        <button class="btn sm primary">Add</button>
      </form>
    </div>`);
  document.body.append(v);
  const video = v.querySelector('video');
  const msg = v.querySelector('#msg');
  let stream, stopped = false, zxReader;

  const stop = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
    try { zxReader?.reset(); } catch {}
    v.classList.add('out'); setTimeout(() => v.remove(), 200);
  };
  const hit = (code) => {
    if (stopped) return;
    haptic([15, 30, 15]);
    v.classList.add('hit');
    setTimeout(() => { stop(); onCode(code); }, 220);
  };

  v.querySelector('#close').onclick = stop;
  v.querySelector('#manual').onsubmit = (e) => {
    e.preventDefault();
    const code = e.target.querySelector('input').value.replace(/\D/g, '');
    if (code.length >= 6) hit(code);
  };

  (async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      msg.textContent = 'Camera needs HTTPS. Type a UPC, or close and use Quick add.';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      video.srcObject = stream;
      await video.play().catch(() => {});

      if ('BarcodeDetector' in window) {
        const det = new window.BarcodeDetector({ formats: ['ean_13', 'upc_a', 'upc_e', 'ean_8', 'code_128'] });
        const loop = async () => {
          if (stopped) return;
          try { const [c] = await det.detect(video); if (c?.rawValue) return hit(normalize(c.rawValue)); } catch {}
          requestAnimationFrame(loop);
        };
        return loop();
      }
      const ZX = await loadZXing();
      zxReader = new ZX.BrowserMultiFormatReader();
      zxReader.decodeFromStream(stream, video, (res) => { if (res) hit(normalize(res.getText())); });
    } catch (e) {
      msg.textContent = 'Camera unavailable. Type a UPC, or close and use Quick add.';
    }
  })();
}

// EAN-13 with a leading 0 is a UPC-A.
const normalize = (c) => (c.length === 13 && c[0] === '0' ? c.slice(1) : c);
