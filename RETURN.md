# RETURN -- cloud session, Oct 7 (03:00 - 06:05 New York)

Branch `cloud` (pushed). Draft PR: silverkittenvr/1#1. Everything below can be re-run from `tools/steel-tool-solve/`.

## 0. Read this first

- **The package did not reach the cloud.** Only `HANDOFF.md` and the built page `Solve_page_TEST_3_build_16cede60.html` were uploaded.
  There was no `student-tests/`, no corpus, no 107 + keys, no PROBLEM-SPACE.md and no instruments. So:
  - `tools/steel-tool-solve/ext/` = the page's script blocks split back out of build **16cede60** (`ext/_order.json` = load order).
    `ext/pipeline.js` = your `src/pipeline.js`, `ext/reader.js` = `vendor/reader.js`, and so on.
  - `tools/steel-tool-solve/harness/` = a new node harness that reproduces the page with nothing pressed (onSolve -> analyze -> readAll -> autoCalc).
  - Section 3 of the HANDOFF could not be re-measured as written (no 107, no corpus). The numbers here are on THIS session's own corpora (A, B, C below).
- **Merged on `cloud` and verified** (full regression, every change classified, 0 wrong): 3 fixes (section 2). Self-test 945/945, ES5 check clean.
- **On branches, NOT merged** (section 5): 4 finished-or-nearly fixes and 7 interrupted WIP fixes. The session hit its usage limit at ~05:00.
  Every fixer still running then died, and the WIP was committed as found.
- **The red team found 290 confirmed clean wrong answers on 16cede60** (section 3). That is far more than any earlier measure showed.
  About 247 are still open on `cloud`. **Do not tell the student the page has zero wrong answers.**

## 1. Instruments (new, all in `tools/steel-tool-solve/harness/`, node only; acorn for check.js is loaded from the scratch dir or `npm i acorn`)

    node harness/one.js "<question>" [--defaults "<cover>"] [--json]   one question exactly as the page answers it with nothing pressed
    node harness/batch.js q.json --out run.json [--procs 3]             [{id,text}] -> {id: result}  (~80 questions/s)
    node harness/diff.js base.json new.json                             changed answer lines per question
    node harness/selftest.js                                            945/945 + table cross-check
    node harness/check.js                                               ES5 (acorn ecmaVersion 5: arrows, let/const, templates, LOOKBEHIND) + ASCII + forbidden calls
    node harness/lookup.js W12x53 | --t414 67 50 | --t41a W10x49 14 | --t32 60    frozen DATA only (for keys)
    bash harness/regress.sh <label> [tree]                              whole corpus vs the 16cede60 baseline (cached), diff to $SP/reg/<label>.diff.txt
    node harness/hits-check.js A1.json A2.json                          the red team's 290 hits on a tree: RIGHT / STOPPED / CHECK
    node harness/rough.js / rough-compare.js / rough-cause.js           unit B generator + SAME/FEWER/MORE/DIFFERENT/HIDDEN accounting (cloud-results/B/README.txt)
    bash harness/export-patches.sh <outdir> [base-ref]                  per-file patches with PACKAGE paths (src/..., vendor/...), build header removed
    STEEL_SRC=<dir>  runs another tree (the baseline tree has its own _order.json)

## 2. What changed on `cloud` (merged, verified)

| Commit | File | Fix | Failing case | Regression (6,065 questions) |
|---|---|---|---|---|
| fa8bacf | vendor/reader.js (floorBits, FILL.floor_plan) | A framing weight is never another load's number. "including the framing" switches the self-weight recheck off. | holdout C-28: "dead load 75 psf (including the weight of the framing) and live load 100 psf" printed clean wu 3.7 / Mu 473.6 / W24X55; right 2.5 / 320 / W21X44 | 8 changed: 6 wrong -> right (A2-beam-190..195), 1 ask -> right, 1 stop -> stop |
| 8ebefae | src/pipeline.js (amendRoute rules 1-2) | A multiple choice with word choices stays a word question. A digit glued to a letter (A36) is never a required Zx. | holdout C-48: "(d) a36 steel shape" printed "ANSWER: Lightest W with Zx >= 36: W16X26" | (same run) |
| 0fe95c1 (fix-hercombo b47c769 + 75901f5) | src/pipeline.js (runPart: herCombo, ~200 lines in one block) | HER ONE COMBINATION, never 1.4D (HANDOFF 8). Where her value is safe it is printed (loads_factored, the loadFromArgs forms re-run with Pu = 1.2D+1.6L, loads_max_service L = (phiRn - 1.2D)/1.6). Otherwise (beam load cases, takedown, floor plan) the part stops in one sentence with no number. Words asking for other combinations, ASCE, snow/wind/roof, or pounds and kips mixed: stop. | "service dead load 100 kips, no live load, find Pu": 140 -> 120; D 200 L 10: 280 -> 256; column select D 280 L 20: W12X53 -> W12X50; "phi Pn 1000, D 750, max service L": stop -> 62.5 | 70 changed vs the cloud before it: 17 numbers -> her value (right), 1 stop -> right (6.25), 52 answer -> stop (each old block used 1.4D, or a live load read as 0 such as "L = 2D"). 0 wrong. Diff: cloud-results/reg/merge-hercombo.step.diff.txt |

