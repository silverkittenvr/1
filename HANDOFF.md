# Steel exam "Solve page" -- handoff to a cloud session

Cut on Oct 7 at 02:30 New York time. **The exam is the same day at 14:00.**
Work that is not back, verified and merged by **10:00 New York time (seven and a half hours after this cut)** will not be used.
Read this file to the end before touching anything; then `student-tests/HOW-HE-TYPES.md`.

## 1. What this is

An offline, single-file HTML page (`tools/steel-tool-solve/steel-solve.html`, built by `node build.js`) for a
second-year architecture student's midterm in a steel structures course (tension members, columns, fully braced beams,
loads, a floor plan, look-ups in the AISC Manual, and word questions on the first five weeks). The exam is open book,
taken on a school laptop with **no internet and no AI model**. The student does not know the material. He types each
question from the paper into the page and copies what the page prints.

The page is rule-based: a rule reader (`vendor/reader.js`) turns the typed words into the boxes of one of 28 calculator
forms; a frozen, tested calculator (`vendor/engine.js`, 945 known-answer cases) does the arithmetic; `src/pipeline.js`
chooses the form, guards against misreadings and writes the block to copy; `src/ui.js` is the page.

## 2. The requirement, in the student's words

> "there are three things that must be done perfectly for this to work. we need a concrete bound for what types of
> problems and questions could possibly be in a test tmr. we need a tool that can solve any of those problems, and
> detect edge cases, and we need a system that i can put messy human words into and it can translate into smth my tool
> can understand and output for. it must be easy to use and not require anything except me roughly copying the words of
> the test. the system asking me for more info than the words of the problem is a failure unless its picture is important"

> "i will not write with perfect syntax, order, spelling, terminoligy like you and the tests do. i will roughly try to
> copy the words of the problem into the thing."

> "this cant only work on questions weve seen, it must work on any math consept she has ever brought up or that could
> possibly be in this test"   (his last study aid, a large flow chart, matched none of the questions on that exam)

> "I fear a lot of these questions, especially word questions could be writin in an odd order or with abnormal wording and fail"

> "Assuming ZERO knowlage of any math at all... Basicly a 3rd grader should get the same score I would"

Speed does not matter (about ten questions, plenty of time). Being RIGHT does.

**The order of what counts, agreed by three councils of outside labs and by him:**
1. **Never a wrong copyable answer.** A clean, plausible, wrong block is the worst outcome: he cannot tell it from a right one.
2. Answer at once from his rough words.
3. If something is missing: ask ONE plain question at a time, only for what a drawing shows. Any other ask is a failure in his eyes.
4. If the question is outside the page: say so in one sentence, with no number in it.

## 3. Where things stand (measured on the build in this package)

| Measure | Result |
|---|---|
| Calculator self-test | 945 / 945 |
| 107 questions written by four other labs' models in their own wording (clean typing), graded against independent keys: 81 calculation and look-up questions | 46 fully right, 14 partly, 1 answered with nothing keyed on its answer lines, 20 stopped. Keyed blanks: 126 of 176 right, 6 present but not on an answer line, 13 to read by hand (`grade-accept.py --show wrong`), 31 missing. At the start of the night: 26 fully right, 65 of 176 blanks. |
| The 26 word questions among the 107 | The NEW matcher `src/wordsx.js` finds her right sentence for 25 (top or first hits), 0 wrong letters. **It is not wired into the page yet** (the local builder is doing that now). The page as built still prints unrelated definitions as "ANSWER" for many of them. |
| Sentences shuffled into another order (616 copies of saved questions) | 602 same, 8 an answer lost, 0 wrong number |
| Rough typing (misspellings, lower case, lost full stops) | The build delivered to the student BEFORE tonight: 1,104 rough copies -> 598 same, 266 an answer lost, 240 a DIFFERENT answer line. Being re-measured on this build as the package was cut; run it yourself (section 6). |
| Saved regression questions vs the delivered build | every difference read and classified up to tonight's merges (improvements, apart from stop -> another stop) |
| Browser click-through scenarios (`ui-test.js`, needs Chrome) | 27 of 29 on a build of 01:36; the 2 need the optional AI helper. Not re-run since. |
| The student's own three typed tests | see `student-tests/HOW-HE-TYPES.md`: each one found a fault no generated test had found |

`student-tests/STATE-107-outside-questions.txt` lists every one of the 107 that is not fully answered, with the reason per part.

## 4. The hard rules

1. **Zero wrong beats coverage.** A new rule that answers ten more questions and makes one wrong answer is rejected. When
   two readings are possible, stop or ask; never choose silently. A count that is not in the words stays MISSING, never 0.
