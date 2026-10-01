"""Build pdf-fonts.js: the app's real typefaces, subset to the characters the
PDF actually draws, converted woff2 -> TTF, base64'd for jsPDF's VFS.

    python -m pip install "fonttools[woff]"
    python tools/make_pdf_fonts.py pdf-fonts.js

jsPDF can only embed TTF, and it embeds the whole file into every document, so
subsetting is what keeps a 60 KB overview from becoming a 1 MB one. The four
faces together come to roughly 53 KB.

All three families are SIL Open Font License.
"""
import base64, io, re, sys, urllib.request

from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")

# family, weight -> (jsPDF font name, jsPDF style)
WANT = [
    ("Inter",         "400", "Inter",        "normal"),
    ("Inter",         "600", "Inter",        "bold"),
    ("Space Grotesk", "700", "SpaceGrotesk", "bold"),
    ("IBM Plex Mono", "400", "PlexMono",     "normal"),
]

# ASCII plus the punctuation and symbols the report actually draws.
CHARS = "".join(chr(c) for c in range(0x20, 0x7F))
CHARS += " °·×²½¼¾"
CHARS += "–—‘’“”•…✓"


def fetch(url, binary=True):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = r.read()
    return d if binary else d.decode()


def css_url(family, weight):
    fam = family.replace(" ", "+")
    css = fetch("https://fonts.googleapis.com/css2?family=%s:wght@%s&display=swap"
                % (fam, weight), binary=False)
    blocks = re.findall(r"/\*\s*([a-z-]+)\s*\*/\s*(@font-face\s*\{.*?\})", css, re.S)
    for subset, block in blocks:
        if subset != "latin":
            continue
        m = re.search(r"url\((https://[^)]+\.woff2)\)", block)
        if m:
            return m.group(1)
    raise SystemExit("no latin woff2 for %s %s" % (family, weight))


out = []
total = 0
for family, weight, js_name, js_style in WANT:
    raw = fetch(css_url(family, weight))
    f = TTFont(io.BytesIO(raw))          # fontTools reads woff2 via brotli
    f.flavor = None                      # drop woff2 compression -> plain TTF

    opts = Options()
    opts.layout_features = []            # jsPDF does not apply OpenType layout
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.recalc_bounds = True
    sub = Subsetter(options=opts)
    sub.populate(text=CHARS)
    sub.subset(f)

    buf = io.BytesIO()
    f.save(buf)
    ttf = buf.getvalue()
    total += len(ttf)
    print("  %-14s %s -> %-13s %-6s %6.1f KB" %
          (family, weight, js_name, js_style, len(ttf) / 1024))

    out.append({
        "file": "%s-%s.ttf" % (js_name, js_style),
        "name": js_name,
        "style": js_style,
        "b64": base64.b64encode(ttf).decode("ascii"),
    })

js = [
    "/* Real typefaces for PDF export: Inter, Space Grotesk and IBM Plex Mono,",
    "   subset to the characters the report draws and converted to TTF because",
    "   that is the only format jsPDF can embed. All SIL Open Font License.",
    "   Regenerate with tools/make_pdf_fonts.py. */",
    "window.NEST_PDF_FONTS = [",
]
for o in out:
    js.append("{file:'%s',name:'%s',style:'%s',b64:'%s'}," %
              (o["file"], o["name"], o["style"], o["b64"]))
js.append("];")

path = sys.argv[1]
io.open(path, "w", encoding="utf-8", newline="\n").write("\n".join(js) + "\n")
print("\n%d faces, %.0f KB TTF -> %.0f KB base64" % (len(out), total / 1024, total * 4 / 3 / 1024))
print("written", path)
