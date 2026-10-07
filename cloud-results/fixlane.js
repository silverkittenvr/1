export const meta = {
  name: 'fix-lane',
  description: 'Fix root-cause clusters of confirmed wrong answers: one fixer per cluster in its own worktree (rule-7 loop), then an adversarial reviewer',
  phases: [
    { title: 'Fix', detail: 'failing cases from the hits -> smallest fix -> selftest/check -> full regression, every change classified -> commit' },
    { title: 'Review', detail: 'independent reviewer attacks the fix with near-misses and his rough typing; fixes up or rejects' },
  ],
}
const SP = '/tmp/claude-0/-home-user-1/a6672620-4f5b-5cfe-8fc0-05cb48074075/scratchpad'
const CLUSTERS = args.clusters
const SRC = args.source
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, worktree: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' }, description: 'hash + subject' },
    files: { type: 'array', items: { type: 'string' } },
    fixed_ids: { type: 'array', items: { type: 'string' }, description: 'hit ids that now print the right value' },
    stopped_ids: { type: 'array', items: { type: 'string' }, description: 'hit ids that now STOP/ASK instead of a wrong answer' },
    still_wrong_ids: { type: 'array', items: { type: 'string' } },
    regression: { type: 'string', description: 'N changed of M; each changed question classified: newly right / stop->stop / right->stop / WRONG (must be 0)' },
    unsure: { type: 'string' },
  },
  required: ['branch', 'worktree', 'commits', 'files', 'fixed_ids', 'stopped_ids', 'still_wrong_ids', 'regression', 'unsure'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['accept', 'accept-after-fixups', 'reject'] }, problems: { type: 'array', items: { type: 'string' } },
    new_wrong_answers: { type: 'array', items: { type: 'string' } }, fixup_commits: { type: 'array', items: { type: 'string' } } },
  required: ['verdict', 'problems', 'new_wrong_answers', 'fixup_commits'],
}
function fixPrompt(c) {
  return `You are a FIXER on an offline exam-helper page for a steel midterm (exam today 14:00 New York). First read ${SP}/BRIEF.md completely;
its hard rules are absolute (zero wrong beats coverage; engine + data frozen; ES5/ASCII/no lookbehind -- node harness/check.js; no number in a stop
message and no second number on an answer line you add or change; edit regex ONLY with the Edit tool, never sed/heredoc; comments say WHY with the
case; small local hunks in pipeline.js / ui.js, prefer reader.js / expand.js / wordsx.js).
You are in your OWN git worktree (git rev-parse --show-toplevel). It may have been created from main, which lacks the tree: FIRST run
\`git checkout -B fix-${c.key} cloud\` (the local branch cloud carries everything merged so far). Work only there (its tools/steel-tool-solve).
Never push. Other fixers work on other clusters in parallel: stay inside your cluster's code.

YOUR CLUSTER "${c.key}": its title, hit ids, root cause (from triage) and fix plan (from triage; improve it if you find a safer one) are the entry
with key "${c.key}" in ${args.laneFile} (field "clusters"). The hits' full records (text, page_line, right_value, working) are in ${SRC} (field "confirmed").

THE LOOP (HANDOFF rule 7, no shortcuts):
1. Failing cases first: write tools/steel-tool-solve/harness/cases/${c.key}.json = [{id, text, expect}] from every hit of your cluster (expect = the
   right value, or "STOP" where the right outcome is a stop/ask) PLUS at least 6 near-misses that must NOT change (same words used correctly) PLUS
   3 copies in the student's rough typing (BRIEF: weird spaces, run-together words, small misspellings, syntax slips). Run them: node harness/batch.js
   harness/cases/${c.key}.json --out /tmp/${c.key}.before.json --procs 2 and look at each.
2. The fix: the smallest that works. Where the right reading is not certain, STOP (one plain sentence, no number) rather than answer.
3. Fast tests: node harness/selftest.js (945/945) ; node harness/check.js ; your cases again: every hit right or stopped, every near-miss unchanged.
4. Full regression: bash harness/regress.sh ${c.key} $(git rev-parse --show-toplevel)/tools/steel-tool-solve   then READ ${SP}/reg/${c.key}.diff.txt and
   classify EVERY changed question (newly right / stop -> stop / right -> stop (a loss: avoid) / WRONG). For each changed one compute the right value
   by hand (node harness/lookup.js for table values) -- do not trust either side. Any WRONG = not done: fix and repeat.
5. Commit (small commits, one fix each; the failing case and the regression count in the message; end the message with the two lines
   "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" and "Claude-Session: https://claude.ai/code/session_01DgbKi2jkbVz5bxFinqJFrW").
Report honestly: ids fixed, ids now stopped, ids still wrong, the regression classification, what you are unsure about.`
}
function reviewPrompt(c, f) {
  return `You are an independent REVIEWER trying to BREAK a fix to an offline exam-helper page (exam today; the student copies what it prints and
cannot tell a wrong number from a right one). First read ${SP}/BRIEF.md (hard rules). The fix: cluster "${c.key}" (see ${args.laneFile}), branch ${f.branch} in
worktree ${f.worktree}, commits ${JSON.stringify(f.commits)}. Read the diff: git -C ${f.worktree} log -p cloud..HEAD -- tools/steel-tool-solve/ext
(if "cloud" is not an ancestor, diff against base-16cede60 and look only at the fixer's commits).
Attack it: write 20+ NEW questions -- clean exam wording AND his rough typing (BRIEF), near-misses that must NOT trigger the new rule, variants that
should, other members/forms that share the words -- run them in that worktree (cd ${f.worktree}/tools/steel-tool-solve && node harness/one.js "...")
and on the baseline (STEEL_SRC=${SP}/base-src node harness/one.js "..."); check every changed line by hand (her method; node harness/lookup.js).
Check: node harness/check.js; node harness/selftest.js 945/945; no number in a stop message; no second number on a changed answer line; hunks small;
comments say why. Re-run bash harness/regress.sh ${c.key}-review ${f.worktree}/tools/steel-tool-solve and spot-check the diff.
If you find a problem you can fix safely in a few lines, fix it in that worktree, re-run the fast tests and commit ("review fixup: ...", same two
trailer lines). Verdict reject = the branch can print a wrong copyable answer that the baseline did not, and you could not fix it.`
}
const out = await pipeline(
  CLUSTERS,
  (c) => agent(fixPrompt(c), { label: `fix:${c.key}`, phase: 'Fix', schema: FIX_SCHEMA, isolation: 'worktree' }),
  (f, c) => f ? agent(reviewPrompt(c, f), { label: `review:${c.key}`, phase: 'Review', schema: REVIEW_SCHEMA }).then((r) => ({ key: c.key, fix: f, review: r })) : { key: c.key, fix: null, review: null },
)
return out.filter(Boolean)