Patches at package paths: `cloud-results/patches-merged/src_pipeline.js.patch`, `vendor_reader.js.patch` (against 16cede60).
Also new: `harness/cases/hercombo.json` (cases of the 1.4D fix).

**Known effect of the 1.4D rule on the student:** a beam, floor or takedown question whose dead load is more than eight times its live load
(including dead-load-only) now STOPS instead of printing the 1.4D value. That loses an answer but avoids a wrong one. Computing her value in those forms is not done.

## 3. The numbers

### A. Red team (two units, 9 topics, 2507 probes in his style and exam style; every hit re-checked by an independent skeptic)
- Confirmed CLEAN WRONG answers on 16cede60: **A1 127** (tension capacity 36, tension select / max load 35, column capacity 31,
  column select / takedown 25) + **A2 163** (beams 38, loads 15, look-ups 59, words / MC 34, labels / negations 17) = **290**.
  Classes: asked-quantity mismatch 50+, missed negation 41+, wrong member 21+, wrong table/method 16+, dropped count, two problems in one, swapped axis ...
- Grouped by root cause: 14 clusters (A1, `cloud-results/A/A1-clusters.json`) + 20 clusters (A2, `A2-clusters.json`), each with ids, code location and fix plan.
- `hits-check.js` (an automatic match of the hand-worked right value against the clean answer lines; it misreads some lines that carry several numbers):
  baseline RIGHT 30 / STOPPED 1 / CHECK 259; **cloud now RIGHT 27 / STOPPED 16 / CHECK 247**. CHECK = still prints a clean line with another value.
  Read a hit before counting it.
- **Wrong answers found: 290 + 2 (holdout) + 66 (typing). Wrong answers left: not 0.** About 247 red-team hits are still open on `cloud`.
  Some are fixed on the unmerged branches (section 5).

### B. His typing at scale (3,221 copies of 141 answered clean questions; his model from the HANDOFF and his messages: weird spaces, run-together words,
small misspellings, syntax slips, glued units, phi, compressions, typed-along answers, figure refs, self-lettered pairs; plus a space inside a number)

| Tree | SAME | FEWER | MORE | DIFFERENT | HIDDEN (would be DIFFERENT once confirmed) |
|---|---|---|---|---|---|
| 16cede60 | 2056 | 356 | 5 | **66** | 738 (42) |
| cloud now | 2056 | 363 | 5 | **59** | 738 (40) |

