#!/bin/bash
# Weekly CMBS corpus maintenance. Runs on the Mac (needs Docker), not in a VM.
#   Install the schedule:  tools/install-weekly-maintenance.sh
#   Run by hand:           tools/weekly-maintenance.sh
#
# Needs SEC_USER_AGENT in .env (copy .env.example); the harvester loads it.
#
# Writes to .snapshots/weekly/:
#   <date>.log          full output of every step
#   <date>.monitor.txt  db:monitor output only
#   latest.env          exit code of every step; read by the scheduled cloud task
#   latest.txt          one-line verdict
# Tests always run, even when the database is unavailable.

export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"
# launchd does not load the shell profile: pick up nvm if that is where node lives.
if ! command -v npm >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi

cd "$(dirname "$0")/.." || exit 1
LOGDIR=".snapshots/weekly"; mkdir -p "$LOGDIR"
DAY="$(date +%F)"
LOG="$LOGDIR/$DAY.log"
MONLOG="$LOGDIR/$DAY.monitor.txt"
exec >"$LOG" 2>&1
echo "started $(date '+%F %T %Z')"

DB=ok; MIGRATE=skipped; HARVEST=skipped; PERF=skipped; MON=skipped; TESTS=skipped
USER_AGENT=ok
grep -qE '^SEC_USER_AGENT=.+' .env 2>/dev/null || [ -n "$SEC_USER_AGENT" ] || USER_AGENT=missing
[ "$USER_AGENT" = missing ] && echo "WARNING: SEC_USER_AGENT is not set in .env; EDGAR will answer 403."

start_db() {
  if ! docker info >/dev/null 2>&1; then
    open -a Docker 2>/dev/null
    for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 5; done
  fi
  docker info >/dev/null 2>&1 || { DB="docker-down"; return 1; }
  npm run db:up || { DB="db-up-failed"; return 1; }
  for _ in $(seq 1 20); do
    docker exec financials-postgres pg_isready -U financials >/dev/null 2>&1 && return 0; sleep 3
  done
  DB="postgres-not-ready"; return 1
}

# 1-3. Database steps: migrate, harvest, rebuild performance, monitor.
if start_db; then
  npm run db:migrate; MIGRATE=$?
  if [ "$MIGRATE" -eq 0 ]; then
    npm run harvest:batch -- --refresh-stale --refresh-limit 30; HARVEST=$?
    if [ "$HARVEST" -eq 0 ]; then npm run db:performance; PERF=$?; fi
    npm run db:monitor 2>&1 | tee "$MONLOG"; MON=${PIPESTATUS[0]}
  fi
fi

# 4. Tests, always.
npm run test:all; TESTS=$?

FINISHED="$(date '+%F %T %Z')"
echo "finished $FINISHED"
cat > "$LOGDIR/latest.env" <<EOF
DATE=$DAY
FINISHED="$FINISHED"
USER_AGENT=$USER_AGENT
DB=$DB
MIGRATE=$MIGRATE
HARVEST=$HARVEST
PERFORMANCE=$PERF
MONITOR=$MON
TESTS=$TESTS
LOG=$LOG
MONITOR_LOG=$MONLOG
EOF

bad() { [ "$1" != skipped ] && [ "$1" != 0 ]; }
SUMMARY="db=$DB migrate=$MIGRATE harvest=$HARVEST performance=$PERF monitor=$MON tests=$TESTS"
if [ "$DB" != ok ] || bad "$MIGRATE" || bad "$HARVEST" || bad "$PERF" || bad "$MON" || bad "$TESTS"; then
  MSG="Corpus CMBS: hay algo para mirar ($SUMMARY). Log: $LOG"
  echo "$MSG" > "$LOGDIR/latest.txt"
  osascript -e "display notification \"$MSG\" with title \"CMBS corpus\"" 2>/dev/null
  exit 1
fi
echo "Corpus sin cambios ($SUMMARY)" > "$LOGDIR/latest.txt"
