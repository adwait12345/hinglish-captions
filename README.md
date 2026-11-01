# Hinglish Captions

Upload a video, get word-perfect captions, style them, adjust them on a timeline, and burn them into the video, or download a plain `.srt`. Built for creators who talk in **Hinglish**: Hindi and English mixed, written in Roman script the way you'd actually type it.

```
1
00:00:06,141 --> 00:00:07,203
Aaj ka video bahut

2
00:00:07,286 --> 00:00:08,611
interesting hai to
```

- **Free and offline.** Everything runs on your own computer. There's no API key, no account and no per-minute cost, and your videos never leave your machine.
- **Made for Hinglish.** English words stay in English, and Hindi is written in Roman script ("Aaj ka video", not "आज का video").
- **Word-accurate timing.** Every word is pinned to the audio with forced alignment. In ground-truth tests, the median timing error was 18 ms.
- **Understands pauses.** Captions clear when you stop talking and flow smoothly while you speak.
- **Reel-style captions.** A slider sets 1–10 words per caption, and you can change it after the captions are made, with no re-processing.

## The caption editor

- **Any font.** All 1,900+ Google Fonts plus every font installed on your computer, searchable.
- **Cinematic styles.** These presets are for a minimal, expensive look: Editorial, Paradise, Gold accent, Film, Luxe, Whisper, Poster and Tall.
- **Accent words.** The key word in each caption can be set in a second font, usually a big serif italic or a script, and stacked on its own line. The word is picked automatically, or you can choose it by wrapping it in `*stars*`.
- **Animated captions.** The spoken word can be highlighted in colour or a box, and it can grow as it's spoken. Words can appear as they're said, and captions can fade, rise or pop in. There are social presets too: Bold Pop, Hormozi, Clean, Boxed, Karaoke and Word by word.
- **Full styling.** Size, weight, italics, case, letter spacing, colours, outline, shadow or glow, background box, line width and position. You can also drag the caption up or down right on the video.
- **Timeline.** It shows the audio waveform. Drag captions to move them, drag their edges to retime them, and split (S), merge (M), add (A) or delete them. Undo and redo work with ⌘Z and ⇧⌘Z.
- **What you see is what you get.** The preview and the export use the same renderer, so the burned-in video matches the editor pixel for pixel, in full resolution with the original audio.
- **Autosave.** Projects are saved as you work and listed on the home screen.

## How it works

1. **Transcription:** [Oriserve/Whisper-Hindi2Hinglish-Prime](https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Prime), a Whisper large-v3 model fine-tuned on Hinglish speech.
2. **Word timing:** [MMS forced aligner](https://huggingface.co/MahmoudAshraf/mms-300m-1130-forced-aligner), Meta's multilingual aligner trained on romanized text in 1,100+ languages. It's the same CTC forced-alignment technique that WhisperX uses.
3. **Caption rules:** captions break on pauses (0.35 s or more) and at sentence ends. They keep a minimum 2-frame gap (83 ms), stay up at least 0.5 s, and anything spoken too fast to read is merged with a neighbouring caption.

## Setup (macOS)

You need Python 3.10+ and ffmpeg:

```bash
brew install python ffmpeg
```

Then double-click **`Start Captions.command`**. The first run installs dependencies and opens the editor in your browser.

Or from a terminal:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python server.py                    # caption editor at http://127.0.0.1:7870
.venv/bin/python app.py                       # simple SRT-only app at http://127.0.0.1:7860
.venv/bin/python app.py my_video.mp4          # or: straight to my_video.srt
.venv/bin/python app.py my_video.mp4 2        # ...with 2 words per caption
```

Projects (your uploaded videos, captions and exports) are stored in the `projects/` folder.

**First run downloads about 7.5 GB of models** (6.2 GB transcription + 1.3 GB alignment). They're cached in `~/.cache/huggingface` and only downloaded once. On Apple Silicon, it also saves a 3 GB half-precision copy of the transcription model in `~/.cache/hinglish-captions`, which loads twice as fast with a fraction of the memory.

## Speed

On an Apple M4 with 16 GB RAM, captioning a 30-second clip takes about 30–35 seconds, and burning captions into a 14-second 1080×1920 reel takes about 10 seconds. It uses the Apple GPU (MPS) automatically and falls back to CPU elsewhere, which is much slower.

## Memory

The tool is built to stay light on a 16 GB Mac:

- **Uploads** stream straight to disk, so a 1 GB 4K file uses about 50 MB of memory.
- **Audio** is decoded to a temporary file and read in pieces, not held in RAM.
- **Models** load one at a time and are freed as soon as captioning finishes. Peak use is about 3.7 GB while transcribing, and about 0.3 GB when idle.
- **Export** sends caption frames to the server in batches of 40, so even thousands of frames never pile up in memory.

## Tips

- Skim the captions before posting. The model sometimes uses textbook spellings ("bhaarat", "vah") or mishears a word.
- Clear speech with quiet background music gives the best results.

## License

[MIT](LICENSE) for this code. The models it downloads have their own licenses; see their Hugging Face pages linked above.
