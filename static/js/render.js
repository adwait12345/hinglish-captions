// Caption renderer. The live preview and the exported video both draw through
// drawCaption(), so what you see in the editor is exactly what gets burned in.
// All sizes are relative to the video frame, so the preview can be any size.

export const DEFAULT_STYLE = {
  fontFamily: 'Montserrat', fontSource: 'google', fontWeight: 800,
  fontSize: 7,          // % of the video's shorter side
  uppercase: true,
  lineHeight: 1.15,
  maxWidth: 80,         // % of video width before wrapping
  positionY: 70,        // % from the top (centre of the caption)
  textColor: '#FFFFFF',
  highlightMode: 'color',   // none | color | box
  highlightColor: '#FFE600',
  highlightTextColor: '#000000',
  activeScale: 1,       // grow the word being spoken
  display: 'full',      // full | progressive (words appear as they're said)
  strokeWidth: 10,      // % of font size
  strokeColor: '#000000',
  shadowColor: '#000000', shadowOpacity: 0.6, shadowBlur: 12, shadowOffset: 4,
  bgEnabled: false, bgColor: '#000000', bgOpacity: 0.55, bgRadius: 25,
  animation: 'pop',     // none | pop
};

export const PRESETS = {
  'Bold Pop': {},
  'Hormozi': { fontFamily: 'Montserrat', fontSource: 'google', fontWeight: 900, uppercase: true,
    highlightMode: 'color', highlightColor: '#39FF14', activeScale: 1.15, strokeWidth: 14, fontSize: 7.5 },
  'Clean': { fontFamily: 'Inter', fontSource: 'google', fontWeight: 600, uppercase: false, fontSize: 5.5,
    highlightMode: 'none', strokeWidth: 0, shadowOpacity: 0.55, shadowBlur: 14, shadowOffset: 3, animation: 'none' },
  'Boxed': { fontFamily: 'Inter', fontSource: 'google', fontWeight: 700, uppercase: false, fontSize: 5.5,
    highlightMode: 'none', strokeWidth: 0, shadowOpacity: 0, bgEnabled: true, bgOpacity: 0.7, animation: 'none' },
  'Karaoke': { fontFamily: 'Poppins', fontSource: 'google', fontWeight: 800, uppercase: false,
    highlightMode: 'box', highlightColor: '#7C3AED', highlightTextColor: '#FFFFFF', strokeWidth: 0,
    shadowOpacity: 0.5, shadowBlur: 10 },
  'Word by word': { fontFamily: 'Poppins', fontSource: 'google', fontWeight: 800, uppercase: true,
    display: 'progressive', highlightMode: 'color', highlightColor: '#FFE600', strokeWidth: 12 },
};

export const POP_DURATION = 0.15;

export function presetStyle(name, current) {
  // Presets restyle the text but keep where you've placed it.
  return { ...DEFAULT_STYLE, ...PRESETS[name], positionY: current.positionY, maxWidth: current.maxWidth };
}

export function fontPx(style, W, H) {
  return (style.fontSize / 100) * Math.min(W, H);
}

export function fontCss(style, px) {
  return `${style.fontWeight} ${px}px "${style.fontFamily}", sans-serif`;
}

