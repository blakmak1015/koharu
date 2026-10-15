$ErrorActionPreference = "Continue"
$exe = "C:\Users\blakm\koharu\target\release\koharu.exe"
Write-Host ("koharu.exe LastWriteTime: " + (Get-Item $exe).LastWriteTime)

# Make sure nothing is still running
Get-Process koharu -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# Launch the SERVER instance (built-in translation agent auto-starts, hidden tray)
$env:KOHARU_INSTANCE_ID = "server"
$env:KOHARU_DATA_ROOT = $null
$env:KOHARU_TRAY_START = "1"
Start-Process $exe -WindowStyle Minimized
$env:KOHARU_TRAY_START = $null
Write-Host "Launched server; waiting for :4000 ..."

$up = $false
foreach ($i in 1..40) {
  Start-Sleep -Seconds 2
  try {
    if ((Invoke-WebRequest "http://127.0.0.1:4000/api/v1/config" -TimeoutSec 4 -UseBasicParsing).StatusCode -eq 200) { $up = $true; break }
  } catch {}
}
if (-not $up) { Write-Host "server :4000 did NOT come up in ~80s"; exit 1 }
Write-Host "server :4000 UP"

# Select the openai-compatible provider + model (points koharu at the shared LLM)
$body = @{ target = @{ kind = "provider"; modelId = "Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q5_K_M.gguf"; providerId = "openai-compatible" } } | ConvertTo-Json -Compress
try {
  Invoke-WebRequest "http://127.0.0.1:4000/api/v1/llm/current" -Method Put -ContentType "application/json" -Body $body -TimeoutSec 90 -UseBasicParsing | Out-Null
  Write-Host "model set OK"
} catch { Write-Host ("model set FAILED: " + $_.Exception.Message) }

# Report current LLM target
try {
  $cur = (Invoke-WebRequest "http://127.0.0.1:4000/api/v1/llm/current" -TimeoutSec 10 -UseBasicParsing).Content
  Write-Host ("llm/current -> " + $cur)
} catch { Write-Host ("llm/current read failed: " + $_.Exception.Message) }
