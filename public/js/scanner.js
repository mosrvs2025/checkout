import { el, haptic } from './shared.js';

// Camera barcode scanner.
// - Android Chrome: native BarcodeDetector (fast, hardware-accelerated).
// - iPhone / everything else: ZXing compiled to WebAssembly, vendored in /vendor so it
//   works without any CDN. Same BarcodeDetector API either way.
// Accuracy guards: GS1 check-digit validation + the same code must be read on two
// consecutive frames before we accept it.
// Camera access requires HTTPS (Vercel/Pages give you that) or localhost.

const PRODUCT = ['ean_13', 'upc_a', 'upc_e', 'ean_8'];
const detectors = {};

export function getDetector(FORMATS = PRODUCT) {
  return (detectors[FORMATS.join()] ||= (async () => {
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        if (FORMATS.every((f) => supported.includes(f))) return new window.BarcodeDetector({ formats: FORMATS });
      } catch {}
    }
    const mod = await import('../vendor/barcode-detector.js');
    const wasm = new URL('../vendor/zxing_reader.wasm', import.meta.url).href;
    mod.setZXingModuleOverrides({ locateFile: (p, prefix) => (p.endsWith('.wasm') ? wasm : prefix + p) });
    return new mod.BarcodeDetector({ formats: FORMATS });
  })());
}

// UPC-E -> UPC-A expansion so short codes match the same product as the full code.
function upcEtoA(e) {
  if (e.length === 8) e = e.slice(1, 7); else if (e.length !== 6) return e;
  const [a, b, c, d, f, g] = e;
  let body;
  if (g <= '2') body = a + b + g + '0000' + c + d + f;
  else if (g === '3') body = a + b + c + '00000' + d + f;
  else if (g === '4') body = a + b + c + d + '00000' + f;
  else body = a + b + c + d + f + '0000' + g;
  const s = '0' + body;
  return s + checkDigit(s);
}
function checkDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += +body[body.length - 1 - i] * (i % 2 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}
export const validGtin = (c) => /^\d{8}$|^\d{12,14}$/.test(c) && checkDigit(c.slice(0, -1)) === c.slice(-1);

// Normalize to the 12-digit UPC-A when possible (US grocery), else keep EAN.
export function normalize(raw, format) {
  let c = String(raw).replace(/\D/g, '');
  if (format === 'upc_e' || (c.length === 8 && format !== 'ean_8' && c[0] === '0')) c = upcEtoA(c);
  if (c.length === 13 && c[0] === '0') c = c.slice(1);
  if (c.length === 14 && c.startsWith('00')) c = c.slice(2);
  return c;
}

// accept(raw) lets callers take non-product codes (e.g. the register reading an Exit Pass QR).
export function openScanner({ onCode, hint = 'Point at a barcode', qr = false, accept, placeholder = 'Or type the numbers under the barcode' }) {
  const formats = qr ? [...PRODUCT, 'qr_code'] : PRODUCT;
  const v = el(`
    <div class="scanner">
      <video playsinline muted autoplay></video>
      <div class="scan-shade"></div>
      <div class="scan-frame"><i></i><i></i><i></i><i></i><div class="scan-laser"></div></div>
      <div class="scan-top">
        <button class="icon-btn dark" id="close" aria-label="Close">✕</button>
        <span>${hint}</span>
        <button class="icon-btn dark" id="torch" aria-label="Flashlight" hidden>⚡︎</button>
      </div>
      <div class="scan-msg" id="msg">Starting camera…</div>
      <form class="scan-manual" id="manual">
        <input inputmode="numeric" pattern="[0-9]*" placeholder="${placeholder}" />
        <button class="btn sm primary">Add</button>
      </form>
    </div>`);
  document.body.append(v);
  const video = v.querySelector('video');
  const msg = v.querySelector('#msg');
  let stream, stopped = false, last = '', torchOn = false;

  const stop = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
    v.classList.add('out'); setTimeout(() => v.remove(), 200);
  };
  const hit = (code) => {
    if (stopped) return;
    stopped = true;
    haptic([15, 30, 15]);
    v.classList.add('hit');
    msg.textContent = code;
    setTimeout(() => { stop(); onCode(code); }, 260);
  };

  v.querySelector('#close').onclick = stop;
  v.querySelector('#manual').onsubmit = (e) => {
    e.preventDefault();
    const raw = e.target.querySelector('input').value.trim();
    if (accept?.(raw)) return hit(raw.toUpperCase());
    const code = normalize(raw);
    if (code.length >= 8) hit(code);
  };

  (async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      msg.textContent = 'Camera needs an https:// link. Type the barcode numbers instead.';
      return;
    }
    const detectorReady = getDetector(formats); // load decoder while the camera starts
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (e) {
      msg.textContent = e.name === 'NotAllowedError'
        ? 'Camera blocked. Allow camera access for this site in Settings, then try again.'
        : 'Camera unavailable. Type the barcode numbers instead.';
      return;
    }
    if (stopped) return stream.getTracks().forEach((t) => t.stop());
    video.srcObject = stream;
    await video.play().catch(() => {});

    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    if (caps.torch) {
      const tb = v.querySelector('#torch');
      tb.hidden = false;
      tb.onclick = () => { torchOn = !torchOn; track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {}); tb.classList.toggle('on', torchOn); };
    }

    let detector;
    try { detector = await detectorReady; } catch {
      msg.textContent = 'Scanner failed to load. Type the barcode numbers instead.';
      return;
    }
    msg.textContent = '';

    const loop = async () => {
      if (stopped) return;
      if (video.readyState >= 2) {
        try {
          const codes = await detector.detect(video);
          const passHit = accept && codes.find((c) => accept(c.rawValue));
          if (passHit) return hit(passHit.rawValue);
          const good = codes.map((c) => normalize(c.rawValue, c.format)).find(validGtin);
          if (good && good === last) return hit(good);
          last = good || '';
        } catch {}
      }
      setTimeout(loop, 80);
    };
    loop();
  })();
}
