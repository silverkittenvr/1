// node harness/collect.js <out.json> <file|dir> ...   -- every question file of shape [{id,text,...}] (or {questions:[...]}) found, merged,
// de-duplicated by text, ids kept (prefixed by nothing).  The regression corpus of this session (no saved corpus came with the build).
var fs = require('fs'), path = require('path'), a = process.argv.slice(2), out = a.shift(), seen = {}, all = [];
function take(f) {
  var j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return; }
  var list = Array.isArray(j) ? j : (j && Array.isArray(j.questions) ? j.questions : null);
  if (!list) return;
  list.forEach(function (q) {
    if (!q || typeof q.text !== 'string' || !q.id) return;
    var t = q.text.replace(/\s+/g, ' ').trim(); if (seen[t]) return; seen[t] = 1;
    all.push({ id: String(q.id), text: q.text, defaults: q.defaults || '' });
    if (typeof q.typed === 'string' && q.typed.trim()) { var t2 = q.typed.replace(/\s+/g, ' ').trim(); if (!seen[t2]) { seen[t2] = 1; all.push({ id: q.id + '~typed', text: q.typed }); } }
  });
}
function walk(p) { if (!fs.existsSync(p)) return; var s = fs.statSync(p); if (s.isDirectory()) fs.readdirSync(p).forEach(function (n) { walk(path.join(p, n)); }); else if (/\.json$/.test(p) && !/run|out|base|new|result|grade|key/i.test(path.basename(p))) take(p); }
a.forEach(walk);
var ids = {}; all.forEach(function (q) { if (ids[q.id]) q.id = q.id + '#' + (++ids[q.id]); else ids[q.id] = 1; });
fs.writeFileSync(out, JSON.stringify(all)); console.log(all.length + ' questions -> ' + out);
