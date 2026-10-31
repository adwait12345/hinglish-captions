# Hinglish Captions

Upload a video, get a ready-to-use `.srt` subtitle file. Built for creators who talk in **Hinglish**: Hindi and English mixed, written in Roman script the way you'd actually type it.

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

## How it works

1. **Transcription:** [Oriserve/Whisper-Hindi2Hinglish-Prime](https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Prime), a Whisper large-v3 model fine-tuned on Hinglish speech.
2. **Word timing:** [MMS forced aligner](https://huggingface.co/MahmoudAshraf/mms-300m-1130-forced-aligner), Meta's multilingual aligner trained on romanized text in 1,100+ languages. It's the same CTC forced-alignment technique that WhisperX uses.
3. **Caption rules:** captions break on pauses (0.35 s or more) and at sentence ends. They keep a minimum 2-frame gap (83 ms), stay up at least 0.5 s, and anything spoken too fast to read is merged with a neighbouring caption.

## Setup (macOS)

You need Python 3.10+ and ffmpeg:

```bash
brew install python ffmpeg
```

Then double-click **`Start Captions.command`**. The first run installs dependencies and opens the app in your browser.

Or from a terminal:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py                       # web app at http://127.0.0.1:7860
.venv/bin/python app.py my_video.mp4          # or: straight to my_video.srt
.venv/bin/python app.py my_video.mp4 2        # ...with 2 words per caption
```

**First run downloads about 7.5 GB of models** (6.2 GB transcription + 1.3 GB alignment). They're cached in `~/.cache/huggingface` and only downloaded once.

## Speed

On an Apple M4 with 16 GB RAM, a 30-second clip takes about 30–35 seconds. It uses the Apple GPU (MPS) automatically and falls back to CPU elsewhere, which is much slower.

## Tips

- Skim the captions before posting. The model sometimes uses textbook spellings ("bhaarat", "vah") or mishears a word.
- Clear speech with quiet background music gives the best results.

## License

[MIT](LICENSE) for this code. The models it downloads have their own licenses; see their Hugging Face pages linked above.
