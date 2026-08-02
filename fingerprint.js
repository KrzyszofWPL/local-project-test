// Per-token browser fingerprints.
//
// Every account runs in its own Chromium context, but by default they all share
// the exact same fingerprint (same screen, same GPU, same core count, same
// canvas hash). To anti-fraud systems that looks like one machine juggling many
// logins. This module derives a *stable, per-token* fingerprint from the token
// itself, so account #1 always looks like the same distinct PC across runs, and
// different accounts look like different PCs.
//
// The values are applied two ways:
//   • context options (userAgent, viewport, screen, deviceScaleFactor, locale…)
//   • an init script (navigator.hardwareConcurrency/deviceMemory, WebGL vendor/
//     renderer, and light canvas noise) injected before any page script runs.
//
// Entropy is limited to things that don't fight the proxy's geolocation: we keep
// the Windows/Chrome UA, Polish locale and Warsaw timezone constant, and vary
// hardware-ish signals instead. That keeps every account plausible while still
// giving each a unique fingerprint hash.

const crypto = require('crypto');

// Keep the Chrome build in step with the bundled Chromium so Discord serves the
// expected web build and webpack detection keeps working.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36';

const GPUS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

const SCREENS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 2560, height: 1440 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
  { width: 1680, height: 1050 },
];

const CORES = [4, 6, 8, 12, 16];
const MEMORY = [4, 8, 16];
const DPRS = [1, 1, 1.25, 1.5]; // weight 1x – most desktops report it

function fingerprintFor(token) {
  const h = crypto.createHash('sha256').update('fp:' + String(token)).digest();
  const seed = h.readUInt32LE(0) >>> 0;

  const gpu = GPUS[h[4] % GPUS.length];
  const screen = SCREENS[h[5] % SCREENS.length];
  const cores = CORES[h[6] % CORES.length];
  const memory = MEMORY[h[7] % MEMORY.length];
  const dpr = DPRS[h[8] % DPRS.length];

  // Viewport is the inner window – a bit smaller than the screen, within sane
  // desktop bounds and never larger than the screen itself.
  const width = Math.min(screen.width, 1200 + (h[9] % 6) * 80);   // 1200–1600
  const height = Math.min(screen.height - 80, 720 + (h[10] % 5) * 40); // 720–880

  return {
    seed,
    userAgent: UA,
    platform: 'Win32',
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    hardwareConcurrency: cores,
    deviceMemory: memory,
    deviceScaleFactor: dpr,
    viewport: { width, height },
    screen: { width: screen.width, height: screen.height },
    webgl: gpu,
  };
}

// Short human-readable summary, e.g. "RTX 3060 · 1920×1080 · 8 cores".
function fingerprintLabel(fp) {
  const gpu = fp.webgl.renderer.match(/(RTX|GTX|Radeon RX|UHD Graphics|Iris\(R\) Xe)[^,]*/);
  return `${gpu ? gpu[0].trim() : 'GPU'} · ${fp.screen.width}×${fp.screen.height} · ${fp.hardwareConcurrency} cores`;
}

// Runs inside the page, before Discord's own scripts, to line the JS-visible
// fingerprint up with the context options. Everything is wrapped so a failure
// never takes the page down with it.
function _apply(fp) {
  const def = (obj, prop, getter) => {
    try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (_) {}
  };

  def(Navigator.prototype, 'hardwareConcurrency', () => fp.hardwareConcurrency);
  def(Navigator.prototype, 'deviceMemory', () => fp.deviceMemory);
  def(Navigator.prototype, 'platform', () => fp.platform);

  const patchGL = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return fp.webgl.vendor;   // UNMASKED_VENDOR_WEBGL
      if (p === 37446) return fp.webgl.renderer;  // UNMASKED_RENDERER_WEBGL
      return orig.call(this, p);
    };
  };
  try { patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype); } catch (_) {}
  try { patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch (_) {}

  // Deterministic, sparse, ±-tiny canvas noise so the readback hash is unique
  // per token but stable across runs (pure function of pixel index + seed, so
  // repeated reads return identical bytes).
  const seed = fp.seed >>> 0;
  try {
    const origGID = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      const img = origGID.apply(this, args);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if ((((i >> 2) ^ seed) % 71) === 0) {
          d[i] ^= (seed & 1);
          d[i + 1] ^= ((seed >> 1) & 1);
          d[i + 2] ^= ((seed >> 2) & 1);
        }
      }
      return img;
    };
  } catch (_) {}

  // toDataURL / toBlob don't go through getImageData, so stamp one near-
  // invisible seeded pixel before serialising.
  const stamp = (canvas) => {
    try {
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx || !canvas.width || !canvas.height) return;
      const x = seed % canvas.width;
      const y = (seed >> 8) % canvas.height;
      ctx.fillStyle = 'rgba(' + (seed % 256) + ',' + ((seed >> 3) % 256) + ',' + ((seed >> 6) % 256) + ',0.01)';
      ctx.fillRect(x, y, 1, 1);
    } catch (_) {}
  };
  try {
    const origTDU = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a) { stamp(this); return origTDU.apply(this, a); };
    const origTB = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...a) { stamp(this); return origTB.apply(this, a); };
  } catch (_) {}
}

function initScript(fp) {
  return '(' + _apply.toString() + ')(' + JSON.stringify(fp) + ');';
}

module.exports = { fingerprintFor, fingerprintLabel, initScript, UA };
