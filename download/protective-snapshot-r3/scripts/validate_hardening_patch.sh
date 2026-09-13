#!/usr/bin/env bash
# Hardening-patch corpus validation v2: re-run all 82 pairs with the HARDENED
# parser and SEMANTICALLY compare drafts + reconciliation against the Stage-1
# bundles (JSON equality — order-insensitive, immune to the pre-patch
# Map.copyOf salted-order artifact). Canonical docs compared structurally too
# (modulo extractedAt).
# Expected: every session semantically identical EXCEPT paper 1 2011-Jun and
# Specimen-2017 (dot numbering fix).
set -u
export JAVA_HOME=/home/z/tools/jdk-25.0.4.1+1
JAVA=$JAVA_HOME/bin/java
CP="/home/z/my-project/repos/syllabai-parser/target/classes:$(cat /tmp/cp.txt)"
PP="/home/z/my-project/repos/Past-Papers"
BASE=/home/z/my-project/t-c03
OUT=/home/z/my-project/t-c03-validate
TSV="$OUT/diffs2.tsv"
echo -e "paper\tsession\tqp_draft\tms_draft\trecon\tcanonical" > "$TSV"

identical=0; changed=0
for paper in "paper 1" "paper 2"; do
  slug=$(echo "$paper" | tr ' ' '-')
  for sessdir in "$PP/$paper"/*/; do
    sess=$(basename "$sessdir")
    [[ -f "$sessdir/QP.md" && -f "$sessdir/MS.md" ]] || continue
    new="$OUT/$slug/$sess"
    old="$BASE/$slug/$sess"
    "$JAVA" -cp "$CP" com.syllabai.parser.GlmOcrPairCli \
        "$sessdir/QP.md" "$sessdir/MS.md" "$new" --uri-prefix="$paper/$sess" >/dev/null 2>&1
    [[ -d "$old" ]] || { echo -e "$paper\t$sess\tNO_OLD_BUNDLE\t-\t-" >> "$TSV"; continue; }
    res=$(python3 - "$old" "$new" <<'PYEOF'
import json, sys, pathlib
old, new = (pathlib.Path(p) for p in sys.argv[1:3])
def load(p, name):
    return json.loads(p.joinpath(name).read_text(encoding="utf-8"))
def no_ts(doc):
    doc["provenance"]["extractedAt"] = "X"
    return doc
results = {}
for name in ("qp-draft.json", "ms-draft.json", "reconciliation.json"):
    results[name] = "same" if load(old, name) == load(new, name) else "DIFF"
for name in ("qp-canonical.json", "ms-canonical.json"):
    results[name] = "same" if no_ts(load(old, name)) == no_ts(load(new, name)) else "DIFF"
print("\t".join(results[n] for n in
      ("qp-draft.json", "ms-draft.json", "reconciliation.json",
       "qp-canonical.json", "ms-canonical.json")))
PYEOF
)
    qpd=$(echo "$res" | cut -f1); msd=$(echo "$res" | cut -f2)
    rec=$(echo "$res" | cut -f3); can=$(echo "$res" | cut -f4,5)
    echo -e "$paper\t$sess\t$qpd\t$msd\t$rec\t$can" >> "$TSV"
    if [[ "$res" == "samesamesamesamesame" ]]; then
      identical=$((identical+1))
    else
      changed=$((changed+1)); echo "CHANGED: $paper/$sess -> $(echo "$res" | tr '\t' ' ')"
    fi
  done
done
echo "=== semantically identical: $identical  changed: $changed ==="
