"""Re-encode downloaded sample photos into public/samples: ≤1024px, metadata stripped, plus square thumbs."""
import sys
from pathlib import Path
from PIL import Image, ImageOps

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(exist_ok=True)
sheet = Image.new("RGB", (6 * 200, 200))
for i, slug in enumerate(["hotdog", "pizza", "wiener-dog", "corndog", "tacos", "hotdog-2"]):
    with Image.open(src / f"{slug}.jpg") as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        full = im.copy()
        full.thumbnail((1024, 1024), Image.LANCZOS)
        full.save(out / f"{slug}.jpg", "JPEG", quality=85)
        thumb = ImageOps.fit(im, (160, 160), Image.LANCZOS)
        thumb.save(out / f"{slug}-thumb.jpg", "JPEG", quality=82)
        sheet.paste(ImageOps.fit(im, (200, 200)), (i * 200, 0))
        print(slug, full.size)
sheet.save("/tmp/hotdog-dl/sheet.jpg")
