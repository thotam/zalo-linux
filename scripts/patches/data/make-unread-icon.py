#!/usr/bin/env python3
"""Composite an "unread" tray icon: the app icon + a red dot in the top-right.
Usage: make-unread-icon.py <src.png> <dst.png>
Run at SETUP by patch-tray.js so the unread icon follows the app's current icon.
"""
import sys
from PIL import Image, ImageDraw

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
w, h = im.size
d = ImageDraw.Draw(im)
r = max(6, round(w * 0.14))        # small corner dot (~1/7 of the icon width)
cx, cy = w - r - 1, r + 1          # top-right corner
# thin white ring for contrast on any background, then the red dot
d.ellipse([cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1], fill=(255, 255, 255, 255))
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(238, 32, 42, 255))
im.save(dst, "PNG")
print("wrote %s %dx%d" % (dst, w, h))
