#!/usr/bin/env python3
"""Иконка приложения и аватар бота: бордовое поле, кремовая монограмма ФЭМ."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "assets"

CREAM = (247, 236, 226)
GOLD = (232, 180, 90)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size: int, top=(7, 17, 34), bottom=(28, 73, 202)) -> Image.Image:
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        row = lerp(top, bottom, y / (size - 1))
        for x in range(size):
            # небольшой диагональный сдвиг
            t = min(1.0, max(0.0, (y / size) * 0.85 + (x / size) * 0.15))
            px[x, y] = lerp(top, bottom, t)
    return img


def radial_glow(size: int, center=(0.82, 0.12), radius=0.75, color=(127, 168, 255), alpha=120):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    cx, cy = center[0] * size, center[1] * size
    steps = 48
    for i in range(steps, 0, -1):
        r = radius * size * (i / steps)
        a = int(alpha * (1 - i / steps) ** 1.6)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (a,))
    return layer.filter(ImageFilter.GaussianBlur(size * 0.02))


def bubble(size: int, pos, r, alpha=26):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    cx, cy = pos[0] * size, pos[1] * size
    rr = r * size
    draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(255, 255, 255, alpha))
    draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(255, 255, 255, min(255, alpha * 3)), width=max(1, size // 340))
    return layer.filter(ImageFilter.GaussianBlur(size * 0.004))


def rounded_mask(size: int, radius_ratio=0.225) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return mask


def build(size: int, rounded: bool = True) -> Image.Image:
    base = gradient(size)
    img = base.convert("RGBA")
    img.alpha_composite(radial_glow(size))
    img.alpha_composite(bubble(size, (0.16, 0.92), 0.30, 18))
    img.alpha_composite(bubble(size, (0.92, 0.28), 0.09, 26))

    draw = ImageDraw.Draw(img)
    font_path = "/System/Library/Fonts/NewYork.ttf"
    if not Path(font_path).exists():
        font_path = "/System/Library/Fonts/Supplemental/Georgia Bold.ttf"
    f = ImageFont.truetype(font_path, int(size * 0.285))
    text = "ФЭМ"
    box = draw.textbbox((0, 0), text, font=f)
    tw, th = box[2] - box[0], box[3] - box[1]
    x = (size - tw) / 2 - box[0]
    y = size * 0.445 - th / 2 - box[1]

    # мягкая тень под буквами
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.text((x + size * 0.006, y + size * 0.012), text, font=f, fill=(0, 0, 0, 120))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(size * 0.012)))

    draw = ImageDraw.Draw(img)
    draw.text((x, y), text, font=f, fill=CREAM + (255,))

    # золотая линия
    lw = max(2, int(size * 0.006))
    y_line = int(size * 0.665)
    x1, x2 = int(size * 0.33), int(size * 0.67)
    draw.rounded_rectangle([x1, y_line, x2, y_line + lw], radius=lw, fill=GOLD + (235,))

    # подпись
    small_path = "/System/Library/Fonts/SFNS.ttf"
    try:
        fs = ImageFont.truetype(small_path, int(size * 0.048))
    except OSError:
        fs = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", int(size * 0.05))
    sub = "СПбГТИ · ФЭМ"
    sb = draw.textbbox((0, 0), sub, font=fs)
    sw = sb[2] - sb[0]
    draw.text(((size - sw) / 2 - sb[0], y_line + size * 0.045), sub, font=fs, fill=(247, 236, 226, 190))

    if rounded:
        mask = rounded_mask(size)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        return out
    return img


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    sizes = {1024: "icon-1024.png", 512: "icon-512.png", 192: "icon-192.png", 180: "apple-touch-icon.png"}
    for size, name in sizes.items():
        build(size).save(OUT / name)
        print("ok", OUT / name)
    # круглый аватар для бота (без прозрачных углов — Telegram сам обрежет)
    build(1024).save(OUT / "bot-avatar.png")
    print("ok", OUT / "bot-avatar.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