function rgba(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function popScale(dt) {
  if (dt < 0 || dt >= POP_DURATION) return 1;
  const p = dt / POP_DURATION;
  if (p < 0.7) return 0.75 + 0.31 * (1 - (1 - p / 0.7) ** 3); // ease out to a small overshoot
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

function layout(ctx, cap, style, W, px, active = -1) {
  ctx.font = fontCss(style, px);
  const space = ctx.measureText(' ').width;
  const maxW = (style.maxWidth / 100) * W;
  const lines = [];
  let line = { items: [], width: 0 };
  cap.words.forEach((w, i) => {
    const text = style.uppercase ? w.text.toUpperCase() : w.text;
    const raw = ctx.measureText(text).width;
    const width = i === active ? raw * style.activeScale : raw; // make room for a grown word
    const grow = line.items.length ? space + width : width;
    if (line.items.length && line.width + grow > maxW) {
      lines.push(line);
      line = { items: [], width: 0 };
    }
    line.items.push({ i, text, width, raw, x: line.items.length ? line.width + space : 0 });
    line.width += line.items.length > 1 ? space + width : width;
  });
  if (line.items.length) lines.push(line);
  return lines;
}

// Draw one caption as it looks at time t, into a W×H video-sized coordinate space.
export function drawCaption(ctx, W, H, cap, t, style) {
  if (!cap || !cap.words.length) return;
  const px = fontPx(style, W, H);
  const active = activeWordIndex(cap, t);
  const lines = layout(ctx, cap, style, W, px, style.activeScale !== 1 ? active : -1);
  const lh = px * style.lineHeight;
  const cy = (style.positionY / 100) * H;
  const top = cy - (lines.length * lh) / 2;
  const shown = style.display === 'progressive' ? Math.max(active, 0) : Infinity;

  ctx.save();
  if (style.animation === 'pop') {
    const s = popScale(t - cap.start);
    ctx.translate(W / 2, cy);
    ctx.scale(s, s);
    ctx.translate(-W / 2, -cy);
  }

  if (style.bgEnabled) {
    const padX = px * 0.45, padY = px * 0.22;
    const bw = Math.max(...lines.map((l) => l.width)) + padX * 2;
    const bh = lines.length * lh + padY * 2;
    ctx.fillStyle = rgba(style.bgColor, style.bgOpacity);
    roundRect(ctx, W / 2 - bw / 2, top - padY, bw, bh, (style.bgRadius / 100) * lh);
    ctx.fill();
  }

  ctx.font = fontCss(style, px);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const stroke = style.strokeWidth > 0 ? (style.strokeWidth / 100) * px * 2 : 0;

  lines.forEach((line, li) => {
    const x0 = W / 2 - line.width / 2;
    const y = top + lh * (li + 0.5);
    line.items.forEach((item) => {
      if (item.i > shown) return;
      const isActive = item.i === active && style.highlightMode !== 'none';
      const cx = x0 + item.x + item.width / 2;
      const x = cx - item.raw / 2; // draw unscaled text centred in its (possibly grown) slot
      ctx.save();
      if (item.i === active && style.activeScale !== 1) {
        ctx.translate(cx, y);
        ctx.scale(style.activeScale, style.activeScale);
        ctx.translate(-cx, -y);
      }
      if (isActive && style.highlightMode === 'box') {
        const padX = px * 0.18, h = px * 1.2;
        ctx.fillStyle = style.highlightColor;
        roundRect(ctx, x - padX, y - h / 2, item.raw + padX * 2, h, px * 0.2);
        ctx.fill();
      }
      const shadow = style.shadowOpacity > 0;
      if (shadow) {
        ctx.shadowColor = rgba(style.shadowColor, style.shadowOpacity);
        ctx.shadowBlur = (style.shadowBlur / 100) * px;
        ctx.shadowOffsetY = (style.shadowOffset / 100) * px;
      }
      if (stroke) {
        ctx.lineWidth = stroke;
        ctx.strokeStyle = style.strokeColor;
        ctx.strokeText(item.text, x, y);
        ctx.shadowColor = 'transparent'; // shadow once, on the outline
      }
      ctx.fillStyle = isActive
        ? (style.highlightMode === 'box' ? style.highlightTextColor : style.highlightColor)
        : style.textColor;
      ctx.fillText(item.text, x, y);
      ctx.restore();
    });
  });
  ctx.restore();
}

// Bounding box of a caption in video coordinates (for dragging it on the stage).
export function captionBox(ctx, W, H, cap, style) {
  const px = fontPx(style, W, H);
  const lines = layout(ctx, cap, style, W, px);
  const h = lines.length * px * style.lineHeight;
  const w = Math.max(...lines.map((l) => l.width));
  const cy = (style.positionY / 100) * H;
  return { left: W / 2 - w / 2, right: W / 2 + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
}

export function captionAt(captions, t) {
  return captions.find((c) => t >= c.start && t < c.end) || null;
}

// Every distinct look the captions have over the video: one entry per word
// change and per pop-animation frame. Each becomes one PNG in the export.
export function exportStates(captions, style, fps) {
  const wordBased = style.highlightMode !== 'none' || style.display === 'progressive' || style.activeScale !== 1;
  const states = [];
  for (const cap of [...captions].sort((a, b) => a.start - b.start)) {
    if (cap.end - cap.start < 0.01 || !cap.words.length) continue;
    const points = new Set([cap.start]);
    if (wordBased) cap.words.forEach((w) => { if (w.start > cap.start && w.start < cap.end) points.add(w.start); });
    if (style.animation === 'pop') {
      for (let k = 1; k < Math.ceil(POP_DURATION * fps) + 1; k++) {
        const p = cap.start + k / fps;
        if (p < cap.end) points.add(p);
      }
    }
    const sorted = [...points].sort((a, b) => a - b);
    sorted.forEach((p, i) => {
      const end = i + 1 < sorted.length ? sorted[i + 1] : cap.end;
      if (end - p > 0.0005) states.push({ cap, start: p, end, t: p + 0.0005 });
    });
  }
  return states;
}
