#!/bin/bash
# macOS counterpart of publish_local.ps1: the whole pipeline, collection then
# the model stages that need a local Ollama, ending with a --push to Neon.
# Scheduled by launchd (registered by scripts/register_publish_agent.sh).
# Keep the stage list in step with publish_local.ps1; the comments there
# explain the --days / --limit choices and why there is no --pull.
#
# Every stage keeps going on failure: each CLI stage commits its own work, and
# the final --push always runs, so whatever did succeed reaches Neon.

# Keep the Mac awake until the run ends (the display may still turn off). A
# sleep mid-run pauses it with jejak.db's write lock held: -i alone left runs
# advancing only in the ~20 s maintenance wakes, so a 75 min run took 8-40 h
# and swallowed the next slots. -s also holds off system sleep on AC power;
# closing the lid without an external display still sleeps the Mac.
if [ -z "$JEJAK_CAFFEINATED" ]; then
    export JEJAK_CAFFEINATED=1
    exec /usr/bin/caffeinate -is /bin/bash "$0" "$@"
fi

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

# A stage that outlives STAGE_TIMEOUT_MIN is stopped so the rest of the run
# (and the push) still happen: a sentiment stage once sat on a dead HTTPS read
# for three days. `sleep` does not count time the Mac spends asleep, so only
# awake time uses up the allowance. An awake run's longest stage (summarize)
# takes under an hour.
STAGE_TIMEOUT_MIN="${STAGE_TIMEOUT_MIN:-180}"

run_stage() {
    local label="$1"; shift
    log "stage: $label"
    "$PYTHON" "$@" > >(tee -a "$LOG_FILE") 2>&1 &
    local pid=$!
    (
        sleep $(( STAGE_TIMEOUT_MIN * 60 ))
        if kill -0 "$pid" 2>/dev/null; then
            log "stage $label still running after ${STAGE_TIMEOUT_MIN} min - stopping it."
            kill "$pid"
        fi
    ) &
    local watchdog=$!
    wait "$pid"
    local rc=$?
    pkill -P "$watchdog" 2>/dev/null
    kill "$watchdog" 2>/dev/null
    wait "$watchdog" 2>/dev/null
    return "$rc"
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

# /kurasi writes its decisions straight into jejak.db, so there is nothing to
# bring down before the stages: they already follow the curator. That also
# makes jejak.db the only copy of the curator's work, so it is backed up first
# (backups/, newest 7 kept).
run_stage "backup" scripts/backup_db.py \
    || log "backup failed - continuing; check disk space in backups/."

# Generated CVs (cv/<figure-id>.json) into the roster. A figure a curator has
# edited is marked and skipped.
run_stage "import cv" scripts/import_cv.py --apply

run_stage "ingest" -m jejak.cli ingest
run_stage "backfill" -m jejak.cli backfill --days 6
run_stage "fetch" -m jejak.cli fetch --limit 1000
run_stage "mentions" -m jejak.cli mentions --limit 1000
# Curation upkeep (jejak/kurasi.py): draft any rework or CV request /kurasi
# left undone, learn from the curator's decisions, rebuild the names queue.
run_stage "kurasi" -m jejak.cli kurasi
for stage in cluster link quotes translate summarize sentiment buzzer suggest; do
    run_stage "$stage" -m jejak.cli "$stage"
done
# Neon gets one push a day, from the evening run: each push wakes Neon's
# compute, and the free tier's monthly allowance is tight. The 05:00 and 11:00
# runs only work locally; their rows ride along with the evening push. A run
# that reaches this point at 18:00 or later pushes if none has today. It is
# decided here, after the stages, not when the run starts: a 05:10 run that
# ran until 21:06 had already decided against pushing, and it had kept
# launchd from starting the 18:00 one, so that day never reached Neon.
# PUSH=1 forces a push.
#
# If yesterday got no push at all (the Mac was asleep or closed through the
# evening), the next run catches up whatever the hour. It stamps yesterday,
# not today, so this evening's push still happens.
PUSH_STAMP="$REPO_ROOT/scripts/.last_neon_push"
today=$(date +%F)
yesterday=$(date -v-1d +%F 2>/dev/null || date -d yesterday +%F)
last_push=$(cat "$PUSH_STAMP" 2>/dev/null)
do_push=0
push_stamp="$today"
if [ "${PUSH:-0}" = 1 ] || { [ "$(date +%H)" -ge 18 ] && [ "$last_push" != "$today" ]; }; then
    do_push=1
elif [ "$last_push" != "$today" ] && [ "$last_push" \< "$yesterday" ]; then
    do_push=1
    push_stamp="$yesterday"
    log "no push since ${last_push:-never} - catching up yesterday's on this run."
fi

if [ "$do_push" = 1 ]; then
    if run_stage "push to Neon" scripts/sync_to_neon.py --push; then
        echo "$push_stamp" > "$PUSH_STAMP"
    else
        log "push to Neon failed - the next evening run retries it."
    fi
else
    log "push to Neon skipped - pushes run once a day, from the first run to finish after 18:00."
fi

log "=== publish_local done ==="
