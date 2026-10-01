// End-to-end check for "fill interior openings" on DXF import.
//
// Drives the real nesting-estimator.html in headless Chromium: builds a few
// DXF files in memory (a rectangular frame whose hole is drawn as loose
// LINEs, a ring made of two CIRCLEs, a plate whose hole already has a shape
// drawn inside it), imports them through the review modal, nests them with
// small parts, and checks the geometry of every placement.
//
//   node tools/test_openings.mjs [screenshot-dir]
//
// Needs the `playwright` package (global install is fine). Exits non-zero
// on any failed check.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Local install first, then the global one (ESM ignores NODE_PATH).
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))); }

const here = path.dirname(fileURLToPath(import.meta.url));
const page_url = pathToFileURL(path.join(here, '..', 'nesting-estimator.html')).href;
const shotDir = process.argv[2] || null;

// ---- tiny DXF writer ---------------------------------------------------
const header = '0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n1\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';
const footer = '0\nENDSEC\n0\nEOF\n';
const line = (x0, y0, x1, y1) => `0\nLINE\n8\nCUT\n10\n${x0}\n20\n${y0}\n11\n${x1}\n21\n${y1}\n`;
const circle = (cx, cy, r) => `0\nCIRCLE\n8\nCUT\n10\n${cx}\n20\n${cy}\n40\n${r}\n`;
const rectPoly = (x, y, w, h) => `0\nLWPOLYLINE\n8\nCUT\n90\n4\n70\n1\n10\n${x}\n20\n${y}\n10\n${x+w}\n20\n${y}\n10\n${x+w}\n20\n${y+h}\n10\n${x}\n20\n${y+h}\n`;
const poly = pts => `0\nLWPOLYLINE\n8\nCUT\n90\n${pts.length}\n70\n1\n` + pts.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join('');
const rectLines = (x, y, w, h) => line(x, y, x+w, y) + line(x+w, y+h, x+w, y) /* reversed on purpose */ + line(x+w, y+h, x, y+h) + line(x, y, x, y+h);

const files = {
  // 30 x 20 frame, 2" rails, hole drawn as 4 separate LINEs -> one 26 x 16 opening
  'Frame (2 PCS).dxf': rectPoly(0, 0, 30, 20) + rectLines(2, 2, 26, 16),
  // 20" ring with a 16" hole -> inscribed square ~11.3" plus side pockets
  'Ring.dxf': circle(10, 10, 10) + circle(10, 10, 8),
  // 12 x 12 plate, 8 x 8 hole that already has a 4 x 4 island in it -> no opening
  'Plate.dxf': rectPoly(0, 0, 12, 12) + rectPoly(2, 2, 8, 8) + rectPoly(4, 4, 4, 4),
  // bolt holes only -> nothing usable
  'Bracket.dxf': rectPoly(0, 0, 10, 4) + circle(1, 2, 0.25) + circle(9, 2, 0.25),
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-openings-'));
const paths = Object.entries(files).map(([name, body]) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, header + body + footer);
  return p;
});

let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept('Openings test'));
await page.goto(page_url);

await page.evaluate(() => { createNewProject(); });
await page.evaluate(() => { dxfOpenModal(); });
await page.setInputFiles('#dxfFileInput', paths);
await page.waitForFunction(() => dxfReviewRows.length >= 4);

const rows = await page.evaluate(() => dxfReviewRows.map(r => ({ name: r.name, w: r.w, h: r.h, qty: r.qty, openings: r.openings, skipped: r.skippedHoles, cut: r.cut })));
const byName = Object.fromEntries(rows.map(r => [r.name, r]));
console.log(JSON.stringify(rows, null, 1));

const fr = byName['Frame'];
check(fr && fr.qty === 2 && fr.w === 30 && fr.h === 20, 'frame read as 30 x 20, qty 2');
check(fr && fr.openings.length === 1, 'frame has exactly one opening');
if (fr && fr.openings[0]){
  const o = fr.openings[0];
  check(Math.abs(o.x - 2) < 0.07 && Math.abs(o.y - 2) < 0.07 && Math.abs(o.w - 26) < 0.13 && Math.abs(o.h - 16) < 0.13 && o.w <= 26 && o.h <= 16,
    `frame opening ~26 x 16 at (2,2), never larger (got ${o.w} x ${o.h} at ${o.x},${o.y})`);
}
const ring = byName['Ring'];
const square = 16 * 16 / 2; // largest rectangle in a 16" circle: the inscribed square
check(ring && ring.openings.length >= 1 && ring.openings[0].w * ring.openings[0].h > 0.95 * square,
  `ring's biggest opening is close to the inscribed square (${ring && ring.openings[0] ? (ring.openings[0].w * ring.openings[0].h).toFixed(1) : '-'} of ${square} sq in)`);
