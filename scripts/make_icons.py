#!/usr/bin/env python3
"""Draws the app icons: a focused wave group in blue on white. Run once: needs Pillow.
Also prints the same curve as an SVG path, for the favicon and the mark in the page header."""
import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "assets" / "icons"
WHITE = (255, 255, 255)
DEEP, SKY = (24, 78, 214), (20, 164, 232)       # the wave: deep blue → sky blue, left to right
WASH = (232, 241, 255)                           # a pale wash of water under the wave


# The focused wave group of the app's masthead: deep-water components (a Gaussian band around k0)
# that have come into phase at the centre, with crests sharpened slightly as real waves are.
COMPONENTS = [(0.5 + i / 21, math.exp(-((0.5 + i / 21 - 1.0) ** 2) / (2 * 0.26 ** 2))) for i in range(22)]
NORM = sum(a for _, a in COMPONENTS)
HALF_WINDOW = 12.5                                # in units of 1/k0: the big crest and two on each side


def wave(u: float) -> float:
    """Surface elevation across the icon, u from 0 (left) to 1 (right); the tall crest is about 1 high."""
    x = -HALF_WINDOW + 2 * HALF_WINDOW * u
    e = sum(a * math.cos(k * x) for k, a in COMPONENTS) / NORM
    return (e + 0.32 * e * e) / 1.32


def draw(size: int, radius: float, inset: float) -> Image.Image:
    s = size * 4                                             # supersample, then shrink
    img = Image.new("RGB", (s, s), WHITE)
    d = ImageDraw.Draw(img)
    lo, hi = s * inset, s * (1 - inset)
    scale = (1 - 2 * inset) / 0.72
    steps = 2400
    pts = []
    for i in range(steps + 1):
        u = i / steps
        pts.append((lo + (hi - lo) * u, s * 0.56 - wave(u) * s * 0.30 * scale))
    # water under the wave, edge to edge, then the wave itself as overlapping discs (a smooth round stroke)
    level = pts[0][1]
    d.polygon([(0, level)] + pts + [(s, level), (s, s), (0, s)], fill=WASH)
    w = max(4, round(s * 0.058 * scale))
    for i, (x, y) in enumerate(pts):
        u = i / steps
        colour = tuple(round(DEEP[k] + (SKY[k] - DEEP[k]) * u) for k in range(3))
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=colour)
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
    # the same curve on a 32 x 32 grid (4 px inset), as a path
    pts32 = [(4 + 24 * i / 72, 17.9 - wave(i / 72) * 9.6) for i in range(73)]
    print("M" + "L".join(f"{x:.2f},{y:.2f}" for x, y in pts32))
