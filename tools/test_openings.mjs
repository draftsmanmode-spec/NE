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

const fmtMoneyNode = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const has = (t, ...w) => w.every(x => t.includes(x)), lacks = (t, ...w) => w.every(x => !t.includes(x));
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

// ---- quote letterhead, per-part prices, shop sign-off, CSV cut list ------
const qt = await page.evaluate(async () => {
  const out = {};
  parts = [{ id: nextId(), name: 'Gate, frame', width: 30, height: 20, qty: 2, rotate: true, color: null },
           { id: nextId(), name: 'Tab', width: 6, height: 5, qty: 10, rotate: true, color: null }];
  setPartOpenings(parts[0], [frameOpening(30, 20, 2)]);
  sheetTypes = [{ id: nextId(), name: '32x22', width: 32, height: 22, qty: null, cost: 40 }];
  document.getElementById('markupPct').value = '20';
  // Company details are one profile for every project; quote fields are per project.
  document.getElementById('bizCompany').value = 'Acme Metal Works';
  document.getElementById('bizContact').value = '555-0100 · quotes@acme.test';
  document.getElementById('bizAddress').value = '1 Forge Rd, Steelton';
  document.getElementById('bizTerms').value = 'Net 30. Material subject to availability.';
  document.getElementById('bizValidDays').value = '14';
  ['bizCompany','bizContact','bizAddress','bizTerms','bizValidDays'].forEach(id => document.getElementById(id).dispatchEvent(new Event('input')));
  // A tiny red logo.
  const c = document.createElement('canvas'); c.width = 40; c.height = 20;
  const g = c.getContext('2d'); g.fillStyle = '#c00'; g.fillRect(0, 0, 40, 20);
  business.logo = c.toDataURL('image/png'); business.logoW = 40; business.logoH = 20; saveBusiness(); syncLogoUI();
  document.getElementById('quoteCustomer').value = 'Bob Builder';
  document.getElementById('quoteNumber').value = '';
  document.getElementById('quotePartPrices').checked = true;
  saveWorkingIntoCurrentProject(); render(); runNesting();
  const t1 = [], d1 = await buildNestingPdf('report', 'customer', t1);
  out.cust = t1.join(' | ');
  out.images = (d1.output().match(/\/Subtype \/Image/g) || []).length;
  out.autoNumber = autoQuoteNumber(getProject(currentProjectId));
  document.getElementById('quotePartPrices').checked = false;
  const t2 = []; await buildNestingPdf('report', 'customer', t2);
  out.custNoParts = t2.join(' | ');
  document.getElementById('quotePartPrices').checked = true;
  const t3 = []; await buildNestingPdf('report', 'shop', t3);
  out.shop = t3.join(' | ');
  out.csv = buildCutListCsv();
  // persistence
  document.getElementById('quoteCustomer').value = 'Carol'; saveWorkingIntoCurrentProject();
  loadProjectIntoWorking(currentProjectId);
  out.keptCustomer = document.getElementById('quoteCustomer').value;
  loadBusiness();
  out.keptCompany = document.getElementById('bizCompany').value;
  out.keptLogo = !!business.logo;
  business.logo = null; saveBusiness();
  document.getElementById('markupPct').value = ''; saveWorkingIntoCurrentProject();
  return out;
});
check(has(qt.cust, 'Acme Metal Works', '555-0100 · quotes@acme.test', '1 Forge Rd, Steelton', 'Quotation', qt.autoNumber, 'VALID UNTIL', 'PREPARED FOR', 'Bob Builder', 'Terms', 'Net 30.')
  && qt.images >= 1, `customer quote letterhead: company, contact, logo, quote ${qt.autoNumber}, valid-until, customer, terms`);