if (ring){
  const inside = ring.openings.every(o => [[o.x, o.y], [o.x+o.w, o.y], [o.x, o.y+o.h], [o.x+o.w, o.y+o.h]]
    .every(([x, y]) => Math.hypot(x - 10, y - 10) <= 8 + 1e-6));
  check(inside, 'every ring opening corner lies inside the 16" hole');
}
check(byName['Plate'] && byName['Plate'].openings.length === 0 && byName['Plate'].skipped === 1, 'hole with a shape already inside it is left alone');
check(byName['Bracket'] && byName['Bracket'].openings.length === 0, 'bolt holes below the minimum size are ignored');
check(fr && Math.abs(fr.cut.length - 184) < 0.01 && fr.cut.pierces === 2, `frame cut path 100 + 84 = 184 in, 2 pierces (got ${fr && fr.cut.length} in, ${fr && fr.cut.pierces})`);
check(ring && Math.abs(ring.cut.length - 2 * Math.PI * 18) < 0.5 && ring.cut.pierces === 2, `ring cut path ~113.1 in, 2 pierces (got ${ring && ring.cut.length})`);
check(byName['Bracket'] && byName['Bracket'].cut.pierces === 3, 'bracket: outline + 2 bolt holes = 3 pierces (small holes still cost a pierce)');
if (shotDir) await page.screenshot({ path: path.join(shotDir, 'openings-review.png') });

await page.click('#dxfAddBtn');
const result = await page.evaluate(() => {
  sheetTypes.push({ id: nextId(), name: '48x96', width: 96, height: 48, qty: null, cost: 100 });
  parts.push({ id: nextId(), name: 'Tab', width: 6, height: 5, qty: 10, rotate: true, color: null });
  parts.push({ id: nextId(), name: 'Gusset', width: 9, height: 7, qty: 4, rotate: true, color: null });
  document.getElementById('partGap').value = '0.25';
  document.getElementById('borderGap').value = '0.5';
  saveWorkingIntoCurrentProject();
  render();
  runNesting();
  const s = strategyResults[selectedStrategyKey];
  return { bins: s.bins.map(b => ({ w: b.w, h: b.h, placements: b.placements })), unplaced: s.unplaced.length, efficiency: s.efficiency, nested: countNestedInOpenings(s.bins) };
});
check(result.unplaced === 0, 'everything placed');
check(result.nested > 0, `parts were nested into openings (${result.nested})`);
check(result.efficiency <= 100, `efficiency stays a real percentage (${result.efficiency.toFixed(1)}%)`);

// Geometry: every pair of placements is either apart by the gap, or one sits
// fully inside an opening of the other with the gap kept from the cut edge.
function geometryOk(bins, gap, border){
  const eps = 1e-6;
  let ok = true;
  const insideOpening = (host, q) => (host.openings || []).some(o => {
    const ox = host.x + o.x, oy = host.y + o.y;
    return q.x >= ox + gap - eps && q.y >= oy + gap - eps && q.x + q.w <= ox + o.w - gap + eps && q.y + q.h <= oy + o.h - gap + eps;
  });
  bins.forEach((b, bi) => {
    b.placements.forEach((p, i) => {
      if (p.x < border - eps || p.y < border - eps || p.x + p.w > b.w - border + eps || p.y + p.h > b.h - border + eps){ ok = false; console.log('outside border', bi, p.name); }
      (p.openings || []).forEach(o => { if (o.x < 0 || o.y < 0 || o.x + o.w > p.w + eps || o.y + o.h > p.h + eps){ ok = false; console.log('opening outside its part', bi, p.name); } });
      b.placements.forEach((q, j) => {
        if (j <= i) return;
        const apart = q.x >= p.x + p.w + gap - eps || p.x >= q.x + q.w + gap - eps || q.y >= p.y + p.h + gap - eps || p.y >= q.y + q.h + gap - eps;
        if (!apart && !insideOpening(p, q) && !insideOpening(q, p)){ ok = false; console.log('overlap', bi, p.name, q.name); }
      });
    });
  });
  return ok;
}
check(geometryOk(result.bins, 0.25, 0.5), 'no overlaps; nested parts keep the part gap inside their opening');

