#!/bin/bash
# bash harness/export-patches.sh <outdir> [base-ref]  -- one patch per changed page source, with the PACKAGE's paths (src/ or vendor/),
# the build's "/* ==== name ==== */" header line taken off both sides so the hunks apply to the source files.
set -e
OUT=$1; BASE=${2:-base-16cede60}; mkdir -p "$OUT"
cd "$(dirname "$0")/.."
declare -A MAP=( [pipeline.js]=src/pipeline.js [ui.js]=src/ui.js [expand.js]=src/expand.js [wordsx.js]=src/wordsx.js [reader.js]=vendor/reader.js )
for f in $(git diff --name-only "$BASE" -- ext/ | sed 's#.*/ext/##'); do
  dest=${MAP[$f]:-src/$f}
  tmpa=$(mktemp -d); mkdir -p "$tmpa/a/$(dirname $dest)" "$tmpa/b/$(dirname $dest)"
  if git cat-file -e "$BASE:tools/steel-tool-solve/ext/$f" 2>/dev/null; then git show "$BASE:tools/steel-tool-solve/ext/$f" | sed '1{/^\/\* ==== .* ==== \*\/$/d}' > "$tmpa/a/$dest"; else : > "$tmpa/a/$dest"; fi
  sed '1{/^\/\* ==== .* ==== \*\/$/d}' "ext/$f" > "$tmpa/b/$dest"
  (cd "$tmpa" && diff -u "a/$dest" "b/$dest" > "$OUT/$(echo $dest | tr / _).patch" || true)
  rm -rf "$tmpa"; echo "$dest -> $OUT/$(echo $dest | tr / _).patch"
done
