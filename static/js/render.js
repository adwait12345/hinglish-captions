// Caption renderer. The live preview and the exported video both draw through
// drawCaption(), so what you see in the editor is exactly what gets burned in.
// All sizes are relative to the video frame, so the preview can be any size.

export const DEFAULT_STYLE = {
  fontFamily: 'Montserrat', fontSource: 'google', fontWeight: 800, fontItalic: false,
  fontSize: 7,          // % of the video's shorter side
  textCase: 'upper',    // none | upper | lower
  letterSpacing: 0,     // em
  lineHeight: 1.15,
  maxWidth: 80,         // % of video width before wrapping
  positionY: 70,        // % from the top (centre of the caption)
  textColor: '#FFFFFF',

  // Accent words: set in a second font, usually bigger (e.g. serif italic).
  // Words marked *like this* in the text are accents; "auto" picks the key word.
  emphasis: 'off',      // off | auto
  emFontFamily: 'Instrument Serif', emFontSource: 'google', emFontWeight: 400, emItalic: true,
  emScale: 1.8, emColor: '#FFFFFF', emCase: 'same', emLetterSpacing: 0,
  layout: 'flow',       // flow | stack (accent words get their own lines)

  highlightMode: 'color',   // none | color | box
  highlightColor: '#FFE600',
  highlightTextColor: '#000000',
  activeScale: 1,       // grow the word being spoken
  display: 'full',      // full | progressive (words appear as they're said)
  strokeWidth: 10,      // % of font size
  strokeColor: '#000000',
  shadowColor: '#000000', shadowOpacity: 0.6, shadowBlur: 12, shadowOffset: 4,
  bgEnabled: false, bgColor: '#000000', bgOpacity: 0.55, bgRadius: 25,
  animation: 'pop',     // none | pop | fade | rise
};

const clean = { highlightMode: 'none', activeScale: 1, strokeWidth: 0, bgEnabled: false, display: 'full', emphasis: 'off', layout: 'flow' };

