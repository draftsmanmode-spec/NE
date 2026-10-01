# Handoff — 2026-10-01

## State
Branch `claude/intelligent-bardeen-84x4o1`. Shipped "Fill interior openings": DXF import now
finds usable cut-outs (frame drop-outs) and the nester places smaller parts inside them,
keeping the part gap from the cut edge. Details and checklist in `PLAN.md`.

Verified: `node tools/test_openings.mjs` — 18/18 pass (import, geometry, rotation, stale
openings, PDF export, and the money check: 2 frames + 10 tabs on 32x22 stock need 2 sheets
with openings vs 3 without). Windows installer not rebuilt in this session (cloud, no Windows).

## Next action
Rebuild the installer on Windows (`.\build.ps1`) and try it on a real frame DXF from the shop.
Then pick from "Next candidates" in `PLAN.md` — manual openings for hand-typed frames is the
most likely ask.

## Watch out for
- Older saved parts have no `openings` field — that's fine, they behave exactly as before.
- Openings are measured at the size the part had at import; editing W/H disables them (⚠ in the Fill column) until the DXF is re-imported.
