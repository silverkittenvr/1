export const meta = {
  name: 'continue-lane',
  description: 'Finish interrupted fixers in their existing worktrees (rule-7 loop + self-attack), commit',
  phases: [{ title: 'Finish', detail: 'continue the uncommitted fix in place: cases, fast tests, full regression classified, adversarial near-misses, commit' }],
}
const SP = '/tmp/claude-0/-home-user-1/a6672620-4f5b-5cfe-8fc0-05cb48074075/scratchpad'
const SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, commits: { type: 'array', items: { type: 'string' } },
    fixed_ids: { type: 'array', items: { type: 'string' } }, stopped_ids: { type: 'array', items: { type: 'string' } }, still_wrong_ids: { type: 'array', items: { type: 'string' } },
    regression: { type: 'string', description: 'N changed of M vs baseline; every change classified; WRONG must be 0' },
    near_miss_attack: { type: 'string', description: 'what you tried to break it with and the result' },
    unsure: { type: 'string' },
  },
  required: ['branch', 'commits', 'fixed_ids', 'stopped_ids', 'still_wrong_ids', 'regression', 'near_miss_attack', 'unsure'],
}
function p(c) {
  return `You FINISH an interrupted fix on an offline exam-helper page for a steel midterm (exam today 14:00; your work must be committed within
50 minutes -- keep it tight). First read ${SP}/BRIEF.md (hard rules are absolute: zero wrong beats coverage; engine + data frozen; ES5/ASCII/no
lookbehind via node harness/check.js; no number in a stop message, no second number on an answer line you add or change; edit regex ONLY with the Edit
tool; comments say WHY with the case; small hunks).
Work ONLY in the existing worktree ${c.wt} (branch ${c.branch}); cd ${c.wt}/tools/steel-tool-solve. A previous fixer was cut off by a session limit:
its UNCOMMITTED changes are there (git status / git diff), and maybe a cases file under harness/cases/. Its cluster (title, hit ids, root cause,
fix plan) is the entry "${c.key}" in ${c.lane}; hit records (text, page_line, right_value) are in ${c.src} (field "confirmed").
1. Read the diff. Keep what is sound, remove what is not (if the diff is a mess, reset and do the smallest safe fix yourself).
2. Cases: make sure harness/cases/${c.key}.json holds every hit of the cluster (expect = right value or "STOP"), 6+ near-misses that must not change,
   3 copies in his rough typing. Run them (node harness/batch.js harness/cases/${c.key}.json --out /tmp/${c.key}.json --procs 2).
3. node harness/selftest.js (945/945) ; node harness/check.js
4. bash harness/regress.sh ${c.key} ${c.wt}/tools/steel-tool-solve ; read ${SP}/reg/${c.key}.diff.txt and classify EVERY changed question (newly right /
   stop->stop / right->stop / WRONG), computing right values by hand (node harness/lookup.js). Any WRONG: fix or narrow the rule until 0.
5. Attack your own fix with 10 near-misses (clean and rough) that must NOT trigger it; fix what breaks.
6. Commit in small commits (failing case + regression count in the message; trailers "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" and
   "Claude-Session: https://claude.ai/code/session_01DgbKi2jkbVz5bxFinqJFrW"). Never push. If you cannot reach WRONG = 0, commit nothing to ext/ and say so.`
}
const out = await pipeline(args.items, (c) => agent(p(c), { label: `finish:${c.key}`, phase: 'Finish', schema: SCHEMA }).then((r) => ({ key: c.key, r })))
return out.filter(Boolean)
