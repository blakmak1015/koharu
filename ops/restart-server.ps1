# Restart the translation-farm instance and pin its translation model.
#
# Replaces the 0.59.2-era restart script. Two things changed upstream:
#   * the in-app HTTP API is gone, so this talks to the fork's own control
#     surface (crates/koharu-control) instead of /api/v1/*;
#   * port 4000 now belongs to CEF's remote debugging endpoint in debug builds,
#     and 4100 is the website's editor gateway, so the control surface listens
#     on 4190.
#
# Pinning the model is not optional: an instance that starts on the default
# local provider silently translates to the wrong language.

param(
  [string] $Exe      = "C:\Users\blakm\koharu-port\target\release\koharu.exe",
  [int]    $Port     = 4190,
  [string] $Provider = "openai-compatible",
  [string] $Model    = "Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q5_K_M.gguf",

  # The server's own default is 1.0, which drifts between scripts within a
  # single page. Low enough to stay in one script, high enough to read naturally.
  [double] $Temperature = 0.5,

  # Pinned translation rules. They live in ops/instructions.txt, not in this
  # parameter, because they have to contain Thai and Japanese: this file is
  # ASCII-only on purpose (PowerShell 5.1 reads a BOM-less .ps1 as ANSI and a
  # non-ASCII literal here would break the relaunch path), while the text file
  # is read back with an explicit UTF-8 decode and survives intact.
  #
  # Blank means "read the file". Pass a value only to override it for one run.
  [string] $Instructions = "",

  # The agent's website credentials. Blank leaves whatever is already stored,
  # so the normal restart does not need the token on the command line. The
  # farm window starts hidden, so this is the only way to set one without a
  # human at the keyboard.
  [string] $AgentToken = "",
  [string] $AgentId    = "",

  [int]    $ReadyTimeoutSeconds = 180
)

$ErrorActionPreference = "Continue"
$base = "http://127.0.0.1:$Port"

if ($Instructions -eq "") {
  $instructionsFile = Join-Path $PSScriptRoot "instructions.txt"
  if (-not (Test-Path $instructionsFile)) {
    Write-Host "NOT FOUND: $instructionsFile"
    exit 1
  }
  # -Encoding UTF8 is the whole point: without it PowerShell 5.1 decodes the
  # file as ANSI and every Thai and Japanese character becomes mojibake, which
  # the model would then be asked to follow as a rule.
  $Instructions = (Get-Content -Raw -Encoding UTF8 -Path $instructionsFile).Trim()
  if ($Instructions -eq "") { Write-Host "EMPTY: $instructionsFile"; exit 1 }
}

if (-not (Test-Path $Exe)) { Write-Host "NOT FOUND: $Exe"; exit 1 }
Write-Host ("koharu.exe LastWriteTime: " + (Get-Item $Exe).LastWriteTime)

Get-Process koharu -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

$env:KOHARU_INSTANCE_ID   = "server"
$env:KOHARU_TRAY_START    = "1"
$env:KOHARU_CONTROL_PORT  = "$Port"
Start-Process $Exe -WindowStyle Minimized
$env:KOHARU_TRAY_START   = $null
$env:KOHARU_CONTROL_PORT = $null

# Wait for the pipeline, not just the socket: pinning the model before the
# pipeline has read its configuration races that first read.
Write-Host "Waiting for $base/health to report ready ..."
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-RestMethod "$base/health" -TimeoutSec 4
    if ($health.ready) { $ready = $true; break }
  } catch { }
}
if (-not $ready) {
  Write-Host "server did NOT become ready within ${ReadyTimeoutSeconds}s"
  exit 1
}
Write-Host "server READY"

if ($AgentToken -ne "" -or $AgentId -ne "") {
  $credentials = @{}
  if ($AgentToken -ne "") { $credentials.token = $AgentToken }
  if ($AgentId -ne "")    { $credentials.agentId = $AgentId }
  try {
    $stored = Invoke-RestMethod "$base/agent/credentials" -Method Put `
      -ContentType "application/json; charset=utf-8" `
      -Body ([System.Text.Encoding]::UTF8.GetBytes(($credentials | ConvertTo-Json -Compress))) `
      -TimeoutSec 30
    # The surface never returns the token, only whether one is held.
    Write-Host ("agent credentials -> agentId=" + $stored.agentId + " hasToken=" + $stored.hasToken)
  } catch {
    Write-Host ("AGENT CREDENTIALS FAILED: " + $_.Exception.Message)
    exit 1
  }
}

# reasoning=false is not cosmetic: this llama.cpp build keeps thinking unless it
# is disabled, and a thinking model spends max_tokens on chain-of-thought and
# returns truncated JSON, which arrives here as blank translations.
$payload = @{
  provider     = $Provider
  model        = $Model
  temperature  = $Temperature
  reasoning    = $false
  instructions = $Instructions
}
# As UTF-8 bytes, not as a string. PowerShell 5.1's ConvertTo-Json leaves
# non-ASCII characters raw rather than escaping them, and Invoke-RestMethod
# then encodes a string body as ASCII - every Thai and Japanese character in
# the rules arrives at koharu as a literal "?", and the model is asked to obey
# a rule about "????". Verified: this is what happened on the first attempt.
$body = [System.Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))
try {
  $current = Invoke-RestMethod "$base/llm/current" -Method Put -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 60
  Write-Host ("pinned -> provider=" + $current.provider + " model=" + $current.model)
} catch {
  Write-Host ("PIN FAILED: " + $_.Exception.Message)
  exit 1
}

# Read it back: the pin is the whole point of this script, so prove it stuck.
try {
  $v = Invoke-RestMethod "$base/llm/current" -TimeoutSec 10
} catch {
  Write-Host ("VERIFY FAILED: " + $_.Exception.Message)
  exit 1
}

$problems = @()
if ($v.provider -ne $Provider)        { $problems += "provider is '$($v.provider)', expected '$Provider'" }
if ($v.model -ne $Model)              { $problems += "model is '$($v.model)', expected '$Model'" }
if ($v.temperature -ne $Temperature)  { $problems += "temperature is '$($v.temperature)', expected '$Temperature'" }
if (-not $v.thinkingSuppressed)       { $problems += "thinking is NOT suppressed (reasoning=$($v.reasoning), modelSupportsReasoning=$($v.modelSupportsReasoning)) - translations will come back blank" }

if ($problems.Count -gt 0) {
  Write-Host "VERIFY FAILED:"
  $problems | ForEach-Object { Write-Host ("  - " + $_) }
  exit 1
}
Write-Host ("verified -> provider=" + $v.provider + " model=" + $v.model + " temp=" + $v.temperature + " target=" + $v.targetLanguage + " thinkingSuppressed=" + $v.thinkingSuppressed)
