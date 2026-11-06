#!/bin/bash
# Registers (or replaces) the launchd agent that keeps the Telegram curation
# bot (web/scripts/telegram-bot.ts) running: started at login, restarted if it
# exits. It runs from this checkout's web/, so register it from the main
# checkout, with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in web/.env.local.
#
#   bash scripts/register_telegram_agent.sh            # register / restart
#   bash scripts/register_telegram_agent.sh --remove   # stop and unregister

LABEL="com.jejaksuara.telegram-bot"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$REPO_ROOT/scripts/telegram_bot.log"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
if [ "$1" = "--remove" ]; then
    rm -f "$PLIST"
    echo "Removed '$LABEL'."
    exit 0
fi

NPM="$(command -v npm)" || { echo "npm not found on PATH" >&2; exit 1; }
if ! grep -q '^TELEGRAM_CHAT_ID=.' "$REPO_ROOT/web/.env.local" 2>/dev/null; then
    echo "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in $REPO_ROOT/web/.env.local first." >&2
    exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NPM</string>
        <string>run</string>
        <string>--silent</string>
        <string>telegram-bot</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT/web</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$NPM"):/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST" || exit 1
echo "Registered '$LABEL' ($PLIST). Log: $LOG"
