// node harness/rough-cause.js --clean <clean.json> --clean-run <clean-run.json> --rough <rough.json> --cmp-dir <dir of rough-compare.js> --out-dir <dir> [--procs 3]
// Unit B: WHICH part of his typing broke the reading.  For every DIFFERENT, FEWER and hidden-DIFFERENT copy, the copy is typed again with one
// transform left out at a time (leave-one-out, the same random choices for the others: each transform has its own seeded stream), and a pair
// ("a) ... b) ...") is also run as its two halves alone and as the two CLEAN texts lettered the same way.  A transform is a cause when leaving
// it out brings the copy back (DIFFERENT -> no changed line; FEWER -> no lost line; hiding ignored).  Then the copies are clustered by cause
// (the transform and its detail: the misspelled word, the kind of space or syntax error) and by how the page's reading moved (form -> form).
// Writes causes.json (per copy) and clusters.json; prints the clusters.  Runs the page through harness/batch.js (STEEL_SRC as set).
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process');
var RG = require('./rough'), RC = require('./rough-compare');

var a = process.argv.slice(2), o = { procs: '3' }, i;
for (i = 0; i < a.length; i++) { if (a[i].slice(0, 2) === '--') { o[a[i].slice(2)] = a[i + 1]; i++; } }
['clean', 'clean-run', 'rough', 'cmp-dir', 'out-dir'].forEach(function (k) { if (!o[k]) { console.error('missing --' + k); process.exit(2); } });
var cleanQ = {}; JSON.parse(fs.readFileSync(o.clean, 'utf8')).forEach(function (q) { cleanQ[q.id] = q; });
var cleanRun = JSON.parse(fs.readFileSync(o['clean-run'], 'utf8'));
var rough = {}; JSON.parse(fs.readFileSync(o.rough, 'utf8')).forEach(function (c) { rough[c.id] = c; });
var classes = JSON.parse(fs.readFileSync(path.join(o['cmp-dir'], 'classes.json'), 'utf8'));
fs.mkdirSync(o['out-dir'], { recursive: true });

