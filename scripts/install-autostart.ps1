#Requires -Version 5.1
<#
.SYNOPSIS
  Registers the "TokenTap" scheduled task so TokenTap starts at user logon.

.DESCRIPTION
  Creates (or replaces) a per-user scheduled task named "TokenTap" that:
    - triggers AtLogOn for the current user
    - runs scripts\start-tokentap.ps1 hidden, in the user's interactive session
      (no elevation needed — node runs as the normal user)
    - never times out (keeps the proxy alive across crashes via the launcher's
      restart loop)
    - ignores duplicate instances (the launcher's mutex also guards this)

  After running this script, TokenTap will start automatically on every logon.
  To start it immediately without logging off/on, run:
      Start-ScheduledTask -TaskName TokenTap

  To remove the autostart:
      Unregister-ScheduledTask -TaskName TokenTap -Confirm:$false
#>
[CmdletBinding()]
param(
  [string]$RepoDir = (Resolve-Path "$PSScriptRoot\..").Path
)
$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'start-tokentap.ps1'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Launcher not found: $launcher"
}

$taskName = 'TokenTap'

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -RepoDir `"$RepoDir`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances Ignore `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

# Replace any pre-existing task with the same name.
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
  ForEach-Object { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Starts TokenTap (LLM max_tokens proxy) at logon and keeps it running.' `
  -Force | Out-Null

Write-Output "Scheduled task '$taskName' registered for user '$env:USERNAME'."
Write-Output "  Trigger : At logon"
Write-Output "  Launcher: $launcher"
Write-Output "  RepoDir : $RepoDir"
Write-Output ""
Write-Output "Start now:      Start-ScheduledTask -TaskName TokenTap"
Write-Output "Check status:   Get-ScheduledTask -TaskName TokenTap | Get-ScheduledTaskInfo"
Write-Output "Remove autostart: Unregister-ScheduledTask -TaskName TokenTap -Confirm:`$false"
