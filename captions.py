"""Core captioning engine: Hinglish transcription, word alignment, caption rules.

Shared by the simple SRT app (app.py) and the caption editor (server.py).
Runs fully offline using Oriserve's Whisper model fine-tuned for Hinglish
(Hindi + English written in Roman script), plus Meta's MMS forced aligner to
pin every word to the exact moment it is spoken.
"""

import subprocess
from pathlib import Path

import numpy as np
import torch
from transformers import pipeline

MODEL_ID = "Oriserve/Whisper-Hindi2Hinglish-Prime"  # best-quality Hinglish model (6 GB)
ALIGN_MODEL_ID = "MahmoudAshraf/mms-300m-1130-forced-aligner"  # word timing (1.3 GB)
DEFAULT_WORDS_PER_CAPTION = 4  # short, punchy reel-style captions
MAX_CHARS_PER_CAPTION = 30  # never wider than one short line on a phone

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
_pipes = {}


def get_pipe(model_id):
    if model_id not in _pipes:
        _pipes[model_id] = pipeline(
            "automatic-speech-recognition",
            model=model_id,
            device=DEVICE,
            dtype=torch.float16 if DEVICE == "mps" else torch.float32,
        )
    return _pipes[model_id]


def load_audio(path):
    """Pull the audio track out of any video/audio file as 16 kHz mono floats."""
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
         "-f", "f32le", "-loglevel", "error", "-"],
        capture_output=True,
    )
    if out.returncode != 0:
        raise ValueError("Couldn't read audio from that file: " + out.stderr.decode()[-300:])
    return np.frombuffer(out.stdout, np.float32)


