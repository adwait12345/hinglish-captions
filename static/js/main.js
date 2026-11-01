import { DEFAULT_STYLE, PRESETS, captionAt, captionBand, captionBox, drawCaption, exportStates, normalizeStyle, presetStyle } from './render.js';
import { fontInfo, getFonts, loadFont, nearestWeight } from './fonts.js';
import { Timeline, fmtTime } from './timeline.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const api = {
  async json(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `Request failed (${r.status})`);
    return r.json();
  },
  form(url, data) {
    const fd = new FormData();
    Object.entries(data).forEach(([k, v]) => fd.append(k, v));
    return this.json(url, { method: 'POST', body: fd });
  },
};

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// Upload with a progress callback (fetch can't report upload progress).
// `body` can be a File (sent as-is, streamed from disk) or FormData.
function xhrUpload(url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const res = JSON.parse(xhr.responseText || '{}');
      xhr.status < 300 ? resolve(res) : reject(new Error(res.detail || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(body);
  });
}

async function poll(pid, onUpdate) {
  for (;;) {
    const s = await api.json(`/api/projects/${pid}/status`);
    onUpdate(s);
    if (s.state === 'done') return s;
    if (s.state === 'error') throw new Error(s.error || 'Something went wrong');
    await new Promise((r) => setTimeout(r, 600));
  }
}

let nextId = 1;
const withIds = (caps) => caps.map((c) => ({ ...c, id: nextId++, words: c.words.map((w) => ({ ...w })) }));
const plain = (caps) => caps.map(({ start, end, words }) => ({ start, end, words }));

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const app = {
  project: null,
  captions: [],
  style: { ...DEFAULT_STYLE },
  selectedId: null,
  history: [],
  hpos: -1,
  get duration() { return this.project?.meta.duration || 0; },
  get time() { return video.currentTime || 0; },
  get playing() { return !video.paused && !video.ended; },

  seek(t) {
    video.currentTime = Math.max(0, Math.min(this.duration, t));
    timeline.setTime(video.currentTime);
    requestDraw();
  },

  select(id, scrollList = true) {
    this.selectedId = id;
    $$('.tl-cap').forEach((el) => el.classList.toggle('selected', +el.dataset.id === id));
    $$('#caption-list li').forEach((li) => li.classList.toggle('selected', +li.dataset.id === id));
    if (scrollList && id != null) $(`#caption-list li[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    updateButtons();
  },

  selected() { return this.captions.find((c) => c.id === this.selectedId) || null; },

  // Something about the captions changed. Commit = add an undo step + save.
  onCaptionsChanged(commit = true, full = false) {
    if (full) { timeline.render(); renderList(); } else refreshListTimes();
    requestDraw();
    if (commit) this.commit();
  },

  commit() {
    const snap = JSON.stringify({ captions: plain(this.captions), style: this.style });
    if (this.history[this.hpos] === snap) return;
    this.history = this.history.slice(0, this.hpos + 1);
    this.history.push(snap);
    if (this.history.length > 300) this.history.shift();
    this.hpos = this.history.length - 1;
    updateButtons();
    scheduleSave();
  },

  restore(pos) {
    if (pos < 0 || pos >= this.history.length) return;
    this.hpos = pos;
    const { captions, style } = JSON.parse(this.history[pos]);
    const sel = this.captions.findIndex((c) => c.id === this.selectedId);
    this.captions = withIds(captions);
    this.style = normalizeStyle(style);
    this.selectedId = this.captions[sel]?.id ?? null;
    syncStyleControls();
    loadFont(this.style).then(requestDraw);
    timeline.render();
    renderList();
    updateButtons();
    scheduleSave();
  },

  focusCaptionText(id) {
    switchTab('captions');
    const ta = $(`#caption-list li[data-id="${id}"] textarea`);
    ta?.focus();
    ta?.select();
  },

  onZoom(pps) { $('#zoom').value = Math.round((Math.log(pps / 15) / Math.log(800 / 15)) * 100); },
};

const video = $('#video');
const overlay = $('#overlay');
const timeline = new Timeline($('#timeline'), app);

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

let saveTimer = null;
function scheduleSave() {
  if (!app.project) return;
  $('#save-state').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api.json(`/api/projects/${app.project.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captions: app.captions.length ? plain(app.captions) : null, style: app.style, name: app.project.name }),
      });
      $('#save-state').textContent = 'All changes saved';
    } catch {
      $('#save-state').textContent = 'Not saved — is the server running?';
    }
  }, 600);
}

// ---------------------------------------------------------------------------
// Routing: home ⇄ editor
// ---------------------------------------------------------------------------

async function route() {
  const m = location.hash.match(/^#\/p\/([a-f0-9]{12})$/);
  if (m) {
    try { return await openProject(m[1]); } catch (e) { toast(e.message); location.hash = ''; }
  }
  showHome();
}
window.addEventListener('hashchange', route);

async function showHome() {
  video.pause();
  app.project = null;
  $('#editor').hidden = true;
  $('#home').hidden = false;
  const list = await api.json('/api/projects').catch(() => []);
  $('#recent').hidden = !list.length;
  $('#recent-list').replaceChildren(...list.map((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="name"></span><span class="meta"></span><button class="ghost small" title="Delete project">Delete</button>`;
    $('.name', li).textContent = p.name;
    $('.meta', li).textContent = `${p.meta.width}×${p.meta.height} · ${fmtTime(p.meta.duration, false)}${p.hasCaptions ? ' · captioned' : ''}`;
    li.onclick = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      location.hash = `#/p/${p.id}`;
    };
    $('button', li).onclick = async () => {
      if (!confirm(`Delete "${p.name}"? This removes the uploaded video and its captions.`)) return;
      await api.json(`/api/projects/${p.id}`, { method: 'DELETE' });
      showHome();
    };
    return li;
  }));
}

