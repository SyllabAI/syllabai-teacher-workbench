#!/usr/bin/env bash
# R3-8 — restart battery on the real host:
#   R1 restart during normal operation -> no state corruption
#   R2 staging-log persistence across restart
#   R3 reviewer-registry persistence across restart
#   R4 restart does NOT regenerate the production session secret
#   R5 session survival semantics: valid session survives restart (same secret,
#      unexpired); revocation still kills it afterwards (documented epoch/expiry model)
#   R6 live session can still stage after restart (registry revalidated, log appends)
#      -- append happens in Phase G only; here we assert GET-side liveness
set -u
P=/home/z/workbench-prod
EV=/home/z/my-project/download/evidence-r3-8
R2COOKIE=$(cat /tmp/r2cookie)
{
echo "== R3-8 restart battery $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "-- pre-restart fingerprints:"
sha256sum $P/state/decision-log.jsonl $P/state/reviewers.json $P/state/provisioning-log.jsonl $P/secrets/session-secret.key | sed "s|$P/||"
echo "-- R2 session pre-restart staging GET: $(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:81/api/decisions -H "cookie: tvs=$R2COOKIE")"
} | tee $EV/phase-c-restart-battery.log
bash $P/ops/deploy.sh >> $EV/phase-c-restart-battery.log 2>&1   # full stop+start cycle (health-gated)
{
echo "-- post-restart fingerprints:"
sha256sum $P/state/decision-log.jsonl $P/state/reviewers.json $P/state/provisioning-log.jsonl $P/secrets/session-secret.key | sed "s|$P/||"
echo "-- R2 session post-restart staging GET: $(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:81/api/decisions -H "cookie: tvs=$R2COOKIE")  (12h unexpired session survives restart by design: same secret, same registry)"
echo "-- chainValid via app post-restart: $(curl -s http://127.0.0.1:81/api/decisions | head -c 60)"
echo "-- registry still authoritative: $(curl -s -X POST http://127.0.0.1:81/api/session -H "content-type: application/json" -d '{"token":"tvr_bogus_bogus"}' -o /dev/null -w "%{http_code}") on bogus token (403 = registry consulted, fail-closed)"
} | tee -a $EV/phase-c-restart-battery.log