// node harness/rough-compare.js --clean-run <clean-run.json> --rough <rough.json> --rough-run <rough-run.json> [--out-dir <dir>] [--quiet]
// Unit B accounting: every rough copy (harness/rough.js) against the clean question(s) it was typed from, by their ANSWER LINES only
// (ANSWER / FOR YOUR BLANK / ANSWER FOR YOUR BLANK / ANSWER TO / CIRCLE -- the lines he copies).  A line is compared by what it says:
// its label (the quantity or the entry it answers), its shapes and its numbers; the echo of his own words inside a blank line is ignored.
//   SAME      the same answer lines
//   FEWER     an answer line of the clean run is missing and none changed (a stop, an ask, a lost part)
//   MORE      extra answer lines, none changed
//   DIFFERENT some answer line has a different number / letter / shape / label than the clean run (and the copy is not hidden)
//   HIDDEN    the copy has unknown words: the page hides its answers until he confirms; "hiddenAs" says what they would be (SAME / DIFFERENT ...)
// Writes into --out-dir: summary.json, classes.json (every copy), different.json, fewer.json, more.json, hidden-different.json.
'use strict';
var fs = require('fs'), path = require('path');

var SHAPE = /\b(WT|MC|HSS|HP|W|C|S|M|L)\s?(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?(?:\/\d+)?)(?:\s*[xX*]\s*(\d+(?:-\d+)?(?:\/\d+)?))?\b|\bPipe\s?\d+\s?(?:STD|XS|XXS|Std)\b/g;
function normShape(m) { return m.toUpperCase().replace(/\s+/g, '').replace(/\*/g, 'X'); }
function sig(kind, text) {
  if (kind === 'circle') return text;
  var shapes = [], t = String(text).replace(SHAPE, function (m) { shapes.push(normShape(m)); return ' SHAPE '; });
  var nums = (t.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || []).map(function (x) { return String(parseFloat(x.replace(/,/g, ''))); });
  var head = kind === 'answer' ? t.split(':')[0] : t.split(/=|>=|<=/)[0];
  var label = head.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  return label + '#' + shapes.join(',') + '#' + nums.join(',');
}
function labelOf(key) { return key.split('#')[0]; }
// the value he copies from a line: the shape it names, else its first number, else (a word answer) the entry's name
function mainOf(kind, text) {
  if (kind === 'circle') return text;
  var body = kind === 'answer' ? String(text).replace(/^[^:]*:\s*/, '') : String(text), m;
  SHAPE.lastIndex = 0;
  if ((m = /^[^0-9]{0,40}?((?:WT|MC|HSS|HP|W|C|S|M|L)\s?\d+(?:\.\d+)?\s*[xX*]\s*\d+(?:\.\d+)?(?:\/\d+)?(?:\s*[xX*]\s*\d+(?:-\d+)?(?:\/\d+)?)?)/.exec(body))) return normShape(m[1]);
  if ((m = /^\s*(\d+(?:,\d{3})*(?:\.\d+)?)/.exec(body)) || (m = /\bphi (?:Pn|Mp|Mn|Fcr) = (\d+(?:,\d{3})*(?:\.\d+)?)/.exec(body)) || (m = /(?:>=|=) ?(\d+(?:,\d{3})*(?:\.\d+)?)/.exec(body))
    || (m = /^[^0-9"]{0,40}?(\d+(?:,\d{3})*(?:\.\d+)?)/.exec(body))) return String(parseFloat(m[1].replace(/,/g, '')));
  return labelOf(sig(kind, text));
}
var WARN_RE = /^(?:NOT WHAT YOUR BLANK ASKS|NOT FOR YOUR BLANK|CHECK YOUR BLANK)/;
// the answer lines of one run result, each {kind, key, text, line, part, status, fn, warned}
function answerLines(r) {
  var out = [];
  if (!r || !r.parts) return out;
  r.parts.forEach(function (p, pi) {
    var W = p.write || [], warned = W.some(function (l) { return WARN_RE.test(l); });
    W.forEach(function (l) {
      var m, kind, text;
      if ((m = /^(?:ANSWER )?FOR YOUR BLANK \((.*?)\): (.*)$/.exec(l))) { kind = 'blank'; text = m[2]; }
      else if ((m = /^ANSWER TO "(.*?)": (.*)$/.exec(l))) { kind = 'blank'; text = m[2]; }
      else if ((m = /^ANSWER(?: \(step \d+\))?: (.*)$/.exec(l))) { kind = 'answer'; text = m[1]; }
      else if ((m = /^CIRCLE: ([A-Za-z0-9]+)[.)]/.exec(l))) { kind = 'circle'; text = m[1].toLowerCase(); }
      else return;
      var sg = sig(kind, text);
      out.push({ kind: kind, key: kind + '|' + sg, qty: kind + '|' + labelOf(sg), main: mainOf(kind, text), line: l, part: pi, label: p.label || '', status: p.status, fn: p.fn, warned: warned });
    });
  });
  return out;
}
function uniqKeys(lines) { var o = {}, k = []; lines.forEach(function (x) { if (!o[x.key]) { o[x.key] = 1; k.push(x.key); } }); return k; }

// one copy against its clean line set -> {cls, lost, extra, changed}
function classify(cleanLines, roughLines) {
  var C = uniqKeys(cleanLines), Rk = uniqKeys(roughLines);
  var lost = C.filter(function (k) { return Rk.indexOf(k) < 0; }), extra = Rk.filter(function (k) { return C.indexOf(k) < 0; });
  var cleanLabels = {}; C.forEach(function (k) { cleanLabels[k.split('|')[0] + '|' + labelOf(k.split('|').slice(1).join('|'))] = 1; });
  // an extra line that answers a quantity the clean run answered, with another value, is a changed line even when nothing was lost
  var changed = extra.filter(function (k) { return cleanLabels[k.split('|')[0] + '|' + labelOf(k.split('|').slice(1).join('|'))]; });
  var cls;
  if (!lost.length && !extra.length) cls = 'SAME';
  else if (lost.length && extra.length) cls = 'DIFFERENT';
  else if (extra.length) cls = changed.length ? 'DIFFERENT' : 'MORE';
  else cls = 'FEWER';
  return { cls: cls, lost: lost, extra: extra, changed: changed };
}

function compareAll(cleanRun, rough, roughRun) {
  var rows = [];
  rough.forEach(function (c) {
    var rr = roughRun[c.id];
    if (!rr) { rows.push({ id: c.id, cls: 'NORUN' }); return; }
    var cl = answerLines(cleanRun[c.base]).concat(c.base2 ? answerLines(cleanRun[c.base2]) : []);
    var rl = answerLines(rr), k = classify(cl, rl), hidden = !!(rr.unknownWords && rr.unknownWords.length);
    var row = { id: c.id, base: c.base, base2: c.base2, level: c.level, kind: c.kind, transforms: c.transforms, cls: hidden ? 'HIDDEN' : k.cls, hiddenAs: hidden ? k.cls : undefined,
      unknownWords: hidden ? rr.unknownWords : undefined, crash: rr.crash || undefined, lost: k.lost, extra: k.extra, changed: k.changed };
    // a changed line under the page's own warning (CHECK YOUR BLANK / NOT WHAT YOUR BLANK ASKS / NOT FOR YOUR BLANK) is not a clean copyable answer
    if (k.cls === 'DIFFERENT') {
      var ex = rl.filter(function (x) { return k.extra.indexOf(x.key) >= 0; });
      row.warnedOnly = ex.every(function (x) { return x.warned; });
      // "detail": every changed line still names the same quantity with the same value he would copy (only the text around it moved);
      // "main": a value he would copy changed, or another quantity is answered in place of the one asked
      row.diffKind = ex.every(function (x) { return cl.some(function (c) { return c.qty === x.qty && c.main === x.main; }); }) ? 'detail' : 'main';
    }
    row.cleanStatus = (cleanRun[c.base].parts || []).map(function (p) { return p.fn + ':' + p.status; }).join(' ');
    row.roughStatus = (rr.parts || []).map(function (p) { return p.fn + ':' + p.status; }).join(' ');
    row._cl = cl; row._rl = rl; row._text = c.text;
    rows.push(row);
  });
  return rows;
}

function tname(t) { return String(t).replace(/^[AB]\./, '').split(':')[0]; }
function tally(rows, keyFn) {
  var T = {};
  rows.forEach(function (r) {
    var ks = keyFn(r); if (!ks) return; if (!Array.isArray(ks)) ks = [ks];
    ks.forEach(function (k) {
      var t = T[k] = T[k] || { n: 0, SAME: 0, FEWER: 0, MORE: 0, DIFFERENT: 0, HIDDEN: 0, hiddenDIFFERENT: 0, hiddenSAME: 0 };
      t.n++; t[r.cls] = (t[r.cls] || 0) + 1;
      if (r.cls === 'HIDDEN') { if (r.hiddenAs === 'DIFFERENT') t.hiddenDIFFERENT++; if (r.hiddenAs === 'SAME') t.hiddenSAME++; }
    });
  });
  return T;
}
function table(T, title) {
  var ks = Object.keys(T).sort(function (a, b) { return T[b].n - T[a].n; }), L = [title];
  L.push(pad('transform', 22) + pad('n', 6) + pad('SAME', 6) + pad('FEWER', 6) + pad('MORE', 6) + pad('DIFF', 6) + pad('HIDDEN', 7) + '(as SAME/DIFF)');
  ks.forEach(function (k) { var t = T[k]; L.push(pad(k, 22) + pad(t.n, 6) + pad(t.SAME, 6) + pad(t.FEWER, 6) + pad(t.MORE, 6) + pad(t.DIFFERENT, 6) + pad(t.HIDDEN, 7) + t.hiddenSAME + '/' + t.hiddenDIFFERENT); });
  return L.join('\n');
}
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s + ' '; }

function caseOf(r, cleanQ) {
  return { id: r.id, base: r.base, base2: r.base2, cls: r.cls, hiddenAs: r.hiddenAs, warnedOnly: r.warnedOnly, diffKind: r.diffKind, unknownWords: r.unknownWords, transforms: r.transforms,
    cleanText: cleanQ[r.base] + (r.base2 ? '\n[b] ' + cleanQ[r.base2] : ''), roughText: r._text,
    cleanLines: r._cl.map(function (x) { return x.line; }), roughLines: r._rl.map(function (x) { return x.line + (x.warned ? '   [under a warning]' : ''); }),
    lost: r.lost, extra: r.extra, cleanStatus: r.cleanStatus, roughStatus: r.roughStatus };
}

module.exports = { answerLines: answerLines, classify: classify, compareAll: compareAll, sig: sig, tally: tally, table: table, tname: tname, caseOf: caseOf };

if (require.main === module) {
  var a = process.argv.slice(2), o = {}, i;
  for (i = 0; i < a.length; i++) { if (a[i].slice(0, 2) === '--') { var k = a[i].slice(2); o[k] = (a[i + 1] && a[i + 1].slice(0, 2) !== '--') ? a[++i] : true; } }
  if (!o['clean-run'] || !o.rough || !o['rough-run']) { console.error('usage: node harness/rough-compare.js --clean-run c.json --rough rough.json --rough-run r.json [--out-dir d]'); process.exit(2); }
  var cleanRun = JSON.parse(fs.readFileSync(o['clean-run'], 'utf8')), rough = JSON.parse(fs.readFileSync(o.rough, 'utf8')), roughRun = JSON.parse(fs.readFileSync(o['rough-run'], 'utf8'));
  var cleanQ = {}; Object.keys(cleanRun).forEach(function (id) { cleanQ[id] = cleanRun[id].text; });
  var rows = compareAll(cleanRun, rough, roughRun), dir = o['out-dir'] || null;
  var all = tally(rows, function () { return 'ALL'; }).ALL;
  var byLevel = tally(rows, function (r) { return r.kind === 'pure' ? 'pure' : r.level; });
  var byPure = tally(rows.filter(function (r) { return r.kind === 'pure'; }), function (r) { return r.transforms.length ? tname(r.transforms[0]) : '?'; });
  var byMixT = tally(rows.filter(function (r) { return r.kind !== 'pure'; }), function (r) { var s = {}; r.transforms.forEach(function (t) { s[tname(t)] = 1; }); return Object.keys(s); });
  var diffClean = rows.filter(function (r) { return r.cls === 'DIFFERENT' && !r.warnedOnly; }).length, crashes = rows.filter(function (r) { return r.crash; }).length;
  var diffMain = rows.filter(function (r) { return r.cls === 'DIFFERENT' && r.diffKind === 'main'; }).length;
  var rep = [];
  rep.push('rough copies: ' + rows.length + '   SAME ' + all.SAME + '   FEWER ' + all.FEWER + '   MORE ' + all.MORE + '   DIFFERENT ' + all.DIFFERENT + ' (' + diffClean + ' not under a warning; ' + diffMain + ' change the value he copies)   HIDDEN ' + all.HIDDEN + ' (would be SAME ' + all.hiddenSAME + ', DIFFERENT ' + all.hiddenDIFFERENT + ')' + (crashes ? '   CRASHES ' + crashes : ''));
  rep.push(''); rep.push(table(byLevel, 'BY LEVEL'));
  rep.push(''); rep.push(table(byPure, 'PURE (one transform only)'));
  rep.push(''); rep.push(table(byMixT, 'MIXED copies (light / medium / heavy / pair) containing the transform'));
  console.log(rep.join('\n'));
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    var strip = rows.map(function (r) { var c = {}; Object.keys(r).forEach(function (k) { if (k.charAt(0) !== '_') c[k] = r[k]; }); return c; });
    fs.writeFileSync(path.join(dir, 'classes.json'), JSON.stringify(strip, null, 1));
    fs.writeFileSync(path.join(dir, 'different.json'), JSON.stringify(rows.filter(function (r) { return r.cls === 'DIFFERENT'; }).map(function (r) { return caseOf(r, cleanQ); }), null, 1));
    fs.writeFileSync(path.join(dir, 'fewer.json'), JSON.stringify(rows.filter(function (r) { return r.cls === 'FEWER'; }).map(function (r) { return caseOf(r, cleanQ); }), null, 1));
    fs.writeFileSync(path.join(dir, 'more.json'), JSON.stringify(rows.filter(function (r) { return r.cls === 'MORE'; }).map(function (r) { return caseOf(r, cleanQ); }), null, 1));
    fs.writeFileSync(path.join(dir, 'hidden-different.json'), JSON.stringify(rows.filter(function (r) { return r.cls === 'HIDDEN' && r.hiddenAs === 'DIFFERENT'; }).map(function (r) { return caseOf(r, cleanQ); }), null, 1));
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ all: all, differentNotWarned: diffClean, differentMain: diffMain, crashes: crashes, byLevel: byLevel, byPure: byPure, byMixedTransform: byMixT }, null, 1));
    fs.writeFileSync(path.join(dir, 'report.txt'), rep.join('\n') + '\n');
  }
}