async function openProject(pid) {
  const p = await api.json(`/api/projects/${pid}`);
  app.project = p;
  app.captions = withIds(p.captions || []);
  app.style = normalizeStyle(p.style || {});
  app.selectedId = null;
  app.history = [JSON.stringify({ captions: plain(app.captions), style: app.style })];
  app.hpos = 0;
  $('#save-state').textContent = '';
  $('#home').hidden = true;
  $('#editor').hidden = false;
  $('#project-name').value = p.name;
  video.src = `/api/projects/${pid}/video`;
  await new Promise((r) => { video.onloadedmetadata = r; video.onerror = r; });
  fitStage();
  syncStyleControls();
  renderPresets();
  loadFont(app.style).then(requestDraw);
  const { peaks, perSecond } = await api.json(`/api/projects/${pid}/peaks`);
  timeline.setPeaks(peaks, perSecond);
  timeline.fitToView();
  showCaptionsUI();
  if (!p.captions && pollingFor !== pid) maybeResumeJob(pid);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
$('#file').addEventListener('change', (e) => e.target.files[0] && upload(e.target.files[0]));

async function upload(file) {
  const bar = $('.upload-bar', drop);
  bar.hidden = false;
  $('.drop-title', drop).textContent = `Uploading ${file.name}…`;
  try {
    // The raw file goes straight to disk on the server, chunk by chunk.
    const p = await xhrUpload(`/api/projects/upload?name=${encodeURIComponent(file.name)}`, file, (f) => {
      $('div', bar).style.width = `${f * 100}%`;
      if (f >= 1) $('.drop-title', drop).textContent = 'Reading the video…';
    });
    location.hash = `#/p/${p.id}`;
  } catch (e) {
    toast(e.message, 5000);
  } finally {
    bar.hidden = true;
    $('div', bar).style.width = '0';
    $('.drop-title', drop).textContent = 'Drop a video here, or click to choose';
    $('#file').value = '';
  }
}

// ---------------------------------------------------------------------------
// Generate captions
// ---------------------------------------------------------------------------

let pollingFor = null;

function showCaptionsUI() {
  const has = app.captions.length > 0;
  $('#generate-box').hidden = has;
  $('#caption-tools').hidden = !has;
  renderList();
  timeline.render();
  updateButtons();
  requestDraw();
}

async function maybeResumeJob(pid) {
  const s = await api.json(`/api/projects/${pid}/status`).catch(() => null);
  if (s?.state === 'running' && s.kind === 'transcribe') trackTranscription(pid);
}

$('#mw').addEventListener('input', (e) => ($('#mw-out').value = e.target.value));
$('#mw2').addEventListener('input', (e) => ($('#mw2-out').value = e.target.value));

$('#btn-generate').addEventListener('click', async () => {
  const pid = app.project.id;
  try {
    await api.form(`/api/projects/${pid}/transcribe`, { max_words: $('#mw').value });
    trackTranscription(pid);
  } catch (e) { toast(e.message, 5000); }
});

async function trackTranscription(pid) {
  pollingFor = pid;
  const box = $('#gen-progress');
  box.hidden = false;
  $('#btn-generate').disabled = true;
  try {
    await poll(pid, (s) => {
      $('.bar > div', box).style.width = `${(s.progress || 0) * 100}%`;
      $('span', box).textContent = s.stage || '';
    });
    if (app.project?.id !== pid) return;
    const p = await api.json(`/api/projects/${pid}`);
    app.captions = withIds(p.captions || []);
    app.commit();
    showCaptionsUI();
    toast(`${app.captions.length} captions ready. Press Space to play.`);
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    pollingFor = null;
    box.hidden = true;
    $('#btn-generate').disabled = false;
  }
}

$('#btn-regroup').addEventListener('click', async () => {
  try {
    const caps = await api.form(`/api/projects/${app.project.id}/regroup`, { max_words: $('#mw2').value });
    app.captions = withIds(caps);
    app.selectedId = null;
    app.onCaptionsChanged(true, true);
    toast('Captions re-split. Undo with ⌘Z if you preferred your edits.');
  } catch (e) { toast(e.message); }
});

// ---------------------------------------------------------------------------
// Caption list (left panel)
// ---------------------------------------------------------------------------

// Caption text as typed in the list: words wrapped in *stars* are accents.
const captionText = (cap) => cap.words.map((w) => (w.em ? `*${w.text}*` : w.text)).join(' ');
const plainText = (cap) => cap.words.map((w) => w.text).join(' ');

function setCaptionText(cap, text) {
  const tokens = wordsFromText(text);
  if (!tokens.length) return;
  if (tokens.length === cap.words.length) {
    tokens.forEach((t, i) => { cap.words[i].text = t.text; cap.words[i].em = !!t.em; });
    return;
  }
  // Word count changed: share the caption's time out by word length.
  const weights = tokens.map((t) => t.text.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = cap.start;
  cap.words = tokens.map((tok, i) => {
    const d = ((cap.end - cap.start) * weights[i]) / total;
    const w = { text: tok.text, start: t, end: t + d, ...(tok.em ? { em: true } : {}) };
    t += d;
    return w;
  });
}

function renderList() {
  const list = $('#caption-list');
  list.replaceChildren(...app.captions.map((cap) => {
    const li = document.createElement('li');
    li.dataset.id = cap.id;
    li.className = cap.id === app.selectedId ? 'selected' : '';
    li.innerHTML = '<div class="ts"></div><textarea rows="1" spellcheck="false"></textarea>';
    $('.ts', li).textContent = `${fmtTime(cap.start)} – ${fmtTime(cap.end)}`;
    $('.ts', li).onclick = () => { app.select(cap.id, false); app.seek(cap.start + 0.001); timeline.scrollToTime(cap.start); };
    const ta = $('textarea', li);
    ta.value = captionText(cap);
    ta.addEventListener('focus', () => { app.select(cap.id, false); if (!app.playing) app.seek(cap.start + 0.001); timeline.scrollToTime(cap.start); });
    ta.addEventListener('input', () => {
      setCaptionText(cap, ta.value);
      $(`.tl-cap[data-id="${cap.id}"] .tl-text`).textContent = plainText(cap);
      requestDraw();
    });
    ta.addEventListener('change', () => { ta.value = captionText(cap); app.onCaptionsChanged(true, true); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ta.blur(); } });
    return li;
  }));
}

function refreshListTimes() {
  app.captions.forEach((cap) => {
    const ts = $(`#caption-list li[data-id="${cap.id}"] .ts`);
    if (ts) ts.textContent = `${fmtTime(cap.start)} – ${fmtTime(cap.end)}`;
  });
}

// ---------------------------------------------------------------------------
// Timeline actions
// ---------------------------------------------------------------------------

function targetCaption() {
  return app.selected() || captionAt(app.captions, app.time);
}

function splitCaption() {
  const t = app.time;
  const cap = captionAt(app.captions, t) || app.selected();
  if (!cap || t <= cap.start || t >= cap.end) return toast('Put the playhead inside a caption to split it.');
  let left = cap.words.filter((w) => w.start < t);
  let right = cap.words.filter((w) => w.start >= t);
  if (!left.length || !right.length) {
    if (cap.words.length < 2) return toast('A one-word caption can’t be split.');
    const mid = Math.ceil(cap.words.length / 2);
    left = cap.words.slice(0, mid); right = cap.words.slice(mid);
  }
  const at = right[0].start > cap.start && right[0].start < cap.end ? Math.max(t, left.at(-1).start + 0.05) : t;
  const i = app.captions.indexOf(cap);
  const a = { id: nextId++, start: cap.start, end: Math.min(at, right[0].start), words: left };
  const b = { id: nextId++, start: Math.min(at, right[0].start), end: cap.end, words: right };
  app.captions.splice(i, 1, a, b);
  app.selectedId = b.id;
  app.onCaptionsChanged(true, true);
}

function mergeCaption() {
  const cap = targetCaption();
  const i = app.captions.indexOf(cap);
  const next = app.captions[i + 1];
  if (!cap || !next) return toast('Select a caption that has another one after it.');
  cap.words = [...cap.words, ...next.words];
  cap.end = next.end;
  app.captions.splice(i + 1, 1);
  app.selectedId = cap.id;
  app.onCaptionsChanged(true, true);
}

function deleteCaption() {
  const cap = targetCaption();
  if (!cap) return;
  const i = app.captions.indexOf(cap);
  app.captions.splice(i, 1);
  app.selectedId = app.captions[i]?.id ?? app.captions[i - 1]?.id ?? null;
  app.onCaptionsChanged(true, true);
}

function addCaption() {
  const t = app.time;
  if (captionAt(app.captions, t)) return toast('There’s already a caption here. Move the playhead to an empty spot.');
  const next = app.captions.find((c) => c.start > t);
  const end = Math.min(t + 1.5, next ? next.start : app.duration);
  if (end - t < 0.2) return toast('Not enough room here for a new caption.');
  const cap = { id: nextId++, start: t, end, words: [] };
  setCaptionText(cap, 'New caption');
  app.captions.push(cap);
  app.captions.sort((a, b) => a.start - b.start);
  app.selectedId = cap.id;
  app.onCaptionsChanged(true, true);
  app.focusCaptionText(cap.id);
}

$('#btn-split').onclick = splitCaption;
$('#btn-merge').onclick = mergeCaption;
$('#btn-delete').onclick = deleteCaption;
$('#btn-add').onclick = addCaption;
$('#btn-undo').onclick = () => app.restore(app.hpos - 1);
$('#btn-redo').onclick = () => app.restore(app.hpos + 1);
$('#btn-fit').onclick = () => timeline.fitToView();
$('#zoom').addEventListener('input', (e) => timeline.zoomAt(15 * (800 / 15) ** (e.target.value / 100)));

function updateButtons() {
  const has = app.captions.length > 0;
  $('#btn-undo').disabled = app.hpos <= 0;
  $('#btn-redo').disabled = app.hpos >= app.history.length - 1;
  ['#btn-split', '#btn-merge', '#btn-delete'].forEach((s) => ($(s).disabled = !has));
  $('#btn-export').disabled = !has;
  $('#btn-srt').disabled = !has;
}

// ---------------------------------------------------------------------------
// Playback + preview
// ---------------------------------------------------------------------------

let box = { x: 0, y: 0, w: 0, h: 0 };
function fitStage() {
  const stage = $('#stage');
  const sw = stage.clientWidth - 32, sh = stage.clientHeight - 32;
  const W = video.videoWidth || app.project?.meta.width || 16, H = video.videoHeight || app.project?.meta.height || 9;
  const k = Math.min(sw / W, sh / H);
  box = { w: Math.round(W * k), h: Math.round(H * k) };
  box.x = Math.round((stage.clientWidth - box.w) / 2);
  box.y = Math.round((stage.clientHeight - box.h) / 2);
  for (const el of [video, overlay]) Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(box.w * dpr);
  overlay.height = Math.round(box.h * dpr);
  requestDraw();
}
new ResizeObserver(() => app.project && fitStage()).observe($('#stage'));

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

let lastNow = null;
function draw() {
  drawQueued = false;
  if (!app.project) return;
  const W = video.videoWidth || app.project.meta.width, H = video.videoHeight || app.project.meta.height;
  const ctx = overlay.getContext('2d');
  ctx.setTransform(overlay.width / W, 0, 0, overlay.height / H, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const t = app.time;
  const cap = captionAt(app.captions, t);
  drawCaption(ctx, W, H, cap, t, app.style);

  $('#time').textContent = `${fmtTime(t)} / ${fmtTime(app.duration)}`;
  timeline.setTime(t);
  const nowId = cap?.id ?? null;
  if (nowId !== lastNow) {
    lastNow = nowId;
    $$('.tl-cap.now, #caption-list li.now').forEach((el) => el.classList.remove('now'));
    if (nowId != null) {
      $(`.tl-cap[data-id="${nowId}"]`)?.classList.add('now');
      const li = $(`#caption-list li[data-id="${nowId}"]`);
      li?.classList.add('now');
      if (app.playing && document.activeElement?.tagName !== 'TEXTAREA') li?.scrollIntoView({ block: 'nearest' });
    }
  }
  if (app.playing) requestDraw();
}

function togglePlay() {
  if (!app.project) return;
  if (app.playing) video.pause(); else video.play();
}
video.addEventListener('play', () => { $('#btn-play').textContent = '❚❚'; requestDraw(); });
video.addEventListener('pause', () => { $('#btn-play').textContent = '▶'; requestDraw(); });
video.addEventListener('seeked', requestDraw);
$('#btn-play').onclick = togglePlay;

// Click the video to play/pause; drag the caption itself to move it up or down.
overlay.addEventListener('pointermove', (e) => {
  if (overlay.classList.contains('grabbing')) return;
  overlay.classList.toggle('grab', hitCaption(e));
});
overlay.addEventListener('pointerdown', (e) => {
  if (!hitCaption(e)) return togglePlay();
  e.preventDefault();
  overlay.setPointerCapture(e.pointerId);
  overlay.classList.add('grabbing');
  const y0 = e.clientY, p0 = app.style.positionY;
  const move = (ev) => {
    app.style.positionY = Math.max(5, Math.min(95, p0 + ((ev.clientY - y0) / box.h) * 100));
    syncStyleControls();
    requestDraw();
  };
  const up = () => {
    overlay.removeEventListener('pointermove', move);
    overlay.removeEventListener('pointerup', up);
    overlay.classList.remove('grabbing');
    app.commit();
  };
  overlay.addEventListener('pointermove', move);
  overlay.addEventListener('pointerup', up);
});

function hitCaption(e) {
  const cap = captionAt(app.captions, app.time);
  if (!cap || !cap.words.length) return false;
  const W = video.videoWidth, H = video.videoHeight;
  const r = overlay.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
  const b = captionBox(overlay.getContext('2d'), W, H, cap, app.style);
  const pad = Math.min(W, H) * 0.03;
  return x > b.left - pad && x < b.right + pad && y > b.top - pad && y < b.bottom + pad;
}

// ---------------------------------------------------------------------------
// Style panel
// ---------------------------------------------------------------------------

const pct = (v) => `${Math.round(v * 100)}%`;
const fmt = {
  fontSize: (v) => (+v).toFixed(1), activeScale: pct, strokeWidth: (v) => v,
  shadowOpacity: pct, bgOpacity: pct, emScale: (v) => `${(+v).toFixed(2)}×`,
  letterSpacing: (v) => (+v).toFixed(2), emLetterSpacing: (v) => (+v).toFixed(2),
  positionY: (v) => `${Math.round(v)}%`, maxWidth: (v) => `${v}%`, lineHeight: (v) => (+v).toFixed(2),
  shadowBlur: (v) => v, shadowOffset: (v) => v, bgRadius: (v) => v,
};

// Which style keys each font button / weight list controls.
const FONT_KEYS = {
  base: { family: 'fontFamily', source: 'fontSource', weight: 'fontWeight', italic: 'fontItalic' },
  accent: { family: 'emFontFamily', source: 'emFontSource', weight: 'emFontWeight', italic: 'emItalic' },
};

function syncStyleControls() {
  const s = app.style;
  $$('.tab-body [data-k]').forEach((el) => {
    const k = el.dataset.k;
    if (el.classList.contains('seg')) $$('button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === String(s[k])));
    else if (el.type === 'checkbox') el.checked = !!s[k];
    else if (el.tagName !== 'SELECT') el.value = s[k];
  });
  $$('[data-o]').forEach((o) => (o.value = (fmt[o.dataset.o] || String)(s[o.dataset.o])));
  $$('[data-show], [data-hide]').forEach((el) => {
    const rule = el.dataset.show ?? el.dataset.hide;
    const [k, v] = rule.split('=');
    const match = v ? String(s[k]) === v : !!s[k];
    el.hidden = el.dataset.show !== undefined ? !match : match;
  });
  $$('.font-btn').forEach((btn) => {
    const keys = FONT_KEYS[btn.dataset.font];
    const fn = $('.font-name', btn);
    fn.textContent = s[keys.family];
    Object.assign(fn.style, { fontFamily: `"${s[keys.family]}", sans-serif`, fontWeight: s[keys.weight], fontStyle: s[keys.italic] ? 'italic' : 'normal' });
  });
  syncWeights();
}

const WEIGHT_NAMES = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' };
async function syncWeights() {
  const s = app.style;
  for (const keys of Object.values(FONT_KEYS)) {
    const { weights } = await fontInfo(s[keys.family], s[keys.source]);
    const sel = $(`select[data-k="${keys.weight}"]`);
    sel.replaceChildren(...weights.map((w) => new Option(`${WEIGHT_NAMES[w] || w} ${w}`, w)));
    sel.value = s[keys.weight];
  }
}

function setStyle(patch, commit = true) {
  Object.assign(app.style, patch);
  syncStyleControls();
  requestDraw();
  if (commit) app.commit();
}

$$('.tab-body [data-k]').forEach((el) => {
  const k = el.dataset.k;
  const fontChange = /Weight|Italic|^emphasis$/.test(k); // these may need a new font file
  const apply = (v, commit = true) => {
    setStyle({ [k]: v }, commit);
    if (fontChange) loadFont(app.style).then(requestDraw);
  };
  if (el.classList.contains('seg')) {
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) apply(b.dataset.v); });
  } else if (el.type === 'checkbox') {
    el.addEventListener('change', () => apply(el.checked));
  } else if (el.type === 'range' || el.type === 'color') {
    el.addEventListener('input', () => apply(el.type === 'range' ? +el.value : el.value, false));
    el.addEventListener('change', () => app.commit());
  } else if (el.tagName === 'SELECT') {
    el.addEventListener('change', () => apply(el.dataset.num !== undefined ? +el.value : el.value));
  }
});

