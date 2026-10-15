"""Render big emoji onto a table-ish background as quick, download-free test images."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1])
font = ImageFont.truetype("/System/Library/Fonts/Apple Color Emoji.ttc", 160)
for name, ch in {"hotdog": "🌭", "pizza": "🍕", "taco": "🌮", "sandwich": "🥪",
                 "banana": "🍌", "dog": "🐕", "corn": "🌽"}.items():
    glyph = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    ImageDraw.Draw(glyph).text((20, 20), ch, font=font, embedded_color=True)
    glyph = glyph.crop(glyph.getbbox()).resize((420, 420), Image.LANCZOS)
    bg = Image.new("RGB", (800, 600), (214, 196, 170))
    bg.paste(glyph, (230, 110), glyph)
    bg.save(out / f"{name}.jpg", "JPEG", quality=90)
    print(name)
