#!/bin/bash
# macOS counterpart of publish_local.ps1: the whole pipeline, collection then
# the model stages that need a local Ollama, ending with a --push to Neon.
# Scheduled by launchd (registered by scripts/register_publish_agent.sh).
# Keep the stage list in step with publish_local.ps1; the comments there
# explain the --days / --limit choices and why there is no --pull.
#
# Every stage keeps going on failure: each CLI stage commits its own work, and
# the final --push always runs, so whatever did succeed reaches Neon.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="$REPO_ROOT/scripts/publish_local.log"
LOCK_FILE="$REPO_ROOT/scripts/.publish_local.lock"
PYTHON="$REPO_ROOT/.venv/bin/python"

# launchd starts jobs with a bare PATH; Homebrew's ollama lives here.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PYTHONIOENCODING=utf-8
export PYTHONUNBUFFERED=1

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

run_stage() {
    local label="$1"; shift
    log "stage: $label"
    "$PYTHON" "$@" 2>&1 | tee -a "$LOG_FILE"
    return "${PIPESTATUS[0]}"
}

# An overlapping run would race the same SQLite file. A lock older than 4
# hours is left over from a crash.
if [ -f "$LOCK_FILE" ]; then
    age_min=$(( ($(date +%s) - $(stat -f %m "$LOCK_FILE")) / 60 ))
    if [ "$age_min" -lt 240 ]; then
        log "Previous run still marked active (lock is ${age_min} min old) - skipping this cycle."
        exit 0
    fi
    log "Stale lock (${age_min} min old) - a previous run likely crashed. Proceeding."
fi
touch "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

log "=== publish_local starting ==="
cd "$REPO_ROOT" || exit 1

# .env is gitignored and the Python side reads os.environ only. launchd does
# not load a shell profile, so YOUTUBE_API_KEY belongs in .env here too.
if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[[:space:]]*[^#[:space:]][^=]*= ]] || continue
        key="${line%%=*}"; val="${line#*=}"
        key="$(echo "$key" | xargs)"
        val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')"
        export "$key=$val"
    done < .env
fi
if [ -z "$DATABASE_URL" ]; then
    log "DATABASE_URL not set (expected in $REPO_ROOT/.env) - aborting."
    exit 1
fi

# jejak.db is the pipeline's state. Running against an empty one would mint
# fresh row ids and push them over Neon's, so refuse instead.
db_bytes=$(stat -f %z jejak.db 2>/dev/null || echo 0)
if [ "$db_bytes" -lt 1048576 ]; then
    log "jejak.db is missing or empty ($db_bytes bytes) - copy it from the old machine. Aborting."
    exit 1
fi

if ! curl -s -m 3 http://localhost:11434/api/tags >/dev/null; then
    log "Ollama not reachable, starting it."
    nohup ollama serve >/dev/null 2>&1 &
    ready=0
    for _ in $(seq 30); do
        sleep 1
        if curl -s -m 2 http://localhost:11434/api/tags >/dev/null; then ready=1; break; fi
    done
    if [ "$ready" -ne 1 ]; then
        log "Ollama did not become reachable within 30s - aborting."
        exit 1
    fi
    log "Ollama is up."
fi

# Neon gets one push a day, from the evening run: each push wakes Neon's
# compute, and the free tier's monthly allowance is tight. The 05:00 and 11:00
# runs only work locally; their rows ride along with the evening push. A run
# starting at 18:00 or later pushes if none has today (so a run launchd catches
# up after sleep still counts). PUSH=1 forces a push.
PUSH_STAMP="$REPO_ROOT/scripts/.last_neon_push"
today=$(date +%F)
do_push=0
if [ "${PUSH:-0}" = 1 ] || { [ "$(date +%H)" -ge 18 ] && [ "$(cat "$PUSH_STAMP" 2>/dev/null)" != "$today" ]; }; then
    do_push=1
fi

# Curator decisions from /kurasi go in first, so this run's attribution,
# clustering and linking already follow them. Only on the run that pushes:
# reading them is a Neon round trip too, and that run is awake anyway.
if [ "$do_push" = 1 ]; then
    run_stage "apply curation" scripts/apply_curation.py --apply \
        || log "apply curation failed - the decisions stay pending for the next push run."
fi

# Generated CVs (cv/<figure-id>.json) into the roster. After apply curation, so
# a figure a curator just edited is already marked and is not overwritten.
run_stage "import cv" scripts/import_cv.py --apply

run_stage "ingest" -m jejak.cli ingest
run_stage "backfill" -m jejak.cli backfill --days 6
run_stage "fetch" -m jejak.cli fetch --limit 200
run_stage "mentions" -m jejak.cli mentions --limit 1000
for stage in cluster link quotes translate summarize sentiment buzzer suggest; do
    run_stage "$stage" -m jejak.cli "$stage"
done
if [ "$do_push" = 1 ]; then
    if run_stage "push to Neon" scripts/sync_to_neon.py --push; then
        echo "$today" > "$PUSH_STAMP"
    else
        log "push to Neon failed - the next evening run retries it."
    fi
else
    log "push to Neon skipped - pushes run once a day, from the 18:00 run."
fi

log "=== publish_local done ==="
