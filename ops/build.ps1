# Build the farm binary.
#
# Two things this exists to stop anyone doing by hand again:
#
#   * `cargo build` produces a koharu.exe that loads devUrl (localhost:3000)
#     instead of embedding the frontend. It starts, shows ERR_CONNECTION_REFUSED
#     and nothing works. `cargo tauri build --no-bundle` is the one that counts;
#     the 98 MB binary is the embedded one, the 82 MB binary is the broken one.
#   * The keepalive relaunches koharu the moment the process disappears, which
#     during a build means the OLD binary comes back and locks the file the
#     linker is about to write. The marker tells it to hold off.
#
# Bindings first: a new #[tauri::command] does not reach packages/bridge until
# the generator runs, and the app's TypeScript build fails on the missing name.
#
# PURE ASCII ON PURPOSE (PowerShell 5.1 reads a BOM-less .ps1 as ANSI).

$ErrorActionPreference = 'Continue'
$root   = Split-Path -Parent $PSScriptRoot
$marker = Join-Path $PSScriptRoot '.keepalive-pause'

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
cmd /c "`"$(Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat')`" >nul 2>&1 && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] -ErrorAction SilentlyContinue }
}
$bun = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Oven-sh.Bun_*\bun-windows-x64" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$env:PATH = "$env:USERPROFILE\.cargo\bin;$bun;C:\Program Files\nodejs;C:\Program Files\LLVM\bin;C:\Program Files\CMake\bin;$env:PATH"
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"
Set-Location $root

New-Item -ItemType File -Path $marker -Force | Out-Null
try {
  Get-Process koharu -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3

  Write-Host '######## regenerating packages/bridge/src/protocol.ts ########'
  & cargo run --quiet -p koharu-app --bin generate
  if ($LASTEXITCODE -ne 0) { Write-Host "generate failed ($LASTEXITCODE)"; exit $LASTEXITCODE }

  Write-Host '######## cargo tauri build --no-bundle ########'
  & cargo tauri build --no-bundle 2>&1 |
    Select-String -Pattern 'Compiling koharu|Finished|error|Built application' |
    Select-Object -Last 15 | Out-Host
  $code = $LASTEXITCODE
} finally {
  Remove-Item $marker -Force -ErrorAction SilentlyContinue
}

$exe = Join-Path $root 'target\release\koharu.exe'
if (Test-Path $exe) {
  $mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
  Write-Host "koharu.exe $mb MB  $((Get-Item $exe).LastWriteTime)"
  if ($mb -lt 90) { Write-Host 'WARNING: under 90 MB - the frontend is probably NOT embedded' }
}
Write-Host "exit $code"
