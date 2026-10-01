# Plan

## Done — Fill interior openings at DXF import (2026-10-01)
Goal: when laser-cutting a frame (or ring, bracket, panel with a big cut-out), the
drop-out should carry smaller parts instead of being scrap.

- [x] Stitch DXF runs into closed loops (LINE/ARC chains as well as CIRCLE/closed polylines)
- [x] Classify loops by containment: outline (depth 0) → holes (depth 1); skip holes that already contain a drawn shape
- [x] Largest inscribed axis-aligned rectangles per hole (raster seed + exact edge growth), up to 3 per hole, 16 per part
- [x] Review modal: "Fill interior openings" toggle, "Smallest useful opening" (default 1"), per-row Fill column + summary
- [x] Parts list: Fill column (count + toggle); openings go stale (⚠, ignored) if W/H are edited after import
- [x] Packer: a placed part's openings become free rects, inset by the part gap; rotation-aware
- [x] Area/efficiency/cost use `placedArea()` so nested parts never double-count
- [x] Drawings show openings as dashed pockets; frame label moves to a solid rail; report + PDF note "N parts nested inside openings"
- [x] Fix: "Try harder" rebuilt units with rotation always allowed (ignored a part's Rot setting)
- [x] `tools/test_openings.mjs` end-to-end browser test (incl. sheet saved: 3 → 2 sheets)

## Done — Openings for hand-typed parts (2026-10-01)
- [x] Openings editor (✎ in the parts-list Fill column): "Make frame" rail preset, custom rectangles, live preview
- [x] Validation: inside the part, no overlaps (touching is fine), max 16; Save disabled while invalid
- [x] Re-fit stale openings after a resize from the editor (no DXF re-import needed)
- [x] Paste rows: optional 5th value `rail N` = frame rail width (`Frame, 30, 20, 2, rail 1.5`)
- [x] Tests extended to 25 checks (paste, editor via UI, validation, re-fit, JSON round-trip)

## Done — Global openings switch (2026-10-01)
- [x] "Nest parts inside openings" in Nesting settings (default on, saved per project)
- [x] When on, the same job is also nested with openings empty; report + PDF state the saving in sheets and $ ("saves 1 sheet ($40) - 2 instead of 3")
- [x] Strategy table gets a "Without openings" column when there is something to compare
- [x] Never worse: every packing attempt also runs with openings empty, best of both wins (scored on the same material count)
- [x] Tests: saving text, switch off, persistence, table column, never-worse (30 checks)

## Done — Review hardening (2026-10-01)
- [x] "Without openings" comparison now comes from the same search (best openings-empty layout), so it can never beat the result; no second full nest
- [x] Try harder searches the openings-empty twin too, so its gains aren't credited to openings
- [x] Paste rows: frame only with an explicit `rail N` 5th value (a numeric thickness/price column is ignored)
- [x] An empty frame interior is never offered as a reusable sheet remnant
- [x] Imported openings need their measured size (else dropped); `"false"` stays off; editor save keeps an unticked Fill
- [x] Openings can't span a part's full width/height; min opening 0 means the 0.25" floor
- [x] Seeded random-job stress test (40 jobs: geometry, part counts, stock limits, Rot, honest comparison); 40 checks

## Next candidates
- [ ] Optionally list a frame's leftover drop-out as a remnant separately from sheet-edge remnants
- [ ] Split mode: a part drawn inside another part's hole in one DXF is merged into that part today (bbox clustering); split it into its own row instead
