#!/usr/bin/env bash
# R3-6 browser verification — two-phase, real staging log untouched.
#   Phase A (real log, READ-ONLY browsing): canonical/staged/applied panels,
#           rehearsal applied-chips in the staging-log sheet.
#   Phase B (scratch log, staging write):   session flow + staged VALIDATE +
#           relationship badges + mobile viewport.
# Every step is logged to browser-verify.log; server console/errors captured.
set -u
EV=/home/z/my-project/download/evidence-r3-6
SHOT=$EV/screenshots
SCRATCH=/home/z/my-project/download/teacher-validation/test-runs/browser-verify-decision-log.jsonl
REAL_LOG=/home/z/my-project/download/teacher-validation/decision-log.jsonl
LOG=$EV/browser-verify.log
REAL_SHA_BEFORE=$(sha256sum "$REAL_LOG" | cut -d' ' -f1)
mkdir -p "$SHOT" /home/z/my-project/download/teacher-validation/test-runs
: > "$LOG"

start_server() {  # $1 = extra env
  ( cd /home/z/my-project && setsid env $1 bun x next dev -p 3000 > /tmp/tv-dev.log 2>&1 < /dev/null & )
  for i in $(seq 1 40); do
    sleep 2
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/api/review/index || true)
    [ "$code" = "200" ] && return 0
  done
  echo "SERVER FAILED TO START" >> "$LOG"; return 1
}
stop_server() {
  pkill -f "next dev -p 3000" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 2
}

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# ---------------------------------------------------------------- Phase A
say "PHASE A: real log, read-only browsing"
start_server "TV_NOOP=1" || exit 1

agent-browser set viewport 1440 900 >> "$LOG" 2>&1
agent-browser open http://127.0.0.1:3000/ >> "$LOG" 2>&1
agent-browser wait --text "What I am proposing" >> "$LOG" 2>&1
agent-browser wait --text "canonical feed LIVE" >> "$LOG" 2>&1
agent-browser screenshot "$SHOT/01-workbench-top.png" --full >> "$LOG" 2>&1
say "01 top screenshot: banners + live feed pill"

# open the FLAG target session (4CH1/1C January 2021 — paper-level applied FLAG+REVERSE)
agent-browser eval "
  [...document.querySelectorAll('button')].find(b => b.textContent.includes('4CH1/1C') && b.textContent.includes('January 2021')).click();
  'clicked'" >> "$LOG" 2>&1
agent-browser wait --text "session decision" >> "$LOG" 2>&1
sleep 1
agent-browser screenshot "$SHOT/02-dossier-paper-applied.png" --full >> "$LOG" 2>&1
say "02 paper dossier: CANONICAL row + APPLIED FLAG/REVERSE rows with attribution"

# same paper contains rehearsal-VALIDATEd question version (VALIDATE then REVERSE)
agent-browser eval "
  const q = [...document.querySelectorAll('.space-y-3 > div, [class*=Card]')];
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('validate'));
  el ? el.scrollIntoView({block:'center'}) : null;
  'scrolled'" >> "$LOG" 2>&1
sleep 1
agent-browser screenshot "$SHOT/03-question-applied-then-reversed.png" >> "$LOG" 2>&1
say "03 question panel: applied VALIDATE + applied REVERSE + relationship chips"

# staging-log sheet: rehearsal entries must show APPLIED, THEN REVERSED chips
agent-browser find role button click --name "Staging log" >> "$LOG" 2>&1
sleep 1
agent-browser wait --text "APPLIED, THEN REVERSED" >> "$LOG" 2>&1
agent-browser screenshot "$SHOT/04-staging-log-applied-chips.png" >> "$LOG" 2>&1
agent-browser press Escape >> "$LOG" 2>&1; sleep 1
say "04 staging log sheet: applied/unapplied chips from canonical events feed"

agent-browser console > /tmp/tv-console.txt 2>&1
agent-browser errors > /tmp/tv-errors.txt 2>&1
cp /tmp/tv-console.txt "$EV/phaseA-console.txt"; cp /tmp/tv-errors.txt "$EV/phaseA-errors.txt"
say "phase A console/errors captured"

# ---------------------------------------------------------------- Phase B
say "PHASE B: scratch log, staging flow"
stop_server
rm -f "$SCRATCH"
start_server "TV_LOG_FILE=$SCRATCH" || exit 1

agent-browser open http://127.0.0.1:3000/ >> "$LOG" 2>&1
agent-browser wait --text "canonical feed LIVE" >> "$LOG" 2>&1
# open a teacher session
agent-browser find role textbox fill --name "reviewer name" "Browser Verification (R3-6)" >> "$LOG" 2>&1 || \
  agent-browser eval "
    const i = document.querySelector('input[aria-label=\"reviewer name\"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, 'Browser Verification (R3-6)');
    i.dispatchEvent(new Event('input', {bubbles: true}));
    'filled'" >> "$LOG" 2>&1
sleep 1
agent-browser find role button click --name "open session" >> "$LOG" 2>&1
agent-browser wait --text "teacher session" >> "$LOG" 2>&1
say "session opened"

# open a dossier with a SUGGESTED version and stage a VALIDATE
agent-browser eval "
  [...document.querySelectorAll('button')].find(b => b.textContent.includes('4CH0/1C') && b.textContent.includes('January 2012')).click();
  'clicked'" >> "$LOG" 2>&1
agent-browser wait --text "session decision" >> "$LOG" 2>&1
sleep 1
agent-browser eval "
  const btns = [...document.querySelectorAll('button')].filter(b => b.textContent.trim().replace(/\\s+/g,' ').includes('validate') && !b.disabled);
  btns[0] ? (btns[0].scrollIntoView({block:'center'}), btns[0].click(), 'staged') : 'none-found'" >> "$LOG" 2>&1
sleep 2
agent-browser screenshot "$SHOT/05-staged-validate-relationship.png" --full >> "$LOG" 2>&1
say "05 staged VALIDATE: STAGED — NOT YET APPLIED chip + WOULD CHANGE badge + toast"

# staging log sheet shows the new entry as STAGED — NOT YET APPLIED
agent-browser find role button click --name "Staging log" >> "$LOG" 2>&1
sleep 1
agent-browser wait --text "STAGED — NOT YET APPLIED" >> "$LOG" 2>&1
agent-browser screenshot "$SHOT/06-staging-log-staged-chip.png" >> "$LOG" 2>&1
agent-browser press Escape >> "$LOG" 2>&1; sleep 1
say "06 log sheet: new entry shows STAGED — NOT YET APPLIED (not applied)"

# mobile viewport
agent-browser set viewport 390 844 >> "$LOG" 2>&1
agent-browser screenshot "$SHOT/07-mobile-390x844.png" --full >> "$LOG" 2>&1
say "07 mobile viewport"

agent-browser console > "$EV/phaseB-console.txt" 2>&1
agent-browser errors > "$EV/phaseB-errors.txt" 2>&1
agent-browser close >> "$LOG" 2>&1

stop_server
REAL_SHA_AFTER=$(sha256sum "$REAL_LOG" | cut -d' ' -f1)
if [ "$REAL_SHA_BEFORE" = "$REAL_SHA_AFTER" ]; then
  say "REAL LOG UNTOUCHED: sha256 $REAL_SHA_AFTER"
else
  say "REAL LOG CHANGED — ISOLATION FAILURE ($REAL_SHA_BEFORE -> $REAL_SHA_AFTER)"
fi
say "scratch log entries: $(wc -l < "$SCRATCH" 2>/dev/null || echo 0)"
say "DONE"
