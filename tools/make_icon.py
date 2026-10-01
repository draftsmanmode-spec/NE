"""Generate the Sheet Nesting Estimator app icon: purple->pink gradient rounded
square with a white 'N' mark. Pure stdlib (zlib + struct), no Pillow needed.

    python tools/make_icon.py src-tauri/icons
"""
import math, os, struct, sys, zlib

OUT = sys.argv[1]
PURPLE = (0x7c, 0x3a, 0xed)
PINK = (0xef, 0x5c, 0xb0)
SS = 4  # supersampling factor


def lerp(a, b, t):
    return a + (b - a) * t


def rounded_rect_sd(x, y, w, h, r):
    """Signed distance to a rounded rect centred in a w*h box; <0 is inside."""
    qx = abs(x - w / 2) - (w / 2 - r)
    qy = abs(y - h / 2) - (h / 2 - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def seg_dist(px, py, ax, ay, bx, by):
    """Distance from point to line segment ab."""
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    return math.hypot(px - (ax + vx * t), py - (ay + vy * t))


def glyph_n_dist(x, y, S):
    """Distance to the skeleton of an 'N': two verticals + a diagonal."""
    left, right = 0.30 * S, 0.70 * S
    top, bot = 0.29 * S, 0.71 * S
    return min(
        seg_dist(x, y, left, top, left, bot),    # left stem
        seg_dist(x, y, right, top, right, bot),  # right stem
        seg_dist(x, y, left, top, right, bot),   # diagonal
    )


def render(S):
    """Render an SxS RGBA icon as a flat bytearray."""
    big = S * SS
    radius = 0.22 * big
    stroke = 0.085 * big  # half-width of the 'N' strokes
    px = bytearray(S * S * 4)

    for oy in range(S):
        for ox in range(S):
            ar = ag = ab = aa = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    fx = ox * SS + sx + 0.5
                    fy = oy * SS + sy + 0.5

                    d = rounded_rect_sd(fx, fy, big, big, radius)
                    cov = min(1.0, max(0.0, 0.5 - d))
                    if cov <= 0:
                        continue

                    # 135deg gradient: purple top-left -> pink bottom-right.
                    t = min(1.0, max(0.0, (fx + fy) / (2 * big)))
                    r = lerp(PURPLE[0], PINK[0], t)
                    g = lerp(PURPLE[1], PINK[1], t)
                    b = lerp(PURPLE[2], PINK[2], t)

                    gd = glyph_n_dist(fx, fy, big) - stroke
                    gcov = min(1.0, max(0.0, 0.5 - gd))
                    if gcov > 0:
                        r = lerp(r, 255, gcov)
                        g = lerp(g, 255, gcov)
                        b = lerp(b, 255, gcov)

                    ar += r * cov
                    ag += g * cov
                    ab += b * cov
                    aa += cov

            n = SS * SS
            i = (oy * S + ox) * 4
            if aa > 0:
                # Un-premultiply so edge pixels keep full colour.
                px[i + 0] = int(ar / aa + 0.5)
                px[i + 1] = int(ag / aa + 0.5)
                px[i + 2] = int(ab / aa + 0.5)
            px[i + 3] = int(aa / n * 255 + 0.5)
    return px


def write_png(path, S, px):
    raw = bytearray()
    for y in range(S):
        raw.append(0)  # filter type: none
        raw += px[y * S * 4:(y + 1) * S * 4]

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def ico_entry(S, px):
    """A 32-bit BGRA DIB entry (widest Windows compatibility)."""
    hdr = struct.pack("<IiiHHIIiiII", 40, S, S * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    body = bytearray()
    for y in range(S - 1, -1, -1):  # DIB rows are bottom-up
        for x in range(S):
            i = (y * S + x) * 4
            body += bytes((px[i + 2], px[i + 1], px[i + 0], px[i + 3]))
    mask_row = ((S + 31) // 32) * 4  # AND mask, 32-bit aligned rows
    return bytes(hdr) + bytes(body) + b"\x00" * (mask_row * S)


def write_ico(path, images):
    out = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    blobs = []
    for S, px in images:
        data = ico_entry(S, px)
        blobs.append(data)
        out += struct.pack("<BBBBHHII", S & 0xFF, S & 0xFF, 0, 0, 1, 32,
                           len(data), offset)
        offset += len(data)
    with open(path, "wb") as f:
        f.write(out + b"".join(blobs))


os.makedirs(OUT, exist_ok=True)
cache = {}
for S in (16, 24, 32, 48, 64, 128, 256):
    cache[S] = render(S)
    print("rendered", S)

write_png(os.path.join(OUT, "32x32.png"), 32, cache[32])
write_png(os.path.join(OUT, "128x128.png"), 128, cache[128])
write_png(os.path.join(OUT, "128x128@2x.png"), 256, cache[256])
write_png(os.path.join(OUT, "icon.png"), 256, cache[256])
write_ico(os.path.join(OUT, "icon.ico"),
          [(S, cache[S]) for S in (16, 24, 32, 48, 64, 128, 256)])
print("wrote icons to", OUT)
