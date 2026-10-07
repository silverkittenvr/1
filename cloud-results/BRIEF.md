# Brief for every worker (read fully; ~3 minutes)

## What this is
An OFFLINE single-file exam helper page for a second-year architecture student's steel midterm (today 14:00 New York).
He does not know the material. He types each question from the paper roughly (lower case, misspellings, glued units) into
the page and copies what the page prints. The page is rule-based: `reader.js` turns words into calculator boxes,
`engine.js` (FROZEN, 945/945 self-test) calculates, `pipeline.js` picks the form, guards against misreadings and writes the
block to copy; `ui.js` draws the page; `expand.js` splits several look-ups in one sentence; `wordsx.js` matches word questions.

What counts, in order:
1. NEVER a wrong copyable answer. A clean, plausible, wrong block is the worst outcome: he cannot tell it from a right one.
2. Answer at once from his rough words.
3. If something is missing: ask ONE plain question at a time, only for what a drawing shows.
4. If the question is outside the page: say so in one sentence, with no number in it.

## Hard rules (no exceptions)
1. Zero wrong beats coverage. A rule that answers ten more questions and makes one wrong answer is rejected. When two readings are
   possible, stop or ask; never choose silently. A count that is not in the words stays MISSING, never 0.
2. The calculator is frozen: never edit `ext/engine.js` or the data files (`shapes.js`, `tables.js`, `materials.js`, `rules.js`,
   `glossary.js`, `glossary-extra.js`, `overrides.js`, `selftest.js`, `finder-data.js`, `finder.js`, `spelling.js`). Treat `finder.js`
   as frozen too (route around it in pipeline's signaturePass).
3. Her class method beats the Specification: one load combination 1.2D + 1.6L; hole = bolt + 1/8 in; U from Table D3.1 cases 1, 7, 8
   as she taught; columns from Table 4-1a when both axes have the same KL, otherwise the larger KL/r rounded UP and phi Fcr from
   Table 4-14; her recommended design K (1.0 / 0.8 / 0.65 / 2.1 ...); fully braced beams only (Table 3-2, lightest; equal weight ->
   the first row going up). Block shear, unbraced beams, shear, deflection, connections = not in the exam. Materials from her slide
   (W, C, MC = A992 50/65; M, S, HP, L = A572 Gr 50 50/65; plates A36 36/58; pipe A53 35/60; HSS A500 C 50/62).
4. Browser limits in every page script: ES5 only (no arrow functions, let/const, template strings, classes; no includes /
   startsWith / endsWith / Object.assign; NO REGEX LOOKBEHIND; no innerHTML). ASCII only. `node harness/check.js` must pass.
5. No number in a stop message, and no second number on an answer line you add or change.
6. Edit regex with the Edit tool, never through a shell heredoc/sed (backslashes get collapsed). A replacement that matches 0 times is a failure.
7. Comments say WHY, with the case that forced the rule (see the existing style). Do not reformat existing code. Keep hunks in
   `pipeline.js` and `ui.js` small and local (the local builder edits those two files in parallel); prefer `reader.js`, `expand.js`,
   `wordsx.js` or a NEW file.
8. Nothing may be sent to any outside service (no web search, no upload, no network). The professor's sentences are in this package.

## The tree (repo /home/user/1, branch `cloud`, never push)
    tools/steel-tool-solve/ext/        the page's sources, extracted from build 16cede60 (load order: ext/_order.json)
         pipeline.js ui.js expand.js wordsx.js reader.js   <- the only files fixes may touch (plus new files)
    tools/steel-tool-solve/harness/    node tools (no dependencies)
      node harness/one.js "<question>" [--defaults "<cover line>"] [--json]   one question exactly as the page answers it with nothing pressed
      node harness/batch.js q.json --out run.json [--procs 3]                 many questions [{id,text,defaults?}] -> {id: result}
      node harness/diff.js base.json new.json [--only id] [--quiet]          every question whose printed result changed
      node harness/selftest.js                                                calculator self-test: must say 945/945
      node harness/check.js                                                   ES5 / ASCII / forbidden-call check of every page script
      node harness/lookup.js W12x53 | --t414 67 50 | --t41a W10x49 14 | --t32 60 | --j33 | --d31    the frozen DATA only (for keys)
    STEEL_SRC=<dir> node harness/...   runs another source tree (missing files fall back to ext/). The untouched baseline is
      $SP/base-src  (SP=/tmp/claude-0/-home-user-1/a6672620-4f5b-5cfe-8fc0-05cb48074075/scratchpad)

The machine has 4 CPUs shared by several workers: use `--procs 3` at most for batch runs.

## How to read the page's output (harness/one.js prints the WRITE THIS block of each part)
- `ANSWER: ...` the line he copies. `FOR YOUR BLANK (x = ____): ...` / `ANSWER FOR YOUR BLANK (...)` / `ANSWER TO "...": ...`
  = the line for a blank he typed. `CIRCLE: b. ...` = a multiple-choice letter.
- `ALSO FOUND ...`, `NOT WHAT YOUR BLANK ASKS ...`, `NOT FOR YOUR BLANK ...`, `CHECK YOUR BLANK ...` = warnings; a value under
  such a warning is not "clean".
- `UNKNOWN WORDS (answers hidden until confirmed)` = the page hides every answer of the question until he confirms the spelling.
- status: answered | figure (answered but asks to check a drawing) | words | needs (a required box is empty: the page asks) |
  asks | refused | notin (out of scope: one sentence) | nomatch | error.
- A CLEAN WRONG ANSWER = an ANSWER / FOR YOUR BLANK / ANSWER TO / CIRCLE line, not hidden, not under a warning, whose value is
  wrong for what the question asks (by her method), or that answers a different quantity than the blank asks.

## HOW HE REALLY TYPES (the student's own words, 03:45: "make sure youre typing in a way i realistically would with weird spaces
## or lack of spaces or small misspellings or syntax errors") -- every generated or probe question in "his" style must use these
- WEIRD SPACES: double/triple spaces, a space inside a word or a number ("colu mn", "W12 x53", "3 /4", "2 0 ft"), a space before
  punctuation ("pinned ,"), spaces around or missing around "=" and "x" ("Fy=50", "Fy =50", "w12x 53", "W 12X53").
- LACK OF SPACES: words run together ("thecolumn", "pinnedends", "isfixed"), number glued to the next word ("14ftlong", "3/4inbolts",
  "2lines"), no space after commas or full stops ("50ksi,fu=65.find the").
- SMALL MISSPELLINGS: a dropped, doubled, swapped or neighbouring-key letter ("colmun", "tensoin", "streng th", "desgin", "flnage",
  "lenght", "bolst", "dimater", "kisp"), in key words AND in ordinary words.
- SYNTAX ERRORS: unclosed or missing brackets ("(a W8x35 with pinned ends"), stray or doubled punctuation (",,", "..", ";:"), a "=" with
  nothing after it, "?" in the middle, a lettered part without its bracket ("a W8x35..." for "(a) W8x35"), "x" typed as "*" or "X",
  fractions as "3/4" or "0.75" or ".75" or "3-4", "ft." "ft" "'" mixed; sentences that run on with no full stop.
- Everything else of the earlier model stands: lower case, glued units, "phi", compressions, table values or the book's answer typed
  along, figure references, two problems lettered by himself. He keeps every NUMBER and COUNT of the paper (a typo never changes a digit).

## HIS OWN SAMPLE (he sent it at 03:55: "what my writing will realistically look like AT BEST"), copied from textbook 3-22 / 3-23:
"(a) a c12x30 is connected through its web with three gage lines of 7/8in phi bolts. the gage lines are 3 in on center and the bolts are
spaced three in on center along the gage line. if the center row of polts is staggered with respect to the outer row,  determine the
effective net cross sectional area of the channel. assume there are four bolts in each line. (b) determane the effective net area of
w18 x 46 shown in fig p3-23 assume holes are for 3/4 in phi bolts (ans. 9.67 in^2)"
Note: two problems lettered by himself, a typo inside a key word ("polts", "determane"), a double space, "phi" for the slashed O, the
book's answer typed along, a figure reference whose numbers (2 holes per flange, 4 bolts per line, bolts in the flanges) are only in the
drawing. At WORST it is rougher than this.

## Speed (measured 04:20): harness/batch.js runs ~80 questions per second (295 in 3.5 s with --procs 2). Full regressions are cheap: run them.

## Regression in one command (from 04:00): bash harness/regress.sh <label> [<tree>/tools/steel-tool-solve]
   collects every question file (A probes, B clean + rough, C holdout, $SP/reg/extra) into $SP/reg/all.json (~4,700 questions), runs the
   baseline once (cached) and your tree, and writes $SP/reg/<label>.diff.txt: read and classify EVERY changed question.
   Branch `cloud` already carries two fixes (holdout C-28 framing weight in reader.js; C-48 multiple choice in pipeline.js amendRoute).