// Money check: frames on sheets just big enough for them. With openings the
// tabs ride inside the frames; without, they need a sheet of their own.
const tight = await page.evaluate(() => {
  const keep = parts.filter(p => p.name === 'Frame');
  parts = keep.concat([{ id: nextId(), name: 'Tab', width: 6, height: 5, qty: 10, rotate: true, color: null }]);
  sheetTypes = [{ id: nextId(), name: '32x22', width: 32, height: 22, qty: null, cost: 40 }];
  saveWorkingIntoCurrentProject(); render();
  runNesting();
  const on = strategyResults[selectedStrategyKey];
  const withOpenings = { sheets: on.sheets, cost: on.cost, nested: countNestedInOpenings(on.bins) };
  parts.forEach(p => { if (p.openings) p.useOpenings = false; });
  runNesting();
  const off = strategyResults[selectedStrategyKey];
  return { withOpenings, without: { sheets: off.sheets, cost: off.cost, nested: countNestedInOpenings(off.bins) } };
});
console.log(JSON.stringify(tight));
check(tight.without.nested === 0, 'unticking Fill keeps openings empty');
check(tight.withOpenings.sheets === 2 && tight.without.sheets === 3,
  `openings save a sheet: ${tight.withOpenings.sheets} sheets ($${tight.withOpenings.cost}) vs ${tight.without.sheets} ($${tight.without.cost})`);

// Global switch: the report states the saving; off nests solid rectangles;
// the setting is saved with the project; the strategy table shows both.
const sw = await page.evaluate(() => {
  parts.forEach(p => { if (p.openings) p.useOpenings = true; });
  document.getElementById('fillOpenings').checked = true;
  saveWorkingIntoCurrentProject(); render();
  runNesting();
  const on = strategyResults[selectedStrategyKey];
  const note = (document.getElementById('openingsNote') || {}).textContent || '';
  const neverWorse = Object.values(strategyResults).every(r => !r.noOpenings || r.sheets <= r.noOpenings.sheets);

  document.getElementById('fillOpenings').checked = false;
  saveWorkingIntoCurrentProject();
  runNesting();
  const off = strategyResults[selectedStrategyKey];
  const offState = { sheets: off.sheets, nested: countNestedInOpenings(off.bins), base: !!off.noOpenings, note: !!document.getElementById('openingsNote') };
  loadProjectIntoWorking(currentProjectId);
  const persisted = document.getElementById('fillOpenings').checked === false;

  document.getElementById('fillOpenings').checked = true;
  sheetTypes.push({ id: nextId(), name: '48x24', width: 48, height: 24, qty: null, cost: 70 });
  saveWorkingIntoCurrentProject(); render();
  runNesting();
  const table = document.querySelector('#results table.breakdown');
  const hasColumn = !!table && /Without openings/.test(table.querySelector('thead').textContent);
  sheetTypes = sheetTypes.filter(st => st.name === '32x22');
  saveWorkingIntoCurrentProject(); render();
  return { note, neverWorse, offState, persisted, hasColumn, onSheets: on.sheets };
});
console.log(JSON.stringify(sw));
check(/saves 1 sheet \(\$40\.00\) - 2 instead of 3/.test(sw.note), `report states the saving: "${sw.note.trim()}"`);
check(sw.neverWorse, 'with openings never needs more sheets than without, for every strategy');
check(sw.offState.sheets === 3 && sw.offState.nested === 0 && !sw.offState.base && !sw.offState.note, 'switch off: solid rectangles, 3 sheets, no saving note');
check(sw.persisted, 'switch is saved with the project');
check(sw.hasColumn, 'strategy table shows a "Without openings" column');

// Portrait sheet: the 30 x 20 frame has to turn 90deg, and so do its openings.
const turned = await page.evaluate(() => {
  parts.forEach(p => { if (p.openings) p.useOpenings = true; });
  sheetTypes = [{ id: nextId(), name: '22x32', width: 22, height: 32, qty: null, cost: 40 }];
  saveWorkingIntoCurrentProject(); render();
  runNesting();
  const s = strategyResults[selectedStrategyKey];
  return { sheets: s.sheets, nested: countNestedInOpenings(s.bins), allRotated: s.bins.every(b => b.placements.filter(p => p.name === 'Frame').every(p => p.rotated)),
           bins: s.bins.map(b => ({ w: b.w, h: b.h, placements: b.placements })) };
});
check(turned.allRotated && turned.sheets === 2 && turned.nested === 10, `rotated frames still carry the tabs (${turned.sheets} sheets, ${turned.nested} nested)`);
check(geometryOk(turned.bins, 0.25, 0.5), 'rotated openings: no overlaps, gap kept');

// Editing a part's size marks its openings stale and stops using them.
const stale = await page.evaluate(() => {
  const fr = parts.find(p => p.name === 'Frame');
  fr.useOpenings = true; fr.width = 31;
  return partOpenings(fr).length;
});
check(stale === 0, 'resized part no longer offers its old openings');

