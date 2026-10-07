/* ==== ui.js ==== */
/* ui.js -- the page of steel-solve.  ES5 ONLY.  ASCII only.  Every piece of text is put in with createTextNode / textContent: nothing the student types
   (or the engine prints) is ever parsed as HTML.  The logic is in pipeline.js (SOLVE); this file only draws and wires buttons.

   Needs: STEEL, STEEL_FINDER, READER, LLMREADER (optional), SOLVE.  Starts itself when the page is ready. */
(function (root) {
'use strict';

/* The pages of the kit.  Plain relative links (they work from file://).  Change a file name HERE and nowhere else. */
var KIT = { solve: '1-SOLVE-A-QUESTION.html', calculator: '2-CALCULATOR.html', problems: '3-EVERY-PROBLEM-SHE-GAVE.html' };

var doc = root.document;
var SOLVE = root.SOLVE;
var STEEL = root.STEEL;

/* ------------------------------------------------------------------------------------------------ tiny DOM helpers */
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function add(el, c) {
  var i;
  if (c === null || c === undefined || c === false) return;
  if (Object.prototype.toString.call(c) === '[object Array]') { for (i = 0; i < c.length; i++) add(el, c[i]); }
  else if (typeof c === 'string' || typeof c === 'number') el.appendChild(doc.createTextNode(String(c)));
  else el.appendChild(c);
}
function h(tag, attrs) {
  var el = doc.createElement(tag), k, i, v;
  if (attrs) {
    for (k in attrs) {
      if (!has(attrs, k)) continue;
      v = attrs[k];
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.appendChild(doc.createTextNode(String(v)));
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? k : v);
    }
  }
  for (i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function $(id) { return doc.getElementById(id); }
function trim(s) { return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }
function collapse(s) { return trim(String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ')); }
function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* storage is optional */ } }

function copyText(text, button) {
  function done(okay) { if (button) { var old = button.getAttribute('data-label') || button.textContent; button.setAttribute('data-label', old); button.textContent = okay ? 'Copied' : 'Select the text and press Ctrl+C'; setTimeout(function () { button.textContent = old; }, 1800); } }
  function fallback() {
    var ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0;' }), okay = false;
    ta.value = text; doc.body.appendChild(ta); ta.select();
    try { okay = doc.execCommand('copy'); } catch (e) { okay = false; }
    doc.body.removeChild(ta); done(okay);
  }
  try {
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText && root.isSecureContext !== false) root.navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    else fallback();
  } catch (e) { fallback(); }
}

/* ------------------------------------------------------------------------------------------------ state */
/* checkMode: what the AI helper reads in the background (see aiOn below).  queue: the parts waiting for it.  busy: the part it is reading now.  questions: every question
   solved since the page was opened (they all stay on the page, newest first, so a slow helper can still finish the older ones). */
var APP = { model: { cls: 'checking', name: null, base: null, error: '' }, caller: null, qid: 0, Q: null, history: [], texts: {}, checkMode: null, queue: [], busy: null, warming: false, questions: [] };
/* checkMode = what the AI helper reads:  'stuck' only the parts the page could not answer by itself | 'all' every part | 'off' nothing.
   The SMALL model starts on 'stuck': on the held-out problems, where it disagreed with the page it was right about as often as wrong, and on a laptop it needs
   minutes a part.  It earns its time where the page has no answer to lose.  The big model starts on 'all'.  His own choice is remembered. */
function aiOn() { return APP.checkMode !== 'off'; }
function answeredByPage(part) { return !!(part.ui && part.ui.run && part.ui.run.ok); }
var MAX_HISTORY = 60;

function modelDeps() {
  if ((APP.model.cls === 'big' || APP.model.cls === 'small') && APP.caller) return { callModel: APP.caller, model: APP.model.name, options: { temperature: 0, num_ctx: 8192 } };
  return {};
}
function mmss(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + pad2(sec % 60); }
/* one line he can paste to whoever is helping him: which helper, which model, how fast this computer runs it */
function helperFacts() {
  var m = APP.model, t = APP.caller && APP.caller.last, bits = [];
  bits.push('helper: ' + (m.base || 'none') + ', model: ' + (m.name || 'none') + ' (' + m.cls + ')');
  bits.push('cpu threads: ' + (root.navigator && root.navigator.hardwareConcurrency ? root.navigator.hardwareConcurrency : '?'));
  if (m.warm) bits.push('warm-up: ' + m.warm);
  if (t) bits.push('last answer: ' + t.wall_s + ' s (load ' + t.load_s + ' s; read ' + t.prompt_tokens + ' tokens in ' + t.prompt_s + ' s; wrote ' + t.out_tokens + ' tokens in ' + t.out_s + ' s); answers so far: ' + (APP.caller.count || 0));
  if (m.error) bits.push('note: ' + m.error);
  bits.push('page build ' + (root.SOLVE_BUILD ? root.SOLVE_BUILD.id : '?'));
  return bits.join(' | ');
}

/* ------------------------------------------------------------------------------------------------ top bars: model, self-test */
function drawModelBar() {
  var bar = $('modelbar'), m = APP.model, text, cls, sub, main, cb, tech;
  clear(bar);
  if (!root.LLMREADER || typeof root.LLMREADER.fill !== 'function') { cls = 'mb mb-none'; text = 'NO AI HELPER: its code is not in this page'; sub = 'The page reads your question by itself. It still works; it asks you more questions.'; bar.className = cls; bar.appendChild(h('div', { class: 'mb-main' }, h('b', null, text))); bar.appendChild(h('div', { class: 'mb-sub' }, sub)); return; }
  if (m.cls === 'checking') { cls = 'mb mb-check'; text = 'Looking for the AI helper...'; sub = 'You do not have to wait for it: type your question and press Solve.'; }
  else if (m.cls === 'big' || m.cls === 'small') {
    cls = 'mb ' + (m.cls === 'big' ? 'mb-big' : 'mb-small');
    text = 'AI helper is running (' + m.name + ')' + (m.warm ? ': ' + m.warm : '');
    sub = 'Answers do NOT wait for it. The page reads your question by itself at once; the AI helper reads in the background. '
      + (m.cls === 'small' ? 'It is a small model: it needs minutes for one part on a laptop, and where it disagrees with the page it is right about half the time. So it starts on "only the parts the page could not answer". Use one of its values only if ITS WORDS say what the box label says.' : 'Use one of its values only if ITS WORDS say what the box label says.');
  } else {
    cls = 'mb mb-none'; text = 'AI helper is not running';
    sub = 'The page works without it: it reads your question by itself, and asks you when it is not sure. To start the helper: close this page and double-click START-HERE.bat in the kit folder.';
  }
  bar.className = cls;
  main = h('div', { class: 'mb-main' }, h('b', null, text), ' ', h('button', { type: 'button', class: 'small', onclick: function () { findModel(); } }, 'Check again'));
  bar.appendChild(main);
  if (sub) bar.appendChild(h('div', { class: 'mb-sub' }, sub));
  if (m.cls === 'big' || m.cls === 'small') {
    cb = h('select', { id: 'aion', 'aria-label': 'what the AI helper reads' },
      h('option', { value: 'stuck' }, 'only the parts the page could not answer'),
      h('option', { value: 'all' }, 'every part (slow: it uses the whole processor while it reads)'),
      h('option', { value: 'off' }, 'nothing (switched off)'));
    cb.value = APP.checkMode || 'stuck';
    cb.addEventListener('change', function () {
      APP.checkMode = cb.value; lsSet('steelsolve.aimode', cb.value);
      if (cb.value === 'off' && APP.caller) APP.caller.abort();
      /* a wider setting: the parts it passed over are queued now */
      if (cb.value !== 'off') eachPart(function (p) { var c = p.ui.check; if (c && c.state === 'skipped' && (cb.value === 'all' || !answeredByPage(p))) enqueueCheck(p); });
      redrawAllAi(); pumpQueue();
    });
    bar.appendChild(h('label', { class: 'mb-sw', for: 'aion' }, 'The AI helper reads: ', cb));
  }
  bar.appendChild(h('div', { class: 'mb-sum', id: 'aisum' }));
  tech = h('details', { class: 'mb-tech' }, h('summary', null, 'technical details'));
  tech.appendChild(h('div', { id: 'aifacts' }, helperFacts()));
  tech.appendChild(h('button', { type: 'button', class: 'small', onclick: function (ev) { copyText(helperFacts(), ev.target); } }, 'Copy these facts'));
  bar.appendChild(tech);
  drawCheckSummary();
}
/* the strip at the top: this page is the current one; the other two pages of the kit are plain links */
function drawKitNav() {
  var nav = $('kitnav');
  if (!nav) return;
  clear(nav);
  nav.appendChild(h('span', { class: 'kn kn-here', 'aria-current': 'page' }, 'Solve a question'));
  nav.appendChild(h('a', { class: 'kn', href: KIT.calculator }, 'Calculator (all the forms)'));
  nav.appendChild(h('a', { class: 'kn', href: KIT.problems }, 'Every problem she gave, with answers'));
}

/* B. the link that opens this part's form in the calculator page, in a new tab (his question and boxes stay where they are) */
function calcLinkFor(part) {
  var fn = null, page = null, D = root.STEEL_DATA && root.STEEL_DATA.finder, i, k;
  for (i = 0; i < (part.stages || []).length; i++) { if (part.stages[i].role === 'main' || (!fn && part.stages[i].role === 'words')) fn = part.stages[i].fn; }
  if (!fn) return null;
  if (part.route && part.route.fn === fn && part.route.page) page = part.route.page;
  if (!page && D && D.tabs) for (k in D.tabs) { if (has(D.tabs, k) && D.tabs[k][1] === fn) { page = D.tabs[k][0]; break; } }
  return page ? KIT.calculator + '#go=' + page + ':' + fn : null;
}

/* Look for the helper.  quiet = a re-check after a failed answer: the bar is only redrawn if the helper is gone.  A part that is being read keeps its own caller. */
function findModel(quiet, then) {
  if (!quiet) { APP.model = { cls: 'checking', name: null, base: null, error: '' }; APP.caller = null; drawModelBar(); }
  SOLVE.net.detect(function (r) {
    var same = r.ok && APP.caller && APP.model.base === r.base && APP.model.name === r.model;
    if (r.ok && !same) {
      APP.model = { cls: r.cls, name: r.model, base: r.base, error: '' }; APP.caller = SOLVE.net.makeCaller(r.base);
      if (!APP.checkMode) { var saved = lsGet('steelsolve.aimode'); APP.checkMode = (saved === 'all' || saved === 'stuck' || saved === 'off') ? saved : (r.cls === 'big' ? 'all' : 'stuck'); }
      warmUp();
    }
    else if (!r.ok) { APP.model = { cls: 'none', name: null, base: null, error: r.error || 'no model reachable' }; APP.caller = null; }
    drawModelBar(); redrawAllAi();
    if (then) then(r.ok);
    pumpQueue();
  });
}
/* Put the model in memory before his first question, with the same context size the real calls use (another size would make the helper load it a second time). */
function warmUp() {
  var caller = APP.caller, m = APP.model, t0 = new Date().getTime();
  if (!caller || APP.busy) return;
  APP.warming = true; m.warm = 'getting ready...';
  function done(ok, why) {
    APP.warming = false;
    if (APP.model === m) m.warm = ok ? 'ready, loaded in ' + Math.round((new Date().getTime() - t0) / 1000) + ' s' : 'did not answer the warm-up (' + why + ')';
    drawModelBar(); pumpQueue();
  }
  try {
    caller({ model: m.name, stream: false, think: false, messages: [{ role: 'user', content: 'Reply with the word ok.' }], options: { temperature: 0, num_ctx: 8192, num_predict: 2 } })
      .then(function () { done(true); }, function (err) { var s = String(err && err.message ? err.message : err); done(/returned nothing/.test(s), s); });
  } catch (e) { done(false, String(e && e.message ? e.message : e)); }
}
function selfTest() {
  var box = $('selftest'), D = root.STEEL_DATA || {}, problems = [], info, r, cc, cases = D.selftest || [], build, line;
  clear(box);
  try {
    info = STEEL.info(); r = STEEL.runCases(cases); cc = STEEL.crossCheck(500, 20261007);
    if (!cases.length) problems.push('no self-test cases were loaded');
    if (!info.shapes) problems.push('no shapes were loaded');
    if (STEEL.shapeLabels().length !== info.shapes) problems.push('the shapes index does not match the shape count');
    r.failed.forEach(function (f) { problems.push('case ' + f.id + ': ' + f.messages.join('; ')); });
    cc.failures.forEach(function (m) { problems.push('table check: ' + m); });
  } catch (e) {
    problems.push('self-test crashed: ' + (e && e.message ? e.message : e));
    info = info || { shapes: 0 }; r = r || { total: 0, passed: 0 }; cc = cc || { checked: 0 };
  }
  build = root.SOLVE_BUILD ? (' Built ' + root.SOLVE_BUILD.date + ' (' + root.SOLVE_BUILD.id + ').') : '';
  if (!problems.length) {
    box.className = 'st st-pass';
    box.appendChild(h('div', null, h('b', null, 'CALCULATOR SELF-TEST PASSED'), ' -- ' + r.passed + ' of ' + r.total + ' known-answer cases and ' + cc.checked + ' table cells recomputed: all agree.' + build));
  } else {
    box.className = 'st st-fail';
    box.appendChild(h('div', null, h('b', null, 'SELF-TEST FAILED -- DO NOT TRUST THIS PAGE'), ' (' + problems.length + ' problem' + (problems.length > 1 ? 's' : '') + '). Use the Manual.'));
    line = h('ul'); problems.slice(0, 8).forEach(function (p) { line.appendChild(h('li', null, p)); }); box.appendChild(line);
  }
}

/* ------------------------------------------------------------------------------------------------ the text panel (his words, with highlights) */
function allOccurrences(text, needle) {
  var out = [], at = 0, i;
  if (!needle) return out;
  for (;;) { i = text.indexOf(needle, at); if (i < 0) break; out.push([i, i + needle.length]); at = i + 1; }
  return out;
}
function drawCtx(part) {
  var ui = part.ui, el = ui.ctxEl, text = part.ctx, n = text.length, cls = [], i, j, k, spans, runs = [], cur, start, st;
  clear(el);
  for (i = 0; i < n; i++) cls.push('');
  spans = ui.unusedSpans || [];
  for (k = 0; k < spans.length; k++) for (i = spans[k][0]; i < spans[k][1] && i < n; i++) cls[i] = 'un';
  spans = ui.hl || [];
  for (k = 0; k < spans.length; k++) for (i = spans[k][0]; i < spans[k][1] && i < n; i++) cls[i] = 'hl';
  start = 0; cur = n ? cls[0] : '';
  for (i = 1; i <= n; i++) {
    if (i === n || cls[i] !== cur) { runs.push([start, i, cur]); start = i; cur = i < n ? cls[i] : ''; }
  }
  st = null;
  for (j = 0; j < runs.length; j++) {
    if (runs[j][2]) { var mk = h('mark', { class: runs[j][2] === 'hl' ? 'hl' : 'unused' }, text.slice(runs[j][0], runs[j][1])); el.appendChild(mk); if (runs[j][2] === 'hl' && !st) st = mk; }
    else el.appendChild(doc.createTextNode(text.slice(runs[j][0], runs[j][1])));
  }
  if (st && st.scrollIntoView && ui.scrollOnHl) { try { st.scrollIntoView({ block: 'nearest' }); } catch (e) { /* older browsers */ } }
}
function setHighlight(part, spans, pin) {
  part.ui.hl = spans || [];
  part.ui.scrollOnHl = true;
  drawCtx(part);
  if (pin) part.ui.pinned = spans || [];
}
function unhighlight(part) { part.ui.hl = part.ui.pinned || []; part.ui.scrollOnHl = false; drawCtx(part); }
function spansOfBox(part, b) {
  var list = [], i;
  for (i = 0; i < b.words.length; i++) list.push(b.words[i].text);
  for (i = 0; i < b.alts.length; i++) list.push(b.alts[i].words);
  return SOLVE.spansFor(part.ctx, list, part.stemLen);
}

/* ------------------------------------------------------------------------------------------------ editors for one box */
function statusText(b, part, si) {
  var vals = part.ui.vals[si], picked = vals['_picked:' + b.path];
  if (vals['_from:' + b.path] !== undefined && b.state !== 'carried') return 'Taken from part (' + vals['_from:' + b.path] + ') of this question, because this part does not give it. Change it if your question says otherwise.';
  if (vals['_ai:' + b.path] !== undefined) return 'Found by the AI helper in these words: "' + vals['_ai:' + b.path] + '". Check that they say what this box asks for.';
  if (b.state === 'agree') return 'Model and rule reader agree. Check the words.';
  if (b.state === 'model') return 'The model found this. Check the words.';
  if (b.state === 'rule') return 'The page read this in your words. Check them.';
  if (b.state === 'conflict' && b.assumed) return picked ? 'You settled the weak-axis length.' : 'The rule reader ASSUMED the same length as the strong axis, but your text speaks of bracing the weak axis. Use that length only if it is right; otherwise type the weak-axis length (or the segments).';
  if (b.state === 'conflict') return picked ? 'The two readers disagreed; you chose a value.' : 'The two readers disagree. Pick one (or type your own).';
  if (b.state === 'carried') return b.notes.length ? b.notes[0] : 'carried automatically';
  if (b.state === 'default') return 'Not in your text. The calculator uses its usual value' + (b.defaultValue !== undefined ? ': ' + String(b.defaultValue) + (b.unit ? ' ' + b.unit : '') : '') + '.';
  if (b.reqGroup === 'load' && !b.required) return 'Your question asks whether the member is adequate, so it needs a load (' + (part.stages[si].fn === 'beam_capacity' ? 'the factored moment Mu' : 'D and L, or Pu') + '). Your text does not give one: type it in.';
  if (b.question) return b.question;
  if (b.required) return 'Required. Your text does not say it: type it in.';
  if (b.askNow) return 'Neither reader found this in your text. Look for it (see "Look for" below) and type it in if your question gives it.';
  return 'Empty: not in your text. Leave it empty only if your question does not need it.';
}
function makeEditor(part, si, b, onChange) {
  var vals = part.ui.vals[si], wrap = h('div', { class: 'ed ed-' + b.kind }), i, inp, btns, rowsEl;
  function setVal(v, mark) { vals[b.path] = v; if (mark !== false) vals['_picked:' + b.path] = true; onChange(); }
  if (b.kind === 'choice') {
    btns = [];
    var desc = h('div', { class: 'optdesc' });
    for (i = 0; i < b.options.length; i++) {
      (function (opt) {
        var btn = h('button', { type: 'button', class: 'opt', title: collapse(opt.label) }, opt.value);
        btn.addEventListener('click', function () { setVal(vals[b.path] === opt.value ? '' : opt.value); sync(); });
        btns.push({ el: btn, value: opt.value, label: opt.label });
        wrap.appendChild(btn);
      })(b.options[i]);
    }
    wrap.appendChild(desc);
    var norm = function (v) { return String(v === undefined || v === null ? '' : v).toLowerCase().replace(/[\s_]+/g, '-'); };
    var sync = function () {
      var k, cur = norm(vals[b.path]), found = null, lab;
      for (k = 0; k < btns.length; k++) { var on = cur !== '' && norm(btns[k].value) === cur; btns[k].el.className = 'opt' + (on ? ' on' : ''); if (on) found = btns[k]; }
      clear(desc);
      if (found) desc.appendChild(h('div', { class: 'optsel' }, h('b', null, found.value), found.label && found.label !== found.value ? ' -- ' + collapse(found.label) : ''));
      else {
        if (cur !== '') desc.appendChild(h('div', { class: 'optsel' }, 'Not one of the choices: ' + vals[b.path]));
        for (k = 0; k < btns.length; k++) { lab = collapse(btns[k].label); if (lab && lab !== btns[k].value) desc.appendChild(h('div', { class: 'optline' }, h('b', null, btns[k].value), ' -- ' + (lab.length > 150 ? lab.slice(0, 148) + '..' : lab))); }
      }
    };
    sync();
    wrap.sync = sync;
    return wrap;
  }
  if (b.kind === 'bool') {
    var yes = h('button', { type: 'button', class: 'opt' }, 'yes'), no = h('button', { type: 'button', class: 'opt' }, 'no');
    var sync2 = function () { yes.className = 'opt' + (vals[b.path] === 'yes' ? ' on' : ''); no.className = 'opt' + (vals[b.path] === 'no' ? ' on' : ''); };
    yes.addEventListener('click', function () { setVal(vals[b.path] === 'yes' ? '' : 'yes'); sync2(); });
    no.addEventListener('click', function () { setVal(vals[b.path] === 'no' ? '' : 'no'); sync2(); });
    wrap.appendChild(yes); wrap.appendChild(no); wrap.appendChild(h('span', { class: 'hint' }, ' (click again to clear)'));
    sync2(); wrap.sync = sync2;
    return wrap;
  }
  if (b.kind === 'list') {
    rowsEl = h('div', { class: 'list' });
    var draw = function () {
      var items = vals[b.path] || [], r, c, row;
      clear(rowsEl);
      if (!items.length) rowsEl.appendChild(h('div', { class: 'hint' }, 'No rows. Add one if your question gives them.'));
      for (r = 0; r < items.length; r++) {
        (function (idx) {
          row = h('div', { class: 'lrow' });
          for (c = 0; c < b.items.length; c++) {
            (function (sub) {
              var cell = h('label', { class: 'lcell' }, h('span', { class: 'lab' }, sub.label + (sub.unit ? ' (' + sub.unit + ')' : '') + (sub.required ? ' *' : '')));
              var ctl;
              if (sub.kind === 'choice') {
                ctl = h('select');
                ctl.appendChild(h('option', { value: '' }, '(usual)'));
                var q; for (q = 0; q < sub.options.length; q++) ctl.appendChild(h('option', { value: sub.options[q].value }, sub.options[q].value));
                ctl.value = items[idx][sub.name] || '';
                ctl.addEventListener('change', function () { items[idx][sub.name] = ctl.value; vals['_picked:' + b.path] = true; onChange(); });
              } else {
                ctl = h('input', { type: 'text', value: items[idx][sub.name] === undefined ? '' : items[idx][sub.name], autocomplete: 'off', spellcheck: 'false' });
                ctl.addEventListener('input', function () { items[idx][sub.name] = ctl.value; vals['_picked:' + b.path] = true; onChange(); });
              }
              cell.appendChild(ctl); row.appendChild(cell);
            })(b.items[c]);
          }
          row.appendChild(h('button', { type: 'button', class: 'small', title: 'remove this row', onclick: function () { items.splice(idx, 1); vals['_picked:' + b.path] = true; draw(); onChange(); } }, 'remove'));
          rowsEl.appendChild(row);
        })(r);
      }
    };
    wrap.appendChild(rowsEl);
    wrap.appendChild(h('button', { type: 'button', class: 'small', onclick: function () { if (!vals[b.path]) vals[b.path] = []; vals[b.path].push({}); vals['_picked:' + b.path] = true; draw(); onChange(); } }, 'add a row'));
    draw(); wrap.sync = draw;
    return wrap;
  }
  if (b.name === 'query') inp = h('textarea', { rows: '3', autocomplete: 'off', spellcheck: 'false', 'aria-label': b.label });
  else inp = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': b.label });
  inp.value = vals[b.path] === undefined ? '' : vals[b.path];
  if (b.kind === 'num' || b.kind === 'int') inp.setAttribute('inputmode', 'decimal');
  inp.addEventListener('input', function () { vals[b.path] = inp.value; vals['_picked:' + b.path] = true; onChange(); });
  wrap.appendChild(inp);
  if (b.unit) wrap.appendChild(h('span', { class: 'unit' }, b.unit));
  wrap.sync = function () { inp.value = vals[b.path] === undefined ? '' : vals[b.path]; };
  wrap.input = inp;
  return wrap;
}

function wordsBlock(part, b) {
  var box = h('div', { class: 'words' }), i;
  if (b.state === 'conflict') {
    return box;
  }
  for (i = 0; i < b.words.length; i++) {
    if (!trim(b.words[i].text)) continue;
    box.appendChild(h('div', { class: 'w' }, h('span', { class: 'src src-' + b.words[i].src }, b.words[i].src === 'model' ? 'model' : 'rules'), ' ', h('q', null, collapse(b.words[i].text))));
  }
  for (i = 0; i < b.notes.length; i++) { if (b.state === 'carried') continue; box.appendChild(h('div', { class: 'note' }, b.notes[i])); }
  return box;
}

/* one row of the boxes table */
function boxRow(part, si, b, refreshAll) {
  var ui = part.ui, vals = ui.vals[si], row, status, ed, edWrap, words, label, alt, i, hint;
  /* a required box that is empty, or the load boxes of an "is it adequate?" question when none of them has a value */
  function needNow() {
    var st = part.stages[si], k, bb, any = false;
    if (b.required && SOLVE.isEmptyUi(b, vals[b.path])) return true;
    if (b.reqGroup !== 'load' || !st || !st.boxes) return false;
    for (k = 0; k < st.boxes.length; k++) { bb = st.boxes[k]; if (bb.reqGroup === 'load' && !SOLVE.isEmptyUi(bb, vals[bb.path])) any = true; }
    return !any;
  }
  function refreshRow() {
    status.textContent = statusText(b, part, si) + (b.state !== 'conflict' && vals['_picked:' + b.path] && (b.state === 'agree' || b.state === 'model' || b.state === 'rule') && edited() ? ' (edited by you)' : '');
    /* a conflict he has settled (picked or typed) is drawn like an ordinary proposal, not as an open red one */
    row.className = 'row st-' + (b.state === 'conflict' && vals['_picked:' + b.path] ? 'agree' : b.state) + (needNow() ? ' need' : '') + (ui.engineMissing && ui.engineMissing[b.path] ? ' engine-missing' : '');
    refreshAll();
  }
  function edited() { return SOLVE.showValue(b, vals[b.path]) !== SOLVE.showValue(b, b.proposal); }
  row = h('div', { class: 'row st-' + b.state });
  label = h('div', { class: 'lab' }, h('b', null, b.label), b.required ? h('span', { class: 'req', title: 'required' }, ' *') : null, b.unit && b.kind !== 'bool' ? h('span', { class: 'unitlab' }, ' (' + b.unit + ')') : null, b.hint ? h('div', { class: 'hint' }, b.hint.length > 160 ? b.hint.slice(0, 158) + '..' : b.hint) : null);
  status = h('div', { class: 'status' });
  if (b.state === 'carried') {
    ed = h('div', { class: 'ed carried' }, '(carried automatically)');
    row.appendChild(label); row.appendChild(ed); row.appendChild(h('div', { class: 'words' })); row.appendChild(status);
    status.textContent = statusText(b, part, si);
    return row;
  }
  ed = makeEditor(part, si, b, refreshRow);
  edWrap = h('div', { class: 'edwrap' }, ed);
  if (b.state === 'conflict') {
    var alts = h('div', { class: 'alts' });
    for (i = 0; i < b.alts.length; i++) {
      (function (a) {
        var btn = h('button', { type: 'button', class: 'alt' + (a.invalid ? ' invalid' : '') }, h('span', { class: 'src src-' + a.src }, a.src === 'model' ? 'model says' : 'rules say'), ' ', h('b', null, SOLVE.showValue(b, a.ui)), a.invalid ? h('span', { class: 'badname' }, '   (not a shape in the Manual: the calculator would refuse it)') : null, h('div', { class: 'altwords' }, h('q', null, collapse(a.words)), a.note ? h('span', { class: 'note' }, '  (' + a.note + ')') : null));
        btn.addEventListener('click', function () { vals[b.path] = a.ui; vals['_picked:' + b.path] = true; if (ed.sync) ed.sync(); setHighlight(part, SOLVE.spansFor(part.ctx, [a.words], part.stemLen), true); refreshRow(); });
        btn.addEventListener('mouseenter', function () { setHighlight(part, SOLVE.spansFor(part.ctx, [a.words], part.stemLen), false); });
        btn.addEventListener('mouseleave', function () { unhighlight(part); });
        alts.appendChild(btn);
      })(b.alts[i]);
    }
    edWrap.insertBefore(alts, ed);
  }
  words = wordsBlock(part, b);
  if (b.state === 'empty' || b.state === 'unclear' || b.state === 'rejected' || b.state === 'default') {
    if (b.grab && b.state !== 'default') words.appendChild(h('div', { class: 'grab' }, 'Look for: ' + b.grab));
  }
  if (b.ruleQuestion && b.state !== 'agree' && b.state !== 'model' && b.state !== 'rule') {
    var rq = h('div', { class: 'rq' }, 'The rule reader asks: ' + b.ruleQuestion.text);
    if (b.ruleQuestion.choices) {
      var cs = h('div', { class: 'rqc' }), q, ch;
      for (q = 0; q < b.ruleQuestion.choices.length; q++) {
        ch = b.ruleQuestion.choices[q];
        (function (choice) {
          var opt = null, k;
          if (b.kind === 'choice') { for (k = 0; k < b.options.length; k++) if (String(b.options[k].value).toLowerCase() === String(choice).toLowerCase()) opt = b.options[k].value; }
          else if (b.kind === 'name') opt = choice;
          if (opt !== null) cs.appendChild(h('button', { type: 'button', class: 'small', onclick: function () { vals[b.path] = opt; vals['_picked:' + b.path] = true; if (ed.sync) ed.sync(); refreshRow(); } }, choice));
          else cs.appendChild(h('span', { class: 'hint' }, ' ' + choice + ' '));
        })(ch);
      }
      rq.appendChild(cs);
    }
    words.appendChild(rq);
  }
  if (b.spec && b.spec.type === 'shape' && (b.state === 'empty' || b.state === 'unclear' || b.state === 'rejected') && SOLVE.offersEarlierShape(part.stages[si], b)) {
    /* "(b) select the shape, (c) find ITS design strength": offer the shape another part of this question has chosen */
    var fromEl = h('div', { class: 'fromparts' });
    words.appendChild(fromEl);
    ui.fromEls = ui.fromEls || [];
    ui.fromEls.push({ el: fromEl, setValue: function (v) { vals[b.path] = v; vals['_picked:' + b.path] = true; if (ed.sync) ed.sync(); refreshRow(); } });
  }
  row.appendChild(label); row.appendChild(edWrap); row.appendChild(words); row.appendChild(status);
  /* hover / click the row: show where in his text it came from */
  var showIt = function (pin) { var sp = spansOfBox(part, b); if (sp.length || pin) setHighlight(part, sp, pin); };
  row.addEventListener('mouseenter', function () { showIt(false); });
  row.addEventListener('mouseleave', function () { unhighlight(part); });
  row.addEventListener('click', function () { showIt(true); });
  refreshRow.rowEl = row;
  row.refresh = refreshRow;
  row.needNow = needNow;
  /* the page itself puts a value in this box (an answer to "which box does this number belong in?"): same as if he had typed it */
  row.setUi = function (v) { vals[b.path] = v; vals['_picked:' + b.path] = true; if (ed.sync) ed.sync(); refreshRow(); };
  status.textContent = statusText(b, part, si);
  if (needNow()) row.className += ' need';
  return row;
}

/* ------------------------------------------------------------------------------------------------ a part's card */
function chip(text, cls) { return h('span', { class: 'chip ' + (cls || '') }, text); }
function formPicker(part, onPick) {
  var wrap = h('div', { class: 'formpick' }), list = STEEL.list(), bySec = {}, order = [], i, sec;
  for (i = 0; i < list.length; i++) { sec = list[i].section || 'Other'; if (!bySec[sec]) { bySec[sec] = []; order.push(sec); } bySec[sec].push(list[i]); }
  order.forEach(function (s) {
    var row = h('div', { class: 'fprow' }, h('span', { class: 'fpsec' }, s + ': '));
    bySec[s].forEach(function (f) { row.appendChild(h('button', { type: 'button', class: 'small', title: f.description || f.label, onclick: function () { onPick(f.name); } }, f.label)); });
    wrap.appendChild(row);
  });
  return wrap;
}

/* the boxes that hold a drawn kind of quantity (a length, a width, an area) with a value that came from his text */
function figureQuantities(part) {
  var out = [], si, st, i, b, vals, v;
  for (si = 0; si < part.stages.length; si++) {
    st = part.stages[si];
    if (!st.boxes || !part.ui.vals) continue;
    vals = part.ui.vals[si] || {};
    for (i = 0; i < st.boxes.length; i++) {
      b = st.boxes[i];
      if (b.state === 'carried' || b.kind !== 'num' || !b.unit || !/^(in|ft|in\^2|sq ft)$/i.test(b.unit)) continue;
      if (b.state !== 'agree' && b.state !== 'model' && b.state !== 'rule' && b.state !== 'conflict') continue;
      v = vals[b.path];
      if (v === undefined || trim(v) === '') continue;
      out.push({ si: si, box: b, value: trim(v) });
    }
  }
  return out;
}
function redrawHoleHelp(part) { if (part.ui.figureEl) drawFigure(part); else renderResult(part); }
/* Holes that are only DRAWN (her Quiz 1 Q7: a plate with staggered holes, every dimension in the figure).  He reads a few numbers off the figure in the order
   they are drawn; the page turns them into the calculator's hole rows.  Returns an element, or null when this part has no hole boxes. */
/* the stage of a part that has the hole boxes of a plate or an angle: { si, boxes: {path: box} } or null */
function holeStage(p) {
  var si, i, m;
  if (!p || !p.stages || !p.ui || !p.ui.vals) return null;
  for (si = 0; si < p.stages.length; si++) {
    if (!p.stages[si].boxes || !p.ui.vals[si]) continue;
    m = {};
    for (i = 0; i < p.stages[si].boxes.length; i++) m[p.stages[si].boxes[i].path] = p.stages[si].boxes[i];
    if (m.holes && m.holes_across && String(p.ui.vals[si].member || '') !== 'shape') return { si: si, boxes: m };
  }
  return null;
}
function holeHelper(part) {
  var ui = part.ui, hsx = holeStage(part), sidx, has1, vals, hs, wrap, nIn, dIn, sIn, sel, msg, isPlate;
  if (!hsx) return null;                                                   /* no hole boxes here, or a rolled shape (its holes are counted per flange and in the web) */
  sidx = hsx.si; has1 = hsx.boxes; vals = ui.vals[sidx];
  isPlate = !!has1.width_in && String(vals.member || 'plate') !== 'angle';
  hs = ui.holeHelp = ui.holeHelp || { n: '', dist: '', s: '', which: 'even' };
  function num(x) { var v = STEEL.parseNum ? STEEL.parseNum(String(x)) : parseFloat(x); return typeof v === 'number' && isFinite(v) ? v : NaN; }
  function fmt(x) { return String(Math.round(x * 10000) / 10000); }
  function redo(p, text) { p.ui.holeMsg = text; p.ui.noAuto = true; try { renderBody(p); } finally { p.ui.noAuto = false; } p.ui.sig = null; autoCalc(p, true); if (!p.ui.run) renderResult(p); }
  /* the same member in the other parts of this question: they take the same holes (he should not have to describe the figure three times) */
  function done(text) {
    var Q = part.Q, i, p, o, v2;
    redo(part, text);
    if (!Q) return;
    for (i = 0; i < Q.A.parts.length; i++) {
      p = Q.A.parts[i]; o = p === part ? null : holeStage(p);
      if (!o) continue;
      v2 = p.ui.vals[o.si];
      v2.holes = JSON.parse(JSON.stringify(vals.holes || [])); v2.holes_across = vals.holes_across; v2['_picked:holes'] = true; v2['_picked:holes_across'] = true;
      if (o.boxes.width_in && has1.width_in && trim(vals.width_in) !== '') { v2.width_in = vals.width_in; v2['_picked:width_in'] = true; }
      p.ui.holeHelp = { n: hs.n, dist: hs.dist, s: hs.s, which: hs.which };
      redo(p, 'The holes you described in part (' + (part.label || '?') + ') are used here too. ' + text);
    }
  }
  wrap = h('div', { class: 'holehelp' }, h('div', { class: 'hh-head' }, 'The holes are only in the figure? Tell the page where they are.'));
  if (ui.holeMsg) wrap.appendChild(h('div', { class: 'hh-done' }, ui.holeMsg));
  /* A. one straight line of holes */
  nIn = h('input', { type: 'text', class: 'hh-n', autocomplete: 'off', 'aria-label': 'number of holes in one line across' }); nIn.value = hs.n;
  nIn.addEventListener('input', function () { hs.n = nIn.value; });
  wrap.appendChild(h('div', { class: 'hh-row' }, h('b', null, 'A. '), 'The holes are in ONE straight line across the member (not zig-zag). How many holes are in that line?  ', nIn, ' ',
    h('button', { type: 'button', class: 'small sg', onclick: function () {
      var n = parseInt(hs.n, 10);
      if (!(n >= 0)) { ui.holeMsg = 'Type the number of holes first (for example 2).'; redrawHoleHelp(part); return; }
      vals.holes_across = String(n); vals['_picked:holes_across'] = true; vals.holes = [];
      done('Done: ' + n + ' hole' + (n === 1 ? '' : 's') + ' in one line across. The answer below uses it.');
    } }, 'Use this')));
  /* B. zig-zag holes in a plate */
  if (isPlate) {
    dIn = h('input', { type: 'text', class: 'hh-d', autocomplete: 'off', placeholder: 'for example  1.5, 3, 3, 1.5', 'aria-label': 'distances across the plate' }); dIn.value = hs.dist;
    dIn.addEventListener('input', function () { hs.dist = dIn.value; });
    sIn = h('input', { type: 'text', class: 'hh-n', autocomplete: 'off', placeholder: '2', 'aria-label': 'stagger distance' }); sIn.value = hs.s;
    sIn.addEventListener('input', function () { hs.s = sIn.value; });
    sel = h('select', { 'aria-label': 'which holes are shifted' }, h('option', { value: 'even' }, 'the 2nd, 4th ... hole (the usual zig-zag)'), h('option', { value: 'odd' }, 'the 1st, 3rd ... hole'));
    sel.value = hs.which; sel.addEventListener('change', function () { hs.which = sel.value; });
    wrap.appendChild(h('div', { class: 'hh-row' }, h('b', null, 'B. '), 'The holes ZIG-ZAG (staggered). Read three things off the figure:',
      h('div', { class: 'hh-sub' }, '1. Every distance ACROSS the plate, in order from one edge to the other (edge to first hole, hole to hole, ..., last hole to edge), with commas:  ', dIn, ' in'),
      h('div', { class: 'hh-sub' }, '2. The stagger: how far the shifted holes are moved ALONG the plate (often marked s):  ', sIn, ' in'),
      h('div', { class: 'hh-sub' }, '3. Counting the holes from that first edge, which ones are shifted along the plate?  ', sel),
      h('button', { type: 'button', class: 'small sg', onclick: function () {
        var parts = String(hs.dist).split(/[,;]+/), d = [], k, s = num(hs.s), rows = [], acc = 0, sum = 0, names = [], w0, note = '';
        for (k = 0; k < parts.length; k++) { if (!trim(parts[k])) continue; d.push(num(trim(parts[k]))); }
        if (d.length < 2 || d.some(function (x) { return !(x > 0); })) { ui.holeMsg = 'Type the distances across the plate first, with commas: edge to first hole, hole to hole, ..., last hole to edge. For example: 1.5, 3, 3, 1.5'; redrawHoleHelp(part); return; }
        if (!(s >= 0)) { ui.holeMsg = 'Type the stagger distance (how far the shifted holes are moved along the plate). Type 0 if no hole is shifted.'; redrawHoleHelp(part); return; }
        for (k = 0; k < d.length; k++) sum += d[k];
        for (k = 0; k < d.length - 1; k++) {
          acc += d[k];
          var shifted = hs.which === 'even' ? (k % 2 === 1) : (k % 2 === 0);
          rows.push({ along: fmt(shifted ? s : 0), across: fmt(acc) });
          names.push(String.fromCharCode(65 + k) + ' (along ' + fmt(shifted ? s : 0) + ', across ' + fmt(acc) + ')');
        }
        vals.holes = rows; vals['_picked:holes'] = true; vals.holes_across = '';
        w0 = trim(vals.width_in);
        if (w0 === '' || Math.abs(num(w0) - sum) > 1e-6) {
          if (w0 !== '') note = ' Your text said the plate is ' + w0 + ' in wide, but the figure\'s distances add up to ' + fmt(sum) + ' in: the figure wins, so the width box now says ' + fmt(sum) + '. (On Quiz 1 she used the figure.) Write on your paper that you used the figure\'s width.';
          vals.width_in = fmt(sum); vals['_picked:width_in'] = true;
        }
        done('Done: ' + rows.length + ' holes: ' + names.join(', ') + '. Plate width ' + fmt(sum) + ' in.' + note + ' The page checks every path through the holes and uses the smallest.');
      } }, 'Fill in the holes')));
  }
  return wrap;
}

/* the figure: this page cannot see it.  The tick is kept, but it is now a question about specific quantities, with a place to type the figure's number */
function drawFigure(part) {
  var ui = part.ui, box = ui.figureEl, list, ul, i, cb, id = 'fig-' + part.id;
  if (!box) return;
  clear(box);
  box.appendChild(h('b', null, 'Your question mentions a figure. '));
  box.appendChild(doc.createTextNode('This page cannot see it. A number that is only drawn (a width, a span, a hole position) cannot be read from your text. If the figure and your text disagree, the figure wins.'));
  list = figureQuantities(part);
  if (list.length) {
    box.appendChild(h('div', { class: 'hint figask' }, 'Look at the figure and answer each question:'));
    ul = h('ul', { class: 'figq' });
    for (i = 0; i < list.length; i++) {
      (function (q) {
        var li = h('li', null, 'Does the figure show a different ', h('b', null, q.box.label), ' than your text (' + q.value + ' ' + q.box.unit + ')?  If it does, type the figure\'s value: '), inp = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'the figure\'s value of ' + q.box.label });
        inp.addEventListener('input', function () {
          var rowEl = ui.rows[q.si] && ui.rows[q.si][q.box.path];
          if (trim(inp.value) !== '' && rowEl && rowEl.setUi) rowEl.setUi(trim(inp.value));
        });
        li.appendChild(inp); li.appendChild(doc.createTextNode(' ' + q.box.unit));
        li.addEventListener('mouseenter', function () { setHighlight(part, spansOfBox(part, q.box), false); });
        li.addEventListener('mouseleave', function () { unhighlight(part); });
        ul.appendChild(li);
      })(list[i]);
    }
    box.appendChild(ul);
  } else {
    box.appendChild(h('div', { class: 'hint figask' }, 'Does the figure give a number your question needs that is not in a box below? If it does, type it in the box it belongs to.'));
  }
  try { var hh = holeHelper(part); if (hh) box.appendChild(hh); } catch (eH) { /* the helper is an extra: the boxes themselves still work */ }
  cb = h('input', { type: 'checkbox', id: id });
  cb.checked = !!ui.ticks.figure;
  /* one tick for the whole question: every part of it that mentions the figure takes the same tick (four parts used to need four ticks) */
  cb.addEventListener('change', function () {
    var Q = part.Q, i, p;
    ui.ticks.figure = cb.checked;
    if (Q) for (i = 0; i < Q.A.parts.length; i++) {
      p = Q.A.parts[i];
      if (p === part || !p.figure || !p.ui || !p.ui.ticks) continue;
      p.ui.ticks.figure = cb.checked;
      if (p.ui.figureEl) { try { drawFigure(p); } catch (eF) { /* its own tick still works */ } }
      refreshGate(p);
    }
    refreshGate(part);
  });
  box.appendChild(h('label', { class: 'ticklab', for: id }, cb, ' I looked at the figure for every number my question asks about, and the boxes have the figure\'s numbers. (One tick counts for every part of this question.)'));
}

