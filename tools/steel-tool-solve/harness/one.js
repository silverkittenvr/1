// node harness/one.js "<question>" [--defaults "<cover line>"] [--json]
var solve = require('./solve').solve, a = process.argv.slice(2), text = a[0], d = '', j = false, i;
for (i = 1; i < a.length; i++) { if (a[i] === '--defaults') d = a[++i]; else if (a[i] === '--json') j = true; }
var r = solve(text, { defaults: d });
if (j) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
if (r.crash) console.log('CRASH ' + r.crash);
if (r.repairs && r.repairs.length) console.log('repairs: ' + r.repairs.join(', '));
if (r.unknownWords && r.unknownWords.length) console.log('UNKNOWN WORDS (answers hidden until confirmed): ' + r.unknownWords.join(', '));
r.parts.forEach(function (p) {
  console.log('--- part ' + (p.label || '-') + ' kind=' + p.kind + ' fn=' + p.fn + ' status=' + p.status + (p.why ? ' why=' + p.why : ''));
  if (p.gate) console.log('  gate: ' + p.gate.join(' | '));
  if (p.write) console.log(p.write.map(function (l) { return '  ' + l; }).join('\n'));
  if (p.read && p.read.length) console.log('  read: ' + p.read.join(' | '));
});