def speech_regions(audio, sr=16000, frame=0.02, min_gap=0.3, max_len=20.0):
    """Find where someone is talking by cutting the audio at pauses.

    These Hinglish models don't return reliable timestamps, so instead we
    transcribe each spoken stretch on its own and use its real start/end time.
    """
    hop = int(sr * frame)
    n = len(audio) // hop
    if n == 0:
        return []
    rms = np.sqrt(np.mean(audio[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    loud = db > max(np.percentile(db, 95) - 30, -55)

    regions, start, quiet = [], None, 0
    for i, is_loud in enumerate(loud):
        if is_loud:
            if start is None:
                start = i
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet * frame >= min_gap:
                regions.append([start, i - quiet + 1])
                start, quiet = None, 0
    if start is not None:
        regions.append([start, n - quiet])

    # Drop tiny blips, merge regions that are very close together, and
    # pad edges slightly so we don't clip the first/last syllable.
    merged = []
    for s, e in regions:
        s, e = s * frame, e * frame
        if merged and s - merged[-1][1] < 0.15 and e - merged[-1][0] <= max_len:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    total = len(audio) / sr
    out = []
    for s, e in merged:
        if e - s < 0.25:
            continue
        s, e = max(0.0, s - 0.1), min(total, e + 0.1)
        # Whisper only hears 30s at a time, so hard-split anything too long.
        while e - s > max_len:
            out.append((s, s + max_len))
            s += max_len
        out.append((s, e))
    return out


def transcribe(audio, model_id=MODEL_ID):
    sr = 16000
    regions = speech_regions(audio, sr)
    if not regions:
        return []
    results = get_pipe(model_id)(
        [{"raw": audio[int(s * sr): int(e * sr)], "sampling_rate": sr} for s, e in regions],
        generate_kwargs={"task": "transcribe", "num_beams": 1},  # greedy: same text in our tests, ~2x faster
    )
    return [
        (s, e, r["text"].strip())
        for (s, e), r in zip(regions, results)
        if r["text"].strip()
    ]


# ---------------------------------------------------------------------------
# Word-level forced alignment
#
# Whisper tells us *what* was said; this tells us exactly *when* each word was
# said. Meta's MMS aligner was trained on 1,100+ languages written in Roman
# letters, so it fits Roman-script Hinglish and English alike. It's the same
# CTC forced-alignment technique WhisperX and pro subtitle tools use.
# ---------------------------------------------------------------------------

END_CORRECTION = 0.1  # seconds; see align_words
_aligner = {}


def get_aligner():
    if not _aligner:
        from transformers import AutoProcessor, Wav2Vec2ForCTC
        _aligner["proc"] = AutoProcessor.from_pretrained(ALIGN_MODEL_ID)
        _aligner["model"] = Wav2Vec2ForCTC.from_pretrained(ALIGN_MODEL_ID).to(DEVICE).eval()
        _aligner["vocab"] = _aligner["proc"].tokenizer.get_vocab()
    return _aligner


def ctc_viterbi(log_probs, tokens, blank=0):
    """Best path of `tokens` through CTC log-probs. Returns (first, last) frame per token."""
    T = log_probs.shape[0]
    ext = [blank]
    for t in tokens:
        ext += [t, blank]
    S = len(ext)
    ext = np.array(ext)
    emit = log_probs[:, ext]  # T x S
    skip_ok = np.zeros(S, bool)
    skip_ok[2:] = (ext[2:] != blank) & (ext[2:] != ext[:-2])

    NEG = -1e30
    dp = np.full(S, NEG)
    dp[0], dp[1] = emit[0, 0], emit[0, 1]
    back = np.zeros((T, S), np.int8)  # 0 = stay, 1 = from s-1, 2 = from s-2
    for t in range(1, T):
        stay = dp
        prev1 = np.concatenate(([NEG], dp[:-1]))
        prev2 = np.where(skip_ok, np.concatenate(([NEG, NEG], dp[:-2])), NEG)
        stacked = np.stack([stay, prev1, prev2])
        choice = stacked.argmax(0)
        dp = stacked[choice, np.arange(S)] + emit[t]
        back[t] = choice

    s = S - 1 if dp[S - 1] >= dp[S - 2] else S - 2
    spans = [[None, None] for _ in tokens]
    for t in range(T - 1, -1, -1):
        if s % 2 == 1:  # a real character, not blank
            k = s // 2
            spans[k][0] = t
            if spans[k][1] is None:
                spans[k][1] = t
        s -= int(back[t, s])
    return spans


def align_words(audio, segments, sr=16000):
    """Return [(start, end, word)] with each word pinned to the audio."""
    a = get_aligner()
    words_out = []
    for seg_start, seg_end, text in segments:
        words = text.split()
        chunk = audio[int(seg_start * sr): int(seg_end * sr)]
        # Letters the aligner knows, per word (numbers/symbols have none).
        letters = [[a["vocab"][c] for c in w.lower() if c in a["vocab"] and c.isalpha() or c == "'"]
                   for w in words]
        tokens = [t for w in letters for t in w]

        timed = [None] * len(words)
        inputs = a["proc"](chunk, sampling_rate=sr, return_tensors="pt").input_values.to(DEVICE)
        with torch.inference_mode():
            log_probs = torch.log_softmax(a["model"](inputs).logits[0].float(), -1).cpu().numpy()
        T = log_probs.shape[0]
        if tokens and T >= 2 * len(tokens):
            spans = ctc_viterbi(log_probs, tokens)
            sec_per_frame = len(chunk) / sr / T
            i = 0
            for wi, w in enumerate(letters):
                if w:
                    first, last = spans[i][0], spans[i + len(w) - 1][1]
                    timed[wi] = (seg_start + first * sec_per_frame,
                                 seg_start + (last + 1) * sec_per_frame)
                    i += len(w)

        # Words we couldn't pin (e.g. "4", "%") get the gap between neighbours.
        for wi in range(len(words)):
            if timed[wi] is None:
                prev_end = next((timed[j][1] for j in range(wi - 1, -1, -1) if timed[j]), seg_start)
                nxt = next((j for j in range(wi + 1, len(words)) if timed[j]), None)
                next_start = timed[nxt][0] if nxt is not None else seg_end
                timed[wi] = (prev_end, max(prev_end + 0.05, next_start))
        # CTC marks the *peak* of a word's last sound, not where it fades out;
        # in ground-truth tests ends came out ~100 ms early, so nudge them back.
        for wi, (s, e) in enumerate(timed):
            cap = timed[wi + 1][0] - 0.01 if wi + 1 < len(timed) else seg_end
            timed[wi] = (s, max(e, min(e + END_CORRECTION, cap)))
        words_out += [(s, e, w) for (s, e), w in zip(timed, words)]
    return words_out


# ---------------------------------------------------------------------------
# Caption building, following common broadcast/streaming subtitle rules
# ---------------------------------------------------------------------------

PAUSE_BREAK = 0.35  # a silence this long always starts a new caption
MIN_GAP = 0.083  # 2 frames @ 24fps: minimum blank between captions
CLOSE_GAP = 0.5  # gaps shorter than this are closed up to avoid flicker
MIN_DURATION = 0.5  # nobody can read a caption that flashes by faster
MIN_READABLE = 0.3  # spoken faster than this? merge with a neighbour
LINGER = 0.2  # keep the last words up briefly after they're spoken


def build_captions(words, max_words=DEFAULT_WORDS_PER_CAPTION):
    """[(start, end, text)] captions."""
    return [(s, e, " ".join(w[2] for w in g)) for s, e, g in caption_groups(words, max_words)]


def caption_groups(words, max_words=DEFAULT_WORDS_PER_CAPTION):
    """[(start, end, [word, ...])] captions, keeping each word's own timing."""
    max_words = int(max_words)

    # 1. Phrases: break on real pauses and at the end of sentences.
    phrases, cur = [], []
    for i, w in enumerate(words):
        if cur and (w[0] - cur[-1][1] >= PAUSE_BREAK or cur[-1][2][-1] in ".?!"):
            phrases.append(cur)
            cur = []
        cur.append(w)
    if cur:
        phrases.append(cur)

    # 2. Split each phrase into evenly sized captions (no lonely last word).
    caps = []
    for ph in phrases:
        n = -(-len(ph) // max_words)
        while True:
            bounds = [round(i * len(ph) / n) for i in range(n + 1)]
            groups = [ph[a:b] for a, b in zip(bounds, bounds[1:])]
            if n >= len(ph) or all(len(" ".join(x[2] for x in g)) <= MAX_CHARS_PER_CAPTION for g in groups):
                break
            n += 1
        # Words said too quickly to read get merged into a neighbouring caption.
        while len(groups) > 1:
            dur = [g[-1][1] - g[0][0] for g in groups]
            i = int(np.argmin(dur))
            if dur[i] >= MIN_READABLE:
                break
            j = i - 1 if i == len(groups) - 1 or (i > 0 and dur[i - 1] < dur[i + 1]) else i + 1
            a, b = sorted((i, j))
            groups[a:b + 1] = [groups[a] + groups[b]]
        caps += [[g[0][0], g[-1][1], g] for g in groups]

    # 3. Timing polish: linger, minimum duration, and gap rules.
    for i, c in enumerate(caps):
        nxt = caps[i + 1] if i + 1 < len(caps) else None
        paused = nxt is not None and nxt[0] - c[1] >= PAUSE_BREAK  # speaker really stopped
        limit = nxt[0] - MIN_GAP if nxt else c[1] + 1.0
        c[1] = min(max(c[1] + LINGER, c[0] + MIN_DURATION), max(limit, c[1]))
        # During continuous speech, chain captions so they don't flicker;
        # at a real pause, let the screen go blank like the speaker did.
        if nxt and not paused and nxt[0] - c[1] < CLOSE_GAP:
            c[1] = max(c[1], nxt[0] - MIN_GAP)
        if nxt:  # always leave the 2-frame gap players need to switch cleanly
            c[1] = max(c[0] + 0.1, min(c[1], nxt[0] - MIN_GAP))
    return [tuple(c) for c in caps]


def srt_time(seconds):
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def to_srt(captions):
    return "\n".join(
        f"{i}\n{srt_time(s)} --> {srt_time(e)}\n{text}\n"
        for i, (s, e, text) in enumerate(captions, 1)
    )


def cli(video_path, max_words=DEFAULT_WORDS_PER_CAPTION):
    audio = load_audio(video_path)
    srt = to_srt(build_captions(align_words(audio, transcribe(audio)), max_words))
    out = Path(video_path).with_suffix(".srt")
    out.write_text(srt, encoding="utf-8")
    print(srt)
    print(f"Saved {out}")