function refreshGate(part) {
  var ui = part.ui, gate = SOLVE.gate(part, ui.vals, ui.ticks), g, ul, sk, pk, rw, was, want;
  ui.gateList = gate;
  /* the load boxes of an "is it adequate?" question: all of them stop being "needed" as soon as one has a value */
  for (sk in ui.rows) if (has(ui.rows, sk)) for (pk in ui.rows[sk]) if (has(ui.rows[sk], pk)) {
    rw = ui.rows[sk][pk];
    if (!rw || !rw.needNow) continue;
    was = / need(?: |$)/.test(rw.className); want = rw.needNow();
    if (want && !was) rw.className += ' need';
    else if (!want && was) rw.className = rw.className.replace(/ need(?= |$)/g, '');
  }
  if (!ui.gateEl) return;
  clear(ui.gateEl);
  if (gate.length) {
    ul = h('ul', { class: 'gl' });
    for (g = 0; g < gate.length; g++) ul.appendChild(h('li', null, gate[g].text));
    ui.gateEl.appendChild(h('div', { class: 'gatehead' }, 'This part needs you before it can be calculated:'));
    ui.gateEl.appendChild(ul);
    if (ui.moreEl) ui.moreEl.open = true;                  /* the boxes and the questions are in the folded section: show them */
  }
  if (ui.calcBtn) ui.calcBtn.disabled = gate.length > 0;
  if (ui.calcBtn) ui.calcBtn.className = 'go' + (gate.length ? ' off' : '');
  scheduleAuto(part);
}

