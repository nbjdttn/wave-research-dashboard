#!/usr/bin/env python3
"""Draws the app icons (a focused wave group on an ocean gradient). Run once: needs Pillow."""
import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "assets" / "icons"
A, B = (6, 40, 58), (15, 116, 128)          # deep navy → teal


def wave(x: float) -> float:
    """A compact wave group: one tall crest flanked by smaller ones."""
    return math.exp(-(x ** 2) / 2.6) * math.cos(2.35 * x)


def draw(size: int, radius: float, inset: float) -> Image.Image:
    s = size * 4                                             # supersample, then shrink
    img = Image.new("RGB", (s, s))
    px = img.load()
    for y in range(s):
        for x in range(s):
            t = (x + y) / (2 * s)
            px[x, y] = tuple(round(A[i] + (B[i] - A[i]) * t) for i in range(3))
    d = ImageDraw.Draw(img)
    lo, hi = s * inset, s * (1 - inset)
    # Stamp overlapping discs along a finely sampled curve: a perfectly smooth round stroke.
    scale = (1 - 2 * inset) / 0.72
    w = max(4, round(s * 0.056 * scale))
    steps = 2400
    for i in range(steps + 1):
        u = i / steps
        x = lo + (hi - lo) * u
        y = s * 0.555 - wave(-3.3 + 6.6 * u) * s * 0.255 * scale
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=(255, 255, 255))
    img = img.resize((size, size), Image.LANCZOS)
    if radius:
        mask = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * 4, size * 4], radius=size * 4 * radius, fill=255)
        img.putalpha(mask.resize((size, size), Image.LANCZOS))
    return img


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    draw(192, 0.22, 0.16).save(OUT / "icon-192.png")
    draw(512, 0.22, 0.16).save(OUT / "icon-512.png")
    draw(512, 0, 0.24).save(OUT / "icon-maskable-512.png")    # full bleed, content inside the safe zone
    draw(180, 0, 0.18).save(OUT / "apple-touch-icon.png")     # iOS rounds the corners itself
    print("icons written to", OUT)