function renderPresets() {
  for (const wrap of $$('.presets')) {
    if (wrap.children.length) continue;
    const group = wrap.dataset.group;
    Object.entries(PRESETS).filter(([, p]) => (p.group || 'cinematic') === group).forEach(([name, p]) => {
      const b = document.createElement('button');
      b.className = `preset ${group}`;
      b.title = name;
      b.innerHTML = '<canvas width="240" height="128"></canvas><span></span>';
      $('span', b).textContent = name;
      b.onclick = async () => {
        const style = presetStyle(name, app.style);
        await loadFont(style);
        setStyle(style);
      };
      wrap.appendChild(b);
      const ps = presetStyle(name, DEFAULT_STYLE);
      loadFont(ps).then(() => drawPreset($('canvas', b), p.sample || `${name} Aa`, ps));
    });
  }
}

// Sample text: words in *stars* are accents.
function wordsFromText(text) {
  return text.split(/\s+/).filter(Boolean).map((t) => {
    const m = t.match(/^\*(.+)\*$/);
    return m ? { text: m[1], em: true } : { text: t };
  });
}

function drawPreset(canvas, sample, style) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const words = wordsFromText(sample);
  const s = { ...style, positionY: 50, maxWidth: 92, fontSize: style.fontSize * 2.1, animation: 'none', display: 'full' };
  const cap = { start: 0, end: 9, words: words.map((w, i) => ({ ...w, start: i * 0.1, end: 9 })) };
  // Highlight the second-to-last word so highlight styles show off.
  drawCaption(ctx, W, H, cap, Math.max(0, words.length - 2) * 0.1 + 0.01, s);
}