/* ------------------------------------------------------------------------------------------------ no button: a part calculates itself as soon as nothing is in the way */
function sigOf(part) { try { return JSON.stringify([part.ui.vals, part.ui.ticks]); } catch (e) { return String(Math.random()); } }
function scheduleAuto(part) {
  var ui = part.ui;
  if (!ui || ui.noAuto) return;
  if (ui.autoT) root.clearTimeout(ui.autoT);
  ui.autoT = root.setTimeout(function () { ui.autoT = null; autoCalc(part); }, 350);
}
/* numbers an earlier part of the same question gave or found (Mu for "can it be used?", the column's length for "select the lightest that is") */
function carryIn(part) {
  var ui = part.ui, Q = part.Q, before, idx;
  if (!Q || part.kind !== 'form' || !ui.vals) return false;
  idx = Q.A.parts.indexOf(part);
  if (idx <= 0) return false;
  before = JSON.stringify(ui.vals);
  try { ui.carried = SOLVE.carryAcross(Q.A.parts, idx, ui.vals); } catch (e) { ui.carried = []; }
  return JSON.stringify(ui.vals) !== before;
}
function autoCalc(part, force) {
  var ui = part.ui, gate, sig;
  if (!ui || !ui.vals || !ui.bodyEl || (part.kind !== 'form' && part.kind !== 'words')) return;
  if (!part.stages.length || !part.stages.every(function (s) { return s.read && s.read.done; })) return;
  if (carryIn(part)) { ui.noAuto = true; try { renderBody(part); } finally { ui.noAuto = false; } }
  gate = SOLVE.gate(part, ui.vals, ui.ticks);
  ui.gateList = gate;
  sig = sigOf(part);
  if (gate.length) {
    if (ui.run || ui.sig !== 'blocked:' + sig) { ui.run = null; ui.wb = null; ui.sig = 'blocked:' + sig; renderResult(part); drawQuestionBar(part.Q); laterParts(part); }
    return;
  }
  if (!force && ui.sig === sig && ui.run) return;
  ui.sig = sig;
  calculate(part, true);
}
/* the parts after this one may take a number from it */
function laterParts(part) {
  var Q = part.Q, i, idx;
  if (!Q) return;
  idx = Q.A.parts.indexOf(part);
  for (i = idx + 1; i < Q.A.parts.length; i++) if (Q.A.parts[i].ui && Q.A.parts[i].ui.vals) autoCalc(Q.A.parts[i]);
}

function stageTitle(part, si) {
  var st = part.stages[si], multi = part.stages.length > 1, form = st.form;
  return (multi ? 'Step ' + (si + 1) + ' of ' + part.stages.length + ': ' : '') + (form ? form.label : st.fn);
}

function renderStageBoxes(part, si, container, refreshAll) {
  var st = part.stages[si], ui = part.ui, main = h('div', { class: 'rows' }), rest = h('details', { class: 'restbox' }), restRows = h('div', { class: 'rows' }), nRest = 0, i, b, rowEl, names = [], unsure = [], usual = [], asked = [];
  ui.rows[si] = {};
  for (i = 0; i < st.boxes.length; i++) {
    b = st.boxes[i];
    rowEl = boxRow(part, si, b, refreshAll);
    ui.rows[si][b.path] = rowEl;
    /* the main list: boxes with a proposal, a disagreement, a carried value, a required box, or a question the rule reader raised.
       The model often says "unclear" about boxes the text never mentions; those (and boxes left at their usual value) wait in the folded list. */
    var sv = ui.vals && ui.vals[si] ? ui.vals[si] : {};
    var shown = b.state === 'agree' || b.state === 'model' || b.state === 'rule' || b.state === 'conflict' || b.state === 'carried' || b.required || b.reqGroup
      || sv['_from:' + b.path] !== undefined || sv['_ai:' + b.path] !== undefined;      /* a value taken from an earlier part, or found by the AI helper afterwards */
    if (shown) main.appendChild(rowEl);
    else {
      restRows.appendChild(rowEl); nRest++;
      if (b.ruleQuestion || b.askNow) asked.push(b.label);
      if (b.state === 'unclear' || b.state === 'rejected') unsure.push(b.label);
      else names.push(b.label + (b.state === 'default' && b.defaultValue !== undefined && b.defaultValue !== '' ? ' ' + String(b.defaultValue) : ''));
      if (b.state === 'default' && b.defaultValue !== undefined && b.defaultValue !== null && b.defaultValue !== '' && typeof b.defaultValue !== 'object' && b.defaultValue !== false && b.defaultValue !== 0) usual.push(b.label + ' = ' + String(b.defaultValue) + (b.unit && b.kind !== 'bool' ? ' ' + b.unit : ''));
    }
  }
  container.appendChild(main);
  if (usual.length) container.appendChild(h('div', { class: 'usual' }, h('b', null, 'Not in your text, so the calculator uses its usual value: '), usual.join(';  '), '.  If your question says otherwise, open the list below and change it.'));
  ui.rest = ui.rest || {};
  if (nRest) {
    rest.appendChild(h('summary', null, nRest + ' other box' + (nRest > 1 ? 'es' : '') + ' (optional: not in your text, or left at the calculator\'s usual value). Open to change one.'));
    if (names.length) rest.appendChild(h('div', { class: 'restnames' }, names.join('  |  ')));
    if (asked.length) rest.appendChild(h('div', { class: 'restnames' }, 'The rule reader noticed words about these but found no number to copy: ' + asked.join('  |  ') + '.  Open the list if your question gives one.'));
    if (unsure.length) rest.appendChild(h('div', { class: 'restnames' }, 'The model was unsure about (it could not copy a value for): ' + unsure.join('  |  ')));
    rest.appendChild(restRows);
    container.appendChild(rest);
    ui.rest[si] = rest;
  }
}

