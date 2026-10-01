# Building the Sheet Nesting Estimator desktop app

The app is `nesting-estimator.html` wrapped in a [Tauri v2](https://v2.tauri.app)
shell. There is no bundler, no framework, and no npm dependency — Tauri points
its WebView2 window straight at the HTML file.

## Layout

```
nesting-estimator.html     the app (source of truth — never edited by the build)
dist/index.html            byte-identical copy; what Tauri actually loads
build.ps1                  re-syncs the copy, then builds the installer
src-tauri/
  tauri.conf.json          window, bundle and installer settings
  Cargo.toml, build.rs     Rust shell
  src/main.rs              ~8 lines: open a window, load the page
  capabilities/default.json
  icons/                   generated purple->pink "N" mark
tools/                     icon and font generators, plus test_openings.mjs (browser test)
```

## Prerequisites (one time)

### 1. Rust

```powershell
winget install --id Rustlang.Rustup -e
```

### 2. Visual Studio Build Tools — C++ workload

Tauri compiles native code, so it needs the MSVC linker. This is the big one
(~4-7 GB) and it **requires administrator rights**.

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Approve the UAC prompt when it appears.

**If this fails with exit code 5008:** the machine has a pending file-rename
operation from an earlier install, which blocks Visual Studio setup. Reboot,
then run the command again. You can confirm the flag with:

```powershell
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations
```

### 3. Tauri CLI

Installed through Cargo, so no Node.js is needed. Takes ~10 minutes to compile,
once.

```powershell
cargo install tauri-cli --locked
```

## Build

```powershell
.\build.ps1
```

The installer lands at:

```
src-tauri\target\release\bundle\nsis\Sheet Nesting Estimator_1.0.0_x64-setup.exe
```

Build output goes to the usual `src-tauri/target/`, which is gitignored.

The project deliberately lives on a local disk rather than under
`G:\My Drive`: Cargo's `target/` is tens of thousands of small files, and a
Drive sync client both slows the build and can corrupt a `.git` directory
mid-write.

## What the installer does

- **NSIS `.exe`, `installMode: "currentUser"`** — installs under `%LOCALAPPDATA%`,
  so neither installing nor running needs admin rights.
- Creates Start Menu and desktop shortcuts.
- No auto-updater, no code signing, no network features. Because it is unsigned,
  SmartScreen will show a "Windows protected your PC" warning on first run —
  click *More info* -> *Run anyway*. This is expected for an unsigned personal tool.

## Notes on the two non-obvious settings

### `dragDropEnabled: false`

This looks backwards but is required. Tauri's drag-drop handler defaults to
**on**, and when on it intercepts OS-level file drops and forwards them to Rust
as Tauri events — the webview never receives them, so the HTML5 `dragover` /
`drop` listeners on the DXF dropzone would silently do nothing.

Setting it to `false` lets WebView2 handle drops natively, so
`e.dataTransfer.files` behaves exactly as it does in a browser and the existing
dropzone code works untouched.

### `csp: null`

The page uses inline `<style>` and `<script>`. Disabling Tauri's CSP injection
keeps it running exactly as it does in a browser.

## Offline

The app is fully offline. Space Grotesk, Inter and IBM Plex Mono (latin subset,
11 faces) are embedded in the HTML as base64 woff2, so it renders identically
with no network access. All three are SIL Open Font License, which permits
embedding. Regenerate them with `scratchpad/embed_fonts.py` if the weight list
changes.

`localStorage` persistence is per-machine: WebView2 gives the app its own
persistent profile, so saved projects survive restarts and upgrades, but they do
not sync between PCs. "Backup all projects" then "Import" is the manual bridge.

## PDF export

Exports are written directly by the app with **jsPDF 3.0.1** (MIT), vendored as
`jspdf.umd.min.js` beside the HTML. `window.print()` is never called, so the OS
print pipeline - and the header, footer and page number Windows/WebView2 stamps
onto every page - is entirely out of the picture. No printer or print driver is
involved.

- **Paper** is chosen in *Report sections -> Paper* (Tabloid 11x17 default;
  Letter, Legal, A4, A3, custom). Margins scale with the paper.
- **Orientation** per sheet comes from `max(w,h)` vs `min(w,h)`, never from
  which of the Width / Height boxes got the bigger number, so 48x96 and 96x48
  print identically. Pages are genuinely mixed-orientation in one document.
- **Sheet drawings** are rasterised at a fixed **300 DPI**, independent of
  screen DPI. `drawSheet()`/`drawSheetThumb()` are unchanged; they just honour
  `exportRenderScale` while an export is running.
- **Typefaces** are the app's own: Inter, Space Grotesk and IBM Plex Mono,
  subset to the characters the report draws and converted to TTF (the only
  format jsPDF embeds) in `pdf-fonts.js`. All four faces together are 53 KB, so
  a document grows by ~22 KB rather than ~860 KB for the full families.
  Regenerate with `scratchpad/make_pdf_fonts.py`.
- **Parts lists** appear at three levels: the full list on page 1, a
  "Parts on this sheet" table under each sheet drawing, and a combined
  "Parts key" under the overview grid so its tag numbers can be decoded.
- **Everything else is vector text** - tables, headers, the custom footer
  (`project name · date · Page X of Y`). Crisp at any zoom and searchable.
- **Saving** goes through Tauri's native Save dialog via the `save_pdf` Rust
  command (`tauri-plugin-dialog`). Opened outside Tauri the page falls back to a
  browser download, which is how the export path is testable in a browser.

- **Audience** ("PDF for" in Report sections or the preview): *Internal report*
  (costs, notes, material, linked sheet index, parts, remnants, sheets), *Shop cut
  sheets* (no prices) or *Customer quote* (one price page). The file name says
  which (`Job - report.pdf`, `Job - cut sheets.pdf`, `Job - quote.pdf`).
- **Navigation**: the PDF opens with its bookmarks panel (Summary, Parts, every
  sheet); sheet index rows jump to their sheet, and each sheet page links back.

The preview modal is the source of truth: per-sheet include/exclude and
orientation overrides are read straight out of it when the PDF is built, so the
file matches what the preview shows.

Expect roughly **0.9 MB per sheet page** at 300 DPI - a 3-sheet report is about
2.7 MB. PNG is used deliberately: for line art JPEG came out both larger and
lossy.

