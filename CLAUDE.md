# Sheet Nesting Estimator (NE)

Offline desktop estimator for sheet-material jobs: parts in, sheets/cost/PDF out.
Personal shop tool, Windows, Tauri v2 shell around a single HTML file.

## Layout
- `nesting-estimator.html` — the whole app (HTML + CSS + JS, fonts embedded as base64).
  Source of truth. Long lines 13-22 are font data; never print them.
- `jspdf.umd.min.js`, `pdf-fonts.js` — vendored PDF export deps, loaded beside the HTML.
- `src-tauri/` — Rust shell (~8 lines). `build.ps1` copies the HTML into `dist/` and builds the NSIS installer.
- `tools/` — icon/font generators (Python) and `test_openings.mjs` (browser test).
- `BUILD.md` — build prerequisites and how export/offline work. `PLAN.md` — feature plan. `HANDOFF.md` — last session's state.

## Code map (JS sections inside the HTML, search the banner comments)
- `DXF IMPORT` → `INTERIOR OPENINGS` → review modal (`dxfReadFile`, `renderDxfReviewTable`) → `OPENINGS EDITOR` (hand-typed openings)
- `PACKING ALGORITHM` (MaxRects: `packSheetsOnce`, `packSheetsBest`, `packMoreAttempts`)
- `RIGHTSIZE PASS`, `COMMON-LINE`, `REMNANT CAPTURE`, `STRATEGY COMPARISON`
- Drawing: `drawSheet`, `drawSheetThumb`, `rotatedBinView`; PDF: `buildNestingPdf(mode, audience)` with `PDF_AUDIENCES` (internal / shop / customer)
- Money: `jobCosts` (material + cutting, markup, all in cents); big jobs: `SEARCH_BUDGET_MS`, oversized parts: `fitsSomeSheet` / `oversizedParts`
- Split mode: `dxfSplitNested` (containment) with `dxfClusterRuns` (bbox) as fallback; cut path: `dxfCutStats`, `partCut`, `cutTotals`

## Rules that matter
- Nesting is **bounding-box (rectangles) only**, by design. Openings are offered as
  rectangles fully inside a DXF hole; never claim space the hole doesn't have.
- Placement coordinates are y-down from the sheet's top-left; DXF is y-up — convert at import.
- Material used = `placedArea(p)` (box minus openings handed back). Never sum `p.w*p.h` directly.
  Cost is always whole sheets; area only breaks ties, so openings-filled and openings-empty layouts must score the same material.
- Openings reach the packer only through `unitForPart()`, gated by the project switch `nestOpeningsEnabled`.
- One 90° rotation convention everywhere: local (u,v) → (H − v, u). Packer and `rotatedBinView` must agree.
- PDF audiences: the shop PDF never prints a price, the customer PDF never shows cost, markup, efficiency or sheets.
  Every money figure comes from `jobCosts` so printed lines add up (per-part lines get whole cents by largest
  remainder, summing exactly to the quote). Tests check this via `buildNestingPdf`'s `trace`.
- Company details live in `localStorage` (`nestingEstimatorBusiness_v1`, logo separately); quote customer/number per project settings.
- PDF text must use the embedded font subset: ASCII plus `°·×²½¼¾–—‘’“”•…✓` (see tools/make_pdf_fonts.py).
- No bundler, no npm deps in the app. Keep it one file that works from `file://` and offline.
- Saved projects live in `localStorage`; new part fields must survive `sanitizeImportedPart`.

## Checks (run before every push)
```
node tools/test_openings.mjs [screenshot-dir]   # needs playwright (global is fine)
```
No CI. The installer build (`.\build.ps1`) is Windows-only and not runnable in cloud sessions.

## Session kickoff
No repo-specific skills. Read `HANDOFF.md` for the next action.