await page.evaluate(() => {
  parts.forEach(p => { if (p.openings) p.useOpenings = true; });
  parts.find(p => p.name === 'Frame').width = 30;
  sheetTypes = [{ id: nextId(), name: '32x22', width: 32, height: 22, qty: null, cost: 40 }];
  saveWorkingIntoCurrentProject(); render();
});
if (shotDir){
  await page.evaluate(() => goToStep(3));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelectorAll('.preview-modal.open').forEach(m => m.classList.remove('open')));
  const card = await page.$('.sheet-card');
  if (card) await card.screenshot({ path: path.join(shotDir, 'openings-sheet.png') });
  await page.evaluate(() => goToStep(1));
  const tbl = await page.$('#partsBody');
  if (tbl) await tbl.screenshot({ path: path.join(shotDir, 'openings-parts.png') });
}

// ---- hand-typed parts (no DXF) --------------------------------------
// Paste rows: a 5th value is the frame rail width.
const pasted = await page.evaluate(() => {
  parts = []; sheetTypes = [{ id: nextId(), name: '32x22', width: 32, height: 22, qty: null, cost: 40 }];
  saveWorkingIntoCurrentProject(); render();
  document.getElementById('bulkPaste').value = 'Window frame, 30, 20, 2, rail 2\nTab, 6, 5, 10\nShelf, 24, 18, 1, 0.75';
  document.getElementById('parseBulk').click();
  const fr = parts.find(p => p.name === 'Window frame');
  const shelf = parts.find(p => p.name === 'Shelf').openings;
  parts = parts.filter(p => p.name !== 'Shelf');   // only here to test the paste
  saveWorkingIntoCurrentProject(); render();
  runNesting();
  const s = strategyResults[selectedStrategyKey];
  return { openings: fr.openings, plain: parts.find(p => p.name === 'Tab').openings, shelf, sheets: s.sheets, nested: countNestedInOpenings(s.bins) };
});
check(JSON.stringify(pasted.openings) === JSON.stringify([{ x: 2, y: 2, w: 26, h: 16 }]) && pasted.plain === undefined,
  'pasted "name, w, h, qty, rail 2" becomes a frame; 4-column rows stay plain');
check(pasted.shelf === undefined, 'a bare numeric 5th column (e.g. thickness) does not make a frame');
check(pasted.sheets === 2 && pasted.nested === 10, `pasted frames carry the tabs (${pasted.sheets} sheets, ${pasted.nested} nested)`);

// Editor, driven through the UI: a plain part becomes a frame.
await page.evaluate(() => {
  parts = [{ id: nextId(), name: 'Gate', width: 40, height: 24, qty: 1, rotate: true, color: null }];
  saveWorkingIntoCurrentProject(); render(); goToStep(1);
});
await page.click('#partsBody [data-open-edit]');
await page.fill('#opRail', '3');
await page.click('#opMakeFrame');
if (shotDir) await page.screenshot({ path: path.join(shotDir, 'openings-editor.png') });
await page.click('#opSaveBtn');
const gate = await page.evaluate(() => ({ o: parts[0].openings, base: parts[0].openingsBase, open: document.getElementById('openingsModal').classList.contains('open') }));
check(!gate.open && JSON.stringify(gate.o) === JSON.stringify([{ x: 3, y: 3, w: 34, h: 18 }]) && gate.base.w === 40,
  'editor: "Make frame" with 3" rails saves one 34 x 18 opening');

// Validation: overlapping and out-of-bounds openings can't be saved.
const bad = await page.evaluate(() => [
  validateOpenings([{ x: 1, y: 1, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }], 40, 24),
  validateOpenings([{ x: 35, y: 1, w: 10, h: 5 }], 40, 24),
  validateOpenings([{ x: 1, y: 1, w: 10, h: 10 }, { x: 11, y: 1, w: 10, h: 10 }], 40, 24),
]);
check(/overlap/.test(bad[0]) && /outside/.test(bad[1]) && bad[2] === '', 'editor rejects overlaps and out-of-bounds, accepts touching openings');
await page.click('#partsBody [data-open-edit]');
await page.click('#opAddRow');
await page.fill('#opBody tr[data-i="1"] input[data-k="x"]', '0');
const disabled = await page.evaluate(() => document.getElementById('opSaveBtn').disabled);
check(disabled, 'Save is disabled while openings overlap');
await page.click('#opCancelBtn');

