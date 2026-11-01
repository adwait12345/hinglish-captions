// Font list (Google Fonts + fonts installed on this computer) and loading.

import { fontCss } from './render.js';

let fontsPromise = null;
const googleLinks = new Set();

export function getFonts() {
  fontsPromise ??= fetch('/api/fonts').then((r) => r.json());
  return fontsPromise;
}

export async function googleWeights(family) {
  const fonts = await getFonts();
  return fonts.google.find((f) => f.family === family)?.weights ?? [400, 700];
}

function addGoogleCss(family, weights) {
  if (googleLinks.has(family)) return;
  googleLinks.add(family);
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  const wq = weights.length > 1 || weights[0] !== 400 ? `:wght@${weights.join(';')}` : '';
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${name}${wq}&display=swap`;
  document.head.appendChild(link);
}

// Make sure the caption font is ready before drawing (canvas won't wait for it).
export async function loadFont(style) {
  if (style.fontSource === 'google') addGoogleCss(style.fontFamily, await googleWeights(style.fontFamily));
  try {
    await document.fonts.load(fontCss(style, 48), 'AaBbYy 123');
  } catch {
    /* unknown font: canvas falls back to sans-serif */
  }
}

// Nearest weight the family actually has, so text never renders faux-bold.
export function nearestWeight(weights, want) {
  return weights.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best), weights[0]);
}
