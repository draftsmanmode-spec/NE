# Build the Sheet Nesting Estimator Windows installer.
#
# One-time prerequisites (see BUILD.md if either is missing):
#   1. Rust           - winget install Rustlang.Rustup
#   2. VS Build Tools - C++ workload, needs admin + possibly a reboot first
#   3. Tauri CLI      - cargo install tauri-cli --locked   (~10 min, once)
#
# Then just run:  .\build.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# rustup installs here but does not always refresh PATH in an existing shell.
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# dist/ is generated and gitignored, so a fresh clone has to create it.
New-Item -ItemType Directory -Force -Path "$root\dist" | Out-Null

# Keep dist/index.html an exact copy of the source file. The HTML is the single
# source of truth and must never be edited in dist/.
Copy-Item -LiteralPath "$root\nesting-estimator.html" -Destination "$root\dist\index.html" -Force
Copy-Item -LiteralPath "$root\jspdf.umd.min.js" -Destination "$root\dist\jspdf.umd.min.js" -Force
Copy-Item -LiteralPath "$root\pdf-fonts.js" -Destination "$root\dist\pdf-fonts.js" -Force
Write-Host "Synced dist/ (index.html, jspdf, pdf-fonts)" -ForegroundColor Cyan

Push-Location "$root\src-tauri"
try {
    # cargo writes progress to stderr, which Windows PowerShell 5.1 turns into
    # NativeCommandError records. Under ErrorActionPreference=Stop that aborts a
    # perfectly healthy build, so judge success by the exit code instead.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    cargo tauri build
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) { throw "cargo tauri build failed with exit code $code" }
} finally {
    Pop-Location
}

# Cargo's default target/ directory, which .gitignore excludes.
$installer = Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($installer) {
    Write-Host "`nInstaller: $($installer.FullName)" -ForegroundColor Green
    Write-Host ("Size: {0:N1} MB" -f ($installer.Length / 1MB))
} else {
    Write-Warning "Build reported success but no NSIS .exe was found."
}
