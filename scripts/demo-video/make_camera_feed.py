"""Fake camera feed for the demo recording: food photos glide in, pause in front of the
'camera', and glide out, like a conveyor. Written as MJPEG (concatenated JPEGs, 30 fps),
which Chrome accepts for --use-file-for-fake-video-capture."""
import sys
from pathlib import Path
from PIL import Image, ImageFilter, ImageOps

samples, out = Path(sys.argv[1]), Path(sys.argv[2])
W, H, FPS = 720, 1280, 30
ITEMS = ["hotdog", "pizza", "wiener-dog", "hotdog-2", "corndog", "tacos"]
SLIDE, DWELL = 0.45, 1.9  # seconds moving, seconds held still in the middle

table = Image.new("RGB", (W, H), (176, 141, 104))
grain = Image.effect_noise((W, H), 18).convert("RGB")
table = Image.blend(table, grain, 0.12).filter(ImageFilter.GaussianBlur(1))
photos = []
for name in ITEMS:
    im = ImageOps.exif_transpose(Image.open(samples / f"{name}.jpg")).convert("RGB")
    im = ImageOps.fit(im, (640, 640), Image.LANCZOS)  # a square plate of food, filling the frame width
    photos.append(im)

def ease(t):
    return t * t * (3 - 2 * t)

frames = []
for i, photo in enumerate(photos):
    nxt = photos[(i + 1) % len(photos)]
    hold = round(DWELL * FPS)
    move = round(SLIDE * FPS)
    for f in range(hold + move):
        canvas = table.copy()
        if f < hold:
            canvas.paste(photo, ((W - 640) // 2, (H - 640) // 2))
        else:
            t = ease((f - hold) / move)
            x = (W - 640) // 2 - round(t * W)
            canvas.paste(photo, (x, (H - 640) // 2))
            canvas.paste(nxt, (x + W, (H - 640) // 2))
        frames.append(canvas)

with open(out, "wb") as fh:
    for fr in frames:
        fr.save(fh, "JPEG", quality=88)
print(out, len(frames), "frames", f"{len(frames) / FPS:.1f}s loop")