// Resize makes the openings stale; re-fitting in the editor revives them.
const refit = await page.evaluate(() => {
  const g = parts[0]; g.width = 44; render();
  const staleBefore = partOpenings(g).length === 0 && !!document.querySelector('#partsBody .fill-stale');
  openOpeningsEditor(g);
  document.getElementById('opRail').value = '3';
  document.getElementById('opMakeFrame').click();
  document.getElementById('opSaveBtn').click();
  return { staleBefore, after: partOpenings(g) };
});
check(refit.staleBefore && refit.after.length === 1 && refit.after[0].w === 38, 'stale openings are re-fitted from the editor');

// Openings survive a project JSON round-trip.
const roundTrip = await page.evaluate(() => {
  const p = sanitizeImportedPart(JSON.parse(JSON.stringify(parts[0])), 0);
  return partOpenings(p).length === 1 && p.openingsBase.w === 44;
});
check(roundTrip, 'openings survive export/import');

// ---- regressions from code review ---------------------------------
const rv = await page.evaluate(async () => {
  const out = {};
  // An empty frame interior is not offered as a sheet remnant.
  parts = [{ id: nextId(), name: 'Big frame', width: 40, height: 30, qty: 1, rotate: true, color: null }];
  setPartOpenings(parts[0], [frameOpening(40, 30, 2)]);
  sheetTypes = [{ id: nextId(), name: '48x96', width: 96, height: 48, qty: null, cost: 100 }];
  document.getElementById('fillOpenings').checked = true;
  saveWorkingIntoCurrentProject(); render(); runNesting();
  const bins = strategyResults[selectedStrategyKey].bins;
  out.openingFree = bins[0].freeRects.some(r => r.inOpening);
  out.remnantInFrame = findRemnants(bins, 6).some(r => Math.abs(r.w - 35.75) < 0.01 && Math.abs(r.h - 25.75) < 0.01);
  // Imported openings without the size they were measured at are dropped;
  // the string "false" stays off.
  const noBase = sanitizeImportedPart({ name: 'x', width: 30, height: 20, qty: 1, openings: [{ x: 2, y: 2, w: 26, h: 16 }] }, 0);
  const strOff = sanitizeImportedPart({ name: 'y', width: 30, height: 20, qty: 1, openings: [{ x: 2, y: 2, w: 26, h: 16 }], openingsBase: { w: 30, h: 20 }, useOpenings: 'false' }, 0);
  out.noBaseDropped = noBase.openings === undefined && partOpenings(noBase).length === 0;
  out.strOff = strOff.useOpenings === false && partOpenings(strOff).length === 0;
  // Saving in the editor keeps a deliberately unticked Fill box unticked.
  parts[0].useOpenings = false;
  setPartOpenings(parts[0], [frameOpening(40, 30, 3)]);
  out.keptOff = parts[0].useOpenings === false && parts[0].openings[0].w === 34;
  // An opening across the whole part is refused.
  out.fullSpan = /full width/.test(validateOpenings([{ x: 0, y: 5, w: 40, h: 10 }], 40, 30));
  // Try harder: the comparison is searched as hard as the result, so it
  // never ends up claiming openings cost a sheet.
  parts = [{ id: nextId(), name: 'Frame', width: 30, height: 20, qty: 2, rotate: true, color: null },
           { id: nextId(), name: 'Tab', width: 6, height: 5, qty: 10, rotate: true, color: null }];
  setPartOpenings(parts[0], [frameOpening(30, 20, 2)]);
  sheetTypes = [{ id: nextId(), name: '32x22', width: 32, height: 22, qty: null, cost: 40 }];
  saveWorkingIntoCurrentProject(); render(); runNesting();
  tryHarder(0.25, 0.5, 2);
  await new Promise(r => setTimeout(r, 1500));
  const s = strategyResults[selectedStrategyKey];
  out.afterTry = { sheets: s.sheets, base: s.noOpenings && s.noOpenings.sheets };
  out.neverNegative = Object.values(strategyResults).every(r => !r.noOpenings || r.noOpenings.costScore >= costScore(r, sheetTypes));
  return out;
});
console.log(JSON.stringify(rv));
check(rv.openingFree && !rv.remnantInFrame, 'an empty frame interior is not listed as a reusable sheet remnant');
check(rv.noBaseDropped && rv.strOff, 'imported openings need their measured size; "false" stays off');
check(rv.keptOff, 'editor save keeps an unticked Fill box unticked');
check(rv.fullSpan, 'an opening spanning the full width is refused');
check(rv.afterTry.sheets === 2 && rv.afterTry.base === 3 && rv.neverNegative, `after Try harder the comparison stays honest (${rv.afterTry.sheets} vs ${rv.afterTry.base} without)`);

