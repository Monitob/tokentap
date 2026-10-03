#Requires -Version 5.1
<#
.SYNOPSIS
  Runs TokenTap natively in the foreground (the action of the scheduled task).

.DESCRIPTION
  Designed to be invoked by the "TokenTap" scheduled task (trigger: AtLogOn).
  - Holds a global named mutex so only ONE launcher instance ever runs.
  - If TokenTap is already listening on $Port, exits without starting another.
  - Otherwise runs `node bin\tokentap.js` in the FOREGROUND and restarts it
    $RestartDelaySec seconds after any unexpected exit, streaming output to
    logs/tokentap-<date>.log.

  Why foreground? A Scheduled Task terminates child processes when its action
  exits (job-object kill-on-close). Running node in the foreground keeps the
  task alive so the proxy stays up; the restart loop recovers from crashes.

  Configuration: TokenTap's built-in defaults + an optional .env file in
  $RepoDir (real environment variables always win over .env).

.PARAMETER RepoDir
  Path to the TokenTap repo (contains bin\tokentap.js). Defaults to the
  parent of this script's directory.

.PARAMETER Port
  Port TokenTap listens on (default 3459). Used only for the idempotency guard.

.PARAMETER RestartDelaySec
  Seconds to wait before restarting node after an exit (default 3).
#>
[CmdletBinding()]
param(
  [string]$RepoDir        = (Resolve-Path "$PSScriptRoot\..").Path,
  [int]   $Port            = 3459,
  [int]   $RestartDelaySec = 3
)

$ErrorActionPreference = 'Stop'

# Decode node's UTF-8 stdout correctly into the PowerShell pipeline so log
# entries (e.g. the → arrows) are not mojibake'd. utf8NoBOM keeps logs clean.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding           = [System.Text.UTF8Encoding]::new($false)

# --- Locate node ---------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH." }

$entry = Join-Path $RepoDir 'bin\tokentap.js'
if (-not (Test-Path -LiteralPath $entry)) {
  throw "TokenTap entry not found: $entry"
}

# --- Single-instance guard (named mutex) ---------------------------------------
$mutex = New-Object System.Threading.Mutex($false, 'Global\TokenTapLauncher')
$owns  = $mutex.WaitOne(0)
if (-not $owns) {
  Write-Output "TokenTap launcher already running. Exiting."
  return
}

# --- Idempotency: skip if something is already listening on $Port ---------------
$listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listening) {
  $pids = ($listening.OwningProcess | Sort-Object -Unique) -join ','
  Write-Output "TokenTap already listening on $Port (PID $pids). Exiting."
  return
}

# --- Logging -------------------------------------------------------------------
$logDir = Join-Path $RepoDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd'
$log   = Join-Path $logDir "tokentap-$stamp.log"
Write-Output "TokenTap launcher: starting node -> 127.0.0.1:$Port (logs: $log)"

# --- Run + auto-restart loop ---------------------------------------------------
try {
  while ($true) {
    $start = Get-Date
    # Stream node stdout+stderr to the log, one line at a time (tailable).
    & $node $entry 2>&1 | ForEach-Object {
      Add-Content -Path $log -Encoding utf8 -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $_)
    }
    $rc  = $LASTEXITCODE
    $dur = (Get-Date) - $start
    Add-Content -Path $log -Encoding utf8 -Value `
      ("[{0}] node exited (code {1}) after {2}s; restarting in {3}s." -f `
        (Get-Date -Format 'o'), $rc, [int]$dur.TotalSeconds, $RestartDelaySec)
    Start-Sleep -Seconds $RestartDelaySec
  }
}
finally {
  if ($owns) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