function findBox(part, si, path) {
  var st = part.stages[si], i;
  if (!st || !st.boxes) return null;
  for (i = 0; i < st.boxes.length; i++) if (st.boxes[i].path === path) return st.boxes[i];
  return null;
}
/* open every folded list above a row, so he can see it */
function openAncestors(part, rowEl) {
  var anc = rowEl && rowEl.parentNode;
  while (anc && anc !== part.ui.bodyEl) { if (anc.tagName && anc.tagName.toLowerCase() === 'details') anc.open = true; anc = anc.parentNode; }
}
/* ONE QUESTION for a number of his text that no box used: which box does it belong in?  (He answers each one; nothing runs until he has.) */
function unusedBlock(part, q) {
  var ui = part.ui, blk = h('div', { class: 'uq' }), choices = ui.ticks.unusedChoices, btns = [], msg = h('div', { class: 'uqmsg' }), c, none, chipEl;
  function sync() {
    var k, cur = choices[q.text];
    for (k = 0; k < btns.length; k++) btns[k].el.className = 'opt' + (cur === btns[k].val ? ' on' : '');
    if (!cur) { msg.textContent = 'Not answered yet.'; msg.className = 'uqmsg open'; }
    else msg.className = 'uqmsg done';
  }
  function say(t) { msg.textContent = t; }
  chipEl = h('span', { class: 'chip un' }, q.text);
  chipEl.addEventListener('mouseenter', function () { setHighlight(part, allOccurrences(part.ctx, q.text), false); });
  chipEl.addEventListener('mouseleave', function () { unhighlight(part); });
  blk.appendChild(h('div', { class: 'uqhead' }, chipEl, ' is in your text, but no box used it. Which box does it belong in?'));
  btns = [];
  function addBtn(label, val, onclick, title) {
    var el = h('button', { type: 'button', class: 'opt', title: title || '' }, label);
    el.addEventListener('click', function () { onclick(); choices[q.text] = val; sync(); refreshGate(part); });
    btns.push({ el: el, val: val });
    blk.appendChild(el);
  }
  function onBox(cd) {
    var rowEl = ui.rows[cd.si] && ui.rows[cd.si][cd.path], p = SOLVE.numberFromText(q.text), b = findBox(part, cd.si, cd.path), v = null, was = ui.vals[cd.si] ? ui.vals[cd.si][cd.path] : '';
    if (cd.fill && p && b) v = SOLVE.valueForBox(p, b);
    openAncestors(part, rowEl);
    if (v !== null && rowEl && rowEl.setUi) {
      rowEl.setUi(v);
      say('Typed ' + v + (b.unit ? ' ' + b.unit : '') + ' in "' + cd.label + '"' + (trim(was) !== '' && trim(was) !== v ? ' (it said ' + trim(was) + ' before)' : '') + '. Check it against your words.');
    } else say('Now type it in the box "' + cd.label + '" (it is marked below).');
    if (rowEl) { try { rowEl.scrollIntoView({ block: 'center' }); } catch (e) { /* older browsers */ } rowEl.className += ' flash'; setTimeout(function () { rowEl.className = rowEl.className.replace(/ flash/g, ''); }, 1800); }
  }
  for (var k = 0; k < q.cands.length; k++) {
    c = q.cands[k];
    (function (cd) { addBtn('Put it in: ' + cd.label + (cd.unit && cd.kind !== 'bool' ? ' (' + cd.unit + ')' : ''), cd.si + ':' + cd.path, function () { onBox(cd); }, 'put this number in the box ' + cd.label); })(c);
  }
  if (!q.cands.length) blk.appendChild(h('div', { class: 'hint' }, 'No box of this form takes this kind of number.'));
  addBtn('It belongs in no box', 'none', function () { say('You said it belongs in no box. It is not used.'); }, 'this number does not matter for this part');
  blk.appendChild(msg);
  sync();
  return blk;
}
function drawUnused(part) {
  var ui = part.ui, box = ui.unusedEl, qs, i, openQs = [], filledQs = [], chips, cb, id = 'unusedgrp-' + part.id;
  if (!box) return;
  clear(box);
  ui.ticks.unusedChoices = ui.ticks.unusedChoices || {};
  qs = SOLVE.unusedQuestions(part);
  ui.unusedSpans = [];
  var askedAsBoxes = false;
  try { askedAsBoxes = SOLVE.wantedBoxes(part, ui.vals, ui.run && !ui.run.ok ? ui.run : null).length > 0; } catch (eWB) { askedAsBoxes = false; }
  for (i = 0; i < qs.length; i++) {
    ui.unusedSpans = ui.unusedSpans.concat(allOccurrences(part.ctx, qs[i].text));
    if (askedAsBoxes && !qs[i].blocking) continue;
    (qs[i].open ? openQs : filledQs).push(qs[i]);
  }
  if (openQs.length) {
    box.appendChild(h('div', { class: 'unusedhead' }, 'Numbers in your text that no box used (underlined in your words above). A number that matters but sits in no box makes the answer wrong, so answer each one:'));
    if (openQs.length >= 2) box.appendChild(h('button', { type: 'button', class: 'small sg', onclick: function () {
      var k; for (k = 0; k < openQs.length; k++) ui.ticks.unusedChoices[openQs[k].text] = 'none';
      drawUnused(part); refreshGate(part);
    } }, 'None of these numbers belongs in a box'));
    for (i = 0; i < openQs.length; i++) box.appendChild(unusedBlock(part, openQs[i]));
  }
  if (filledQs.length) {
    /* every box that could take these numbers already has a value: they are most likely other quantities.  One tick for all of them. */
    box.appendChild(h('div', { class: 'unusedhead' }, 'Also in your text, in no box (every box that could take them already has a value):'));
    chips = h('div', { class: 'chips' });
    filledQs.forEach(function (q) {
      var c = h('span', { class: 'chip un' }, q.text);
      c.addEventListener('mouseenter', function () { setHighlight(part, allOccurrences(part.ctx, q.text), false); });
      c.addEventListener('mouseleave', function () { unhighlight(part); });
      chips.appendChild(c);
    });
    box.appendChild(chips);
    box.appendChild(h('div', { class: 'hint' }, 'Look at your text (they are underlined). If one of them should have been a value in a box above, type it there.'));
    cb = h('input', { type: 'checkbox', id: id });
    cb.checked = !!ui.ticks.unusedGroup;
    cb.addEventListener('change', function () { ui.ticks.unusedGroup = cb.checked; refreshGate(part); });
    box.appendChild(h('label', { class: 'ticklab', for: id }, cb, ' I looked at each of these numbers: none of them should change a box.'));
  }
}

function describeEngineError(res, stageIdx, part) {
  var e = res.error || {}, code = e.code || '?', lead;
  if (code === 'MISSING') lead = 'The calculator needs something that is empty.';
  /* the page's own refusals (pipeline.js, stage.refuse): a question this page does not do, or words it could not read */
  else if (code === 'NOT_IN_TOOL') lead = 'This page does NOT answer this question.';
  else if (code === 'PAGE_STOP') lead = 'The page stopped: your question says something it could not use.';
  else if (code === 'NOT_FOUND') lead = 'The calculator does not know this name.';
  else if (code === 'AMBIGUOUS') lead = 'The calculator cannot tell which one you mean.';
  else if (code === 'OUT_OF_RANGE') lead = 'The calculator refused a value that is outside what it accepts.';
  else lead = 'The calculator refused what was typed.';
  return lead;
}

function renderResult(part) {
  var ui = part.ui, box = ui.resultEl, run = ui.run, wb = ui.wb, si, sr, res, w, pre, readBox, ul, k, lines, ev, st, errBox, sug, held = aiOpen(part);
  if (!box) return;
  clear(box);
  try { drawChoices(part, box); } catch (eC) { /* an extra: the look-up below still works */ }
  if (!run) { drawNeeds(part, box); try { drawRelated(part, box); } catch (eR0) { /* an extra */ } return; }
  /* what failed? */
  for (si = 0; si < run.stages.length; si++) {
    sr = run.stages[si];
    if (sr.skipped || (sr.res && !sr.res.ok)) {
      st = part.stages[si];
      errBox = h('div', { class: 'errbox' });
      errBox.appendChild(h('div', { class: 'errhead' }, 'No answer was written. ' + (sr.skipped ? 'This step was not run.' : describeEngineError(sr.res, si, part))));
      if (sr.skipped) errBox.appendChild(h('div', null, sr.skipped));
      else {
        ev = sr.res.error || {};
        errBox.appendChild(h('div', { class: 'errmsg' }, ev.message || ''));
        sug = ev.suggestions || [];
        if (sug.length) {
          var sbox = h('div', { class: 'sugg' }, h('div', { class: 'hint' }, part.kind === 'words' ? 'Click one to look it up:' : 'The calculator suggests (click one to put it in the box; then check it against your question and press calculate again):'));
          sug.slice(0, 10).forEach(function (s) { sbox.appendChild(h('button', { type: 'button', class: 'small sg', onclick: function () { applySuggestion(part, si, s, ev); } }, s)); });
          errBox.appendChild(sbox);
        }
        if (ev.suggestion_groups && ev.suggestion_groups.length) {
          ev.suggestion_groups.forEach(function (g) { errBox.appendChild(h('div', { class: 'hint' }, g.label + ': ' + g.items.join(', '))); });
        }
        if (part.kind === 'words' && ev.code === 'NOT_FOUND') errBox.appendChild(h('div', { class: 'hint' }, 'Nothing of hers matches. This may be a question to answer in your own words (explain, why, describe): the calculator has no wording for it.'));
        /* the floor-plan worksheet runs on to the girder and the column unless told to stop */
        var stepM = /^Step\s+([2-4])\s+needs/i.exec(String(ev.message || ''));
        if (stepM && st && st.fn === 'floor_plan' && !trim((ui.vals[si] && ui.vals[si].through_step) || '')) {
          var stopAt = Number(stepM[1]) - 1, what = ['', 'the floor load', 'the beam', 'the girder'][stopAt];
          errBox.appendChild(h('div', { class: 'stephint' }, 'The worksheet goes on to the next step. If your question asks only about ' + what + ' (not a later step), stop it there: ',
            h('button', { type: 'button', class: 'small sg', onclick: function () { setStopStep(part, si, stopAt); } }, 'Stop after step ' + stopAt + ' (' + what + ')')));
        }
      }
      var ecode = !sr.skipped && sr.res && sr.res.error ? sr.res.error.code : '';
      errBox.appendChild(h('div', { class: 'errgo' }, part.kind === 'words' ? 'Change the words below and it is looked up again.'
        : (ecode === 'NOT_IN_TOOL' ? 'There is nothing to fix in the boxes. Write what you can for this question on your paper and go on to the next one.'
          : (ecode === 'PAGE_STOP' ? 'If the message above names a box, open "Change a value" below and fill that box: the answer then appears by itself. If it names none, go on to the next question.'
            : 'Fix this in the boxes below (the ones the calculator named are marked in red). The answer appears here by itself as soon as the calculator accepts them.'))));
      /* the calculator wants the holes and this part has no figure block: the hole helper goes here */
      if (!sr.skipped && /\bholes?\b/i.test(String((sr.res.error || {}).message || '')) && !ui.figureEl) { try { var hh2 = holeHelper(part); if (hh2) errBox.appendChild(hh2); } catch (eH2) { /* an extra */ } }
      box.appendChild(errBox);
      if (!sr.skipped) { try { drawWanted(part, box); } catch (eW2) { /* an extra: the boxes below still work */ } }
      break;
    }
  }
  if (run.ok) {
    w = h('div', { class: 'write' + (held ? ' hold' : '') });
    if (held) w.appendChild(h('div', { class: 'holdmsg' }, 'WAIT. Do not write this part down yet: the AI helper read ' + held + ' value' + (held > 1 ? 's' : '') + ' differently. Decide ' + (held > 1 ? 'them' : 'it') + ' in the red block above first.'));
    w.appendChild(h('div', { class: 'whead' }, h('span', { class: 'wtitle' }, 'WRITE THIS' + (part.label ? '   (' + part.label + ')' : '')), ' ', held ? null : h('button', { type: 'button', class: 'small', onclick: function (ev2) { copyText(wb.write, ev2.target); } }, 'Copy')));
    /* THE VALUES THIS ANSWER STANDS ON, above the answer (the councils of 10/06 night: every lab asked for the shape and the numbers the page used to be
       named where he copies from, to be ticked against the paper BEFORE he copies -- a wrong shape or a dropped count gives a clean, plausible, wrong
       block).  One short line; the table under the answer still shows the words each value was read from. */
    try {
      var usedRows = checkRows(part), usedShape = null, usedBits = [], ur;
      for (ur = 0; ur < usedRows.length; ur++) {
        if (/(?:^|: )(?:shape|section|member)\b/i.test(usedRows[ur].label) && !usedShape) usedShape = usedRows[ur].value;
        else usedBits.push(String(usedRows[ur].label).replace(/\s*[?:]\s*$/, '') + ': ' + usedRows[ur].value);
      }
      if (usedShape || usedBits.length) {
        var strip = h('div', { class: 'usedstrip' }, h('b', null, 'BEFORE YOU COPY, tick each of these against your paper. '));
        if (usedShape) strip.appendChild(h('span', { class: 'usedshape' }, 'SHAPE I USED: ' + usedShape));
        if (usedBits.length) strip.appendChild(h('span', { class: 'usedbits' }, (usedShape ? '   |   ' : '') + usedBits.join('   |   ')));
        strip.appendChild(h('div', { class: 'usedrule' }, 'If one of them is not what your paper says, do not copy: fix that word or digit in the box at the top and press Solve again.'));
        w.appendChild(strip);
      }
    } catch (eU) { /* an extra: the answer and the check table below do not depend on it */ }
    pre = h('pre', { class: 'wtext' });
    pre.appendChild(doc.createTextNode(wb.writeLines.slice(1).join('\n')));
    w.appendChild(pre);
    box.appendChild(w);
    drawCheckTable(part, box);
  } else if (wb && wb.read.length === 0) { /* nothing to add */ }
  /* the read-only block: flags and errors */
  if (wb && (wb.read.length || part.route.traps.length || (ui.notes && ui.notes.length))) {
    readBox = h('div', { class: 'readonly' }, h('div', { class: 'rhead' }, 'Read this, do not write it'));
    ul = h('ul');
    for (k = 0; k < wb.read.length; k++) ul.appendChild(h('li', { class: 'fl fl-' + SOLVE.flagKind(wb.read[k]) }, wb.read[k]));
    if (ui.notes && ui.notes.length) for (k = 0; k < ui.notes.length; k++) ul.appendChild(h('li', { class: 'fl fl-note' }, ui.notes[k]));
    readBox.appendChild(ul);
    if (wb.read.length || (ui.notes && ui.notes.length)) box.appendChild(readBox);
  }
  if (run.ok && wb.other.length) {
    var ob = h('details', { class: 'other' }, h('summary', null, 'Other numbers this calculation found (write one only if your question asks for exactly that)'));
    ul = h('ul'); wb.other.forEach(function (o) { ul.appendChild(h('li', null, o)); }); ob.appendChild(ul); box.appendChild(ob);
  }
  if (run.ok && wb.sources && wb.sources.length) {
    var sb = h('details', { class: 'other' }, h('summary', null, 'Where each line comes from (the calculator\'s sources; write them only if you want to cite them)'));
    ul = h('ul'); wb.sources.forEach(function (o) { ul.appendChild(h('li', null, o)); }); sb.appendChild(ul); box.appendChild(sb);
  }
  if (wb && wb.given.length) {
    var gb = h('details', { class: 'other' }, h('summary', null, 'What you confirmed (the numbers that went into the calculator)'));
    ul = h('ul'); wb.given.forEach(function (o) { ul.appendChild(h('li', null, o)); }); gb.appendChild(ul); box.appendChild(gb);
  }
  try { drawRelated(part, box); } catch (eR) { /* an extra */ }
}
/* a word question: every entry of hers that touches the words of the question, in her own wording, for him to read and copy from */
function drawRelated(part, box) {
  var list, wrap;
  if (part.kind !== 'words') return;
  /* (10/07) when the order-free matcher found her sentences they stand in the block itself; this older list (entries whose NAME is in the question)
     would be a second, weaker list under it */
  if (part.wx && part.wx.hits && part.wx.hits.length) return;
  list = SOLVE.relatedEntries(part.text, 10);
  if (!list.length) return;
  wrap = h('div', { class: 'related' }, h('div', { class: 'rel-head' }, 'HER OWN WORDS on what your question mentions (' + list.length + ' entr' + (list.length === 1 ? 'y' : 'ies') + ')'),
    h('div', { class: 'hint' }, 'A question that says explain, why, name or give is often answered by MORE than one of these. Read them, and write the ones that answer your question. The first ones match your words best.'));
  list.forEach(function (e) {
    wrap.appendChild(h('div', { class: 'rel-row' }, h('div', { class: 'rel-text' }, e.text), h('span', { class: 'hint' }, 'matched on: ' + e.via + '   '),
      h('button', { type: 'button', class: 'small', onclick: function (ev) { copyText(e.text, ev.target); } }, 'Copy')));
  });
  box.appendChild(wrap);
}

/* floor plan: "stop after step N" (the box through_step); the student still presses the calculate button himself */
function setStopStep(part, si, n) {
  var ui = part.ui, vals = ui.vals[si], rowEl = ui.rows[si] && ui.rows[si].through_step;
  vals.through_step = String(n); vals['_picked:through_step'] = true;
  if (rowEl) { var inp = rowEl.querySelector('input'); if (inp) inp.value = String(n); if (rowEl.refresh) rowEl.refresh(); }
  if (ui.rest && ui.rest[si]) ui.rest[si].open = true;
  ui.notes = ui.notes || [];
  ui.notes.push('You told the floor-plan worksheet to stop after step ' + n + '.');
  refreshGate(part);
  clear(ui.resultEl);
  ui.run = null; ui.wb = null;
  ui.resultEl.appendChild(h('div', { class: 'info' }, '"Stop after this step" is now ' + n + ' (in the other boxes below). Press the button to calculate again.'));
}

/* the student clicked a suggestion in an error box */
function applySuggestion(part, si, s, ev) {
  var ui = part.ui, st = part.stages[si], b, i, k, vals = ui.vals[si], target = null, old;
  if (part.kind === 'words') {
    vals.query = s; vals['_picked:query'] = true;
    var qrow = part.ui.rows[si] && part.ui.rows[si].query, qin = qrow && qrow.querySelector('textarea, input');
    if (qin) qin.value = s;
    if (qrow && qrow.refresh) qrow.refresh();
    calculate(part);
    return;
  }
  for (i = 0; i < st.boxes.length; i++) { b = st.boxes[i]; if (b.spec && b.spec.type === 'shape') { target = b; break; } }
  if (!target) return;
  old = vals[target.path];
  vals[target.path] = s; vals['_picked:' + target.path] = true;
  ui.notes = ui.notes || [];
  ui.notes.push('You replaced ' + old + ' (in your question) with ' + s + ' (suggested by the calculator). Write on your paper that you did.');
  var rowEl = ui.rows[si][target.path];
  if (rowEl) { var inp = rowEl.querySelector('input'); if (inp) inp.value = s; if (rowEl.refresh) rowEl.refresh(); }
  refreshGate(part);
  ui.run = null; ui.wb = null; clear(ui.resultEl);
  ui.resultEl.appendChild(h('div', { class: 'info' }, 'The box now says ' + s + '. Check it against your question, then press the button to calculate again.'));
}