// "Smallest useful opening" of 0 means the 0.25" floor, not the 1" default.
await page.evaluate(() => { dxfOpenModal(); document.getElementById('dxfMinOpening').value = '0'; });
await page.setInputFiles('#dxfFileInput', paths.filter(p => /Bracket/.test(p)));
await page.waitForFunction(() => dxfReviewRows.length >= 1);
const tiny = await page.evaluate(() => { const r = dxfReviewRows[0]; document.getElementById('dxfModal').classList.remove('open'); return r.openings.length; });
check(tiny > 0, `min opening 0 keeps small cut-outs (bracket holes found: ${tiny})`);

// ---- randomised jobs (seeded, so a failure is reproducible) ------------
// Random sheets, stock limits, gaps, rotation and frames; every strategy of
// every job must be geometrically sound and account for every part.
const fuzz = await page.evaluate(() => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const realRandom = Math.random;
  Math.random = rnd;
  const pick = (a, b) => a + rnd() * (b - a);
  const q16 = v => Math.round(v * 16) / 16;
  const report = { jobs: 0, strategies: 0, problems: [], nested: 0, saved: 0, slowestMs: 0 };
  try {
    for (let job = 0; job < 40; job++){
      sheetTypes = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => ({
        id: nextId(), name: 'S' + i, width: q16(pick(36, 96)), height: q16(pick(24, 60)),
        qty: rnd() < 0.3 ? 1 + Math.floor(rnd() * 3) : null, cost: rnd() < 0.8 ? Math.round(pick(30, 200)) : null }));
      parts = Array.from({ length: 2 + Math.floor(rnd() * 6) }, (_, i) => ({
        id: nextId(), name: 'P' + i, width: q16(pick(2, 34)), height: q16(pick(2, 22)),
        qty: 1 + Math.floor(rnd() * 8), rotate: rnd() < 0.7, color: null }));
      parts.forEach(p => { if (rnd() < 0.35){ const f = frameOpening(p.width, p.height, q16(pick(0.75, 4))); if (f) setPartOpenings(p, [f]); } });
      const gap = q16(pick(0, 0.5)), border = q16(pick(0, 1));
      document.getElementById('partGap').value = gap;
      document.getElementById('borderGap').value = border;
      document.getElementById('fillOpenings').checked = rnd() < 0.85;
      qualitySlider.value = String(Math.floor(rnd() * 3));
      saveWorkingIntoCurrentProject(); render();
      const t = performance.now();
      runNesting();
      report.slowestMs = Math.max(report.slowestMs, performance.now() - t);
      report.jobs++;
      const requested = parts.reduce((a, p) => a + p.qty, 0);
      Object.entries(strategyResults).forEach(([k, r]) => {
        report.strategies++;
        const placed = r.bins.reduce((a, b) => a + b.placements.length, 0);
        if (placed + r.unplaced.length !== requested) report.problems.push(`job ${job} ${k}: ${placed}+${r.unplaced.length} != ${requested}`);
        if (r.efficiency > 100 + 1e-6) report.problems.push(`job ${job} ${k}: efficiency ${r.efficiency}`);
        if (r.noOpenings && r.noOpenings.costScore < costScore(r, sheetTypes) - 1e-6) report.problems.push(`job ${job} ${k}: comparison beats result`);
        const use = {}; r.bins.forEach(b => use[b.sheetType.id] = (use[b.sheetType.id] || 0) + 1);
        sheetTypes.forEach(st => { if (st.qty != null && (use[st.id] || 0) > st.qty) report.problems.push(`job ${job} ${k}: stock exceeded on ${st.name}`); });
        r.bins.forEach(b => b.placements.forEach(p => {
          const def = parts.find(d => d.id === p.defId);
          if (p.rotated && def && !def.rotate) report.problems.push(`job ${job} ${k}: ${p.name} rotated but Rot is off`);
        }));
        report.nested += countNestedInOpenings(r.bins);
        const sv = openingsSaving(r); if (sv && sv.sheetsSaved > 0) report.saved += sv.sheetsSaved;
        report.bins = (report.bins || []).concat([{ gap, border, bins: r.bins.map(b => ({ w: b.w, h: b.h, placements: b.placements })) }]);
      });
    }
  } finally { Math.random = realRandom; }
  return report;
});
const fuzzGeom = fuzz.bins.every(j => geometryOk(j.bins, j.gap, j.border));
console.log(`fuzz: ${fuzz.jobs} jobs, ${fuzz.strategies} strategies, ${fuzz.nested} parts nested, ${fuzz.saved} sheets saved, slowest ${Math.round(fuzz.slowestMs)} ms`);
fuzz.problems.slice(0, 10).forEach(p => console.log('  ' + p));
check(fuzz.problems.length === 0, `random jobs: every part accounted for, stock limits and Rot respected, comparison honest (${fuzz.problems.length} problems)`);
check(fuzzGeom, 'random jobs: no overlaps, gaps and borders kept, nested parts inside their openings');
check(fuzz.slowestMs < 3000, `random jobs: slowest nest ${Math.round(fuzz.slowestMs)} ms`);

