"""Caption editor: upload a video, auto-caption it, style and adjust captions on
a timeline, then burn them into the video.

Run:  .venv/bin/python server.py   →   http://127.0.0.1:7870

The browser draws every caption state (same renderer as the live preview, so
export is pixel-identical), uploads them as transparent PNGs, and ffmpeg
overlays them at their exact times in one pass.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import webbrowser
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).parent
PROJECTS = ROOT / "projects"
LIBRARY = ROOT / "library" / "library.json"  # your dictionary + saved styles (shared by all projects)
STATIC = ROOT / "static"
CACHE = Path.home() / ".cache" / "hinglish-captions"
PORT = 7870
PEAKS_PER_SEC = 100

PROJECTS.mkdir(exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Hinglish Caption Editor")
jobs = {}  # project id -> {"state", "stage", "progress", "error"}
model_lock = threading.Lock()  # one transcription at a time (big models, one GPU)


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

def pdir(pid):
    if not re.fullmatch(r"[a-f0-9]{12}", pid):
        raise HTTPException(404, "No such project")
    d = PROJECTS / pid
    if not d.exists():
        raise HTTPException(404, "No such project")
    return d


def load_project(pid):
    return json.loads((pdir(pid) / "project.json").read_text())


def save_project(p):
    path = PROJECTS / p["id"] / "project.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(p))
    tmp.replace(path)


def source_file(pid):
    return next(pdir(pid).glob("source.*"))


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise HTTPException(400, "That file doesn't look like a video ffmpeg can read.")
    info = json.loads(out.stdout)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if v is None:
        raise HTTPException(400, "No video track found in that file.")
    w, h = int(v["width"]), int(v["height"])
    rotation = 0
    for sd in v.get("side_data_list", []):
        rotation = int(sd.get("rotation", rotation) or 0)
    rotation = int(v.get("tags", {}).get("rotate", rotation))
    if abs(rotation) % 180 == 90:  # phone videos are often stored sideways
        w, h = h, w
    num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den) if float(den) else 30.0
    return {
        "width": w, "height": h, "fps": round(fps, 3) or 30.0,
        "duration": float(info["format"].get("duration") or v.get("duration") or 0),
        "hasAudio": any(s["codec_type"] == "audio" for s in info["streams"]),
        # HLG = iPhone/Android HDR, PQ = HDR10. Captions need converting into these.
        "hdr": {"arib-std-b67": "hlg", "smpte2084": "pq"}.get(v.get("color_transfer")),
        "colorPrimaries": v.get("color_primaries"), "colorSpace": v.get("color_space"),
    }


def compute_peaks(path):
    """Loudest sample per 10 ms, read from ffmpeg in 64 KB blocks (constant memory)."""
    hop = 8000 // PEAKS_PER_SEC
    proc = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1",
         "-ar", "8000", "-f", "f32le", "-"],
        stdout=subprocess.PIPE,
    )
    peaks, leftover = [], np.zeros(0, np.float32)
    while block := proc.stdout.read(hop * 4 * 200):
        a = np.concatenate([leftover, np.frombuffer(block, np.float32)])
        n = len(a) // hop
        if n:
            peaks.append(np.abs(a[: n * hop]).reshape(n, hop).max(axis=1))
        leftover = a[n * hop:]
    proc.wait()
    if not peaks:
        return []
    peaks = np.concatenate(peaks)
    peaks = peaks / (np.percentile(peaks, 99.5) or 1)
    return np.round(np.clip(peaks, 0, 1), 3).tolist()


@app.get("/api/projects")
def list_projects():
    items = []
    for d in PROJECTS.iterdir():
        f = d / "project.json"
        if f.exists():
            p = json.loads(f.read_text())
            items.append({"id": p["id"], "name": p["name"], "created": p["created"],
                          "meta": p["meta"], "hasCaptions": bool(p.get("captions"))})
    return sorted(items, key=lambda p: -p["created"])


def finish_project(d, src, name):
    try:
        meta = probe(src)
    except HTTPException:
        shutil.rmtree(d)
        raise
    (d / "peaks.json").write_text(json.dumps(compute_peaks(src)))
    p = {"id": d.name, "name": name, "created": time.time(),
         "meta": meta, "words": None, "captions": None, "style": None}
    save_project(p)
    return p


def new_project_dir(filename):
    d = PROJECTS / uuid.uuid4().hex[:12]
    d.mkdir()
    ext = (Path(filename or "video.mp4").suffix or ".mp4").lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,5}", ext):
        ext = ".mp4"
    return d, d / f"source{ext}"


@app.post("/api/projects/upload")
async def upload_project(request: Request, name: str = "video.mp4"):
    """The editor sends the raw file as the request body; it goes straight to
    disk in chunks as it arrives, so a 4K video never sits in memory."""
    d, src = new_project_dir(name)
    try:
        with src.open("wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    return await run_in_threadpool(finish_project, d, src, Path(name).stem or "video")


@app.post("/api/projects")
def create_project(video: UploadFile = File(...)):
    """Form upload (for scripts/curl). Starlette spools it to disk first."""
    d, src = new_project_dir(video.filename)
    with src.open("wb") as f:
        shutil.copyfileobj(video.file, f, 1024 * 1024)
    return finish_project(d, src, Path(video.filename or "video").stem)


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    p = load_project(pid)
    if "hdr" not in p["meta"]:  # projects made before HDR support
        p["meta"].update({k: v for k, v in probe(source_file(pid)).items() if k in ("hdr", "colorPrimaries", "colorSpace")})
        save_project(p)
    return p


@app.put("/api/projects/{pid}")
async def update_project(pid: str, request: Request):
    p = load_project(pid)
    body = await request.json()
    for key in ("captions", "style", "name"):
        if key in body:
            p[key] = body[key]
    save_project(p)
    return {"ok": True}


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    shutil.rmtree(pdir(pid))
    return {"ok": True}


@app.get("/api/projects/{pid}/video")
def get_video(pid: str):
    return FileResponse(source_file(pid))


@app.get("/api/projects/{pid}/peaks")
def get_peaks(pid: str):
    return JSONResponse({"perSecond": PEAKS_PER_SEC,
                         "peaks": json.loads((pdir(pid) / "peaks.json").read_text())})


# ---------------------------------------------------------------------------
# Library: spelling dictionary and saved styles, shared by every project
# ---------------------------------------------------------------------------

DEFAULT_LIBRARY = {"texting": True, "rules": [], "styles": [], "defaultStyle": None}


def load_library():
    if LIBRARY.exists():
        return {**DEFAULT_LIBRARY, **json.loads(LIBRARY.read_text())}
    return dict(DEFAULT_LIBRARY)


def spelling_table():
    import spelling
    lib = load_library()
    return spelling.build_table(lib["texting"], lib["rules"])


@app.get("/api/library")
def get_library():
    import spelling
    return {**load_library(), "builtin": spelling.texting_rules()}


@app.put("/api/library")
async def update_library(request: Request):
    lib = load_library()
    body = await request.json()
    for key in DEFAULT_LIBRARY:
        if key in body:
            lib[key] = body[key]
    LIBRARY.parent.mkdir(exist_ok=True)
    tmp = LIBRARY.with_suffix(".tmp")
    tmp.write_text(json.dumps(lib, indent=1))
    tmp.replace(LIBRARY)
    return {"ok": True}


@app.post("/api/fix-spelling")
async def fix_spelling(request: Request):
    """Apply the dictionary to captions sent by the editor (so it's undo-able there)."""
    import spelling
    captions = (await request.json())["captions"]
    return spelling.fix_captions(captions, spelling_table())


# ---------------------------------------------------------------------------
# Transcription (runs in a background thread; the page polls /status)
# ---------------------------------------------------------------------------

def to_caption_json(groups):
    return [{"start": round(s, 3), "end": round(e, 3),
             "words": [{"text": w[2], "start": round(w[0], 3), "end": round(w[1], 3)} for w in g]}
            for s, e, g in groups]


def run_transcribe(pid, max_words):
    import captions as cap  # loads torch/transformers; keep server start-up fast

    job = jobs[pid]
    try:
        with model_lock:
            job.update(stage="Reading audio…", progress=0.05)
            audio = cap.load_audio(str(source_file(pid)))
            job.update(stage="Listening (first run loads the model)…", progress=0.15)
            segments = cap.transcribe(audio)
            cap.release_models(["whisper"])  # ~3 GB back before the aligner loads
            job.update(stage="Lining up every word with the audio…", progress=0.75)
            words = cap.align_words(audio, segments)
            cap.release_models(["aligner"])
            del audio
        import spelling
        words = spelling.fix_word_tuples(words, spelling_table())  # your dictionary + texting style
        p = load_project(pid)
        p["words"] = [[round(s, 3), round(e, 3), w] for s, e, w in words]
        p["captions"] = to_caption_json(cap.caption_groups(words, max_words))
        save_project(p)
        job.update(state="done", stage="Done", progress=1.0)
    except Exception as e:  # report any failure to the page instead of hanging
        job.update(state="error", error=str(e))
        cap.release_models()


@app.post("/api/projects/{pid}/transcribe")
def start_transcribe(pid: str, max_words: int = Form(4)):
    pdir(pid)
    if jobs.get(pid, {}).get("state") == "running":
        return jobs[pid]
    jobs[pid] = {"kind": "transcribe", "state": "running", "stage": "Starting…", "progress": 0}
    threading.Thread(target=run_transcribe, args=(pid, max_words), daemon=True).start()
    return jobs[pid]


@app.get("/api/projects/{pid}/status")
def job_status(pid: str):
    return jobs.get(pid, {"state": "idle"})


@app.post("/api/projects/{pid}/regroup")
def regroup(pid: str, max_words: int = Form(4)):
    import captions as cap

    p = load_project(pid)
    if not p.get("words"):
        raise HTTPException(400, "Generate captions first.")
    p["captions"] = to_caption_json(cap.caption_groups([tuple(w) for w in p["words"]], max_words))
    save_project(p)
    return p["captions"]


# ---------------------------------------------------------------------------
# Fonts
# ---------------------------------------------------------------------------

_fonts = {}


def google_fonts():
    cache = CACHE / "google-fonts-v2.json"
    if cache.exists() and time.time() - cache.stat().st_mtime < 7 * 86400:
        return json.loads(cache.read_text())
    try:
        import urllib.request
        raw = urllib.request.urlopen("https://fonts.google.com/metadata/fonts", timeout=15).read().decode()
        data = json.loads(raw[raw.index("{"):])  # tolerate an anti-JSON-hijacking prefix
        fonts = [{"family": f["family"], "category": f["category"],
                  "weights": sorted({int(k) for k in f["fonts"] if k.isdigit()}),
                  "italics": sorted({int(k[:-1]) for k in f["fonts"] if k.endswith("i")})}
                 for f in sorted(data["familyMetadataList"], key=lambda f: f.get("popularity", 9999))]
        cache.write_text(json.dumps(fonts))
        return fonts
    except Exception:
        return json.loads(cache.read_text()) if cache.exists() else []


def system_fonts():
    from fontTools.ttLib import TTCollection, TTFont

    dirs = [Path("/System/Library/Fonts"), Path("/Library/Fonts"), Path.home() / "Library/Fonts",
            Path("/usr/share/fonts"), Path.home() / ".fonts", Path("C:/Windows/Fonts")]
    families = set()
    for d in dirs:
        if not d.exists():
            continue
        for f in d.rglob("*"):
            if f.suffix.lower() not in (".ttf", ".otf", ".ttc"):
                continue
            try:
                faces = TTCollection(str(f)).fonts if f.suffix.lower() == ".ttc" else [TTFont(str(f), lazy=True)]
                for face in faces:
                    name = face["name"].getBestFamilyName()
                    if name and not name.startswith("."):  # dot-names are hidden system UI fonts
                        families.add(name)
            except Exception:
                continue
    return sorted(families, key=str.lower)


@app.get("/api/fonts")
def fonts():
    if not _fonts:
        _fonts["google"] = google_fonts()
        _fonts["system"] = system_fonts()
    return _fonts


# ---------------------------------------------------------------------------
# Export: overlay the browser-rendered caption frames with ffmpeg
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# HDR: captions are drawn in normal (SDR) colours, so for HDR videos they're
# converted into the video's HDR signal: sRGB -> linear light -> BT.2020
# colours -> HLG or PQ, with white at the broadcast "graphics white" level
# (ITU-R BT.2408: 75% HLG / 203 nits). `boost` raises caption brightness above
# that if you want them to pop like HDR highlights.
# ---------------------------------------------------------------------------

SRGB_TO_LINEAR = "if(lte(val/maxval\\,0.04045)\\,val/maxval/12.92\\,pow((val/maxval+0.055)/1.055\\,2.4))*maxval"
BT709_TO_BT2020 = ("rr=0.6274:rg=0.3293:rb=0.0433:gr=0.0691:gg=0.9195:gb=0.0114:"
                   "br=0.0164:bg=0.0880:bb=0.8956")


def hdr_encode_expr(kind, boost):
    if kind == "hlg":
        e = f"min(val/maxval*{0.26496 * boost:.6f}\\,1)"  # 0.26496 -> 75% HLG signal
        return (f"if(lte({e}\\,1/12)\\,sqrt(3*{e})\\,"
                f"0.17883277*log(12*{e}-0.28466892)+0.55991073)*maxval")
    y = f"pow(min(val/maxval*{203 * boost / 10000:.6f}\\,1)\\,0.1593017578125)"  # 203 nits -> PQ
    return f"pow((0.8359375+18.8515625*{y})/(1+18.6875*{y})\\,78.84375)*maxval"


def caption_filter(meta, offset_y, boost):
    out = f"overlay=0:{offset_y}:eof_action=repeat:shortest=1"
    if not meta.get("hdr"):
        return f"[1:v]format=rgba[c];[0:v][c]{out}:format=auto,format=yuv420p[v]"
    enc = hdr_encode_expr(meta["hdr"], boost)
    return (f"[1:v]format=rgba64le,lutrgb=r='{SRGB_TO_LINEAR}':g='{SRGB_TO_LINEAR}':b='{SRGB_TO_LINEAR}',"
            f"colorchannelmixer={BT709_TO_BT2020},lutrgb=r='{enc}':g='{enc}':b='{enc}',"
            f"scale=out_color_matrix=bt2020:out_range=tv,format=yuva444p10le[c];"
            f"[0:v][c]{out}:format=yuv420p10,format=yuv420p10le[v]")


def video_encoder(meta):
    if not meta.get("hdr"):
        return ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p"]
    trc = {"hlg": "arib-std-b67", "pq": "smpte2084"}[meta["hdr"]]
    return ["-c:v", "libx265", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
            "-x265-params", f"log-level=error:colorprim=bt2020:transfer={trc}:colormatrix=bt2020nc",
            "-color_primaries", "bt2020", "-color_trc", trc, "-colorspace", "bt2020nc"]


def run_export(pid, manifest, out_dir):
    job = jobs[pid]
    try:
        p = load_project(pid)
        meta = p["meta"]
        # Frames cover only the horizontal band captions can reach (offsetY..offsetY+H).
        W, H = manifest["width"], manifest["height"]
        offset_y = int(manifest.get("offsetY", 0))
        from PIL import Image
        Image.new("RGBA", (W, H), (0, 0, 0, 0)).save(out_dir / "blank.png")

        # ffconcat timeline: blank gaps + caption frames, each held until the next.
        lines, cursor = ["ffconcat version 1.0"], 0.0
        for fr in sorted(manifest["frames"], key=lambda f: f["start"]):
            start, end = max(fr["start"], cursor), fr["end"]
            if end - start < 0.001:
                continue
            if start - cursor > 0.0005:
                lines += ["file blank.png", f"duration {start - cursor:.4f}"]
            lines += [f"file {fr['file']}", f"duration {end - start:.4f}"]
            cursor = end
        tail = max(meta["duration"] - cursor, 0) + 1.0
        lines += ["file blank.png", f"duration {tail:.4f}", "file blank.png"]
        (out_dir / "frames.txt").write_text("\n".join(lines) + "\n")

        if "hdr" not in meta:  # projects made before HDR support
            meta.update(probe(source_file(pid)))
        boost = min(max(float(manifest.get("hdrBoost", 1.0)), 1.0), 3.8)
        overlay = caption_filter(meta, offset_y, boost)
        out = out_dir / "output.mp4"

        def ffmpeg(audio_args):
            cmd = ["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1",
                   "-i", str(source_file(pid)), "-f", "concat", "-safe", "0", "-i", str(out_dir / "frames.txt"),
                   "-filter_complex", overlay, "-map", "[v]", "-map", "0:a?",
                   *video_encoder(meta), *audio_args, "-movflags", "+faststart", str(out)]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for line in proc.stdout:
                if line.startswith("out_time_us=") and meta["duration"]:
                    try:
                        done = int(line.split("=")[1]) / 1e6
                        job["progress"] = min(0.99, done / meta["duration"])
                    except ValueError:
                        pass
            return proc.wait(), proc.stderr.read()

        job.update(stage="Burning captions into the HDR video…" if meta.get("hdr") else "Burning captions into the video…", progress=0)
        code, err = ffmpeg(["-c:a", "copy"])
        if code != 0:  # source audio can't go in an .mp4 as-is: re-encode it
            code, err = ffmpeg(["-c:a", "aac", "-b:a", "192k"])
        if code != 0:
            raise RuntimeError(err[-500:])
        for f in out_dir.glob("*.png"):
            f.unlink()
        job.update(state="done", stage="Done", progress=1.0)
    except Exception as e:
        job.update(state="error", error=str(e))


# Export happens in three steps so frames reach the disk in small batches and
# never pile up in memory (in the browser or here): start → frames… → render.

@app.post("/api/projects/{pid}/export/start")
def export_start(pid: str):
    d = pdir(pid)
    if jobs.get(pid, {}).get("state") == "running":
        raise HTTPException(409, "Something is already running for this project.")
    out_dir = d / "export"
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir()
    return {"ok": True}


@app.post("/api/projects/{pid}/export/frames")
async def export_frames(pid: str, request: Request):
    out_dir = pdir(pid) / "export"
    if not out_dir.exists():
        raise HTTPException(409, "Start the export first.")
    form = await request.form(max_files=500)
    saved = 0
    for key, value in form.multi_items():
        if key == "frames" and hasattr(value, "filename"):
            name = Path(value.filename).name
            if re.fullmatch(r"f\d+\.png", name):
                (out_dir / name).write_bytes(await value.read())
                saved += 1
    await form.close()
    return {"saved": saved}


@app.post("/api/projects/{pid}/export/render")
async def export_render(pid: str, request: Request):
    out_dir = pdir(pid) / "export"
    manifest = await request.json()
    missing = [f["file"] for f in manifest["frames"] if not (out_dir / Path(f["file"]).name).exists()]
    if missing:
        raise HTTPException(400, f"{len(missing)} caption frames never arrived; please export again.")
    jobs[pid] = {"kind": "export", "state": "running", "stage": "Preparing…", "progress": 0}
    threading.Thread(target=run_export, args=(pid, manifest, out_dir), daemon=True).start()
    return jobs[pid]


@app.get("/api/projects/{pid}/download")
def download(pid: str):
    out = pdir(pid) / "export" / "output.mp4"
    if not out.exists():
        raise HTTPException(404, "Export the video first.")
    name = load_project(pid)["name"]
    return FileResponse(out, media_type="video/mp4", filename=f"{name}-captioned.mp4")


@app.middleware("http")
async def revalidate_app_files(request: Request, call_next):
    """Make the browser check for a newer copy of the editor's own files on every
    load (cheap: unchanged files answer 304), so updates show up after a refresh."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")

if __name__ == "__main__":
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{PORT}")).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