function noteMissingBoxes(part, run, auto) {
  var ui = part.ui, si, sr, msg, b, i, found = {}, any = false, first = null;
  ui.engineMissing = {};
  if (!run || run.ok || run.failedAt < 0) return;
  sr = run.stages[run.failedAt]; if (!sr || !sr.res || !sr.res.error) return;
  msg = String(sr.res.error.message || '');
  si = run.failedAt;
  var st = part.stages[si];
  for (i = 0; i < st.boxes.length; i++) {
    b = st.boxes[i];
    var esc = b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), plain = /^[a-z]+$/.test(b.name), re;
    /* a one-word lowercase name (member, shape, family) is common English: count it only when the message wraps it as a name */
    re = plain ? new RegExp('[(\'"`]' + esc + '[)\'"`]') : new RegExp('(^|[^A-Za-z0-9_])' + esc + '([^A-Za-z0-9_]|$)');
    /* a short symbol (D, L, K, Pu) counts only as a capital letter standing alone ("Enter D and L"); "A" and "r" are too common */
    if ((b.name.length > 2 || (/^[A-Z][a-z]?$/.test(b.name) && b.name !== 'A')) && re.test(msg)) { ui.engineMissing[b.path] = true; any = true; if (!first) first = b.path; }
  }
  for (var p in ui.engineMissing) if (has(ui.engineMissing, p)) {
    var rowEl = ui.rows[si] && ui.rows[si][p];
    if (rowEl) {
      rowEl.className += ' engine-missing';
      /* a named box that sits in the folded list: open the list so he can see it */
      openAncestors(part, rowEl);
    }
  }
  if (!auto && first && ui.rows[si] && ui.rows[si][first]) { try { ui.rows[si][first].scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ } }
}

/* ------------------------------------------------------------------------------------------------ history */
function histText(entry) { return entry.text; }
function drawHistory() {
  var box = $('hist'), list = $('histlist'), i, e, item;
  clear(list);
  if (!APP.history.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  for (i = 0; i < APP.history.length; i++) {
    e = APP.history[i];
    item = h('details', { class: 'hitem' }, h('summary', null, h('b', null, e.title), '  ', h('span', { class: 'hsub' }, e.sub + '  ' + e.time)));
    item.appendChild(h('div', { class: 'hq' }, e.question));
    item.appendChild(h('pre', { class: 'wtext' }, e.text));
    (function (entry) { item.appendChild(h('button', { type: 'button', class: 'small', onclick: function (ev) { copyText(entry.text, ev.target); } }, 'Copy')); })(e);
    list.appendChild(item);
  }
  var save = []; for (i = 0; i < APP.history.length && i < 25; i++) save.push(APP.history[i]);
  lsSet('steelsolve.history', JSON.stringify(save));
}
function pad2(x) { return (x < 10 ? '0' : '') + x; }
function stampNow() { var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function recordHistory(part) {
  var ui = part.ui, key = part.qid + ':' + part.id, i, entry;
  entry = { key: key, title: 'Question ' + part.qn + (part.label ? '  (' + part.label + ')' : ''), sub: (part.stages.length ? (part.stages[part.stages.length - 1].form ? part.stages[part.stages.length - 1].form.label : '') : ''), time: stampNow(),
    question: collapse(part.text).slice(0, 220), text: ui.wb.write };
  for (i = 0; i < APP.history.length; i++) if (APP.history[i].key === key) { APP.history.splice(i, 1); break; }
  APP.history.unshift(entry);
  while (APP.history.length > MAX_HISTORY) APP.history.pop();
  drawHistory();
}

/* ------------------------------------------------------------------------------------------------ calculate */
/* auto = the page calculated by itself (nothing was in the way): the screen does not jump to the result */
function calculate(part, auto) {
  var ui = part.ui, run, wb;
  ui.notes = ui.notes || [];
  if (!auto) { carryIn(part); ui.sig = sigOf(part); }
  try {
    run = SOLVE.runPart(part, ui.vals);
    wb = SOLVE.writeBlock(part, run, ui.vals);
  } catch (e) {
    run = { ok: false, stages: [], failedAt: 0 };
    wb = { write: '', writeLines: [], read: ['The page hit an error while calculating: ' + (e && e.message ? e.message : e)], other: [], given: [], ok: false };
  }
  ui.run = run; ui.wb = wb;
  ui.engineMissing = {};
  try { renderResult(part); }
  catch (e3) { clear(ui.resultEl); ui.resultEl.appendChild(h('div', { class: 'errbox' }, h('div', { class: 'errhead' }, 'The answer could not be shown: ' + SOLVE.plainError(e3)), h('div', null, 'Your boxes are kept. Change a box and the page calculates again.'))); }
  try { noteMissingBoxes(part, run, auto); } catch (e4) { /* only a highlight */ }
  if (!run.ok && ui.moreEl) ui.moreEl.open = true;                    /* the calculator refused something: show the boxes */
  if (run.ok) recordHistory(part);
  drawQuestionBar(part.Q);
  if (!auto && ui.resultEl && ui.resultEl.scrollIntoView) { try { ui.resultEl.scrollIntoView({ block: 'nearest' }); } catch (e2) { /* ignore */ } }
  laterParts(part);
}

/* ------------------------------------------------------------------------------------------------ rendering a part */
function readingBadge(part) {
  var m = APP.model.cls, parts = [], si, st, llm = false, err = null;
  for (si = 0; si < part.stages.length; si++) { st = part.stages[si]; if (st.read && st.read.llmUsed) llm = true; if (st.read && st.read.llmError) err = st.read.llmError; }
  if (part.kind === 'words') return 'Search words: the whole question is used.';
  return 'These boxes were read by the page itself. What the AI helper found (when it is running) is shown above the answer, not here.';
}

/* "this part could not be read: <plain reason>": his text is kept, the other parts are not touched, and he may choose a form himself */
function renderErrorCard(part) {
  var ui = part.ui, card = ui.card;
  clear(card);
  card.className = 'part part-out';
  card.appendChild(h('div', { class: 'phead' }, part.label ? h('span', { class: 'plabel' }, '(' + part.label + ')') : null, h('span', { class: 'pform bad' }, 'This part could not be read')));
  card.appendChild(h('div', { class: 'bad' }, 'This part could not be read: ' + (part.errorText || 'for an unknown reason') + '.'));
  card.appendChild(h('pre', { class: 'ctx' }, String(part.text || '')));
  card.appendChild(h('div', { class: 'hint' }, 'Your text is kept (above, and in the box at the top of the page). The other parts of the question are not affected. You can choose a form yourself and read the boxes with the rule reader:'));
  card.appendChild(formPicker(part, function (fn) { chooseForm(part, fn); }));
}
function safeRender(part) {
  try {
    if (part.kind === 'error') { renderErrorCard(part); return; }
    renderPart(part);
  } catch (e) {
    SOLVE.failPart(part, e);
    try { renderErrorCard(part); } catch (e2) { clear(part.ui.card); part.ui.card.appendChild(h('div', { class: 'bad' }, 'This part could not be shown: ' + SOLVE.plainError(e2))); }
  }
}

function renderPart(part) {
  var ui = part.ui, card = ui.card, route = part.route, head, i, body, tr, t, why, chips, rowText, hasReading = false, si, st, wasOpen = !!(ui.moreEl && ui.moreEl.open), more;
  clear(card);
  ui.fromEls = []; ui.aiEl = null; ui.resultEl = null; ui.moreEl = null; ui.bodyEl = null; ui.gateEl = null; ui.calcBtn = null;
  card.className = 'part ' + (part.kind === 'not_in_tool' ? 'part-out' : (part.kind === 'nomatch' ? 'part-none' : 'part-form'));
  ui.rows = {};
  head = h('div', { class: 'phead' });
  if (part.label) head.appendChild(h('span', { class: 'plabel' }, '(' + part.label + ')'));
  if (part.kind === 'form' || part.kind === 'words') {
    head.appendChild(h('span', { class: 'pform' }, part.stages.length ? (part.stages.length > 1 ? part.stages.map(function (s, k) { var f = STEEL.list(); var lab = s.fn; var q; for (q = 0; q < f.length; q++) if (f[q].name === s.fn) lab = f[q].label; return lab; }).join('  then  ') : (route.tab || part.stages[0].fn)) : ''));
    if (part.forced) head.appendChild(h('span', { class: 'forced' }, 'form chosen by you'));
  } else if (part.kind === 'not_in_tool') head.appendChild(h('span', { class: 'pform bad' }, 'The calculator cannot do this part'));
  else head.appendChild(h('span', { class: 'pform warn' }, 'No form matched'));
  card.appendChild(head);
  if (part.split) card.appendChild(h('div', { class: 'hint' }, 'Your text asks several things. This is one of them, taken on its own.'));
  card.appendChild(h('div', { class: 'ptext' }, collapse(part.text).length > 260 ? collapse(part.text).slice(0, 258) + '..' : collapse(part.text)));

  if (part.kind === 'not_in_tool') {
    var seenWhy = {}, wordsFor = {};
    for (i = 0; i < part.notIn.length; i++) { var dk = part.notIn[i]['do']; wordsFor[dk] = (wordsFor[dk] || []).concat(part.notIn[i].words || []); }
    for (i = 0; i < part.notIn.length; i++) {
      var why1 = part.notIn[i]['do'];
      if (seenWhy[why1]) continue;
      seenWhy[why1] = 1;
      card.appendChild(h('div', { class: 'bad' }, h('b', null, 'Why: '), why1, wordsFor[why1].length ? h('span', { class: 'hint' }, '   (your words: ' + wordsFor[why1].join(', ') + ')') : null));
    }
    card.appendChild(h('div', { class: 'hint' }, 'Nothing is calculated for this part. Write what you can by hand and move on.'));
    card.appendChild(h('div', { class: 'hint' }, 'If the words quoted above are only negated in your text (for example "has no overhang"), take that phrase out of the box at the top and press Solve again.'));
    return;
  }
  if (part.kind === 'nomatch') {
    card.appendChild(h('div', { class: 'warnbox' }, 'None of the finder\'s giveaway words is in this part. Pick the form yourself (the calculator then reads its boxes from your text):'));
    card.appendChild(formPicker(part, function (fn) { chooseForm(part, fn); }));
    return;
  }
  if (part.rerouted) card.appendChild(h('div', { class: 'reroute' }, h('b', null, 'How this calculation was chosen: '), part.rerouted.why + '.' +
    (part.rerouted.fromLabel ? '  (The wording alone pointed to "' + part.rerouted.fromLabel + '", which ' + (part.rerouted.was === 'answered' || part.rerouted.was === 'figure' ? 'does not give what the blank asks' : 'could not be worked out from your question') + '.)' : '')));
  if (part.askedMismatch) card.appendChild(h('div', { class: 'bad' }, h('b', null, 'Not what your blank asks. '), 'Your answer blank is "' + part.askedMismatch.raw + '". The calculation below does not give that. Do not copy its ANSWER line into that blank; choose another form at the bottom of this part.'));
  if (route.want && part.stages.length) card.appendChild(h('div', { class: 'gives' }, h('b', null, 'This form gives: '), route.want + '.  ', h('span', { class: 'hint' }, 'If your question asks for something else, choose another form at the bottom of this part.')));
  more = h('details', { class: 'more' }, h('summary', null, 'Change a value / see how the page read this part'));
  ui.moreEl = more;
  if (route.marks && (route.marks.family.length || route.marks.form.length)) {
    chips = h('div', { class: 'decided' }, h('span', { class: 'hint' }, 'The form was decided by these words: '));
    var seen = {};
    (route.marks.family || []).concat(route.marks.form || []).forEach(function (m) { var s = String(m).replace(/^re:.*\|/, ''); if (!seen[s]) { seen[s] = 1; chips.appendChild(chip(s, 'dec')); } });
    more.appendChild(chips);
  }
  if (route.also && route.also.length || route.by_default) {
    t = [];
    if (route.also && route.also.length) t.push('The words also fit another kind of member.');
    if (route.by_default) t.push('No word named the form, so this is the usual one for this kind of member.');
    card.appendChild(h('div', { class: 'warnbox' }, h('b', null, 'Not certain. '), t.join(' ') + ' Check the "It gives" line against your question, or choose another form below.'));
  }
  if (part.others && part.others.length) {
    var ob = h('div', { class: 'warnbox' }, h('b', null, 'Your question may ask for more than one thing. '), 'This page gives ONE form per part. Other forms whose words are also in your question:');
    part.others.forEach(function (o) {
      ob.appendChild(h('div', { class: 'alsoline' }, h('b', null, o.tab), ' -- ' + o.want + '  ', h('span', { class: 'hint' }, '(your words: ' + o.words.join(', ') + ')  '),
        h('button', { type: 'button', class: 'small sg', onclick: function () { addAlso(part, o.fn); } }, 'Also solve this')));
    });
    card.appendChild(ob);
  }
  if (route.rider) card.appendChild(h('div', { class: 'warnbox' }, 'Your question also asks you to explain or name something. This page only does the calculation; do that part in words yourself.'));
  /* the AI helper's line and the ANSWER come next; how the page got there is folded below them */
  ui.aiEl = h('div', { class: 'ai' });
  ui.resultEl = h('div', { class: 'result' });
  card.appendChild(ui.aiEl);
  card.appendChild(ui.resultEl);
  /* the finder's careful-with list */
  var checks = [];
  for (i = 0; i < route.traps.length; i++) if (!route.traps[i].not_in_tool && route.family !== 'words') checks.push(route.traps[i]);
  if (checks.length) {
    var cd = h('details', { class: 'checks', open: 'open' }, h('summary', null, 'Words in your text to be careful with (' + checks.length + ')'));
    checks.forEach(function (c) { cd.appendChild(h('div', { class: 'chk' }, h('span', { class: 'chip trp' }, (c.words || []).join(', ') || c.when), ' ', c['do'])); });
    more.appendChild(cd);
  }
  /* a figure is a question for him (the page cannot see it): it stays in sight, above the folded section */
  if (part.figure) { ui.figureEl = h('div', { class: 'figure' }); card.appendChild(ui.figureEl); drawFigure(part); }
  card.appendChild(more);
  /* the text copy with highlights */
  more.appendChild(h('div', { class: 'ctxhead' }, 'Your words, as the readers saw them (hover or click a row below to see where its value came from):'));
  ui.ctxEl = h('div', { class: 'ctx' });
  more.appendChild(ui.ctxEl);
  /* reading state */
  for (si = 0; si < part.stages.length; si++) if (part.stages[si].boxes && part.stages[si].read && part.stages[si].read.done) hasReading = true;
  ui.readEl = h('div', { class: 'reading' });
  more.appendChild(ui.readEl);
  ui.bodyEl = h('div', { class: 'pbody' });
  more.appendChild(ui.bodyEl);
  drawCtx(part);
  if (!part.stages.length || !part.stages.every(function (s) { return s.read && s.read.done; })) {
    ui.readEl.appendChild(h('div', { class: 'readingmsg' }, 'Reading this part...'));
    ui.bodyEl.style.display = 'none';
  } else {
    ui.readEl.appendChild(h('div', { class: 'readby' }, readingBadge(part)));
    renderBody(part);
  }
  if (wasOpen) more.open = true;
  /* choose another form */
  var alt = h('details', { class: 'altform' }, h('summary', null, 'Use a different form'));
  alt.appendChild(h('div', { class: 'hint' }, 'Only if the "This form gives" line does not match your question. You then check every box yourself.'));
  alt.appendChild(formPicker(part, function (fn) { chooseForm(part, fn); }));
  card.appendChild(alt);
  var cl = calcLinkFor(part);
  if (cl) card.appendChild(h('div', { class: 'calclink' }, h('a', { href: cl, target: '_blank', rel: 'noopener' }, 'Open this form in the calculator'), h('span', { class: 'hint' }, '  (opens in a new tab; your question and its boxes stay here)')));
  renderResult(part);
  drawAi(part);
  if (part.Q) refreshFromParts(part.Q);
}

/* a "search for this one word" button of a definition question: puts the word in the query box (he still presses the look-up button) */
function searchWordButton(part, si, word, body) {
  return h('button', { type: 'button', class: 'small', onclick: function () {
    part.ui.vals[si].query = word; part.ui.vals[si]['_picked:query'] = true;
    var inp = body.querySelector('.ed textarea, .ed input'); if (inp) inp.value = word;
    refreshGate(part);
  } }, word);
}

function renderBody(part) {
  var ui = part.ui, body = ui.bodyEl, si, st, vals, refreshAll, btnLabel, tops;
  clear(body); body.style.display = '';
  if (!ui.vals) {
    ui.vals = {};
    for (si = 0; si < part.stages.length; si++) ui.vals[si] = SOLVE.initialValues(part.stages[si]);
  }
  refreshAll = function () { refreshGate(part); };
  for (si = 0; si < part.stages.length; si++) {
    st = part.stages[si];
    body.appendChild(h('div', { class: 'stagehead' }, stageTitle(part, si)));
    if (st.role === 'words') body.appendChild(h('div', { class: 'warnbox' }, 'This looks up the entry (a definition or a term of hers) whose NAME is in your question. If your question asks you to explain, compare or say why, the entry may only be related to it: read it, and write only what answers your question.'));
    if (st.form && st.form.description) body.appendChild(h('div', { class: 'hint' }, collapse(st.form.description).length > 230 ? collapse(st.form.description).slice(0, 228) + '..' : collapse(st.form.description)));
    renderStageBoxes(part, si, body, refreshAll);
    var ws = st.read && st.read.warnings ? st.read.warnings : [];
    ws.forEach(function (w) { if (!/figure or drawing/i.test(w) && !/Numbers in the text that no field used/i.test(w)) body.appendChild(h('div', { class: 'rnote' }, 'Rule reader: ' + w)); });
    if (st.read && st.read.droppedByRules && st.read.droppedByRules.length) body.appendChild(h('div', { class: 'rnote' }, 'Read in your text but this form has no box for it: ' + st.read.droppedByRules.join('; ')));
    if (part.kind === 'words') {
      var sw = SOLVE.searchWords(part.text), bar = h('div', { class: 'swbar' }, h('span', { class: 'hint' }, 'Or search for one word: '));
      sw.forEach(function (w) { bar.appendChild(searchWordButton(part, 0, w, body)); });
      body.appendChild(bar);
    }
  }
  ui.unusedEl = h('div', { class: 'unused' });
  body.appendChild(ui.unusedEl);
  drawUnused(part); drawCtx(part);
  if (part.figure) drawFigure(part);
  ui.gateEl = h('div', { class: 'gate' });
  body.appendChild(ui.gateEl);
  /* the page calculates by itself whenever a box changes; the button is only there for someone who wants to press something */
  btnLabel = part.kind === 'words' ? 'Look it up again' : 'Calculate again';
  ui.calcBtn = h('button', { type: 'button', class: 'go', onclick: function () { calculate(part); } }, btnLabel);
  body.appendChild(h('div', { class: 'gorow' }, ui.calcBtn, h('span', { class: 'hint' }, '   You do not have to press this: the answer above changes by itself when a box changes.')));
  refreshGate(part);
}

function chooseForm(part, fn) {
  var Q = part.Q;
  SOLVE.chooseForm(part, fn);
  part.ui.vals = null; part.ui.run = null; part.ui.wb = null; part.ui.notes = []; part.ui.ticks = { figure: false, unused: false, unusedChoices: {} };
  part.stages[0].read = null;
  safeRender(part);
  readStages(Q, part, 0, function () { /* drawn as each stage finishes */ });
}

/* a second card for the same words with another form ("Also solve this") */
function addAlso(part, fn) {
  var Q = part.Q, parts = Q.A.parts, idx = parts.indexOf(part), i, c, f = STEEL.list(), lab = fn;
  for (i = 0; i < parts.length; i++) if (parts[i].alsoOf === part.id && parts[i].forced === fn) { try { parts[i].ui.card.scrollIntoView({ block: 'start' }); } catch (e) { /* ignore */ } return; }
  for (i = 0; i < f.length; i++) if (f[i].name === fn) lab = f[i].label;
  c = SOLVE.cloneForForm(part, fn);
  c.label = 'also: ' + lab;
  newPartUi(c, Q, part.qn);
  parts.splice(idx + 1, 0, c);
  part.ui.card.parentNode.insertBefore(c.ui.card, part.ui.card.nextSibling);
  safeRender(c);
  readStages(Q, c, 0, function () { /* drawn as each stage finishes */ });
  drawQuestionBar(Q);
}

/* ------------------------------------------------------------------------------------------------ reading
   1. The page reads every part BY ITSELF, at once (the rule reader: no model, no waiting), and calculates whatever nothing is in the way of.
   2. The AI helper then reads the parts again, one at a time, in the background, for as long as it needs (10/06: on his laptop one part took more than ten
      minutes; the old page waited for it, gave up at ten minutes, and said the helper was "not running").  Its reading never changes an answer by itself:
      where it differs, the page asks. */
function readPartNow(part) {
  var si;
  if (part.kind === 'form' || part.kind === 'words') {
    for (si = 0; si < part.stages.length; si++) { if (part.kind === 'error') break; SOLVE.readStage(part, si, {}, function () { /* without a model this returns at once */ }); }
    part.ui.ticks = part.ui.ticks || { figure: false, unused: false, unusedChoices: {} };
  }
  safeRender(part);
}
/* one part read again (another form was chosen, or "Also solve this") */
function readStages(Q, part, si, done) {
  part.ui.sig = null; part.ui.check = null;
  readPartNow(part); autoCalc(part, true); enqueueCheck(part); drawQuestionBar(Q); pumpQueue();
  if (done) done();
}
function readAll(Q) {
  var i, parts = Q.A.parts;
  for (i = 0; i < parts.length; i++) readPartNow(parts[i]);
  for (i = 0; i < parts.length; i++) autoCalc(parts[i], true);       /* in order: a later part may take a number from an earlier one */
  for (i = 0; i < parts.length; i++) enqueueCheck(parts[i]);
  drawQuestionBar(Q); pumpQueue();
}

/* ---- a multiple-choice word question: each choice with her own wording for it, side by side, so he can match them to his question by reading */
function drawChoices(part, box) {
  var tab, wrap, best = null, top = 0, second = 0, i, n;
  if (part.kind !== 'words') return;
  tab = SOLVE.choiceTable(part.text);
  if (!tab) return;
  for (i = 0; i < tab.list.length; i++) { n = tab.list[i].shared.length; if (n > top) { second = top; top = n; best = tab.list[i]; } else if (n > second) second = n; }
  if (!(top >= 2 && top > second)) best = null;
  var mc = part.mc || null;
  if (mc && mc.best) best = null;
  wrap = h('div', { class: 'choices' }, h('div', { class: 'ch-head' }, mc && mc.best
    ? 'This is a multiple-choice question. The page circled ' + mc.best.ch + ' because ' + mc.why + '. Each choice is shown below with HER wording for it.'
    : 'This is a multiple-choice question. Her wording does not single out one choice, so the page prints NO letter. Below is each choice with HER wording for it: choose the one whose wording says what your question says and press "This one". If nothing decides it, circle any one on your paper: a blank scores nothing.'));
  tab.list.forEach(function (c) {
    wrap.appendChild(h('div', { class: 'ch-row' + (c === best || (mc && mc.best && mc.best.ch === c.ch) ? ' ch-best' : '') },
      h('b', null, c.ch + '. ' + c.text), '   ', h('button', { type: 'button', class: 'small sg', onclick: function () { applySuggestion(part, 0, c.text, {}); } }, 'This one'),
      mc && mc.best && mc.best.ch === c.ch ? h('span', { class: 'ch-tag' }, '  the page circled this one') : (c === best ? h('span', { class: 'ch-tag' }, '  shares the most words with your question (not a reason to circle it)') : null),
      h('div', { class: 'ch-entry' }, c.found ? c.entry : '(she has no entry with this name)'),
      c.shared.length ? h('div', { class: 'hint' }, 'shares these words with your question: ' + c.shared.join(', ')) : null));
  });
  box.appendChild(wrap);
}

/* ---- a box the page is waiting for (council 10/06, item 2): the question is about the BOX, in plain words; the choices are phrases of his own question */
function drawWanted(part, host) {
  var ui = part.ui, list, wrap;
  if (part.kind !== 'form' || !ui.vals) return;
  try { list = SOLVE.wantedBoxes(part, ui.vals, ui.run && !ui.run.ok ? ui.run : null); } catch (e) { list = []; }
  if (!list.length) return;
  wrap = h('div', { class: 'wanted' }, h('div', { class: 'wantedhead' }, list.length === 1 ? 'The page needs one thing from you:' : 'The page needs ' + list.length + ' things from you:'));
  list.forEach(function (w) {
    var blk = h('div', { class: 'wbox' }), inp, msg = h('div', { class: 'uqmsg' }), unit = w.unit ? ' ' + w.unit : '';
    function put(v) {
      var rowEl = ui.rows[w.si] && ui.rows[w.si][w.path];
      if (rowEl && rowEl.setUi) { openAncestors(part, rowEl); rowEl.setUi(String(v)); }
      else if (ui.vals[w.si]) ui.vals[w.si][w.path] = String(v);
      refreshGate(part);
    }
    function typed() { var v = trim(inp.value); if (v === '') { msg.textContent = 'Type the number first.'; msg.className = 'uqmsg open'; return; } put(v); }
    blk.appendChild(h('div', { class: 'wlabel' }, h('b', null, w.label + (w.unit && w.label.indexOf('(' + w.unit + ')') < 0 ? ' (' + w.unit + ')' : '')), w.hint ? h('div', { class: 'whint' }, w.hint) : null));
    if (w.cands.length) {
      blk.appendChild(h('div', { class: 'hint' }, 'From your question (click the one whose words say it):'));
      w.cands.forEach(function (c) {
        blk.appendChild(h('button', { type: 'button', class: 'opt wcand', onclick: function () { put(c.value); } }, h('b', null, c.value + unit), '   --   your words: "' + c.phrase + '"'));
      });
    }
    inp = h('input', { type: 'text', class: 'wtype', size: '8' });
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); typed(); } });
    blk.appendChild(h('div', { class: 'wtyperow' }, w.cands.length ? 'Or it is only in the drawing: type it ' : 'Type it (look at the drawing if your question has one): ', inp, unit + '  ',
      h('button', { type: 'button', class: 'small sg', onclick: typed }, 'Use this number'), '   ',
      h('button', { type: 'button', class: 'small', onclick: function () { msg.textContent = 'Then this part cannot be worked out. Copy the parts that did work, and move on to the next question.'; msg.className = 'uqmsg open'; } }, 'My question does not say it')));
    blk.appendChild(msg);
    wrap.appendChild(blk);
  });
  host.appendChild(wrap);
}

