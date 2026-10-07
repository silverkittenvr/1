// node harness/asks-run.js <cases.json> [--verbose] [--only id,id]
// Unit E: a question whose missing numbers are only in its DRAWING.  For each case [{id, text, expect}] the question goes through the page's steps
// with nothing pressed (as solve.js), and then he ANSWERS what the page asks, one ask at a time, from the drawing (expect.answers), the way the
// page shows it: an ask of asks.js is answered alone; the old box list (a baseline tree) is answered all at once, as it is drawn.
// After every answer the part is run again (gate -> runPart -> wantedBoxes) until it prints an answer, stops, or asks something the case has no answer for.
// expect: { part: label of the part (default: the first form part),
//           answers: { <ask id or box name>: value or choice key },
//           seq: [ask ids in the order they must come] (optional),
//           final: regex an ANSWER / ANSWER TO / FOR YOUR BLANK line must match at the end (optional),
//           noAsk: true  -> the part shows no ask of asks.js at all (a case that must not change),
//           stop: true   -> the flow must end without an answer line }
// Prints one block per case and a last line "asks: N/M as expected".  STEEL_SRC=<dir> runs another tree (the baseline).
var fs = require('fs'), path = require('path');
var a = process.argv.slice(2), file = a[0], verbose = a.indexOf('--verbose') >= 0, only = a.indexOf('--only') >= 0 ? a[a.indexOf('--only') + 1].split(',') : null;
var g = require('./solve').ctx(), S = g.SOLVE;
var cases = JSON.parse(fs.readFileSync(file, 'utf8')), good = 0, n = 0;
function answerLines(wl) { return (wl || []).filter(function (l) { return /^(ANSWER|FOR YOUR BLANK|ANSWER TO|CIRCLE)/.test(l); }); }
function failMsg(run) { var s = run && run.stages[run.failedAt]; return s ? (s.skipped || (s.res && s.res.error ? s.res.error.code + ': ' + s.res.error.message : '?')) : ''; }
function boxAt(st, p) { var i; for (i = 0; i < (st.boxes || []).length; i++) if (st.boxes[i].path === p) return st.boxes[i]; return null; }
function runCase(c) {
  var A = S.analyze(c.text, { defaults: c.defaults || '' }), e = c.expect || {}, log = [], pi, part = null, d, run, vals, wb, w, step, k, seq = [], ans = e.answers || {}, out = { ok: true, why: [] };
  for (pi = 0; pi < A.parts.length; pi++) { if (e.part !== undefined ? A.parts[pi].label === e.part : A.parts[pi].kind === 'form') { part = A.parts[pi]; break; } }
  for (k = 0; k < A.parts.length; k++) { if (A.parts[k] !== part) { try { S.dryPart(A.parts, k); } catch (e0) { /* as the page */ } } }
  if (!part) { out.ok = !!e.noAsk; out.why.push('no such part'); out.log = log; return out; }
  d = S.dryPart(A.parts, pi); vals = d.vals; run = d.run || null;
  log.push('start: ' + d.status + (run && !run.ok ? '  [' + failMsg(run).slice(0, 140) + ']' : ''));
  var final = null, stopped = null;
  for (step = 0; step < 12; step++) {
    if (run && run.ok) {
      /* the page holds the answer back while a number of his text sits in no box (the unused-number questions): he answers those, not the drawing */
      var ug = S.gate(part, vals, { figure: true, unused: false, unusedChoices: {} }).filter(function (x) { return /^unused/.test(x.kind); });
      if (ug.length) { stopped = 'held by the unused-number questions: ' + ug.map(function (x) { return x.text; }).join(' | ').slice(0, 200); break; }
      part.ui.run = run; final = answerLines(S.writeBlock(part, run, vals).writeLines); break;
    }
    if (!vals) break;
    try { wb = S.wantedBoxes(part, vals, run && !run.ok ? run : null); } catch (eW) { log.push('wantedBoxes CRASH ' + eW.message); out.ok = false; break; }
    if (!wb.length) { stopped = 'nothing asked' + (run && !run.ok ? ': ' + failMsg(run).slice(0, 160) : ''); break; }
    w = wb[0];
    if (w.ask) {
      if (w.stop) { stopped = 'STOP: ' + w.q; seq.push(w.id); log.push('stop  ' + w.id + ': ' + w.q); break; }
      seq.push(w.id);
      if (!(w.id in ans) && !(w.name in ans)) { log.push('ASK   ' + w.id + ': ' + w.q + '   <- the case has no answer'); stopped = 'unanswered ask ' + w.id; break; }
      var v = w.id in ans ? ans[w.id] : ans[w.name];
      log.push('ask   ' + w.id + ': ' + w.q + (w.choices ? '  [' + w.choices.map(function (c0) { return c0.key; }).join(' / ') + ']' : '') + '   -> ' + v);
      if (w.choices) {
        var ch = w.choices.filter(function (c0) { return c0.key === String(v); })[0];
        if (!ch) { log.push('  no choice "' + v + '"'); out.ok = false; break; }
        if (ch.stop) { stopped = 'STOP: ' + ch.stop; log.push('  stop: ' + ch.stop); break; }
        S.applyAsk(part, vals, w, v);
      } else S.applyAsk(part, vals, w, v);
    } else {
      /* the old list: every box at once */
      var miss = wb.filter(function (x) { return !(x.name in ans); });
      seq.push('[' + wb.map(function (x) { return x.name; }).join('+') + ']');
      if (miss.length) { log.push('BOXES ' + wb.map(function (x) { return x.name; }).join(', ') + '   <- no answer for ' + miss.map(function (x) { return x.name; }).join(', ')); stopped = 'unanswered box'; break; }
      log.push('boxes ' + wb.map(function (x) { return x.name + '=' + ans[x.name]; }).join(', '));
      wb.forEach(function (x) { vals[x.si][x.path] = String(ans[x.name]); });
    }
    var gate = S.gate(part, vals, { figure: true, unused: true, unusedChoices: {} });
    if (gate.length) { log.push('  gate: ' + gate.map(function (x) { return x.kind + ':' + x.text; }).join(' | ').slice(0, 200)); run = null; continue; }
    run = S.runPart(part, vals);
    if (!run.ok) log.push('  refused: ' + failMsg(run).slice(0, 160));
  }
  if (final) log.push('ANSWER LINES: ' + (final.length ? final.join('  ||  ') : '(none)'));
  if (stopped) log.push('ended: ' + stopped);
  /* the verdict */
  var askSeq = seq.filter(function (x) { return x.charAt(0) !== '['; });
  if (e.noAsk && askSeq.length) { out.ok = false; out.why.push('asked ' + askSeq.join(',') + ' but must not ask'); }
  if (e.seq && e.seq.join(',') !== askSeq.join(',')) { out.ok = false; out.why.push('sequence ' + askSeq.join(',') + ' != ' + e.seq.join(',')); }
  if (e.final) {
    var re = new RegExp(e.final, 'i');
    if (!final || !final.some(function (l) { return re.test(l) && !/^ALSO FOUND|^NOT /.test(l); })) { out.ok = false; out.why.push('no answer line matches /' + e.final + '/'); }
  }
  if (e.stop && final && final.length) { out.ok = false; out.why.push('answered but must stop'); }
  out.log = log; out.seq = seq; out.final = final;
  return out;
}
cases.forEach(function (c) {
  if (only && only.indexOf(c.id) < 0) return;
  var r;
  n++;
  try { r = runCase(c); } catch (e) { r = { ok: false, why: ['CRASH ' + (e && e.stack || e)], log: [] }; }
  if (r.ok) good++;
  console.log((r.ok ? 'ok   ' : 'FAIL ') + c.id + (r.why.length ? '   ' + r.why.join('; ') : ''));
  if (verbose || !r.ok) r.log.forEach(function (l) { console.log('       ' + l); });
});
console.log('asks: ' + good + '/' + n + ' as expected');
