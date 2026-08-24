# Runs the whole pipeline: collection (ingest/fetch/cluster) then the model
# stages (translate/summarize/sentiment/buzzer) that need a local Ollama.
# Scheduled on this machine via Task Scheduler (registered by
# scripts/register_publish_task.ps1). Neon holds the durable state, so the
# run starts with a --pull and ends with a --push.
#
# Collection used to live in a GitHub Actions cron. That split existed only
# because runners have no Ollama; it cost a second set of secrets and a second
# schedule to keep aligned, so it was folded back in here.
#
# Every step keeps going on failure rather than aborting the run: each CLI
# stage commits its own work, so a mid-run error just means less got published
# this cycle, not a half-written database. The final --push always runs, so
# whatever did succeed reaches Neon.

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $RepoRoot "scripts\publish_local.log"
$LockFile = Join-Path $RepoRoot "scripts\.publish_local.lock"
$OllamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    $line | Tee-Object -FilePath $LogFile -Append
}

# Run one pipeline step, logging everything it writes.
#
# The ForEach-Object is not decoration. PowerShell turns every stderr line from
# a native command into an ErrorRecord, so `2>&1` makes a progress bar or a
# library warning render as a NativeCommandError block with PowerShell context
# wrapped around it - "Loading weights: 100%" arriving as a red error. Casting
# each object to a string flattens it back to the line python actually wrote,
# which keeps the log readable and leaves red text meaning something went
# wrong.
function Invoke-Stage([string]$Label, [string[]]$Arguments) {
    Log "stage: $Label"
    & python @Arguments 2>&1 | ForEach-Object { "$_" } |
        Tee-Object -FilePath $LogFile -Append
}

# A resummarize backfill or a slow model can outlast the scheduling interval;
# without a lock, an overlapping run would race the same SQLite file.
if (Test-Path $LockFile) {
    $age = (Get-Date) - (Get-Item $LockFile).LastWriteTime
    if ($age.TotalHours -lt 4) {
        Log "Previous run still marked active (lock is $([int]$age.TotalMinutes) min old) - skipping this cycle."
        exit 0
    }
    Log "Stale lock ($([int]$age.TotalHours)h old) - a previous run likely crashed. Proceeding."
}
New-Item -ItemType File -Path $LockFile -Force | Out-Null

try {
    Log "=== publish_local starting ==="
    Set-Location $RepoRoot

    # .env is gitignored and not read by the Python side (which uses
    # os.environ directly) - load it into the process environment here.
    $envFile = Join-Path $RepoRoot ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | Where-Object { $_ -match "^\s*[^#\s][^=]*=" } | ForEach-Object {
            $k, $v = $_ -split "=", 2
            $v = $v.Trim().Trim('"')
            [Environment]::SetEnvironmentVariable($k.Trim(), $v, "Process")
        }
    }
    if (-not $env:DATABASE_URL) {
        Log "DATABASE_URL not set (expected in $envFile) - aborting."
        exit 1
    }

    $tags = $null
    try { $tags = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 3 } catch {}
    if (-not $tags) {
        Log "Ollama not reachable, starting it."
        Start-Process -FilePath $OllamaExe -ArgumentList "serve" -WindowStyle Hidden
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            try { Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 2 | Out-Null; $ready = $true; break } catch {}
        }
        if (-not $ready) {
            Log "Ollama did not become reachable within 30s - aborting."
            exit 1
        }
        Log "Ollama is up."
    }

    Invoke-Stage "pull from Neon" @("scripts\sync_to_neon.py", "--pull")

    Invoke-Stage "ingest" @("-m", "jejak.cli", "ingest")

    # RSS only reaches back about a day, so each cycle also walks further back
    # through the outlet archives. Six days a cycle, four cycles a day, is
    # roughly a month of history per day - about a month to reach the floor
    # date, after which this stage becomes a no-op.
    Invoke-Stage "backfill" @("-m", "jejak.cli", "backfill", "--days", "6")

    # The fetch limit is tied to the backfill rate, not chosen for its own sake.
    # An article with no body is summarized from its headline alone (backfilled
    # rows carry no RSS lead either), and nothing re-summarizes an event when a
    # body arrives later - so a fetch queue that cannot keep up turns into
    # history made of headlines. Six days a cycle yields ~150 figure articles;
    # 200 drains that plus the RSS intake, at ~1s each.
    Invoke-Stage "fetch" @("-m", "jejak.cli", "fetch", "--limit", "200")

    # Figure discovery. The roster is not a hand-kept list: this mines the
    # articles fetched above for "<office> <name>" mentions and promotes anyone
    # named by enough distinct outlets, which is the only thing that grows the
    # number of figures records can be written about. Runs before clustering so
    # a figure promoted this cycle owns the articles clustered this cycle.
    Invoke-Stage "mentions" @("-m", "jejak.cli", "mentions", "--limit", "1000")

    foreach ($stage in @("cluster", "translate", "summarize",
                         "sentiment", "buzzer")) {
        Invoke-Stage $stage @("-m", "jejak.cli", $stage)
    }

    Invoke-Stage "push to Neon" @("scripts\sync_to_neon.py", "--push")

    Log "=== publish_local done ==="
}
finally {
    Remove-Item -Path $LockFile -Force -ErrorAction SilentlyContinue
}