/* ---- the answer area when there is no answer: what is in the way (the boxes themselves may be folded) */
function drawNeeds(part, box) {
  var ui = part.ui, gate = ui.gateList || [], nb, ul, g;
  if ((part.kind !== 'form' && part.kind !== 'words') || !ui.vals || !gate.length) return;
  nb = h('div', { class: 'needs' }, h('div', { class: 'needshead' }, 'No answer yet: this part needs you.'));
  ul = h('ul');
  for (g = 0; g < gate.length; g++) ul.appendChild(h('li', null, gate[g].text));
  nb.appendChild(ul);
  nb.appendChild(h('div', { class: 'hint' }, 'The boxes and the questions are open just below. As soon as nothing is missing, the answer appears here by itself.' + (aiPending(part) ? ' The AI helper has not finished reading this part and may still find what is missing.' : '')));
  box.appendChild(nb);
  try { drawWanted(part, box); } catch (eW) { /* an extra: the boxes below still work */ }
}

/* ---- "check these words": one line per value that went into the calculator, with the words it came from */
function checkRows(part) {
  var rows = [], ui = part.ui, si, st, i, b, v, vals, from, words, who;
  for (si = 0; si < part.stages.length; si++) {
    st = part.stages[si]; vals = (ui.vals && ui.vals[si]) || {};
    if (!st.boxes || st.role === 'words') continue;
    for (i = 0; i < st.boxes.length; i++) {
      b = st.boxes[i]; v = vals[b.path];
      if (b.state === 'carried' || SOLVE.isEmptyUi(b, v)) continue;
      from = vals['_from:' + b.path];
      if (from !== undefined) { who = 'part (' + from + ')'; words = 'taken from part (' + from + ') of this question'; }
      else if (vals['_ai:' + b.path] !== undefined) { who = 'AI helper'; words = '"' + vals['_ai:' + b.path] + '"'; }
      else if (b.proposal !== undefined && SOLVE.sameUi(b, v, b.proposal)) { who = b.state === 'agree' ? 'both readers' : (b.state === 'model' ? 'AI helper' : 'page'); words = b.words && b.words.length ? '"' + b.words[0].text + '"' : ''; }
      else { who = 'you'; words = 'typed or chosen by you'; }
      rows.push({ si: si, path: b.path, label: (part.stages.length > 1 ? 'Step ' + (si + 1) + ': ' : '') + b.label, value: SOLVE.showValue(b, v), words: words, who: who });
    }
  }
  return rows;
}
function aiWord(mark) {
  if (mark === 'same') return 'AI helper: same';
  if (mark === 'differs') return 'AI helper: DIFFERENT (see above)';
  if (mark === 'used') return 'AI helper\'s value, chosen by you';
  if (mark === 'kept') return 'AI helper differed; you kept this';
  if (mark === 'filled') return 'found by the AI helper';
  return 'AI helper: did not read it';
}
function drawCheckTable(part, box) {
  var rows = checkRows(part), c = part.ui.check, showAi = !!(c && (c.state === 'agree' || c.state === 'differs' || c.state === 'filled' || c.state === 'resolved')), wrap, t, i, r;
  if (!rows.length) return;
  wrap = h('div', { class: 'chk2' }, h('div', { class: 'chk2head' }, 'Check ' + (rows.length > 1 ? 'these ' + rows.length + ' values' : 'this value') + ' against your question: do the words say what the label says?'));
  t = h('table', { class: 'chk2t' });
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    t.appendChild(h('tr', { class: r.who === 'you' ? 'c-you' : null }, h('td', { class: 'c-l' }, r.label), h('td', { class: 'c-v' }, r.value), h('td', { class: 'c-w' }, r.words), h('td', { class: 'c-a' }, showAi ? aiWord(c.by[r.si + ':' + r.path]) : '')));
  }
  wrap.appendChild(t);
  wrap.appendChild(h('div', { class: 'hint' }, 'Something wrong or missing? Open "Change a value" below and fix the box: the answer changes by itself.'));
  /* numbers of his text that went into no box and are not loads: said plainly, without holding the answer back */
  var loose = [], uc = (part.ui.ticks && part.ui.ticks.unusedChoices) || {};
  try { loose = SOLVE.unusedQuestions(part).filter(function (q) { return !q.blocking && !uc[q.text]; }); } catch (eL) { loose = []; }
  if (loose.length) wrap.appendChild(h('div', { class: 'loose' }, h('b', null, 'Not used: '), loose.map(function (q) { return '"' + q.text + '"'; }).join(', ') + '. '
    + (loose.length > 1 ? 'These numbers of your question went' : 'This number of your question went') + ' into no box. That is normal for a number the form does not need (a bolt spacing, an edge distance, a number said twice). If one matters for this part, open "Change a value" below: it has buttons there to put it in a box.'
    + (loose.some(function (q) { return q.holesNote; }) ? '  CHECK THE HOLES: a count of holes or bolts is in that list. Look at the hole boxes in the check list above: if they do not hold every hole your question gives, the net area is wrong.' : '')));
  box.appendChild(wrap);
}

/* ---- the AI helper as a second reader, in the background */
function aiPending(part) { var c = part.ui && part.ui.check; return !!(c && (c.state === 'waiting' || c.state === 'reading') && (APP.model.cls === 'big' || APP.model.cls === 'small') && aiOn()); }
/* Which of the helper's differences hold the answer back?  Only a value that DIFFERS from one the page read.  A value for a box the page left EMPTY never does:
   the small model is wrong about such boxes more often than right (measured 10/06: about 1 in 3 right), and the big one talked the mock's floor plan into a
   double-counted beam weight.  Those are shown as suggestions he may take, and the page's own answer stands. */
