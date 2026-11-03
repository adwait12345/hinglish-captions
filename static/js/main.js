import { DEFAULT_STYLE, PRESETS, captionAt, captionBand, captionBox, drawCaption, exportStates, normalizeStyle, presetStyle } from './render.js?v=10';
import { fontInfo, getFonts, loadFont, nearestWeight } from './fonts.js?v=10';
import { Timeline, fmtTime } from './timeline.js?v=10';

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

function toast(msg, ms = 2600, action = null) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'primary small';
    b.textContent = action.label;
    b.onclick = () => { t.hidden = true; action.run(); };
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// In-page yes/no question. (Browser pop-ups like confirm()/prompt() are
// silently blocked in some windows, which made buttons look dead.)
function ask(message, yes = 'OK') {
  const dlg = $('#ask-dlg');
  $('#ask-msg').textContent = message;
  $('#ask-yes').textContent = yes;
  dlg.showModal();
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); $('#ask-yes').onclick = $('#ask-no').onclick = dlg.oncancel = null; resolve(v); };
    $('#ask-yes').onclick = () => done(true);
    $('#ask-no').onclick = () => done(false);
    dlg.oncancel = () => done(false);
  });
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

async function poll(pid, onUpdate, kind = '') {
  for (;;) {
    const s = await api.json(`/api/projects/${pid}/status${kind ? `?kind=${kind}` : ''}`);
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
const matte = $('#matte'); // the cut-out (white = subject), played in step with the video
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
  app.library ??= await api.json('/api/library').catch(() => ({ texting: true, rules: [], styles: [], defaultStyle: null, builtin: [] }));
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
      if (!await ask(`Delete "${p.name}"?\nThis removes the uploaded video and its captions.`, 'Delete')) return;
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
  app.style = normalizeStyle(p.style || defaultStyle() || {});
  app.selectedId = null;
  app.history = [JSON.stringify({ captions: plain(app.captions), style: app.style })];
  app.hpos = 0;
  $('#save-state').textContent = '';
  $('#home').hidden = true;
  $('#editor').hidden = false;
  $('#project-name').value = p.name;
  $('#hdr-field').hidden = $('#hdr-badge').hidden = $('#btn-hdr-preview').hidden = !p.meta.hdr;
  video.src = `/api/projects/${pid}/video`;
  loadMatte(p.cutout);
  await new Promise((r) => { video.onloadedmetadata = r; video.onerror = r; });
  fitStage();
  syncStyleControls();
  renderPresets();
  renderMyStyles();
  renderDictionary();
  loadFont(app.style).then(requestDraw);
  const { peaks, perSecond } = await api.json(`/api/projects/${pid}/peaks`);
  timeline.setPeaks(peaks, perSecond);
  timeline.fitToView();
  showCaptionsUI();
  if (!p.captions && pollingFor !== pid) maybeResumeJob(pid);
  const cut = await api.json(`/api/projects/${pid}/status?kind=cutout`).catch(() => null);
  if (cut?.state === 'running' && cuttingFor !== pid) trackCutout(pid);
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
  const box = app.captions.length ? $('#regen-progress') : $('#gen-progress');
  box.hidden = false;
  $('#btn-generate').disabled = $('#btn-retranscribe').disabled = true;
  try {
    await poll(pid, (s) => {
      $('.bar > div', box).style.width = `${(s.progress || 0) * 100}%`;
      $('span', box).textContent = s.stage || '';
    });
    if (app.project?.id !== pid) return;
    const p = await api.json(`/api/projects/${pid}`);
    app.captions = withIds(p.captions || []);
    app.selectedId = null;
    app.commit(); // the old captions stay one ⌘Z away
    showCaptionsUI();
    toast(`${app.captions.length} captions ready. Press Space to play.`);
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    pollingFor = null;
    box.hidden = true;
    $('#btn-generate').disabled = $('#btn-retranscribe').disabled = false;
  }
}

$('#btn-retranscribe').addEventListener('click', async () => {
  if (!await ask('Listen to the video again and replace all captions?\nYour current captions stay available with Undo (⌘Z).', 'Re-transcribe')) return;
  const pid = app.project.id;
  try {
    await api.form(`/api/projects/${pid}/transcribe`, { max_words: $('#mw2').value });
    trackTranscription(pid);
  } catch (e) { toast(e.message, 5000); }
});

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
    ta.addEventListener('focus', () => { ta.dataset.before = JSON.stringify(cap.words.map((w) => w.text)); app.select(cap.id, false); if (!app.playing) app.seek(cap.start + 0.001); timeline.scrollToTime(cap.start); });
    ta.addEventListener('input', () => {
      setCaptionText(cap, ta.value);
      $(`.tl-cap[data-id="${cap.id}"] .tl-text`).textContent = plainText(cap);
      requestDraw();
    });
    ta.addEventListener('change', () => {
      ta.value = captionText(cap);
      app.onCaptionsChanged(true, true);
      offerToLearn(JSON.parse(ta.dataset.before || '[]'), cap.words.map((w) => w.text));
    });
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
  if (cap && app.style.behindSubject) cutCaptionsBehindSubject(ctx, W, H, cap);

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
video.addEventListener('play', () => { $('#btn-play').textContent = '❚❚'; syncMatte(true); requestDraw(); });
video.addEventListener('pause', () => { $('#btn-play').textContent = '▶'; syncMatte(true); requestDraw(); });
video.addEventListener('seeked', () => { syncMatte(true); requestDraw(); });
$('#btn-play').onclick = togglePlay;

// Click the video to play/pause; drag the caption itself to move it up or down.
overlay.addEventListener('pointermove', (e) => {
  if (overlay.classList.contains('grabbing')) return;
  overlay.classList.toggle('grab', hitCaption(e));
});
overlay.addEventListener('pointerdown', (e) => {
  if (overlay.classList.contains('picking')) return pickObject(e);
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
// Behind subject: a matte video from the server (white = person/object). The
// preview erases caption pixels wherever the matte is white, so the real video
// (HDR and all) shows through; the export pastes the subject back on top.
// ---------------------------------------------------------------------------

app.cutout = null;
let cuttingFor = null;

function loadMatte(cutout) {
  app.cutout = cutout || null;
  if (cutout) matte.src = `/api/projects/${app.project.id}/matte.mp4?v=${cutout.version}`;
  else matte.removeAttribute('src');
  matte.load();
  updateCutoutUI();
  requestDraw();
}
matte.addEventListener('loadeddata', () => { syncMatte(true); requestDraw(); });
matte.addEventListener('seeked', requestDraw);

// Keep the matte on the video's frame: follow play/pause/seek, and jump back
// in step if it ever drifts by more than a couple of frames while playing.
function syncMatte(force = false) {
  if (!app.cutout || matte.readyState < 1 || (matte.seeking && !force)) return;
  const drift = Math.abs(matte.currentTime - video.currentTime);
  if (force || drift > 0.08) matte.currentTime = video.currentTime;
  if (app.playing && matte.paused) matte.play().catch(() => {});
  if (!app.playing && !matte.paused) matte.pause();
}

const cutCanvas = document.createElement('canvas');
function cutCaptionsBehindSubject(ctx, W, H, cap) {
  if (!app.cutout || matte.readyState < 2) return;
  if (app.playing) syncMatte();
  // Only the rows the caption (plus its glow) covers.
  const b = captionBox(ctx, W, H, cap, app.style);
  const pad = Math.min(W, H) * 0.06 + (app.style.shadowBlur || 0) * 2;
  const top = Math.max(0, b.top - pad), bottom = Math.min(H, b.bottom + pad);
  if (bottom <= top) return;
  const k = overlay.height / H;
  const y = Math.floor(top * k), h = Math.ceil((bottom - top) * k), w = overlay.width;
  cutCanvas.width = w; cutCanvas.height = h;
  const c = cutCanvas.getContext('2d', { willReadFrequently: true });
  const mk = matte.videoHeight / H;
  c.drawImage(matte, 0, top * mk, matte.videoWidth, (bottom - top) * mk, 0, 0, w, h);
  const img = c.getImageData(0, 0, w, h);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) px[i + 3] = px[i]; // brightness → see-through
  c.putImageData(img, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(cutCanvas, 0, y);
  ctx.restore();
}

function updateCutoutUI() {
  const st = $('#cutout-status');
  const what = { person: 'Person', object: 'the object you picked' }[app.cutout?.mode];
  st.textContent = app.cutout
    ? `✓ Cut-out ready: ${what}. Captions go behind it in the preview and the export.`
    : 'Choose what stays in front of the captions. It\'s worked out on your Mac (about 3 s per second of video).';
  st.classList.toggle('ready', !!app.cutout);
  $('#btn-cut-remove').hidden = !app.cutout;
}

async function startCutout(body) {
  const pid = app.project.id;
  try {
    await api.json(`/api/projects/${pid}/cutout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    trackCutout(pid);
  } catch (e) { toast(e.message, 5000); }
}

async function trackCutout(pid) {
  cuttingFor = pid;
  const box = $('#cutout-progress');
  box.hidden = false;
  $('#btn-cut-person').disabled = $('#btn-cut-object').disabled = true;
  try {
    const s = await poll(pid, (st) => {
      $('.bar > div', box).style.width = `${(st.progress || 0) * 100}%`;
      $('span', box).textContent = st.stage || '';
    }, 'cutout');
    if (app.project?.id !== pid) return;
    loadMatte(s.cutout);
    if (!app.style.behindSubject) { app.style.behindSubject = true; syncStyleControls(); app.commit(); }
    toast('Cut-out ready. Captions now pass behind it.');
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    cuttingFor = null;
    box.hidden = true;
    $('#btn-cut-person').disabled = $('#btn-cut-object').disabled = false;
  }
}

$('#btn-cut-person').onclick = () => startCutout({ mode: 'person' });

$('#btn-cut-object').onclick = () => {
  video.pause();
  overlay.classList.add('picking');
  toast('Click the person or object that should stay in front of the captions. Esc to cancel.', 6000);
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlay.classList.contains('picking')) overlay.classList.remove('picking');
});

function pickObject(e) {
  e.preventDefault();
  overlay.classList.remove('picking');
  const r = overlay.getBoundingClientRect();
  startCutout({ mode: 'object', t: app.time, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
}

$('#btn-cut-remove').onclick = async () => {
  if (!await ask('Remove the cut-out? Captions will sit on top of everything again.', 'Remove')) return;
  await api.json(`/api/projects/${app.project.id}/cutout`, { method: 'DELETE' });
  loadMatte(null);
};

// ---------------------------------------------------------------------------
// Style panel
// ---------------------------------------------------------------------------

const pct = (v) => `${Math.round(v * 100)}%`;
const fmt = {
  fontSize: (v) => (+v).toFixed(1), activeScale: pct, strokeWidth: (v) => v,
  shadowOpacity: pct, bgOpacity: pct, emScale: (v) => `${(+v).toFixed(2)}×`,
  letterSpacing: (v) => (+v).toFixed(2), emLetterSpacing: (v) => (+v).toFixed(2),
  positionY: (v) => `${Math.round(v)}%`, maxWidth: (v) => `${v}%`, lineHeight: (v) => (+v).toFixed(2),
  shadowBlur: (v) => v, shadowOffset: (v) => v, bgRadius: (v) => v, hdrBoost: pct,
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
  if (commit) renderMyStyles();
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

// ---------------------------------------------------------------------------
// Library: spelling dictionary + my saved styles (shared by all projects)
// ---------------------------------------------------------------------------

async function saveLibrary(patch) {
  Object.assign(app.library, patch);
  await api.json('/api/library', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
}

const core = (t) => t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

function renderDictionary() {
  const lib = app.library;
  $('#dict-texting').checked = lib.texting;
  $('#dict-list').replaceChildren(...lib.rules.map((r, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="from"></span><span class="arrow">→</span><span class="to"></span><button title="Remove">×</button>';
    $('.from', li).textContent = r.from;
    $('.to', li).textContent = r.to;
    $('button', li).onclick = async () => {
      await saveLibrary({ rules: lib.rules.filter((_, j) => j !== i) });
      renderDictionary();
    };
    return li;
  }));
  $('#dict-builtin').replaceChildren(...(lib.builtin || []).map((r) => {
    const li = document.createElement('li');
    li.textContent = `${r.from} → ${r.to}`;
    return li;
  }));
}

async function addRule(from, to) {
  from = from.trim(); to = to.trim();
  if (!from || !to || from.toLowerCase() === to.toLowerCase() && from === to) return;
  const rules = app.library.rules.filter((r) => r.from.toLowerCase() !== from.toLowerCase());
  await saveLibrary({ rules: [...rules, { from, to }] });
  renderDictionary();
}

$('#dict-texting').addEventListener('change', (e) => saveLibrary({ texting: e.target.checked }));
$('#dict-show-builtin').addEventListener('click', (e) => {
  e.preventDefault();
  const list = $('#dict-builtin');
  list.hidden = !list.hidden;
  e.target.textContent = list.hidden ? 'See all' : 'Hide';
});
$('#dict-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  await addRule($('#dict-from').value, $('#dict-to').value);
  $('#dict-from').value = $('#dict-to').value = '';
  $('#dict-from').focus();
});
$('#dict-apply').addEventListener('click', async () => {
  if (!app.captions.length) return toast('Generate captions first.');
  const fixed = await api.json('/api/fix-spelling', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ captions: plain(app.captions) }),
  });
  let changed = 0;
  fixed.forEach((c, i) => {
    const cap = app.captions[i];
    changed += c.words.filter((w, j) => w.text !== cap.words[j]?.text).length + Math.abs(c.words.length - cap.words.length);
    cap.words = c.words;
  });
  app.onCaptionsChanged(true, true);
  toast(changed ? `Fixed ${changed} word${changed > 1 ? 's' : ''}. Undo with ⌘Z.` : 'Nothing to fix. Spelling already matches your dictionary.');
});

// After you correct words in a caption, offer to always fix them that way.
function offerToLearn(before, after) {
  if (before.length !== after.length) return;
  const known = new Set(app.library.rules.map((r) => r.from.toLowerCase()));
  const pairs = before.map((b, i) => [core(b), core(after[i])])
    .filter(([b, a]) => b && a && b !== a && b.toLowerCase() !== a.toLowerCase() || (b !== a && /[A-Z]/.test(a.slice(1))))
    .filter(([b]) => !known.has(b.toLowerCase()));
  if (!pairs.length || pairs.length > 2) return;
  const label = pairs.map(([b, a]) => `“${b}” → “${a}”`).join(', ');
  toast(`Always write ${label}?`, 8000, {
    label: 'Always',
    run: async () => {
      for (const [b, a] of pairs) {
        // A capital that's only there because the word starts a sentence isn't part of the rule.
        const sentenceCap = /^\p{Lu}/u.test(b) && a.slice(1) === a.slice(1).toLowerCase();
        await addRule(b.toLowerCase(), sentenceCap ? a.toLowerCase() : a);
      }
      toast('Added to your dictionary. New videos will use it.');
    },
  });
}

// --- My styles ---------------------------------------------------------------
function defaultStyle() {
  const lib = app.library;
  return lib?.styles.find((x) => x.name === lib.defaultStyle)?.style || null;
}

const sameStyle = (a, b) => JSON.stringify(normalizeStyle(a)) === JSON.stringify(normalizeStyle(b));

function renderMyStyles(flashName = null) {
  const wrap = $('#my-styles');
  const lib = app.library;
  $('#my-styles-empty').hidden = lib.styles.length > 0;
  $('#my-styles-help').hidden = lib.styles.length === 0;
  $('.tab[data-tab="saved"]').textContent = lib.styles.length ? `My styles (${lib.styles.length})` : 'My styles';
  wrap.replaceChildren(...lib.styles.map((entry) => {
    const isDefault = entry.name === lib.defaultStyle;
    const item = document.createElement('div');
    item.className = 'saved-item' + (sameStyle(entry.style, app.style) ? ' applied' : '');
    item.innerHTML = `<canvas width="208" height="112"></canvas>
      <div class="info"><div class="name"></div><div class="meta"></div></div>
      <div class="acts"><button class="star" title="Use for every new video">★</button><button class="del" title="Delete">×</button></div>`;
    $('.name', item).textContent = entry.name;
    const st = normalizeStyle(entry.style);
    $('.meta', item).innerHTML = '';
    $('.meta', item).append(isDefault ? Object.assign(document.createElement('span'), { className: 'badge', textContent: 'DEFAULT · ' }) : '',
      `${st.fontFamily}${st.emphasis !== 'off' ? ` + ${st.emFontFamily}` : ''}`);
    $('.star', item).classList.toggle('on', isDefault);
    item.onclick = async (e) => {
      if (e.target.closest('.acts')) return;
      const style = normalizeStyle(entry.style);
      await loadFont(style);
      setStyle(style);
      renderMyStyles();
      toast(`Applied “${entry.name}”.`);
    };
    $('.star', item).onclick = async () => {
      await saveLibrary({ defaultStyle: isDefault ? null : entry.name });
      renderMyStyles();
      toast(isDefault ? 'No default style now.' : `Every new video will start in “${entry.name}”.`);
    };
    $('.del', item).onclick = async () => {
      if (!await ask(`Delete the style “${entry.name}”?`, 'Delete')) return;
      await saveLibrary({ styles: lib.styles.filter((x) => x !== entry), defaultStyle: isDefault ? null : lib.defaultStyle });
      renderMyStyles();
    };
    loadFont(st).then(() => drawPreset($('canvas', item), st.emphasis !== 'off' ? 'my *style*' : 'Aa caption', st));
    if (entry.name === flashName) requestAnimationFrame(() => item.animate(
      [{ boxShadow: '0 0 0 3px #7c5cff' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1400 }));
    return item;
  }));
}

$('#goto-saved').addEventListener('click', () => {
  switchTab('saved');
  $('#save-style-name').focus();
});

$('#save-style-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#save-style-name').value.trim();
  if (!name) return;
  const existing = app.library.styles.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (existing && !await ask(`You already have a style called “${existing.name}”. Replace it with the current look?`, 'Replace')) return;
  const entry = { name: existing?.name || name, style: { ...app.style } };
  const styles = existing ? app.library.styles.map((x) => (x === existing ? entry : x)) : [...app.library.styles, entry];
  try {
    await saveLibrary({ styles });
  } catch (err) {
    return toast(`Couldn’t save: ${err.message}`, 5000);
  }
  $('#save-style-name').value = '';
  renderMyStyles(entry.name);
  toast(`Saved “${entry.name}”. Tap ★ to use it for every new video.`, 4000);
});

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

// Draw every caption state as a transparent PNG (same renderer as the preview),
// send them in small batches, and have the server burn them in with ffmpeg.
// `clip` = { start, duration } renders just that stretch (for the HDR preview).
async function renderVideo({ target, clip = null, isCancelled, onProgress }) {
  const pid = app.project.id;
  await loadFont(app.style);
  const { width: W, height: H, fps } = app.project.meta;
  let states = exportStates(app.captions, app.style, fps || 30);
  if (clip) {
    const end = clip.start + clip.duration;
    states = states.filter((s) => s.end > clip.start && s.start < end)
      .map((s) => ({ ...s, start: Math.max(s.start, clip.start) - clip.start, end: Math.min(s.end, end) - clip.start }));
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const band = captionBand(ctx, W, H, app.captions, app.style);
  canvas.width = W; canvas.height = band.height;
  // Small batches, so only a few images are ever held in memory at once
  // (long or 4K videos can have thousands).
  const BATCH = 40;
  const q = `?target=${target}`;
  await api.json(`/api/projects/${pid}/export/start${q}`, { method: 'POST' });
  const frames = [];
  let batch = new FormData(), inBatch = 0;
  const flush = async () => {
    if (!inBatch) return;
    await api.json(`/api/projects/${pid}/export/frames${q}`, { method: 'POST', body: batch });
    batch = new FormData();
    inBatch = 0;
  };
  for (let i = 0; i < states.length; i++) {
    if (isCancelled()) return false;
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
    if (i % 5 === 0) onProgress(`Drawing captions… ${i + 1} / ${states.length}`, (i / states.length) * 0.4);
  }
  await flush();
  await api.json(`/api/projects/${pid}/export/render${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      width: W, height: band.height, offsetY: band.top, frames, hdrBoost: app.style.hdrBoost,
      behind: !!(app.style.behindSubject && app.cutout), ...(clip || {}),
    }),
  });
  await poll(pid, (st) => onProgress(st.stage || 'Rendering…', 0.4 + (st.progress || 0) * 0.6));
  return true;
}

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
    const done = await renderVideo({ target: 'export', isCancelled: () => !dlg.open, onProgress: setP });
    if (!done) return;
    setP('Done! Your captioned video is ready.', 1);
    dl.href = `/api/projects/${pid}/download?t=${Date.now()}`;
    dl.hidden = false;
    $('#export-close').textContent = 'Close';
  } catch (e) {
    setP(`Export failed: ${e.message}`, 0);
    $('#export-close').textContent = 'Close';
  }
};