2. **The calculator is frozen.** Never edit `vendor/engine.js` or the data files (`shapes.js`, `tables.js`, `materials.js`,
   `rules.js`, `glossary.js`, `overrides.js`, `selftest.js`). 945 / 945 must hold after every change.
3. **Her class method beats the Specification** wherever they differ. The calculator already implements her method: one
   load combination 1.2D + 1.6L; hole = bolt + 1/8 in; U from Table D3.1 cases 1, 7, 8 as she taught them; columns from
   Table 4-1a when both axes have the same KL, otherwise the larger KL/r rounded UP and phi Fcr from Table 4-14; her
   recommended design K values (1.0 / 0.8 / 0.65 / 2.1 ...); fully braced beams only (Table 3-2, lightest; equal weight ->
   the first row going up); block shear, unbraced beams, shear, deflection, connections = not in the exam.
   Do not "correct" her: where her slide differs from ordinary engineering (her iron and carbon slide, her wording on fire
   ratings) the page stores HER version.
4. **Browser limits.** Everything bundled into the page is ES5: no arrow functions, no let / const, no template strings, no
   `includes` / `startsWith` / `Object.assign`, **no regex lookbehind** (an old browser throws on the whole file), no
   innerHTML. ASCII only in sources. `build.js` checks part of this and refuses otherwise. No network, no server, no model
   at exam time: the page must work from `file://`.
5. **No number in a stop message, and no second number on an answer line** if you add or change one (councils: a second
   number gets copied).
6. **Edit regex with an editor tool, never through a shell heredoc** (on the builder's machine the shell collapses
   backslashes; four silent failures tonight). A replacement that matches 0 times is a failure, not a detail.
7. **Every change follows the loop:** a failing case first -> the fix -> the fast tests -> the FULL dump comparison against
   your baseline with EVERY changed question read and classified (newly right / stop -> stop / WRONG) -> the 107 graded.
   A change with an unexplained difference is not done.
8. Comments say WHY, with the case that forced the rule (see the existing style). Do not reformat existing code.
9. Nothing in this package may be sent to any outside service. The professor's sentences and her past exam are in it.

