UNIT B -- his typing, at scale.  Re-run everything from the repo's tool directory:

    cd /home/user/1/tools/steel-tool-solve
    SP=/tmp/claude-0/-home-user-1/a6672620-4f5b-5cfe-8fc0-05cb48074075/scratchpad
    B=$SP/B

Files of the harness (new, nothing under ext/ touched):
    harness/rough.js          the generator (seeded, deterministic: same input + seed -> byte-identical output)
    harness/rough-compare.js  SAME / FEWER / MORE / DIFFERENT / HIDDEN accounting, per level and per transform, and the case files
    harness/rough-cause.js    leave-one-out cause of every DIFFERENT / FEWER / hidden-DIFFERENT copy, and the clusters

------------------------------------------------------------------------------------------------------------------------------
1. BASELINE (what is reported below).  STEEL_SRC=$SP/base-src is the untouched build.

  # clean corpus (130 calculations + 90 look-ups / word questions), run on the baseline
  node -e 'var f=require("fs"),a=JSON.parse(f.readFileSync(process.argv[1])),b=JSON.parse(f.readFileSync(process.argv[2]));f.writeFileSync(process.argv[3],JSON.stringify(a.concat(b),null,1))' $B/clean-calc.json $B/clean-words.json $B/clean-all.json
  STEEL_SRC=$SP/base-src node harness/batch.js $B/clean-all.json --out $B/base-clean.json --procs 3

  # rough copies of the 141 clean questions that have at least one answer line (3,221 copies; seed B1)
  node harness/rough.js $B/clean-all.json --out $B/rough.json --clean-run $B/base-clean.json
  #   (defaults: --seed B1 --light 3 --medium 3 --heavy 3 --pairs 1, plus one pure copy per transform, two for misspell)

  # run them, account, explain
  STEEL_SRC=$SP/base-src node harness/batch.js $B/rough.json --out $B/base-rough.json --procs 3
  node harness/rough-compare.js --clean-run $B/base-clean.json --rough $B/rough.json --rough-run $B/base-rough.json --out-dir $B
  STEEL_SRC=$SP/base-src node harness/rough-cause.js --clean $B/clean-all.json --clean-run $B/base-clean.json --rough $B/rough.json --cmp-dir $B --out-dir $B/cause --procs 3 > $B/cause/clusters.txt

  Outputs in $B: report.txt (the tables), summary.json, classes.json (every copy), different.json, fewer.json, more.json,
  hidden-different.json (each case: id, clean text, rough text, transforms, clean answer lines, rough answer lines, lost/extra keys,
  and -- after rough-cause.js -- cause, causeHow, reading); cause/causes.json, cause/clusters.json, cause/clusters.txt.

------------------------------------------------------------------------------------------------------------------------------
2. A FIXED TREE (STEEL_SRC unset = the current ext/).  Keep THE SAME rough.json (the copies are frozen: same seed, same base run);
   compare against the fixed tree's own clean run, so a clean answer the fix corrected is not counted against it.

  N=$B/fixed; mkdir -p $N $N/cause
  node harness/batch.js $B/clean-all.json --out $N/clean.json --procs 3
  node harness/batch.js $B/rough.json --out $N/rough-run.json --procs 3
  node harness/rough-compare.js --clean-run $N/clean.json --rough $B/rough.json --rough-run $N/rough-run.json --out-dir $N
  node harness/rough-cause.js --clean $B/clean-all.json --clean-run $N/clean.json --rough $B/rough.json --cmp-dir $N --out-dir $N/cause --procs 3 > $N/cause/clusters.txt

  Targets (HANDOFF section 7 B): DIFFERENT = 0 (also look at "HIDDEN ... DIFFERENT", answers that turn wrong once he confirms a
  spelling); lost answers (FEWER) halved: baseline 356.
  If the fixed tree now STOPS on a clean question, its copies have no clean line to compare with (they count SAME when they stop
  too, MORE when they answer): check the fixed tree's clean run first (node harness/diff.js $B/base-clean.json $N/clean.json).
  (Checked at the end of the unit: with ext/ still equal to the baseline these commands reproduce the baseline numbers exactly.)
  To check one copy by hand: node -e 'var r=require("'$B'/rough.json");console.log(r.filter(function(c){return c.id==="BC-011~lower"})[0].text)'
  then node harness/one.js "<that text>".

------------------------------------------------------------------------------------------------------------------------------
3. THE MODEL (rough.js; from HOW-HE-TYPES / his three tests / his 03:45 and 03:55 messages; NOT from the page's word lists)
   lower (sometimes a capital first) | nostops (decimal points kept) | breaks (lost or added) | misspell (1-2 KEY words per question:
   his own misspellings colum, tention, lenght, modulous, flang, buckeling, streangth, salb, laod, stel, simpley, polts, determane,
   "frree to swya", else a dropped / doubled / swapped / neighbouring-key letter; heavy: also one ordinary word; never a number word
   or a negation) | glue (20ft, 3/4in, 50ksi, 90k, 1.5k/ft, k-ft, ' for ft, " for in) | shape (w12x53, w 12 x 53, W12X53, w12 53,
   w12*53, W12 x53) | phi (phi Pn / phiPn / phi pn; "7/8in phi bolts" for the diameter) | compress (2 per flange, per line, both
   flanges, thru flanges, each side of the web, pinned ends, fixed base, DL / LL before a value, dia, eff length; heavy: "the" dropped)
   | blanks (____ -> "= ?", "=", "___", dropped) | shuffle (sentence order) | typed (the book's answer "(ans 359.2 k)" from the clean
   run, or a Manual value "from the table Ag = 9.71") | fig ("see fig 3-22", "as shown") | label ("Problem 3-22.", "3-22)", "#5",
   "(a)") | spaces (double spaces, "colu mn", " ,", "Fy=50" / "Fy =50", "3 /4") | nospace ("thecolumn", "14ftlong", "50ksi,fu")
   | syntax (unclosed bracket, ",," "..", ";:", "?" in the middle, "(a)" -> "a") | frac (3/4 -> .75 / 0.75 / 3-4, never inside a
   shape name) | numspace ("2 0 ft": a space inside a number, digits kept) | pair (two problems of the same chapter lettered by him:
   "(a) .. (b) ..", "a) .. b) ..", "a) ..\nb) ..", "a. .. b. ..", "a .. b ..").
   Levels: light / medium / heavy draw the transforms with fixed probabilities (PROB in rough.js); "pure" copies apply ONE transform.
   Every copy keeps every number and count: values (fractions evaluated, number words counted) are compared before the copy is kept;
   81 candidate copies were rejected for that, 787 because one transform did not change the text.

Note: collect.js skips file names with run|out|base|new|result|grade|key; rough.json and clean-*.json here WOULD be collected if
someone points collect.js at $SP -- they are not regression questions with keys, keep them out of the corpus.
