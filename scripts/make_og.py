"""Render public/og.png, the 1200x630 link preview."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

out = Path(sys.argv[1])
W, H = 1200, 630
GREEN, RED, BEIGE = (54, 194, 74), (232, 66, 63), (214, 196, 170)
EMOJI = "/System/Library/Fonts/Apple Color Emoji.ttc"


def sf(size, weight="Heavy"):
    f = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", size)
    try:
        f.set_variation_by_name(weight)
    except Exception:
        pass
    return f


def emoji(ch, size):
    g = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    ImageDraw.Draw(g).text((20, 20), ch, font=ImageFont.truetype(EMOJI, 160), embedded_color=True)
    return g.crop(g.getbbox()).resize((size, size), Image.LANCZOS)


img = Image.new("RGB", (W, H), (13, 13, 13))
glow = Image.new("RGB", (W, H), (13, 13, 13))
ImageDraw.Draw(glow).ellipse((-200, -150, 700, 650), fill=(70, 32, 20))
img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(160)), 1.0)
d = ImageDraw.Draw(img)

dog = emoji("🌭", 130)
img.paste(dog, (72, 70), dog)
d.text((68, 210), "SeeFood", font=sf(124), fill="white")
d.text((74, 360), "Hotdog or Not Hotdog.", font=sf(44, "Bold"), fill=(225, 225, 225))
d.text((74, 420), "The Shazam for food, rebuilt on Jev 1.14.", font=sf(30, "Semibold"), fill=(244, 169, 201))
d.text((74, 540), "Fan-made · point your camera at food", font=sf(24, "Medium"), fill=(120, 120, 120))


def phone(x, y, yes, ch):
    w, h, r = 220, 420, 34
    color = GREEN if yes else RED
    card = Image.new("RGB", (w, h), BEIGE)
    cd = ImageDraw.Draw(card)
    food = emoji(ch, 150)
    card.paste(food, ((w - 150) // 2, 200), food)
    cd.rectangle((0, 0, w, 96), fill=color)
    word = "Hotdog!" if yes else "Not hotdog!"
    f = sf(36 if yes else 31)
    tw = cd.textlength(word, font=f)
    cd.text(((w - tw) / 2, 22), word, font=f, fill="white")
    cx, cy, rr = w // 2, 104, 30
    cd.ellipse((cx - rr - 4, cy - rr - 4, cx + rr + 4, cy + rr + 4), fill="white")
    cd.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=color)
    if yes:
        cd.line([(cx - 14, cy + 1), (cx - 4, cy + 11), (cx + 15, cy - 10)], fill="white", width=7, joint="curve")
    else:
        cd.line([(cx - 11, cy - 11), (cx + 11, cy + 11)], fill="white", width=7)
        cd.line([(cx + 11, cy - 11), (cx - 11, cy + 11)], fill="white", width=7)
    if yes:
        cd.rounded_rectangle((28, 190, w - 28, 370), radius=16, outline=GREEN, width=5)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w, h), radius=r, fill=255)
    frame = Image.new("RGB", (w + 16, h + 16), (43, 43, 43))
    fmask = Image.new("L", frame.size, 0)
    ImageDraw.Draw(fmask).rounded_rectangle((0, 0, w + 16, h + 16), radius=r + 8, fill=255)
    img.paste(frame, (x - 8, y - 8), fmask)
    img.paste(card, (x, y), mask)


phone(700, 105, True, "🌭")
phone(948, 105, False, "🍕")
img.save(out, "PNG", optimize=True)
print(out, img.size)