// the copies to explain: DIFFERENT and FEWER (not hidden), and the hidden copies whose answers, once he confirms the spelling, would be DIFFERENT
function bad(row) { if (row.cls === 'HIDDEN') return row.hiddenAs === 'DIFFERENT' ? 'DIFFERENT' : null; return row.cls === 'DIFFERENT' || row.cls === 'FEWER' ? row.cls : null; }
function label(row) { return row.cls === 'HIDDEN' ? 'HIDDEN-DIFFERENT' : row.cls; }
var targets = classes.filter(function (r) { return bad(r); });
var variants = [], meta = {};
function addVar(id, text, base, base2, defaults) { variants.push({ id: id, text: text, defaults: defaults || '' }); meta[id] = { base: base, base2: base2 }; }
targets.forEach(function (r) {
  var c = rough[r.id], q = cleanQ[c.base];
  if (c.kind === 'pure') return;
  if (c.kind === 'pair') {
    var q2 = cleanQ[c.base2], sA = { level: c.spec.level, enabled: c.spec.enabled, seed: c.spec.seed }, sB = { level: c.spec.level2, enabled: c.spec.enabled2, seed: c.spec.seed + ':B' };
    var tA = RG.applySpec(q, sA, { cleanRun: cleanRun }).text, tB = RG.applySpec(q2, sB, { cleanRun: cleanRun }).text;
    function fmt(x, y) { return c.spec.fmt.replace('%A', function () { return x; }).replace('%B', function () { return y; }); }
    addVar(c.id + '#A', tA, c.base); addVar(c.id + '#B', tB, c.base2);
    addVar(c.id + '#cleanpair', fmt(q.text, q2.text), c.base, c.base2);
    return;
  }
  c.spec.enabled.forEach(function (t) {
    var sp = { level: c.spec.level, enabled: c.spec.enabled.filter(function (x) { return x !== t; }), seed: c.spec.seed }, res = RG.applySpec(q, sp, { cleanRun: cleanRun });
    if (res.text !== c.text) addVar(c.id + '#-' + t, res.text, c.base);
  });
});
function runVariants(list, name) {
  var vfile = path.join(o['out-dir'], name + '.json'), vrun = path.join(o['out-dir'], name + '-run.json');
  fs.writeFileSync(vfile, JSON.stringify(list));
  if (list.length) cp.execFileSync(process.execPath, [path.join(__dirname, 'batch.js'), vfile, '--out', vrun, '--procs', o.procs], { stdio: 'inherit' });
  return list.length ? JSON.parse(fs.readFileSync(vrun, 'utf8')) : {};
}
var vres = runVariants(variants, 'variants');
// second round, for the mixed copies that no single left-out transform brings back: each of their transforms ALONE (a sufficient cause)
var round2 = [];
targets.forEach(function (r) {
  var c = rough[r.id], kind = bad(r);
  if (c.kind !== 'mix') return;
  var any = c.spec.enabled.some(function (t) { var id = c.id + '#-' + t; return meta[id] && fixedFor(kind, clsOf(id)); });
  if (any) return;
  c.spec.enabled.forEach(function (t) {
    var res = RG.applySpec(cleanQ[c.base], { level: c.spec.level, enabled: [t], seed: c.spec.seed }, { cleanRun: cleanRun });
    if (res.text !== cleanQ[c.base].text) { round2.push({ id: c.id + '#only-' + t, text: res.text }); meta[c.id + '#only-' + t] = { base: c.base }; }
  });
});
var v2 = runVariants(round2, 'variants2');
Object.keys(v2).forEach(function (k) { vres[k] = v2[k]; });
function clsOf(id) {
  var m = meta[id], rr = vres[id];
  if (!rr) return 'NORUN';
  var cl = RC.answerLines(cleanRun[m.base]).concat(m.base2 ? RC.answerLines(cleanRun[m.base2]) : []);
  return RC.classify(cl, RC.answerLines(rr)).cls;
}
function fixedFor(kind, cls) { return kind === 'DIFFERENT' ? cls !== 'DIFFERENT' : (cls === 'SAME' || cls === 'MORE'); }

// the detail of a transform in a copy, coarse enough to cluster: misspell -> the word; syntax/spaces/nospace -> the kinds; others -> the name
function detail(t, notes) {
  var mine = notes.filter(function (n) { var b = n.replace(/^[AB]\./, '').split(':')[0]; return b === t || b === t + '-ordinary'; }).map(function (n) { return n.replace(/^[AB]\./, ''); });
  if (t === 'misspell') return mine.map(function (n) { return n.replace(/^misspell(-ordinary)?:/, '').replace(/>.*$/, ''); }).join('+') || t;
  if (t === 'syntax' || t === 'spaces' || t === 'nospace') return mine.map(function (n) { return n.split(':').slice(1).join(':').replace(/inword:[a-z]+/g, 'inword'); }).join(',');
  if (t === 'compress') return mine.map(function (n) { return n.split(':')[1]; }).join(',');
  if (t === 'frac') return mine.map(function (n) { return n.split('>')[1].replace(/^\d*\./, '.').replace(/^\.\d+$/, 'decimal').replace(/^\d-\d$/, 'dash'); }).join(',');
  if (t === 'blanks') return mine.map(function (n) { return n.split(':')[1]; }).join(',');
  if (t === 'shape') return mine.map(function (n) { var s = n.split(':')[1]; return /\*/.test(s) ? 'x as *' : /^\w+\d+ \d/.test(s) ? 'no x' : /\s/.test(s) ? 'spaces' : 'case'; }).join(',');
  if (t === 'typed') return mine.map(function (n) { return /table/.test(n) ? 'table value' : 'book answer'; }).join(',');
  if (t === 'breaks') return mine.map(function (n) { return n.split(':')[1]; }).join(',');
  return t;
}

