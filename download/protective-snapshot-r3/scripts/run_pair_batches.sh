#!/usr/bin/env bash
# T-C03 Stage 1: run syllabai-glmocr-pair for every session of paper 1 + paper 2.
# Bundles -> /home/z/my-project/t-c03/<paper-slug>/<session>/
# Summary -> /home/z/my-project/t-c03/pair_runs.tsv
set -u
export JAVA_HOME=/home/z/tools/jdk-25.0.4.1+1
JAVA=$JAVA_HOME/bin/java
CP="/home/z/my-project/repos/syllabai-parser/target/classes:$(cat /tmp/cp.txt)"
PP="/home/z/my-project/repos/Past-Papers"
OUT=/home/z/my-project/t-c03
TSV="$OUT/pair_runs.tsv"
echo -e "paper\tsession\tquestions\tms_entries\tmismatches\tpaper_total_conflict\treview_required\tdoc_ids" > "$TSV"

fail=0
for paper in "paper 1" "paper 2"; do
  slug=$(echo "$paper" | tr ' ' '-')
  for sessdir in "$PP/$paper"/*/; do
    sess=$(basename "$sessdir")
    [[ -f "$sessdir/QP.md" && -f "$sessdir/MS.md" ]] || { echo "SKIP $paper/$sess (no QP/MS pair)"; continue; }
    out="$OUT/$slug/$sess"
    line=$("$JAVA" -cp "$CP" com.syllabai.parser.GlmOcrPairCli \
        "$sessdir/QP.md" "$sessdir/MS.md" "$out" --uri-prefix="$paper/$sess" 2>&1 | head -1)
    if [[ $? -ne 0 || -z "$line" ]]; then echo "FAIL $paper/$sess"; fail=1; continue; fi
    # parse: pair: qp=<id> ms=<id>; questions: N; ms entries: N; review required: bool (mismatches: N, paper-total conflict: bool)
    q=$(echo "$line"   | sed -E 's/.*questions: ([0-9]+).*/\1/')
    m=$(echo "$line"   | sed -E 's/.*ms entries: ([0-9]+).*/\1/')
    mis=$(echo "$line" | sed -E 's/.*mismatches: ([0-9]+).*/\1/')
    ptc=$(echo "$line" | sed -E 's/.*paper-total conflict: ([a-z]+).*/\1/')
    rr=$(echo "$line"  | sed -E 's/.*review required: ([a-z]+).*/\1/')
    ids=$(echo "$line" | sed -E 's/pair: qp=([^ ]+) ms=([^;]+);.*/\1|\2/')
    echo -e "$paper\t$sess\t$q\t$m\t$mis\t$ptc\t$rr\t$ids" >> "$TSV"
  done
done
echo "=== done, fail=$fail ==="
column -t -s$'\t' "$TSV" | head -90
