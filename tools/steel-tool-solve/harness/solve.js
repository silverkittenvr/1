// solve.js -- one question through the page's steps with nothing pressed (onSolve -> analyze -> readAll -> autoCalc in order), as the page shows it.
// Returns a plain object: per part its kind, form, status, the WRITE THIS lines, the read lines, the asks (gate).  Used by one.js and batch.js.
var load = require('./load');
var G = null;
function ctx() { if (!G) G = load(); return G; }
function solve(text, opts) {
  var g = ctx(), S = g.SOLVE, A, out = { text: text, parts: [] }, i;
  opts = opts || {};
  try { A = S.analyze(text, { defaults: opts.defaults || '' }); } catch (e) { out.crash = 'analyze: ' + (e && e.message ? e.message : e); return out; }
  out.repairs = (A.repairs || []).map(function (r) { return r.from + '->' + r.to; });
  out.unknownWords = A.unknownWords || [];
  out.expanded = (A.expanded || []).length;
  for (i = 0; i < A.parts.length; i++) {
    var p = A.parts[i], d, wb = null, rec;
    try { d = S.dryPart(A.parts, i); } catch (e1) { d = { status: 'crash:' + (e1 && e1.message ? e1.message : e1) }; }
    rec = { label: p.label || '', kind: p.kind, fn: p.stages && p.stages.length ? p.stages.map(function (s) { return s.fn || (s.form && s.form.name); }).join('>') : (p.route && p.route.fn) || null, status: d.status };
    if (p.kind === 'not_in_tool') rec.why = (p.notIn || []).map(function (t) { return t['do']; }).filter(function (x, k, a) { return a.indexOf(x) === k; }).join(' / ');
    if (p.kind === 'error') rec.why = p.errorText || '';
    if (p.askedMismatch) rec.askedMismatch = p.askedMismatch.raw;
    if (p.rerouted) rec.rerouted = p.rerouted.why;
    if (d.run) { try { wb = S.writeBlock(p, d.run, d.vals); } catch (e2) { rec.wbCrash = String(e2 && e2.message ? e2.message : e2); } }
    if (wb) { rec.write = wb.writeLines; rec.read = wb.read; }
    if (d.gate && d.gate.length) rec.gate = d.gate.map(function (x) { return x.kind + ':' + (x.text || x.label || x.path || x.msg || ''); });
    out.parts.push(rec);
  }
  return out;
}
module.exports = { solve: solve, ctx: ctx };