Largest DIFFERENT causes (cloud-results/B/unitB-result.json has the analysts' root causes and proposed fixes):
1. **A space inside a number** ("2 0 ft" -> 0 ft: W14x90 printed 1190 for 877; "5 00 kips" -> 5). 21-27 copies. Proposed: join groups that are only zeros, stop otherwise.
2. **"?" typed mid-sentence splits the question** (a missing D or L then calculated as 0). 7 copies.
3. **Two problems lettered by himself ("a. .. b. ..", "a .. b ..") are not split**: numbers leak between them. 12 copies. His own 3-22/3-23 sample splits correctly.
4. "take the hole diameter as the bolt diameter plus 1/8 in" read as the asked quantity (lookup_hole). 4 copies.
5. Real-word typos are never flagged: "blots" (bolts), so the holes are dropped; "week axis" (weak), so the strong-axis Mp is printed.
6. HIDDEN 738: run-together words ("thecolumn", "14ftlong") are unknown words, so every answer is hidden. Safe, but most of his rough copies lose everything.
   A word-splitting repair is the largest available coverage gain.

### C. Fresh blind holdout (60 questions written from the scope only; two independent keys each, settled by a third; graded per blank)
On **16cede60**:

| Set | Questions | All right | Some | Asked | Stopped | Nothing keyed | Wrong copyable (blanks) |
|---|---|---|---|---|---|---|---|
| 40 calc, clean | 40 | 28 | 1 | 8 | 2 | 0 | **3 blanks in 1 question (C-28)** |
| 40 calc, his typing | 40 | 12 | 2 | 17 | 8 | 0 | **1 (C-28 c)** |
| 20 words, clean | 20 | 5 | 0 | 0 | 6 | 8 | 0 clean (C-48 under the generic CHECK YOUR BLANK) |
| 20 words, his typing | 20 | 5 | 0 | 2 | 2 | 10 | **1 (C-48)** |

Per blank (calc clean, 59 blanks): right 39, WRONG 3, asked 10, stopped 6, present-not-on-answer-line 1.
On **cloud**: C-28 clean prints all three right (2.5 / 320 / W21X44); C-28 typed (c) prints W21X44 and (a)(b) stop (girder span asked, as on 16cede60).
C-48: typed prints NO LETTER + her sentences; clean stops. Both are now regression cases (cloud-results/reg/corpus-6065.json).
**Not re-graded end to end on cloud** (the session limit hit first); only C-28 and C-48 were checked by hand.

### Regression corpus
`cloud-results/reg/corpus-6065.json` = A probes + B clean + B rough + C holdout (clean and typed). Baseline = 16cede60.
Diffs: cloud-results/reg/fix-c-holdout.diff.txt (8, classified above) and merge-hercombo.step.diff.txt (70, classified above).

## 4. What I am unsure about
- The merged 1.4D rule: "words that ask for more than her one combination" (HER_ASCE_RE) is broad. "roof", "snow", "wind", "combinations" and "S = 3"
  anywhere in the question stop the combination. On the corpus this hit only questions where the old answer was 1.4D. A takedown with a roof live load
  where 1.2D + 1.6L governs is NOT affected (the guard runs only when 1.4D governed). The reviewer of this fix died at the session limit; the step regression above is the only review.
- My harness reproduces the page without ui.js. The figure tick-box, the unknown-words hiding and the asks are approximated from SOLVE.dryPart / gate.
  ui-test.js was not run (no package); Chromium exists in the cloud but no scenarios were available.
- The hit counts come from red-team workers. Each hit was re-checked by a second worker, not by a person.

## 5. NOT done / on branches (pushed to origin, not merged)

| Branch | State | What it does | Before merging |
|---|---|---|---|
| fix-altnum | done + reviewed (accept after 4 review fixups) | One number on the line to copy: her value alone on ANSWER; alternatives (KL/r route, exact E3, yielding/rupture ...) on a separate "For comparison only (do not copy)" / Check line. Questions that ASK for the moved quantity keep the whole line. | It rewrites ~2,900 corpus ANSWER lines. Merge it LAST and diff only the kept number (the reviewer checked: always the old headline). |
| fix-asks | done, NOT reviewed | Unit E: new `src/asks.js` (load before pipeline.js; **build.js must include it**), wantedBoxes asks asks.js first, drawWanted shows ONE plain question at a time (choice buttons / one number). His W18x46 Fig. P3-23 reaches 9.67. | Review + browser check (ui.js changed). |
| fix-dcauses | fixer interrupted; last hunk committed by me | Unit D: largest live load in words the finder misses; dead-load-only floor question stops in one sentence; theoretical K gets its own line (0.7 vs design 0.8); "fixed - pinned" with spaces; "Case A / Case B" -> lettered parts (expand.js). | Full regression + review. |
| fix-tension-holes | fixer interrupted; committed | "no bolt holes in the web / flanges / short leg" no longer makes the member welded (A1-tcap-01..11: 702 printed, 596.2 right); glued "3/4inbolts", "2holes", "2perflange" spaced; the "mentions bolts" guard covers tension selection. | Full regression + review. High value. |
| fix-self-weight-and-negated, fix-load-reading, fix-column-bracing, fix-prose-asks, fix-required-area-and-form-guards, fix-tension-geometry, fix-grades | WIP, NOT VERIFIED (one "WIP" commit each) | Partial fixes for the clusters of the same names (cloud-results/lanes/*.json has each plan) | Treat as drafts: read, finish the loop of rule 7, or drop. |

Clusters with no work yet (plans in cloud-results/lanes/ and A*-clusters.json): beam supports (fixed/cantilever words, partial loads),
ft-in lengths (20'-6"), k-sway negation ("not braced against sidesway"), MC letter guards ("which is NOT" circled), open word-answer guards,
look-up small (L6x6x1 /2, standard hole, U reading), shape-property pick, Euler gaps, takedown floors, stated conditions, max-load ask, numbered problems,
and every unit B cause above (number with a space, "?" split, self-lettered pairs, real-word typos, run-together words).

Section 7 items: A done (finding); B done (finding, 7 fewer DIFFERENT); C done (finding, 2 fixed); D partly on fix-dcauses; E on fix-asks;
F (staggered holes in rolled shapes) not started; G (word questions) only the C-48 guard and the word-guards plan.

## 6. Where everything is
- `cloud-results/A/` hits (A1.json, A2.json: text, page line, right value, working, verifier's root cause), clusters, hits-check runs.
- `cloud-results/B/` report, summary, every DIFFERENT / FEWER case, causes, unit B analysts' findings; `B/fixed-cloud/` = the re-run on cloud.
- `cloud-results/C/` the 60 holdout questions (clean + typed), both keys, the settled key, the four grades.
- `cloud-results/lanes/` the fix plans per cluster; `BRIEF.md` the brief every worker got; `scope/` the blind writers' scope pack.
- `cloud-results/unitDE-result.json` the D/E fixers' reports (cases before / after).
