# Steel exam "Solve page" -- handoff to a cloud session

Cut on Oct 7 at 02:30 New York time. **The exam is the same day at 14:00.**
Work that is not back, verified and merged by **10:00 New York time (seven and a half hours after this cut)** will not be used.
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

## Scope of the midterm (from the handoff; this is all the scope information there is)
Topics: tension members (gross yielding, net rupture, net area with holes, shear lag factor U, selection of the lightest member,
required area), columns (capacity of a given column, K factors, KL/r, Table 4-1a and Table 4-14, selection of the lightest column,
Euler buckling load), fully braced beams (factored moment from loads, required Zx, capacity phi Mp of a given beam, selection of the
lightest beam from Table 3-2, largest live load a beam can carry), loads (1.2D + 1.6L, floor loads in psf to line loads on beams by
tributary width, self weight, column load takedown, a floor plan with beam / girder / column), look-ups in the AISC Manual (shape
properties such as A, d, bf, tf, tw, Ix, Zx, Sx, rx, ry; Fy and Fu of a grade; hole size; K; U), and word questions on the first five
weeks (her definitions: stress-strain curve, elastic limit, yield, ultimate, modulus of elasticity, ductility, steel making, A992 / A36,
LRFD, load types, failure modes, etc.).  NOT in the exam: block shear, unbraced (lateral-torsional) beams, shear, deflection,
connections (bolt shear / bearing), welds.
Her method (where it differs from the Specification, HERS counts): one load combination 1.2D + 1.6L; hole = bolt + 1/8 in for net
area; U from Table D3.1 cases 1, 7, 8; columns from Table 4-1a when both axes have the same KL, otherwise the larger KL/r rounded UP and
phi Fcr from Table 4-14; recommended design K values (pinned-pinned 1.0, fixed-pinned 0.8, fixed-fixed 0.65, fixed-free 2.1, ...);
fully braced beams only (Table 3-2, lightest; equal weight -> the first row going up); materials from her week-1 slide unless the
question says otherwise (see her-materials.txt: W, C, MC = A992 Fy 50 / Fu 65; the other families as listed there); decimals.
See her-rules.json (her standing rules with her own quotes) and her-sentences.json (her own sentences for word questions).
