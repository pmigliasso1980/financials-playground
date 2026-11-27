#!/bin/bash
# Installs a launchd job: Mondays 06:30 local time (two hours before the cloud task reads the result), runs weekly-maintenance.sh.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
grep -qE '^SEC_USER_AGENT=.+' "$REPO/.env" 2>/dev/null || echo "Warning: set SEC_USER_AGENT in $REPO/.env (see .env.example) or the harvest gets 403."
PLIST="$HOME/Library/LaunchAgents/com.financials.weekly-maintenance.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.financials.weekly-maintenance</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/tools/weekly-maintenance.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardErrorPath</key><string>/tmp/weekly-maintenance.err</string>
</dict></plist>
PL
chmod +x "$REPO/tools/weekly-maintenance.sh"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed: $PLIST (Mondays 06:30). Test now with: launchctl start com.financials.weekly-maintenance"