// HDR preview: browsers can't draw HDR captions on a canvas, but they can play
// HDR video. So render ~4 s around the playhead through the real export
// pipeline and play that: exactly what the export will look like.
const PREVIEW_SECONDS = 4;
$('#btn-hdr-preview').onclick = async () => {
  if (!app.captions.length) return toast('Generate captions first.');
  const dlg = $('#hdr-dlg');
  const player = $('#hdr-player');
  const status = $('#hdr-status');
  player.removeAttribute('src');
  player.load();
  player.hidden = true;
  $('#hdr-screen').hidden = matchMedia('(dynamic-range: high)').matches;
  dlg.showModal();
  video.pause();
  const start = Math.max(0, Math.min(app.time - 0.5, app.duration - PREVIEW_SECONDS));
  const clip = { start, duration: Math.min(PREVIEW_SECONDS, app.duration - start) };
  try {
    const done = await renderVideo({
      target: 'preview', clip, isCancelled: () => !dlg.open,
      onProgress: (text, f) => { status.textContent = `${text} (${Math.round(f * 100)}%)`; },
    });
    if (!done) return;
    status.textContent = `HDR preview of ${fmtTime(clip.start, false)}–${fmtTime(clip.start + clip.duration, false)}, exactly as it will export.`;
    player.src = `/api/projects/${app.project.id}/preview.mp4?t=${Date.now()}`;
    player.hidden = false;
    player.play().catch(() => {});
  } catch (e) {
    status.textContent = `Preview failed: ${e.message}`;
  }
};
$('#hdr-close').onclick = () => { $('#hdr-player').pause(); $('#hdr-dlg').close(); };
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
