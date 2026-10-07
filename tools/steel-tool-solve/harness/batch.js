// node harness/batch.js <questions.json> --out <run.json> [--procs 8] [--only id,id]
// questions.json: [{id, text, defaults?}].  Runs every question through solve.js in N child processes; writes {id: result}.
var fs = require('fs'), path = require('path'), cp = require('child_process');
var a = process.argv.slice(2), inp = a[0], out = null, procs = 8, only = null, i;
for (i = 1; i < a.length; i++) { if (a[i] === '--out') out = a[++i]; else if (a[i] === '--procs') procs = +a[++i]; else if (a[i] === '--only') only = a[++i].split(','); }
if (process.env.BATCH_CHILD) {
  var solve = require('./solve').solve, qs = JSON.parse(fs.readFileSync(inp, 'utf8')), res = {};
  qs.forEach(function (q) { try { res[q.id] = solve(q.text, { defaults: q.defaults || '' }); } catch (e) { res[q.id] = { text: q.text, crash: String(e && e.stack || e) }; } });
  fs.writeFileSync(out, JSON.stringify(res)); process.exit(0);
}
var qs = JSON.parse(fs.readFileSync(inp, 'utf8'));
if (only) qs = qs.filter(function (q) { return only.indexOf(q.id) >= 0; });
var chunks = [], k; for (k = 0; k < procs; k++) chunks.push([]);
qs.forEach(function (q, j) { chunks[j % procs].push(q); });
var tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'batch-')), left = 0, all = {};
chunks.forEach(function (c, j) {
  if (!c.length) return; left++;
  var fi = path.join(tmp, 'in' + j + '.json'), fo = path.join(tmp, 'out' + j + '.json');
  fs.writeFileSync(fi, JSON.stringify(c));
  var ch = cp.spawn(process.execPath, [__filename, fi, '--out', fo], { env: Object.assign({}, process.env, { BATCH_CHILD: '1' }), stdio: ['ignore', 'ignore', 'inherit'] });
  ch.on('exit', function () {
    try { var r = JSON.parse(fs.readFileSync(fo, 'utf8')); Object.keys(r).forEach(function (id) { all[id] = r[id]; }); } catch (e) { console.error('chunk ' + j + ' failed'); }
    if (--left === 0) {
      var ordered = {}; qs.forEach(function (q) { if (all[q.id]) ordered[q.id] = all[q.id]; });
      fs.writeFileSync(out, JSON.stringify(ordered, null, 0));
      console.log('ran ' + Object.keys(ordered).length + ' of ' + qs.length + ' -> ' + out);
    }
  });
});
