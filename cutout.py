"""Mattes for "captions behind the subject", made with macOS's own Vision
framework (the engine behind Portrait mode and "lift subject from background").

The matte is a greyscale video the size of the source (white = subject),
written frame by frame, so memory stays flat however long the video is.
"""

import subprocess
import tempfile

import Foundation
import numpy as np
import objc
import Quartz
import Vision
from PIL import Image

MAX_SIDE = 1080  # matte's shorter side; the export scales it up smoothly
MIN_OVERLAP = 0.15  # below this the object we were following has left the frame


def matte_size(w, h):
    k = min(1.0, MAX_SIDE / min(w, h))
    return int(round(w * k / 2)) * 2, int(round(h * k / 2)) * 2


def _cgimage(rgb):
    h, w, _ = rgb.shape
    # NSData owns the pixels, so they're freed with the image (a plain Python
    # buffer handed to CoreGraphics is never released: ~8 MB leaked per frame).
    data = Foundation.NSData.dataWithBytes_length_(np.dstack([rgb, np.full((h, w), 255, np.uint8)]).tobytes(), w * h * 4)
    provider = Quartz.CGDataProviderCreateWithCFData(data)
    return Quartz.CGImageCreate(w, h, 8, 32, w * 4, Quartz.CGColorSpaceCreateDeviceRGB(),
                                Quartz.kCGImageAlphaNoneSkipLast, provider, None, False,
                                Quartz.kCGRenderingIntentDefault)


# Colour management off, so 8-bit values (like object labels) come through exactly.
_ci = Quartz.CIContext.contextWithOptions_({Quartz.kCIContextWorkingColorSpace: None,
                                            Quartz.kCIContextOutputColorSpace: None,
                                            Quartz.kCIContextCacheIntermediates: False})


def _pixels(buffer):
    """A Vision mask (CVPixelBuffer) as an 8-bit numpy array. Copied out through
    CoreImage: locking the buffer and reading it directly leaks it (~8 MB/frame)."""
    w, h = Quartz.CVPixelBufferGetWidth(buffer), Quartz.CVPixelBufferGetHeight(buffer)
    out = bytearray(w * h)
    _ci.render_toBitmap_rowBytes_bounds_format_colorSpace_(
        Quartz.CIImage.imageWithCVPixelBuffer_(buffer), out, w, ((0, 0), (w, h)), Quartz.kCIFormatL8, None)
    return np.frombuffer(out, np.uint8).reshape(h, w)


