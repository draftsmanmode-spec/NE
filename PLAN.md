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

## Done — Smarter "Split multi-shape files" (2026-10-01)
- [x] Split by containment (loop tree) when the file's outlines close: every outline is its own row with its own holes
- [x] Parts drawn inside a frame's hole become their own rows, and the frame's hole becomes a usable opening
- [x] Interlocking parts with overlapping bounding boxes are no longer merged
- [x] Fix: a hole inside an outline drawn as separate LINEs was imported as a phantom part of its own (24x24 frame + 18x18 "part"); the bbox fallback now keeps a box inside another box with it
- [x] Identical shapes in one file collapse to one row with the count as Qty (review modal says which)
- [x] Tests: layout DXF, LINE-drawn frame, open outline fallback (50 checks)

## Done — Cut path and laser cost (2026-10-01)
- [x] DXF parts carry their real cut path (entity lengths) and pierces (one per closed loop / open chain)
- [x] Typed-in parts: estimate from rectangle + openings (flagged as estimated in the report); a resized DXF part falls back to the estimate
- [x] Report + PDF: cut path and pierces of the nested parts; with cut speed / pierce time / $ per hour (Nesting settings, saved per project) also machine time and an "Est. cutting" stat
- [x] Tests: frame/ring/bracket cut paths, typed estimate, totals, time and $, persistence (58 checks)

## Done — Quote, big jobs, export by audience (2026-10-01)
- [x] Customer quote = (material + cutting) x markup; money rounded to the cent once (`jobCosts`), so every line adds up
- [x] Big jobs: per-strategy time budget (Quality 4 s, Balanced 2.5 s), strongest attempts first, whole filled/plain pairs; report notes a cut-short search. 2,500 parts: 22.8 s -> 5.1 s, same sheet count
- [x] A part too big for every sheet is held back and named (with each sheet's real limit); everything else nests (was: whole nest refused)
- [x] PDF "for": Internal (costs table, notes, material, linked sheet index, parts, remnants, sheets), Shop (no prices: material to pull, cut order, cut path/time, sheets), Customer (one page: quote total, price lines, parts)
- [x] PDF navigation: bookmarks (opens with the panel), sheet index rows link to sheet pages, "Back to summary" on each sheet, document title/subject
- [x] Trimmed: no paper/margin line, no Rotation column, short bullet notes, "not to scale" note kept for shop/internal
- [x] Drawings: title box never covers parts (and is left out of PDFs); tall narrow parts get vertical labels
- [x] Fix: PDF remnant table always said "Sheet 1"
- [x] Tests: quote math and rounding, oversized part, Try harder, time budget, what each audience PDF must and must not say, links (69 checks)

## Done — Quote letterhead, per-part prices, shop checklist, CSV (2026-10-01)
- [x] "Quote & company details" (Results step): company, contact, address, terms, valid-for days, logo (saved once, own storage key, size-capped); per project: customer, quote number (auto `Q-yymmdd-nnn`)
- [x] Customer quote: letterhead, Quotation + number, date / valid until / prepared for / project, terms; company + quote number in the footer
- [x] Per-part prices (switchable): material share by area + cutting share by machine time, marked up; whole cents allocated so lines add up exactly to (material + cutting) x markup; unit prices show 4 places when not whole cents
- [x] Shop sheets: a tick box per part on every sheet and a "Cut by / Date / Checked" sign-off line
- [x] Cut list CSV: sheet, material, tag, part, size, X/Y on the sheet, rotated, inside which frame's opening; Excel-friendly (BOM, CRLF, quoted)
- [x] `save_pdf` (Rust) takes an optional file-type filter so the CSV saves as CSV (verified against tauri-plugin-dialog 2.7 source; Linux cargo check can't run here: no GTK)
- [x] Tests: letterhead, logo embedded, prices on/off, sign-off, CSV, persistence, tiny-parts pricing (75 checks)

## Next candidates
- [ ] Common-line cuts could subtract shared edges from the cut path
- [ ] Optionally list a frame's leftover drop-out as a remnant separately from sheet-edge remnants
- [ ] Identical shapes drawn rotated 90 deg in one file are not merged yet (only same orientation)
