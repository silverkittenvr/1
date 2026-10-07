#!/bin/bash
# bash harness/regress.sh <label> [tree-root]   -- the regression of HANDOFF rule 7 on this session's corpus:
#   collects every question file (red-team probes A, clean + rough copies B, holdout C) into $SP/reg/all.json, runs the BASELINE
#   (build 16cede60, $SP/base-src) and the tree (default: this checkout), and prints every question whose printed result changed.
SP=${SP:-/tmp/claude-0/-home-user-1/a6672620-4f5b-5cfe-8fc0-05cb48074075/scratchpad}
L=${1:-cur}; ROOT=${2:-$(cd "$(dirname "$0")/.." && pwd)}
H=$(cd "$(dirname "$0")" && pwd)
node "$H/collect.js" $SP/reg/all.json $SP/A $SP/B/clean-all.json $SP/B/rough.json $SP/reg/C-holdout.json $SP/reg/extra >/dev/null
if [ ! -f $SP/reg/all.base.run.json ] || [ $SP/reg/all.json -nt $SP/reg/all.base.run.json ]; then STEEL_SRC=$SP/base-src node "$H/batch.js" $SP/reg/all.json --out $SP/reg/all.base.run.json --procs 3 >/dev/null; fi
node "$ROOT/harness/batch.js" $SP/reg/all.json --out $SP/reg/all.$L.run.json --procs 3 >/dev/null
node "$H/diff.js" $SP/reg/all.base.run.json $SP/reg/all.$L.run.json > $SP/reg/$L.diff.txt
echo "$(python3 -c "import json;print(len(json.load(open('$SP/reg/all.json'))))") questions; $(tail -1 $SP/reg/$L.diff.txt) vs baseline -> $SP/reg/$L.diff.txt"
