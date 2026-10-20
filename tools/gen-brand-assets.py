#!/usr/bin/env python3
"""Regenerate every logo/icon asset from tools/brand/logo-source.png.
Requires Pillow + numpy:  pip install pillow numpy
Usage: python3 tools/gen-brand-assets.py
"""
import os
import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..')
PUB = os.path.join(ROOT, 'public')
SRC = os.path.join(ROOT, 'tools', 'brand', 'logo-source.png')
BG = (11, 14, 20)          # app background #0b0e14
FULL_BOX = (205, 486, 1062, 713)   # lockup bounds in the source image
MARK_BOX = (205, 486, 405, 713)    # shield-only bounds
PAD = 6

a = np.array(Image.open(SRC).convert('RGB')).astype(float)

def cut(box, width):
    x0, y0, x1, y1 = box
    c = a[y0 - PAD:y1 + PAD, x0 - PAD:x1 + PAD]
    alpha = np.clip((c.max(axis=2) - 12) / 45, 0, 1)
    im = Image.fromarray(np.dstack([c, alpha * 255]).astype(np.uint8), 'RGBA')
    return im.resize((width, round(width * im.height / im.width)), Image.LANCZOS)

os.makedirs(os.path.join(PUB, 'brand'), exist_ok=True)
cut(FULL_BOX, 520).save(os.path.join(PUB, 'brand', 'logo-full.png'), optimize=True)
mark = cut(MARK_BOX, 128)
mark.save(os.path.join(PUB, 'brand', 'logo-mark.png'), optimize=True)

def icon(size, fill, name):
    canvas = Image.new('RGBA', (size, size), BG + (255,))
    h = int(size * fill)
    w = int(mark.width * h / mark.height)
    canvas.alpha_composite(mark.resize((w, h), Image.LANCZOS), ((size - w) // 2, (size - h) // 2))
    canvas.convert('RGB').save(os.path.join(PUB, name), optimize=True)

icon(512, 0.56, 'icon-512.png')          # inside maskable safe zone
icon(192, 0.56, 'icon-192.png')
icon(180, 0.60, 'apple-touch-icon.png')
icon(32, 0.84, 'favicon-32.png')
icon(48, 0.84, 'favicon-48.png')
Image.open(os.path.join(PUB, 'favicon-48.png')).save(os.path.join(PUB, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])
print('brand assets regenerated')