export const PRESETS = {
  // Cinematic / minimal
  'Editorial': { ...clean, fontFamily: 'Inter Tight', fontWeight: 700, fontSize: 5.2, textCase: 'lower', letterSpacing: -0.02,
    emphasis: 'auto', emFontFamily: 'Instrument Serif', emFontWeight: 400, emItalic: true, emScale: 2, emCase: 'lower',
    emLetterSpacing: -0.02, layout: 'stack', lineHeight: 0.95, shadowOpacity: 0.35, shadowBlur: 40, shadowOffset: 0, animation: 'rise',
    sample: 'this isn’t my *real* *voice*' },
  'Paradise': { ...clean, fontFamily: 'Archivo', fontWeight: 800, fontSize: 6, textCase: 'lower', letterSpacing: -0.04, textColor: '#F3E2A0',
    emphasis: 'auto', emFontFamily: 'Pinyon Script', emFontWeight: 400, emItalic: false, emScale: 2.4, emColor: '#F3E2A0', emCase: 'none',
    layout: 'stack', lineHeight: 0.88, shadowOpacity: 0.25, shadowBlur: 30, shadowOffset: 0, animation: 'fade',
    sample: '*Sun* *Sets* in paradise' },
  'Gold accent': { ...clean, fontFamily: 'Manrope', fontWeight: 500, fontSize: 4.8, textCase: 'lower',
    emphasis: 'auto', emFontFamily: 'Fraunces', emFontWeight: 500, emItalic: true, emScale: 1.55, emColor: '#E9C46A', emCase: 'lower',
    shadowOpacity: 0.45, shadowBlur: 24, shadowOffset: 0, animation: 'fade', sample: 'the *quiet* luxury' },
  'Film': { ...clean, fontFamily: 'Cormorant Garamond', fontWeight: 600, fontSize: 4.4, textCase: 'none', letterSpacing: 0.01,
    textColor: '#F5F1E8', positionY: 84, shadowOpacity: 0.7, shadowBlur: 10, shadowOffset: 0, animation: 'fade',
    sample: 'We were never meant to stay.' },
  'Luxe': { ...clean, fontFamily: 'Bodoni Moda', fontWeight: 500, fontSize: 3.6, textCase: 'upper', letterSpacing: 0.32,
    textColor: '#EADBC8', maxWidth: 70, shadowOpacity: 0.4, shadowBlur: 20, shadowOffset: 0, animation: 'fade', sample: 'Made in Paris' },
  'Whisper': { ...clean, fontFamily: 'Instrument Serif', fontWeight: 400, fontItalic: true, fontSize: 7, textCase: 'lower',
    letterSpacing: -0.01, display: 'progressive', shadowColor: '#FFFFFF', shadowOpacity: 0.35, shadowBlur: 35, shadowOffset: 0,
    animation: 'fade', sample: 'softly, slowly' },
  'Poster': { ...clean, fontFamily: 'Playfair Display', fontWeight: 900, fontSize: 8.5, textCase: 'upper', letterSpacing: -0.03,
    textColor: '#E3242B', lineHeight: 0.88, maxWidth: 72, shadowOpacity: 0, animation: 'rise', sample: 'Life goes on' },
  'Tall': { ...clean, fontFamily: 'Anton', fontWeight: 400, fontSize: 13, textCase: 'upper', lineHeight: 0.92, maxWidth: 90,
    shadowOpacity: 0.25, shadowBlur: 30, shadowOffset: 0, animation: 'rise', sample: 'Mountains' },

  // Bold social styles
  'Bold Pop': { group: 'social' },
  'Hormozi': { group: 'social', fontFamily: 'Montserrat', fontWeight: 900, textCase: 'upper',
    highlightMode: 'color', highlightColor: '#39FF14', activeScale: 1.15, strokeWidth: 14, fontSize: 7.5 },
  'Clean': { group: 'social', fontFamily: 'Inter', fontWeight: 600, textCase: 'none', fontSize: 5.5,
    highlightMode: 'none', strokeWidth: 0, shadowOpacity: 0.55, shadowBlur: 14, shadowOffset: 3, animation: 'none' },
  'Boxed': { group: 'social', fontFamily: 'Inter', fontWeight: 700, textCase: 'none', fontSize: 5.5,
    highlightMode: 'none', strokeWidth: 0, shadowOpacity: 0, bgEnabled: true, bgOpacity: 0.7, animation: 'none' },
  'Karaoke': { group: 'social', fontFamily: 'Poppins', fontWeight: 800, textCase: 'none',
    highlightMode: 'box', highlightColor: '#7C3AED', highlightTextColor: '#FFFFFF', strokeWidth: 0,
    shadowOpacity: 0.5, shadowBlur: 10 },
  'Word by word': { group: 'social', fontFamily: 'Poppins', fontWeight: 800, textCase: 'upper',
    display: 'progressive', highlightMode: 'color', highlightColor: '#FFE600', strokeWidth: 12 },
};

export const ANIMATIONS = {
  pop: { in: 0.15 },
  fade: { in: 0.3, out: 0.2 },
  rise: { in: 0.4, out: 0.2 },
};
const WORD_IN = 0.3; // per-word fade when words appear as they're said

// Older projects saved `uppercase: true/false`.
export function normalizeStyle(s = {}) {
  const out = { ...DEFAULT_STYLE, ...s };
  if (s.uppercase !== undefined && s.textCase === undefined) out.textCase = s.uppercase ? 'upper' : 'none';
  delete out.uppercase;
  return out;
}

export function presetStyle(name, current) {
  // Presets restyle the text but keep where you've placed it.
  const { sample, group, ...preset } = PRESETS[name];
  return { ...DEFAULT_STYLE, positionY: current.positionY, maxWidth: current.maxWidth, ...preset };
}

export function fontPx(style, W, H) {
  return (style.fontSize / 100) * Math.min(W, H);
}

export function fontCss({ family, weight, italic }, px) {
  return `${italic ? 'italic ' : ''}${weight} ${px}px "${family}", sans-serif`;
}

// The two text "runs" a caption can use: base text and accent words.
export function baseFont(style) {
  return { family: style.fontFamily, source: style.fontSource, weight: style.fontWeight, italic: style.fontItalic };
}
export function accentFont(style) {
  return { family: style.emFontFamily, source: style.emFontSource, weight: style.emFontWeight, italic: style.emItalic };
}

