# Keep an SSH tunnel from this farm box to the LLM box (PTC).
#
# The LLM was reached through translate.manga-th.net, i.e. Cloudflare, which
# cuts any request at 100 s (HTTP 524). A long page takes 60-70 s on its own and
# two pages in flight take longer, so the farm talks to PTC over the LAN instead:
# local 127.0.0.1:7677 -> PTC 127.0.0.1:7676 (llama-server only listens locally).
# SSH is already open on PTC, so no port or firewall change is needed there.
#
# PURE ASCII ON PURPOSE (PowerShell 5.1 reads a BOM-less .ps1 as ANSI).

param(
  [string] $LlmHost = "192.168.1.64",
  [string] $User    = "blakm",
  [int]    $Local   = 7677,
  [int]    $Remote  = 7676
)

$log = "$env:USERPROFILE\llm-tunnel.log"
$mutex = New-Object System.Threading.Mutex($false, 'Global\koharu-llm-tunnel')
if (-not $mutex.WaitOne(0)) { return }

while ($true) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  opening tunnel to $LlmHost" | Out-File $log -Append -Encoding utf8
  # ServerAlive: notice a dead link in ~30 s and let the loop reconnect
  & ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 `
      -L "127.0.0.1:${Local}:127.0.0.1:${Remote}" "$User@$LlmHost" 2>> $log
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  tunnel closed (exit $LASTEXITCODE), retrying in 5 s" | Out-File $log -Append -Encoding utf8
  Start-Sleep -Seconds 5
}