check(has(qt.cust, 'Unit price') && lacks(qt.custNoParts, 'Unit price') && has(qt.custNoParts, 'Material'), 'per-part prices can be switched off (then material / cutting lines)');
check(has(qt.shop, 'Cut by', 'Checked') && lacks(qt.shop, '$'), 'shop sheets carry a sign-off line (and still no prices)');
const csvRows = qt.csv.replace(/^﻿/, '').trim().split('\r\n');
check(csvRows[0] === 'Sheet,Material,Sheet W,Sheet H,Tag,Part,W,H,X from left,Y from top,Rotated,Inside opening of' && csvRows.length === 13
  && csvRows.some(r => r.includes('"Gate, frame"')) && csvRows.filter(r => /,#1$/.test(r)).length === 10,
  `CSV cut list: header, 12 placements, quoted names, tabs marked inside frame #1 (${csvRows.length - 1} rows)`);
check(qt.keptCustomer === 'Carol' && qt.keptCompany === 'Acme Metal Works' && qt.keptLogo, 'quote fields saved per project; company details and logo saved once');

// Hundreds of tiny parts on one cheap sheet: whole-cent allocation keeps the
// quote exact (rounding each unit price to the cent would make it $0.00).
const washers = await page.evaluate(() => {
  parts = [{ id: nextId(), name: 'Washer', width: 1, height: 1, qty: 400, rotate: true, color: null }];
  sheetTypes = [{ id: nextId(), name: '24x24', width: 24, height: 24, qty: null, cost: 4 }];
  document.getElementById('markupPct').value = '20';
  ['cutSpeed', 'pierceSec', 'laserRate'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('partGap').value = '0.1'; document.getElementById('borderGap').value = '0.2';
  saveWorkingIntoCurrentProject(); render(); runNesting();
  const s = strategyResults[selectedStrategyKey], c = jobCosts(s, s.bins);
  document.getElementById('markupPct').value = ''; saveWorkingIntoCurrentProject();
  return { sheets: s.sheets, quote: c.quote, lineTotal: c.lines[0].total, unit: fmtUnitPrice(c.lines[0].unit) };
});
check(washers.sheets === 1 && washers.quote === 4.8 && washers.lineTotal === 4.8 && washers.unit === '$0.0120', `400 tiny parts on a $4 sheet at 20%: quote $4.80, unit price ${washers.unit}`);

// ---- money, oversized parts, big jobs, export audiences ----------------
const ex = await page.evaluate(async () => {
  const out = {};
  parts = [{ id: nextId(), name: 'Typed frame', width: 30, height: 20, qty: 2, rotate: true, color: null },
           { id: nextId(), name: 'Tab', width: 6, height: 5, qty: 10, rotate: true, color: null },
           { id: nextId(), name: 'Monster', width: 200, height: 100, qty: 1, rotate: true, color: null }];
  setPartOpenings(parts[0], [frameOpening(30, 20, 2)]);
  sheetTypes = [{ id: nextId(), name: '32x22', width: 32, height: 22, qty: null, cost: 40 }];
  document.getElementById('fillOpenings').checked = true;
  document.getElementById('markupPct').value = '35';
  reportPrefs.quoting = true; syncAudienceUI();
  document.getElementById('cutSpeed').value = '200'; document.getElementById('pierceSec').value = '1'; document.getElementById('laserRate').value = '120';
  saveWorkingIntoCurrentProject(); render(); runNesting();
  let s = strategyResults[selectedStrategyKey];
  out.nest = { sheets: s.sheets, unplaced: s.unplaced.length, strategies: Object.keys(strategyResults).length };
  out.oversizedNote = (document.getElementById('oversizedNote') || {}).textContent || '';
  const c = jobCosts(s, s.bins);
  out.costs = { material: c.material, cutting: +c.cutting.toFixed(4), quote: +c.quote.toFixed(4), lines: c.lines, fmt: fmtMoney(c.quote) };
  out.quoteOnScreen = document.getElementById('reportBody').textContent.includes(fmtMoney(c.quote));
  // Quoting tools off: no quote figure and no markup field on screen.
  reportPrefs.quoting = false; syncAudienceUI(); rerenderResults();
  out.quoteHiddenOff = !document.getElementById('reportBody').textContent.includes(fmtMoney(c.quote))
    && document.getElementById('markupRow').style.display === 'none';
  tryHarder(0.25, 0.5, 2);
  await new Promise(r => setTimeout(r, 1500));
  s = strategyResults[selectedStrategyKey];
  out.afterTry = { unplaced: s.unplaced.length, note: (document.getElementById('tryHarderNote') || {}).textContent || '' };
  for (const aud of ['internal', 'shop', 'customer']){
    const trace = [];
    const doc = await buildNestingPdf('report', aud, trace);
    out[aud] = { text: trace.join(' | '), links: (doc.output().match(/\/Subtype \/Link/g) || []).length, pages: doc.getNumberOfPages() };
  }
  // Big job under a deliberately tiny time budget: still a complete,
  // valid result, and the report says the search was cut short.
  const saved = SEARCH_BUDGET_MS[2];
  SEARCH_BUDGET_MS[2] = 60;
  try {
    parts = Array.from({ length: 12 }, (_, i) => ({ id: nextId(), name: 'B' + i, width: 3 + i, height: 2 + (i % 5), qty: 35, rotate: true, color: null }));
    sheetTypes = [{ id: nextId(), name: '48x96', width: 96, height: 48, qty: null, cost: 100 }, { id: nextId(), name: '60x120', width: 120, height: 60, qty: null, cost: 160 }];
    qualitySlider.value = '2';
    saveWorkingIntoCurrentProject(); render(); runNesting();
    const r = strategyResults[selectedStrategyKey];
    out.big = { complete: r.bins.reduce((a, b) => a + b.placements.length, 0) + r.unplaced.length === 420,
                note: (document.getElementById('searchNote') || {}).textContent || '' };
  } finally { SEARCH_BUDGET_MS[2] = saved; }
  document.getElementById('markupPct').value = '';
  ['cutSpeed', 'pierceSec', 'laserRate'].forEach(id => document.getElementById(id).value = '');
  saveWorkingIntoCurrentProject();
  return out;
});
console.log(JSON.stringify({ nest: ex.nest, costs: ex.costs, afterTry: ex.afterTry, big: ex.big, links: [ex.internal.links, ex.shop.links, ex.customer.links] }));
check(ex.nest.sheets === 2 && ex.nest.unplaced === 1 && ex.nest.strategies > 0 && /Monster/.test(ex.oversizedNote),
  'a part too big for every sheet is held back and named; everything else still nests');
check(/No better layout/.test(ex.afterTry.note) && ex.afterTry.unplaced === 1, 'Try harder does not count the held-back part as an improvement');
// 2 sheets x $40 = $80; 588 in / 200 + 14 s = 3.1733 min x $120/h = $6.3467; x 1.35
// Quote = sum of per-part lines (each unit price rounded first), within a few
// cents of (material + cutting) x markup = ($80 + $6.35) x 1.35 = $116.57.
const lc = l => Math.round(l * 100);
const linesOk = ex.costs.lines.every(l => Math.abs(l.unit * l.qty - l.total) < 1e-9);
const linesSum = ex.costs.lines.reduce((a, l) => a + lc(l.total), 0);
check(ex.costs.material === 80 && ex.costs.cutting === 6.35 && linesOk && linesSum === lc(ex.costs.quote) && ex.costs.quote === 116.57 && ex.quoteOnScreen && ex.quoteHiddenOff,
  `customer quote = ($80 + $6.35) x 1.35 = ${ex.costs.fmt}, its part lines add up to it exactly, shown only with quoting tools on (${ex.costs.lines.map(l => l.qty + ' parts $' + l.total.toFixed(2)).join(' + ')})`);
check(ex.costs.lines.every(l => ex.customer.text.includes(fmtMoneyNode(l.total))) && ex.customer.text.includes('Unit price'),
  'customer PDF prints every line total');
check(has(ex.internal.text, 'Costs', 'Laser cutting', 'Markup 35%', 'Customer quote', ex.costs.fmt, 'EFFICIENCY', 'Monster'),
  'internal PDF: full cost breakdown, efficiency and warnings');
check(has(ex.customer.text, 'Quotation', 'QUOTE TOTAL', ex.costs.fmt, 'Not included in this quote: Monster x 1', '2 | PART TYPES')
  && lacks(ex.customer.text, 'Markup', 'MARKUP', 'EFFICIENCY', 'Cut order', '$80.00', '#1', 'Sheet 1', 'Monster (') && ex.customer.pages === 1 && ex.customer.links === 0,
  'customer PDF: price and parts only - no markup, efficiency, internal cost, tags or sheets');
check(has(ex.shop.text, 'Cut sheets', 'Material to pull', 'Cut order', 'Back to summary', 'Sheet 1 of 2') && lacks(ex.shop.text, '$', 'Markup', 'EFFICIENCY'),
  'shop PDF: cut sheets, material to pull and cut order - no prices anywhere');
check(has(ex.shop.text, 'not to scale') && has(ex.internal.text, 'not to scale') && lacks(ex.customer.text, 'not to scale'), 'shop and internal PDFs say drawings are not to scale');
check(has(ex.internal.text, '| Material |', 'Used'), 'internal PDF keeps the material breakdown (Report sections > Material breakdown)');
check(ex.shop.links === 4 && ex.internal.links === 4, 'sheet index rows and "Back to summary" are live links (2 + 2)');
check(ex.big.complete && /compared \d+ of \d+ candidate layouts/.test(ex.big.note), 'big job under a time budget: complete result, and the report says the search was cut short');

// ---- shop-floor layout editing ----------------------------------------------
// Helpers in the page: the layout as plain data, and its invariants.
await page.evaluate(() => {
  window.__layout = () => {
    const s = strategyResults[selectedStrategyKey];
    return JSON.stringify(s.bins.map(b => [b.sheetType.id, b.placements.map(p => [p.defId, +p.x.toFixed(4), +p.y.toFixed(4), p.rotated])]));
  };
  window.__check = () => {
    const s = strategyResults[selectedStrategyKey], problems = [];
    const count = {};
    s.bins.forEach(b => b.placements.forEach(p => { count[p.defId] = (count[p.defId] || 0) + 1; }));
    s.unplaced.forEach(u => { count[u.defId] = (count[u.defId] || 0) + 1; });
    parts.forEach(p => { if ((count[p.id] || 0) !== p.qty) problems.push(p.name + ' count ' + (count[p.id] || 0) + ' != ' + p.qty); });
    sheetTypes.forEach(st => { const n = s.bins.filter(b => b.sheetType.id === st.id).length; if (st.qty != null && n > st.qty) problems.push('stock ' + st.name); });
    if (s.sheets !== s.bins.length) problems.push('sheet count stale');
    return { problems, bins: s.bins.map(b => ({ w: b.w, h: b.h, placements: b.placements })), gap: lastRunParams.partGap, border: lastRunParams.borderGap };
  };
});
const layoutOk = async (label) => {
  const r = await page.evaluate(() => window.__check());
  const ok = r.problems.length === 0 && geometryOk(r.bins, r.gap, r.border);
  if (!ok) console.log('  layout problems after ' + label + ':', r.problems);
  return ok;
};
await page.evaluate(() => {
  parts = [];
  document.getElementById('bulkPaste').value = 'Gate frame, 40, 30, 2, rail 3\nTab, 6, 5, 16\nGusset, 9, 7, 8\nStrip, 36, 3, 6\nBase plate, 44, 40, 3';
  document.getElementById('parseBulk').click();
  sheetTypes = [{ id: nextId(), name: '48x96', width: 96, height: 48, qty: null, cost: 185 }];
  document.getElementById('partGap').value = '0.25'; document.getElementById('borderGap').value = '0.5';
  document.getElementById('fillOpenings').checked = true;
  saveWorkingIntoCurrentProject(); render(); goToStep(3);
});
await page.waitForTimeout(400);
const noPopup = await page.evaluate(() => !document.getElementById('previewModal').classList.contains('open'));
check(noPopup, 'Results opens straight on the report (no preview popup)');
const sheetsBefore = await page.evaluate(() => strategyResults[selectedStrategyKey].bins.length);
// Tap a part on the last sheet, then the big "Sheet 1" button.
const tapPart = async (sheetIdx, plIdx) => {
  const c = (await page.$$('.sheet-canvas'))[sheetIdx];
  await c.scrollIntoViewIfNeeded();
  const f = await page.evaluate(([si, pi]) => { const b = strategyResults[selectedStrategyKey].bins[si]; const p = b.placements[pi]; return [(p.x + p.w / 2) / b.w, (p.y + p.h / 2) / b.h]; }, [sheetIdx, plIdx]);
  const box = await c.boundingBox();
  await page.mouse.click(box.x + box.width * f[0], box.y + box.height * f[1]);
};
// A small part from a full sheet, moved to the sheet with the most room.
const pick = await page.evaluate(() => {
  const bins = strategyResults[selectedStrategyKey].bins;
  const used = b => b.placements.reduce((a, p) => a + p.w * p.h, 0);
  let ti = 0; bins.forEach((b, i) => { if (b.w * b.h - used(b) > bins[ti].w * bins[ti].h - used(bins[ti])) ti = i; });
  let si = -1, pi = -1, area = Infinity;
  bins.forEach((b, i) => { if (i === ti) return; b.placements.forEach((p, k) => { if (p.w * p.h < area){ area = p.w * p.h; si = i; pi = k; } }); });
  return { si, pi, ti };
});
await tapPart(pick.si, pick.pi);
const barOpen = await page.evaluate(() => document.getElementById('layoutBar').classList.contains('open') && !!layoutSel);
check(barOpen, 'tapping a part opens the big button bar');
const beforeMove = await page.evaluate(() => window.__layout());
await page.click(`#layoutBar [data-lb-move="${pick.ti}"]`);
const afterMove = await page.evaluate(() => ({ layout: window.__layout(), toast: document.getElementById('layoutToast').textContent, edited: strategyResults[selectedStrategyKey].edited }));
check(afterMove.layout !== beforeMove && (await layoutOk('move')) && afterMove.edited && /moved to Sheet \d/.test(afterMove.toast),
  `move to another sheet via the big button: valid layout, every part accounted for ("${afterMove.toast}")`);
// Take a part off, then put it back from the tray.
await tapPart(0, 0);
await page.click('#lbTakeOff');
const tray = await page.evaluate(() => ({ tray: !!document.getElementById('offSheetTray'), off: strategyResults[selectedStrategyKey].unplaced.length,
  stockNote: /sheet stock ran out/.test(document.getElementById('reportBody').textContent) }));
check(tray.tray && tray.off === 1 && !tray.stockNote && (await layoutOk('take off')), 'take off: part goes to "Not on a sheet" (not reported as a stock shortage)');
await page.click('#offSheetTray [data-putback]');
const back = await page.evaluate(() => ({ off: strategyResults[selectedStrategyKey].unplaced.length, tray: !!document.getElementById('offSheetTray') }));
check(back.off === 0 && !back.tray && (await layoutOk('put back')), 'put back: the part lands on a sheet and the tray disappears');
// Tidy a sheet.
await page.click('.sheet-card [data-tidy]');
check(await layoutOk('tidy'), 'tidy this sheet keeps a valid layout');
// Undo steps back exactly.
const beforeUndo = await page.evaluate(() => window.__layout());
await tapPart(0, 0);
await page.click('#lbTakeOff');
await page.click('#btnUndo');
check((await page.evaluate(() => window.__layout())) === beforeUndo && (await layoutOk('undo')), 'undo restores the layout exactly');
// A move that can't happen leaves everything as it was.
const refused = await page.evaluate(() => {
  const s = strategyResults[selectedStrategyKey];
  s.bins[0].sheetType.qty = s.bins.length;           // no stock left for a new sheet
  const before = window.__layout();
  const pl = s.bins[0].placements[0];
  const ok = layoutMove(0, pl, { newSheet: s.bins[0].sheetType.id });
  const r = { ok, same: window.__layout() === before, toast: document.getElementById('layoutToast').textContent };
  sheetTypes.forEach(st => st.qty = null);
  return r;
});
check(!refused.ok && refused.same && /No more .* in stock/.test(refused.toast), `a new sheet beyond stock is refused and nothing changes ("${refused.toast}")`);
// New sheet when stock allows.
const newSheet = await page.evaluate(() => {
  const s = strategyResults[selectedStrategyKey], n = s.bins.length;
  layoutMove(0, s.bins[0].placements[0], { newSheet: s.bins[0].sheetType.id });
  return { more: strategyResults[selectedStrategyKey].bins.length === n + 1 };
});
check(newSheet.more && (await layoutOk('new sheet')), 'move to a new sheet adds a sheet');
// The PDF and the cut list follow the edits.
const follow = await page.evaluate(async () => {
  const s = strategyResults[selectedStrategyKey];
  const trace = []; const doc = await buildNestingPdf('report', 'shop', trace);
  const csvSheets = new Set(buildCutListCsv().trim().split('\r\n').slice(1).map(r => r.split(',')[0])).size;
  return { pdfSheets: trace.filter(t => /^Sheet \d+ of \d+/.test(t)).length, bins: s.bins.length, csvSheets };
});
check(follow.pdfSheets === follow.bins && follow.csvSheets === follow.bins, `PDF and cut list follow the edited layout (${follow.bins} sheets)`);
// Saved with the project: reopen = same layout; change a part = edits cleared, and said so.
const saved = await page.evaluate(() => {
  const edited = window.__layout();
  loadProjectIntoWorking(currentProjectId); runNesting();
  const r = { same: window.__layout() === edited, banner: !!document.getElementById('editedBanner') };
  parts.find(p => p.name === 'Tab').qty = 17; saveWorkingIntoCurrentProject(); runNesting();
  r.cleared = !strategyResults[selectedStrategyKey].edited && /cleared/.test(document.getElementById('reportBody').textContent)
    && !getProject(currentProjectId).editedLayout;
  return r;
});
check(saved.same && saved.banner, 'hand edits are saved with the project and come back on reopen');
check(saved.cleared && (await layoutOk('after change')), 'changing a part clears stale hand edits and says so');
// Reset goes back to the computed layout.
await tapPart(0, 0);
await page.click('#lbTakeOff');
await page.click('#btnResetLayout');   // the confirm is accepted by the page-wide dialog handler
const reset = await page.evaluate(() => ({ edited: !!strategyResults[selectedStrategyKey].edited, off: strategyResults[selectedStrategyKey].unplaced.length }));
check(!reset.edited && reset.off === 0 && (await layoutOk('reset')), 'reset layout goes back to the computed one');

// ---- editing regressions from code review ----------------------------------
// A refused move leaves the sheet drawing and tapping working.
const refusedUi = await page.evaluate(() => {
  const s = strategyResults[selectedStrategyKey];
  for (let bi = 0; bi < s.bins.length; bi++){
    const big = s.bins[bi].placements.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
    for (let ti = 0; ti < s.bins.length; ti++){
      if (ti === bi) continue;
      const before = window.__layout();
      if (!layoutMove(bi, big, ti) && window.__layout() === before) return { bi, pi: strategyResults[selectedStrategyKey].bins[bi].placements.indexOf(big), name: big.name };
      layoutUndoLast();
    }
  }
  return null;
});
if (refusedUi){
  await tapPart(refusedUi.bi, refusedUi.pi);
  const sel = await page.evaluate(() => layoutSel && layoutSel.pl.name);
  check(sel === refusedUi.name && (await layoutOk('refused move')), `after a refused move the part can still be tapped (${refusedUi.name})`);
  await page.click('#lbDone');
} else check(false, 'could not set up a refused move');
// Taken off by hand is reported as such in the PDF - not as a stock shortage.
await tapPart(0, 0);
await page.click('#lbTakeOff');
const offPdf = await page.evaluate(async () => { const t = []; await buildNestingPdf('report', 'shop', t); return t.join(' | '); });
check(has(offPdf, 'Taken off the sheets by hand') && lacks(offPdf, 'Sheet stock ran out'), 'PDF says a part was taken off by hand, not that stock ran out');
await page.click('#btnResetLayout');
// Reset and strategy switch never leave the button bar hanging.
await tapPart(0, 0);
await page.click('#lbTakeOff');
await tapPart(0, 0);
await page.click('#btnResetLayout');
check(await page.evaluate(() => !document.getElementById('layoutBar').classList.contains('open') && !layoutSel), 'Reset closes the button bar');
// Two sheet types: the recommended star stays put through edits; Reset keeps
// the strategy you were on; switching strategy drops edits with a warning.
const two = await page.evaluate(() => {
  sheetTypes.push({ id: nextId(), name: '60x120', width: 120, height: 60, qty: null, cost: 290 });
  saveWorkingIntoCurrentProject(); render(); runNesting();
  const firstRow = () => document.querySelector('#results table.breakdown tbody tr td').textContent;
  const star = firstRow();
  const s = strategyResults[selectedStrategyKey];
  layoutTakeOff(0, s.bins[0].placements[0]);
  const starAfter = firstRow();
  const other = strategyOrder.find(k => k !== selectedStrategyKey);
  switchStrategy(other);
  const switched = selectedStrategyKey === other && !getProject(currentProjectId).editedLayout;
  const comp = JSON.stringify(strategyResults[other].computed.bins.map(b => b.placements.length));
  const s2 = strategyResults[other];
  layoutTakeOff(0, s2.bins[0].placements[0]);
  layoutReset();
  return { star, starAfter, switched, keptKey: selectedStrategyKey === other,
           resetToComputed: JSON.stringify(strategyResults[other].bins.map(b => b.placements.length)) === comp && !strategyResults[other].edited };
});
check(two.star === two.starAfter, 'the recommended strategy stays first after an edit');
check(two.switched && two.keptKey && two.resetToComputed, 'switching strategy drops edits; Reset goes back to that strategy\'s computed layout');
// Undo back to the computed layout brings its notes back.
const notesBack = await page.evaluate(() => {
  parts = [{ id: nextId(), name: 'Frame', width: 30, height: 20, qty: 2, rotate: true, color: null },
           { id: nextId(), name: 'Tab', width: 6, height: 5, qty: 10, rotate: true, color: null }];
  setPartOpenings(parts[0], [frameOpening(30, 20, 2)]);
  sheetTypes = [{ id: nextId(), name: '32x22', width: 32, height: 22, qty: null, cost: 40 }];
  saveWorkingIntoCurrentProject(); render(); runNesting();
  const note = () => (document.getElementById('openingsNote') || {}).textContent || '';
  const before = /saves 1 sheet/.test(note());
  const s = strategyResults[selectedStrategyKey];
  layoutTakeOff(0, s.bins[0].placements[s.bins[0].placements.length - 1]);
  const during = /saves/.test(note());
  layoutUndoLast();
  return { before, during, after: /saves 1 sheet/.test(note()) };
});
check(notesBack.before && !notesBack.during && notesBack.after, 'edited layout drops the "saves N sheets" claim; undo back to computed brings it back');
// A real stock shortage stays a stock shortage after reopening an edited project.
const shortage = await page.evaluate(() => {
  parts = [{ id: nextId(), name: 'Plate', width: 20, height: 20, qty: 9, rotate: true, color: null }];
  sheetTypes = [{ id: nextId(), name: '48x48', width: 48, height: 48, qty: 1, cost: 50 }];
  saveWorkingIntoCurrentProject(); render(); runNesting();
  const s = strategyResults[selectedStrategyKey];
  const short = s.unplaced.length;
  layoutTakeOff(0, s.bins[0].placements[0]);   // a real hand edit
  loadProjectIntoWorking(currentProjectId); runNesting();
  const r = strategyResults[selectedStrategyKey];
  return { short, edited: r.edited, stillShort: r.unplaced.filter(u => !u.takenOff).length,
           note: /sheet stock ran out/.test(document.getElementById('reportBody').textContent) };
});
check(shortage.short > 0 && shortage.edited && shortage.stillShort === shortage.short && shortage.note, `stock shortage survives reopening an edited project (${shortage.short} short)`);
// Hand edits travel in the project's Export JSON and come back on Import.
const exported = await page.evaluate(() => {
  const s = strategyResults[selectedStrategyKey];
  saveWorkingIntoCurrentProject();
  const proj = getProject(currentProjectId);
  return { json: JSON.stringify({ name: proj.name + ' (copy)', sheetTypes: proj.sheetTypes, parts: proj.parts, settings: proj.settings, editedLayout: proj.editedLayout }), layout: window.__layout() };
});
const jsonPath = path.join(tmp, 'project.json');
fs.writeFileSync(jsonPath, exported.json);
await page.setInputFiles('#importFile', jsonPath);
await page.waitForFunction(n => getProject(currentProjectId) && getProject(currentProjectId).name === n, JSON.parse(exported.json).name);
const imported = await page.evaluate(() => { goToStep(3); return null; });
await page.waitForTimeout(300);
const imp = await page.evaluate(() => ({ layout: window.__layout(), banner: !!document.getElementById('editedBanner') }));
check(imp.layout === exported.layout && imp.banner, 'hand edits survive Export JSON / Import');
// A tampered saved layout (overlapping parts) is refused, not shown.
const tampered = await page.evaluate(() => {
  const proj = getProject(currentProjectId);
  const e = proj.editedLayout;
  e.bins[0].p[1] = [e.bins[0].p[0][0], e.bins[0].p[0][1], e.bins[0].p[0][2], e.bins[0].p[0][3]];   // two parts on one spot
  runNesting();
  return { edited: !!strategyResults[selectedStrategyKey].edited, gone: !proj.editedLayout };
});
check(!tampered.edited && tampered.gone && (await layoutOk('tampered')), 'a saved layout with overlapping parts is refused');

// Randomised editing: 150 random moves / take-offs / put-backs / tidies / undos,
// checking the layout after every one.
const fuzzEdit = await page.evaluate(() => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const problems = [];
  for (let i = 0; i < 150; i++){
    const s = strategyResults[selectedStrategyKey];
    const op = Math.floor(rnd() * 5);
    const bi = Math.floor(rnd() * s.bins.length), b = s.bins[bi];
    const pl = b && b.placements[Math.floor(rnd() * b.placements.length)];
    if (op === 0 && pl) layoutMove(bi, pl, Math.floor(rnd() * s.bins.length));
    else if (op === 1 && pl) layoutTakeOff(bi, pl);
    else if (op === 2 && s.unplaced.length) layoutPutBack(s.unplaced[0].defId, 1 + Math.floor(rnd() * 3));
    else if (op === 3 && b) layoutTidy(bi);
    else layoutUndoLast();
    const c = window.__check();
    if (c.problems.length) problems.push(i + ': ' + c.problems.join('; '));
    window.__fuzzBins = (window.__fuzzBins || []).concat([c]);
  }
  const all = window.__fuzzBins; window.__fuzzBins = null;
  return { problems, snaps: all.filter((_, k) => k % 10 === 9) };
});
check(fuzzEdit.problems.length === 0 && fuzzEdit.snaps.every(c => geometryOk(c.bins, c.gap, c.border)),
  `150 random edits: counts, stock and geometry valid after every one${fuzzEdit.problems.length ? ' - ' + fuzzEdit.problems[0] : ''}`);
await page.evaluate(() => { document.getElementById('layoutToast').classList.remove('show'); layoutSelect(null, null); });

// ---- the Export window ------------------------------------------------------
await page.evaluate(() => {
  parts = [];
  document.getElementById('bulkPaste').value = 'Gate frame, 40, 30, 2, rail 3\nTab, 6, 5, 16\nGusset, 9, 7, 8\nStrip, 36, 3, 6\nBase plate, 44, 40, 3';
  document.getElementById('parseBulk').click();
  sheetTypes = [{ id: nextId(), name: '48x96', width: 96, height: 48, qty: null, cost: 185 }];
  Object.assign(reportPrefs, { format: 'report', audience: 'shop', summary: true, notes: true, pdfParts: true, pdfSheets: true, sheetParts: true, checklist: true, mono: false, orientAll: 'auto' });
  saveWorkingIntoCurrentProject(); render(); goToStep(3);
});
await page.waitForTimeout(400);
await page.click('#btnPrint');
const exOpen = await page.evaluate(() => document.getElementById('exportModal').classList.contains('open')
  && !!document.querySelector('[data-ex-format="report"].on') && !!document.querySelector('[data-ex-aud="shop"].on'));
check(exOpen, 'Export opens a window: PDF one sheet per page, for the shop');
const pdfNow = async () => page.evaluate(async () => {
  const t = []; const d = await buildNestingPdf(reportPrefs.format === 'overview' ? 'overview' : 'report', reportPrefs.audience, t);
  return { text: t.join(' | '), pages: d.getNumberOfPages(), w: d.internal.pageSize.getWidth(), h: d.internal.pageSize.getHeight() };
});
const nSheets = await page.evaluate(() => lastNestResult.bins.length);
let r0 = await pdfNow();
check(r0.pages === nSheets + 1 && has(r0.text, 'Notes for this job', 'Parts on this sheet', 'Cut by'), `default: summary + ${nSheets} sheet pages with parts lists and sign-off (${r0.pages} pages)`);
// Summary off: just the sheets, first page turned to suit the first sheet, no dangling links.
await page.click('[data-ex-tog="summary"]');
let r1 = await pdfNow();
check(r1.pages === nSheets && lacks(r1.text, 'Notes for this job', 'Back to summary') && has(r1.text, 'Sheet 1 of') && r1.w > r1.h,
  `summary off: only the ${nSheets} sheet pages, first page landscape, no "Back to summary"`);
check(await page.evaluate(() => document.querySelector('[data-ex-tog="notes"]').disabled && /Needs the summary page/.test(document.querySelector('[data-ex-tog="notes"]').textContent)),
  'options that need the summary are greyed out and say why');
// Leave out a sheet.
await page.click('[data-ex-sheet="1"]');
let r2 = await pdfNow();
check(r2.pages === nSheets - 1 && lacks(r2.text, 'Sheet 2 of') && /About 2 pages/.test(await page.textContent('#exPlan')), 'unticking a sheet leaves it out, and the window says how many pages');
// Parts list under each sheet off: tick boxes go with it.
await page.click('[data-ex-tog="sheetParts"]');
let r3 = await pdfNow();
check(lacks(r3.text, 'Parts on this sheet', 'Cut by') && await page.evaluate(() => document.querySelector('[data-ex-tog="checklist"]').disabled),
  'parts list under each sheet off: no list, no sign-off (that option greys out)');
await page.click('[data-ex-tog="sheetParts"]');
await page.click('[data-ex-tog="checklist"]');
let r4 = await pdfNow();
check(has(r4.text, 'Parts on this sheet') && lacks(r4.text, 'Cut by'), 'tick boxes & sign-off can be switched off on their own');
// All portrait.
await page.click('[data-ex-orient="portrait"]');
let r5 = await pdfNow();
const plans = await page.evaluate(() => { exportingPdf = true; const a = lastNestResult.bins.every((b, i) => sheetPrintPlan(b, i).orient === 'portrait'); exportingPdf = false;
  const screen = lastNestResult.bins.some((b, i) => sheetPrintPlan(b, i).orient === 'landscape'); return { a, screen }; });
check(r5.w < r5.h && plans.a && plans.screen, 'All portrait turns every sheet page portrait in the file only (screen cards unchanged)');
await page.click('[data-ex-orient="auto"]');
// Black & white: the drawing has no colour in it.
await page.click('[data-ex-mono="1"]');
const mono = await page.evaluate(async () => {
  const bin = lastNestResult.bins[0];
  const sample = async () => {
    drawMono = !!reportPrefs.mono;
    const png = renderSheetPng(bin, { rotate: false }, 1, 0, 4, false);
    drawMono = false;
    const img = new Image(); img.src = png.url; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let coloured = 0;
    for (let i = 0; i < d.length; i += 4 * 37){ const mx = Math.max(d[i], d[i+1], d[i+2]), mn = Math.min(d[i], d[i+1], d[i+2]); if (mx - mn > 24) coloured++; }
    return coloured;
  };
  const bw = await sample();
  reportPrefs.mono = false;
  const colour = await sample();
  reportPrefs.mono = true;
  return { bw, colour };
});
check(mono.bw === 0 && mono.colour > 0, `black & white drawings carry no colour (${mono.bw} coloured samples vs ${mono.colour} in colour)`);
await page.click('[data-ex-mono="0"]');
// Nothing selected: Save is disabled and says why.
await page.click('[data-ex-allsheets="0"]');
const nothing = await page.evaluate(() => ({ dis: document.getElementById('exSave').disabled, text: document.getElementById('exPlan').textContent }));
check(nothing.dis && /Nothing to export/.test(nothing.text), `nothing selected: Save is disabled ("${nothing.text}")`);
await page.click('[data-ex-allsheets="1"]');
await page.click('[data-ex-tog="summary"]');
// Cut list from the same window, only the picked sheets, saved under the typed name.
await page.click('[data-ex-format="csv"]');
await page.click('[data-ex-sheet="0"]');
await page.fill('#exName', 'Monday cut list');
const csvPicked = new Set(await page.evaluate(() => [...new Set(buildCutListCsv().trim().split('\r\n').slice(1).map(r => r.split(',')[0]))]));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exSave')]);
check(dl.suggestedFilename() === 'Monday cut list.csv' && !csvPicked.has('1') && csvPicked.size === nSheets - 1,
  `cut list from the Export window: picked sheets only, saved as "${dl.suggestedFilename()}"`);
// PDF saved under the typed name.
await page.click('[data-ex-format="report"]');
await page.click('[data-ex-allsheets="1"]');
await page.fill('#exName', 'Job 417 cut sheets.pdf');
const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#exSave')]);
await page.waitForFunction(() => /Saved: Job 417/.test(document.getElementById('exPlan').textContent));
check(dl2.suggestedFilename() === 'Job 417 cut sheets.pdf', `PDF saved under the typed name ("${dl2.suggestedFilename()}"), and the window says so`);
// Turning sheet drawings off for the PDF leaves the Results screen alone.
await page.waitForTimeout(1000);
await page.click('#btnPrint');
await page.click('[data-ex-tog="pdfSheets"]');
const screenKept = await page.evaluate(() => { rerenderResults(); return document.querySelectorAll('.sheet-canvas').length === lastNestResult.bins.length; });
check(screenKept, 'PDF choices never hide anything on the Results screen');
await page.click('[data-ex-tog="pdfSheets"]');
// Choices are remembered on this computer.
const remembered = await page.evaluate(() => { const p = JSON.parse(localStorage.getItem(REPORT_PREFS_KEY)); return p.checklist === false && p.format === 'report'; });
check(remembered, 'export choices are remembered for next time');
await page.click('#exCancel');
await page.evaluate(() => { Object.assign(reportPrefs, { summary: true, notes: true, sheetParts: true, checklist: true, mono: false, orientAll: 'auto', format: 'report', pdfSheets: true, pdfParts: true }); storeReportPrefs(); sheetPrintState = {}; });

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

// ---- whole-app audit fixes -------------------------------------------------
const dialogs = [];
page.on('dialog', d => dialogs.push(d.message()));
// Results never leak between projects; the move bar closes on Home.
const leak = await page.evaluate(() => {
  const homeId = currentProjectId;
  goToStep(3); runNesting();
  const st = strategyResults[selectedStrategyKey];
  layoutSelect(0, st.bins[0].placements[0]);
  const barOpen = document.getElementById('layoutBar').classList.contains('open');
  showHome();
  const barClosedOnHome = !document.getElementById('layoutBar').classList.contains('open');
  const proj = { id: nextId(), name: 'Empty B', createdAt: Date.now(), sheetTypes: [], parts: [], settings: defaultSettings() };
  projects.push(proj); openProject(proj.id);
  document.getElementById('markupPct').value = '10';
  document.getElementById('markupPct').dispatchEvent(new Event('input'));
  document.getElementById('secParts').dispatchEvent(new Event('change'));
  const empty = document.getElementById('results').innerHTML === '' && lastRunParams === null;
  document.getElementById('markupPct').value = ''; saveWorkingIntoCurrentProject();
  openProject(homeId);
  return { barOpen, barClosedOnHome, empty };
});
check(leak.barOpen && leak.barClosedOnHome && leak.empty, 'switching project drops the old results (no report from another job) and closes the move bar');

// Bulk paste: fractions, qty 0, unreadable lines kept with a reason.
const paste = await page.evaluate(() => {
  const before = parts.length;
  document.getElementById('bulkPaste').value = 'Gusset X, 10 1/2, 3/4, 0\nBad line, -4, 5, 2\nNo size, abc, 5\nPlate Y, 12", 8-1/4';
  document.getElementById('parseBulk').click();
  const g = parts.find(p => p.name === 'Gusset X'), pl = parts.find(p => p.name === 'Plate Y');
  return { added: parts.length - before, g: g && [g.width, g.height, g.qty], pl: pl && [pl.width, pl.height, pl.qty],
    left: document.getElementById('bulkPaste').value, note: document.getElementById('bulkNote').textContent };
});
check(paste.added === 2 && paste.g.join() === '10.5,0.75,0' && paste.pl.join() === '12,8.25,1'
  && paste.left === 'Bad line, -4, 5, 2\nNo size, abc, 5' && /2 lines were not added/.test(paste.note),
  `paste rows read 10 1/2 and 3/4, keep qty 0, and leave unreadable lines in the box with a reason (${paste.note})`);

// Negative gaps are used as 0; negative sheet cost is not kept.
const gaps = await page.evaluate(() => {
  document.getElementById('partGap').value = '-2'; document.getElementById('borderGap').value = '-3';
  runNesting();
  const ok = lastRunParams.partGap === 0 && lastRunParams.borderGap === 0
    && strategyResults[selectedStrategyKey].bins.every(b => b.placements.every(p => p.x >= 0 && p.y >= 0));
  document.getElementById('partGap').value = '0.25'; document.getElementById('borderGap').value = '0.5';
  return ok;
});
check(gaps, 'a negative part gap / border gap nests as 0 (no parts off the sheet)');

// Project notes print on office and shop PDFs; $ lines stay off the shop copy.
const notesPdf = await page.evaluate(async () => {
  document.getElementById('projectNotes').value = 'Confirm grain direction on brackets\nCustomer agreed $500\nQuoted 1250 USD all in\nPay attention to the grain';
  runNesting();
  const ti = [], ts = [];
  await buildNestingPdf('report', 'internal', ti); await buildNestingPdf('report', 'shop', ts);
  document.getElementById('projectNotes').value = '';
  return { i: ti.join(' | '), s: ts.join(' | ') };
});
check(has(notesPdf.i, 'Confirm grain direction on brackets', 'Customer agreed $500', 'Quoted 1250 USD') && has(notesPdf.s, 'Confirm grain direction on brackets', 'Pay attention to the grain')
  && lacks(notesPdf.s, '$', 'Quoted', 'USD'), 'project notes print on the office and shop PDFs; lines about money never on the shop copy');

// Import: notes kept, numbers written as text accepted, a wrong file refused.
const impDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-imp-'));
const goodJson = path.join(impDir, 'job.json'), badJson = path.join(impDir, 'bad.json');
fs.writeFileSync(goodJson, JSON.stringify({ name: 'Imported job', notes: 'Bring the blue tape',
  sheetTypes: [{ name: 'S', width: '48', height: '96', qty: '', cost: '50' }], parts: [{ name: 'P', width: '12', height: '6.5', qty: '3' }] }));
fs.writeFileSync(badJson, JSON.stringify([1, 2, 3]));
const nProj = await page.evaluate(() => projects.length);
await page.setInputFiles('#importFile', goodJson);
await page.waitForFunction(() => document.getElementById('projectNameInput').value === 'Imported job');
const imported2 = await page.evaluate(() => ({ notes: document.getElementById('projectNotes').value, w: parts[0].width, h: parts[0].height, sw: sheetTypes[0].width }));
await page.setInputFiles('#importFile', badJson);
await page.waitForFunction(() => true);
await page.waitForTimeout(300);
const nAfter = await page.evaluate(() => projects.length);
check(imported2.notes === "Bring the blue tape" && imported2.w === 12 && imported2.h === 6.5 && imported2.sw === 48 && nAfter === nProj + 1
  && dialogs.some(m => /not a Nesting Estimator project/.test(m)),
  'import keeps notes and reads "12" as 12; a file that is not a project is refused with a plain message');
fs.rmSync(impDir, { recursive: true, force: true });

// A strategy picked by hand stays picked when Results re-runs.
const picked = await page.evaluate(() => {
  sheetTypes = [{ id: nextId(), name: 'Small', width: 48, height: 48, qty: null, cost: 30 },
                { id: nextId(), name: 'Big', width: 96, height: 48, qty: null, cost: 50 }];
  parts = [{ id: nextId(), name: 'Q', width: 20, height: 20, qty: 6, rotate: true, color: null }];
  saveWorkingIntoCurrentProject(); render(); runNesting();
  const other = strategyOrder.find(k => k !== strategyOrder[0]);
  switchStrategy(other);
  runNesting();
  const kept = selectedStrategyKey === other;
  switchStrategy(strategyOrder[0]);
  runNesting();
  return kept && selectedStrategyKey === strategyOrder[0];
});
check(picked, 'a strategy picked with "Use this" is still picked after re-running');

// Openings editor: "+ Add opening" lands somewhere free, so Save stays usable.
const opAdd = await page.evaluate(() => {
  const part = { id: nextId(), name: 'Plate', width: 30, height: 20, qty: 1, rotate: true, color: null };
  setPartOpenings(part, [{ x: 2, y: 2, w: 8, h: 8 }]);
  parts.push(part); render();
  openOpeningsEditor(part);
  document.getElementById('opAddRow').click();
  const ok = opEdit.rows.length === 2 && !document.getElementById('opSaveBtn').disabled;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  return ok && !document.getElementById('openingsModal').classList.contains('open');
});
check(opAdd, '"+ Add opening" starts valid (no overlap) and Esc closes the editor');

// Header "More" menu: opens, its items are real buttons, Esc / outside click close it.
await page.click('#btnMore');
const menuOpen = await page.evaluate(() => document.getElementById('moreMenu').classList.contains('open') && !!document.querySelector('#moreMenu #btnClear'));
await page.keyboard.press('Escape');
const menuShut = await page.evaluate(() => !document.getElementById('moreMenu').classList.contains('open'));
await page.click('#btnMore'); await page.mouse.click(5, 400);
const menuShut2 = await page.evaluate(() => !document.getElementById('moreMenu').classList.contains('open'));
check(menuOpen && menuShut && menuShut2, 'header "More" menu opens and closes with Esc or a click outside');

// Review fixes: a no-op Tidy is not a hand edit; a run that stops early drops
// the old results, so redrawing the report afterwards can't fail.
const review = await page.evaluate(() => {
  parts = [{ id: nextId(), name: 'Sq', width: 10, height: 10, qty: 4, rotate: true, color: null }];
  sheetTypes = [{ id: nextId(), name: 'S', width: 48, height: 48, qty: null, cost: 10 }];
  saveWorkingIntoCurrentProject(); render(); goToStep(3); runNesting();
  layoutTidy(0); layoutTidy(0);
  const notEdited = !currentStrategy().edited && !getProject(currentProjectId).editedLayout;
  parts[0].qty = 0; saveWorkingIntoCurrentProject(); runNesting();
  let threw = false;
  try {
    document.getElementById('markupPct').dispatchEvent(new Event('input'));
    document.getElementById('secParts').dispatchEvent(new Event('change'));
  } catch (e) { threw = true; }
  const cleared = lastRunParams === null && lastNestResult === null;
  parts[0].qty = 4; saveWorkingIntoCurrentProject(); runNesting();
  return { notEdited, threw, cleared };
});
check(review.notEdited && !review.threw && review.cleared, 'a Tidy that moves nothing is not a hand edit; an empty run drops old results (no crash redrawing)');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