function runStyle(style, em, px) {
  return em
    ? { ...accentFont(style), px: px * style.emScale, color: style.emColor, ls: style.emLetterSpacing,
        kase: style.emCase === 'same' ? style.textCase : style.emCase }
    : { ...baseFont(style), px, color: style.textColor, ls: style.letterSpacing, kase: style.textCase };
}

function applyCase(text, kase) {
  return kase === 'upper' ? text.toUpperCase() : kase === 'lower' ? text.toLowerCase() : text;
}

// Words that carry little meaning — never auto-picked as the accent.
const STOP = new Set(('a an the is are am was were be been to of in on at for and or but so if as by with from it its this that these those ' +
  'i you he she we they me us them my your his her our their not no yes do does did just very really ' +
  'hai hain ho hoga tha thi the ka ki ke ko se me mein main par aur ya to toh bhi hi na nahi nahin ek yeh ye woh wo vah kya ' +
  'kaise jo jab tab ab is us un in kuch sab bahut hum ham tum aap mai mera meri mere apna apni karna kar raha rahi rahe wala vaale').split(' '));

const bare = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

// Which words of a caption are accents (indices).
export function accentSet(cap, style) {
  if (style.emphasis === 'off') return new Set();
  const marked = cap.words.flatMap((w, i) => (w.em ? [i] : []));
  if (marked.length) return new Set(marked);
  const ranked = cap.words.map((w, i) => ({ i, b: bare(w.text) }))
    .filter((x) => x.b.length > 2 && !STOP.has(x.b))
    .sort((a, b) => b.b.length - a.b.length || b.i - a.i);
  return new Set(ranked.slice(0, cap.words.length >= 5 ? 2 : 1).map((x) => x.i));
}

// --- text measuring/drawing with letter spacing --------------------------------
const NATIVE_LS = typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype;

function setFont(ctx, rs) {
  ctx.font = fontCss(rs, rs.px);
  if (NATIVE_LS) ctx.letterSpacing = `${rs.ls * rs.px}px`;
}

function textWidth(ctx, text, rs) {
  const ls = rs.ls * rs.px;
  if (NATIVE_LS) return ctx.measureText(text).width - (text.length ? ls : 0); // no trailing gap
  if (!ls) return ctx.measureText(text).width;
  const chars = [...text];
  return chars.reduce((a, c) => a + ctx.measureText(c).width, 0) + ls * (chars.length - 1);
}

function drawText(ctx, text, x, y, rs, stroke) {
  const ls = rs.ls * rs.px;
  if (NATIVE_LS || !ls) return stroke ? ctx.strokeText(text, x, y) : ctx.fillText(text, x, y);
  for (const c of text) {
    stroke ? ctx.strokeText(c, x, y) : ctx.fillText(c, x, y);
    x += ctx.measureText(c).width + ls;
  }
}

