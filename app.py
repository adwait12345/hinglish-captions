"""Simple Hinglish caption maker: upload a video, get a downloadable .srt file.

For the full editor with burned-in captions, run server.py instead.
"""

import sys
import tempfile
from pathlib import Path

import gradio as gr

from captions import (DEFAULT_WORDS_PER_CAPTION, align_words, build_captions, cli,
                      load_audio, to_srt, transcribe)

def build_srt(words, max_words, video_path):
    srt = to_srt(build_captions(words, max_words))
    out_path = Path(tempfile.mkdtemp()) / (Path(video_path).stem + ".srt")
    out_path.write_text(srt, encoding="utf-8")
    return srt, str(out_path)


def make_captions(video_path, max_words, progress=gr.Progress()):
    if not video_path:
        raise gr.Error("Upload a video first.")
    progress(0.1, desc="Extracting audio…")
    try:
        audio = load_audio(video_path)
    except ValueError as e:
        raise gr.Error(str(e))
    progress(0.3, desc="Listening (first run loads the model, so it takes longer)…")
    segments = transcribe(audio)
    progress(0.8, desc="Lining up every word with the audio…")
    words = align_words(audio, segments)
    return (*build_srt(words, max_words, video_path), words)


def resplit(words, max_words, video_path):
    """Slider moved: re-cut the captions instantly, no need to listen again."""
    if not words or not video_path:
        return gr.skip(), gr.skip()
    return build_srt(words, max_words, video_path)


with gr.Blocks(title="Hinglish Captions") as demo:
    gr.Markdown("# Hinglish Captions\nUpload a video → get a ready-to-use `.srt` file.")
    with gr.Row():
        with gr.Column():
            video = gr.Video(label="Your video", sources=["upload"])
            max_words = gr.Slider(
                1, 10, value=DEFAULT_WORDS_PER_CAPTION, step=1,
                label="Max words per caption",
                info="Fewer words = shorter captions that change more often. "
                     "You can change this after captions are made.",
            )
            go = gr.Button("Make captions", variant="primary")
        with gr.Column():
            srt_file = gr.File(label="Download .srt")
            preview = gr.Textbox(label="Preview", lines=18)
    words_state = gr.State()
    go.click(make_captions, [video, max_words], [preview, srt_file, words_state])
    max_words.release(resplit, [words_state, max_words, video], [preview, srt_file])

if __name__ == "__main__":
    if len(sys.argv) > 1:
        cli(*sys.argv[1:])
    else:
        demo.launch(inbrowser=True)