def _frames(path, size, fps):
    """The video's frames as RGB arrays, at a constant fps so matte frame n
    always lines up with time n / fps."""
    w, h = size
    cmd = ["ffmpeg", "-v", "error", "-i", str(path),
           "-vf", f"fps={fps},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        while len(buf := proc.stdout.read(w * h * 3)) == w * h * 3:
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        proc.kill()
        proc.wait()


class PersonMatte:
    """Every person in the frame, with hair-level edges."""

    def __init__(self):
        self.request = Vision.VNGeneratePersonSegmentationRequest.alloc().initWithCompletionHandler_(None)
        self.request.setQualityLevel_(Vision.VNGeneratePersonSegmentationRequestQualityLevelAccurate)

    def __call__(self, rgb):
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(_cgimage(rgb), None)
        handler.performRequests_error_([self.request], None)
        results = self.request.results()
        if not results:
            return np.zeros(rgb.shape[:2], np.uint8)
        m = _pixels(results[0].pixelBuffer())
        return np.asarray(Image.fromarray(m).resize((rgb.shape[1], rgb.shape[0]), Image.BILINEAR))


def _instances(request, rgb):
    """Vision's "lift subject": a low-res map labelling each separate object."""
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(_cgimage(rgb), None)
    handler.performRequests_error_([request], None)
    results = request.results()
    if not results:
        return None, None, None
    return handler, results[0], _pixels(results[0].instanceMask())


def _clicked_label(labels, x, y):
    """The object under (x, y), fractions of the frame; a near miss still counts."""
    if not labels.any():
        raise ValueError("Couldn't find a distinct object at that moment. Try Person, or another moment.")
    h, w = labels.shape
    px, py = min(int(x * w), w - 1), min(int(y * h), h - 1)
    if labels[py, px]:
        return int(labels[py, px])
    ys, xs = np.nonzero(labels)
    i = np.argmin((ys - py) ** 2 + (xs - px) ** 2)
    if (ys[i] - py) ** 2 + (xs[i] - px) ** 2 > (0.08 * max(w, h)) ** 2:
        raise ValueError("Nothing to cut out there — click right on the person or object.")
    return int(labels[ys[i], xs[i]])


def _follow(maps, start, label, step):
    """Labels of the clicked object in each frame from `start` onwards (step ±1),
    matched to the previous sighting by overlap; 0 where it's out of shot."""
    chosen = {}
    prev = maps[start] == label
    i = start + step
    while 0 <= i < len(maps):
        best, score = 0, 0.0
        for cand in np.unique(maps[i][maps[i] > 0]):
            mine = maps[i] == cand
            iou = (mine & prev).sum() / max((mine | prev).sum(), 1)
            if iou > score:
                best, score = int(cand), iou
        if score >= MIN_OVERLAP:
            chosen[i] = best
            prev = maps[i] == best
        i += step
    return chosen


def _check_click(path, size, click, request):
    w, h = size
    frame = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{click['t']:.3f}", "-i", str(path), "-frames:v", "1",
                            "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           capture_output=True).stdout
    if len(frame) != w * h * 3:
        return  # couldn't grab it on its own; the full pass will check
    with objc.autorelease_pool():
        _, _, labels = _instances(request, np.frombuffer(frame, np.uint8).reshape(h, w, 3))
    _clicked_label(labels if labels is not None else np.zeros((8, 8), np.uint8), click["x"], click["y"])


def _object_masks(path, size, fps, total, click, on_progress):
    """Two passes: label every frame (small maps, kept on disk), follow the
    clicked object out from the click both ways, then render its full mask."""
    request = Vision.VNGenerateForegroundInstanceMaskRequest.alloc().initWithCompletionHandler_(None)
    _check_click(path, size, click, request)  # a missed click fails now, not after a full pass
    with tempfile.TemporaryFile() as store:
        shape = None
        for i, rgb in enumerate(_frames(path, size, fps)):
            with objc.autorelease_pool():
                _, _, labels = _instances(request, rgb)
            shape = shape or (labels.shape if labels is not None else (512, 512))
            store.write((labels if labels is not None else np.zeros(shape, np.uint8)).tobytes())
            if on_progress and i % 10 == 0:
                on_progress(min(i / total, 1) * 0.5)
        store.flush()
        maps = np.memmap(store, np.uint8, "r", shape=(store.tell() // (shape[0] * shape[1]), *shape))
        k = min(int(round(click["t"] * fps)), len(maps) - 1)
        label = _clicked_label(maps[k], click["x"], click["y"])
        chosen = {k: label, **_follow(maps, k, label, 1), **_follow(maps, k, label, -1)}
        del maps

    blank = np.zeros(size[::-1], np.uint8)
    for i, rgb in enumerate(_frames(path, size, fps)):
        if i not in chosen:
            yield blank
            continue
        with objc.autorelease_pool():
            handler, result, _ = _instances(request, rgb)
            index = Foundation.NSIndexSet.indexSetWithIndex_(chosen[i])
            buffer, _ = result.generateScaledMaskForImageForInstances_fromRequestHandler_error_(index, handler, None)
            m = _pixels(buffer)
        yield m if m.shape[::-1] == size else np.asarray(Image.fromarray(m).resize(size, Image.BILINEAR))
        if on_progress and i % 10 == 0:
            on_progress(0.5 + min(i / total, 0.99) * 0.5)


def _person_masks(path, size, fps, total, on_progress):
    matte = PersonMatte()
    for i, rgb in enumerate(_frames(path, size, fps)):
        with objc.autorelease_pool():  # Vision's buffers are freed every frame
            yield matte(rgb)
        if on_progress and i % 10 == 0:
            on_progress(min(i / total, 0.99))


def make_matte(path, out, meta, mode, click=None, on_progress=None):
    """Write the matte video for `path` to `out`: one frame per source frame."""
    size = matte_size(meta["width"], meta["height"])
    fps = meta.get("fps") or 30
    total = max(int(meta["duration"] * fps), 1)
    masks = (_person_masks(path, size, fps, total, on_progress) if mode == "person"
             else _object_masks(path, size, fps, total, click, on_progress))
    enc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{size[0]}x{size[1]}",
         "-r", str(fps), "-i", "-", "-c:v", "libx264", "-preset", "fast", "-crf", "16",
         "-g", str(int(fps)), "-pix_fmt", "yuv420p", "-color_range", "pc", "-movflags", "+faststart", str(out)],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for m in masks:
            enc.stdin.write(m.tobytes())
        enc.stdin.close()
        if enc.wait() != 0:
            raise RuntimeError(enc.stderr.read().decode()[-400:])
    except BaseException:
        enc.kill()
        raise
