// node harness/hits-check.js <hits.json> [...] [--out file]   -- the red-team hits (field "confirmed": id, text, right_value) run on THIS tree:
//   RIGHT    a clean answer line carries the right value (first number of right_value within 0.6%, or the right shape / letter)
//   STOPPED  no clean answer line (stop, ask, refusal, out of scope, hidden behind unknown words, every line under a warning)
//   CHECK    a clean answer line with some other value: STILL WRONG unless a person reads it and says otherwise
var fs = require('fs'), solve = require('./solve').solve, a = process.argv.slice(2), out = null, files = [], i;
for (i = 0; i < a.length; i++) { if (a[i] === '--out') out = a[++i]; else files.push(a[i]); }
var hits = [];
files.forEach(function (f) { var j = JSON.parse(fs.readFileSync(f, 'utf8')); (j.confirmed || j).forEach(function (h) { hits.push(h); }); });
var CLEAN = /^(ANSWER(?: \(step \d+\))?:|ANSWER FOR YOUR BLANK|FOR YOUR BLANK|ANSWER TO "|CIRCLE:)/;
function nums(s) { return (String(s).match(/-?\d+(?:\.\d+)?/g) || []).map(Number); }
function shapes(s) { return (String(s).toUpperCase().replace(/\s+/g, '').match(/(?:W|HP|M|S|C|MC|L|WT|HSS)\d+(?:\.\d+)?X\d+(?:\.\d+)?(?:X\d+(?:\/\d+)?)?/g) || []); }
var res = { RIGHT: [], STOPPED: [], CHECK: [] };
hits.forEach(function (h) {
  var r = solve(h.text), lines = [], hidden = r.unknownWords && r.unknownWords.length;
  (r.parts || []).forEach(function (p) {
    var w = p.write || [], warned = w.some(function (l) { return /^(NOT WHAT YOUR BLANK|NOT FOR YOUR BLANK|CHECK YOUR BLANK)/.test(l); });
    w.forEach(function (l) { if (CLEAN.test(l) && !warned) lines.push(l); });
  });
  var rv = String(h.right_value || ''), rn = nums(rv.replace(/\b(?:W|HP|C|MC|L|WT|HSS|M|S)\s?\d+\s?[xX]\s?\d+(?:\.\d+)?/g, '')), rs = shapes(rv), lt = /^\(?([a-f])\)?[\s.)]/i.exec(rv.trim());
  var ok = lines.some(function (l) {
    if (rs.length) return shapes(l).indexOf(rs[0]) >= 0;
    if (lt) return new RegExp('^CIRCLE: ' + lt[1] + '\\b', 'i').test(l);
    if (!rn.length) return false;
    return nums(l.replace(/\(step \d+\)/, '')).some(function (x) { return Math.abs(x - rn[0]) <= Math.max(0.006 * Math.abs(rn[0]), 0.006); });
  });
  var rec = { id: h.id, text: h.text, right: rv.slice(0, 120), lines: lines, hidden: !!hidden };
  if (hidden || !lines.length) res.STOPPED.push(rec); else if (ok) res.RIGHT.push(rec); else res.CHECK.push(rec);
});
console.log('hits ' + hits.length + ': RIGHT ' + res.RIGHT.length + ', STOPPED ' + res.STOPPED.length + ', CHECK (still wrong unless read) ' + res.CHECK.length);
if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
