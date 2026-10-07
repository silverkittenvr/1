// node harness/cases/altnum-check.js harness/cases/altnum.json run.json
// run.json = node harness/batch.js harness/cases/altnum.json --out run.json
// Each case: {id, text, expect: {status: [per part], lines: [every WRITE THIS line that is not a numbered step or a header, in order]}}.
// PASS when both match exactly; otherwise the actual lines are printed.
var fs = require('fs'), a = process.argv.slice(2), C = JSON.parse(fs.readFileSync(a[0], 'utf8')), R = JSON.parse(fs.readFileSync(a[1], 'utf8')), bad = 0;
function linesOf(r) {
  var out = [];
  (r.parts || []).forEach(function (p) { (p.write || []).forEach(function (l) { if (!/^(?:\d+\. |WRITE THIS|Step \d+ of )/.test(l)) out.push(l); }); });
  return out;
}
C.forEach(function (c) {
  var r = R[c.id], st, ln, ok;
  if (!r) { console.log('MISSING ' + c.id); bad++; return; }
  st = (r.parts || []).map(function (p) { return p.status; });
  ln = linesOf(r);
  ok = JSON.stringify(st) === JSON.stringify(c.expect.status) && JSON.stringify(ln) === JSON.stringify(c.expect.lines);
  if (ok) { console.log('PASS ' + c.id); return; }
  bad++;
  console.log('FAIL ' + c.id + '  status ' + JSON.stringify(st) + (JSON.stringify(st) === JSON.stringify(c.expect.status) ? '' : ' (expected ' + JSON.stringify(c.expect.status) + ')'));
  ln.forEach(function (l) { console.log('   got  ' + l); });
  c.expect.lines.forEach(function (l) { if (ln.indexOf(l) < 0) console.log('   want ' + l); });
});
console.log((C.length - bad) + ' of ' + C.length + ' pass');
process.exit(bad ? 1 : 0);
