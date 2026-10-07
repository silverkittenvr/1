// node harness/diff.js base.json new.json [--only id] [--quiet]   -- every question whose printed result changed, with the changed lines
var fs = require('fs'), a = process.argv.slice(2), A = JSON.parse(fs.readFileSync(a[0], 'utf8')), B = JSON.parse(fs.readFileSync(a[1], 'utf8'));
var only = a.indexOf('--only') >= 0 ? a[a.indexOf('--only') + 1] : null, quiet = a.indexOf('--quiet') >= 0;
function lines(r) {
  var L = [];
  if (!r) return ['(absent)'];
  if (r.crash) L.push('CRASH ' + r.crash);
  if (r.unknownWords && r.unknownWords.length) L.push('UNKNOWN ' + r.unknownWords.join(','));
  (r.parts || []).forEach(function (p) {
    var h = '[' + (p.label || '-') + '] ' + p.kind + ' ' + p.fn + ' ' + p.status;
    L.push(h + (p.why ? ' why=' + p.why : '') + (p.askedMismatch ? ' MISMATCH=' + p.askedMismatch : ''));
    (p.write || []).forEach(function (l) { if (/^(ANSWER|FOR YOUR BLANK|ANSWER TO|ALSO FOUND|NOT WHAT|CHECK YOUR BLANK|CIRCLE|NO LETTER|YES|NO\b)/.test(l)) L.push('  ' + l); });
    if (p.gate) L.push('  gate ' + p.gate.join(' | '));
    if (p.wanted && p.wanted.length) L.push('  wanted ' + p.wanted.join(' | '));
  });
  return L;
}
var ids = Object.keys(B).concat(Object.keys(A).filter(function (k) { return !(k in B); })), n = 0;
ids.forEach(function (id) {
  if (only && id !== only) return;
  var la = lines(A[id]), lb = lines(B[id]);
  if (la.join('\n') === lb.join('\n')) return;
  n++;
  if (quiet) return;
  console.log('=== ' + id + ': ' + String((B[id] || A[id]).text).replace(/\s+/g, ' ').slice(0, 160));
  la.forEach(function (l) { if (lb.indexOf(l) < 0) console.log('- ' + l); });
  lb.forEach(function (l) { if (la.indexOf(l) < 0) console.log('+ ' + l); });
});
console.log(n + ' changed of ' + ids.length);
