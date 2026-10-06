# Registers/updates the Windows Scheduled Task that runs publish_local.ps1.
#
# Three times a day, at 05:00, 11:00 and 18:00. -StartWhenAvailable runs a missed cycle as soon as the
# machine is back, so powering down overnight delays collection rather than
# skipping it.
#
#   powershell -File scripts\register_publish_task.ps1

$TaskName = "JejakSuara-PublishLocal"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $RepoRoot "scripts\publish_local.ps1"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""

$trigger = "05:00", "11:00", "18:00" | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description "Jejak Suara: local publish (translate/summarize/sentiment/buzzer + Neon sync)" `
    -Force

Write-Host "Registered '$TaskName'. Next run:"
(Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo).NextRunTime