function rgba(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const easeOut = (p) => 1 - (1 - Math.min(1, Math.max(0, p))) ** 3;

function popScale(dt) {
  const d = ANIMATIONS.pop.in;
  if (dt < 0 || dt >= d) return 1;
  const p = dt / d;
  if (p < 0.7) return 0.75 + 0.31 * easeOut(p / 0.7); // ease out to a small overshoot
  return 1.06 - 0.06 * ((p - 0.7) / 0.3);
}

export function activeWordIndex(cap, t) {
  let idx = -1;
  cap.words.forEach((w, i) => { if (t >= w.start - 1e-4) idx = i; });
  return idx;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, h / 2, w / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Break a caption into lines. Words in a line share a baseline, so a big
// accent word sits naturally next to smaller text.
function layout(ctx, cap, style, W, px, active = -1) {
  const accents = accentSet(cap, style);
  const maxW = (style.maxWidth / 100) * W;
  const items = cap.words.map((w, i) => {
    const em = accents.has(i);
    const rs = runStyle(style, em, px);
    setFont(ctx, rs);
    const text = applyCase(w.text, rs.kase);
    const raw = textWidth(ctx, text, rs);
    // Tracking applies to spaces too (after the last letter and after the space),
    // otherwise widely spaced words run into each other.
    const space = ctx.measureText(' ').width + (NATIVE_LS ? 1 : 2) * rs.ls * rs.px;
    return { i, em, rs, text, raw, space, width: i === active ? raw * style.activeScale : raw };
  });
  const lines = [];
  let line = null;
  for (const it of items) {
    const prev = line?.items.at(-1);
    const gap = prev ? (prev.space + it.space) / 2 : 0;
    const brk = !line || (style.layout === 'stack' && prev.em !== it.em) || line.width + gap + it.width > maxW;
    if (brk) {
      if (line) lines.push(line);
      line = { items: [], width: 0, px: 0 };
    }
    it.x = line.items.length ? line.width + gap : 0;
    line.width = it.x + it.width;
    line.px = Math.max(line.px, it.rs.px);
    line.items.push(it);
  }
  if (line) lines.push(line);
  let y = 0;
  for (const l of lines) {
    l.h = l.px * style.lineHeight;
    l.top = y;
    l.baseline = y + l.h / 2 + l.px * 0.35; // centre the cap-height in the line box
    y += l.h;
  }
  return { lines, height: y, width: Math.max(0, ...lines.map((l) => l.width)) };
}

function captionAnim(style, cap, t, px) {
  const a = ANIMATIONS[style.animation];
  const out = { alpha: 1, scale: 1, dy: 0 };
  if (!a) return out;
  if (style.animation === 'pop') out.scale = popScale(t - cap.start);
  else {
    const pin = easeOut((t - cap.start) / a.in);
    const pout = Math.min(1, Math.max(0, (cap.end - t) / a.out));
    out.alpha = Math.min(pin, pout);
    if (style.animation === 'rise') out.dy = (1 - pin) * px * 0.45;
  }
  return out;
}

// Draw one caption as it looks at time t, into a W×H video-sized coordinate space.
export function drawCaption(ctx, W, H, cap, t, style) {
  if (!cap || !cap.words.length) return;
  const px = fontPx(style, W, H);
  const active = activeWordIndex(cap, t);
  const L = layout(ctx, cap, style, W, px, style.activeScale !== 1 ? active : -1);
  const cy = (style.positionY / 100) * H;
  const top = cy - L.height / 2;
  const progressive = style.display === 'progressive';
  const shown = progressive ? Math.max(active, 0) : Infinity;
  const anim = captionAnim(style, cap, t, px);
  if (anim.alpha <= 0) return;

  ctx.save();
  ctx.globalAlpha = anim.alpha;
  ctx.translate(0, anim.dy);
  if (anim.scale !== 1) {
    ctx.translate(W / 2, cy);
    ctx.scale(anim.scale, anim.scale);
    ctx.translate(-W / 2, -cy);
  }

  if (style.bgEnabled) {
    const padX = px * 0.45, padY = px * 0.22;
    ctx.fillStyle = rgba(style.bgColor, style.bgOpacity);
    roundRect(ctx, W / 2 - L.width / 2 - padX, top - padY, L.width + padX * 2, L.height + padY * 2, (style.bgRadius / 100) * px * style.lineHeight);
    ctx.fill();
  }

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  for (const line of L.lines) {
    const x0 = W / 2 - line.width / 2;
    const base = top + line.baseline;
    for (const item of line.items) {
      if (item.i > shown) continue;
      const rs = item.rs;
      const isActive = item.i === active && style.highlightMode !== 'none';
      const cx = x0 + item.x + item.width / 2;
      const x = cx - item.raw / 2; // unscaled text centred in its (possibly grown) slot
      const mid = base - rs.px * 0.35;
      ctx.save();
      if (progressive && (style.animation === 'fade' || style.animation === 'rise')) {
        const ws = item.i === 0 ? cap.start : cap.words[item.i].start;
        const p = easeOut((t - ws) / WORD_IN);
        ctx.globalAlpha *= p;
        ctx.translate(0, (1 - p) * rs.px * 0.25);
      }
      if (item.i === active && style.activeScale !== 1) {
        ctx.translate(cx, mid);
        ctx.scale(style.activeScale, style.activeScale);
        ctx.translate(-cx, -mid);
      }
      if (isActive && style.highlightMode === 'box') {
        const padX = rs.px * 0.18, h = rs.px * 1.2;
        ctx.fillStyle = style.highlightColor;
        roundRect(ctx, x - padX, mid - h / 2, item.raw + padX * 2, h, rs.px * 0.2);
        ctx.fill();
      }
      setFont(ctx, rs);
      if (style.shadowOpacity > 0) {
        ctx.shadowColor = rgba(style.shadowColor, style.shadowOpacity); // globalAlpha fades it too
        ctx.shadowBlur = (style.shadowBlur / 100) * rs.px;
        ctx.shadowOffsetY = (style.shadowOffset / 100) * rs.px;
      }
      if (style.strokeWidth > 0) {
        ctx.lineWidth = (style.strokeWidth / 100) * rs.px * 2;
        ctx.strokeStyle = style.strokeColor;
        drawText(ctx, item.text, x, base, rs, true);
        ctx.shadowColor = 'transparent'; // shadow once, on the outline
      }
      ctx.fillStyle = isActive
        ? (style.highlightMode === 'box' ? style.highlightTextColor : style.highlightColor)
        : rs.color;
      drawText(ctx, item.text, x, base, rs, false);
      ctx.restore();
    }
  }
  ctx.restore();
}

// Bounding box of a caption in video coordinates (for dragging it on the stage).
export function captionBox(ctx, W, H, cap, style) {
  const px = fontPx(style, W, H);
  const L = layout(ctx, cap, style, W, px);
  const cy = (style.positionY / 100) * H;
  return { left: W / 2 - L.width / 2, right: W / 2 + L.width / 2, top: cy - L.height / 2, bottom: cy + L.height / 2 };
}

export function captionAt(captions, t) {
  return captions.find((c) => t >= c.start && t < c.end) || null;
}

// Every distinct look the captions have over the video: one entry per word
// change and per animation frame. Each becomes one PNG in the export.
export function exportStates(captions, style, fps) {
  const wordBased = style.highlightMode !== 'none' || style.display === 'progressive' || style.activeScale !== 1;
  const anim = ANIMATIONS[style.animation];
  const wordFade = style.display === 'progressive' && (style.animation === 'fade' || style.animation === 'rise');
  const states = [];
  for (const cap of [...captions].sort((a, b) => a.start - b.start)) {
    if (cap.end - cap.start < 0.01 || !cap.words.length) continue;
    const points = new Set([cap.start]);
    if (wordBased) cap.words.forEach((w) => { if (w.start > cap.start && w.start < cap.end) points.add(w.start); });
    // Animated stretches get one frame per video frame.
    const windows = [];
    if (anim?.in) windows.push([cap.start, cap.start + anim.in]);
    if (anim?.out) windows.push([cap.end - anim.out, cap.end]);
    if (wordFade) cap.words.forEach((w, i) => windows.push([i ? w.start : cap.start, (i ? w.start : cap.start) + WORD_IN]));
    for (const [a, b] of windows) {
      for (let p = a; p < b; p += 1 / fps) if (p > cap.start && p < cap.end) points.add(p);
    }
    const sorted = [...points].sort((a, b) => a - b);
    sorted.forEach((p, i) => {
      const end = i + 1 < sorted.length ? sorted[i + 1] : cap.end;
      if (end - p > 0.0005) states.push({ cap, start: p, end, t: p + 0.0005 });
    });
  }
  return states;
}

// Vertical strip of the frame that captions can ever touch, so export only
// encodes that band instead of full transparent frames.
export function captionBand(ctx, W, H, captions, style) {
  let top = H, bottom = 0;
  const px = fontPx(style, W, H);
  for (const cap of captions) {
    if (!cap.words.length) continue;
    const b = captionBox(ctx, W, H, cap, style);
    top = Math.min(top, b.top);
    bottom = Math.max(bottom, b.bottom);
  }
  if (bottom <= top) return { top: 0, height: H };
  const grow = Math.max(style.activeScale, ANIMATIONS[style.animation] ? 1.1 : 1, style.emphasis !== 'off' ? style.emScale : 1);
  const margin = px * grow * 0.9 + ((style.shadowBlur + Math.abs(style.shadowOffset) + style.strokeWidth) / 100) * px * 3 + px * 0.6;
  const t = Math.max(0, Math.floor(top - margin));
  const b = Math.min(H, Math.ceil(bottom + margin));
  return { top: t, height: b - t };
}
