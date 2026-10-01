"""Download the three Google Fonts the UI uses and emit self-contained
@font-face rules with the woff2 payload inlined as base64.

This produces a CSS fragment; paste it at the top of the <style> block in
nesting-estimator.html, replacing the existing embedded-webfonts section. The
HTML must contain no fonts.googleapis.com / fonts.gstatic.com references
afterwards, or the app stops being offline.

    python tools/embed_fonts.py fonts.css

Only the `latin` unicode-range subset is taken - the UI is English and the full
set would roughly quadruple the payload for no benefit. All three families are
SIL Open Font License, which permits embedding.
"""
import base64, re, sys, urllib.request

CSS_URL = ("https://fonts.googleapis.com/css2"
           "?family=Space+Grotesk:wght@500;600;700"
           "&family=Inter:wght@400;500;600;700"
           "&family=IBM+Plex+Mono:wght@400;500;600;700"
           "&display=swap")

# A modern desktop UA makes the API serve woff2 rather than legacy ttf.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")

# The `latin` subset Google emits always contains U+0000-00FF; this is the
# marker that distinguishes it from latin-ext / cyrillic / greek blocks.
LATIN_MARK = "U+0000-00FF"


def get(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf-8")


css = get(CSS_URL)
blocks = re.findall(r"/\*\s*([a-z-]+)\s*\*/\s*(@font-face\s*\{.*?\})", css, re.S)
print("parsed %d @font-face blocks from Google CSS" % len(blocks))

out = []
total = 0
kept = 0
for subset, block in blocks:
    if subset != "latin":
        continue
    fam = re.search(r"font-family:\s*'([^']+)'", block).group(1)
    wght = re.search(r"font-weight:\s*(\d+)", block).group(1)
    style = re.search(r"font-style:\s*(\w+)", block).group(1)
    urange = re.search(r"unicode-range:\s*([^;]+);", block).group(1).strip()
    if LATIN_MARK not in urange:
        continue
    url = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)

    raw = get(url, binary=True)
    total += len(raw)
    kept += 1
    b64 = base64.b64encode(raw).decode("ascii")
    print("  %-16s %s  %-7s %6.1f KB" % (fam, wght, style, len(raw) / 1024))

    out.append(
        "@font-face{font-family:'%s';font-style:%s;font-weight:%s;"
        "font-display:swap;"
        "src:url(data:font/woff2;base64,%s) format('woff2');}" % (fam, style, wght, b64)
    )

header = (
    "  /* ---------- embedded webfonts ----------\n"
    "     Space Grotesk, Inter and IBM Plex Mono, latin subset, inlined as\n"
    "     base64 woff2 so the app renders identically with no network access.\n"
    "     All three are SIL Open Font License. Regenerate with\n"
    "     tools/embed_fonts.py if the weight list ever changes. */\n"
)

with open(sys.argv[1], "w", encoding="utf-8") as f:
    f.write(header + "\n".join("  " + o for o in out) + "\n")

print("\n%d faces, %.0f KB raw -> %.0f KB base64" % (kept, total / 1024, total * 4 / 3 / 1024))
print("written to", sys.argv[1])
