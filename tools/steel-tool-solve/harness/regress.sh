#!/bin/bash
# bash harness/regress.sh <label> [tree-root]   -- the regression of HANDOFF rule 7 on this session's corpus:
#   collects every question file (red-team probes A, clean + rough copies B, holdout C, $SP/reg/extra) into $SP/reg/all.<label>.json, runs the
#   BASELINE (build 16cede60, $SP/base-src; cached per corpus content, safe for several workers at once) and the tree (default: this checkout),
#   and writes every question whose printed result changed to $SP/reg/<label>.diff.txt.
SP=${SP:-/tmp/claude-0/-home-user-1/a6672620-4f5b-5cfe-8fc0-05cb48074075/scratchpad}
L=${1:-cur}; ROOT=${2:-$(cd "$(dirname "$0")/.." && pwd)}
H=$(cd "$(dirname "$0")" && pwd)
Q=$SP/reg/all.$L.json
node "$H/collect.js" $Q $SP/A $SP/B/clean-all.json $SP/B/rough.json $SP/reg/C-holdout.json $SP/reg/extra >/dev/null
SUM=$(md5sum $Q | cut -c1-12); BASE=$SP/reg/base.$SUM.run.json
if [ ! -f $BASE ]; then STEEL_SRC=$SP/base-src node "$H/batch.js" $Q --out $BASE.tmp.$$ --procs 3 >/dev/null && mv $BASE.tmp.$$ $BASE; fi
node "$ROOT/harness/batch.js" $Q --out $SP/reg/run.$L.json --procs 3 >/dev/null
node "$H/diff.js" $BASE $SP/reg/run.$L.json > $SP/reg/$L.diff.txt
echo "$(python3 -c "import json;print(len(json.load(open('$Q'))))") questions; $(tail -1 $SP/reg/$L.diff.txt) vs baseline -> $SP/reg/$L.diff.txt"
