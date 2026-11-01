"""Small ffmpeg helpers shared by the captioning engine and the server."""

import json
import subprocess

# Audio formats ffmpeg can't decode. iPhones add a spatial-audio track in
# Apple's APAC format next to the normal stereo AAC one.
UNDECODABLE_AUDIO = {"apple_apac", "none", "unknown"}


def audio_stream(path):
    """Index of the audio track to use: the default one ffmpeg can decode,
    else the first decodable one. None if the file has no usable audio."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-print_format", "json",
         "-show_entries", "stream=index,codec_name:stream_disposition=default", str(path)],
        capture_output=True, text=True,
    )
    streams = [s for s in json.loads(out.stdout or "{}").get("streams", [])
               if s.get("codec_name") not in UNDECODABLE_AUDIO]
    if not streams:
        return None
    default = [s for s in streams if s.get("disposition", {}).get("default")]
    return (default or streams)[0]["index"]


def audio_map(path):
    """ffmpeg arguments that select the usable audio track (or none)."""
    idx = audio_stream(path)
    return ["-map", f"0:{idx}"] if idx is not None else []