var out = [], clusters = {};
targets.forEach(function (r) {
  var c = rough[r.id], kind = bad(r), causes = [], how;
  if (c.kind === 'pure') { causes = [c.spec.enabled[0]]; how = 'pure'; }
  else if (c.kind === 'pair') {
    var cA = clsOf(c.id + '#A'), cB = clsOf(c.id + '#B'), cP = clsOf(c.id + '#cleanpair');
    if (!fixedFor(kind, cP)) causes = ['pair'];
    else { if (!fixedFor(kind, cA)) causes.push('A'); if (!fixedFor(kind, cB)) causes.push('B'); if (!causes.length) causes = ['pair+typing']; }
    how = 'pair: clean pair ' + cP + ', A alone ' + cA + ', B alone ' + cB;
  } else {
    c.spec.enabled.forEach(function (t) { var id = c.id + '#-' + t; if (meta[id] && fixedFor(kind, clsOf(id))) causes.push(t); });
    how = 'leave-one-out';
    if (!causes.length) {
      c.spec.enabled.forEach(function (t) { var id = c.id + '#only-' + t; if (meta[id] && vres[id] && !fixedFor(kind, clsOf(id))) causes.push(t); });
      how = causes.length ? 'each alone (several causes)' : 'combined (no single transform)';
    }
    if (!causes.length) causes = ['combined'];
  }
  var keys = causes.map(function (t) {
    if (t === 'pair') return 'pair:' + c.spec.fmtName;
    if (t === 'A' || t === 'B') {
      var sp = t === 'A' ? c.spec.enabled : c.spec.enabled2, pre = t + '.';
      var notes = c.transforms.filter(function (n) { return n.indexOf(pre) === 0; });
      return 'pair-half:' + sp.filter(function (x) { return notes.some(function (n) { return n.slice(2).split(':')[0].replace('-ordinary', '') === x; }); }).join('+');
    }
    if (t === 'combined' || t === 'pair+typing') return t;
    return t + ':' + detail(t, c.transforms);
  });
  var move = r.cleanStatus.replace(/:\w+/g, '') + ' -> ' + r.roughStatus;
  kind = label(r);
  var rec = { id: r.id, kind: kind, hidden: r.cls === 'HIDDEN', causes: keys, how: how, move: move, transforms: c.transforms };
  out.push(rec);
  keys.forEach(function (k) {
    var top = k.replace(/:.*$/, '') === 'misspell' ? k : k.replace(/^(\w+(?:-\w+)?):.*$/, '$1');
    var ck = kind + ' | ' + top;
    var cl = clusters[ck] = clusters[ck] || { name: top, kind: kind, ids: [], details: {}, moves: {}, hidden: 0 };
    cl.ids.push(r.id); if (rec.hidden) cl.hidden++;
    cl.details[k] = (cl.details[k] || 0) + 1; cl.moves[move] = (cl.moves[move] || 0) + 1;
  });
});
fs.writeFileSync(path.join(o['out-dir'], 'causes.json'), JSON.stringify(out, null, 1));
var ORDERK = { DIFFERENT: 0, 'HIDDEN-DIFFERENT': 1, FEWER: 2 };
var list = Object.keys(clusters).map(function (k) { return clusters[k]; }).sort(function (x, y) { return x.kind === y.kind ? y.ids.length - x.ids.length : ORDERK[x.kind] - ORDERK[y.kind]; });
fs.writeFileSync(path.join(o['out-dir'], 'clusters.json'), JSON.stringify(list, null, 1));
list.forEach(function (cl) {
  var det = Object.keys(cl.details).sort(function (x, y) { return cl.details[y] - cl.details[x]; }).slice(0, 6).map(function (k) { return k + ' x' + cl.details[k]; }).join('; ');
  var mv = Object.keys(cl.moves).sort(function (x, y) { return cl.moves[y] - cl.moves[x]; }).slice(0, 3).map(function (k) { return k + ' x' + cl.moves[k]; }).join('; ');
  console.log(cl.kind + '  ' + cl.name + '  n=' + cl.ids.length + (cl.hidden ? ' (' + cl.hidden + ' hidden)' : '') + '\n    details: ' + det + '\n    reading: ' + mv + '\n    e.g. ' + cl.ids.slice(0, 6).join(' '));
});
