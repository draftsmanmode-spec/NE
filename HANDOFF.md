# Handoff — 2026-10-01

## State
Openings work merged to `main` (draftsmanmode-spec/NE#1). Follow-up on branch
`claude/intelligent-bardeen-84x4o1` (draftsmanmode-spec/NE#2, open, not merged): smarter DXF split
mode, cut path / laser cost, quote incl. cutting, time-budgeted search for big jobs, oversized parts
held back, and PDF export by audience (internal / shop / customer) with bookmarks and links. See `PLAN.md`.
Shipped "Fill interior openings": DXF import now
finds usable cut-outs (frame drop-outs) and the nester places smaller parts inside them,
keeping the part gap from the cut edge. Hand-typed parts can get openings too: the ✎ editor
in the parts list (frame preset or custom rectangles) or a 5th "rail" value in paste rows.
A project-level "Nest parts inside openings" switch (Nesting settings) turns it all off; when
on, the report states the saving vs. leaving openings empty (sheets and $, since cost is
always whole sheets). Details and checklist in `PLAN.md`.

Verified: `node tools/test_openings.mjs` — 69/69 pass (import, split mode, cut path, quote, export audiences, big jobs, geometry, rotation, stale
openings, PDF export, review regressions, a seeded 40-job random stress test, and the money
check: 2 frames + 10 tabs on 32x22 stock need 2 sheets with openings vs 3 without).
Heavy job (304 parts, 4 sheet types, Quality): ~1 s; 2,500 parts ~5 s (was 23 s) thanks to the time budget.
Windows installer not rebuilt yet (cloud session, no Windows).

## Next action
Rebuild the installer on Windows (`.\build.ps1`), install, then a 5-minute smoke test:
1. Open an existing saved project: parts and settings load, nest result unchanged.
2. Import DXF -> a real frame part: Fill shows a count, green note lists openings.
3. Add small parts, Next to Nest: dashed pockets with parts inside, saving line under Strategy.
4. Untick "Nest parts inside openings" (Nesting settings): no pockets, sheet count goes back up.
5. Export full report as PDF: drawings show the pockets, saving line is on page 1.
6. Import a layout DXF with "Split multi-shape files" on: one row per shape, identical shapes merged with a count.
7. Enter cut speed / pierce time / $ per hour in Nesting settings: report shows cut path, machine time and Est. cutting.
   Compare the cut length with your CAM software on one real part.
8. Report sections > "PDF for": export once each as Internal, Shop and Customer. Shop has no $ anywhere;
   Customer is one page; in Internal/Shop the sheet index rows and "Back to summary" jump between pages,
   and the bookmarks panel lists every sheet.
Then pick from "Next candidates" in `PLAN.md`.

## Watch out for
- With openings in play every packing attempt also runs with them empty (best of both wins, and the
  best empty one is the report's comparison). Search is capped by `SEARCH_BUDGET_MS`; a cut-short
  search is stated in the report and "Try harder" continues it.
- Paste rows make a frame only with `rail N` as the 5th value.
- Older saved parts have no `openings` field — that's fine, they behave exactly as before.
- Openings are measured at the size the part had when they were set; editing W/H disables them (⚠ in the Fill column) until they are re-fitted with ✎ or the DXF is re-imported.
