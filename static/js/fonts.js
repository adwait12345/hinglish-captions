// Font list (Google Fonts + fonts installed on this computer) and loading.

import { accentFont, baseFont, fontCss } from './render.js?v=11';

let fontsPromise = null;
const googleLinks = new Map(); // family -> promise of its stylesheet loading
const ALL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

export function getFonts() {
  fontsPromise ??= fetch('/api/fonts').then((r) => r.json());
  return fontsPromise;
}

// Weights (and italic weights) a font family offers.
export async function fontInfo(family, source) {
  if (source !== 'google') return { weights: ALL_WEIGHTS, italics: ALL_WEIGHTS };
  const f = (await getFonts()).google.find((g) => g.family === family);
  return { weights: f?.weights ?? [400, 700], italics: f?.italics ?? [] };
}

// Resolves once Google's stylesheet has arrived; until then the browser
// doesn't know the font exists, and document.fonts.load() would return at once.
function addGoogleCss(family, { weights, italics }) {
  if (googleLinks.has(family)) return googleLinks.get(family);
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  let axes = '';
  if (italics.length) axes = `:ital,wght@${[...weights.map((w) => `0,${w}`), ...italics.map((w) => `1,${w}`)].join(';')}`;
  else if (weights.length > 1 || weights[0] !== 400) axes = `:wght@${weights.join(';')}`;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${name}${axes}&display=swap`;
  const ready = new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; });
  googleLinks.set(family, ready);
  document.head.appendChild(link);
  return ready;
}

async function loadOne(font) {
  if (font.source === 'google') await addGoogleCss(font.family, await fontInfo(font.family, 'google'));
  try {
    await document.fonts.load(fontCss(font, 48), 'AaBbYy 123');
  } catch {
    /* unknown font: canvas falls back to sans-serif */
  }
}

// Make sure every font the style uses is ready (canvas won't wait for it).
export async function loadFont(style) {
  const jobs = [loadOne(baseFont(style))];
  if (style.emphasis !== 'off') jobs.push(loadOne(accentFont(style)));
  await Promise.all(jobs);
}

// Nearest weight the family actually has, so text never renders faux-bold.
export function nearestWeight(weights, want) {
  return weights.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best), weights[0]);
}
