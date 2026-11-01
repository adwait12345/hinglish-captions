// Timeline: ruler + audio waveform + caption blocks you can drag and resize.

const PAD = 16;          // px of empty space before 0:00
const RULER_H = 24;
const WAVE_TOP = 26, WAVE_H = 56;
const MIN_LEN = 0.1;     // shortest caption, seconds
const SNAP_PX = 6;

export function fmtTime(t, precise = true) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${(precise ? s.toFixed(2) : Math.floor(s).toString()).padStart(precise ? 5 : 2, '0')}`;
}

export class Timeline {
  constructor(root, app) {
    this.app = app;
    this.pps = 120; // pixels per second
    this.peaks = [];
    this.perSec = 100;
    root.innerHTML = `
      <div class="tl-scroll">
        <canvas class="tl-wave"></canvas>
        <div class="tl-inner">
          <div class="tl-track"></div>
          <div class="tl-playhead"><div class="tl-knob"></div></div>
        </div>
      </div>`;
    this.scroll = root.querySelector('.tl-scroll');
    this.canvas = root.querySelector('.tl-wave');
    this.inner = root.querySelector('.tl-inner');
    this.track = root.querySelector('.tl-track');
    this.playhead = root.querySelector('.tl-playhead');

    this.scroll.addEventListener('scroll', () => this.drawWave());
    new ResizeObserver(() => this.drawWave()).observe(this.scroll);
    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoomAt(this.pps * Math.exp(-e.deltaY * 0.01), e.clientX);
      }
    }, { passive: false });

    // Click or drag anywhere that isn't a caption to scrub.
    this.inner.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tl-cap')) return;
      e.preventDefault();
      const seek = (ev) => this.app.seek(this.timeAtClientX(ev.clientX));
      seek(e);
      const up = () => { window.removeEventListener('pointermove', seek); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', seek);
      window.addEventListener('pointerup', up);
    });
  }

  get duration() { return this.app.duration; }

  setPeaks(peaks, perSec) {
    this.peaks = peaks;
    this.perSec = perSec;
    this.layout();
  }

  timeAtClientX(clientX) {
    const x = clientX - this.scroll.getBoundingClientRect().left + this.scroll.scrollLeft - PAD;
    return Math.max(0, Math.min(this.duration, x / this.pps));
  }

  xOf(t) { return PAD + t * this.pps; }

  zoomAt(pps, clientX) {
    pps = Math.max(15, Math.min(800, pps));
    const anchorT = clientX != null ? this.timeAtClientX(clientX) : this.app.time;
    const anchorX = clientX != null ? clientX - this.scroll.getBoundingClientRect().left : this.xOf(anchorT) - this.scroll.scrollLeft;
    this.pps = pps;
    this.layout();
    this.scroll.scrollLeft = this.xOf(anchorT) - anchorX;
    this.app.onZoom?.(pps);
  }

  fitToView() {
    const w = this.scroll.clientWidth - PAD * 2;
    if (w > 0 && this.duration > 0) this.pps = Math.max(15, Math.min(800, w / this.duration));
    this.layout();
    this.app.onZoom?.(this.pps);
  }

  layout() {
    this.inner.style.width = `${this.xOf(this.duration) + PAD}px`;
    this.render();
    this.setTime(this.app.time);
    this.drawWave();
  }

  drawWave() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.scroll.clientWidth, h = this.scroll.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const sl = this.scroll.scrollLeft;
    const css = getComputedStyle(document.documentElement);

    // Ruler: pick a tick spacing that leaves room for labels.
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => s * this.pps >= 70) ?? 600;
    const minor = step / 5;
    ctx.fillStyle = css.getPropertyValue('--tl-ruler').trim();
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = css.getPropertyValue('--tl-tick').trim();
    ctx.fillStyle = css.getPropertyValue('--muted').trim();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const t0 = Math.max(0, (sl - PAD) / this.pps), t1 = (sl + w - PAD) / this.pps;
    ctx.beginPath();
    // Count in whole ticks (not t += minor) so float drift can't mislabel.
    for (let k = Math.floor(t0 / minor); k * minor <= Math.min(t1, this.duration) + 1e-9; k++) {
      const t = Math.round(k * minor * 1000) / 1000;
      const x = Math.round(this.xOf(t) - sl) + 0.5;
      const major = k % 5 === 0;
      ctx.moveTo(x, major ? 8 : 16);
      ctx.lineTo(x, RULER_H);
      if (major) ctx.fillText(step < 1 ? fmtTime(t).replace(/0$/, '') : fmtTime(t, false), x + 4, 10);
    }
    ctx.stroke();

    // Waveform, mirrored around its centre line.
    if (!this.peaks.length) return;
    ctx.fillStyle = css.getPropertyValue('--wave').trim();
    const mid = WAVE_TOP + WAVE_H / 2;
    for (let x = 0; x < w; x += 2) {
      const a = (sl + x - PAD) / this.pps, b = (sl + x + 2 - PAD) / this.pps;
      if (b < 0 || a > this.duration) continue;
      const i0 = Math.max(0, Math.floor(a * this.perSec)), i1 = Math.min(this.peaks.length, Math.ceil(b * this.perSec) + 1);
      let p = 0;
      for (let i = i0; i < i1; i++) p = Math.max(p, this.peaks[i]);
      const bh = Math.max(1, p * (WAVE_H / 2 - 2));
      ctx.fillRect(x, mid - bh, 1.5, bh * 2);
    }
  }

  setTime(t) {
    this.playhead.style.transform = `translateX(${this.xOf(t)}px)`;
    if (this.app.playing) {  // keep the playhead in view while playing
      const x = this.xOf(t) - this.scroll.scrollLeft, w = this.scroll.clientWidth;
      if (x > w - 40 || x < 0) this.scroll.scrollLeft = this.xOf(t) - 60;
    }
  }

  scrollToTime(t) {
    const x = this.xOf(t) - this.scroll.scrollLeft, w = this.scroll.clientWidth;
    if (x < 30 || x > w - 30) this.scroll.scrollLeft = this.xOf(t) - w / 3;
  }

  render() {
    const caps = this.app.captions;
    this.track.replaceChildren(...caps.map((cap) => this.block(cap)));
  }

  block(cap) {
    const el = document.createElement('div');
    el.className = 'tl-cap' + (cap.id === this.app.selectedId ? ' selected' : '');
    el.dataset.id = cap.id;
    this.position(el, cap);
    el.innerHTML = '<div class="h h-l"></div><span class="tl-text"></span><div class="h h-r"></div>';
    el.querySelector('.tl-text').textContent = cap.words.map((w) => w.text).join(' ');
    el.addEventListener('pointerdown', (e) => this.startDrag(e, cap, el));
    el.addEventListener('dblclick', () => this.app.focusCaptionText(cap.id));
    return el;
  }

  position(el, cap) {
    el.style.left = `${this.xOf(cap.start)}px`;
    el.style.width = `${Math.max(2, (cap.end - cap.start) * this.pps)}px`;
    el.querySelectorAll('.tl-tick').forEach((t) => t.remove());
    cap.words.slice(1).forEach((w) => {
      const tick = document.createElement('i');
      tick.className = 'tl-tick';
      tick.style.left = `${(w.start - cap.start) * this.pps}px`;
      el.appendChild(tick);
    });
  }

  startDrag(e, cap, el) {
    e.preventDefault();
    e.stopPropagation();
    const mode = e.target.classList.contains('h-l') ? 'left' : e.target.classList.contains('h-r') ? 'right' : 'move';
    const caps = this.app.captions;
    const i = caps.indexOf(cap);
    const prev = caps[i - 1], next = caps[i + 1];
    const lo = prev ? prev.end : 0;
    const hi = next ? next.start : this.duration;
    const orig = { start: cap.start, end: cap.end, words: cap.words.map((w) => ({ ...w })) };
    const x0 = e.clientX;
    let moved = false;
    this.app.select(cap.id, false);

    const snap = (t) => (Math.abs(t - this.app.time) * this.pps < SNAP_PX ? this.app.time : t);
    const remap = (s, e2) => {
      const k = (e2 - s) / (orig.end - orig.start);
      cap.words = orig.words.map((w) => ({ ...w, start: s + (w.start - orig.start) * k, end: s + (w.end - orig.start) * k }));
    };

    const move = (ev) => {
      const dt = (ev.clientX - x0) / this.pps;
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      if (mode === 'move') {
        const len = orig.end - orig.start;
        let s = Math.max(lo, Math.min(hi - len, snap(orig.start + dt)));
        if (Math.abs(snap(s + len) - (s + len)) > 0) s = Math.max(lo, Math.min(hi - len, snap(s + len) - len));
        cap.start = s; cap.end = s + len;
        const shift = s - orig.start;
        cap.words = orig.words.map((w) => ({ ...w, start: w.start + shift, end: w.end + shift }));
      } else if (mode === 'left') {
        cap.start = Math.max(lo, Math.min(orig.end - MIN_LEN, snap(orig.start + dt)));
        remap(cap.start, cap.end);
      } else {
        cap.end = Math.min(hi, Math.max(orig.start + MIN_LEN, snap(orig.end + dt)));
        remap(cap.start, cap.end);
      }
      this.position(el, cap);
      this.app.onCaptionsChanged(false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) this.app.commit();
      else this.app.seek(cap.start + 0.001);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}