// ---- split mode: containment, not bounding boxes ---------------------
// A layout DXF: a frame with two tabs already drawn in its hole, three
// identical squares, and two interlocking L brackets whose boxes overlap.
const layout = path.join(tmp, 'Layout.dxf');
fs.writeFileSync(layout, header
  + rectPoly(0, 0, 30, 20) + rectLines(2, 2, 26, 16)
  + rectPoly(4, 4, 6, 5) + rectPoly(12, 4, 6, 5)
  + rectPoly(40, 0, 4, 4) + rectPoly(46, 0, 4, 4) + rectPoly(52, 0, 4, 4)
  + poly([[60, 0], [70, 0], [70, 2], [62, 2], [62, 10], [60, 10]])
  + poly([[64, 4], [72, 4], [72, 12], [70, 12], [70, 6], [64, 6]])
  + footer);
// An outline left open (three sides) around a round hole: the loops can't
// be trusted as parts, so it stays one part, as before.
const openOutline = path.join(tmp, 'Open outline.dxf');
fs.writeFileSync(openOutline, header + line(0, 0, 20, 0) + line(20, 0, 20, 12) + line(20, 12, 0, 12) + circle(10, 6, 4) + footer);
const importRows = async (files, split) => {
  await page.evaluate(sp => { dxfOpenModal(); document.getElementById('dxfSplitLoops').checked = sp; document.getElementById('dxfMinOpening').value = '1'; }, split);
  await page.setInputFiles('#dxfFileInput', files);
  await page.waitForFunction(n => dxfReviewRows.length >= n, files.length);
  await page.waitForTimeout(150);
  return page.evaluate(() => dxfReviewRows.map(r => ({ name: r.name, w: r.w, h: r.h, qty: r.qty, merged: r.merged, openings: r.openings.length, skipped: r.skippedHoles })));
};
const splitRows = await importRows([layout], true);
console.log(JSON.stringify(splitRows));
const find = (w, h) => splitRows.find(r => (r.w === w && r.h === h) || (r.w === h && r.h === w));
check(splitRows.length === 5, `split layout gives 5 rows (got ${splitRows.length})`);
check(find(30, 20) && find(30, 20).openings === 1 && find(30, 20).skipped === 0, 'frame with parts drawn in its hole: split off from them, and its hole becomes a usable opening');
check(find(6, 5) && find(6, 5).qty === 2 && find(6, 5).merged === 2, 'the two tabs drawn inside the hole are one row, qty 2');
check(find(4, 4) && find(4, 4).qty === 3, 'three identical squares are one row, qty 3');
check(find(10, 10) && find(8, 8), 'interlocking L brackets with overlapping boxes are separate parts');
const mergedNote = await page.evaluate(() => /Identical shapes combined/.test(document.getElementById('dxfDiagnostics').textContent));
check(mergedNote, 'review modal says which identical shapes were combined');
await page.evaluate(() => { parts = []; });
await page.click('#dxfAddBtn');
const laid = await page.evaluate(() => {
  sheetTypes = [{ id: nextId(), name: '32x22', width: 32, height: 22, qty: null, cost: 40 }];
  parts = parts.filter(p => p.width <= 30 && p.height <= 20);
  document.getElementById('fillOpenings').checked = true;
  document.getElementById('partGap').value = '0.25'; document.getElementById('borderGap').value = '0.5';
  saveWorkingIntoCurrentProject(); render(); runNesting();
  const s = strategyResults[selectedStrategyKey];
  return { sheets: s.sheets, nested: countNestedInOpenings(s.bins), unplaced: s.unplaced.length };
});
check(laid.sheets === 1 && laid.unplaced === 0 && laid.nested >= 5, `split layout nests back into one sheet with the small parts in the frame (${laid.nested} nested)`);

const wholeRows = await importRows([layout], false);
check(wholeRows.length === 1 && wholeRows[0].w === 72 && wholeRows[0].h === 20, 'split off: the whole file is still one part');
const openRows = await importRows([openOutline], true);
check(openRows.length === 1 && openRows[0].w === 20 && openRows[0].h === 12 && openRows[0].openings === 0, 'an outline that never closes is not split apart by its hole');
// Outline drawn as 4 separate LINEs around a round hole: one part with an
// opening (the bounding-box split used to make the hole a part of its own).
const lineFrame = path.join(tmp, 'Line frame.dxf');
fs.writeFileSync(lineFrame, header + rectLines(0, 0, 24, 24) + circle(12, 12, 9) + footer);
const lineRows = await importRows([lineFrame], true);
check(lineRows.length === 1 && lineRows[0].w === 24 && lineRows[0].openings >= 1, `LINE-drawn outline with a round hole stays one part with its opening (${lineRows.length} row, ${lineRows[0] && lineRows[0].openings} openings)`);
await page.evaluate(() => document.getElementById('dxfModal').classList.remove('open'));

