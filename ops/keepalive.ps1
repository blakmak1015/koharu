# Keep the unattended translation instance alive and its disk usage bounded.
#
# Replaces koharu-keepalive.ps1 from the 0.59.2 fork. Three things moved:
#   * health is /health on the control surface, not /api/v1/operations on
#     :4000 - that port now belongs to CEF's remote debugging endpoint;
#   * relaunching goes through ops/restart-server.ps1, which also re-pins the
#     model, so a watchdog restart can no longer leave the instance on the
#     wrong provider;
#   * projects live in Documents\Koharu, not %LOCALAPPDATA%\Koharu\projects.
#
# PURE ASCII ON PURPOSE. PowerShell 5.1 reads a BOM-less .ps1 as ANSI, and on
# this machine Documents is a Thai-named OneDrive folder: a literal path here
# would mojibake into "path not recognized" and the relaunch would fail
# silently. The path is resolved from the OS instead of written down.

$ErrorActionPreference = 'SilentlyContinue'

$mutex = New-Object System.Threading.Mutex($false, 'Global\koharu-farm-keepalive')
if (-not $mutex.WaitOne(0)) { return }

$port       = 4190
$log        = "$env:USERPROFILE\koharu-keepalive.log"
$restart    = Join-Path $PSScriptRoot 'restart-server.ps1'
$projectDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Koharu'

# How long a project must be untouched before it is considered finished.
# An agent processes a chapter, then uploads and completes it without writing
# locally, so LastWriteTime is when processing ended - the worst case observed
# was ~75 minutes, hence two hours.
$FinishedAfterHours = 2
# The newest few are never touched: the current job is always among them.
$KeepNewest = 3

function Note($message) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $message" | Out-File -FilePath $log -Append -Encoding utf8
}

function Running() {
  return [bool](Get-Process koharu -ErrorAction SilentlyContinue)
}

# The farm's own log is the only honest liveness signal. On 2026-10-17 a wgpu
# out-of-memory panic killed the agent thread while the process stayed up and
# /health still answered {ok:true,ready:true}: the farm sat dead for three and
# a half hours with 59 chapters queued, and the checks above would not have
# noticed. The agent writes a line every pass - 15s between idle polls, 60s
# between retries, and one per pipeline step while it works - so a log that has
# not moved in ten minutes means the loop is gone, not that there is no work.
$farmLog      = Join-Path $env:LOCALAPPDATA 'Koharu\logs\koharu.log'
$StallMinutes = 10

function Stalled() {
  try {
    $written = (Get-Item $farmLog -ErrorAction Stop).LastWriteTime
    return (((Get-Date) - $written).TotalMinutes -ge $StallMinutes)
  } catch {
    # No log file at all: a fresh install, or a path that moved. Silence is not
    # evidence of death, so leave this one to the health check.
    return $false
  }
}

# A just-launched instance has not written anything yet, and restarting it for
# that would loop for ever.
function JustStarted() {
  try {
    $started = (Get-Process koharu -ErrorAction Stop |
      Sort-Object StartTime | Select-Object -First 1).StartTime
    if (-not $started) { return $true }
    return (((Get-Date) - $started).TotalMinutes -lt $StallMinutes)
  } catch {
    return $false
  }
}

# Ready, not merely listening: the socket opens before the pipeline has read
# its configuration, and work dispatched in that window races it.
function Healthy() {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 8
    return [bool]$health.ready
  } catch {
    return $false
  }
}

function Relaunch($why) {
  Note "relaunching: $why"
  try { & $restart *>> $log } catch { Note ("relaunch error: " + $_.Exception.Message) }
}

# Reported, never acted on. Detection alone peaks at ~5.7 GB of this card's
# 8 GB and the pipeline's allocator never returns it, so spill is expected
# under load and says nothing about whether the run is healthy. Restarting on
# it would throw away a chapter mid-flight; the agent's own
# recycleAfterChapters does the same job at a safe boundary. This line is here
# so the operator can see how often it happens and tune that number.
function NoteVram() {
  try {
    $dedicated = [int]((Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction Stop).CounterSamples |
      Measure-Object CookedValue -Sum).Sum
    $shared = [int]((Get-Counter '\GPU Adapter Memory(*)\Shared Usage' -ErrorAction Stop).CounterSamples |
      Measure-Object CookedValue -Sum).Sum
    if ($shared -gt 1GB) {
      Note ("vram spilling: {0:N0} MB dedicated, {1:N0} MB in system memory" -f ($dedicated / 1MB), ($shared / 1MB))
    }
  } catch { }
}

function CleanProjects() {
  $now = Get-Date
  $agents = @(Get-ChildItem $projectDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'agent-*' } |
    Sort-Object LastWriteTime -Descending)
  $keep = @($agents | Select-Object -First $KeepNewest | ForEach-Object { $_.Name })
  foreach ($directory in $agents) {
    if ($keep -contains $directory.Name) { continue }
    if (($now - $directory.LastWriteTime).TotalHours -le $FinishedAfterHours) { continue }
    Remove-Item $directory.FullName -Recurse -Force -ErrorAction SilentlyContinue
    Note ("cleaned " + $directory.Name)
  }
}

# A rebuild deliberately takes koharu down, and the watchdog restarting it in
# that window relaunches the OLD binary and locks the file the linker is about
# to write. ops/build.ps1 drops this marker for the duration; nothing else does.
$pauseMarker = Join-Path $PSScriptRoot '.keepalive-pause'

Note "keepalive started (pid $PID); projects=$projectDir"
if (-not (Test-Path $restart)) { Note "restart-server.ps1 not found next to this script"; return }

$unhealthy = 0
$lastClean = Get-Date
while ($true) {
  if (Test-Path $pauseMarker) {
    Note 'paused by ops/build.ps1'
    Start-Sleep -Seconds 30
    continue
  }
  if (-not (Running)) {
    Relaunch 'process absent'
    $unhealthy = 0
    Start-Sleep -Seconds 150
  }
  elseif (-not (Healthy)) {
    # One missed probe is usually a model load holding the runtime busy, so
    # three in a row are required before restarting a process that is alive.
    $unhealthy++
    Note "health check failed x$unhealthy (process up)"
    if ($unhealthy -ge 3) {
      Relaunch 'health check failed three times'
      $unhealthy = 0
      Start-Sleep -Seconds 150
    } else {
      Start-Sleep -Seconds 60
    }
  }
  elseif ((Stalled) -and -not (JustStarted)) {
    Relaunch "no farm log line for $StallMinutes minutes (process up, health ok)"
    $unhealthy = 0
    Start-Sleep -Seconds 150
  }
  else {
    $unhealthy = 0
    NoteVram
    Start-Sleep -Seconds 60
  }
  # Cleanup is throttled rather than run every loop: it walks a directory the
  # running instance is writing into.
  if (((Get-Date) - $lastClean).TotalMinutes -ge 15) {
    CleanProjects
    $lastClean = Get-Date
  }
}