function isBlocking(c, d) { return d.kind === 'differs'; }
function aiOpen(part) {
  var c = part.ui && part.ui.check, n = 0, i;
  if (!c || c.state !== 'differs') return 0;
  for (i = 0; i < c.diffs.length; i++) if (isBlocking(c, c.diffs[i])) n++;
  return n;
}
function partName(part) { return 'Question ' + part.qn + (part.label ? ' (' + part.label + ')' : ''); }
function eachPart(fn) {
  var i, j, Q;
  for (i = 0; i < APP.questions.length; i++) { Q = APP.questions[i]; for (j = 0; j < Q.A.parts.length; j++) if (Q.A.parts[j].ui && !Q.removed) fn(Q.A.parts[j], Q); }
}
function redrawAllAi() { eachPart(function (p) { drawAi(p); }); drawCheckSummary(); }
function wantsCheck(part) { return part.kind === 'form' && part.stages && part.stages.length > 0 && !!root.LLMREADER; }
function enqueueCheck(part) {
  var i;
  if (!part.ui || !wantsCheck(part)) return;
  for (i = APP.queue.length - 1; i >= 0; i--) if (APP.queue[i] === part) APP.queue.splice(i, 1);
  part.ui.check = { state: 'waiting' };
  APP.queue.push(part);
  drawAi(part);
}
function shadowOf(part) {
  var s = {}, k, i;
  for (k in part) if (has(part, k) && k !== 'ui' && k !== 'Q' && k !== 'stages') s[k] = part[k];
  s.stages = [];
  for (i = 0; i < part.stages.length; i++) s.stages.push({ role: part.stages[i].role, fn: part.stages[i].fn });
  return s;
}
function pumpQueue() {
  var part, deps;
  drawCheckSummary();
  if (APP.busy || APP.warming || !aiOn()) return;
  deps = modelDeps();
  if (!deps.callModel) return;                                   /* no helper: the parts stay "read by the page alone" */
  for (;;) {
    part = APP.queue.shift();
    if (!part) { drawCheckSummary(); return; }
    if (!part.ui || (part.Q && part.Q.removed) || !wantsCheck(part)) continue;
    /* "only the parts the page could not answer": a part that has its answer is passed over (he can ask for it with the button in that part) */
    if (APP.checkMode === 'stuck' && answeredByPage(part) && !part.ui.forceCheck) { part.ui.check = { state: 'skipped' }; drawAi(part); continue; }
    break;
  }
  runCheck(part, deps);
}
function runCheck(part, deps) {
  var shadow = shadowOf(part), si = 0, t0 = new Date().getTime(), c = { state: 'reading', t0: t0 }, fns = part.stages.map(function (s) { return s.fn; }).join('>');
  APP.busy = part; part.ui.check = c; drawAi(part); drawCheckSummary();
  function finish() {
    var out, stale = part.ui.check !== c || part.stages.map(function (s) { return s.fn; }).join('>') !== fns;
    APP.busy = null;
    if (stale) { pumpQueue(); return; }                          /* another form was chosen meanwhile: that reading is queued on its own */
    try { out = compareShadow(part, shadow); } catch (e) { out = { state: 'failed', diffs: [], by: {}, same: 0, error: SOLVE.plainError(e) }; }
    if (c.stopped && out.state === 'failed') out.state = 'stopped';
    out.seconds = Math.round((new Date().getTime() - t0) / 1000);
    out.cls = APP.model.cls;
    part.ui.check = out;
    try { applyCheck(part); } catch (e2) { showFatal('showing the AI helper\'s reading failed: ' + SOLVE.plainError(e2)); }
    /* an answer that failed: is the helper still there?  (a slow or a stopped answer is not "not running") */
    if (out.state === 'failed') findModel(true); else pumpQueue();
  }
  function next() {
    if (si >= shadow.stages.length || shadow.kind === 'error') { finish(); return; }
    SOLVE.readStage(shadow, si, deps, function () { si++; next(); });
  }
  next();
}
/* what the helper's reading (merged with the page's own, as before) says, against the values that are in the boxes now */
function compareShadow(part, shadow) {
  var out = { state: 'agree', diffs: [], by: {}, same: 0, error: null }, used = false, err = null, si, st, ss, i, j, b, sb, v, mv, mw, vals, key, dflt, from, cur;
  if (shadow.kind === 'error') return { state: 'failed', diffs: [], by: {}, same: 0, error: shadow.errorText || 'the part could not be read' };
  for (si = 0; si < part.stages.length; si++) {
    st = part.stages[si]; ss = shadow.stages[si]; vals = (part.ui.vals && part.ui.vals[si]) || {};
    if (!ss || !ss.read || !ss.boxes || !st.boxes) continue;
    if (ss.read.llmError) err = ss.read.llmError;
    if (ss.read.llmUsed) used = true;
    for (i = 0; i < st.boxes.length; i++) {
      b = st.boxes[i]; sb = null;
      for (j = 0; j < ss.boxes.length; j++) if (ss.boxes[j].path === b.path) sb = ss.boxes[j];
      if (!sb || b.state === 'carried' || sb.state === 'carried') continue;
      mv = undefined; mw = '';
      if (sb.state === 'agree' || sb.state === 'model') { mv = sb.proposal; for (j = 0; j < sb.words.length; j++) if (sb.words[j].src === 'model') mw = sb.words[j].text; }
      else if (sb.state === 'conflict') { for (j = 0; j < sb.alts.length; j++) if (sb.alts[j].src === 'model') { mv = sb.alts[j].ui; mw = sb.alts[j].words; } }
      if (mv === undefined || SOLVE.isEmptyUi(b, mv)) continue;                      /* the helper gave nothing for this box */
      key = si + ':' + b.path; v = vals[b.path];
      if (!SOLVE.isEmptyUi(b, v)) {
        if (SOLVE.sameUi(b, v, mv)) { out.same++; out.by[key] = 'same'; continue; }
        from = vals['_from:' + b.path];
        cur = from !== undefined ? 'taken from part (' + from + ')' : (b.proposal !== undefined && SOLVE.sameUi(b, v, b.proposal) && b.words && b.words.length ? '"' + b.words[0].text + '"' : 'typed or chosen by you');
        out.by[key] = 'differs';
        out.diffs.push({ kind: 'differs', si: si, path: b.path, label: b.label, mine: v, mineShow: SOLVE.showValue(b, v), mineWords: cur, model: mv, modelShow: SOLVE.showValue(b, mv), words: mw });
      } else {
        /* the box is empty.  Not worth a question: a value equal to the calculator's usual one, and "no" for a yes/no box (empty means no) */
        dflt = b.defaultValue;
        if (dflt !== undefined && dflt !== null && dflt !== '' && SOLVE.sameUi(b, dflt, mv)) { out.by[key] = 'same'; continue; }
        if (b.kind === 'bool' && SOLVE.sameUi(b, 'no', mv)) { out.by[key] = 'same'; continue; }
        out.by[key] = 'differs';
        out.diffs.push({ kind: 'extra', si: si, path: b.path, label: b.label, mine: '', mineShow: '(empty)', mineWords: 'the page found nothing for this box', model: mv, modelShow: SOLVE.showValue(b, mv), words: mw });
      }
    }
  }
  if (!used) { out.state = 'failed'; out.error = err || 'it gave no reading'; out.diffs = []; return out; }
  out.state = out.diffs.length ? 'differs' : 'agree';
  return out;
}
function applyCheck(part) {
  var ui = part.ui, c = ui.check, rest = [], i, d, n = 0;
  if (c.state === 'differs' && !(ui.run && ui.run.ok)) {
    /* this part has no answer yet: a value the helper found for an EMPTY box is put in (it is shown in the check list, marked, with its words).
       A value that DIFFERS from one already in a box always stays a question. */
    for (i = 0; i < c.diffs.length; i++) {
      d = c.diffs[i];
      /* with the small model only a box the part is WAITING for (a required one) is filled; its other guesses stay suggestions */
      /* "waiting for": a required box, a box the calculator named when it refused, or a LOAD (a part stuck on "which box does 100 k belong in?") */
      var lb = findBox(part, d.si, d.path), nm = String(d.path).replace(/^analysis\./, ''),
        wanted = !!(lb && (lb.required || lb.reqGroup || (ui.engineMissing && ui.engineMissing[d.path]) || /^(?:D|L|Pu|wD|wL|w_u|Mu|point_loads)$/.test(nm)));
      if (d.kind === 'extra' && wanted) { ui.vals[d.si][d.path] = d.model; ui.vals[d.si]['_ai:' + d.path] = d.words; c.by[d.si + ':' + d.path] = 'filled'; n++; }
      else rest.push(d);
    }
    c.diffs = rest; c.filled = n;
    if (!rest.length) c.state = 'filled';
    if (n) { ui.noAuto = true; try { renderBody(part); } finally { ui.noAuto = false; } }
  }
  drawAi(part);
  ui.sig = null;
  autoCalc(part, true);
  if (!ui.run) renderResult(part);
  drawQuestionBar(part.Q);
  drawCheckSummary();
}
function settleDiff(part, d, useModel) {
  var ui = part.ui, c = ui.check, i = c ? c.diffs.indexOf(d) : -1, key = d.si + ':' + d.path, v;
  if (i < 0) return;
  c.diffs.splice(i, 1);
  if (useModel) {
    v = ui.vals[d.si];
    v[d.path] = d.model; v['_picked:' + d.path] = true; v['_ai:' + d.path] = d.words; delete v['_from:' + d.path]; delete v['_fromval:' + d.path];
    c.by[key] = 'used';
  } else c.by[key] = 'kept';
  if (!c.diffs.length) c.state = 'resolved';
  ui.noAuto = true; try { renderBody(part); } finally { ui.noAuto = false; }
  drawAi(part);
  ui.sig = null;
  autoCalc(part, true);
  if (!ui.run) renderResult(part);
  drawQuestionBar(part.Q);
  drawCheckSummary();
}
function drawAi(part) {
  var ui = part.ui, el = ui && ui.aiEl, c = ui && ui.check, running = APP.model.cls === 'big' || APP.model.cls === 'small', blk, took;
  if (!el) return;
  clear(el); el.className = 'ai';
  if (part.kind !== 'form' || !c) return;
  took = c.seconds !== undefined ? ' (it took ' + mmss(c.seconds) + ')' : '';
  if (c.state === 'waiting') {
    if (!running) el.appendChild(h('div', { class: 'ai-line' }, 'Read by the page alone (the AI helper is not running).'));
    else if (!aiOn()) el.appendChild(h('div', { class: 'ai-line' }, 'Read by the page alone (the AI helper is switched off at the top of the page).'));
    else el.appendChild(h('div', { class: 'ai-line' }, 'AI helper: has not read this part yet (it reads one part at a time). You do not have to wait for it.'));
  } else if (c.state === 'skipped') {
    el.appendChild(h('div', { class: 'ai-line' }, 'Read by the page alone. The AI helper is set to read only the parts the page could not answer.  ',
      running && aiOn() ? h('button', { type: 'button', class: 'small', onclick: function () { part.ui.forceCheck = true; enqueueCheck(part); pumpQueue(); } }, 'Let it read this part too') : null));
  } else if (c.state === 'reading') {
    el.appendChild(h('div', { class: 'ai-line ai-busy' }, 'AI helper is reading this part: ', h('span', { class: 'aiclock', 'data-t0': String(c.t0) }, '0:00'), ' so far. You do not have to wait: what is below comes from the page itself.  ',
      h('button', { type: 'button', class: 'small', onclick: function () { c.stopped = true; if (APP.caller) APP.caller.abort(); } }, 'Stop it for this part')));
  } else if (c.state === 'agree') {
    el.appendChild(h('div', { class: 'ai-line ai-ok' }, 'AI helper read this part too' + took + ': ' + (c.same ? 'it agrees with ' + (c.same === 1 ? 'the value' : 'the ' + c.same + ' values') + ' it also found.' : 'it found nothing different.')));
  } else if (c.state === 'filled') {
    el.appendChild(h('div', { class: 'ai-line ai-warn' }, 'AI helper read this part too' + took + ' and found ' + c.filled + ' value' + (c.filled > 1 ? 's' : '') + ' the page had missed. ' + (c.filled > 1 ? 'They are' : 'It is') + ' in the check list below, marked "found by the AI helper": read ' + (c.filled > 1 ? 'their' : 'its') + ' words.'));
  } else if (c.state === 'resolved') {
    el.appendChild(h('div', { class: 'ai-line ai-ok' }, 'AI helper read this part too' + took + '. You decided what it read differently.'));
  } else if (c.state === 'stopped') {
    el.appendChild(h('div', { class: 'ai-line' }, 'You stopped the AI helper for this part. What is below comes from the page itself.  ', h('button', { type: 'button', class: 'small', onclick: function () { enqueueCheck(part); pumpQueue(); } }, 'Let it read this part after all')));
  } else if (c.state === 'failed') {
    el.appendChild(h('div', { class: 'ai-line ai-warn' }, 'AI helper did not answer for this part (' + (c.error || 'no reason given') + '). What is below comes from the page itself.  ', h('button', { type: 'button', class: 'small', onclick: function () { enqueueCheck(part); pumpQueue(); } }, 'Try again')));
  } else if (c.state === 'differs') {
    var hard = c.diffs.filter(function (d) { return isBlocking(c, d); }), soft = c.diffs.filter(function (d) { return !isBlocking(c, d); }), sg;
    function row(d) {
      /* "Keep" comes first: it is the safe choice when he cannot tell */
      return h('div', { class: 'ai-d' }, h('div', { class: 'ai-dl' }, d.label),
        h('div', null, 'The page:  ', h('b', null, d.mineShow), '   ', h('span', { class: 'hint' }, d.mineWords)),
        h('div', null, 'AI helper:  ', h('b', null, d.modelShow), '   ', h('span', { class: 'hint' }, 'its words: "' + d.words + '"')),
        h('div', { class: 'ai-db' }, h('button', { type: 'button', class: 'small sg', onclick: function () { settleDiff(part, d, false); } }, d.kind === 'extra' ? 'Leave the box empty (keep the page\'s reading)' : 'Keep the page\'s value'), ' ',
          h('button', { type: 'button', class: 'small', onclick: function () { settleDiff(part, d, true); } }, 'Use the AI helper\'s value')));
    }
    if (hard.length) {
      blk = h('div', { class: 'ai-diff' }, h('div', { class: 'ai-diffhead' }, 'The AI helper read ' + hard.length + ' value' + (hard.length > 1 ? 's' : '') + ' differently' + took + '. Decide ' + (hard.length > 1 ? 'each one' : 'it') + ' before you write this part down.'),
        h('div', { class: 'hint' }, 'Look at the words each one points at. Take the value whose words say what the label says. The AI helper is often wrong: if you cannot tell, keep the page\'s value.'));
      hard.forEach(function (d) { blk.appendChild(row(d)); });
      el.appendChild(blk);
    } else el.appendChild(h('div', { class: 'ai-line ai-ok' }, 'AI helper read this part too' + took + ': ' + (c.same ? 'it agrees with ' + (c.same === 1 ? 'the value' : 'the ' + c.same + ' values') + ' it also found.' : 'it disagrees with no value the page read.')));
    if (soft.length) {
      sg = h('details', { class: 'ai-soft' }, h('summary', null, 'The AI helper ALSO suggests ' + soft.length + ' value' + (soft.length > 1 ? 's' : '') + ' for boxes the page left empty (it is wrong about these more often than right; open to look)'),
        h('div', { class: 'hint' }, 'The answer below does NOT use these. Take one only if ITS WORDS plainly say what the box label says and the box matters for your question.'));
      soft.forEach(function (d) { sg.appendChild(row(d)); });
      el.appendChild(sg);
    }
  }
}
/* one line at the top of the page: how far the helper is, and where it disagrees (he may be three questions further by then) */
function drawCheckSummary() {
  var el = $('aisum'), total = 0, done = 0, waiting = 0, open = [], reading = null, running = APP.model.cls === 'big' || APP.model.cls === 'small', f = $('aifacts');
  if (f) f.textContent = helperFacts();
  if (!el) return;
  clear(el);
  eachPart(function (p) {
    var c = p.ui.check;
    if (!c) return;
    total++;
    if (c.state === 'skipped') { total--; return; }
    if (c.state === 'reading') reading = p; else if (c.state === 'waiting') waiting++; else done++;
    if (aiOpen(p)) open.push(p);
  });
  if (!running) return;
  if (!total) { if (APP.checkMode === 'stuck' && APP.questions.length) el.appendChild(h('span', null, 'The page answered every part so far by itself, so the AI helper has had nothing to read.')); return; }
  el.appendChild(h('span', null, 'It has read ' + done + ' of ' + total + ' part' + (total > 1 ? 's' : '') + ' it was given.  '));
  if (reading) el.appendChild(h('span', null, 'Now reading ' + partName(reading) + ': ', h('span', { class: 'aiclock', 'data-t0': String(reading.ui.check.t0) }, '0:00'), '.  '));
  else if (waiting && !aiOn()) el.appendChild(h('span', null, waiting + ' waiting (it is switched off).  '));
  open.forEach(function (p) {
    el.appendChild(h('button', { type: 'button', class: 'small warnbtn', onclick: function () { try { p.ui.card.scrollIntoView({ block: 'start' }); } catch (e) { /* ignore */ } } }, 'It disagrees in ' + partName(p) + ': show me'));
  });
}

/* ------------------------------------------------------------------------------------------------ a whole question */
/* the shapes the earlier parts of a question have chosen (selected_shape of a select form, the beam of a floor plan) */
function chosenShapes(Q, beforePart) {
  var out = [], i, p, run, res, v, k, keys = ['selected_shape', 'step2_beam_shape', 'step3_girder_shape', 'step4_selected_shape'];
  for (i = 0; i < Q.A.parts.length; i++) {
    p = Q.A.parts[i];
    if (p === beforePart) break;
    run = p.ui && p.ui.run;
    if (!run || !run.ok || !run.stages.length) continue;
    res = run.stages[run.stages.length - 1].res;
    for (k = 0; k < keys.length; k++) { v = res && res.values && res.values[keys[k]]; if (v && typeof v.value === 'string' && v.value) out.push({ label: p.label, shape: v.value }); }
  }
  return out;
}
function refreshFromParts(Q) {
  var i, j, p, list;
  for (i = 0; i < Q.A.parts.length; i++) {
    p = Q.A.parts[i];
    if (!p.ui || !p.ui.fromEls) continue;
    list = chosenShapes(Q, p);
    for (j = 0; j < p.ui.fromEls.length; j++) {
      (function (holder) {
        clear(holder.el);
        list.forEach(function (c) { holder.el.appendChild(h('div', { class: 'fromline' }, 'Part ' + (c.label || '') + ' chose ', h('b', null, c.shape), '  ', h('button', { type: 'button', class: 'small sg', onclick: function (ev) { ev.stopPropagation(); holder.setValue(c.shape); } }, 'Use ' + c.shape + ' here'))); });
      })(p.ui.fromEls[j]);
    }
  }
}
function answered(p) { return !!(p.ui && p.ui.wb && p.ui.run && p.ui.run.ok) && !aiOpen(p); }
function drawQuestionBar(Q) {
  var bar = Q && Q.barEl, n = 0, i, parts, need = [];
  if (!bar) return;
  parts = Q.A.parts;
  refreshFromParts(Q);
  clear(bar);
  for (i = 0; i < parts.length; i++) { if (answered(parts[i])) n++; else need.push(parts[i].label ? '(' + parts[i].label + ')' : 'part ' + (i + 1)); }
  bar.className = 'qbar' + (need.length ? ' qbar-need' : ' qbar-ok');
  bar.appendChild(h('span', { class: 'qinfo' }, parts.length + ' part' + (parts.length > 1 ? 's' : '') + ': ' + n + ' answered' + (need.length ? ', ' + need.length + ' need' + (need.length > 1 ? '' : 's') + ' you: ' + need.join(' ') : '') + '.  '));
  bar.appendChild(h('button', { type: 'button', class: 'go2', onclick: function (ev) { copyText(allText(Q), ev.target); } }, 'Copy all'));
  bar.appendChild(h('span', { class: 'hint' }, '  (all the WRITE THIS blocks of this question, in order)'));
  /* THE ANSWERS, at the top.  (Zack, 10/06 19:40: a question solved in full, four right answers at the bottom of four long blocks, and he could not tell
     whether the page had solved it.)  One line per blank, each one a line of the WRITE THIS block below, word for word. */
  try {
    var box = h('div', { class: 'qanswers' }), groups = {}, order = [], lab, bl, j, key, row;
    box.appendChild(h('div', { class: 'qanshead' }, 'THE ANSWERS: one line for each blank. The working to copy is in the blocks below.'));
    for (i = 0; i < parts.length; i++) {
      lab = parts[i].label ? '(' + parts[i].label + ')' : (parts.length > 1 ? 'part ' + (i + 1) : '');
      if (!answered(parts[i])) {
        box.appendChild(h('div', { class: 'qansrow qansnone' }, h('b', null, lab + ' '), 'NO ANSWER YET: ' + noAnswerWhy(parts[i])));
        continue;
      }
      bl = SOLVE.blankLines(parts[i].ui.wb.writeLines);
      if (!bl.length) box.appendChild(h('div', { class: 'qansrow' }, h('b', null, lab + ' '), 'answered in words: read the lines under WRITE THIS ' + lab));
      for (j = 0; j < bl.length; j++) {
        if (bl[j].kind === 'blank') row = h('div', { class: 'qansrow' }, h('b', null, lab + ' '), h('span', { class: 'qansblank' }, bl[j].blank), '  ->  ', h('b', { class: 'qansval' }, bl[j].text));
        /* the part's ONE blank, answered by the block's own ANSWER line: the blank is shown in front of it, as his paper prints it */
        else if (bl[j].kind === 'answer' && (parts[i].asked || []).length === 1 && (parts[i].blankCount || 1) === 1 && !bl.some(function (x) { return x.kind === 'blank'; }))
          row = h('div', { class: 'qansrow' }, h('b', null, lab + ' '), h('span', { class: 'qansblank' }, parts[i].asked[0].raw), '  ->  ', h('b', { class: 'qansval' }, bl[j].text));
        else if (bl[j].kind === 'answer') row = h('div', { class: 'qansrow' }, h('b', null, lab + ' '), h('b', { class: 'qansval' }, bl[j].text));
        else row = h('div', { class: 'qansrow qanswarn' }, h('b', null, lab + ' '), bl[j].text);
        box.appendChild(row);
      }
      key = SOLVE.workingKey(parts[i].ui.wb.writeLines);
      if (key && lab) { if (!groups[key]) { groups[key] = []; order.push(key); } groups[key].push(lab); }
    }
    for (i = 0; i < order.length; i++) if (groups[order[i]].length > 1)
      box.appendChild(h('div', { class: 'qanssame' }, 'Parts ' + groups[order[i]].join(', ') + ' print the SAME numbered working: write it once, then only the answer line of each part.'));
    bar.appendChild(box);
  } catch (eBox) {
    /* the list is a convenience and the blocks below stand without it -- but its absence must be said, not silent */
    try { bar.appendChild(h('div', { class: 'qanssame' }, 'The list of answers could not be drawn here. Nothing is lost: every part\'s answer is the ANSWER line at the end of its WRITE THIS block below.')); } catch (eBox2) { /* nothing more to do */ }
  }
}
function noAnswerWhy(p) {
  return p.kind === 'not_in_tool' ? 'the calculator cannot do this part' : (p.kind === 'nomatch' ? 'no form matched' : (p.kind === 'error' ? 'this part could not be read' : (aiOpen(p) ? 'the AI helper read a value differently; decide it on the page first' : 'this part needs you first (see the page)')));
}
function allText(Q) {
  var out = [], i, p;
  for (i = 0; i < Q.A.parts.length; i++) {
    p = Q.A.parts[i];
    if (answered(p)) out.push(p.ui.wb.write);
    else out.push('(' + (p.label || 'question') + ') NO ANSWER WRITTEN: ' + noAnswerWhy(p));
  }
  return out.join('\n\n');
}

