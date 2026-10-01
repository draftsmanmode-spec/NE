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

const rows = await page.evaluate(() => dxfReviewRows.map(r => ({ name: r.name, w: r.w, h: r.h, qty: r.qty, openings: r.openings, skipped: r.skippedHoles })));
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
  document.getElementById('bulkPaste').value = 'Window frame, 30, 20, 2, 2\nTab, 6, 5, 10';
  document.getElementById('parseBulk').click();
  const fr = parts.find(p => p.name === 'Window frame');
  runNesting();
  const s = strategyResults[selectedStrategyKey];
  return { openings: fr.openings, plain: parts.find(p => p.name === 'Tab').openings, sheets: s.sheets, nested: countNestedInOpenings(s.bins) };
});
check(JSON.stringify(pasted.openings) === JSON.stringify([{ x: 2, y: 2, w: 26, h: 16 }]) && pasted.plain === undefined,
  'pasted "name, w, h, qty, rail" becomes a frame; 4-column rows stay plain');
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