// ---- cut path in the report ---------------------------------------------
const cutRes = await page.evaluate(() => {
  parts = [{ id: nextId(), name: 'Typed frame', width: 30, height: 20, qty: 2, rotate: true, color: null },
           { id: nextId(), name: 'Tab', width: 6, height: 5, qty: 10, rotate: true, color: null }];
  setPartOpenings(parts[0], [frameOpening(30, 20, 2)]);
  sheetTypes = [{ id: nextId(), name: '32x22', width: 32, height: 22, qty: null, cost: 40 }];
  document.getElementById('fillOpenings').checked = true;
  document.getElementById('partGap').value = '0.25'; document.getElementById('borderGap').value = '0.5';
  ['cutSpeed', 'pierceSec', 'laserRate'].forEach(id => document.getElementById(id).value = '');
  saveWorkingIntoCurrentProject(); render(); runNesting();
  const est = partCut(parts[0]);
  const noRates = (document.getElementById('cutNote') || {}).textContent || '';
  const noStat = !/Est\. cutting/.test(document.getElementById('reportBody').textContent);
  // 2 x 184 + 10 x 22 = 588 in; 2 x 2 + 10 = 14 pierces
  document.getElementById('cutSpeed').value = '200';
  document.getElementById('pierceSec').value = '1';
  document.getElementById('laserRate').value = '120';
  document.getElementById('laserRate').dispatchEvent(new Event('input'));
  const t = cutTotals(strategyResults[selectedStrategyKey].bins);
  const withRates = (document.getElementById('cutNote') || {}).textContent || '';
  const stat = /Est\. cutting/.test(document.getElementById('reportBody').textContent);
  loadProjectIntoWorking(currentProjectId);
  const kept = document.getElementById('cutSpeed').value === '200' && document.getElementById('laserRate').value === '120';
  // A resized DXF part falls back to the estimate.
  const dxfPart = { width: 30, height: 20, cut: { length: 250, pierces: 5, w: 30, h: 20 } };
  const real = partCut(dxfPart).length === 250, resized = partCut(Object.assign({}, dxfPart, { width: 31 })).estimated;
  return { est, noRates, noStat, t, withRates, stat, kept, real, resized };
});
console.log(JSON.stringify({ t: cutRes.t, withRates: cutRes.withRates }));
check(cutRes.est.length === 184 && cutRes.est.pierces === 2 && cutRes.est.estimated, 'typed-in frame: cut estimated from rectangle + opening (184 in, 2 pierces)');
check(/Cut path 588 in \(49\.0 ft\), 14 pierces/.test(cutRes.noRates) && cutRes.noStat, 'report totals cut path and pierces of the nested parts; no cost without rates');
// 588/200 = 2.94 min + 14 s = 3.173 min -> $6.35 at $120/h
check(Math.abs(cutRes.t.minutes - 3.1733) < 0.001 && Math.abs(cutRes.t.cost - 6.35) < 0.01 && /3\.2 min of machine time = \$6\.35/.test(cutRes.withRates) && cutRes.stat,
  `with rates: machine time and cutting cost (${cutRes.t.minutes && cutRes.t.minutes.toFixed(2)} min, $${cutRes.t.cost && cutRes.t.cost.toFixed(2)})`);
check(cutRes.kept, 'laser rates are saved with the project');
check(cutRes.real && cutRes.resized, 'DXF cut path is used as read, and falls back to the estimate after a resize');

// The PDF path draws the same sheets through drawSheet(); make sure it still builds.
const pdfBytes = await page.evaluate(async () => {
  sheetTypes = [{ id: nextId(), name: '48x96', width: 96, height: 48, qty: null, cost: 100 }];
  document.getElementById('bulkPaste').value = 'Tab, 6, 5, 10';
  document.getElementById('parseBulk').click();
  runNesting();
  for (const mode of ['report', 'overview']){
    const doc = await buildNestingPdf(mode);
    if (!doc) return 0;
    if (mode === 'overview') return doc.output('arraybuffer').byteLength;
  }
});
check(pdfBytes > 10000, `PDF export builds (${Math.round(pdfBytes/1024)} KB)`);

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