function newPartUi(part, Q, qn) {
  part.Q = Q; part.qid = Q.id; part.qn = qn;
  part.ui = { card: h('div', { class: 'part' }), vals: null, ticks: { figure: false, unused: false, unusedChoices: {} }, hl: [], pinned: [], run: null, wb: null, notes: [], rows: {} };
}

/* what the page understood from the cover-page assumptions he typed: shown under the box, so that a list it cannot read is not silently ignored */
function coverUnderstood(text) {
  var out = [], r, i, d, R = root.READER;
  if (!trim(text) || !R || typeof R.read !== 'function') return out;
  try { r = R.read('Exam defaults (cover page): unless noted otherwise, assume: ' + collapse(text) + '\nA W12x65 column is 14 ft long.', {}); } catch (e) { return out; }
  for (i = 0; i < ((r && r.defaults) || []).length; i++) {
    d = r.defaults[i];
    if (d.name === 'loads_basis') out.push('the loads given are service loads (the page factors them)');
    else if (d.name === 'Fy') out.push('Fy = ' + d.value + ' ksi');
    else if (d.name === 'end_condition') out.push('pinned supports');
    else if (d.name === 'K') out.push('K = ' + d.value + ' for columns');
    else if (d.name === 'U') out.push('shear lag factor U = ' + d.value + ' (Table D3.1 is used only when a question speaks of shear lag or of U)');
    else if (d.name === 'concrete_pcf') out.push('concrete ' + d.value + ' lb/ft3');
    else if (d.name === 'full_lateral_bracing') out.push('beams fully braced');
  }
  return out;
}
function drawCoverNote() {
  var el = $('defsnote'), sum = $('defssum'), text = $('defaults') ? $('defaults').value : '', got;
  if (!el) return;
  clear(el);
  if (trim(text) === '') {
    el.appendChild(doc.createTextNode('Nothing typed yet. Without the cover page the page asks you for the end conditions of every column, and it takes U from Table D3.1.'));
    if (sum) sum.textContent = 'FIRST, ONCE: the assumptions printed on the cover page of your exam';
    return;
  }
  got = coverUnderstood(text);
  if (got.length) {
    el.appendChild(h('b', null, 'The page understood ' + got.length + ' assumption' + (got.length > 1 ? 's' : '') + ': '));
    el.appendChild(doc.createTextNode(got.join('; ') + '.  Anything else in your list is not used; a value written in a question always wins over this list.'));
    if (sum) sum.textContent = 'Cover page in use (' + got.length + ' assumption' + (got.length > 1 ? 's' : '') + ' understood). Open to see or change it.';
  } else {
    el.appendChild(h('b', { class: 'bad' }, 'The page understood NOTHING from this text. '));
    el.appendChild(doc.createTextNode('Type the list the way the cover page prints it, for example: all loads given are service (unfactored); Fy = 50 ksi; pinned support conditions; K = 1.0 for all columns; connection shear lag factor U = 1.0'));
    if (sum) sum.textContent = 'Cover page: typed, but NOT understood. Open and check it.';
  }
}

/* AN ANSWER MUST NEVER OUTLIVE ITS QUESTION.  He corrects a digit in the box and forgets to press Solve: the answers on the screen are then the answers
   of the text as it WAS.  The newest question says so until Solve is pressed (an empty box, after Clear, says nothing). */
function markStale() {
  var Q = APP.Q, now = $('q').value, stale = !!(Q && Q.el && typeof APP.solvedText === 'string' && /\S/.test(now) && now !== APP.solvedText);
  if (!Q || !Q.el) return;
  /* (the councils of 10/06 night, three labs of four: a note is not enough -- a number that is still on the screen gets copied.  While the text differs from
     the solved text the answers are HIDDEN, not deleted: put the text back as it was, or press Solve, and they are there again.) */
  if (stale && !Q.staleEl) {
    Q.staleEl = h('div', { class: 'stalenote' }, h('b', null, 'THE TEXT IN THE BOX HAS CHANGED. '), 'The answers of this question are hidden, because they belong to the text as it was when you pressed Solve. Press Solve again to answer the text as it is now.');
    Q.el.insertBefore(Q.staleEl, Q.el.firstChild);
    Q.el.className = String(Q.el.className || '').replace(/\s*\bisstale\b/g, '') + ' isstale';
  } else if (!stale && Q.staleEl) {
    if (Q.staleEl.parentNode) Q.staleEl.parentNode.removeChild(Q.staleEl);
    Q.staleEl = null;
    Q.el.className = String(Q.el.className || '').replace(/\s*\bisstale\b/g, '');
  }
}
function onSolve() {
  var text = $('q').value, defaults = $('defaults').value, Q, A, i, out = $('out'), qn;
  if (!/\S/.test(text)) { $('status').textContent = 'Type the question first.'; return; }
  if (APP.Q && APP.Q.staleEl) { if (APP.Q.staleEl.parentNode) APP.Q.staleEl.parentNode.removeChild(APP.Q.staleEl); APP.Q.staleEl = null; }
  /* an older question whose text was replaced stays hidden-stale no longer: it is the answer of ITS text, shown above it */
  if (APP.Q && APP.Q.el) APP.Q.el.className = String(APP.Q.el.className || '').replace(/\s*\bisstale\b/g, '');
  APP.solvedText = text;
  lsSet('steelsolve.text', text); lsSet('steelsolve.defaults', defaults);
  APP.qid++;
  qn = (APP.qcount = (APP.qcount || 0) + 1);
  try { A = SOLVE.analyze(text, { defaults: defaults }); }
  catch (e) { clear(out); out.appendChild(h('div', { class: 'errbox' }, h('div', { class: 'errhead' }, 'The page could not read this question.'), h('div', { class: 'errmsg' }, String(e && e.message ? e.message : e)), h('div', null, 'Your text is still in the box above. Nothing was lost.'))); return; }
  Q = { id: APP.qid, A: A, qn: qn };
  APP.Q = Q;
  /* every question stays on the page (newest first): a slow AI helper can still finish the older ones, and he can go back to them */
  APP.questions.unshift(Q);
  Q.el = h('div', { class: 'question' });
  out.insertBefore(Q.el, out.firstChild);
  Q.barEl = h('div', { class: 'qbar' });
  Q.el.appendChild(h('div', { class: 'qhead' }, h('b', null, 'Question ' + qn), '  ', h('span', { class: 'hint' }, A.parts.length ? collapse(text).slice(0, 90) + (collapse(text).length > 90 ? '..' : '') : 'Nothing was found in this text.'), '  ',
    h('button', { type: 'button', class: 'small', onclick: function () { removeQuestion(Q); } }, 'Remove this question')));
  /* the words the page read differently from what he typed (misspellings it repaired): said plainly, above the answers */
  if (A.repairs && A.repairs.length) {
    Q.el.appendChild(h('div', { class: 'spellnote' }, h('b', null, 'Spelling: '), 'the page read ' + A.repairs.map(function (r) { return '"' + r.from + '" as "' + r.to + '"'; }).join(', ')
      + '. If one of these is NOT the word on your paper, fix that word in the box above and press Solve again.'));
  }
  /* (10/07, the rough-typing run) WORDS THE PAGE COULD NOT READ.  A misspelled word that the repair cannot place is simply not read -- and when that word
     carried the meaning ("frree to swya" for "free to sway": K 0.8 for 2.0; "salb" for "slab": the slab's weight left out) the page printed a clean block
     for a different question.  Such words are named, and the answers of this question stay hidden until he has either corrected them (the text in the
     box changes, he presses Solve) or said that they stand on the paper exactly so.  On 464 clean saved questions this fires on none. */
  if (A.unknownWords && A.unknownWords.length) {
    Q.unkEl = h('div', { class: 'unknote' }, h('b', null, 'CHECK THE SPELLING FIRST. '), 'The page does not know ' + (A.unknownWords.length > 1 ? 'these words' : 'this word') + ': '
      + A.unknownWords.map(function (w0) { return '"' + w0 + '"'; }).join(', ') + '. It read your question WITHOUT ' + (A.unknownWords.length > 1 ? 'them' : 'it')
      + ', so the answer may be for a different question. Compare ' + (A.unknownWords.length > 1 ? 'each one' : 'it') + ' with your paper: if it is misspelled, fix it in the box above and press Solve again.  ',
      h('button', { type: 'button', class: 'small', onclick: function () {
        Q.el.className = String(Q.el.className || '').replace(/\s*\bisunknown\b/g, '');
        if (Q.unkEl && Q.unkEl.parentNode) Q.unkEl.parentNode.removeChild(Q.unkEl);
        Q.unkEl = null;
      } }, 'Spelled exactly as on my paper: show the answers'));
    Q.el.appendChild(Q.unkEl);
    Q.el.className = String(Q.el.className || '') + ' isunknown';
  }
  /* several look-ups in one sentence were split into lettered parts (src/expand.js): said plainly, so that he knows which answer goes in which blank */
  if (A.expanded && A.expanded.length) {
    var exN = 0, exI; for (exI = 0; exI < A.expanded.length; exI++) exN += Number(A.expanded[exI].items) || 0;
    Q.el.appendChild(h('div', { class: 'spellnote' }, h('b', null, 'Several look-ups in one question: '), 'the page split your question into ' + (exN || 'separate') + ' look-ups, lettered (a), (b), (c) ... in the SAME ORDER as in your question. '
      + 'The first answer goes in the first blank of your paper, the second in the second, and so on.'));
  }
  Q.el.appendChild(Q.barEl);
  for (i = 0; i < A.parts.length; i++) { newPartUi(A.parts[i], Q, qn); Q.el.appendChild(A.parts[i].ui.card); }
  $('status').textContent = A.parts.length ? 'Question ' + qn + ' is below. Type the next question here whenever you like: this one stays on the page.' : 'No part could be made from this text.';
  readAll(Q);
  try { Q.el.scrollIntoView({ block: 'start' }); } catch (e2) { /* ignore */ }
}
function removeQuestion(Q) {
  var i;
  Q.removed = true;
  for (i = APP.queue.length - 1; i >= 0; i--) if (APP.queue[i].Q === Q) APP.queue.splice(i, 1);
  if (APP.busy && APP.busy.Q === Q && APP.caller) APP.caller.abort();
  i = APP.questions.indexOf(Q); if (i >= 0) APP.questions.splice(i, 1);
  if (Q.el && Q.el.parentNode) Q.el.parentNode.removeChild(Q.el);
  drawCheckSummary();
}
/* Clear empties the text box for the next question.  The questions already solved stay below (each has its own Remove button). */
function onClear() {
  $('q').value = ''; lsSet('steelsolve.text', ''); $('status').textContent = '';
  $('q').focus();
}

/* ------------------------------------------------------------------------------------------------ start */
var EXAMPLES = [
  ['Quiz Q4 (U)', 'Given a W14 x 132 with two 7/8 in diameter bolt holes in the web, and 4 holes in each line. What is the shear lag factor U?'],
  ['Quiz Q5 (select)', 'Select the lightest 10 in deep channel section C10, to carry tensile service loads: PD = 90 kips and PL = 90 kips. Assume that all connections are welded (i.e. no bolt holes)'],
  ['Columns (a)-(c)', '5-9. Determine the phi_c*Pn for each of the columns, using Fy = 50 ksi unless noted otherwise.\n(a) A W8 x 35 with pinned ends, L = 18 ft.\n(b) A W14 x 68 with fixed ends, L = 30 ft.\n(c) A W12 x 87, Fy = 36 ksi with one end fixed and the other end pinned, L = 25 ft.'],
  ['Several lookups', 'Determine the following, and show the applicable units with each answer: The actual web width of a HP12 X 89. The actual depth of a M8 X 3.7. The radius of gyration about the weak axis of a S12 x 35.'],
  ['Definition', 'In the elastic range, the ratio of stress to strain (f/e) is called: a. modulus of elasticity b. yield strength c. plastic strain d. ultimate tensile stress']
];

/* never a dead page: if anything throws, say so at the top, keep his text, and keep going */
function showFatal(msg) {
  var box = $('fatal');
  if (!box) { box = h('div', { id: 'fatal', class: 'errbox' }); var app = $('app'); app.insertBefore(box, app.firstChild); }
  clear(box);
  box.appendChild(h('div', { class: 'errhead' }, 'The page hit an error.'));
  box.appendChild(h('div', { class: 'errmsg' }, String(msg)));
  box.appendChild(h('div', null, 'Your question is still in the box and in your history below. Press Solve again; if it keeps happening, reload the page (your text is saved).'));
}

function drawFoot() {
  var f = $('foot'), D = root.STEEL_DATA || {}, bits = [];
  if (!f) return;
  bits.push('engine: ' + (STEEL.info ? STEEL.info().specification + ', ' + STEEL.info().shapes + ' shapes' : '?'));
  if (D.finder && D.finder.version) bits.push('finder rules v' + D.finder.version);
  if (root.READER && root.READER.version) bits.push('rule reader ' + root.READER.version);
  if (root.LLMREADER && root.LLMREADER.version) bits.push('model reader ' + root.LLMREADER.version); else bits.push('model reader: not loaded');
  bits.push('page ' + (root.SOLVE && root.SOLVE.version) + (root.SOLVE_BUILD ? ' build ' + root.SOLVE_BUILD.id : ''));
  f.appendChild(doc.createTextNode('Versions: ' + bits.join('  |  ')));
}

function start() {
  var q = $('q'), ex = $('examples'), saved, h0;
  if (!doc || !SOLVE || !STEEL) return;
  root.addEventListener('error', function (e) { showFatal((e && e.message) || 'unknown error'); });
  root.addEventListener('unhandledrejection', function (e) { showFatal('a background step failed: ' + (e && e.reason && e.reason.message ? e.reason.message : e && e.reason)); });
  selfTest();
  drawKitNav();
  drawModelBar();
  drawFoot();
  /* a running clock on every "reading..." message, so a slow model never looks like a dead page */
  root.setInterval(function () {
    var els = doc.querySelectorAll('.aiclock'), i, t0;
    for (i = 0; i < els.length; i++) {
      t0 = Number(els[i].getAttribute('data-t0'));
      if (t0) els[i].textContent = mmss((new Date().getTime() - t0) / 1000);
    }
  }, 1000);
  saved = lsGet('steelsolve.text'); if (saved) q.value = saved;
  saved = lsGet('steelsolve.defaults'); if (saved) $('defaults').value = saved;
  q.addEventListener('input', function () { lsSet('steelsolve.text', q.value); markStale(); });
  $('defaults').addEventListener('input', function () { lsSet('steelsolve.defaults', $('defaults').value); drawCoverNote(); });
  /* the cover page is the FIRST step: the box is open until something is in it */
  try { if ($('defsbox') && trim($('defaults').value) === '') $('defsbox').open = true; } catch (eD) { /* older browsers */ }
  drawCoverNote();
  /* a page with questions on it is not closed or reloaded by accident (the "Solved so far" list survives a reload; the open questions do not) */
  root.addEventListener('beforeunload', function (ev) {
    var live = false, k;
    for (k = 0; k < APP.questions.length; k++) if (!APP.questions[k].removed) live = true;
    if (live) { ev.preventDefault(); ev.returnValue = ''; return ''; }
  });
  $('solve').addEventListener('click', onSolve);
  q.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); onSolve(); } });
  $('clear').addEventListener('click', onClear);
  EXAMPLES.forEach(function (e) { ex.appendChild(h('button', { type: 'button', class: 'small', onclick: function () { q.value = e[1]; lsSet('steelsolve.text', e[1]); } }, e[0])); });
  try { h0 = JSON.parse(lsGet('steelsolve.history') || '[]'); if (h0 && h0.length) APP.history = h0; } catch (e2) { APP.history = []; }
  drawHistory();
  findModel();
}
root.SOLVE_UI = { start: start, app: APP };
if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : this);