// Font picker (shared by the text font and the accent font)
const fontPop = $('#font-pop');
let fontFilter = 'all';
let fontTarget = 'base';
$$('.font-btn').forEach((btn) => btn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!fontPop.hidden && fontTarget === btn.dataset.font) return (fontPop.hidden = true);
  fontTarget = btn.dataset.font;
  const r = btn.getBoundingClientRect();
  Object.assign(fontPop.style, { left: `${r.left}px`, top: `${Math.max(8, Math.min(r.bottom + 6, innerHeight - 430))}px` });
  fontPop.hidden = false;
  $('#font-search').value = '';
  $('#font-search').focus();
  renderFontList();
}));
document.addEventListener('pointerdown', (e) => { if (!fontPop.hidden && !fontPop.contains(e.target) && !e.target.closest('.font-btn')) fontPop.hidden = true; });
$('#font-search').addEventListener('input', renderFontList);
$('#font-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  fontFilter = b.dataset.v;
  $$('#font-filter button').forEach((x) => x.classList.toggle('on', x === b));
  renderFontList();
});

async function renderFontList() {
  const { google, system } = await getFonts();
  const current = app.style[FONT_KEYS[fontTarget].family];
  const q = $('#font-search').value.trim().toLowerCase();
  let items = [];
  if (fontFilter !== 'google') items.push(...system.map((f) => ({ family: f, source: 'system', tag: 'On this Mac' })));
  if (fontFilter !== 'system') items.push(...google.map((f) => ({ family: f.family, source: 'google', tag: f.category })));
  if (fontFilter === 'all' && !q) items.sort((a, b) => (a.source === b.source ? 0 : a.source === 'google' ? -1 : 1));
  if (q) items = items.filter((f) => f.family.toLowerCase().includes(q))
    .sort((a, b) => a.family.toLowerCase().indexOf(q) - b.family.toLowerCase().indexOf(q));
  const LIMIT = 250;
  const list = $('#font-list');
  list.replaceChildren(...items.slice(0, LIMIT).map((f) => {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><small></small>';
    $('span', li).textContent = f.family;
    $('small', li).textContent = f.tag;
    if (f.source === 'system') $('span', li).style.fontFamily = `"${f.family}", system-ui`;
    if (f.family === current) li.className = 'cur';
    li.onclick = () => chooseFont(f);
    return li;
  }));
  if (items.length > LIMIT) {
    const more = document.createElement('li');
    more.className = 'more';
    more.textContent = `${items.length - LIMIT} more — type to search`;
    list.appendChild(more);
  }
  if (!items.length) list.innerHTML = '<li class="more">No fonts match</li>';
}

