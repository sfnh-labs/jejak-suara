#!/bin/bash
# macOS counterpart of register_publish_task.ps1: registers (or replaces) the
# launchd agent that runs publish_local.sh daily at 05:00, 11:00 and 18:00.
# launchd runs a cycle missed during sleep once the Mac wakes; a Mac that was
# shut down skips it.
#
#   bash scripts/register_publish_agent.sh

LABEL="com.jejaksuara.publish-local"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/publish_local.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

chmod +x "$SCRIPT"
mkdir -p "$HOME/Library/LaunchAgents"

trigger() {
    printf '        <dict><key>Hour</key><integer>%d</integer><key>Minute</key><integer>0</integer></dict>\n' "$1"
}

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>StartCalendarInterval</key>
    <array>
$(trigger 5)
$(trigger 11)
$(trigger 18)
    </array>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>$REPO_ROOT/scripts/publish_local.launchd.err</string>
    <key>ProcessType</key>
    <string>Standard</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST" || exit 1

echo "Registered '$LABEL' ($PLIST). Runs daily at 05:00, 11:00 and 18:00."
echo "Run a cycle now:  launchctl kickstart gui/$(id -u)/$LABEL"