## 5. The files

    tools/steel-tool-solve/
      src/pipeline.js     the page's logic (about 3,900 lines): normalizeTyped / recaseTyped / repairSpelling (his typing), parts, the form finder's
                          result, readStage (reader -> boxes), the guards mark*(), gate (what is asked), runPart (calculator + the print contract),
                          signaturePass (what is asked + what is given -> which form), askedBlanks / wordId / askedInWords (which quantity a blank or a
                          sentence asks for), writeBlock (the lines: ANSWER / FOR YOUR BLANK / ANSWER TO / ALSO FOUND / NOT WHAT YOUR BLANK ASKS / CHECK YOUR BLANK)
      src/ui.js           the page: the question box, the answers bar, WRITE THIS, the check table, the asks ("wanted"), stale-answer hiding
      src/expand.js       NEW tonight: several look-ups in one sentence -> lettered parts (text in, text out); wired in SOLVE.analyze
      src/wordsx.js       NEW tonight: order-free matcher for word questions and multiple choice; NOT wired yet
      src/template.html, src/style.css
      vendor/reader.js    the rule reader, reader-0.8 (count grammar for bolts and holes, ends one at a time, loads named by kind)
      vendor/engine.js + data       FROZEN
      vendor/finder.js, finder-data.js   the form finder (rules v3.8): treat as frozen; route around it in signaturePass
      data/final2024.json           her real 2024 final (25 questions, with the cover-page defaults)
      data/spelling.js              word lists of the spelling repair (make-spelling.js)
      test-results/*.txt            case files; test-results/corpus-all.json = every saved question text (464)
      build.js            node build.js --no-vendor   (ALWAYS with --no-vendor here: vendor/ is the source of truth in this package)
    tools/steel-tool-words/glossary-extra.json     109 new stored entries (her sentences from the class captions and slides), verified quotes
    data/exam-kits/ARCH-232-midterm/research/
      PROBLEM-SPACE.md                         everything that could be on the test: her list of 9/30, every problem she gave, rules R-..., the exclusions
      council-2026-10-06-night/s1-bound/       council on the bound: brief, three rounds (r1-, r2-, r3-*.md), predicted-questions.json (107), keys.json
      council-2026-10-06-night/s2-solver/      council on the solver
      council-2026-10-06-night/s3-input/       council on the way in (his typing)
      council-2026-10-06-night/sweep/A..E      five readers' inventories of every concept in the class captions, slides, review, readings
    student-tests/        his own typed tests and what they showed; the state of the 107

Instruments (all in `tools/steel-tool-solve/`, all node or python, no dependencies):

    node one.js "<question>" [--cover] [--boxes] [--args] [--values] [--block]     one question, everything shown
    node accept-run.js <questions.json> --out run.json [--only id,id] [--show all] the 107 (or any set {id,text})
    python grade-accept.py run.json <keys.json> [--show wrong|missing|aside]        graded against keys
    bash dump-par.sh <out.json> <label>                                             every saved question, 10 processes, ~5 min
    python dump-diff.py base.json new.json [--only id] [--max-lines 12]             only the changed lines, per question
    python dump-show.py dump.json <id> [--mode cover] [--answers] [--text]
    bash typo-par.sh <log> <level> <k>        level = light | medium | heavy | lower | nostops | lowernostops | shuffle
    node expand-test.js     (62 of 66: the 4 failures are stale expectations -- the page now answers bare grades; fix the expectations first)
    node wordsx-test.js     (sets A-E, seeded; ~20 s)
    SIGDBG=1 node one.js "..."      why each form was or was not taken by signaturePass
    node ui-test.js --scenario <name> --nomodel ; bash ui-all.sh <log dir>         only where Chrome exists

The path of the council files from `tools/steel-tool-solve/` is `../../data/exam-kits/ARCH-232-midterm/research/council-2026-10-06-night/`.

## 6. First twenty minutes

    cd tools/steel-tool-solve && mkdir -p ../../scratch
    node build.js --no-vendor                      # must end: all checks passed, self-test 945/945
    bash dump-par.sh ../../scratch/base.json base  # YOUR baseline; every later change is compared with it
    R=../../data/exam-kits/ARCH-232-midterm/research/council-2026-10-06-night/s1-bound
    node accept-run.js $R/predicted-questions.json --out ../../scratch/acc.json
    python3 grade-accept.py ../../scratch/acc.json $R/keys.json --show wrong        # expect: ALL 46 / SOME 14 / 1 / STOPPED 20
    bash typo-par.sh ../../scratch/typo-medium.log medium 3
    node wordsx-test.js ; node expand-test.js
    cat ../../student-tests/HOW-HE-TYPES.md

## 7. The work, in order of value

Use many workers. Give each worker ONE unit, its own copy of the tree (or its own branch), the hard rules, and the loop of
rule 7. Workers that write test questions or keys must NOT see the code or the saved questions (that is the whole point
of a holdout); workers that fix must not see the keys of a holdout they have not been graded on.

**A. Red team: make the page print a wrong answer (highest value).**
Independent workers who know steel design type in-scope questions the way a hurried student would and look for a block
that is clean and WRONG: a dropped count, a swapped axis, a wrong member, an asked quantity answered with another, a
negation missed ("not staggered", "no web holes"), two problems in one box, a number of the label read as data. Every
hit is delivered as a minimal text + the right value by hand, and then closed with a guard or a fix. Tonight's examples
of exactly this class: "Design strength for yielding of the gross section" of a bolted W12x53 answered 526.5 for 702;
problem 3-22 (staggered holes in a channel) answered "An = 7.28" as if in a straight line; "Excess capacity = ____"
answered with the capacity. The release statement needs: wrong answers found, wrong answers left = 0.

**B. His typing, at scale.** `student-tests/HOW-HE-TYPES.md` is the model: lower case, key words misspelled, units glued,
"phi" for the slashed O in both meanings, compression ("one each side of the web"), table values and the book's answer
typed along, figure references, two problems lettered by himself. Generate at least 2,000 copies in THAT style of
questions whose right answers are known (the saved corpus answered by the baseline, her homework and review problems in
PROBLEM-SPACE.md, the keyed 107), run them, and work through every result that differs from the clean one: first every
DIFFERENT (a changed number), then the lost answers. `typo-forms.js` is the existing, cruder generator: extend it or
write a new one, but keep the SAME / FEWER / DIFFERENT accounting. Target: DIFFERENT = 0; lost answers halved.

**C. A second, fresh holdout, and the release numbers.** At least 60 new questions (40 calculations and look-ups, 20 word
questions and multiple choice) written by workers who read only PROBLEM-SPACE.md, the councils' final rounds and
section 3 of each brief -- not the code, not the saved questions, not the 107. Independent keys by other workers
(the calculator's look-up tables may be used for table values, never the page). Grade. Report exactly:
"wrong copyable answers: N; answered at once: X of Q; stopped: Y of Q", per question and per blank. After that, fix what
failed (those questions then become regression cases, and the report says so).

**D. The 20 stopped and 14 partly answered of the 107** (`student-tests/STATE-107-outside-questions.txt`). Skip the ones
that depend on another question (DS-08, DS-18, DS-19), block shear (OA-30, XA-30), and staggered holes given by
coordinates (OA-11, OA-29, XA-09, GO-08) unless unit F is done. Known causes: a dead-load-only question is sent to the
floor plan, which insists on a live load (XA-19, DS-21); "maximum service live load" variants (OA-28, XA-29, DS-28);
two problems in one text (XA-18); two cases A / B in one question (XA-23); a takedown with a roof that cannot be chained
(XA-28); the theoretical K has no answer line (GO-11 a); strain = stress / E has no form (OA-27; the councils were split
on adding such recipes -- if you add one, it may fire ONLY when the question asks for stress, strain or elongation by name
and no other form fits).

**E. Questions that depend on a figure.** The promised floor plan, a tension member with its holes, a staggered plate:
on the paper the numbers are in a drawing. He types the words; the page must then ask for exactly what the drawing
shows, ONE plain question at a time, in words a child can follow ("How many bolts do you see in ONE flange of the
cross-section drawing?"), and answer as soon as it has them. Today it shows a tick-box and up to 25 boxes
(`student-tests/HOW-HE-TYPES.md`, test 2 b). The asks are made in `src/ui.js` (drawWanted, the gate) from the boxes
that `src/pipeline.js` marks required; design the question list per form, write it, and test the texts at node level.

**F. Staggered holes in a rolled shape** (channel or W web, flange, angle legs unfolded): a pure function with hand-checked
cases, wired behind the stop that now refuses them (`markStagger`). Textbook problem 3-22 is the first case. Her
homework 3-26 (two angles, two staggered lines) is the second. Only if A-C are staffed.

**G. Word questions.** The local builder is wiring `WORDSX.analyze` into the page (a letter only on unique evidence;
otherwise up to three of her sentences under "HER SENTENCES ABOUT THIS -- the page does not choose"). In the cloud: more
everyday-word mappings, more test sets (use unit C's 20 word questions as a holdout BEFORE reading them), and the
uncovered items of the sweeps turned into stored entries -- only with her wording as quoted in the sweeps, or marked
"SUMMARY (not her words)".

## 8. Known and open (do not rediscover)

- `ANSWER:` lines of the column and beam forms still carry alternative numbers in brackets ("KL/r route 1020.3; exact E3
  1025.6"). The councils ruled: her value alone on the line to copy. Not done (the text comes from the frozen calculator;
  it would be a rewrite in `writeBlock`).
- When the dead load is more than eight times the live load the calculator takes 1.4D (the larger); her class uses
  1.2D + 1.6L only. The councils ruled for hers. Not done.
- The two-axis guard (`markAxes`) stops only when exactly one length was read.
- A conflict between two readings of a bolt count empties the box and asks (reader `count_*` questions).
- "Is it adequate? ____" gets its own YES / NO line; a blank named in words gets a line only for the quantities in
  `wordId`; a qualifier ("excess", "required", "nominal", "allowable", "per bolt") deliberately leaves the blank unknown.
- A sentence with no blank is read for what it asks (`askedInWords`); such asks may add lines and rescue a stopped
  question, but never flag "NOT WHAT YOUR BLANK ASKS" and never move a part that already answers one of them.
- `expand.js` leaves a text alone unless every word of it is understood as one kind of look-up list.
- The strip "BEFORE YOU COPY ... SHAPE I USED ..." above each answer and the hiding of answers when the text in the box
  changes are new tonight and have not been tried by a person.
- Spelling repair: a word is repaired only into a word the kit's own text uses at least three times, by one edit, same
  first letter; "laod", "stel", "simpley" are NOT repaired (ambiguous or too short).

## 9. How to hand work back

The package is a git repository with one commit. Work on a branch; small commits, one fix each, the failing case in the
commit message. At the end write `RETURN.md` at the root: what changed (file by file), the numbers of section 3
re-measured, every dump difference classified, what you are unsure about, and what is NOT done. The local builder merges
the branch into his own tree (he keeps editing `src/pipeline.js` and `src/ui.js` meanwhile: keep your hunks in those two
files small and local, and prefer `vendor/reader.js`, `src/expand.js`, `src/wordsx.js` and new files), re-runs everything
on his machine including the browser scenarios, and decides. He will not use a number he has not re-measured.
If the repository cannot be pushed anywhere, zip the changed files with `RETURN.md` and the test logs.