async function chooseFont(f) {
  fontPop.hidden = true;
  const keys = FONT_KEYS[fontTarget];
  const info = await fontInfo(f.family, f.source);
  const next = {
    [keys.family]: f.family, [keys.source]: f.source,
    [keys.weight]: nearestWeight(info.weights, app.style[keys.weight]),
    [keys.italic]: app.style[keys.italic] && info.italics.length > 0, // keep italic only if the font has it
  };
  await loadFont({ ...app.style, ...next });
  setStyle(next);
}

// Tabs
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-body').forEach((b) => (b.hidden = b.dataset.tab !== name));
}
$$('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

// ---------------------------------------------------------------------------
// Export: SRT + burned-in video
// ---------------------------------------------------------------------------

function srtTime(t) {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

$('#btn-srt').onclick = () => {
  const srt = app.captions.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${plainText(c)}\n`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([srt], { type: 'application/x-subrip' }));
  a.download = `${app.project.name}.srt`;
  a.click();
  URL.revokeObjectURL(a.href);
};

$('#btn-export').onclick = async () => {
  const dlg = $('#export-dlg');
  const stage = $('#export-stage'), bar = $('#export-bar'), dl = $('#export-download');
  const setP = (text, f) => { stage.textContent = text; bar.style.width = `${f * 100}%`; };
  dl.hidden = true;
  $('#export-close').textContent = 'Cancel';
  dlg.showModal();
  video.pause();
  const pid = app.project.id;
  try {
    await loadFont(app.style);
    const { width: W, height: H, fps } = app.project.meta;
    const states = exportStates(app.captions, app.style, fps || 30);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const band = captionBand(ctx, W, H, app.captions, app.style);
    canvas.width = W; canvas.height = band.height;
    // Draw and send frames in small batches, so only a few images are ever
    // held in memory at once (long or 4K videos can have thousands).
    const BATCH = 40;
    await api.json(`/api/projects/${pid}/export/start`, { method: 'POST' });
    const frames = [];
    let batch = new FormData(), inBatch = 0;
    const flush = async () => {
      if (!inBatch) return;
      await api.json(`/api/projects/${pid}/export/frames`, { method: 'POST', body: batch });
      batch = new FormData();
      inBatch = 0;
    };
    for (let i = 0; i < states.length; i++) {
      if (!dlg.open) return;
      const s = states[i];
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, band.height);
      ctx.translate(0, -band.top);
      drawCaption(ctx, W, H, s.cap, s.t, app.style);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const name = `f${String(i).padStart(6, '0')}.png`;
      batch.append('frames', blob, name);
      inBatch++;
      frames.push({ file: name, start: s.start, end: s.end });
      if (inBatch >= BATCH) await flush();
      if (i % 5 === 0) setP(`Drawing captions… ${i + 1} / ${states.length}`, (i / states.length) * 0.4);
    }
    await flush();
    await api.json(`/api/projects/${pid}/export/render`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width: W, height: band.height, offsetY: band.top, frames }),
    });
    await poll(pid, (s) => setP(s.stage || 'Rendering…', 0.4 + (s.progress || 0) * 0.6));
    setP('Done! Your captioned video is ready.', 1);
    dl.href = `/api/projects/${pid}/download?t=${Date.now()}`;
    dl.hidden = false;
    $('#export-close').textContent = 'Close';
  } catch (e) {
    setP(`Export failed: ${e.message}`, 0);
    $('#export-close').textContent = 'Close';
  }
};
$('#export-close').onclick = () => $('#export-dlg').close();

// ---------------------------------------------------------------------------
// Misc wiring
// ---------------------------------------------------------------------------

$('#btn-home').onclick = () => { location.hash = ''; };
$('#project-name').addEventListener('change', (e) => {
  app.project.name = e.target.value.trim() || app.project.name;
  e.target.value = app.project.name;
  scheduleSave();
});

document.addEventListener('keydown', (e) => {
  if (!app.project || $('#export-dlg').open) return;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && document.activeElement.type !== 'range';
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    return e.shiftKey ? app.restore(app.hpos + 1) : app.restore(app.hpos - 1);
  }
  if (typing || mod) return;
  const actions = {
    ' ': togglePlay, s: splitCaption, m: mergeCaption, a: addCaption,
    Delete: deleteCaption, Backspace: deleteCaption,
    ArrowLeft: () => app.seek(app.time - (e.shiftKey ? 1 : 1 / 30)),
    ArrowRight: () => app.seek(app.time + (e.shiftKey ? 1 : 1 / 30)),
  };
  const fn = actions[e.key] || actions[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});

route();
