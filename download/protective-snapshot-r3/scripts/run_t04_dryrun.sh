#!/usr/bin/env bash
# run_t04_dryrun.sh — Stage 1 (offline) pair bundles for the next T-C03/T-C04 review.
# NO DB WRITES — bundles are review material only; ingestion stays parked behind
# the T-C04 operator gate.
set -euo pipefail

JAVA_HOME=/tmp/jdk-25.0.4.1+1
PARSER=/home/z/my-project/repos/syllabai-parser
OUTROOT=/home/z/my-project/download/t-c04-dryrun
PAPERS_ROOT=/home/z/my-project/repos/Past-Papers

export JAVA_HOME
export PATH="$JAVA_HOME/bin:/tmp/apache-maven-3.9.9/bin:$PATH"

CP="$PARSER/target/classes:$(cat /tmp/parser-cp.txt)"

rm -rf "$OUTROOT"
mkdir -p "$OUTROOT"

run_pair() {
    local paper="$1" sess="$2"
    local sdir="$PAPERS_ROOT/$paper/$sess"
    local slug
    # igcse-chemistry-4ch0-<1c|2c>-<YYYY><Mon>  e.g. igcse-chemistry-4ch0-1c-jun2011
    local papercode
    case "$paper" in
        "paper 1") papercode="1c" ;;
        "paper 2") papercode="2c" ;;
        *) echo "unknown paper $paper"; exit 2 ;;
    esac
    slug="igcse-chemistry-4ch0-${papercode}-$(echo "$sess" | tr 'A-Z' 'a-z' | tr -d '-')"
    local out="$OUTROOT/$slug"
    echo "=== $paper/$sess -> $slug"
    java -cp "$CP" com.syllabai.parser.GlmOcrPairCli \
        "$sdir/QP.md" "$sdir/MS.md" "$out" \
        --uri-prefix="corpus/$slug" \
        --assets-dir="$sdir/assets"
    # quick stats
    python3 - "$out" "$slug" <<'PY'
import json, sys
out, slug = sys.argv[1], sys.argv[2]
qp = json.load(open(f"{out}/qp-draft.json"))
rec = json.load(open(f"{out}/reconciliation.json"))
def figures(draft):
    n = 0; avail = 0
    def walk(figs):
        nonlocal n, avail
        for f in figs or []:
            n += 1
            if f.get("availability") == "available": avail += 1
    for q in draft.get("questions", []):
        walk(q.get("figures"))
        for p in q.get("parts", []):
            walk(p.get("figures"))
    return n, avail
tot, av = figures(qp)
print(f"    {slug}: questions={len(qp.get('questions', []))} figures={tot} figures_available={av} "
      f"reconciliation_status={rec.get('status')}")
PY
}

# The dry-run batch: 3 sessions of paper 1 (same bounded size as the merged T-C03 proof)
run_pair "paper 1" "2011-Jun"
run_pair "paper 1" "2012-Jan"
run_pair "paper 1" "2012-Jun"

echo
echo "Bundles under: $OUTROOT"
ls "$OUTROOT"
