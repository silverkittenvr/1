/* ==== pipeline.js ==== */
/* pipeline.js -- the logic of steel-solve.  ES5 ONLY (no arrow functions, let/const, template strings, classes).  ASCII only.
   No DOM and no network in this file: the page (ui.js) and test.js call exactly these functions.

   Needs these globals (the page loads them first; test.js sets them): STEEL (engine), STEEL_FINDER (finder), READER (rule reader),
   LLMREADER (box reader that uses a local model; optional: without it everything runs on the rule reader alone).

   The flow for one pasted question:
     SOLVE.analyze(text, {defaults})            -> parts (each: the finder's form, the chain of calculator forms, the text the readers see)
     SOLVE.readStage(part, i, deps, done)       -> proposes every box of stage i: model + rule reader, merged, every value with its words
     SOLVE.initialValues(stage)                 -> the box values the student starts from (proposals only; conflicts stay empty)
     SOLVE.gate(part, vals, ticks)              -> what still blocks "calculate" (empty required box, unresolved conflict, figure tick)
     SOLVE.runPart(part, vals)                  -> runs the chain on the engine
     SOLVE.writeBlock(part, run)                -> the WRITE THIS text and the READ THIS lines
   Nothing is calculated until runPart is called, and the page only calls it after the student pressed the confirm button. */
(function (root) {
'use strict';

var SOLVE = { version: 'solve-0.1' };
var ENV = null;

function env() {
  if (ENV) return ENV;
  var e = { STEEL: root.STEEL, FINDER: root.STEEL_FINDER, READER: root.READER, LLMREADER: root.LLMREADER };
  if (!e.STEEL || typeof e.STEEL.run !== 'function') throw new Error('the calculator engine (STEEL) is not loaded');
  if (!e.FINDER || typeof e.FINDER.route !== 'function') throw new Error('the form finder (STEEL_FINDER) is not loaded');
  ENV = e;
  return ENV;
}
SOLVE.setEnv = function (e) { ENV = e; };

/* ------------------------------------------------------------------------------------------------ small helpers */
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function isStr(x) { return typeof x === 'string'; }
function isArr(x) { return Object.prototype.toString.call(x) === '[object Array]'; }
function isObj(x) { return x !== null && typeof x === 'object' && !isArr(x); }
function trim(s) { return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }
function rnd9(x) { return Math.round(x * 1e9) / 1e9; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function fmtNum(n) { return String(rnd9(n)); }
function parseNum(x) { return env().STEEL.parseNum(x); }
function uniq(list) { var out = [], seen = {}, i; for (i = 0; i < list.length; i++) { if (!has(seen, '$' + list[i])) { seen['$' + list[i]] = 1; out.push(list[i]); } } return out; }
function collapse(s) { return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').replace(/^ | $/g, ''); }

/* the short name and the hint of an engine label, the way ui.js of the calculator splits them ("Beam span (the beams run ... )") */
function matchingParen(s, open) {
  var depth = 0, i;
  for (i = open; i < s.length; i++) {
    if (s.charAt(i) === '(') depth++;
    else if (s.charAt(i) === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function trimEnds(s) { return String(s).replace(/^[\s:,;.]+|[\s:,;]+$/g, ''); }
function splitLabel(label) {
  var s = collapse(label), i, close, inner, name, rest;
  for (i = 0; i < s.length; i++) {
    if (s.substr(i, 4) === ' -- ') { name = s.slice(0, i); rest = s.slice(i + 4); break; }
    if (s.charAt(i) === '(' && i > 0) {
      close = matchingParen(s, i);
      inner = s.slice(i + 1, close < 0 ? s.length : close);
      if (inner.length >= 12 || inner.indexOf(' -- ') >= 0) {
        name = s.slice(0, i); rest = s.slice(i);
        if (close === s.length - 1) rest = s.slice(i + 1, close);
        break;
      }
      i = close < 0 ? s.length : close;
    }
  }
  if (name === undefined) return { name: trimEnds(s), hint: '' };
  return { name: trimEnds(name), hint: trimEnds(rest) };
}
function shortName(label) {
  var s = collapse(label), k = s.search(/\s--\s|:\s|\s\(/);
  if (k > 0) s = s.slice(0, k);
  return s.length > 40 ? s.slice(0, 38) + '..' : s;
}

/* ------------------------------------------------------------------------------------------------ the engine's forms */
var FORM_CACHE = null;
function forms() {
  if (!FORM_CACHE) { FORM_CACHE = {}; var L = env().STEEL.list(), i; for (i = 0; i < L.length; i++) FORM_CACHE[L[i].name] = L[i]; }
  return FORM_CACHE;
}
SOLVE.formList = function () { return env().STEEL.list(); };
function formOf(fn) { return forms()[fn] || null; }

var SKIP = { unit: 1, show: 1 };            /* print labels and how-many-to-list: not read from a problem (the model reader skips them too) */
function kindOf(f) {
  var t = f.type;
  if (t === 'number' || t === 'dimension') return 'num';
  if (t === 'integer') return 'int';
  if (t === 'shape' || t === 'text') return 'name';
  if (t === 'boolean') return 'bool';
  if (t === 'select' || t === 'endcond') return 'choice';
  if (t === 'numlist') return 'numlist';
  if (t === 'strlist') return 'strlist';
  if (t === 'list') return 'list';
  return null;
}
function optionsOf(f) {
  var out = [], i, v;
  if (f.type === 'endcond' && (!f.values || !f.values.length)) {
    var ec = env().STEEL.endConditions;
    var ids = ['pinned-pinned', 'fixed-fixed', 'fixed-pinned', 'fixed-sway', 'flagpole', 'pinned-sway'];
    if (typeof ec === 'function') { try { var got = ec(); if (isArr(got) && got.length) { for (i = 0; i < got.length; i++) out.push({ value: got[i].id, label: got[i].label || got[i].id }); return out; } } catch (e) { /* fall through */ } }
    for (i = 0; i < ids.length; i++) out.push({ value: ids[i], label: ids[i] });
    return out;
  }
  for (i = 0; i < (f.values || []).length; i++) { v = f.values[i]; out.push({ value: typeof v === 'object' ? v.value : v, label: typeof v === 'object' ? (v.label || v.value) : v }); }
  return out;
}
function makeBox(prefix, spec, nested) {
  var kind = kindOf(spec), sl, b, i, it, sub;
  if (!kind || SKIP[spec.name]) return null;
  sl = splitLabel(spec.label || spec.name);
  b = { path: prefix + spec.name, name: spec.name, spec: spec, kind: kind, unit: spec.unit || '', required: !!spec.required && !nested && !spec.requiredUnless,
    label: sl.name || spec.name, hint: sl.hint, options: [], defaultValue: spec.default, items: null, nested: !!nested };
  if (kind === 'choice') b.options = optionsOf(spec);
  if (kind === 'list') {
    b.items = [];
    for (i = 0; i < (spec.item || []).length; i++) {
      it = spec.item[i];
      sub = { name: it.name, label: shortName(it.label || it.name), unit: it.unit || '', kind: kindOf(it), required: !!it.required, options: it.type === 'select' || it.type === 'endcond' ? optionsOf(it) : [], defaultValue: it.default, spec: it };
      if (sub.kind && sub.kind !== 'list' && sub.kind !== 'numlist' && sub.kind !== 'strlist') b.items.push(sub);
    }
  }
  return b;
}
/* the flat list of boxes of one form; the "analysis" object of beam_select is spread into the boxes of beam_analysis (path "analysis.span_ft") */
function boxesOf(fn) {
  var form = formOf(fn), out = [], i, j, f, b, sub;
  if (!form) return out;
  for (i = 0; i < form.fields.length; i++) {
    f = form.fields[i];
    if (f.type === 'object' && f.name === 'analysis') {
      sub = formOf('beam_analysis');
      if (sub) for (j = 0; j < sub.fields.length; j++) { b = makeBox('analysis.', sub.fields[j], true); if (b) out.push(b); }
    } else { b = makeBox('', f, false); if (b) out.push(b); }
  }
  return out;
}
SOLVE.boxesOf = boxesOf;

/* ------------------------------------------------------------------------------------------------ finding words in the text (for the highlights) */
var QMAP = {};
(function () {
  function add(list, rep) { var i; for (i = 0; i < list.length; i++) QMAP[String.fromCharCode(list[i])] = rep; }
  add([0xa0, 0x2007, 0x202f, 0x200b, 0x2009, 0x2002, 0x2003, 0xfeff], ' ');
  add([0x2018, 0x2019, 0x2bc, 0x2032], "'");
  add([0x201c, 0x201d, 0x2033], '"');
  add([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212], '-');
  add([0xb2], '^2'); add([0xb3], '^3'); add([0xb7], '*'); add([0xd7], 'x');
  add([0x3a6, 0x3c6], 'f'); add([0x2044], '/');
})();
/* a normalised copy of the text with, for every character of the copy, the index it came from.  Whitespace runs become one space. */
function normWithMap(text, ascii) {
  var s = '', map = [], i, ch, rep, k, lastSpace = true;
  for (i = 0; i < text.length; i++) {
    ch = text.charAt(i);
    rep = has(QMAP, ch) ? QMAP[ch] : ch;
    if (ascii && rep.charCodeAt(0) > 127) rep = ' ';
    if (/\s/.test(rep)) { if (!lastSpace) { s += ' '; map.push(i); lastSpace = true; } continue; }
    for (k = 0; k < rep.length; k++) { s += rep.charAt(k); map.push(i); }
    lastSpace = false;
  }
  return { s: s, map: map };
}
function alnumWithMap(text) {
  var s = '', map = [], i, ch, rep;
  for (i = 0; i < text.length; i++) {
    ch = text.charAt(i); rep = has(QMAP, ch) ? QMAP[ch] : ch;
    if (/[A-Za-z0-9]/.test(rep.charAt(0))) { s += rep.toLowerCase(); map.push(i); }
  }
  return { s: s, map: map };
}
/* where do these words sit in the text?  returns [start, end) of the best occurrence (the one inside the part's own text when there are several), or null */
function locate(text, words, preferFrom) {
  var q = collapse(words), nm, qn, idx, hits = [], from, best, a, e, aq;
  if (!q) return null;
  nm = normWithMap(text, false); qn = collapse(normWithMap(q, false).s);
  function collect(hay, needle, cs) {
    var out = [], h = cs ? hay : hay.toLowerCase(), n = cs ? needle : needle.toLowerCase(), at = 0, i;
    if (!n) return out;
    for (;;) { i = h.indexOf(n, at); if (i < 0) break; out.push(i); at = i + 1; }
    return out;
  }
  hits = collect(nm.s, qn, true);
  if (!hits.length) hits = collect(nm.s, qn, false);
  if (hits.length) {
    best = hits[0];
    if (isNum(preferFrom)) { for (idx = 0; idx < hits.length; idx++) { if (nm.map[hits[idx]] >= preferFrom) { best = hits[idx]; break; } } }
    a = nm.map[best]; e = nm.map[Math.min(best + qn.length, nm.map.length) - 1] + 1;
    return [a, e];
  }
  nm = normWithMap(text, true); qn = collapse(normWithMap(q, true).s);
  hits = collect(nm.s, qn, false);
  if (hits.length) {
    best = hits[0];
    if (isNum(preferFrom)) { for (idx = 0; idx < hits.length; idx++) { if (nm.map[hits[idx]] >= preferFrom) { best = hits[idx]; break; } } }
    a = nm.map[best]; e = nm.map[Math.min(best + qn.length, nm.map.length) - 1] + 1;
    return [a, e];
  }
  nm = alnumWithMap(text); aq = alnumWithMap(q).s;
  if (aq.length >= 3) {
    hits = collect(nm.s, aq, true);
    if (hits.length) {
      best = hits[0];
      if (isNum(preferFrom)) { for (idx = 0; idx < hits.length; idx++) { if (nm.map[hits[idx]] >= preferFrom) { best = hits[idx]; break; } } }
      return [nm.map[best], nm.map[best + aq.length - 1] + 1];
    }
  }
  return null;
}
SOLVE.locate = locate;
/* a phrase may be several pieces joined by " | " or " ... " (the rule reader joins what a list used) */
function pieces(words) { var out = [], parts = String(words).split(/\s+\|\s+|\s+\.\.\.\s+/), i; for (i = 0; i < parts.length; i++) if (trim(parts[i])) out.push(trim(parts[i])); return out; }
SOLVE.spansFor = function (ctx, wordsList, preferFrom) {
  var out = [], i, j, k, ps, sp, bits;
  for (i = 0; i < wordsList.length; i++) {
    ps = pieces(wordsList[i]);
    for (j = 0; j < ps.length; j++) {
      sp = locate(ctx, ps[j], preferFrom);
      if (sp) { out.push(sp); continue; }
      /* the rule reader joins several phrases with ", " ("PD = 15 k, PL = 25 k" for "PD = 15 k and PL = 25 k"): try the bits on their own */
      if (ps[j].indexOf(', ') > 0) { bits = ps[j].split(/,\s+/); for (k = 0; k < bits.length; k++) { sp = locate(ctx, bits[k], preferFrom); if (sp) out.push(sp); } }
    }
  }
  return out;
};

/* ------------------------------------------------------------------------------------------------ comparing and showing values */
function normChoice(v) { return String(v).trim().toLowerCase().replace(/[\s_]+/g, '-'); }
function toBool(v) {
  if (v === true || v === false) return v;
  var s = String(v).trim().toLowerCase();
  if (s === 'yes' || s === 'true' || s === 'y' || s === '1') return true;
  if (s === 'no' || s === 'false' || s === 'n' || s === '0') return false;
  return null;
}
function sameScalar(spec, a, b) {
  var kind = spec.kind || kindOf(spec), na, nb;
  if (a === undefined || a === null || b === undefined || b === null) return a === b;
  if (kind === 'num' || kind === 'int') {
    na = parseNum(a); nb = parseNum(b);
    if (isFinite(na) && isFinite(nb)) return Math.abs(na - nb) <= 1e-6 * Math.max(1, Math.abs(nb));
    return collapse(a).toUpperCase() === collapse(b).toUpperCase();
  }
  if (kind === 'bool') return toBool(a) === toBool(b);
  if (kind === 'choice') return normChoice(a) === normChoice(b);
  return String(a).replace(/\s+/g, '').toUpperCase() === String(b).replace(/\s+/g, '').toUpperCase();
}
function listItemCanon(box, item) {
  var out = {}, i, sub, v;
  for (i = 0; i < box.items.length; i++) {
    sub = box.items[i]; v = item ? item[sub.name] : undefined;
    if (v === undefined || v === null || v === '') continue;
    if (sub.defaultValue !== undefined && sameScalar(sub, v, sub.defaultValue)) continue;
    out[sub.name] = (sub.kind === 'num' || sub.kind === 'int') && isFinite(parseNum(v)) ? rnd9(parseNum(v)) : (sub.kind === 'choice' ? normChoice(v) : v);
  }
  return out;
}
function sameValue(box, a, b) {
  var i, la, lb, ka, kb, k;
  if (box.kind === 'numlist') {
    la = toNumList(a); lb = toNumList(b);
    if (!la || !lb || la.length !== lb.length) return false;
    for (i = 0; i < la.length; i++) if (Math.abs(la[i] - lb[i]) > 1e-6 * Math.max(1, Math.abs(lb[i]))) return false;
    return true;
  }
  if (box.kind === 'strlist') {
    la = toStrList(a); lb = toStrList(b);
    if (la.length !== lb.length) return false;
    for (i = 0; i < la.length; i++) if (la[i].toUpperCase() !== lb[i].toUpperCase()) return false;
    return true;
  }
  if (box.kind === 'list') {
    if (!isArr(a) || !isArr(b) || a.length !== b.length) return false;
    for (i = 0; i < a.length; i++) {
      ka = listItemCanon(box, a[i]); kb = listItemCanon(box, b[i]);
      for (k in ka) if (has(ka, k)) { if (!has(kb, k) || ka[k] !== kb[k]) return false; }
      for (k in kb) if (has(kb, k) && !has(ka, k)) return false;
    }
    return true;
  }
  return sameScalar(box, a, b);
}
function toNumList(v) {
  var out = [], i, n, toks;
  if (isArr(v)) { for (i = 0; i < v.length; i++) { n = parseNum(v[i]); if (!isFinite(n)) return null; out.push(n); } return out; }
  if (isStr(v)) {
    toks = v.split(/[,;]+|\s+/);
    for (i = 0; i < toks.length; i++) { if (!trim(toks[i])) continue; n = parseNum(toks[i]); if (!isFinite(n)) return null; out.push(n); }
    return out;
  }
  return null;
}
function toStrList(v) {
  var out = [], i, toks;
  if (isArr(v)) { for (i = 0; i < v.length; i++) if (trim(v[i])) out.push(trim(v[i])); return out; }
  toks = String(v === undefined || v === null ? '' : v).split(/[\s,;]+/);
  for (i = 0; i < toks.length; i++) if (trim(toks[i])) out.push(trim(toks[i]));
  return out;
}
/* a reader's value -> the text the student sees and edits (list boxes: an array of {sub: text}) */
function uiValue(box, raw) {
  var i, out, it, sub, v;
  if (raw === undefined || raw === null) return '';
  if (box.kind === 'num' || box.kind === 'int') return isNum(raw) ? fmtNum(raw) : collapse(raw);
  if (box.kind === 'bool') { v = toBool(raw); return v === true ? 'yes' : (v === false ? 'no' : ''); }
  if (box.kind === 'numlist') { v = toNumList(raw); if (v) { out = []; for (i = 0; i < v.length; i++) out.push(fmtNum(v[i])); return out.join(', '); } return collapse(raw); }
  if (box.kind === 'strlist') return toStrList(raw).join(', ');
  if (box.kind === 'list') {
    out = [];
    if (!isArr(raw)) return out;
    for (i = 0; i < raw.length; i++) {
      it = {};
      for (v = 0; v < box.items.length; v++) {
        sub = box.items[v];
        if (raw[i] && raw[i][sub.name] !== undefined && raw[i][sub.name] !== null) it[sub.name] = isNum(raw[i][sub.name]) ? fmtNum(raw[i][sub.name]) : String(raw[i][sub.name]);
      }
      out.push(it);
    }
    return out;
  }
  if (box.kind === 'choice') return String(raw);
  return collapse(raw);
}
/* the same value as one line of plain text */
function showValue(box, ui) {
  var i, parts, it, v, sub, bits;
  if (ui === undefined || ui === null || ui === '') return '';
  if (box.kind === 'list') {
    if (!isArr(ui)) return String(ui);
    parts = [];
    for (i = 0; i < ui.length; i++) {
      bits = [];
      for (v = 0; v < box.items.length; v++) { sub = box.items[v]; it = ui[i][sub.name]; if (it !== undefined && it !== '') bits.push(sub.name + ' = ' + it + (sub.unit ? ' ' + sub.unit : '')); }
      parts.push(bits.join(', '));
    }
    return parts.join('  |  ');
  }
  if (box.kind === 'choice') { for (i = 0; i < box.options.length; i++) if (normChoice(box.options[i].value) === normChoice(ui)) return String(ui); }
  return String(ui) + (box.unit && box.kind !== 'bool' ? ' ' + box.unit : '');
}
SOLVE.showValue = showValue;
/* are two values of one box the same thing (3/4 and 0.75, "yes" and true, two lists with the same rows)? */
SOLVE.sameUi = function (box, a, b) { try { return sameValue(box, a, b); } catch (e) { return showValue(box, a) === showValue(box, b); } };

/* ------------------------------------------------------------------------------------------------ the two readers -> one table of proposals */
var PLAIN_REASON = [
  [/required and not stated/i, 'Your text does not say this.'],
  [/gives no value to copy|speaks of this box/i, 'Your text mentions it but gives no number to copy (it needs arithmetic, a figure or a judgement).'],
  [/quote is not in the problem|text is not inside the quote|only part of a number/i, 'The model named words that are not in your text, so its answer was thrown away.'],
  [/unit/i, 'The model gave a unit that is not written next to the number, so its answer was thrown away.'],
  [/outside the range/i, 'The model read a number that the box does not allow, so its answer was thrown away.'],
  [/choice is not/i, 'The model picked something that is not one of the box\'s choices, so its answer was thrown away.']
];
function plainReason(reason) {
  var i;
  for (i = 0; i < PLAIN_REASON.length; i++) if (PLAIN_REASON[i][0].test(reason || '')) return PLAIN_REASON[i][1];
  return 'The model\'s answer for this box failed a check, so it was thrown away (' + collapse(reason || '') + ').';
}

/* the model reader's result -> { path: {status, value, words:[...], note, reason} } */
/* A number the model copied must be a WHOLE number of the text.  "1/2" taken out of "2-1/2 in", or "3" out of "3/4", is half a number (10/06: on the mock's
   staggered plate the model read the stagger 2-1/2 in as 1/2 in, quoted "1/2 in" -- words that really are in the text -- and the answer came out wrong). */
function cutsANumber(ctx, quote, numText) {
  var C = String(ctx || '').replace(/\s+/g, ' '), q = collapse(quote || ''), n = trim(numText || ''), from = 0, at, p, before, after, any = false, whole = false, cutB, cutA;
  if (!q || !n || !/^[\d.,\/ ]+$/.test(n)) return false;
  while ((at = C.indexOf(q, from)) >= 0) {
    p = C.indexOf(n, at);
    if (p >= 0 && p < at + q.length) {
      any = true;
      before = C.slice(Math.max(0, p - 3), p); after = C.slice(p + n.length, p + n.length + 2);
      cutB = /\d$/.test(before) || /\d[.\/,]$/.test(before) || (/\d[- ]$/.test(before) && /^\d+\/\d+$/.test(n));
      cutA = /^\d/.test(after) || /^[\/.]\d/.test(after);
      if (!cutB && !cutA) whole = true;
    }
    from = at + 1;
  }
  return any && !whole;
}
SOLVE.cutsANumber = cutsANumber;
function llmMap(fill, boxes, ctx) {
  var out = {}, i, b, d, words, raw, items, k, j, it, sub, q;
  if (!fill || !fill.detail) return out;
  raw = fill.raw && typeof fill.raw === 'object' ? fill.raw : {};
  for (i = 0; i < boxes.length; i++) {
    b = boxes[i]; d = fill.detail[b.path];
    if (!d) continue;
    words = [];
    if (d.status === 'filled') {
      if (d.quote) words.push(d.quote);
      else {
        /* lists and name lists carry no single quote in the verified result: take the quotes the program verified from the model's own answer */
        items = raw[b.path];
        if (isArr(items)) {
          for (k = 0; k < items.length; k++) {
            it = items[k];
            if (!it || typeof it !== 'object') continue;
            if (isStr(it.quote)) words.push(collapse(it.quote));
            else for (j in it) if (has(it, j) && it[j] && typeof it[j] === 'object' && isStr(it[j].quote)) words.push(collapse(it[j].quote));
          }
        }
      }
      if (ctx && (b.kind === 'num' || b.kind === 'int') && d.quote && d.text && cutsANumber(ctx, d.quote, d.text)) {
        out[b.path] = { status: 'rejected', reason: 'the number it copied (' + d.text + ') is only part of a longer number in your text', words: [d.quote] };
        continue;
      }
      out[b.path] = { status: 'filled', value: d.value, words: uniq(words), text: d.text || null, unit: d.unit || '' };
    } else if (d.status === 'rejected' || d.status === 'unclear') {
      out[b.path] = { status: d.status, reason: d.reason || '', words: d.quote ? [d.quote] : [] };
    } else out[b.path] = { status: 'empty' };
  }
  return out;
}

/* the rule reader's result -> { path: {value, words:[...], confidence, rule} } plus what it could not place */
function ruleMap(res, boxes) {
  var out = {}, ignored = [], i, f, k, b, byPath = {}, paths = {};
  for (i = 0; i < boxes.length; i++) byPath[boxes[i].path] = boxes[i];
  if (!res || !res.fields) return { map: out, ignored: ignored };
  for (i = 0; i < res.fields.length; i++) {
    f = res.fields[i];
    if (f.name === 'analysis' && isObj(f.value)) {
      /* the rule reader joins the phrases of the loading's boxes with " | " in the order the boxes were set: give each box its own phrase when the counts agree */
      var akeys = [], ak, apcs = String(f.from).split(/\s+\|\s+/), perKey = false;
      for (ak in f.value) if (has(f.value, ak)) akeys.push(ak);
      perKey = apcs.length === akeys.length;
      for (ak = 0; ak < akeys.length; ak++) {
        k = akeys[ak];
        if (has(byPath, 'analysis.' + k) && !has(out, 'analysis.' + k)) out['analysis.' + k] = { value: f.value[k], words: [perKey ? apcs[ak] : f.from], confidence: f.confidence, rule: f.rule || '' };
        else if (!has(byPath, 'analysis.' + k)) ignored.push('analysis.' + k + ' = ' + JSON.stringify(f.value[k]));
      }
      continue;
    }
    if (has(byPath, f.name)) { if (!has(out, f.name)) out[f.name] = { value: f.value, words: [f.from], confidence: f.confidence, rule: f.rule || '' }; }
    else ignored.push(f.name + ' = ' + JSON.stringify(f.value) + '  (' + collapse(f.from).slice(0, 60) + ')');
  }
  return { map: out, ignored: ignored };
}

/* ------------------------------------------------------------------------------------------------ hints from the finder's "numbers to pull out" lists */
var GRAB_MAP = {
  tension_capacity: [[/^(shape|member|angles|width_in|thickness_in)$/, 'Shape'], [/bolt_dia|hole_dia/, 'Bolt diameter'], [/^holes_per_flange$/, 'Holes per flange'], [/^web_holes$/, 'Holes in the web'], [/^holes/, 'Holes per flange'], [/fasteners_per_line/, 'Fasteners per line'], [/^connection$/, 'Connected through'], [/^welded$/, 'Welded'], [/^(D|L|Pu|already_factored)$/, 'Loads']],
  tension_net_area: [[/^(shape|member|width_in|thickness_in)$/, 'Plate width'], [/bolt_dia/, 'Bolt diameter'], [/^holes/, 'Each hole']],
  tension_select: [[/^family$/, 'Family'], [/^(D|L|Pu|already_factored)$/, 'Loads'], [/^(welded|bolt_dia_in|holes|web_holes|connection|fasteners)/, 'Welded or bolted'], [/length_ft/, 'Length']],
  lookup_U: [[/connection/, 'Where it is connected'], [/fasteners_per_line/, 'Fasteners per line'], [/^shape$/, 'Shape']],
  column_capacity: [[/^shape$/, 'Shape'], [/^(Lx_ft|KLx_ft|Ly_ft|KLy_ft)$/, 'Length'], [/end_condition$/, 'End conditions'], [/y_segments/, 'Braces'], [/^(D|L|Pu|already_factored)$/, 'Load']],
  column_select: [[/^families$/, 'Family'], [/^(D|L|Pu|already_factored)$/, 'Loads'], [/(Lx_ft|KLx_ft|Ly_ft|KLy_ft|end_condition|y_segments)/, 'Length and end conditions']],
  column_euler: [[/^(shape|A|r|bar_dia_in|rect_)/, 'Section'], [/^(K|L_ft)$/, 'Length and end conditions'], [/proportional/, 'Proportional limit']],
  beam_analysis: [[/span_ft/, 'Span'], [/^(wD|wL|w_u)$/, 'Uniform loads'], [/point_loads/, 'Point loads'], [/self_weight/, 'Own weight'], [/support|positions_from/, 'Cantilever']],
  beam_select: [[/^Mu$/, 'The moment or the loads'], [/^analysis\./, 'The moment or the loads'], [/depth/, 'Depth limit']],
  beam_capacity: [[/^shape$/, 'Shape'], [/^Mu$/, 'Mu']],
  beam_max_live_load: [[/^(shape|span_ft|spacing_ft|position|tributary_ft)$/, 'Shape, span, spacing'], [/slab|superimposed|framing|concrete/, 'Dead loads']],
  floor_plan: [[/slab_thickness|concrete/, 'Slab or dead load'], [/superimposed/, 'Other dead load'], [/framing/, 'Steel framing'], [/live/, 'Live load'], [/^beam_/, 'Beam'], [/^girder_/, 'Girder']],
  loads_combinations: [[/^(D|L|Lr|S|R|W|E)$/, 'Each load'], [/reverse/, 'Reversing wind or earthquake']],
  loads_takedown: [[/tributary|bay_/, 'Tributary area'], [/^roof/, 'Roof'], [/^(floor|floors)/, 'Floors']],
  loads_factored: [[/^(D|L)$/, 'D and L']],
  lookup_shape: [[/^shape$/, 'Shape'], [/^property$/, 'Property']],
  lookup_definition: [[/^query$/, 'Search words']],
  lookup_hole: [[/bolt/, 'Bolt diameter']],
  lookup_K: [[/end/, 'End conditions']],
  lookup_critical_stress: [[/KL/, 'KL/r'], [/Fy/, 'Fy']],
  lookup_by_property: [[/property|minimum/, 'Property and minimum'], [/family|nominal/, 'Family']],
  lookup_material: [[/what/, 'Shape or grade']],
  tension_required_area: [[/^(D|L|Pu|already_factored)$/, 'Loads'], [/^(Fy|Fu)$/, 'Steel']],
  beam_required_zx: [[/^Mu$/, 'Mu'], [/^Fy$/, 'Fy']],
  loads_max_service: [[/phiRn/, 'phi Rn'], [/^D$/, 'Dead load']],
  units: [[/^value$/, 'The number and its unit'], [/conversion/, 'The unit wanted'], [/width/, 'Width']],
  section_properties: [[/^shape$/, 'Shape'], [/^(bar|rect|plate_t|plate_b)/, 'Plates or bar'], [/plate_h/, 'Where the plates go']]
};
function grabHint(fn, box) {
  var D = root.STEEL_DATA && root.STEEL_DATA.finder, rows = D && D.grab && D.grab[fn], map = GRAB_MAP[fn], i, j;
  if (!rows || !map) return null;
  for (i = 0; i < map.length; i++) {
    if (map[i][0].test(box.path)) {
      for (j = 0; j < rows.length; j++) if (rows[j][0].indexOf(map[i][1]) === 0) return { group: rows[j][0], text: rows[j][0] + ': ' + rows[j][1] };
    }
  }
  return null;
}
/* the finder lists what to pull out of a problem for each form ("Length", "End conditions" ...).  A group of boxes that neither reader filled is a question
   for the student: the first empty box of the group is shown as one (the others of the group stay in the folded list). */
function markQuestions(boxes) {
  var filled = {}, asked = {}, i, b;
  for (i = 0; i < boxes.length; i++) {
    b = boxes[i];
    if (b.grabGroup && (b.state === 'agree' || b.state === 'model' || b.state === 'rule' || b.state === 'conflict' || b.state === 'carried')) filled[b.grabGroup] = true;
  }
  for (i = 0; i < boxes.length; i++) {
    b = boxes[i]; b.askNow = false;
    if (b.state === 'empty' && b.grabGroup && !filled[b.grabGroup] && !asked[b.grabGroup]) { b.askNow = true; asked[b.grabGroup] = true; }
  }
}

/* two readers named different shapes: tell the student which of them is a shape the Manual really has (the engine refuses the other one) */
function shapeKnown(name) {
  var r;
  try { r = env().STEEL.run('lookup_shape', { shape: name, property: 'A' }); } catch (e) { return true; }
  return !!(r && r.ok);
}
function markUnknownShapes(b) {
  var known = [shapeKnown(b.alts[0].ui), shapeKnown(b.alts[1].ui)], i;
  if (known[0] === known[1]) return;
  for (i = 0; i < 2; i++) b.alts[i].invalid = !known[i];
}

/* ------------------------------------------------------------------------------------------------ merging: the rows the student sees */
function mergeBoxes(boxes, L, R, ruleQs, llmQs, carried) {
  var i, b, l, r, qs, q, j;
  for (i = 0; i < boxes.length; i++) {
    b = boxes[i]; l = L[b.path] || null; r = R[b.path] || null;
    b.llm = l; b.rule = r; b.state = 'empty'; b.proposal = undefined; b.alts = []; b.words = []; b.notes = []; b.question = null; b.ruleQuestion = null; b.askNow = false;
    var gh = grabHint(b.fn, b);
    b.grab = gh ? gh.text : null; b.grabGroup = gh ? gh.group : null;
    if (carried && has(carried, b.path)) { b.state = 'carried'; b.notes.push(carried[b.path]); continue; }
    var hasL = !!(l && l.status === 'filled'), hasR = !!r;
    if (hasL && hasR) {
      if (sameValue(b, l.value, r.value)) {
        b.state = 'agree'; b.proposal = uiValue(b, r.value && typeof r.value === 'string' && /\//.test(r.value) && b.kind === 'num' ? r.value : l.value);
        b.words.push({ src: 'model', text: l.words.join('  ...  ') });
        b.words.push({ src: 'rules', text: r.words.join('  ...  ') });
      } else {
        b.state = 'conflict';
        b.alts.push({ src: 'model', ui: uiValue(b, l.value), words: l.words.join('  ...  ') });
        b.alts.push({ src: 'rules', ui: uiValue(b, r.value), words: r.words.join('  ...  '), note: r.rule || '' });
        if (b.spec && b.spec.type === 'shape') markUnknownShapes(b);
      }
    } else if (hasL) {
      b.state = 'model'; b.proposal = uiValue(b, l.value);
      b.words.push({ src: 'model', text: l.words.join('  ...  ') });
    } else if (hasR) {
      b.state = 'rule'; b.proposal = uiValue(b, r.value);
      b.words.push({ src: 'rules', text: r.words.join('  ...  ') });
    } else if (l && l.status === 'unclear' && l.words.length) {
      /* "the problem speaks of it but gives no value to copy": only believed when the model pointed at words that really are in the text */
      b.state = 'unclear'; b.question = plainReason(l.reason); b.words.push({ src: 'model', text: l.words.join('  ...  ') });
    } else if (l && l.status === 'rejected') {
      b.state = 'rejected'; b.question = plainReason(l.reason);
    }
    if (b.state === 'model' || b.state === 'agree') {
      if (l.text && l.unit && b.unit && l.unit !== b.unit) b.notes.push('read as ' + l.text + ' ' + l.unit + '; this box is in ' + b.unit);
    }
    if ((b.state === 'rule' || b.state === 'conflict') && r && r.rule) b.notes.push('rule used: ' + r.rule);
    if (r && r.confidence === 'default') b.notes.push('taken from the exam-defaults line');
    if (b.state === 'empty' && !b.required && b.defaultValue !== undefined && b.defaultValue !== null && b.defaultValue !== '') b.state = 'default';
  }
  /* questions the readers raised about boxes */
  for (i = 0; i < ruleQs.length; i++) {
    q = ruleQs[i];
    if (q.kind === 'info' && (!q.fields || !q.fields.length)) continue;
    for (j = 0; j < (q.fields || []).length; j++) {
      for (var k = 0; k < boxes.length; k++) {
        if (boxes[k].path === q.fields[j] || boxes[k].path === 'analysis.' + q.fields[j] || (q.fields[j] === 'analysis' && boxes[k].nested && !boxes[k].ruleQuestion)) {
          if (!boxes[k].ruleQuestion) boxes[k].ruleQuestion = { text: q.text, choices: q.choices || null };
        }
      }
    }
  }
  for (i = 0; i < boxes.length; i++) {
    if (boxes[i].state === 'empty' && !boxes[i].question && boxes[i].required) boxes[i].question = 'Your text does not say this. It is required: type it in.';
  }
  markQuestions(boxes);
  return boxes;
}

/* ------------------------------------------------------------------------------------------------ routing and splitting into parts */
function coverLines(text) {
  var lines = String(text).split(/\r\n|\r|\n/), out = [], i;
  for (i = 0; i < lines.length; i++) if (/^\s*(exam defaults|cover defaults|unless noted)/i.test(lines[i])) out.push(trim(lines[i]));
  return out;
}
/* a line break in the middle of a sentence (text copied from a PDF or a web page wraps its lines) is not the end of the sentence:
   when a line does not end like a sentence and the next line goes on in lower case, the two lines are one */
function joinWrapped(text) {
  var raw = String(text).split(/\n/), out = [], i, prev;
  for (i = 0; i < raw.length; i++) {
    prev = out.length ? out[out.length - 1] : null;
    /* (10/06 18:05: a line that ends with ")" may be the middle of a sentence too -- her own final: "... calculate the critical (i.e. governing)" /
       "slenderness ratio for a W12 x 96 column ...".  Typed with the paper's line breaks that question went to the K lookup.  After a ")" the next line is
       joined only when it starts with a plain lower-case word and holds no blank and no "=": an answer line stays a line of its own.) */
    if (prev !== null && /\S/.test(prev) && /\S/.test(raw[i]) && !/[.?!:;\]_|]\s*$/.test(prev) && /^\s*[a-z]/.test(raw[i])
      && (!/\)\s*$/.test(prev) || (/^\s*[a-z]{2,}[\s,]/.test(raw[i]) && !/_{2,}|=/.test(raw[i])))) out[out.length - 1] = prev.replace(/\s+$/, '') + ' ' + raw[i].replace(/^\s+/, '');
    else out.push(raw[i]);
  }
  return out.join('\n');
}
/* a sentence that is an ASK (a question mark, or an asking verb that starts a clause), not a statement that merely contains a noun like "rupture check" or "design strength" */
var ASK_VERB_RE = /(?:^|[.;:!?]\s+|,\s*(?:and\s+|then\s+)?|\b(?:then|and|also|now|first|next)\s+)(?:\([a-h]\)\s*)?(?:please\s+)?(?:find|determine|calculate|compute|select|choose|design|size|check|explain|why|define|list|name|state|describe|express|convert|give|show|verify|compare|what|which|how|is|are|does|do|can|will|would|should)\b/i;
function looksLikeAsk(s) { return /\?/.test(s) || ASK_VERB_RE.test(s) || /\b(?:find|to find|required|determine|asked|question|unknown|compute|calculate|select)\s*:/i.test(s); }
function sentenceList(text) {
  var out = [], lines = joinWrapped(text).split(/\n+/), i, k, bits;
  for (i = 0; i < lines.length; i++) {
    bits = lines[i].replace(/\b(find|to find|required|determine|asked|question|unknown|compute|calculate|select)\s*:\s+/gi, '$1:\u0002')
      .replace(/([?;:])\s+|(\.)\s+(?=[^a-z\s])/g, function (m, a, b) { return (a || b) + '\u0001'; }).split('\u0001');
    for (k = 0; k < bits.length; k++) if (/\S/.test(bits[k])) out.push(trim(bits[k].replace(/\u0002/g, ' ')));
  }
  return out;
}
function asksSomething(F, sentence) {
  var n = F.norm(sentence), qw = (F.DATA && F.DATA.question_words) || [], k;
  for (k = 0; k < qw.length; k++) if (F.hit(qw[k], n)) return true;
  return false;
}
function routeSignature(r) { return [r.fn, r.then_fn, r.combo_first ? 1 : 0, r.family, r.not_in_tool ? 1 : 0, r.tab].join('|'); }

/* The finder's own part splitter gives up when a line BEFORE the first (a) mentions other parts ("Note that Fy is different for parts (d) and (e).":
   the spurious "(e)." swallows the line break that the real "(a)" needs, so no parts are found at all).  Work-around, without touching the finder:
   hide such back-references from it, and when it still finds one part where the lines clearly start (a) (b) ..., split those lines myself. */
var REF_RE = /\b(parts?|problems?|items?|see|repeat)\s+(\([a-h]\)(?:\s*(?:,|and|or|&)\s*\([a-h]\))*)/gi;
function protectRefs(text) { return String(text).replace(REF_RE, function (m, w, chain) { return w + ' ' + chain.replace(/\(([a-h])\)/g, '\u0001$1\u0002'); }); }
function unprotect(s) { return String(s === undefined || s === null ? '' : s).replace(/\u0001([a-h])\u0002/g, '($1)'); }
function lineMarkerSplit(body) {
  var re = /(?:^|\n)[ \t]*\(([a-h])\)[ \t]*/g, marks = [], m, next = 'a', i, end, stem, parts = [];
  while ((m = re.exec(body)) !== null) {
    if (m[1] === next) { marks.push({ ch: m[1], start: m.index + (body.charAt(m.index) === '\n' ? 1 : 0), textStart: m.index + m[0].length }); next = String.fromCharCode(next.charCodeAt(0) + 1); }
  }
  if (marks.length < 2) return null;
  stem = trim(body.slice(0, marks[0].start));
  for (i = 0; i < marks.length; i++) { end = i + 1 < marks.length ? marks[i + 1].start : body.length; parts.push([marks[i].ch, trim(body.slice(marks[i].textStart, end))]); }
  return { stem: stem, parts: parts };
}
function routeText(text) {
  var F = env().FINDER, body = String(text), r = F.route(protectRefs(body)), i, p, sp, rr, out;
  if (r.parts.length <= 1 && !(r.parts[0] && r.parts[0].letter)) {
    sp = lineMarkerSplit(body);
    if (sp) {
      out = [];
      for (i = 0; i < sp.parts.length; i++) { rr = F.identify(protectRefs(sp.stem), protectRefs(sp.parts[i][1])); rr.letter = sp.parts[i][0]; rr.text = sp.parts[i][1]; out.push(rr); }
      return { stem: sp.stem, parts: out, manual: true };
    }
  }
  for (i = 0; i < r.parts.length; i++) { p = r.parts[i]; p.text = unprotect(p.text); }
  r.stem = unprotect(r.stem);
  return r;
}
SOLVE.routeText = routeText;
function shapeCount(E, s) {
  try { if (E.READER && E.READER._internal && E.READER._internal.findShapes) return E.READER._internal.findShapes(String(s)).shapes.length; } catch (e) { /* fall through */ }
  return /\b(?:W|M|S|HP|C|MC|L|WT|MT|ST|HSS)\s?\d+(?:\.\d+)?\s*x\s*\d/i.test(s) ? 1 : 0;
}
/* a part that holds several asks: a list of shapes to look up ("The depth of a W14 x 90. The area of a ..."), or several different questions */
function splitAsks(stem, r) {
  var E = env(), segs = sentenceList(r.text), shapeSegs = [], i, first, pre, subStem, subs = [], rr, askIdx = [], nonAsk = [], sigs, same;
  if (r.family === 'lookup') {
    for (i = 0; i < segs.length; i++) if (shapeCount(E, segs[i]) >= 1) shapeSegs.push(i);
    if (shapeSegs.length >= 2) {
      first = shapeSegs[0];
      pre = segs.slice(0, first).join(' ');
      subStem = trim((stem ? stem + '\n' : '') + pre);
      for (i = 0; i < shapeSegs.length; i++) {
        rr = E.FINDER.identify(subStem, segs[shapeSegs[i]]);
        rr.text = segs[shapeSegs[i]];
        subs.push({ stem: subStem, route: rr });
      }
      for (i = 0; i < subs.length; i++) if (!subs[i].route.fn) return [];
      return subs;
    }
    return [];
  }
  /* an ask sentence counts as a separate ask only when its OWN words name a kind of problem (a member word, or a word question):
     "Select sections for the conditions described ..." and "For all these problems, select sizes ..." are general instructions, not asks */
  var nonAskAll = [], realAsk = [];
  for (i = 0; i < segs.length; i++) {
    if (asksSomething(E.FINDER, segs[i]) && looksLikeAsk(segs[i])) { rr = E.FINDER.identify('', segs[i]); if (rr.fn || rr.family === 'words') realAsk.push(i); else nonAsk.push(segs[i]); }
    else nonAsk.push(segs[i]);
  }
  if (realAsk.length < 2) return [];
  askIdx = realAsk;
  subStem = trim((stem ? stem + '\n' : '') + nonAsk.join(' '));
  for (i = 0; i < askIdx.length; i++) {
    rr = E.FINDER.identify(subStem, segs[askIdx[i]]);
    rr.text = segs[askIdx[i]];
    subs.push({ stem: subStem, route: rr });
  }
  sigs = {};
  for (i = 0; i < subs.length; i++) { sigs[routeSignature(subs[i].route)] = 1; }
  same = Object.keys(sigs).length < 2;
  return same ? [] : subs;
}

/* the chain of calculator forms for one routed part */
function planStages(r) {
  var stages = [];
  if (r.family === 'words') return [{ role: 'words', fn: 'lookup_definition' }];
  if (!r.fn) return [];
  if (r.combo_first && r.fn !== 'loads_combinations') stages.push({ role: 'combo', fn: 'loads_combinations' });
  stages.push({ role: 'main', fn: r.fn });
  if (r.then_fn) stages.push({ role: 'then', fn: r.then_fn });
  return stages;
}

var FIGURE_RE = /\bfig(?:ure|\.)?\s*[A-Za-z]?\d|\bfigure\b|\bas\s+shown\b|\bshown\b|\bsketch\b|\bdiagram\b|\bplan\s+view\b|\bsee\s+below\b|\bthe\s+(?:plan|drawing|picture|image)\s+(?:below|above|shown)\b/i;

function makePart(stem, askText, route, label, defaultsLine, cover, id) {
  var pieces = [], ctx, stemLen, pre, kind, stages, coverLen;
  if (defaultsLine) pieces.push(defaultsLine);
  for (var i = 0; i < cover.length; i++) pieces.push(cover[i]);
  coverLen = pieces.join('\n').length;                 /* the defaults / cover lines at the top of ctx: numbers there are not "the question's own" */
  if (trim(stem)) pieces.push(trim(stem));
  pre = pieces.join('\n');
  stemLen = pre.length ? pre.length + 1 : 0;
  ctx = pre ? pre + '\n' + askText : askText;
  stages = planStages(route);
  kind = route.not_in_tool && route.family !== 'words' ? 'not_in_tool' : (!route.fn && route.family !== 'words' ? 'nomatch' : (route.family === 'words' ? 'words' : 'form'));
  var notIn = [], t;
  for (t = 0; t < route.traps.length; t++) if (route.traps[t].not_in_tool) notIn.push(route.traps[t]);
  var others = [];
  try { if (kind === 'form') others = otherForms(route); } catch (e) { others = []; }
  return { id: id, label: label, text: askText, stem: stem, ctx: ctx, stemLen: stemLen, coverLen: coverLen, route: route, kind: kind, stages: stages === null ? [] : stages, notIn: notIn,
    figure: FIGURE_RE.test(ctx) || hasTrap(route, 'figure'), defaultsLine: defaultsLine, others: others };
}
function hasTrap(route, id) { var i; for (i = 0; i < (route.traps || []).length; i++) if (route.traps[i].id === id) return true; return false; }

/* ------------------------------------------------------------------------------------------------ routes corrected on top of the finder
   Found 10/06 by running the 15 never-seen questions of the REAL May 2024 final of this course through the page: 5 of the 7 in midterm scope went to the wrong
   form.  The finder's rules are frozen with their own tests, so the corrections sit here, each for a plain reason and each tested in run-exam.js. */
var MC_RE = /\(\s*(?:choose|circle|check|pick|select)\s+one\s*\)|\b(?:choose|circle|pick|check)\s+(?:only\s+)?one\b|\bwhich\s+(?:one\s+)?of\s+the\s+following\b|\bselect\s+one\s+of\s+the\s+following\b|\b(?:circle|choose|select|pick)\s+the\s+(?:correct|best|right)\s+(?:answer|choice|one)\b|\bmultiple\s+choice\b/i;
/* the lettered choices of a multiple-choice question, or null: at least two, each short, none of them an instruction ("(a) Find the moment" is a PART).
   The question must SAY it is a choice ("choose one", "which of the following", "circle the correct answer"): a plain "(a) the moment; (b) the lightest W16;
   (c) its phi Mn" is a list of things to work out, and treating it as choices turned two right answers into wrong ones (R1-24, R3-28, 10/06). */
function mcChoices(text) {
  var ch, i, c, words;
  if (!MC_RE.test(String(text || ''))) return null;
  ch = choicesOf(text);
  if (ch.length < 2) return null;
  for (i = 0; i < ch.length; i++) {
    c = String(ch[i].text).replace(/\s*answer\s*:?\s*_*\s*$/i, '').replace(/[_\s]+$/, '');
    words = c.split(/\s+/).filter(Boolean).length;
    if (i < ch.length - 1 && (words > 9 || /[?]/.test(c))) return null;
    if (ASK_VERB_RE.test(c) || /\b(?:find|determine|select|calculate|compute|design|check|what|which|how)\b/i.test(c)) return null;
  }
  return ch;
}
function choicesAreWords(ch) { var i, n = 0; for (i = 0; i < ch.length; i++) if (!/\d/.test(String(ch[i].text).replace(/\b[A-Za-z]{1,3}\d+\b/g, ''))) n++; return n >= Math.ceil(ch.length * 0.75); }
function tabOf(fn) {
  var D = (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {})).STEEL_DATA, k;
  D = D && D.finder;
  if (D && D.tabs) for (k in D.tabs) if (has(D.tabs, k) && D.tabs[k][1] === fn) return { tab: k, page: D.tabs[k][0] };
  return { tab: fn, page: null };
}
function formRoute(route, fn, words, want) {
  var out = copyRouteFor(route, fn), tb = tabOf(fn);
  out.tab = tb.tab; out.page = tb.page; out.want = want || null; out.traps = (route.traps || []).filter(function (t) { return !t.not_in_tool; }); out.not_in_tool = false;
  out.marks = { family: words || [], form: [] }; out.why = ['corrected on top of the finder: ' + (words || []).join(', ')]; out.amended = true;
  out.letter = route.letter; out.text = route.text;
  return out;
}
function wordsRoute(route, words) {
  var out = {}, k;
  for (k in route) if (has(route, k)) out[k] = route[k];
  out.family = 'words'; out.form = 'W-def'; out.tab = 'Definitions'; out.page = 'defs'; out.fn = 'lookup_definition'; out.then = null; out.then_fn = null; out.combo_first = false;
  out.traps = []; out.not_in_tool = false; out.want = 'A definition, a reason, a list'; out.also = []; out.by_default = false; out.clear = true; out.rider = false;
  out.marks = { family: words || [], form: [] }; out.why = ['corrected on top of the finder: ' + (words || []).join(', ')]; out.amended = true;
  return out;
}
function amendRoute(route, askText, stem) {
  var E = env(), t = String(askText || ''), all = String(stem || '') + ' ' + t, m, keep, ch, out, k;
  if (!route) return route;
  /* 1. a multiple-choice question whose choices are WORDS is a word question, whatever member it happens to mention ("... for a column is (choose one): ...") */
  ch = mcChoices(t);
  if (route.family !== 'words' && ch && choicesAreWords(ch)) return wordsRoute(route, ['multiple choice']);
  /* (cloud, holdout C-48) ... and it STAYS one: the rules below never turn it into a calculation.  "(c) the one with Zx closest to required Zx
     (d) a36 steel shape" fell to rule 2 below (the 3 of "a36" read as the required Zx) and printed "ANSWER: Lightest W with Zx >= 36: W16X26" under a
     question whose answer is the letter b. */
  if (route.family === 'words' && ch && choicesAreWords(ch)) return route;
  /* 2. "the required Ix is 3000 in4 ... the lightest section" is a look-up by property, not a beam chosen from a moment.
     (cloud, holdout C-48) The number must stand on its own: a digit glued to a letter ("A36", "a36 steel") is a grade, never the property's value. */
  if (route.fn !== 'lookup_by_property' && (m = /\b(?:required|needed|minimum|necessary)\s+(?:value\s+of\s+)?(I[xy]|Z[xy]|S[xy]|r[xy])\b[^.;0-9]{0,40}?[^A-Za-z0-9.;]\d|\b(I[xy]|S[xy]|r[xy])\s+(?:required|needed|req'?d)\b[^.;0-9]{0,30}?[^A-Za-z0-9.;]\d/i.exec(t))
    && /lightest|economical|section|shape|\bbeam\b|\bW\b/i.test(t) && !/\bM\s?u\s*=|\bkip\s?-?\s?ft\b|\bk\s?-\s?ft\b/i.test(t)) return formRoute(route, 'lookup_by_property', [trim(m[0]).replace(/\s*\d$/, '')], 'The lightest shape that has at least some property');
  /* 3. "KL/r = 100, what is the available (critical, design) stress" with no shape named is the phi Fcr table, not a column's capacity */
  if (route.fn !== 'lookup_critical_stress' && /\bk\s?l\s*\/\s*r\s*(?:=|of|is)\s*\d/i.test(all) && /\b(?:available|critical|design|nominal|allowable)\s+(?:\w+\s+)?stress\b|phi\s*_?\s*c?\s*F\s*_?\s*(?:cr|n)\b|\bF\s?cr\b/i.test(t)
    && shapeCount(E, all) === 0 && !/\bP\s?u\b|\bP\s?n\b|\bhow\s+much\s+(?:axial\s+)?(?:compression\s+)?load\b/i.test(t)) return formRoute(route, 'lookup_critical_stress', ['KL/r', 'stress'], 'Only phi Fcr for a given KL/r');
  /* 4. the moment, the shear and the reactions of a beam do not depend on its lateral bracing: an unbraced length in the text does not make THEM final-exam material */
  if (route.fn === 'beam_analysis' && route.not_in_tool) {
    keep = (route.traps || []).filter(function (x) { return !(x.not_in_tool && /^final-beam/.test(String(x.id))); });
    if (keep.length < (route.traps || []).length && !keep.some(function (x) { return x.not_in_tool; })) {
      out = {}; for (k in route) if (has(route, k)) out[k] = route[k];
      out.traps = keep; out.not_in_tool = false; out.amended = true; out.lbNote = true;
      return out;
    }
  }
  /* 5. (unit D, 10/07) THE LARGEST LIVE LOAD IN WORDS THE FINDER'S SIGNALS MISS.  "W12x53 column KL=14ft D=200k. max L?", "what is the max service live
     load the W12x40 column (KL = 12 ft) can carry if the dead load is 150 k", "determine the max. live load it can support", "the biggest live load", "a W8x24
     tension member ... dead load of 50 kips. max L?" went to the member's capacity alone, and the page printed "ANSWER: phi Pn = 352 kips" -- clean, and not
     what is asked (L = 107.5 kips is).  The finder knows "max live", "maximum service live" ...: the ask is put in those words and the finder chooses again;
     its choice is taken only when it IS a largest-live-load form.  Only beside a dead load or a slab in the words (a reverse calculation has one), never with
     a number after the L (a given), never for a moment, a shear or a deflection of the live load. */
  var r5 = route, m5, rr5;
  if (route.family !== 'words' && !/-maxl$|^L-max$/.test(String(route.form || '')) && (m5 = MAXL_ASK_RE.exec(t)) && /\bdead\b|\bD\s*=\s*\d|\bDL\b|\bslab\b/i.test(all)) {
    rr5 = E.FINDER.identify(stem || '', t.slice(0, m5.index) + ' maximum live load ' + t.slice(m5.index + m5[0].length));
    if (rr5 && /^[CTBF]-maxl$|^L-max$/.test(String(rr5.form || ''))) { rr5.amended = true; rr5.why = (rr5.why || []).concat(['corrected on top of the finder: ' + trim(m5[0])]); r5 = rr5; }
  }
  /* 5b. ... and the member's OWN WEIGHT in the words: the largest-live-load form takes D as typed and does not add it.  "a 20ft long w8x24 hanger, 3/4in
     bolts 2 per flange 3 per line, dead load 40k. include the self weight of the hanger. max service live load?" printed L = 125.75625 kips from D = 40
     (with the hanger's 0.48 kips it is 125.4).  Any mention stops it ("dead load includes the self weight" too: the page cannot tell the two apart),
     unless the words say to neglect it. */
  if (/^[CT]-maxl$|^L-max$/.test(String(r5.form || '')) && MAXL_SELFW_RE.test(all) && !MAXL_NEGLECT_RE.test(all)) return notInRoute(r5, 'maxl-self-weight', MAXL_SELFW_STOP, [MAXL_SELFW_RE.exec(all)[0]]);
  /* 5c. ... and a LIVE LOAD ALREADY GIVEN as a number ("dead load 150 k, live load 50 k. what is the max L it can carry in addition": the form gives the
     whole live load, 107.5, where 57.5 is asked), or the loads given per square foot on a column or a hanger (the form takes D in kips): one sentence. */
  if (/^[CT]-maxl$|^L-max$/.test(String(r5.form || '')) && (MAXL_LIVE_GIVEN_RE.test(all) || MAXL_AREA_RE.test(all))) return notInRoute(r5, 'maxl-given-live', MAXL_GIVEN_STOP, [(MAXL_LIVE_GIVEN_RE.exec(all) || MAXL_AREA_RE.exec(all))[0]]);
  /* 6. (unit D) the largest live load of a BEAM whose loads are given per foot, with no floor: the page's form works it from a floor (slab, psf, beam
     spacing), so "W16x26 spans 20 ft, dead load 0.5 k/ft ... maximum service live load" stopped asking for a spacing the question does not have, and
     "W16x31 ... dead load 0.6 k/ft. max service live load in k/ft" printed "ANSWER: Mu = 60.48 kip-ft".  One plain sentence instead. */
  if (/^[BF]-maxl$/.test(String(r5.form || '')) && /\d\s*(?:k|kips?|lbs?|#)\s*\/\s*(?:ft|foot|')|\d\s*(?:klf|plf)\b/i.test(all)
    && !/psf|\bslab\b|\bspac(?:ed|ing)\b|\bon\s+cent(?:er|re)s?\b|\bo\.\s?c\b|\boc\b|\btributary\b|\bapart\b/i.test(all)) return notInRoute(r5, 'maxl-per-foot', MAXL_PER_FOOT_STOP, [trim(m5 ? m5[0] : 'live load'), 'k/ft']);
  /* 7. (unit D) THE DEAD LOAD ALONE of a floor.  "a floor of 6 in concrete slab and 20 psf finishes, beams 25 ft span spaced 8 ft. what is the factored dead
     load on the beam in k/ft" went to the floor plan, which insists on a live load: he was asked for a number his question does not have (and a 0 typed
     there is factored as 1.4D by the calculator, not her 1.2D).  A floor question that speaks of no live load at all and asks only for a dead load stops
     with one sentence; so does a floor question whose words say there IS no live load ("6 in slab and 20 psf superimposed dead load (dead load only) ...
     find wu": her 1.2D is not what the floor forms print). */
  if ((r5.fn === 'floor_plan' || r5.fn === 'loads_floor') && DEAD_NO_LIVE_RE.test(all)) return notInRoute(r5, 'dead-only', DEAD_NO_LIVE_STOP, [DEAD_NO_LIVE_RE.exec(all)[0]]);
  /* (his full stops come before lower-case words -- "spaced 8ft . whats the factored dead load" -- so the sentences are cut here at every full stop) */
  if ((r5.fn === 'floor_plan' || r5.fn === 'loads_floor') && !/\blive\b|\bLL\b|\bL\s*=|\boccupan|\bsnow\b|\broof\b/i.test(all)) {
    var s7all = t.split(/[.?!;]+\s+|\n+/).filter(function (s7) { return looksLikeAsk(s7) || /\bwhat'?s\b/i.test(s7); }),
      dAsk = s7all.filter(function (s7) { return DEAD_ASK_RE.test(s7); });
    if (dAsk.length && dAsk.length === s7all.length && !dAsk.some(function (s7) { return /\bmoments?\b|\bshears?\b|\breactions?\b|\bselect|\blightest|\bsize\b|\bdesign\b|\bW\s?\d|\bgirders?\b|\bcolumns?\b|\b[MVP]\s?u\b|\bw\s?u\b|\bdeflect|\btotal\s+(?:factored\s+)?load\b/i.test(s7.replace(DEAD_ASK_RE, ' ')); }))
      return notInRoute(r5, 'dead-only', DEAD_ONLY_STOP, [trim(DEAD_ASK_RE.exec(dAsk[0])[0])]);
  }
  return r5;
}
SOLVE.amendRoute = amendRoute;
/* (unit D) the ask of rule 5: max / largest / biggest + up to two of service, unfactored ... + live (load) / LL / L / "service load L" */
var MAXL_ASK_RE = /\b(?:max(?:imum)?\.?|largest|greatest|biggest|highest)\s+(?:(?:service|unfactored|allowable|permissible|safe|additional|uniform|applied|superimposed|axial)\s+){0,2}(?:(?:service|live)\s+loads?\s+L|live(?:\s+loads?)?|LL|L)\b(?!\s*(?:=|is\b|of\b|:)?\s*\d)(?!\s*\/|\s*-?\s*(?:moments?|shears?|deflections?|reactions?|stress|factor|combinations?)\b)/i;
var MAXL_SELFW_RE = /\bself[\s-]?weights?\b|\bown\s+weights?\b|\bweights?\s+of\s+the\s+(?:member|hanger|column|rod|bar|angle|plate|section|shape|tie|strut|channel|tee|pipe)\b/i;
var MAXL_NEGLECT_RE = /\b(?:neglect|ignor|disregard)\w*\b[^.;]{0,40}\b(?:self|own|weight)|\b(?:self[\s-]?weight|own\s+weight)s?\b[^.;]{0,30}\b(?:neglected|ignored|disregarded|negligible)\b/i;
var MAXL_SELFW_STOP = 'Your question speaks of the member\'s own weight, and the page\'s largest-live-load calculation does not add it to the dead load, so it gives no answer to copy here.';
/* (an "L = 14 ft" is the column's length, not a live load) */
var MAXL_LIVE_GIVEN_RE = /\blive(?:\s+loads?)?\s*(?:=|of|is|:)?\s*\d|\bL\s*=\s*\d+(?:\.\d+)?(?!\d|\.\d|\s*-?\s*(?:ft|feet|foot|in\b|inch|'))|\bLL\s*(?:=|of|is|:)?\s*\d|\d\s*(?:k|kips?|psf|plf|klf|k\s*\/\s*ft)\s+(?:of\s+)?live\b/i;
var MAXL_AREA_RE = /psf|sq\.?\s*ft|square\s+f(?:ee|oo)t|ft\s?\^?\s?2\b|\btributary\b/i;
var MAXL_GIVEN_STOP = 'Your question gives a live load already, or its loads per square foot, and the page\'s largest-live-load calculation works only from a service dead load in kips with the live load unknown, so it gives no answer to copy here.';
var MAXL_PER_FOOT_STOP = 'Your question gives the beam\'s loads per foot and no floor, and the page works out the largest live load of a beam only from a floor (slab, loads in psf and the beam spacing), so it gives no answer to copy here.';
/* (unit D) the ask of rule 7: a dead load (or weight), service or factored */
var DEAD_ASK_RE = /\b(?:(?:factored|service|unfactored|total|uniform(?:ly\s+distributed)?|distributed|line)\s+){0,2}dead\s+(?:loads?|weights?)\b/i;
var DEAD_ONLY_STOP = 'Your question asks for the dead load alone, and the page works out a floor only with its live load as well, so it gives no answer to copy here.';
/* (unit D) words that say the floor carries NO live load */
var DEAD_NO_LIVE_RE = /\bno\s+(?:service\s+)?live\b|\bzero\s+live\b|\bwithout\s+(?:any\s+|a\s+)?live\b|\blive\s+loads?\s+(?:is\s+|are\s+)?(?:negligible|neglected|ignored|zero|none)\b|\bdead\s+loads?\s+only\b|\bonly\s+(?:a\s+|the\s+)?dead\s+loads?\b/i;
var DEAD_NO_LIVE_STOP = 'Your question gives the floor a dead load only, and the page works out a floor only with its live load as well, so it gives no answer to copy here.';
/* a route the calculator cannot do, with the one sentence that says why (the part shows "Why: ..." and calculates nothing) */
function notInRoute(route, id, why, words) {
  var out = {}, k;
  for (k in route) if (has(route, k)) out[k] = route[k];
  out.traps = (route.traps || []).concat([{ id: id, when: why, 'do': why, words: words || [], not_in_tool: true }]);
  out.not_in_tool = true; out.amended = true; out.why = (route.why || []).concat(['corrected on top of the finder: ' + id]);
  return out;
}

/* ==================================================================================================== what is ASKED, and which form GIVES it
   COUNCIL 2026-10-06 (OpenAI GPT-6.1, xAI Grok 4.7, DeepSeek v4 Pro; two rounds; data/exam-kits/ARCH-232-midterm/research/council-2026-10-06/).
   The first item of all three members: choose the form by WHAT IS ASKED AND WHAT IS GIVEN, not by wording.
     asked = the answer blank of the question ("Vu = ____ kips", "W____x____", "phi c Fn = ___ ksi"): its symbol and its unit;
     given = whether a form's boxes can be filled from the text and the engine accepts them: a dry run of the page's own reader, gate and engine.
   The finder's choice stands whenever it can be worked out AND gives what the blank asks.  Otherwise every form that gives the asked quantity is tried, and the
   page switches only when exactly one stands out.  No wording is read here: there are no phrase rules.
   Why (the real May 2024 final, 10/06): the page printed "Mu = 360" as the answer to a blank "Vu = ___ kips", and "K = 0.65" to a blank "kL/r = ___". */
var FORM_GIVES = {
  lookup_shape: { main: ['prop', 'ag'], also: [] },
  lookup_by_property: { main: ['shape'], also: [] },
  lookup_material: { main: ['fy', 'fu'], also: [] },
  lookup_U: { main: ['u'], also: [] },
  lookup_K: { main: ['k'], also: [] },
  lookup_critical_stress: { main: ['phifcr'], also: [] },
  lookup_hole: { main: ['hole'], also: [] },
  section_properties: { main: ['prop', 'ag'], also: [] },
  loads_factored: { main: ['pu', 'wu'], also: [] },
  loads_floor: { main: ['wu'], also: [] },
  loads_takedown: { main: ['pu'], also: [] },
  loads_combinations: { main: ['pu', 'wu'], also: [] },
  loads_max_service: { main: ['live'], also: [] },
  beam_analysis: { main: ['mu'], also: ['vu', 'reaction', 'ra', 'rb', 'wu'] },
  beam_capacity: { main: ['phimn'], also: [] },
  beam_required_zx: { main: ['zx'], also: [] },
  beam_select: { main: ['shape'], also: ['phimn', 'mu'] },
  beam_max_live_load: { main: ['live'], also: ['phimn'] },
  floor_plan: { main: ['mu', 'pu', 'shape', 'wu', 'reaction'], also: ['phimn', 'phipn'] },
  column_euler: { main: ['pcr'], also: ['fe', 'klr'] },
  column_capacity: { main: ['phipn'], also: ['klr', 'phifcr'] },
  column_select: { main: ['shape'], also: ['phipn', 'klr'] },
  tension_net_area: { main: ['an'], also: ['ag', 'hole'] },
  tension_capacity: { main: ['phipn'], also: ['an', 'ae', 'ag', 'u', 'klr'] },
  tension_required_area: { main: ['ag'], also: ['ae'] },
  tension_select: { main: ['shape'], also: ['phipn', 'klr'] }
};
/* where a form's result holds each asked quantity (the engine's own names), first match wins */
/* (the floor plan's step2_ / step3_ / step4_ names are NOT here: a floor plan is read member by member, see sigValueFor)
   REVIEW 10/06: Mu_with_self_weight before Mu (the page printed the moment before the beam's own weight); RA and RB are two quantities (it printed RA for a
   blank "RB"); the yielding and the rupture strength of a tension member are two quantities (a blank "phi Pn for yielding" got the governing one). */
var SIG_VALUE = {
  vu: [/^Vu$/, /^Vu_max_both_combinations$/], reaction: [/^RA$/, /^R_wall$/], ra: [/^RA$/, /^R_wall$/], rb: [/^RB$/],
  mu: [/^Mu_with_self_weight$/, /^Mu$/], wu: [/^wu$/, /^w_total$/, /^factored_total$/, /^U_max$/],
  klr: [/^KL_over_r$/, /^L_over_r$/], klrx: [/^KL_over_r_x$/], klry: [/^KL_over_r_y$/], phifcr: [/^phiFcr$/], phipn: [/^phiPn$/, /^capacity$/], phimn: [/^phiMp_printed$/, /^phiMp$/],
  phipn_y: [/^yielding$/], phipn_r: [/^rupture$/],
  an: [/^An$/], ae: [/^Ae$/, /^Ae_required$/], ag: [/^Ag$/, /^Ag_required$/, /^A$/], u: [/^U$/], k: [/^K$/], zx: [/^Zx_required$/, /^Zx$/, /^Z$/],
  shape: [/^selected_shape$/], pu: [/^Pu$/, /^factored_total$/, /^Pu_bottom$/, /^U_max$/],
  live: [/^live_psf$/, /^L_max$/], fe: [/^Fe$/], pcr: [/^Pcr$/], fy: [/^Fy$/], fu: [/^Fu$/], hole: [/^hole$/],
  axis: [/^governing_axis$/], governs: [/^governs$/],
  /* (unit D) the theoretical K of her table, which the K look-up holds beside the design value (see signaturePass) */
  ktheo: [/^K_theoretical$/]
};
var SIG_LABEL = { vu: 'Vu', reaction: 'Reaction', ra: 'RA', rb: 'RB', mu: 'Mu', wu: 'wu', klr: 'KL/r', phifcr: 'phi Fcr', phipn: 'phi Pn', phimn: 'phi Mn', an: 'An', ae: 'Ae', ag: 'Ag', u: 'U', k: 'K',
  zx: 'Zx', shape: 'Shape', pu: 'Pu', live: 'Live load', fe: 'Fe', pcr: 'Pcr', fy: 'Fy', fu: 'Fu', hole: 'Hole size', phipn_y: 'phi Pn (yielding)', phipn_r: 'phi Pn (rupture)',
  pn: 'Pn', mn: 'Mn', fcr: 'Fcr', pn_y: 'Pn (yielding)', pn_r: 'Pn (rupture)', kl: 'KL', klrx: 'KxLx/rx', klry: 'KyLy/ry', deadpsf: 'Dead load', livepsf: 'Live load',
  ktheo: 'K (theoretical)' };
/* REVIEW 10/06: a blank WITHOUT phi asks for the NOMINAL value ("Mp = ___", "Pn = ___", "Fcr = ___"); the forms give the design value.  The page printed the
   design value into such blanks (phi Mp = 240 where Mp = 266.7).  Nominal = design / phi, and only where that phi is one number: columns, beams, the stress
   table, and ONE named limit state of a tension member. */
var SIG_NOMINAL = { pn: ['phipn', 0.9, 'phi Pn', /^column_(?:capacity|select)$/], mn: ['phimn', 0.9, 'phi Mn', /^beam_(?:capacity|select)$/], fcr: ['phifcr', 0.9, 'phi Fcr', /^(?:lookup_critical_stress|column_capacity)$/],
  pn_y: ['phipn_y', 0.9, 'phi Pn (yielding)', /^tension_(?:capacity|select)$/], pn_r: ['phipn_r', 0.75, 'phi Pn (rupture)', /^tension_(?:capacity|select)$/] };
/* a symbol as typed -> the asked quantity.  (Pn without phi, Fn / Fcr with or without phi: the same form gives both.) */
var SIG_SYM = { phipn: 'phipn', pn: 'pn', phimn: 'phimn', phimp: 'phimn', mn: 'mn', mp: 'mp', phifn: 'phifcr', phifcr: 'phifcr', fcr: 'fcr', fn: 'fcr',
  pu: 'pu', mu: 'mu', vu: 'vu', wu: 'wu', 'kl/r': 'klr', klr: 'klr', 'lc/r': 'klr', 'l/r': 'klr', an: 'an', anet: 'an', ae: 'ae', ag: 'ag', agross: 'ag',
  u: 'u', k: 'k', zx: 'zx', zreq: 'zx', zxreq: 'zx', sx: 'sx', sy: 'sy', zy: 'zy', ix: 'ix', iy: 'iy', rx: 'rx', ry: 'ry', tw: 'tw', tf: 'tf', bf: 'bf', fy: 'fy', fu: 'fu',
  qu: 'wu', zxrequired: 'zx', requiredzx: 'zx', zxreqd: 'zx', zxmin: 'zx', zrequired: 'zx',
  wl: 'live', ll: 'live', pcr: 'pcr', pe: 'pcr', fe: 'fe', phivn: 'phivn', vn: 'phivn', phirn: 'phirn', rn: 'phirn', delta: 'defl', deflection: 'defl', ra: 'ra', rb: 'rb' };
var SIG_PROP = { sx: 1, sy: 1, zy: 1, ix: 1, iy: 1, rx: 1, ry: 1, tw: 1, tf: 1, bf: 1 };
/* second-half material: the finder's flag (or its answer) stands, nothing is re-routed */
var SIG_OUT = { phivn: 1, phirn: 1, defl: 1 };
/* when a quantity is given "on the way" by several forms, the usual one first */
var SIG_PREF = { klr: ['column_capacity'], phifcr: ['lookup_critical_stress', 'column_capacity'], an: ['tension_net_area', 'tension_capacity'], ae: ['tension_capacity'], u: ['lookup_U', 'tension_capacity'],
  vu: ['beam_analysis'], reaction: ['beam_analysis'], phipn: ['column_capacity', 'tension_capacity'], phimn: ['beam_capacity'], zx: ['beam_required_zx'], k: ['lookup_K'], pcr: ['column_euler'], fe: ['column_euler'],
  /* (fresh exam 10/06) "A column carries a dead load of 180 kips and a live load of 95 kips ... Pu = ____": two load forms both give it, the plain one first */
  pu: ['loads_factored'], wu: ['loads_factored'] };
var SIG_UNIT_IDS = { kips: ['phipn', 'pu', 'vu', 'reaction', 'pcr', 'live'], ksi: ['phifcr', 'fe', 'fy', 'fu'], kipft: ['mu', 'phimn'], in2: ['an', 'ae', 'ag'], in3: ['zx', 'prop'], in4: ['prop'],
  psf: ['live'], klf: ['wu'], 'in': ['hole', 'prop'] };
/* the longer units first: "kip-ft" is not "kip" */
var SIG_UNIT_RE = /^(kip\s*-?\s*ft|k\s*-\s*ft|ft\s*-?\s*k(?:ips?)?|kip\s*-?\s*in|k\s*-\s*in|k\s*\/\s*ft|kips?\s*\/\s*ft|lbs?\s*\/\s*ft|in\.?\s*\^?\s*[234]|sq\.?\s*in\.?|ksi|kips?|psf|plf|klf|inch(?:es)?|in\.?|feet|ft|k)(?![A-Za-z0-9])/i;
/* the Greek letter phi as he may paste it (three code points), written here by number so that this file stays plain ASCII */
var PHI_ANY_RE = new RegExp('[' + String.fromCharCode(0x3a6) + String.fromCharCode(0x3c6) + String.fromCharCode(0x3d5) + ']', 'g');
function dePhi(s) { return String(s === undefined || s === null ? '' : s).replace(PHI_ANY_RE, ' phi '); }
function sigUnit(u) {
  var s = String(u || '').toLowerCase().replace(/\s+/g, '').replace(/\.$/, '');
  if (!s) return '';
  if (/^(kips?|k)$/.test(s)) return 'kips';
  if (s === 'ksi') return 'ksi';
  if (/^(kip-?ft|k-ft|ft-?k(ips?)?)$/.test(s)) return 'kipft';
  if (/^(kip-?in|k-in)$/.test(s)) return 'kipin';
  if (/^(in\.?\^?2|sq\.?in\.?)$/.test(s)) return 'in2';
  if (/^in\.?\^?3$/.test(s)) return 'in3';
  if (/^in\.?\^?4$/.test(s)) return 'in4';
  if (s === 'psf') return 'psf';
  if (/^(k\/ft|kips?\/ft|klf)$/.test(s)) return 'klf';
  if (/^(plf|lbs?\/ft)$/.test(s)) return 'plf';
  if (/^(in|inch|inches)$/.test(s)) return 'in';
  if (/^(ft|feet)$/.test(s)) return 'ft';
  return '';
}
function sigSymbol(raw, unit) {
  var s = dePhi(raw || '').toLowerCase().replace(/[^a-z0-9\/]+/g, '');
  if (!s) return null;
  s = s.replace(/^phi[cbtv](?=[pmfvr])/, 'phi');                         /* "phi c Pn", "phi b Mn", "phi t Pn" */
  /* REVIEW 10/06: "U = ____ psf" is the factored load U of the load combinations, not the shear lag factor (which has no unit) */
  if (s === 'u' && unit) return unit === 'kips' ? 'pu' : ((unit === 'psf' || unit === 'klf') ? 'wu' : null);
  if (has(SIG_SYM, s)) return SIG_SYM[s];
  if (s === 'l' && (unit === 'psf' || unit === 'kips' || unit === 'klf')) return 'live';
  if (s === 'r' && unit === 'kips') return 'reaction';
  if (s === 'a' && unit === 'in2') return 'ag';
  return null;
}
/* the symbol in front of a blank: the last short tokens of the text before it ("Max service live load WL" -> "WL", "Design strength phi Pn" -> "phi Pn") */
function blankSymbol(left) {
  var t = trim(String(left || '').replace(/[=:]\s*$/, '')), toks, out = [], i, w;
  t = t.split(/[.?!;]\s+|,\s+/).pop();
  toks = trim(t).split(/\s+/);
  for (i = toks.length - 1; i >= 0 && out.length < 3; i--) {
    w = dePhi(toks[i]).replace(/^[(\[]+|[)\],]+$/g, '');
    if (!w) continue;
    if (/^(?:phi|delta)$/i.test(w) || /^(?:K[xy]?)?L[xy]?\/r[xy]?$/.test(w) || (w.length <= 5 && /^[A-Za-z][A-Za-z0-9\/_'.]*$/.test(w)
      && !/^(?:is|are|of|the|to|be|in|an?|and|or|for|at|it|its|use|load|that|this|was|by|as|on|if|so|we|per|max|min|beam|area|shear|force|value|equal|about|total)$/.test(w))) out.unshift(w);   /* lower case only: "An" and "A" are symbols */
    else break;
  }
  return out.join(' ');
}
/* A BLANK NAMED IN WORDS.  Her review problem asks for "the area, the effective area, the yield strength, the rupture strength, the capacity"; a paper may
   print "tensile yielding strength = ____ kips", "Governing KL/r = ____", "Which axis governs? ____" with no symbol at all.  The words in front of the blank
   (its last nine) and its unit name the quantity.  Only used when no symbol was found (10/06 night: of 107 questions written by other labs, the blanks
   named in words got "CHECK YOUR BLANK" or nothing). */
function wordId(left, unit) {
  var w = ' ' + trim(String(left || '').toLowerCase().replace(/[^a-z0-9\/]+/g, ' ')).split(' ').slice(-12).join(' ') + ' ';
  /* A WORD THAT TURNS THE QUANTITY INTO ANOTHER ONE.  "Excess capacity = ____ kips" is not the capacity (the regression dump of 10/07 01:00 caught this
     rule answering 877 kips of strength into a blank that asks for the 189 kips of excess, and taking away the warning that used to stand there);
     "required gross area" is not the shape's area; "nominal strength" has no phi; "hole spacing" is not the hole.  With such a word the page does not
     know the blank, and says so (CHECK YOUR BLANK) instead of handing over the plain quantity. */
  if (/ excess| exceed| remaining| reserve| extra | additional| margin| difference| percent| utili[sz]| unused| shortfall| deficit| allowable| nominal| asd | omega | block shear| per bolt| each bolt| per line| per foot| spacing| pitch| gage | gauge | edge | weight| change in | increase| decrease| reduction in | demand| how many | number of /.test(w)) return null;
  if (/ ratio /.test(w) && !/ slenderness ratio /.test(w)) return null;
  if (/ limit | limits | limiting | maximum allowed| permitted| recommended/.test(w) && !/ limit state/.test(w)) return null;
  if (/ which axis | axis governs | governing axis | axis controls | controlling axis /.test(w)) return 'axis';
  if (!unit && / (?:which|what) (?:limit state|failure mode) | limit state governs | governing limit state | limit state controls /.test(w)) return 'governs';
  /* THE SYMBOL ITSELF, a few words before the blank: "Mu of the beam = ____ kip-ft", "Pu at the bottom = ____ kips" (the symbol rules want it right in front
     of the "=").  Only with the unit that belongs to it; "an" is left out, because it is also a word. */
  if (unit === 'kipft' && / mu /.test(w) && !/ phi /.test(w)) return 'mu';
  if (unit === 'kipft' && / phi (?:mn|mp) /.test(w)) return 'phimn';
  if (unit === 'kips' && / phi pn /.test(w)) return / yield/.test(w) && !/ rupture| fracture/.test(w) ? 'phipn_y' : (/ rupture| fracture/.test(w) && !/ yield/.test(w) ? 'phipn_r' : 'phipn');
  if (unit === 'kips' && / pu /.test(w)) return 'pu';
  if (unit === 'kips' && / vu /.test(w)) return 'vu';
  if (unit === 'klf' && / wu /.test(w)) return 'wu';
  if (unit === 'in2' && / ae /.test(w)) return 'ae';
  if (unit === 'in2' && / ag /.test(w)) return 'ag';
  if (unit === 'kips') {
    if (/ yield/.test(w) && !/ rupture| fracture/.test(w)) return 'phipn_y';
    if (/ rupture| fracture/.test(w) && !/ yield/.test(w)) return 'phipn_r';
    if (/ euler| critical (?:buckling )?load| buckling load/.test(w)) return 'pcr';
    if (/ factored (?:axial |column |tension |tensile |compressive |compression |point |concentrated )?load| ultimate (?:axial |point )?load| required (?:axial |tensile |compressive )?strength| design load/.test(w)) return 'pu';
    if (/ reaction/.test(w)) return 'reaction';
    if (/ shear/.test(w)) return 'vu';
    if (/ capacity| strength/.test(w)) return 'phipn';
  }
  if (unit === 'kipft') {
    /* (the plastic moment Mp = Fy Zx has no phi: it is not the design strength, and is left to the symbol rules) */
    if (/ plastic moment/.test(w)) return null;
    if (/ capacity| strength/.test(w)) return 'phimn';
    if (/ moment/.test(w)) return 'mu';
  }
  if (unit === 'in2') {
    /* an area the member NEEDS is not the area it has */
    if (/ required | minimum | min | needed /.test(w)) return null;
    if (/ effective/.test(w)) return 'ae';
    if (/ net/.test(w)) return 'an';
    if (/ gross| cross sectional area| area of the (?:section|member|shape|plate|angle|channel|tee)| total area/.test(w)) return 'ag';
  }
  if (unit === 'ksi' && / euler| elastic buckling/.test(w) && / stress/.test(w)) return 'fe';
  /* (a bare "critical stress" may mean Fcr without phi; only the words that say DESIGN or AVAILABLE name her table's phi Fcr) */
  if (unit === 'ksi' && / available (?:critical |compressive |buckling )?stress| design (?:critical |compressive |buckling )?stress/.test(w)) return 'phifcr';
  if (unit === 'klf' && / factored| ultimate| design/.test(w)) return 'wu';
  if (!unit) {
    if (/ slenderness| kl\/r | l\/r /.test(w)) return 'klr';
    if (/ shear lag| reduction coefficient/.test(w)) return 'u';
    if (/ effective length factor| k factor| k value/.test(w)) return 'k';
  }
  if (unit === 'in' && / hole (?:diameter|dia|size) | diameter of (?:the |each |a )?(?:bolt )?hole| size of (?:the |each |a )?(?:bolt )?hole| hole to (?:use|deduct)| hole deducted /.test(w)) return 'hole';
  return null;
}
/* A QUESTION WITH NO BLANK.  "Which axis governs and what is the governing KL/r?", "Find the net area and the effective net area." have no answer line to
   say what is asked; the page printed the form's own result (a capacity, for a question about the axis).  Only quantities that are named beyond doubt are
   taken, and only from the asking sentence (the one with which / what / find / determine / calculate / compute / give / state).  Each becomes an asked item
   exactly like a blank, so the answer block gets a line for it.  Nothing is added when the sentence asks for the form's own result anyway. */
var ASK_WORDS = [
  [/\bwhich\s+axis\s+(?:governs|controls)\b|\b(?:governing|controlling|critical)\s+axis\b/i, 'axis', 'which axis governs'],
  [/\b(?:which|what)\s+limit\s+state\s+(?:governs|controls)\b|\bgoverning\s+limit\s+state\b/i, 'governs', 'which limit state governs'],
  [/\b(?:governing|controlling|largest|maximum)?\s*(?:slenderness\s+ratio|K\s?L\s*\/\s*r|L\s*\/\s*r)\b/i, 'klr', 'governing KL/r'],
  [/\beffective\s+(?:net\s+)?(?:cross[\s-]*sectional\s+)?area\b|\bA\s?e\b/, 'ae', 'effective net area Ae'],
  /* ("An" is also an English word: as a symbol it counts only where no noun can follow it -- before a comma, "and", "=", a bracket or the end) */
  [/\bnet\s+area\b|\bA\s?net\b|\bAn\b(?=\s*[,;=)]|\s+and\b|\s*$)/, 'an', 'net area An'],
  [/\bgross\s+area\b|\bA\s?g\b/, 'ag', 'gross area Ag'],
  [/\bshear[\s-]+lag\s+(?:factor|coefficient)\b|\bfactor\s+U\b|\bU\s+factor\b|\bU\b(?=\s*[,;=)]|\s+and\b|\s*$)/, 'u', 'shear lag factor U'],
  [/\b(?:Euler|critical)\s+(?:buckling\s+)?load\b|\bP\s?cr\b/i, 'pcr', 'Euler load Pcr'],
  /* (10/07) THE MAIN QUANTITIES TOO.  With no blank, what the sentence asks for is the only thing that says which calculation is wanted: "Select the
     lightest W14 for Pu = 800 k, KxLx = 30 ft, KyLy = 10 ft" was answered "factored load: 800 kips", and "A W10x54 ... has KxLx = 28 ft, KyLy = 12 ft.
     Determine phi Pn" by nothing at all (both written by another lab's model, both clean).  A symbol followed by "= number" is a GIVEN, not an ask. */
  [/\b(?:lightest|most\s+economical|least[\s-]+weight)\b/i, 'shape', 'the shape to choose'],
  [/\bphi\s*\*?\s*P\s?n\b(?!\s*=\s*\d)|\b(?:design|available)\s+(?:axial\s+|compressive\s+|compression\s+|tensile\s+|tension\s+)?(?:strength|capacity)\b|\b(?:compressive|tensile|axial|tension|compression)\s+(?:design\s+)?(?:strength|capacity)\b/i, 'phipn', 'design strength phi Pn'],
  [/\bphi\s*\*?\s*M\s?[np]\b(?!\s*=\s*\d)|\b(?:design|available)\s+(?:flexural|bending|moment)\s+(?:strength|capacity)\b|\b(?:flexural|bending|moment)\s+(?:design\s+)?(?:strength|capacity)\b/i, 'phimn', 'design moment strength phi Mn'],
  [/\bM\s?u\b(?!\s*=\s*\d)|\b(?:maximum|factored|ultimate)\s+(?:factored\s+|design\s+)?(?:bending\s+)?moment\b/, 'mu', 'factored moment Mu'],
  [/\bV\s?u\b(?!\s*=\s*\d)|\b(?:maximum|factored|ultimate)\s+(?:factored\s+|design\s+)?shear\b/, 'vu', 'factored shear Vu'],
  [/\bP\s?u\b(?!\s*=\s*\d)|\bfactored\s+(?:axial\s+|column\s+|tensile\s+)?load\b|\brequired\s+(?:axial\s+|tensile\s+|compressive\s+)?strength\b/, 'pu', 'factored load Pu'],
  [/\bw\s?u\b(?!\s*=\s*\d)|\bfactored\s+(?:uniform(?:ly\s+distributed)?|line|distributed)\s+load\b/, 'wu', 'factored line load wu'],
  [/\b(?:effective\s+length\s+factor|K\s+factor|K\s+value|design\s+K|value\s+of\s+K|recommended\s+K|theoretical\s+K)\b|\bK\b(?=\s*[,;?)]|\s*$)/, 'k', 'effective length factor K'],
  [/\bhole\s+(?:diameter|size)\b|\b(?:diameter|size)\s+of\s+(?:the\s+|each\s+)?(?:bolt\s+)?holes?\b/i, 'hole', 'hole diameter'],
  [/\bphi\s*\*?\s*F\s?cr\b(?!\s*=\s*\d)|\b(?:design|available)\s+(?:critical|buckling|compressive)\s+stress\b/, 'phifcr', 'design critical stress phi Fcr'],
  [/\bEuler\s+(?:buckling\s+)?stress\b|\belastic\s+buckling\s+stress\b|\bF\s?e\b(?=\s*[,;?)]|\s+and\b|\s*$)/, 'fe', 'Euler stress Fe']
];
/* a sentence that ASKS: it has an asking word ("state" only as a verb: "the governing limit state" asks nothing), or it is a bare list of two or more
   symbols with no number in it ("An, U, Ae and phi Pn with the governing limit state") */
function asksInProse(s) {
  if (/\b(?:which|what|find|determine|calculate|compute|give|report|list|show|select|choose|pick|size|obtain|evaluate|estimate|check|verify)\b|\bstate\s+(?:the|which|whether|your|its)\b|\bdesign\s+(?:a|an|the)\s/i.test(s)) return true;
  if (/\d/.test(s.replace(/\bD3\.1\b|\b4-1[a4]?\b|\b3-2\b/g, ''))) return false;
  return (s.match(/\b(?:An|Ae|Ag|U|Pu|Mu|Pn|Mn|Pcr|Fcr)\b|KL\s*\/\s*r/g) || []).length >= 2;
}
function askedInWords(text) {
  var sens = sentenceList(String(text || '')), out = [], i, j, s, s2, m, seen = {};
  for (i = 0; i < sens.length; i++) {
    s = sens[i];
    if (!asksInProse(s)) continue;
    for (j = 0; j < ASK_WORDS.length; j++) {
      /* "the effective net area" does not also ask for the net area */
      s2 = ASK_WORDS[j][1] === 'an' ? s.replace(/\beffective\s+net\s+(?:cross[\s-]*sectional\s+)?area\b/gi, ' ') : s;
      /* an area the member NEEDS ("Show Ag required") is not the area of the shape: no line for it from here */
      if (/^(?:ag|an|ae)$/.test(ASK_WORDS[j][1]) && /\b(?:required|minimum|needed|necessary)\b/i.test(s)) continue;
      m = ASK_WORDS[j][0].exec(s2);
      if (!m || seen[ASK_WORDS[j][1]]) continue;
      /* a quantity that is followed by its VALUE is a given, not an ask ("to carry a factored axial load of 500 kips", "Using U = 0.80"); and "round the
         governing KL/r up" is an instruction about the table, not a request for the ratio */
      if (/^\s*(?:of|=|is|:|was|equals?)?\s*-?\d/.test(s2.slice(m.index + m[0].length))) continue;
      if (ASK_WORDS[j][1] === 'klr' && /\bround(?:ed|ing)?\b/i.test(s2)) continue;
      seen[ASK_WORDS[j][1]] = 1;
      out.push({ id: ASK_WORDS[j][1], unit: '', raw: ASK_WORDS[j][2], sym: ASK_WORDS[j][2], byWords: true, prose: true, context: trim(s).slice(-40), after: '' });
      /* "the lightest W14": the family and the depth go with the ask, as they do for a "W14 x ____" blank */
      if (ASK_WORDS[j][1] === 'shape') {
        var fm = /\b(?:lightest|economical|weight)\s+(?:available\s+|rolled\s+|steel\s+)?(W|WT|HP|HSS|MC|C|S|M|L)\s?(\d{1,2})\b(?!\s*[xX]\s*\d)/.exec(s2);
        /* (one family only: "the lightest W14 or W16" names two, and the choice may fall in either) */
        var famAll = (s2.match(/\b(?:W|WT|HP|HSS|MC|C|S|M|L)\s?\d{1,2}\b(?!\s*[xX]\s*\d)/g) || []).map(function (x) { return x.replace(/\s+/g, '').toUpperCase(); }).filter(function (x, k9, a9) { return a9.indexOf(x) === k9; });
        if (fm && famAll.length === 1) { out[out.length - 1].family = fm[1].toUpperCase(); out[out.length - 1].depth = Number(fm[2]); out[out.length - 1].raw = 'lightest ' + fm[1].toUpperCase() + fm[2]; }
      }
    }
  }
  /* (an asked thing that is the form's own result is skipped where the lines are written: the form's ANSWER line already is its answer) */
  return out;
}
/* words that ask for the strength itself (or for a choice made by strength): with one of them in the question, the form's own ANSWER line stays an answer */
var STRENGTH_ASK = /\b(?:strengths?|capacity|capacities|adequa\w+|lightest|select\w*|choose|safe(?:ly)?)\b|\bphi\s*\*?\s*[PMRT]\s?n\b|\bhow\s+much\s+(?:load|force|weight)\b|\b(?:maximum|largest|greatest|allowable)\s+(?:factored\s+|service\s+|axial\s+|tensile\s+|live\s+|dead\s+)?(?:load|force)\b|\bcan\s+(?:it|the\s+\w+)\s+(?:carry|support|resist)\b/i;
/* the answer blanks of a text, in order: [{id, unit, raw, family, depth}]   (id null = a blank whose symbol the page does not know) */
function askedBlanks(text) {
  var lines = String(text === undefined || text === null ? '' : text).split(/\n/), out = [], i, ln, m, left, right, um, unit, sym;
  function push(left0, right0, rawText) {
    var um0 = SIG_UNIT_RE.exec(trim(right0).replace(/^[=:]\s*/, '')), unit0 = um0 ? sigUnit(um0[1]) : '', sym0 = blankSymbol(left0), id0 = sigSymbol(sym0, unit0), tk = sym0.split(' '), wid;
    /* "Load WL": when the whole tail is not a symbol the page knows, its last tokens may be */
    while (!id0 && tk.length > 1) { tk.shift(); id0 = sigSymbol(tk.join(' '), unit0); }
    if (!id0) {
      wid = wordId(left0, unit0);
      if (wid) {
        out.push({ id: wid, unit: unit0, raw: trim(rawText).replace(/_{2,}/g, '____'), sym: SIG_LABEL[wid] || wid, byWords: true, context: trim(String(left0 || '')).slice(-40), after: trim(String(right0 || '')).slice(0, 30) });
        return;
      }
    }
    out.push({ id: id0, unit: unit0, raw: id0 ? (tk.join(' ') + ' = ____' + (um0 ? ' ' + trim(um0[1]) : '')) : trim(rawText).replace(/_{2,}/g, '____'), sym: id0 ? tk.join(' ') : sym0,
      context: trim(String(left0 || '')).slice(-40), after: trim(String(right0 || '')).slice(0, 30) });
  }
  for (i = 0; i < lines.length; i++) {
    ln = lines[i];
    /* a shape to fill in: "W12 x ____", "W____x____", or a line that is only "W".  It may share its line with another blank ("phi Mn = ___ kip-ft  W___x___"). */
    var shapeRe = /\b(W|WT|HSS|C|L)\s*(\d{1,2})?\s*x?\s*_{2,}(?:\s*x\s*_{2,})?/g, rest = ln, sm;
    while ((sm = shapeRe.exec(ln)) !== null) out.push({ id: 'shape', unit: '', raw: trim(sm[0]).replace(/_{2,}/g, '____'), family: sm[1], depth: sm[2] ? Number(sm[2]) : null,
      context: trim(ln.slice(0, sm.index)).slice(-40) });
    rest = ln.replace(shapeRe, ' ');
    if ((m = /^\s*(W)\s*(\d{1,2})?\s*x?\s*$/.exec(ln))) { out.push({ id: 'shape', unit: '', raw: trim(ln), family: m[1], depth: m[2] ? Number(m[2]) : null }); continue; }
    if (/_{2,}/.test(rest)) {
      /* every blank of the line: the words before it (back to the blank before) name it, the words after it hold its unit */
      var bits = rest.split(/_{2,}/), b2;
      for (b2 = 0; b2 < bits.length - 1; b2++) push(bits[b2], bits[b2 + 1], trim(bits[b2]).split(/[.?!;]\s+/).pop() + ' ____ ' + trim(bits[b2 + 1]).split(/\s+/).slice(0, 2).join(' '));
      continue;
    }
    /* blanks left empty: "Pu = kips   W10 x ____   phi Pn = kips" -- a symbol, "=", and then a unit instead of a number */
    var emptyRe = /([A-Za-z][A-Za-z0-9\/ ]{0,14}?)\s*=\s*(kip\s*-?\s*ft|k-ft|k\/ft|kips?\/ft|in\.?\^?[234]|ksi|kips?|psf|plf|klf|ft|in)\b(?!\s*[\d=])/g, em, found = 0;
    while ((em = emptyRe.exec(rest)) !== null) { push(em[1], em[2], trim(em[0])); found++; }
    if (!found && (m = /^(.{0,70}?)=\s*\??\s*$/.exec(rest))) push(m[1], '', rest);
  }
  return out;
}
SOLVE.askedBlanks = askedBlanks;
function sigGives(fn, id) {
  var g = FORM_GIVES[fn], key = has(SIG_PROP, id) ? 'prop' : id;
  if (!g) return 0;
  if (has(SIG_NOMINAL, id)) return SIG_NOMINAL[id][3].test(fn) ? 1 : 0;
  if (id === 'mp') return fn === 'beam_capacity' ? 1 : 0;
  if (id === 'phipn_y' || id === 'phipn_r') return /^tension_(?:capacity|select)$/.test(fn) ? 1 : 0;
  if (id === 'axis') return fn === 'column_capacity' ? 1 : 0;
  if (id === 'governs') return fn === 'tension_capacity' ? 1 : 0;
  if (g.main.indexOf(key) >= 0) return 2;
  if (g.also.indexOf(key) >= 0) return 1;
  /* a look-up of a shape gives any one property of it: Zx and A included */
  if (fn === 'lookup_shape' && (id === 'zx' || id === 'ag')) return 2;
  return 0;
}
/* the value of an asked quantity in a finished run: { key, value, unit } or null (the last stage that holds it) */
function sigValue(run, id) {
  var si, res, keys, k, r, list = has(SIG_PROP, id) ? [new RegExp('^' + id + '$', 'i')] : (SIG_VALUE[id] || []), dn, nm;
  if (!run || !run.stages) return null;
  if (has(SIG_NOMINAL, id)) {
    nm = SIG_NOMINAL[id]; dn = sigValue(run, nm[0]);
    if (!dn || typeof dn.value !== 'number' || !run.stages[dn.stage] || !nm[3].test(String(run.stages[dn.stage].fn))) return null;
    return { key: dn.key, value: dn.value / nm[1], unit: dn.unit, stage: dn.stage, nominal: { phi: nm[1], design: dn.value, label: nm[2] } };
  }
  if (id === 'mp') {
    /* REVIEW 2: the PLASTIC moment is Fy Zx exactly; the table's phi Mp of a shape whose flange is not compact is smaller (W14x90: 637.78 was printed for 654.17) */
    for (si = run.stages.length - 1; si >= 0; si--) {
      res = run.stages[si] && run.stages[si].res;
      if (res && res.ok && res.values && res.values.Zx && isNum(res.values.Zx.value)) {
        var fy0 = run.stages[si].args && isNum(run.stages[si].args.Fy) ? Number(run.stages[si].args.Fy) : 50;
        return { key: 'Zx', value: fy0 * Number(res.values.Zx.value) / 12, unit: 'kip-ft', stage: si, mp: { Fy: fy0, Zx: Number(res.values.Zx.value) } };
      }
    }
    return null;
  }
  if (id === 'reaction') {
    /* "R = ____": one number only when the two reactions are the same */
    for (si = run.stages.length - 1; si >= 0; si--) {
      res = run.stages[si] && run.stages[si].res;
      if (res && res.ok && res.values && res.values.RA && res.values.RB && isNum(res.values.RA.value) && isNum(res.values.RB.value)
        && Math.abs(Number(res.values.RA.value) - Number(res.values.RB.value)) > 1e-6 * Math.max(1, Math.abs(Number(res.values.RA.value)))) return null;
    }
  }
  for (si = run.stages.length - 1; si >= 0; si--) {
    res = run.stages[si] && run.stages[si].res;
    if (!res || !res.ok || !res.values) continue;
    keys = Object.keys(res.values);
    for (r = 0; r < list.length; r++) for (k = 0; k < keys.length; k++) {
      if (list[r].test(keys[k]) && res.values[keys[k]] && res.values[keys[k]].value !== undefined && res.values[keys[k]].value !== null && res.values[keys[k]].value !== '') return { key: keys[k], value: res.values[keys[k]].value, unit: res.values[keys[k]].unit || '', stage: si };
    }
  }
  return null;
}
SOLVE.sigValue = sigValue;
function sigValueKeys(run, list) {
  var si, res, keys, k, r;
  if (!run || !run.stages) return null;
  for (si = run.stages.length - 1; si >= 0; si--) {
    res = run.stages[si] && run.stages[si].res;
    if (!res || !res.ok || !res.values) continue;
    keys = Object.keys(res.values);
    for (r = 0; r < list.length; r++) for (k = 0; k < keys.length; k++) {
      if (list[r].test(keys[k]) && res.values[keys[k]] && res.values[keys[k]].value !== undefined && res.values[keys[k]].value !== null && res.values[keys[k]].value !== '') return { key: keys[k], value: res.values[keys[k]].value, unit: res.values[keys[k]].unit || '', stage: si };
    }
  }
  return null;
}
function sigFamily(fn) { return /^tension_|^lookup_U$|^lookup_hole$/.test(fn) ? 'tension' : (/^column_|^lookup_K$|^lookup_critical_stress$/.test(fn) ? 'column' : (/^beam_/.test(fn) ? 'beam' : (fn === 'floor_plan' ? 'floor' : (/^loads_/.test(fn) ? 'loads' : 'lookup')))); }
/* a form of one kind of member is not offered for a text that names only another kind */
function sigConflict(fn, text) {
  var t = String(text || ''), fam = sigFamily(fn),
    T = /\btension|tensile|\bhanger|\btie\s+(?:rod|member)|net\s+area|shear\s+lag|rupture/i.test(t),
    C = /\bcolumns?\b|compress|buckl|slender|k\s?l\s*\/\s*r|\bstrut|\beuler/i.test(t),
    B = /\bbeams?\b|girder|joist|flexur|bending|\bmoment|lintel/i.test(t);
  if (fn === 'column_euler' && !/euler|elastic\s+buckling|\bP\s?cr\b|\bP\s?e\b|critical\s+(?:buckling\s+)?load/i.test(t)) return true;
  if (fam === 'tension') return (C || B) && !T;
  if (fam === 'column') return (T || B) && !C;
  if (fam === 'beam') return (T || C) && !B;
  return false;
}
/* one part taken through the page's own steps with nothing pressed: read (rules only) -> first values -> carry from the parts before -> gate -> engine */
function dryPart(parts, pi) {
  var part = parts[pi], vals = {}, si, gate, kinds = {}, run;
  if (part.kind === 'not_in_tool') return { status: 'notin' };
  if (part.kind === 'nomatch') return { status: 'nomatch' };
  if (part.kind === 'error') return { status: 'error' };
  for (si = 0; si < part.stages.length; si++) SOLVE.readStage(part, si, {}, function () { /* rules only */ });
  if (part.kind === 'error') return { status: 'error' };
  for (si = 0; si < part.stages.length; si++) vals[si] = SOLVE.initialValues(part.stages[si]);
  part.ui = { vals: vals, run: null };
  try { SOLVE.carryAcross(parts, pi, vals); } catch (e) { /* as the page */ }
  gate = SOLVE.gate(part, vals, { figure: false, unused: false, unusedChoices: {} });
  gate.forEach(function (g) { kinds[g.kind] = 1; });
  if (kinds.required || kinds.conflict) return { status: 'needs', gate: gate, vals: vals };
  if (kinds.unused || kinds.unusedgroup) return { status: 'asks', gate: gate, vals: vals };
  try { run = SOLVE.runPart(part, vals); } catch (e2) { return { status: 'error' }; }
  if (!run.ok) return { status: 'refused', run: run, gate: gate, vals: vals };
  part.ui.run = run;
  return { status: part.kind === 'words' ? 'words' : (kinds.figure ? 'figure' : 'answered'), run: run, gate: gate, vals: vals };
}
SOLVE.dryPart = dryPart;
function sigWant(fn) {
  var D = (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {})).STEEL_DATA, fam, i, f;
  D = D && D.finder;
  var first = null;
  if (D && D.forms && D.tabs) for (fam in D.forms) if (has(D.forms, fam)) for (i = 0; i < D.forms[fam].length; i++) {
    f = D.forms[fam][i];
    if (!(D.tabs[f.tab] && D.tabs[f.tab][1] === fn && f.want)) continue;
    if (!/maxl|-dem$|-pu$|-take-sel$|2$/.test(String(f.id))) return f.want;      /* the form's general entry */
    if (first === null) first = f.want;
  }
  return first;
}
function sigFamilyForms(family) {
  var D = (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {})).STEEL_DATA, out = [], i, fn;
  D = D && D.finder;
  if (D && D.forms && D.forms[family]) for (i = 0; i < D.forms[family].length; i++) { fn = D.tabs[D.forms[family][i].tab] && D.tabs[D.forms[family][i].tab][1]; if (fn && out.indexOf(fn) < 0) out.push(fn); }
  return out;
}
function curOk0(d) { return !!d && (d.status === 'answered' || d.status === 'figure'); }
/* which member of a floor plan some words are about: only when they name exactly one kind */
function floorWho(x) {
  var g = /\bG\s?\d\b|\bgirders?\b/i.test(x), bm = /\bB\s?\d\b|\bbeams?\b/i.test(x), c = /\bC\s?\d\b|\bcolumns?\b/i.test(x);
  return (g ? 1 : 0) + (bm ? 1 : 0) + (c ? 1 : 0) === 1 ? (g ? 'girder' : (bm ? 'beam' : 'column')) : null;
}
/* the member a blank asks about: its own words first, then the sentence that asks ("Determine the design moment Mu for beam B1"), then the whole part */
function floorMember(part, b) {
  /* A sentence asks when it still looks like an ask with its ", which ..." clause taken out ("Beams frame into both sides of each interior girder, which spans
     24 ft" is a description: it was taken for the ask, and a blank for the GIRDER's shear was answered with the beam's, 22.98 for 45.96).
     The asks are tried from the one nearest the answer blank backwards, those that name the blank's own quantity first. */
  var QW = { mu: /\bMu\b|\bmoments?\b/i, vu: /\bVu\b|\bshears?\b/i, wu: /\bwu\b|\buniform\b|\bloads?\b/i, reaction: /\breactions?\b|\bforces?\b|\bR\b/i, ra: /\breactions?\b|\bforces?\b|\bRA\b/i,
    rb: /\breactions?\b|\bforces?\b|\bRB\b/i, phimn: /\bMn\b|\bstrength\b|\bcapacity\b/i, shape: /\b(?:select|size|design|choose|lightest|section|shape)\b/i, pu: /\bPu\b|\baxial\b|\bloads?\b/i };
  var t = String(part.text || ''), m, i,
    asks0 = sentenceList(t).filter(function (x) { return looksLikeAsk(x.replace(/,\s*(?:which|that|who)\b[^,.;?]*/gi, ' ')); }).reverse(),
    qre = QW[b.id] || null,
    asks = (qre ? asks0.filter(function (x) { return qre.test(x); }) : []).concat(asks0);
  /* the blank's own line first: the words before it ("B1: Mu = ___"), then the words after it ("Mu = ___ kip-ft for G1") */
  m = floorWho(String(b.context || '')) || floorWho(String(b.after || ''));
  /* REVIEW 1 + 2: "the reaction of beam B1 on the girder", "the force that beam B1 exerts on girder G1": the quantity belongs to the FIRST member named in the
     asking sentence, unless that member only receives it ("... on the girder", "... into the column") */
  function firstMember(sen) {
    var re = /\b(beam|girder|column)s?\b|\b(B|G|C)\s?\d\b/gi, mm, pre, fallback = null, who;
    while ((mm = re.exec(sen)) !== null) {
      who = mm[1] ? mm[1].toLowerCase() : ({ B: 'beam', G: 'girder', C: 'column' })[mm[2].toUpperCase()];
      pre = sen.slice(Math.max(0, mm.index - 14), mm.index);
      if (/\b(?:on|onto|into|to|upon|between)\s+(?:the\s+|each\s+|an?\s+)?$/i.test(pre)) { if (!fallback) fallback = who; continue; }
      return who;
    }
    return fallback;
  }
  for (i = 0; !m && i < asks.length; i++) m = floorWho(asks[i]) || firstMember(asks[i]);
  return m || floorWho(t);
}
/* In a floor plan the same symbol belongs to the beam, to the girder or to the column: the member is taken from the blank's own words, then from the part's;
   when neither says which, no value is offered (null) rather than the wrong member's. */
/* REVIEW 10/06: the unit of the blank and the unit of the value must agree ("wu = ____ psf" was answered with 1.472 k/ft) */
function sigValueFor(part, run, b) {
  var v = sigValueFor0(part, run, b), vu;
  if (!v) return null;
  vu = v.unit ? sigUnit(v.unit) : '';
  if (b.unit && vu && vu !== b.unit) {
    /* REVIEW 2: the same quantity in the blank's own unit ("wu = ____ lb/ft", "Mu = ____ kip-in"); any other mismatch is not an answer */
    if (typeof v.value !== 'number') return null;
    if (vu === 'klf' && b.unit === 'plf') return { key: v.key, value: v.value * 1000, unit: 'lb/ft', stage: v.stage, member: v.member, converted: v.value + ' k/ft x 1000' };
    if (vu === 'plf' && b.unit === 'klf') return { key: v.key, value: v.value / 1000, unit: 'k/ft', stage: v.stage, member: v.member, converted: v.value + ' lb/ft / 1000' };
    if (vu === 'kipft' && b.unit === 'kipin') return { key: v.key, value: v.value * 12, unit: 'kip-in', stage: v.stage, member: v.member, converted: v.value + ' kip-ft x 12' };
    if (vu === 'kipin' && b.unit === 'kipft') return { key: v.key, value: v.value / 12, unit: 'kip-ft', stage: v.stage, member: v.member, converted: v.value + ' kip-in / 12' };
    return null;
  }
  return v;
}
function sigValueFor0(part, run, b) {
  var fns = (part.stages || []).map(function (s) { return s.fn; }), lastFn = fns.length ? fns[fns.length - 1] : null, t, member = null, map, list, si, res, k, keys;
  if (b.id === 'wu' && b.unit === 'psf') { var fp = sigValueKeys(run, [/^step1_factored_psf$/, /^factored_psf$/]); return fp; }
  if (b.id === 'kl') {
    /* only ever set for a K lookup with ONE length in the question (see signaturePass): KL = K x L */
    var kv = sigValue(run, 'k');
    if (lastFn !== 'lookup_K' || !kv || typeof kv.value !== 'number' || !isNum(b.len)) return null;
    return { key: 'KL', value: Math.round(kv.value * Number(b.len) * 1000) / 1000, unit: 'ft', stage: kv.stage, converted: 'K x L = ' + sigNum(kv.value) + ' x ' + sigNum(Number(b.len)) };
  }
  if (lastFn !== 'floor_plan') return sigValue(run, b.id);
  /* the floor's own loads (step 1): they belong to no member */
  if (b.id === 'deadpsf') return sigValueKeys(run, [/^step1_dead_psf$/]);
  if (b.id === 'livepsf' || (b.id === 'live' && b.unit === 'psf')) return sigValueKeys(run, [/^step1_live_psf$/]);
  member = floorMember(part, b);
  if (!member) return null;
  map = { beam: { mu: [/^step2_Mu_with_self_weight$/, /^step2_Mu$/], phimn: [/^step2_beam_phiMp$/], shape: [/^step2_beam_shape$/], wu: [/^step2_wu$/], reaction: [/^step2_beam_reaction$/], vu: [/^step2_beam_reaction$/],
      ra: [/^step2_beam_reaction$/], rb: [/^step2_beam_reaction$/] },
    girder: { mu: [/^step3_Mu_with_self_weight$/, /^step3_Mu$/], phimn: [/^step3_girder_phiMp$/], shape: [/^step3_girder_shape$/], reaction: [/^step3_girder_reaction$/], vu: [/^step3_girder_reaction$/],
      pu: [/^step3_point_load$/] },
    column: { pu: [/^step4_Pu$/], phipn: [/^step4_phiPn$/], shape: [/^step4_selected_shape$/], klr: [/^step4_KL_over_r$/] } };
  list = map[member][b.id];
  if (!list) return null;
  for (si = run.stages.length - 1; si >= 0; si--) {
    res = run.stages[si] && run.stages[si].res;
    if (!res || !res.ok || !res.values) continue;
    keys = Object.keys(res.values);
    for (k = 0; k < list.length; k++) for (t = 0; t < keys.length; t++) if (list[k].test(keys[t]) && res.values[keys[t]] && res.values[keys[t]].value !== undefined && res.values[keys[t]].value !== null && res.values[keys[t]].value !== '') return { key: keys[t], value: res.values[keys[t]].value, unit: res.values[keys[t]].unit || '', stage: si, member: member };
  }
  return null;
}
/* how many numbers-with-a-unit of the question went into NO box of this part (the reader's own list, whatever kind of number it is) */
/* (builder's switch: set SIGDBG=1 in the environment of a node run to see why each form was or was not taken; the browser has no process object) */
var SIGDBG = typeof process !== 'undefined' && !!(process.env && process.env.SIGDBG);
function sigUnplaced(part) {
  var n = 0, si, st;
  /* (a stated property of the named shape that IS the Manual's value is not unplaced: see givenShapeProp) */
  for (si = 0; si < (part.stages || []).length; si++) {
    st = part.stages[si];
    if (st.read && st.read.unplaced) n += st.read.unplaced.filter(function (u) { return !givenShapeProp(part, typeof u === 'string' ? u : (u && u.text) || ''); }).length;
  }
  return n;
}
/* parts = the parts of one question, in order.  cover = its cover lines.  body = its whole text (a one-part question may have its blank outside the part's text). */
function signaturePass(parts, cover, body) {
  var i, k, part, blanks, known, cur, curOk, fns, lastFn, curScore, cands, fn, p2, d2, feas, best, second, score, all, unknownUnit, label, old, why, fam;
  for (i = 0; i < parts.length; i++) {
    part = parts[i];
    try {
      blanks = askedBlanks(part.text);
      if (!blanks.length && parts.length === 1) blanks = askedBlanks(body);
      /* no blank at all: what the SENTENCE asks for ("Which axis governs and what is the governing KL/r?") */
      if (!blanks.length) blanks = askedInWords(part.text);
      /* (10/07) asks that stand in a sentence of their own BESIDE the blanks ("W10x____. Show Ag required and the L/r check."): extra answer lines
         only -- they never choose the form and never flag anything */
      else { try { part.alsoAsked = askedInWords(sentenceList(String(part.text || '')).filter(function (s0) { return !/_{2,}/.test(s0); }).join(' . ')); } catch (eAA) { part.alsoAsked = []; } }
      /* Two blanks the value-graded mock exam showed with NO line at all (10/06):
           "Ru = ____ kips" under "The factored end reaction of B1": Ru is the required strength, and here the part's own words say it is a reaction;
           "K = ____   KL = ____ ft" on a question that only asks for K: KL is K times the ONE length the question gives.
         Both only in exactly that situation; a bare Ru, or a KL with two lengths in the text, stays a blank the page does not claim to know. */
      (function () {
        var fn0 = (part.stages || []).length ? part.stages[part.stages.length - 1].fn : null, own0 = String(part.text || ''),
          own1 = String(part.ctx || own0).slice(part.coverLen || 0);
        blanks.forEach(function (b) {
          /* the symbol is the LAST word in front of the blank: on a line of several blanks the unit of the blank before it comes along ("psf live") */
          var symLast = trim(String(b.sym || '')).split(/\s+/).pop() || '',
            s0 = symLast.replace(/[^A-Za-z]/g, '').toLowerCase(), lens = [], lm, lre = /(\d+(?:\.\d+)?)\s*-?\s*(?:ft|feet|foot)\b(?!\s*\^?\s*[23])/gi,
            s1 = symLast;
          /* "KxLx/rx = ____   KyLy/ry = ____" on a column whose capacity the page works out: the slenderness about EACH axis is a value of that form */
          if (fn0 === 'column_capacity' && (!b.id || b.id === 'klr') && !b.unit) {
            if (/^(?:Kx)?Lx\/rx$|^KL\/rx$/.test(s1)) { b.id = 'klrx'; b.raw = s1 + ' = ____'; return; }
            if (/^(?:Ky)?Ly\/ry$|^KL\/ry$/.test(s1)) { b.id = 'klry'; b.raw = s1 + ' = ____'; return; }
          }
          /* "dead = ____ psf   live = ____ psf   wu = ____ psf" on a floor plan: step 1 of the worksheet has both */
          if (!b.id && fn0 === 'floor_plan' && b.unit === 'psf') {
            if (s0 === 'dead' || s0 === 'wd' || s0 === 'd') { b.id = 'deadpsf'; b.raw = String(b.sym || 'dead') + ' = ____ psf'; return; }
            if (s0 === 'live') { b.id = 'livepsf'; b.raw = 'live = ____ psf'; return; }
          }
          if (b.id) return;
          if (s0 === 'ru' && b.unit === 'kips' && /\breactions?\b/i.test(own0)) { b.id = 'reaction'; b.raw = 'Ru = ____ kips'; }
          else if (s0 === 'kl' && fn0 === 'lookup_K' && (b.unit === 'ft' || !b.unit)) {
            while ((lm = lre.exec(own1)) !== null) if (lens.indexOf(Number(lm[1])) < 0) lens.push(Number(lm[1]));
            if (lens.length === 1) { b.id = 'kl'; b.raw = 'KL = ____ ft'; b.len = lens[0]; }
          }
        });
        /* (unit D) THE THEORETICAL K.  "what is the theoretical K value for a fixed-pinned column? ____ and the recommended design value ____" printed
           only "ANSWER: K = 0.8", under which the theoretical blank (0.7) read as answered; "what is the theoretical K for a column fixed at both ends"
           stopped.  The K look-up holds both values of her table: a blank or an ask that says "theoretical" gets the theoretical one (ktheo), one that
           says "recommended" or "design" the design one; when the part says only "theoretical", every K blank is the theoretical one (a KL blank, worked
           from the design K, is then not known), a line for it is always there, and the design K is not the answer (writeBlock: theoOnly).  A blank
           whose own words say both, or neither while the part says both, is a blank the page does not know. */
        if (fn0 === 'lookup_K') {
          /* ("use the recommended value, not the theoretical, for design" does not ask for the theoretical one; "what is the theoretical K" beside it does) */
          var NOT_THEO = /\b(?:not|rather\s+than|instead\s+of)\s+(?:the\s+|a\s+)?theoretical\b/gi, tSrc = /\btheoretical\b|\brecommended\b|\bdesign\b/i.test(own0) ? own0 : own1,
            theo = /\btheoretical\b/i.test(tSrc.replace(NOT_THEO, ' ')), rec = /\brecommended\b|\bdesign\b/i.test(tSrc);
          /* NOT when the part asks for something made FROM a K -- an effective length ("using the theoretical K, what is the effective length", "what is KL"),
             a ratio, a comparison, a reason -- or gives the theoretical K as a number: a K line there answers what is not asked (the old stop stands) */
          if (theo && !/\bK\s?L\b(?!\s*\/)|\beffective\s+length\b(?!\s+factor)|\bratio\b|\bdifferen|\bcompar|\bwhy\b|\bexplain|\bdescrib|\btheoretical\s+(?:value\s+(?:of\s+)?)?K\s*(?:=|is|of|equals?)\s*\d/i.test(tSrc)) {
            blanks.concat(part.alsoAsked || []).forEach(function (b) {
              /* (its own words: the text in front of the blank as typed -- the 40-letter context alone cut "theoretical" in half) */
              var c = (/_{2,}/.test(String(b.raw || '')) ? String(b.raw).split(/_{2,}/)[0] : '') + ' ' + String(b.context || ''), ct = /\btheoretical\b/i.test(c.replace(NOT_THEO, ' ')), cr = /\brecommended\b|\bdesign\b/i.test(c);
              if (!rec) { if (b.id === 'k' || (!b.id && !b.unit && ct)) { b.id = 'ktheo'; if (b.prose) b.raw = b.sym = 'theoretical K'; } else if (b.id === 'kl') b.id = null; return; }
              if (b.prose) return;
              if ((b.id === 'k' || !b.id) && !b.unit) { if (ct && !cr) b.id = 'ktheo'; else if (cr && !ct) b.id = 'k'; else if (b.id === 'k') b.id = null; }
              else if (b.id === 'kl') b.id = null;
            });
            if (!blanks.concat(part.alsoAsked || []).some(function (b) { return b.id === 'ktheo'; }) && (!rec || blanks.some(function (b) { return b.prose && b.id === 'k'; })))
              blanks.push({ id: 'ktheo', unit: '', raw: 'theoretical K', sym: 'theoretical K', byWords: true, prose: true, context: '', after: '' });
            part.theoLine = true; part.theoOnly = !rec;
          }
        }
      })();
      known = blanks.filter(function (b) { return !!b.id; });
      /* REVIEW 10/06: "phi Pn for yielding" / "based on gross section yielding" / "for rupture" asks for ONE limit state of a tension member */
      (function () {
        var own = String(part.text || ''), fam0 = part.route && part.route.family, ls = null,
          y = /\b(?:for|in|by|of|against|on|from|considering)\s+(?:the\s+)?(?:limit\s+state\s+of\s+)?(?:tensile\s+|gross[\s-]*section\s+|gross\s+)?yielding\b|\byielding\s+(?:limit\s+state|strength|capacity|only)\b|gross[\s-]*section\s+yield/i.test(own),
          r = /\b(?:for|in|by|of|against|on|from|considering)\s+(?:the\s+)?(?:limit\s+state\s+of\s+)?(?:tensile\s+|net[\s-]*section\s+|net\s+)?(?:rupture|fracture)\b|\b(?:rupture|fracture)\s+(?:limit\s+state|strength|capacity|only)\b|net[\s-]*section\s+(?:rupture|fracture)/i.test(own);
        /* REVIEW 2: one limit state only when the OTHER word is nowhere in the question ("for yielding and rupture" printed the yielding value) */
        var yAny = /\byielding\b|gross[\s-]*section\s+yield/i.test(own), rAny = /\b(?:rupture|fracture)\b/i.test(own);
        if (y && !rAny) ls = 'y'; else if (r && !yAny) ls = 'r';
        if (ls && (fam0 === 'tension' || /\btension|tensile/i.test(own))) known.forEach(function (b) { if (b.id === 'phipn') b.id = 'phipn_' + ls; else if (b.id === 'pn') b.id = 'pn_' + ls; });
      })();
      part.asked = known; part.blankCount = blanks.length; part.unknownBlanks = blanks.filter(function (b0) { return !b0.id; }).map(function (b0) { return b0.raw; });
      cur = dryPart(parts, i);
      if (part.kind === 'words' || part.kind === 'error') continue;
      if (known.some(function (b) { return has(SIG_OUT, b.id); })) continue;
      curOk = cur.status === 'answered' || cur.status === 'figure';
      fns = (part.stages || []).map(function (s) { return s.fn; });
      lastFn = fns.length ? fns[fns.length - 1] : null;
      curScore = known.length ? Math.min.apply(null, known.map(function (b) {
        var s = 0, q;
        for (q = 0; q < fns.length; q++) s = Math.max(s, q === fns.length - 1 ? sigGives(fns[q], b.id) : Math.min(1, sigGives(fns[q], b.id)));
        /* a quantity the finished run really holds counts as given on the way, whatever the table above says (Pu worked out from D and L inside a selection) */
        if (!s && curOk0(cur) && sigValueFor(part, cur.run, b) !== null) s = 1;
        b.curGives = s;
        return s;
      })) : 1;
      /* ASKS READ FROM A SENTENCE (no blank) are weaker evidence than a blank: "Find: Euler Pcr, the AISC phi Pn, and why they differ" asks two things
         that no one form gives, and "The capacity Pu = phi Pn" names Pu without asking for a load.  (The regression dump of 10/07 01:15 caught the page
         printing "NOT WHAT YOUR BLANK ASKS ... do NOT copy" under four RIGHT answers of her own review and class problems.)  So for such asks:
         a part that is worked out and gives AT LEAST ONE of the things named stays as it is, and no part is ever flagged for them. */
      var proseOnly = known.length > 0 && known.every(function (b) { return b.prose; });
      if (proseOnly && curOk && known.some(function (b) { return b.curGives > 0; })) continue;
      /* REVIEW 10/06: a floor plan is never left for a single-member form and never flagged.  A stopped floor plan was re-chosen as "beam analysis" and printed
         a reaction of 1.05 kips where 22.98 is right: the other form could not even see the slab and the psf loads. */
      /* ONE way out is kept, because it is the same arithmetic: a stopped floor plan whose blank asks only for the load wu may be worked as "floor load to
         line load" (no span needed) -- and only when that form takes every number of the question (a given beam weight in lb/ft keeps it a floor plan). */
      var fromFloor = lastFn === 'floor_plan', ownTxt = String(part.stem || '') + ' ' + String(part.text || '');
      if (lastFn === 'loads_takedown') continue;
      /* (fresh exam 10/06) a SECOND way out: a stopped floor plan whose blank asks for the load Pu on a COLUMN, in a question that gives the column's
         tributary AREA and speaks of no beam and no girder ("A column supports a single floor with a tributary area of 900 ft2 ... Pu = ____ kips"):
         that is the column takedown, and only when the takedown takes every number of the question. */
      var floorToColumn = fromFloor && !curOk && known.length > 0 && known.every(function (b) { return b.id === 'pu'; }) && /\bcolumn\b/i.test(ownTxt)
        && /\d\s*(?:sq\.?\s*ft|square\s+f(?:ee|oo)t|ft\s?\^?\s?2|sf)(?![A-Za-z0-9])/i.test(ownTxt) && !/\b(?:beam|girder|joist)s?\b/i.test(ownTxt);
      if (fromFloor && !floorToColumn && (curOk || !known.length || !known.every(function (b) { return b.id === 'wu'; }))) continue;
      /* (REVIEW 2: and only when the words say whether the beam is inside the floor or at its edge: the floor plan would have asked, the other form assumes) */
      /* (fresh exam 10/06: or give the beam's tributary WIDTH outright, which settles the same thing) */
      if (fromFloor && !floorToColumn && !/\binterior\b|\bedge\b|\bexterior\b|\bperimeter\b|\bspandrel\b|\bboth\s+sides\b|\beach\s+side\b|\bone\s+side\b|\btributary\s+width\b/i.test(ownTxt)) continue;
      if (curOk && curScore > 0) continue;                                  /* worked out, and it gives what is asked */
      if (curOk && !known.length) continue;                                 /* worked out, nothing says it is the wrong thing */
      if (!curOk && cur.status === 'asks' && curScore > 0) continue;        /* it runs and gives what is asked: one click of his places the number */
      if (part.kind === 'not_in_tool') {
        /* an unbraced length does not change a moment, a shear, a reaction or a load: only those may leave the "final-exam material" flag behind */
        if (!known.length || !known.every(function (b) { return /^(?:mu|vu|reaction|wu|pu)$/.test(b.id); })) continue;
        if (!(part.notIn || []).every(function (t) { return /^final-beam/.test(String(t.id)); })) continue;
      }
      /* the forms to try */
      all = Object.keys(FORM_GIVES);
      if (fromFloor) cands = floorToColumn ? ['loads_takedown'] : ['loads_floor'];
      else if (known.length) cands = all;
      else {
        /* no blank the page understands.  A form that merely CAN be filled proves nothing (10/06: a net-area question went to "hole size" that way), so the page
           looks further only when the blank at least has a unit, and then only among forms of the same kind whose own answer has that unit. */
        if (!(cur.status === 'nomatch' || cur.status === 'needs' || cur.status === 'refused')) continue;
        unknownUnit = blanks.length ? blanks[blanks.length - 1].unit : '';
        if (!unknownUnit || !has(SIG_UNIT_IDS, unknownUnit)) continue;
        fam = part.route && part.route.family;
        cands = fam && fam !== 'words' ? sigFamilyForms(fam).filter(function (f) { return has(FORM_GIVES, f) && FORM_GIVES[f].main.some(function (id) { return SIG_UNIT_IDS[unknownUnit].indexOf(id) >= 0; }); }) : [];
      }
      feas = [];
      for (k = 0; k < cands.length; k++) {
        fn = cands[k];
        if (fn === lastFn && fns.length === 1) continue;
        if (sigConflict(fn, String(part.stem || '') + ' ' + String(part.text || ''))) continue;      /* his own words, not the cover page's "beams" and "columns" */
        /* (10/06 night) a SELECTION answers "which shape": its strengths belong to the shape it picks.  A question that NAMES its member (W12x53) and asks
           for a strength or an area of it is never moved to a selection form -- a bolted W12x53, "Design strength for yielding of the gross section", was
           answered with the yielding strength of the lightest W12 (526.5 kips for 702). */
        if (/_select$/.test(fn) && !known.some(function (b) { return b.id === 'shape'; }) && /\b(?:W|WT|HP|HSS|MC|C|S|M|L|2L)\s?\d+(?:\.\d+)?\s*[xX]\s*\d/.test(ownTxt)) continue;
        try {
          p2 = makePart(part.stem, part.text, formRoute(part.route, fn, ['what is asked and what is given'], sigWant(fn)), part.label, part.defaultsLine, cover, part.id);
          p2.route.family = sigFamily(fn) === 'lookup' ? 'lookup' : (sigFamily(fn) === 'floor' ? 'floor' : sigFamily(fn));
          p2.split = part.split; if (part.choiceNote) p2.choiceNote = part.choiceNote;
          p2.whole = part.whole;
          p2.asked = known; p2.blankCount = blanks.length; p2.unknownBlanks = part.unknownBlanks;
          old = parts[i]; parts[i] = p2;
          d2 = dryPart(parts, i);
          parts[i] = old;
        } catch (e1) { parts[i] = part; continue; }
        if (SIGDBG) console.log('SIGDBG ' + fn + ' status ' + d2.status + ' unplaced ' + sigUnplaced(p2));
        if (!(d2.status === 'answered' || d2.status === 'figure')) continue;
        /* REVIEW 10/06: the new form must have taken EVERY number of the question that carries a unit.  A form that leaves the slab thickness and the psf
           loads aside can still "work out" and "give" the asked symbol -- with a wrong number. */
        if (sigUnplaced(p2) > 0) continue;
        if (fn === 'floor_plan' || (fn === 'loads_takedown' && !floorToColumn)) continue;
        if (known.length && !known.every(function (b) { return sigValueFor(p2, d2.run, b) !== null; })) continue;
        /* a form that holds the asked quantity only as something it was GIVEN (a Pu typed in, an Fy) does not answer the blank */
        if (known.length && !known.some(function (b) { return sigGives(fn, b.id) > 0; })) continue;
        score = 0;
        known.forEach(function (b) { var pf = SIG_PREF[b.id] || []; score += sigGives(fn, b.id) * 10 + (pf[0] === fn ? 4 : (pf.indexOf(fn) >= 0 ? 2 : 0)); });
        if (part.route && part.route.family && part.route.family === p2.route.family) score += 3;
        var unusedN = 0;
        try { unusedN = SOLVE.unusedQuestions(p2).length; } catch (e3) { unusedN = 0; }
        score -= unusedN;
        feas.push({ fn: fn, part: p2, d: d2, score: score, unused: unusedN });
      }
      feas.sort(function (a, b) { return b.score - a.score; });
      best = feas[0] || null; second = feas[1] || null;
      /* with no known blank there is nothing to tell two forms apart: the page switches only when ONE form of the same kind can be worked out and uses every number */
      if (best && !known.length && (second || best.unused > 0)) best = null;
      if (best && second && second.score >= best.score) best = null;
      if (best) {
        label = (formOf(best.fn) || {}).label || best.fn;
        why = known.length ? 'it gives what your answer blank asks for (' + known.map(function (b) { return b.raw; }).join(' ; ') + ') from the numbers in your question'
          : 'it is the only calculation of this kind that the numbers in your question can fill';
        best.part.rerouted = { from: lastFn, fromLabel: lastFn ? ((formOf(lastFn) || {}).label || lastFn) : null, to: best.fn, toLabel: label, why: why, was: cur.status };
        parts[i] = best.part;
      } else if (proseOnly) {
        /* nothing better found for an ask read from a sentence: the part stays as the finder left it, unflagged */
      } else if (curOk && known.length && curScore === 0) {
        /* worked out, but NOT what the blank asks, and no other form stands out: the answer must not be copied into that blank */
        part.askedMismatch = { raw: known.map(function (b) { return b.raw; }).join(' ; '), several: feas.map(function (f) { return (formOf(f.fn) || {}).label || f.fn; }) };
      } else if (feas.length > 1) part.sigSeveral = feas.map(function (f) { return { fn: f.fn, label: (formOf(f.fn) || {}).label || f.fn }; });
    } catch (e0) { parts[i] = part; }
  }
  for (i = 0; i < parts.length; i++) { try { delete parts[i].ui; } catch (e9) { parts[i].ui = undefined; } }
  return parts;
}
SOLVE.signaturePass = signaturePass;
function sigNum(x) { var E = env(); try { if (E.STEEL && typeof E.STEEL.fmt === 'function') return String(E.STEEL.fmt(x)); } catch (e) { /* fall through */ } return String(Number(x.toPrecision(4))); }
/* the lines for the answer blanks of the part: one per blank whose quantity the form gives on the way (its own ANSWER line already covers the others) */
function askedLines(part, run) {
  var out = [], asked = part.asked || [], fns = (part.stages || []).map(function (s) { return s.fn; }), lastFn = fns.length ? fns[fns.length - 1] : null, i, b, v, txt, seen = {},
    single = (part.blankCount || asked.length) === 1;
  if (!run || !run.ok || !lastFn) return out;
  /* (10/07) what a sentence beside the blanks asks for as well: lines only, after the blanks' own */
  asked = asked.concat((part.alsoAsked || []).filter(function (x) { return !asked.some(function (y) { return y.id === x.id; }); }));
  /* SEVERAL FAMILIES ON ONE ANSWER LINE: "W10 x ___ (phi Pn = ___)   W12 x ___ (phi Pn = ___)   W14 x ___ (phi Pn = ___)".  The form's one answer is the
     lightest of all; the page printed that one strength once, for three blanks.  Each family's own choice is a value of the selection (lightest_W10 ...) and
     its strength stands on the selection's own line "Choose W10X77 ...: phi Pn = 686 kips".  All of them or none: with one family missing the old lines stay. */
  var famLines = (function () {
    var last = run.stages[run.stages.length - 1], vals = last && last.res && last.res.values, steps = (last && last.res && last.res.steps) || [], fams = [], caps = [], lines = [], q, m2, tok, shp, cap, sre, s2, capBlanks;
    if (!/^(?:column|tension|beam)_select$/.test(lastFn) || !vals) return null;
    for (q = 0; q < asked.length; q++) {
      if (asked[q].id !== 'shape') continue;
      m2 = /^([A-Za-z]{1,3})\s?(\d{1,2})\s*[xX]\s*_/.exec(String(asked[q].raw || ''));
      if (!m2) return null;
      tok = m2[1].toUpperCase() + m2[2];
      if (!vals['lightest_' + tok] || typeof vals['lightest_' + tok].value !== 'string') return null;
      fams.push({ blank: asked[q], tok: tok, shape: vals['lightest_' + tok].value });
    }
    if (fams.length < 2) return null;
    capBlanks = asked.filter(function (x) { return x.id === 'phipn' || x.id === 'phimn'; });
    for (q = 0; q < fams.length; q++) {
      shp = fams[q].shape; cap = null;
      sre = new RegExp('Choose\\s+' + shp.replace(/\./g, '[.]') + '\\b[^:]{0,40}:\\s*phi\\s+(?:Pn|Mp|Mn)\\s*=\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*kip', 'i');
      for (s2 = 0; s2 < steps.length && cap === null; s2++) { m2 = sre.exec(String(steps[s2].text || '')); if (m2) cap = m2[1]; }
      caps.push(cap);
      lines.push('FOR YOUR BLANK (' + fams[q].blank.raw + '): ' + shp);
    }
    if (capBlanks.length === fams.length && caps.every(function (c) { return c !== null; })) {
      for (q = 0; q < fams.length; q++) lines.push('FOR YOUR BLANK (' + (capBlanks[q].id === 'phimn' ? 'phi Mn' : 'phi Pn') + ' of the ' + fams[q].shape + ' = ____): ' + (capBlanks[q].id === 'phimn' ? 'phi Mn' : 'phi Pn') + ' = ' + caps[q] + (capBlanks[q].id === 'phimn' ? ' kip-ft' : ' kips'));
      return { lines: lines, skip: { shape: 1, phipn: 1, phimn: 1 } };
    }
    if (capBlanks.length > 1) lines.push('Your answer line has ' + capBlanks.length + ' strength blanks, one for each shape: each shape\'s own strength is on its "Choose ..." line in the steps above. The ANSWER line gives the lightest of them only.');
    return { lines: lines, skip: { shape: 1, phipn: capBlanks.length > 1 ? 1 : 0, phimn: capBlanks.length > 1 ? 1 : 0 } };
  })();
  if (famLines) out = famLines.lines.slice();
  for (i = 0; i < asked.length; i++) {
    b = asked[i];
    if (famLines && famLines.skip[b.id]) continue;
    /* REVIEW 4: the blank NAMES a family ("W16 x ____") and the shape the page chose is of another one: the choice was not limited to that family (the
       floor plan printed W14X30 into a "W16 x ____" blank fourteen times).  The line says so instead of handing the shape over. */
    if (b.id === 'shape' && b.depth) {
      v = sigValueFor(part, run, b);
      var shm = v && typeof v.value === 'string' ? /^([A-Za-z]{1,2})\s?(\d{1,2})\s*[xX]/.exec(v.value) : null;
      if (shm && Number(shm[2]) !== Number(b.depth)) {
        out.push('NOT FOR YOUR BLANK: your blank reads "' + b.raw + '" and the page chose ' + v.value + '. It did NOT limit its choice to ' + String(b.family || 'W') + b.depth + ' shapes. Do NOT copy ' + v.value + ' into that blank.');
        part.familyMismatch = true;
        continue;
      }
    }
    /* (unit D: beside a theoretical K, the design K blank gets a line of its own too -- the ANSWER line alone does not say which blank it is for) */
    if (has(SIG_OUT, b.id) || (lastFn !== 'floor_plan' && sigGives(lastFn, b.id) === 2 && !(b.id === 'k' && part.theoLine))) continue;
    v = sigValueFor(part, run, b);
    if (!v) continue;
    txt = (SIG_LABEL[b.id] || b.sym || b.id) + ' = ' + (typeof v.value === 'number' ? sigNum(v.value) : String(v.value)) + (v.unit ? ' ' + v.unit : '');
    /* answers in words: which axis governs a column, which limit state governs a tension member */
    if (b.id === 'axis') {
      var kx = sigValue(run, 'klrx'), ky = sigValue(run, 'klry'), isY = String(v.value) === 'y';
      txt = (isY ? 'the WEAK axis (y-y)' : 'the STRONG axis (x-x)') + ' governs' + (kx && ky && typeof kx.value === 'number' && typeof ky.value === 'number'
        ? ': KL/r about ' + (isY ? 'y' : 'x') + ' = ' + sigNum(isY ? ky.value : kx.value) + ' is larger than KL/r about ' + (isY ? 'x' : 'y') + ' = ' + sigNum(isY ? kx.value : ky.value) : '');
    }
    if (b.id === 'governs') txt = String(v.value) + ' governs (the smaller of the two strengths)';
    if (v.nominal) txt = (SIG_LABEL[b.id] || b.sym) + ' = ' + v.nominal.label + ' / ' + v.nominal.phi.toFixed(2) + ' = ' + sigNum(v.nominal.design) + ' / ' + v.nominal.phi.toFixed(2) + ' = ' + sigNum(v.value)
      + (v.unit ? ' ' + v.unit : '') + '   (your blank has no phi: it asks for the NOMINAL value)';
    if (v.mp) txt = 'Mp = Fy Zx / 12 = ' + sigNum(v.mp.Fy) + ' x ' + sigNum(v.mp.Zx) + ' / 12 = ' + sigNum(v.value) + ' kip-ft   (the plastic moment: no phi)';
    if (v.converted) txt += '   (= ' + v.converted + ')';
    /* (10/06 20:20: a reader who knows no engineering, given this line as "KL/r = 58.43 (her table step rounds it up to 59)", answered "58.43 (or 59)" --
       two numbers on the line, and the working's "her table method (rounded-up KL/r) is the answer to write" is about phi Pn.  The line now says which of
       the two goes in the blank.  Her own solutions write the ratio itself, to the nearest whole number or with its decimals, never the rounded-up row.) */
    /* (10/07) the slenderness of a TENSION member is L/r against the limit of 300; there is no table row to round to */
    if (b.id === 'klr' && v.key === 'L_over_r' && typeof v.value === 'number') txt = 'L/r = ' + sigNum(v.value) + (v.value <= 300 ? '   (not more than 300: OK for a tension member)' : '   (MORE than 300: too slender for a tension member)');
    else if (b.id === 'klr' && typeof v.value === 'number' && Math.ceil(v.value) !== v.value) txt += '   <- write this number.   (' + Math.ceil(v.value) + ' is only the row of her table that phi Fcr is read from)';
    /* the same blank written twice on the answer line and one value for it: the value belongs to ONE of them, and the line says so
       (three "phi Pn = ___" blanks were all given the one strength of the ANSWER line) */
    if (seen[b.raw + '|' + txt]) {
      if (out[seen[b.raw + '|' + txt] - 1].indexOf('ONE of them') < 0) out[seen[b.raw + '|' + txt] - 1] += '   (your answer line has more than one blank written like this: this value is for ONE of them, the one the ANSWER line is about)';
      continue;
    }
    out.push((b.prose ? 'ANSWER TO "' + b.raw + '": ' : ((single ? 'ANSWER FOR YOUR BLANK (' : 'FOR YOUR BLANK (') + b.raw + (v.member ? ', the ' + v.member : '') + '): ')) + txt);
    seen[b.raw + '|' + txt] = out.length;
  }
  return out;
}
SOLVE.askedLines = askedLines;
/* THE ANSWERS OF A QUESTION, ONE LINE PER BLANK, for the top of the question (ui.js drawQuestionBar).
   Zack, 10/06 19:40, pasted a whole solved question -- four parts, all four right -- and asked: "did the system solve the problem or not?"  The answers stood at
   the bottom of four long blocks of working, three of them the same eleven lines.  This takes, out of a part's WRITE THIS lines, the ones that go into a blank.
   It never makes a number: every line it returns is a line of the block, in the block's words.
     -> [{kind: 'blank', blank, text} | {kind: 'answer', text} | {kind: 'warn', text}] */
SOLVE.blankLines = function (writeLines) {
  var out = [], i, s, m;
  for (i = 0; i < (writeLines || []).length; i++) {
    s = String(writeLines[i]);
    if ((m = /^(?:ANSWER )?FOR YOUR BLANK \((.*?)\): (.*)$/.exec(s)) || (m = /^ANSWER TO "(.*?)": (.*)$/.exec(s))) out.push({ kind: 'blank', blank: m[1], text: m[2] });
    /* (the calculator's own "NOT RELIABLE" result -- a single-angle column -- prints a number "for reference".  In the list it is a warning, not an
       answer: the same reader could not tell whether that number was meant to be copied.) */
    else if ((m = /^ANSWER(?: \(step \d+\))?: (.*)$/.exec(s))) out.push(/\bNOT RELIABLE\b/.test(m[1])
      ? { kind: 'warn', text: 'DO NOT COPY A NUMBER FOR THIS PART: the page says its own result is NOT RELIABLE here. ' + m[1] } : { kind: 'answer', text: m[1] });
    else if (/^(?:CIRCLE:|NO LETTER FROM THE PAGE)/.test(s)) out.push({ kind: 'answer', text: s });
    else if (/^(?:NOT WHAT YOUR BLANK ASKS|NOT FOR YOUR BLANK|CHECK YOUR BLANK)/.test(s)) out.push({ kind: 'warn', text: s });
  }
  return out;
};
/* the numbered working of a part, as one string: two parts with the same string print the same working, and it need be written only once */
SOLVE.workingKey = function (writeLines) {
  return (writeLines || []).filter(function (s) { return /^\d+\. /.test(String(s)); }).join('\n');
};

/* ==================================================================================================== a box the page could not fill
   COUNCIL 2026-10-06, item 2 (all three): he matches PHRASES, he does not judge.  The old question was about a number ("8 ft is in your text, which box does
   it belong in?") and offered six box names: engineering judgment.  This one is about the BOX, says in plain words what the box is and where to look for it
   on a drawing, and offers as choices the numbers of his own question that could be it, each with the words around it.  "My question does not say it" is
   always there: then nothing is calculated. */
var BOX_HINT = {
  beam_span_ft: 'How LONG the beam is, from one end to the other. On a plan drawing: the dimension written ALONG the beam (in the same direction as the beam line).',
  span_ft: 'How LONG the beam is, from one support to the other. On a drawing: the dimension written ALONG the beam.',
  beam_spacing_ft: 'How far this beam is from the NEXT beam beside it. On a plan drawing: the dimension written ACROSS the beams (from one beam line to the next).',
  spacing_ft: 'How far this beam is from the NEXT beam beside it. On a plan drawing: the dimension written ACROSS the beams (from one beam line to the next).',
  girder_span_ft: 'How long the GIRDER is (the member the beams rest on), from column to column.',
  holes_per_flange: 'Count the holes in ONE flange. The flanges are the two flat bars at the top and at the bottom of the I shape. Count one bar only.',
  web_holes: 'Count the holes in the web: the upright middle part of the I shape. Type 0 if it has none.',
  holes_across: 'Count the holes that one straight cut ACROSS the plate goes through (the holes side by side in one row).',
  Lx_ft: 'How tall the column is (its length), in feet.',
  Ly_ft: 'The same length again, unless your question says the column is braced part-way up: then the distance between the braces.',
  L_ft: 'How tall the column is (its length), in feet.',
  Mu: 'The factored moment Mu in kip-ft, if your question gives one.',
  KL_over_r: 'The number your question gives for KL/r (the slenderness ratio).',
  slab_thickness_in: 'How thick the concrete slab is, in inches.',
  live_psf: 'The live load on the floor, in psf.',
  bolt_dia_in: 'The diameter of the bolts, in inches.',
  width_in: 'How wide the plate is, in inches.',
  thickness_in: 'How thick the plate is, in inches.',
  shape: 'The name of the steel shape, for example W12x65.',
  fasteners_per_line: 'How many bolts are in ONE line, counted ALONG the member (one behind the other, in the direction of the pull). Look at the drawing; count one line only.',
  fastener_lines: 'How many LINES of bolts there are (a line runs along the member; count the lines side by side).',
  xbar_in: 'The distance x-bar in inches, if your question or its drawing gives it (often written with a bar over the x).',
  l_in: 'The length of the connection in inches: from the first bolt to the last bolt of one line.',
  KLx_ft: 'The effective length about the strong axis, written KxLx or KL in your question, in feet.',
  KLy_ft: 'The effective length about the weak axis, written KyLy in your question, in feet.',
  tributary_area_sf: 'The floor area this column carries, in square feet (often called the tributary area).',
  floors: 'How many floors the column carries.',
  Pu: 'The factored load Pu in kips, if your question gives one.',
  D: 'The service DEAD load, in the unit your question uses.',
  L: 'The service LIVE load, in the unit your question uses.'
};
SOLVE.boxHint = function (name) { return has(BOX_HINT, name) ? BOX_HINT[name] : ''; };
/* the words around a number of his question (the clause it stands in), so that he can tell two equal-looking numbers apart */
function phraseAround(part, text) {
  var ctx = String(part.ctx || ''), from = part.coverLen || 0, at = ctx.indexOf(text, from), a, b, left, right;
  if (at < 0) at = ctx.indexOf(text);
  if (at < 0) return text;
  a = at; b = at + text.length;
  left = ctx.slice(Math.max(0, a - 60), a); right = ctx.slice(b, b + 40);
  left = left.replace(/^[\s\S]*[.;:\n(]\s*/, '');
  if (/,\s*[^,]*[A-Za-z][^,]*$/.test(left)) left = left.replace(/^[\s\S]*,\s*/, '');      /* "Dimensions are x = 8 ft, y = " -> "y = " */
  right = right.replace(/[.;:\n),][\s\S]*$/, '');
  return trim((left.length > 48 ? '..' + left.slice(-46) : left) + text + (right.length > 30 ? right.slice(0, 28) + '..' : right)).replace(/\s+/g, ' ');
}
/* the numbers of his question that could be this box: [{ text, value, phrase }] (unit and kind must fit; numbers another box already holds are left out) */
SOLVE.candidatesForBox = function (part, si, path) {
  var qs, out = [], i, k, p, v, b = part.stages[si] ? boxAt(part.stages[si], path) : null, seen = {};
  if (!b) return out;
  try { qs = SOLVE.unusedQuestions(part); } catch (e) { qs = []; }
  for (i = 0; i < qs.length; i++) for (k = 0; k < qs[i].cands.length; k++) {
    if (qs[i].cands[k].si !== si || qs[i].cands[k].path !== path) continue;
    p = SOLVE.numberFromText(qs[i].text);
    v = p ? SOLVE.valueForBox(p, b) : null;
    if (v === null || seen[qs[i].text]) continue;
    seen[qs[i].text] = 1;
    out.push({ text: qs[i].text, value: v, phrase: phraseAround(part, qs[i].text) });
  }
  return out;
};
/* the boxes a part is waiting for: the empty required ones, and the ones the calculator's refusal is about.
   [{ si, path, name, label, unit, kind, hint, cands }]   vals = the values on screen; run = the last (refused) run or null */
SOLVE.wantedBoxes = function (part, vals, run) {
  var out = [], seen = {}, si, i, st, b, msg, names = [], fn, member;
  function empty(si0, path) { var st0 = part.stages[si0], b0 = st0 ? boxAt(st0, path) : null; return !!b0 && isEmptyUi(b0, vals && vals[si0] ? vals[si0][path] : undefined); }
  function add(si0, path) {
    var st0 = part.stages[si0], b0 = st0 ? boxAt(st0, path) : null;
    if (!b0 || seen[si0 + ':' + path] || b0.state === 'carried' || !empty(si0, path)) return;
    seen[si0 + ':' + path] = 1;
    out.push({ si: si0, path: path, name: b0.name, label: plainLabel(b0.label), unit: b0.unit || '', kind: b0.kind, hint: SOLVE.boxHint(b0.name), cands: SOLVE.candidatesForBox(part, si0, path) });
  }
  if (part.kind !== 'form') return out;
  for (si = 0; si < part.stages.length; si++) {
    st = part.stages[si];
    if (!st.boxes) continue;
    for (i = 0; i < st.boxes.length; i++) { b = st.boxes[i]; if (b.required && b.state !== 'carried' && (b.kind === 'num' || b.kind === 'int') && empty(si, b.path)) add(si, b.path); }
  }
  if (run && !run.ok && run.failedAt >= 0 && run.stages[run.failedAt] && run.stages[run.failedAt].res && run.stages[run.failedAt].res.error) {
    si = run.failedAt; st = part.stages[si]; fn = st.fn; msg = String(run.stages[si].res.error.message || '');
    member = vals && vals[si] ? String(vals[si].member || '') : '';
    if (/beam span/i.test(msg)) names = ['beam_span_ft', 'span_ft'].concat(empty(si, 'beam_tributary_ft') ? ['beam_spacing_ft'] : []);
    else if (/beam spacing|tributary width/i.test(msg)) names = ['beam_spacing_ft', 'spacing_ft'];
    else if (/girder span/i.test(msg)) names = ['girder_span_ft'];
    else if (/Span L\b/i.test(msg)) names = ['span_ft'].concat(empty(si, 'tributary_ft') ? ['spacing_ft'] : []);
    /* holes: a rolled shape is asked flange by flange.  A plate or an angle is NOT asked for one count here: its holes may be zig-zag (Quiz 1 Q7), where one
       count gives a wrong answer; the hole helper under the figure note takes the distances and the stagger instead. */
    else if (/how many holes/i.test(msg)) names = /plate|angle/i.test(member) ? [] : ['holes_per_flange', 'web_holes'];
    else if (/effective length/i.test(msg)) names = ['Lx_ft', 'L_ft'];
    else if (/Enter Mu\b/i.test(msg)) names = ['Mu'];
    else if (/fasteners?\s+per\s+line/i.test(msg)) names = ['fasteners_per_line'];
    /* and any numeric box the calculator names in brackets: "... the member length (Lx_ft) only", "type KL directly in KLx_ft" */
    for (i = 0; i < (st.boxes || []).length; i++) {
      b = st.boxes[i];
      if ((b.kind === 'num' || b.kind === 'int') && b.name.length > 2 && names.indexOf(b.name) < 0 && msg.indexOf('(' + b.name + ')') >= 0 && empty(si, b.path)) names.push(b.name);
    }
    for (i = 0; i < names.length; i++) for (var k = 0; k < (st.boxes || []).length; k++) if (st.boxes[k].name === names[i]) add(si, st.boxes[k].path);
  }
  return out;
};


/* What he types is not what the rules were written for.  Her exams print the resistance factor as a slashed O ("OMn" with a stroke through the O; seen on the
   real May 2024 final), superscripts ("in" with a raised 2), a multiplication sign in shape names, long dashes.  He will type some of these, paste others, or
   type the nearest key ("0Mn", "OMn").  Everything is brought to the plain form the rest of the page reads.  Characters are written by number: ASCII source. */
var TYPED_MAP = [[0xd7, 'x'], [0x2013, '-'], [0x2014, '-'], [0x2212, '-'], [0x2018, '\''], [0x2019, '\''], [0x201c, '"'], [0x201d, '"'], [0x2032, '\''], [0x2033, '"'],
  [0xb2, '2'], [0xb3, '3'], [0x2074, '4'], [0xa0, ' '], [0x394, 'Delta '], [0x2265, '>='], [0x2264, '<='], [0xbd, ' 1/2'], [0xbc, ' 1/4'], [0xbe, ' 3/4'], [0xb7, '*'], [0x2219, '*'],
  [0x3a6, ' phi '], [0x3c6, ' phi '], [0x3d5, ' phi ']];
var SLASHED_O_RE = new RegExp('[' + String.fromCharCode(0xd8) + String.fromCharCode(0xf8) + String.fromCharCode(0x2205) + String.fromCharCode(0x2300) + ']\\s*(?=(?:[cbtv]\\s*)?(?:P|M|R|V|F)\\s*(?:n|cr|p)\\b)', 'g');
var LOOKALIKE_O_RE = /(^|[^A-Za-z0-9.])[0O]\s?(?=(?:[cbtv]\s?)?(?:Pn|Mn|Rn|Vn|Fn|Fcr|Mp)\b)/g;
/* ------------------------------------------------------------------------------------------------ SPELLING REPAIR, with no language model
   He types the question from paper, roughly, and a misspelled key word does not only stop the page: it can change the number ("8 flor levels" once
   printed Pu = 0; "8 ft aboit the y-y axis" read ONE unbraced length for both axes).  Before anything reads the text, a typed word that is NO word --
   neither in the kit's own vocabulary nor in an English dictionary -- is replaced by the known word ONE edit away (a letter lost, added or replaced, or
   two neighbours swapped), and only when the choice is clear:
     - exactly one candidate forms a pair seen in the kit's own text with the word before or the word after ("flor levels" -> floor, not four or foot); or
     - there is no such pair at all, but only ONE candidate exists, the typed word has 5+ letters and the candidate is a common word of the kit.
   Never touched: a word that is a real word (even the wrong one: "bean" for "beam" stays), anything glued to a digit, a slash or a blank (W12x53, in2,
   k/ft, KL/r), anything with a capital inside it (PD, KL, LRFD), words of 1 or 2 letters.  Every repair is returned so that the page can SHOW it.
   The lists are data/spelling.js (make-spelling.js).  Without that file nothing is repaired.   Tests: typo-forms.js, dump-all.js. */
var SPELL = null;
function spellData() {
  var r2 = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}), D = r2.STEEL_DATA && r2.STEEL_DATA.spelling, S, a, i, kv;
  if (SPELL !== null) return SPELL;
  if (!D || !D.known) { SPELL = false; return SPELL; }
  S = { known: {}, english: {}, pairs: {}, byLen: {} };
  a = String(D.known).split(' ');
  for (i = 0; i < a.length; i++) { kv = a[i].split(':'); if (!kv[0]) continue; S.known[kv[0]] = kv[1] ? Number(kv[1]) : 0; (S.byLen[kv[0].length] = S.byLen[kv[0].length] || []).push(kv[0]); }
  a = String(D.english || '').split(' ');
  for (i = 0; i < a.length; i++) if (a[i]) S.english[a[i]] = 1;
  a = String(D.pairs || '').split('|');
  for (i = 0; i < a.length; i++) { kv = a[i].split(':'); if (kv[0]) S.pairs[kv[0]] = Number(kv[1]) || 1; }
  SPELL = S;
  return SPELL;
}
function oneEdit(a, b) {
  var la = a.length, lb = b.length, i, j, k;
  if (a === b || Math.abs(la - lb) > 1) return false;
  i = 0; while (i < la && i < lb && a.charAt(i) === b.charAt(i)) i++;
  j = la - 1; k = lb - 1; while (j >= i && k >= i && a.charAt(j) === b.charAt(k)) { j--; k--; }
  if (la === lb) return (j === i && k === i) || (j === i + 1 && k === i + 1 && a.charAt(i) === b.charAt(i + 1) && a.charAt(i + 1) === b.charAt(i));
  return la > lb ? (j === i && k === i - 1) : (k === i && j === i - 1);
}
function repairSpelling(text) {
  var S = spellData(), t = String(text === undefined || text === null ? '' : text), re = /[A-Za-z]+|\d+(?:[.,\/]\d+)*|\s+|[^A-Za-z\d\s]/g, toks = [], m, i, w, lw, L, list, k, cands, ev, withEv, pick, repairs = [], changed = false, unknown = [];
  if (!S || !/[A-Za-z]{3}/.test(t)) return { text: t, repairs: [], unknown: [] };
  while ((m = re.exec(t)) !== null) toks.push({ s: m[0], kind: /^[A-Za-z]/.test(m[0]) ? 'w' : (/^\d/.test(m[0]) ? 'n' : (/^\s/.test(m[0]) ? 's' : 'p')) });
  /* the word (as typed, and only if it is a known word) or the number that stands next to token i, with nothing but spaces between */
  function neighbour(at, dir) {
    var j = at + dir, x;
    while (j >= 0 && j < toks.length && toks[j].kind === 's') { if (toks[j].s.indexOf('\n') >= 0) return null; j += dir; }
    if (j < 0 || j >= toks.length) return null;
    if (toks[j].kind === 'n') return '#';
    if (toks[j].kind !== 'w' || toks[j].fixed) return null;
    x = toks[j].s.toLowerCase();
    return has(S.known, x) ? x : null;
  }
  for (i = 0; i < toks.length; i++) {
    if (toks[i].kind !== 'w') continue;
    w = toks[i].s; lw = w.toLowerCase();
    if (lw.length < 3 || lw.length > 22) continue;
    if (/[A-Z]/.test(w.slice(1))) continue;
    if (i > 0 && (toks[i - 1].kind === 'n' || /^[_\/^=]$/.test(toks[i - 1].s))) continue;
    if (i + 1 < toks.length && (toks[i + 1].kind === 'n' || /^[_\/^]$/.test(toks[i + 1].s))) continue;
    if (has(S.known, lw) || has(S.english, lw)) continue;
    cands = [];
    for (L = lw.length - 1; L <= lw.length + 1; L++) {
      list = S.byLen[L] || [];
      for (k = 0; k < list.length; k++) {
        if (list[k].length < 3 || !oneEdit(lw, list[k])) continue;
        /* the first letter is the one a typist gets right, unless the first two changed places */
        if (list[k].charAt(0) !== lw.charAt(0) && !(list[k].charAt(0) === lw.charAt(1) && list[k].charAt(1) === lw.charAt(0))) continue;
        cands.push(list[k]);
      }
    }
    if (!cands.length) { if (lw.length >= 4) unknown.push(w); continue; }
    /* how well each candidate fits its place: on how many SIDES it forms a pair seen in the kit's text (0, 1 or 2), then how often */
    withEv = [];
    (function () {
      var p = neighbour(i, -1), n = neighbour(i, 1), c, e1, e2;
      for (c = 0; c < cands.length; c++) {
        e1 = p ? (S.pairs[p + ' ' + cands[c]] || 0) : 0; e2 = n ? (S.pairs[cands[c] + ' ' + n] || 0) : 0;
        if (e1 + e2 > 0) withEv.push({ w: cands[c], sides: (e1 > 0 ? 1 : 0) + (e2 > 0 ? 1 : 0), e: e1 + e2 });
      }
    })();
    withEv.sort(function (a, b) { return b.sides - a.sides || b.e - a.e; });
    cands.sort(function (a, b) { return (S.known[b] || 0) - (S.known[a] || 0); });
    pick = null;
    if (withEv.length === 1) pick = withEv[0].w;                                                              /* the only one that fits its place */
    else if (withEv.length > 1 && withEv[0].sides === 2 && withEv[1].sides < 2) pick = withEv[0].w;          /* "8 flor levels": floor fits both sides, "for" one */
    else if (withEv.length > 1 && withEv[0].sides === withEv[1].sides && withEv[0].e >= 3 && withEv[0].e >= 4 * withEv[1].e) pick = withEv[0].w;
    else if (!withEv.length && lw.length >= 5) {
      /* nothing beside it helps (the neighbours are misspelled too, or it stands alone): only a candidate with no rival */
      if (cands.length === 1 && S.known[cands[0]] >= 3) pick = cands[0];
      /* (council 3, 10/06 night: the arm "a rival fifty times rarer does not count" is removed -- how often a word occurs says nothing about which word
         he meant.  With no neighbouring pair, only a lone candidate is taken.) */
    }
    /* (council 3) and whatever the rule, a word is repaired only INTO a word the kit's own clean text uses at least three times */
    if (pick && !((S.known[pick] || 0) >= 3)) pick = null;
    if (!pick) { if (lw.length >= 4) unknown.push(w); continue; }
    ev = /^[A-Z]/.test(w) ? pick.charAt(0).toUpperCase() + pick.slice(1) : pick;
    repairs.push({ from: w, to: ev });
    toks[i].s = ev; toks[i].fixed = true; changed = true;
  }
  /* unknown: words that are in no dictionary and that the repair could not place -- the page reads the question WITHOUT them, and says which (ui.js) */
  unknown = unknown.filter(function (x, k9, a9) { return a9.indexOf(x) === k9; });
  if (!changed) return { text: t, repairs: [], unknown: unknown };
  return { text: toks.map(function (x) { return x.s; }).join(''), repairs: repairs, unknown: unknown };
}
SOLVE.repairSpelling = repairSpelling;

/* HE TYPES IN LOWER CASE.  Every rule of the finder, the reader and the answer-blank table was written against PRINTED questions: "W12x53", "A992",
   "Pu = ____ kips", "Fy = 50 ksi", "KL/r".  Typed all in lower case and with nothing else changed, the real past exam lost 6 of its 14 answers (10/06
   night, typo-forms.js --level lower).  So before anything reads the text, the capital letters that carry meaning are put back: shape names, steel
   grades, the symbols in front of "=" and after "phi", the symbols that are no English word, LRFD / ASD / AISC / ASTM.  A letter that is already a
   capital is never touched, so a question typed as printed comes out unchanged.  */
var RECASE_EQ = { pu: 'Pu', pn: 'Pn', mu: 'Mu', mn: 'Mn', mp: 'Mp', my: 'My', vu: 'Vu', vn: 'Vn', rn: 'Rn', an: 'An', ae: 'Ae', ag: 'Ag', fy: 'Fy', fu: 'Fu',
  fcr: 'Fcr', fe: 'Fe', fn: 'Fn', pcr: 'Pcr', pe: 'Pe', zx: 'Zx', zy: 'Zy', sx: 'Sx', sy: 'Sy', ix: 'Ix', iy: 'Iy', lb: 'Lb', lx: 'Lx', ly: 'Ly', lc: 'Lc', kl: 'KL',
  klx: 'KLx', kly: 'KLy', kx: 'Kx', ky: 'Ky', pd: 'PD', pl: 'PL', wd: 'WD', wl: 'WL', dl: 'DL', ll: 'LL', md: 'MD', ml: 'ML', lr: 'Lr', k: 'K', u: 'U', e: 'E', l: 'L', p: 'P' };
/* symbols that are no English word: capitalised wherever they stand as a word of their own */
var RECASE_ANY = { pu: 'Pu', pn: 'Pn', mu: 'Mu', mn: 'Mn', mp: 'Mp', vu: 'Vu', vn: 'Vn', ae: 'Ae', ag: 'Ag', fy: 'Fy', fu: 'Fu', fcr: 'Fcr', pcr: 'Pcr', zx: 'Zx', zy: 'Zy',
  sx: 'Sx', sy: 'Sy', ix: 'Ix', iy: 'Iy', lrfd: 'LRFD', asd: 'ASD', aisc: 'AISC', astm: 'ASTM', hss: 'HSS' };
function recaseTyped(text) {
  var t = String(text);
  if (!/[a-z]/.test(t)) return t;
  /* shapes: w12x53, w 12 x 53, wt7x45, hp12x89, hss6x4x3/8, mc10x22, "lightest w12", "w12 x ____", "w____x____", "a w shape"; c10x20, s12x35, m8x6.5, l4x4x1/2, 2l4x4 */
  t = t.replace(/(^|[^A-Za-z0-9])(wt|hp|hss|mc|w)(?=\s?\d{1,2}(?:\.\d+)?(?![A-Za-z0-9.])|\s?\d{1,2}(?:\.\d+)?\s?[xX]|\s*_{2,}|\s*-?\s*(?:shapes?|sections?)\b)/g, function (m0, a, f) { return a + f.toUpperCase(); });
  t = t.replace(/(^|[^A-Za-z0-9])(2l|[csml])(?=\s?\d{1,2}(?:\.\d+)?\s?[xX]\s?\d)/g, function (m0, a, f) { return a + f.toUpperCase(); });
  t = t.replace(/(^|[^A-Za-z0-9])c(?=\d{1,2}(?![A-Za-z0-9.]))/g, '$1C');
  /* the x of a designation may be typed as a capital or with spaces; the rules know both */
  /* steel grades: a992, a36, a572 gr 50, a500 */
  t = t.replace(/(^|[^A-Za-z0-9])a(?=(?:36|53|242|500|501|529|572|588|618|709|847|913|992|1011|1043|1065|1085)(?![0-9]))/g, '$1A');
  /* after phi: phi pn, phi c pn, phi mn, phi b mp, phi fcr */
  t = t.replace(/((?:^|[^A-Za-z])(?:phi|PHI|Phi)\s*(?:[cbtv]\s*)?)(pn|mn|mp|vn|rn|fn|fcr|mnx|mpx|pnx)\b/g, function (m0, a, s) { return a + s.charAt(0).toUpperCase() + s.slice(1); });
  /* in front of "=" (a given value or an answer blank), in front of a blank, and "kl/r" */
  t = t.replace(/(^|[^A-Za-z0-9_\/])([a-z]{1,3})(?=\s*(?:=|_{2,}))/g, function (m0, a, s) { return has(RECASE_EQ, s) ? a + RECASE_EQ[s] : m0; });
  t = t.replace(/(^|[^A-Za-z0-9_])k\s?l(?=\s*\/\s*r)/g, '$1KL');
  t = t.replace(/(^|[^A-Za-z0-9_])k([xy])\s?l([xy])(?=\s*\/\s*r)/g, function (m0, a, p, q) { return a + 'K' + p + 'L' + q; });
  /* "d = 100 psf" is the dead load D; "d = 12.2 in" is a depth and stays */
  t = t.replace(/(^|[^A-Za-z0-9_\/])d(?=\s*=\s*\d[\d.,]*\s*(?:kips?|k\b|psf|plf|klf|k\/ft|kip\/ft|lb\/ft|pcf))/g, '$1D');
  /* symbols that are no English word, wherever they stand */
  t = t.replace(/(^|[^A-Za-z0-9_\/])([a-z]{2,4})(?![A-Za-z0-9_])/g, function (m0, a, s) { return has(RECASE_ANY, s) ? a + RECASE_ANY[s] : m0; });
  /* a question ABOUT a symbol: "in which e is (choose one)", "what does k stand for", "the letter u means" */
  t = t.replace(/\b((?:in\s+which|where|what\s+(?:is|does)|the\s+(?:symbol|letter|term|factor|variable))\s+)([ekulpdm])(?=\s+(?:is|stands?|represents?|means?|denotes?|refers?)\b)/g, function (m0, a, s) { return a + s.toUpperCase(); });
  return t;
}
SOLVE.recaseTyped = recaseTyped;
function normalizeTyped(text) {
  var t = String(text === undefined || text === null ? '' : text), i;
  /* (10/07, his first manual test: "had no way to use the slashed O nor know what it means")  The paper prints a slashed O in two places: in front of
     Pn / Mn / Rn / Vn it is PHI (the resistance factor); beside a bolt size it is DIAMETER.  He cannot type it, so the ways he may type it instead are
     read as well: "oPn", "o/Pn", "0/Pn", "OPn", in either case.  (A 0 that is the value of something -- "Lb = 0 Mn = ____" -- is not phi.) */
  t = t.replace(/(^|[^A-Za-z0-9.])([oO0])\s?\/?\s?(pn|mn|rn|vn|mp|fcr)\b/gi, function (m0, p1, o1, sym, off, str) {
    if (o1 === '0' && /=\s*$/.test(str.slice(Math.max(0, off - 2), off + p1.length))) return m0;
    return p1 + 'phi ' + { pn: 'Pn', mn: 'Mn', rn: 'Rn', vn: 'Vn', mp: 'Mp', fcr: 'Fcr' }[sym.toLowerCase()];
  });
  t = recaseTyped(t);
  /* (10/07, his second manual test, her textbook problems 3-22 and 3-23 typed from the page)
     - "7/8in phi bolts": he typed the slashed O as "phi", which is right in front of Pn and wrong beside a bolt size.  The bolt size was then read by
       nobody ("Missing: bolt diameter").  "phi" between a size in inches and the word bolt / hole / rivet, or straight in front of such a size, is the
       DIAMETER sign.
     - "shown in fig p3-23": the number of a figure, of a problem or of an example is a label; its digits were read as a count ("23 assume holes").
       The word stays (the page still knows there is a figure), the number goes.
     - "(ans. 9.67 in^2)": the book's printed answer is not a given of the question. */
  t = t.replace(/(\d\s*-?\s*(?:in\.?|inch(?:es)?|")\s*-?\s*)phi(?=\s*-?\s*(?:diameter\s+|dia\.?\s+)?(?:bolts?|holes?|rivets?|rods?|bars?|fasteners?)\b)/gi, '$1diameter');
  t = t.replace(/\bphi\s+(?=\d+(?:\s?\/\s?\d+|\.\d+)?\s*-?\s*(?:in\.?|inch(?:es)?|")\s*-?\s*(?:diameter\s+|dia\.?\s+)?(?:bolts?|holes?|rivets?|rods?|bars?|fasteners?)\b)/gi, 'diameter ');
  t = t.replace(/\b(fig(?:ure|s)?\.?|problem|prob\.?|example|ex\.)[ \t]*(?:no\.?[ \t]*)?[A-Za-z]{0,2}\d+(?:[-.]\d+)*[a-z]?(?![A-Za-z0-9\/])/gi, '$1');
  t = t.replace(/\(\s*ans(?:wer)?s?\b\.?\s*:?[^()]{0,80}\)/gi, ' ');
  /* a textbook problem number in front of the question ("3-22 A C12 x 30 is connected ...") */
  t = t.replace(/(^|\n)[ \t]*\d{1,2}-\d{1,3}[.)]?[ \t]+(?=[A-Za-z(])/g, '$1');
  t = t.replace(SLASHED_O_RE, 'phi ');
  /* a slashed O anywhere else is the diameter sign ("3/4 in [O] bolts") */
  t = t.replace(new RegExp('\\s*[' + String.fromCharCode(0xd8) + String.fromCharCode(0xf8) + String.fromCharCode(0x2205) + String.fromCharCode(0x2300) + ']\\s*', 'g'), ' diameter ');
  for (i = 0; i < TYPED_MAP.length; i++) if (t.indexOf(String.fromCharCode(TYPED_MAP[i][0])) >= 0) t = t.split(String.fromCharCode(TYPED_MAP[i][0])).join(TYPED_MAP[i][1]);
  /* (REVIEW 2: "... fully braced, Lb = 0 Mn = ____" -- a 0 that is the VALUE of something is not phi) */
  t = t.replace(LOOKALIKE_O_RE, function (m0, p1, off, str) { return /=\s*$/.test(str.slice(Math.max(0, off - 2), off + p1.length)) ? m0 : p1 + 'phi '; });
  /* REVIEW 10/06: psf written "pounds/ft2", "lb/ft2", "lb/sf", "pounds per square foot", or as ksf.  The reader did not know them, dropped the loads, and the
     page answered 216 kips where 1728 is right.  Her own cover page writes "pounds/ft3". */
  /* REVIEW 2: ".04 ksf" (a leading dot), "k/ft2", "pounds/square ft", "pounds per sq. foot", "p.s.f.", "lbf/ft2", "lb/ft**2", "#/ft2" */
  t = t.replace(/(\d*\.?\d+)\s*(?:ksf|k(?:ips?)?\s*(?:\/|per)\s*(?:ft\.?\s*(?:\^|\*\*)?\s*2|sq\.?\s*f(?:oo|ee)?t\.?|square\s+f(?:oo|ee)?t|sf))(?![A-Za-z0-9])/gi, function (m0, n0) { return String(Math.round(Number(n0) * 1e6) / 1000) + ' psf'; });
  t = t.replace(/\bp\.\s?s\.\s?f\.?(?![A-Za-z0-9])/gi, 'psf');
  t = t.replace(/(?:\b(?:pounds?|lbs?\.?|lbf)|#)\s*(?:\/|per)\s*(?:ft\.?\s*(?:\^|\*\*)?\s*2|sq\.?\s*f(?:oo|ee)?t\.?|square\s+f(?:oo|ee)?t|sf)(?![A-Za-z0-9])/gi, 'psf');
  t = t.replace(/(?:\b(?:pounds?|lbs?\.?|lbf)|#)\s*(?:\/|per)\s*(?:ft\.?\s*(?:\^|\*\*)?\s*3|cu\.?\s*f(?:oo|ee)?t\.?|cubic\s+f(?:oo|ee)?t|cf)(?![A-Za-z0-9])/gi, 'pcf');
  t = t.replace(/\bpounds?\s*(?:\/|per)\s*(?:ft|foot)(?![A-Za-z0-9^])/gi, 'lb/ft');
  t = t.replace(/\bkips?\s+per\s+(?:ft|foot)(?![A-Za-z0-9^])/gi, 'k/ft');
  /* "phiPn", "phicFn" typed as one word */
  t = t.replace(/\bphi(?=(?:[cbtv])?(?:Pn|Mn|Rn|Vn|Fn|Fcr|Mp)\b)/g, 'phi ');
  /* "Vu = ?" is an answer blank, not the end of a question (the "?" made the page see a second question) */
  t = t.replace(/=[ \t]*\?+[ \t]*/g, '= ____ ');
  /* a unit glued to its number ("32ft", "5k/ft", "40psf", "3000in4", "50k"): one glued unit sent a column-load question to another form with a wrong answer */
  t = t.replace(/(\d)(in\.?\^?[234]|k\/ft|kips?\/ft|lbs?\/ft|kip-?ft|k-ft|kips?|ksi|psf|pcf|plf|klf|feet|ft|inch(?:es)?|in|k)(?![A-Za-z0-9\/])/g, '$1 $2');
  /* runs of spaces (never across lines) */
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t;
}
SOLVE.normalizeTyped = normalizeTyped;
/* THE QUESTION IS READ THE SAME HOWEVER ITS LINES ARE BROKEN.  A person copying a printed question may type it as one paragraph, or press Enter where the
   paper's lines end -- and where the paper breaks its lines is chance.  The finder, the reader and several guards treat a line end as the end of a
   sentence, so the same question came out differently with different line breaks: her own final Q23, typed with the paper's line ends, went to the K
   lookup; floor-plan questions wrapped after "self-weight of" were refused (up to 16 of 238 questions changed; found 10/06 18:10 by wrap-forms.js).
   Before anything reads the question, a line is joined to the line before it, EXCEPT:
     an empty line; an answer line (a blank ____, or "Pu =" with nothing after it) and the line after one; a line that starts a part or a choice
     ("(a) ...", "b. ...", "3) ..."), a dash or bullet list line, a "Given:" / "Find:" heading; a cover-page line and the line after one. */
var UNWRAP_COVER_RE = /(unless\s+(?:otherwise\s+)?noted|exam\s+defaults|cover\s+(?:page|defaults))/i;
function unwrapOwnLine(ln) {
  if (!/\S/.test(ln)) return true;
  if (/_{2,}/.test(ln)) return true;
  if (/=\s*(?:kips?|k|ksi|psf|pcf|plf|klf|k\/ft|kips?\/ft|kip-?\s?ft|k-ft|ft|in\.?|in\.?\s?\^?[234]|lb\/ft)?\s*$/i.test(ln) && ln.replace(/\s+/g, '').length <= 34) return true;
  if (/^\s*(?:\(\s*[a-hA-H]\s*\)|\(\s*(?:i{1,3}|iv|v)\s*\)|[a-hA-H][.)]|\(?\d{1,2}[.)]|(?:part|problem|question|q)\s*\(?[\dA-Ha-h]{1,2}\)?\s*[.:)-])(?:\s|$)/i.test(ln)) return true;
  if (/^\s*(?:[-*]|\u2022|\u2013|\u2014)\s/.test(ln)) return true;
  if (/^\s*(?:given|find|to\s+find|required|determine|note|hint|answer|solution|data|assume)\s*:/i.test(ln)) return true;
  if (/^\s*(?:exam\s+defaults|cover\s+defaults|unless\s+noted)/i.test(ln)) return true;
  if (UNWRAP_COVER_RE.test(ln) && /assume|default/i.test(ln) && ln.length > 80) return true;
  return false;
}
function unwrapTyped(text) {
  var raw = String(text).split('\n'), out = [], i, ln, prev, prevOwn = true;
  /* a line that ends with "=" and whose value stands at the start of the next line ("... Use U =" / "0.85, Fy = 50 ksi") is not an answer line */
  for (i = 0; i + 1 < raw.length; i++) {
    if (/=\s*$/.test(raw[i]) && !/_{2,}/.test(raw[i]) && /^\s*-?\.?\d/.test(raw[i + 1]) && !/_{2,}/.test(raw[i + 1])) { raw.splice(i, 2, raw[i].replace(/\s+$/, '') + ' ' + raw[i + 1].replace(/^\s+/, '')); i--; }
  }
  for (i = 0; i < raw.length; i++) {
    ln = raw[i].replace(/[ \t]+$/, '');
    prev = out.length ? out[out.length - 1] : null;
    if (prev === null || prevOwn || unwrapOwnLine(ln)) {
      out.push(ln);
      /* text goes on after a part label or a list line ("(a) Determine the" / "factored load ..."); it does not go on after an answer line, an empty
         line or a cover-page line */
      prevOwn = !/\S/.test(ln) || /_{2,}/.test(ln) || (UNWRAP_COVER_RE.test(ln) && /assume|default/i.test(ln) && ln.length > 80) || /^\s*(?:exam\s+defaults|cover\s+defaults|unless\s+noted)/i.test(ln)
        || (/=\s*(?:kips?|k|ksi|psf|pcf|plf|klf|k\/ft|kips?\/ft|kip-?\s?ft|k-ft|ft|in\.?|in\.?\s?\^?[234]|lb\/ft)?\s*$/i.test(ln) && ln.replace(/\s+/g, '').length <= 34);
    } else {
      out[out.length - 1] = prev + ' ' + ln.replace(/^[ \t]+/, '');
      prevOwn = false;
    }
  }
  /* A line end was sometimes the ONLY thing between two sentences: her own final, Q20, prints "Dimensions are x = 8 ft, y = 30 ft" / "Determine the design
     moment Mu for beam B1." with no period after "30 ft".  Joined into one line (or typed as one paragraph) the instruction is no longer the start of a
     sentence, the page no longer sees that the question asks about the BEAM, and the floor-plan worksheet runs on to the girder (found 10/06 18:20 by the
     browser scenario that clicks through that question).  A CAPITALISED instruction word after a word that ends no sentence starts a new sentence: the
     period the paper left out is put in.  (Mid-sentence these words are never capitalised.) */
  for (i = 0; i < out.length; i++) {
    if (/_{2,}/.test(out[i])) continue;
    out[i] = out[i].replace(/([a-z0-9"'\)\]%])[ \t]+(?=(?:Determine|Calculate|Compute|Find|Select|Choose|Check|Verify|Evaluate|Estimate|Use|Using|Assume|Neglect|Ignore|Include|Dimensions)\b[ \t]+\S)/g, '$1. ');
    /* (10/06 night, council 3) THE SAME BREAK WHEN HE TYPES IN LOWER CASE with no period: "... is 14 ft long determine the design strength".  A lower-case
       instruction word may stand in the middle of a sentence ("the table is used to find ..."), so the break is made only after something that closes a
       statement of a value: a number with its unit, a closing bracket, or "= number".  The word gets its capital, because a sentence is split only at a
       period that a capital follows. */
    out[i] = out[i].replace(/((?:\d\s?(?:ft|feet|foot|in|inch|inches|kips?|k|ksi|psf|pcf|plf|klf|k\/ft|kips?\/ft|kip-ft|k-ft|lb\/ft|in\^?[234]|%)\.?(?:\s+(?:long|high|tall|deep|wide|apart|on\s+cent(?:er|re)s?|o\.?c\.?|each|total|span))?|[\)\]]|=\s?-?\d+(?:[.\/]\d+)?))[ \t]+(determine|calculate|compute|find|select|check)(?=[ \t]+\S)/g,
      function (m0, a, w) { return a + '. ' + w.charAt(0).toUpperCase() + w.slice(1); });
  }
  /* an instruction or a question word typed in lower case straight after a period: it starts a sentence, and gets the capital that says so (every line,
     answer lines too: no character is added) */
  for (i = 0; i < out.length; i++) {
    out[i] = out[i].replace(/([.?!;][ \t]+)(determine|calculate|compute|find|select|choose|check|verify|evaluate|estimate|use|using|assume|neglect|ignore|include|what|which|how|is|are|does|do|can|will|would|should|if|the|a|an|it|this|that|each|all|both|there|for|when|where|why|explain|describe|define|list|name|state|give|show|draw|sketch|write|convert|express)(?=[ \t]+\S)/g,
      function (m0, a, w) { return a + w.charAt(0).toUpperCase() + w.slice(1); });
  }
  return out.join('\n');
}
SOLVE.unwrapTyped = unwrapTyped;

/* THE PAGE'S WAY IN.  His typing is repaired first (misspelled words, see repairSpelling), then read.  The repairs come back in A.repairs so that the
   page can show them; A.typed is what he typed.  opts.noSpell = read the text exactly as typed (tests that measure the repair use it). */
SOLVE.analyze = function (text, opts) {
  var o = opts || {}, raw = String(text === undefined || text === null ? '' : text), sp, dsp, o2 = {}, k, A;
  if (o.noSpell) return SOLVE.analyzeRead(raw, o);
  sp = repairSpelling(raw);
  dsp = repairSpelling(o.defaults || '');
  for (k in o) if (has(o, k)) o2[k] = o[k];
  if (dsp.repairs.length) o2.defaults = dsp.text;
  /* (10/07) SEVERAL LOOK-UPS IN ONE SENTENCE ("Give W14x90 Ix; C10x20 tw; WT7x45 Sx ... ___; ___; ___.") are rewritten into lettered parts, one look-up
     each, in the order of the text (src/expand.js: text in, text out; a text that is not such a list comes back character for character).  The capitals
     are put back first, because the expander reads shape names and symbols as printed. */
  var body = sp.text, ex = null, EX = typeof SOLVE_EXPAND !== 'undefined' ? SOLVE_EXPAND : null;
  if (EX && typeof EX.expand === 'function' && !o.noExpand) {
    try { ex = EX.expand(recaseTyped(body)); } catch (eX) { ex = null; }
    if (ex && ex.expanded && ex.expanded.length && typeof ex.text === 'string' && /\S/.test(ex.text)) body = ex.text; else ex = null;
  }
  /* (10/07) A MULTIPLE-CHOICE QUESTION IN ANY LAYOUT.  The page knew one layout: "(choose one):" and a choice per line.  A question that prints its
     choices in a row -- "... is called the: (a) Modulus of elasticity (b) Proportional limit (c) Yield point (d) Ultimate strength" -- was cut into four
     PARTS, and each choice got her definition as an "ANSWER" (three of the outside labs' questions).  The order-free matcher (src/wordsx.js) reads the
     choices in every layout; the question is then put into the one layout the rest of the page knows.  Only letters a, b, c ... in order, three choices or
     more, and never a text the matcher takes for a calculation. */
  /* (the regression dump of 10/07 02:50 caught this rewrite turning a CALCULATION with parts -- "A girder spans 30 ft ... 20 k ... 27.5 k ... (a) the
     maximum factored moment, (b) the lightest W16, (c) ..." -- into one "multiple choice" with no letter: two right answers gone.  A text with two or
     more numbers that carry an engineering unit is a calculation and is never rewritten.) */
  var wx0 = o.noWords ? null : wxAnalyze(body), mcTxt = null,
    unitNums = (body.match(/\d\s*-?\s*(?:ft|feet|foot|in\.?|inch(?:es)?|kips?|k|ksi|psi|psf|pcf|plf|klf|k\s?\/\s?ft|kip-ft|k-ft|lbs?(?:\s?\/\s?ft)?)(?![A-Za-z0-9])/gi) || []).length;
  if (unitNums >= 2) wx0 = null;
  if (wx0 && wx0.mc && wx0.mc.options && wx0.mc.options.length >= 3 && wx0.mc.options.length <= 6 && wx0.mc.layout !== 'bare list'
    && wx0.mc.options.every(function (op, k9) { return String(op.ch) === 'abcdef'.charAt(k9) && /\S/.test(String(op.text || '')); })) {
    mcTxt = collapse(String(wx0.mc.stem || '')).replace(/\(?\s*choose\s+(?:one|the\s+best\s+answer|the\s+correct\s+answer)\s*\)?\s*:?/gi, ' ').replace(/[\s:]+$/, '');
    if (/\S/.test(mcTxt)) body = mcTxt + ' (choose one):' + '\n' + wx0.mc.options.map(function (op) { return op.ch + ' ' + collapse(String(op.text)).replace(/[\s.;,]+$/, ''); }).join('\n');
  }
  A = SOLVE.analyzeRead(body, o2);
  A.repairs = sp.repairs.concat(dsp.repairs);
  A.unknownWords = (sp.unknown || []).slice(0, 12);
  A.expanded = ex ? ex.expanded : [];
  A.typed = raw;
  return A;
};
/* the pasted text -> parts.  opts.defaults = the exam-defaults line the student pasted once (optional) */
SOLVE.analyzeRead = function (text, opts) {
  var E = env(), o = opts || {}, body = normalizeTyped(String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n')), routed, parts = [], cover, defaultsLine, n = 0, i, r, subs, k, label;
  if (!/\S/.test(body)) return { text: body, stem: '', parts: [] };
  if (!o.keepLines) body = unwrapTyped(body);
  /* THE COVER PAGE IS ONE LINE, however he types it.  Her cover page is PRINTED as a list, one assumption to a line, and a person copies it that way.  The
     reader takes only whole leading lines as cover page, so a cover page typed on eleven lines left ten of them in the QUESTION: every column and every beam
     stopped on the nonsense 'The number "1.0 - K" is in your text but in no box', and "connection shear lag factor U=1.0" was read as the question's own U
     (704 kips for 633.6 on a question that says to use Table D3.1) -- while the note under the box said "the page understood 6 assumptions", because the note
     did collapse the lines.  In every build since the box was added (Updates 10 to 12).  Found 10/06 16:50 by typing it the way it is printed. */
  defaultsLine = normalizeTyped(collapse(o.defaults || ''));
  if (defaultsLine && !/(unless\s+(?:otherwise\s+)?noted|exam\s+defaults|cover\s+page)/i.test(defaultsLine)) defaultsLine = 'Exam defaults (cover page): unless noted otherwise, assume: ' + defaultsLine;
  cover = coverLines(body);
  /* A multiple-choice question is ONE question: its lettered choices must not be split off as parts (a) (b) (c).
     Choices that are words -> a word question (each choice is shown with her wording).  Choices that are numbers -> the question is worked out without them,
     and the choices are shown next to the answer so he can pick the one that matches. */
  var mc = null, mcNote = null, routeBody = body;
  try { mc = mcChoices(body); } catch (em) { mc = null; }
  try {
    if (mc && choicesAreWords(mc)) {
      r = wordsRoute(E.FINDER.identify('', protectRefs(body)), ['multiple choice']);
      r.letter = ''; r.text = body; r.question = body; r.mcWords = true;
      routed = { stem: '', parts: [r] };
    } else {
      if (mc && mc[0].start > 20) { routeBody = trim(body.slice(0, mc[0].start)); mcNote = mc.map(function (c) { return c.ch + '. ' + String(c.text).replace(/\s+/g, ' '); }); }
      routed = routeText(routeBody);
    }
  }
  catch (e0) { return { text: body, stem: '', parts: [errorPart('', trim(body), 'p1', 'the question could not be split into parts (' + plainError(e0) + ')')] }; }
  /* one part that cannot be built must never take the other parts down: it becomes an "error" part that shows why and keeps his text */
  for (i = 0; i < routed.parts.length; i++) {
    r = routed.parts[i];
    try { var am = amendRoute(r, r.text, routed.stem); if (am !== r) { am.letter = r.letter; am.text = r.text; r = am; routed.parts[i] = am; } } catch (ea) { /* the finder's own route stands */ }
    try {
      try { subs = o.noSplit ? [] : splitAsks(routed.stem, r); } catch (es) { subs = []; }
      for (k = 0; k < subs.length; k++) { try { var am2 = amendRoute(subs[k].route, subs[k].route.text, subs[k].stem); if (am2 !== subs[k].route) { am2.text = subs[k].route.text; subs[k].route = am2; } } catch (ea2) { /* keep */ } }
      if (subs.length) {
        for (k = 0; k < subs.length; k++) {
          label = (r.letter ? r.letter + '.' : '') + (k + 1);
          try {
            parts.push(makePart(subs[k].stem, subs[k].route.text, subs[k].route, label, defaultsLine, cover, 'p' + (++n)));
            parts[parts.length - 1].split = true;
          } catch (e2) { parts.push(errorPart(label, subs[k].route.text, 'p' + n, plainError(e2))); }
        }
      } else {
        parts.push(makePart(routed.stem, r.text, r, r.letter, defaultsLine, cover, 'p' + (++n)));
        if (r.family === 'words') {
          try { var pk = mcChoices(r.text) ? SOLVE.choicePick(r.text) : null; if (pk) parts[parts.length - 1].mc = pk; } catch (eP) { /* no pick */ }
          /* (10/07) the order-free matcher's reading of the same part: her sentences that share the question's words, and -- for a multiple choice --
             a letter when her sentences support exactly ONE choice.  Two rules that name two different letters give NO letter. */
          try {
            var wxp = wxAnalyze(r.text), cur9 = parts[parts.length - 1];
            if (wxp && !wxp.calculation) {
              cur9.wx = wxp;
              if (cur9.mc && wxp.mc && wxp.mc.pick && /^[a-f]$/.test(String(wxp.mc.pick.ch || ''))) {
                if (!cur9.mc.best) {
                  var opt9 = (cur9.mc.choices || []).filter(function (c9) { return String(c9.ch) === String(wxp.mc.pick.ch); })[0];
                  if (opt9) { cur9.mc.best = opt9; cur9.mc.kind = 'sentences'; cur9.mc.why = 'her sentence for "' + wxp.mc.pick.term + '" has the words of your question: "' + collapse(wxp.mc.pick.sentence).slice(0, 220) + '"'; }
                } else if (String(cur9.mc.best.ch) !== String(wxp.mc.pick.ch)) { cur9.mc.best = null; cur9.mc.why = ''; cur9.mc.twoLetters = true; }
              }
            }
          } catch (eW) { /* the part stands without it */ }
        }
      }
    } catch (e1) { parts.push(errorPart(r && r.letter, r && r.text, 'p' + (++n), plainError(e1))); }
  }
  if (mcNote) for (i = 0; i < parts.length; i++) parts[i].choiceNote = mcNote;
  /* every part knows the WHOLE question's own words (without the cover lines): what an earlier part asks decides how a later part is read.
     (Mock exam P1 with her cover page typed in: part (a) asks for the shear lag factor U, parts (b) to (d) do not say the word, and the cover page's
     "U = 1.0 unless noted otherwise" was applied to them: 704 kips printed where 633.6 is right.  The QUESTION notes otherwise.) */
  var wholeQ = body;
  for (i = 0; i < cover.length; i++) wholeQ = wholeQ.split(cover[i]).join(' ');
  for (i = 0; i < parts.length; i++) parts[i].whole = wholeQ;
  /* what is asked and what is given: see signaturePass.  Whatever goes wrong there, the finder's routes stand. */
  if (!o.noSignature) { try { signaturePass(parts, cover, body); } catch (eS) { for (i = 0; i < parts.length; i++) { try { delete parts[i].ui; } catch (eD) { /* keep */ } } } }
  return { text: body, stem: routed.stem, parts: parts };
};
/* a message a student can read, from whatever was thrown */
function plainError(e) {
  var m = String(e && e.message ? e.message : e).replace(/\s+/g, ' ');
  return m.length > 180 ? m.slice(0, 178) + '..' : m;
}
SOLVE.plainError = plainError;
/* a part that could not be built or read: it has no stages, it shows why, and the others are unaffected */
function errorPart(label, text, id, why) {
  var t = trim(text);
  return { id: id, label: label || '', text: t, stem: '', ctx: t, stemLen: 0, coverLen: 0, kind: 'error', errorText: why, stages: [], notIn: [], figure: false, others: [], defaultsLine: '',
    route: { traps: [], marks: { family: [], form: [] }, family: null, fn: null, tab: null, form: null, want: null, question: t, also: [], by_default: false, rider: false } };
}
SOLVE.errorPart = errorPart;
/* a part whose reading threw: it becomes an error part in place (same object, so the page's references stay valid) */
SOLVE.failPart = function (part, err) {
  part.kind = 'error'; part.errorText = plainError(err); part.stages = [];
  return part;
};
/* the student picked a form himself (no form matched, or he disagrees with the finder) */
function copyRouteFor(route, fn) {
  var out = {}, k, f = formOf(fn);
  for (k in route) if (has(route, k)) out[k] = route[k];
  out.fn = fn; out.tab = f ? f.label : fn; out.then = null; out.then_fn = null; out.combo_first = false; out.want = null; out.also = []; out.by_default = false;
  out.clear = true; out.rider = false; out.family = route.family === 'words' ? null : route.family; out.page = null;
  return out;
}
SOLVE.chooseForm = function (part, fn) {
  part.stages = [{ role: 'main', fn: fn }];
  part.kind = 'form';
  part.forced = fn;
  part.route = copyRouteFor(part.route, fn);
  part.others = [];
  return part;
};
/* a second card for the same words with another form ("Also solve ...") */
SOLVE.cloneForForm = function (part, fn) {
  var c = {}, k;
  for (k in part) if (has(part, k) && k !== 'ui' && k !== 'stages') c[k] = part[k];
  c.id = part.id + '+' + fn; c.stages = []; c.alsoOf = part.id; c.split = part.split;
  SOLVE.chooseForm(c, fn);
  return c;
};
/* the other forms of the same family whose giveaway words are ALSO in the question: "Compare the Euler load with the AISC design strength" asks for two things,
   the finder gives one form per part.  [{fn, tab, want, words}] */
var GENERIC_SIGNALS = ' an ok strength capacity select choose check the resist largest governs allowable adequate satisfactory floor beam girder slab moment shear reaction diagram tributary ';
function otherForms(route) {
  var F = env().FINDER, D = F.DATA, forms = D && D.forms && route.family && D.forms[route.family], Qn, out = [], i, j, f, sig, hits, un, tabInfo, shown, m;
  if (!forms || !route.question) return out;
  Qn = F.norm(route.question);
  for (i = 0; i < forms.length; i++) {
    f = forms[i];
    if (f.id === route.form || !f.signals || !f.signals.length) continue;
    hits = [];
    for (j = 0; j < f.signals.length; j++) {
      sig = F.hit(f.signals[j], Qn);
      if (!sig) continue;
      shown = String(sig).replace(/^re:.*\|/, '');
      /* common English, not a giveaway word: skip it */
      if (shown.replace(/\s+/g, '').length < 5 || GENERIC_SIGNALS.indexOf(' ' + shown.replace(/^\s+|\s+$/g, '').toLowerCase() + ' ') >= 0) continue;
      hits.push(shown);
    }
    if (!hits.length) continue;
    un = []; for (j = 0; j < (f.unless || []).length; j++) if (F.hit(f.unless[j], Qn)) un.push(1);
    if (un.length) continue;
    tabInfo = D.tabs[f.tab];
    if (!tabInfo || !tabInfo[1] || tabInfo[1] === route.fn) continue;
    out.push({ fn: tabInfo[1], tab: f.tab, want: f.want, words: hits.slice(0, 3) });
  }
  /* the classic pair: an Euler question that also asks for the AISC design strength ("Compare the Euler load with the AISC strength") */
  if (route.fn === 'column_euler' && !out.some(function (o) { return o.fn === 'column_capacity'; })) {
    m = /\b(AISC|design\s+strength|allowable\s+(?:compress|load)|phi\s*_?\s*c?\s*\*?\s*Pn|compressive\s+strength|capacity)\b/i.exec(route.question);
    if (m) out.push({ fn: 'column_capacity', tab: '4 Column > Capacity of a column', want: 'Capacity, KL/r, which axis governs, or whether it is adequate', words: [m[0]] });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ chains: what a later form takes from an earlier one */
var CARRY = {
  'loads_combinations>column_capacity': { unit: 'kips', set: { already_factored: true }, from: 'Pu', drop: ['D', 'L'] },
  'loads_combinations>column_select': { unit: 'kips', set: { already_factored: true }, from: 'Pu', drop: ['D', 'L'] },
  'loads_combinations>tension_capacity': { unit: 'kips', set: { already_factored: true }, from: 'Pu', drop: ['D', 'L'] },
  'loads_combinations>tension_select': { unit: 'kips', set: { already_factored: true }, from: 'Pu', drop: ['D', 'L'] },
  'loads_combinations>tension_required_area': { unit: 'kips', set: { already_factored: true }, from: 'Pu', drop: ['D', 'L'] },
  'loads_combinations>loads_factored': { unit: '', set: { already_factored: true }, from: 'factored_value', drop: ['D', 'L'] },
  'loads_combinations>beam_analysis': { unit: 'k/ft', set: { already_factored: true }, from: 'w_u', drop: ['wD', 'wL', 'self_weight_plf', 'w_includes_self_weight'] },
  'loads_combinations>beam_select': { unit: 'k/ft', set: { 'analysis.already_factored': true }, from: 'analysis.w_u', drop: ['analysis.wD', 'analysis.wL', 'analysis.self_weight_plf', 'analysis.w_includes_self_weight'] },
  'loads_takedown>column_select': { unit: '', set: { already_factored: true }, from: 'Pu', drop: ['D', 'L'], take: 'Pu_bottom' },
  'column_capacity>loads_max_service': { unit: '', set: {}, from: 'phiRn', drop: [], take: 'phiPn' },
  'tension_capacity>loads_max_service': { unit: '', set: {}, from: 'phiRn', drop: [], take: 'capacity' }
};
function carryRule(prevFn, fn) { return CARRY[prevFn + '>' + fn] || null; }
/* the boxes of stage i that come from stage i-1: path -> a sentence for the student */
function carriedFor(part, i) {
  if (i === 0) return null;
  var prev = part.stages[i - 1], cur = part.stages[i], rule = carryRule(prev.fn, cur.fn), out = {}, k;
  if (!rule) return null;
  for (k in rule.set) if (has(rule.set, k)) out[k] = 'set by the first calculation (' + prev.fn + ')';
  out[rule.from] = 'carried automatically from step ' + i + ' (' + prev.fn + ')';
  for (k = 0; k < rule.drop.length; k++) out[rule.drop[k]] = 'not used: the load comes from step ' + i;
  return out;
}

/* The rule reader gives the weak axis the SAME length as the strong axis when the text names one length ("rule used: one length, same for both axes").  That is an
   assumption, not words.  When the text also speaks of bracing the weak axis (the finder's "weak-brace" trap) the assumption is probably wrong, so the value is not
   proposed: it becomes a choice the student must make (use it, or type the weak-axis length / segments). */
function flagAssumedLengths(part, boxes) {
  var i, b;
  if (!hasTrap(part.route, 'weak-brace')) return;
  for (i = 0; i < boxes.length; i++) {
    b = boxes[i];
    if ((b.name === 'Ly_ft' || b.name === 'KLy_ft') && b.state === 'rule' && b.rule && /same for both axes/i.test(b.rule.rule || '')) {
      b.alts = [{ src: 'rules', ui: b.proposal, words: b.words.length ? b.words[0].text : '', note: 'assumed: the same length as the strong axis' }];
      b.state = 'conflict'; b.proposal = undefined; b.assumed = true;
      b.notes.push('Your text speaks of bracing the weak axis, so its length may be SHORTER than the full length.');
    }
  }
}

/* ------------------------------------------------------------------------------------------------ reading one stage of a part */
function setNested(obj, path, val) {
  var p = path.split('.'), cur = obj, i;
  for (i = 0; i < p.length - 1; i++) { if (!isObj(cur[p[i]])) cur[p[i]] = {}; cur = cur[p[i]]; }
  cur[p[p.length - 1]] = val;
}
function getNested(obj, path) {
  var p = path.split('.'), cur = obj, i;
  for (i = 0; i < p.length; i++) { if (cur === undefined || cur === null) return undefined; cur = cur[p[i]]; }
  return cur;
}

function safeRuleRead(E, part, fn) {
  if (!E.READER || typeof E.READER.read !== 'function') return { res: null, error: 'the rule reader is not loaded' };
  try { return { res: E.READER.read(part.ctx, { fn: fn, noParts: true, partStart: part.stemLen, whole: part.whole || '' }), error: null }; }
  catch (e) { return { res: null, error: String(e && e.message ? e.message : e) }; }
}

/* the words question: the student types or confirms what to look up; no model is involved (the engine matches the NAMES of her entries) */
function wordsQuery(part) {
  if (part.mc) return collapse(part.mc.best ? part.mc.best.text : part.mc.stem).slice(0, 700);
  var t = collapse(part.text).replace(/^\(?[a-h]\)\s*/i, '').replace(/^word\s+question\s*(?:\([^)]*\))?\s*\.?\s*/i, '');
  return t.length > 700 ? t.slice(0, 700) : t;
}
var STOPW = ' the a an of in to and or is are it its that this what why how does do did for with on at by be as if not no from can which who when where there their they you your we she her his into than then also each every any all some one two three four name list give state define explain describe called mean means meant briefly sentence words use used using steel member members structural following answer ';
SOLVE.searchWords = function (question) {
  var w = String(question).toLowerCase().replace(/[^a-z0-9\/ -]/g, ' ').split(/\s+/), out = [], i;
  for (i = 0; i < w.length; i++) { if (w[i].length < 3 || STOPW.indexOf(' ' + w[i] + ' ') >= 0) continue; if (out.indexOf(w[i]) < 0) out.push(w[i]); }
  return out.slice(0, 5);
};

/* A word question ("explain", "why", "give two ...") is rarely answered by ONE entry.  relatedEntries collects every entry of hers that a word (or two words in a
   row) of the question names: her own sentences, for him to choose from and copy.  It is reference material, not an answer.  [{term, text, via}] */
var RELATED_STOP = ' check plus number numbers line lines name things thing sentence change changes taken account accounts used uses even include includes leaves leave mean means called table tables equation equations why how what does when then give two three one ';
SOLVE.relatedEntries = function (text, max) {
  var root2 = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}), G = (root2.STEEL_DATA && root2.STEEL_DATA.glossary) || [],
    E = env(), q = ' ' + String(text || '').toLowerCase().replace(/w\/o/g, ' without ').replace(/[^a-z0-9]+/g, ' ') + ' ', qw = [], qs = {}, scored = [], out = [], i, j, e, s, t, hit, why, n, r, quote;
  contentWords(text).forEach(function (w) { if (RELATED_STOP.indexOf(' ' + w + ' ') < 0) { qw.push(w); qs[stemOf(w)] = w; } });
  /* short symbols count too: phi, U, K, Fy ... */
  (q.match(/ (phi|lrfd|asd|fy|fu|kl|u|k|ae|an|ag|fcr|pcr) (?= )/g) || []).forEach(function (m0) { var w = trim(m0); qs[w] = w; });
  function norm(x) { return ' ' + String(x || '').toLowerCase().replace(/w\/o/g, ' without ').replace(/[^a-z0-9]+/g, ' ') + ' '; }
  function nameWords(e0) { return trim(norm(e0.term)).split(' ').filter(function (w) { return w.length >= 4 || /^(phi|lrfd|asd|fy|fu|kl|u|k|ae|an|ag|fcr|pcr)$/.test(w); }); }
  /* a word that sits in the names of many entries (column, area, factor) says little; a rare one (Euler, ductile, phi) says a lot */
  var df = {}, nameHit;
  for (i = 0; i < G.length; i++) { var seenW = {}; nameWords(G[i]).forEach(function (w) { var k = w.length >= 4 ? stemOf(w) : w; if (!seenW[k]) { seenW[k] = 1; df[k] = (df[k] || 0) + 1; } }); }
  function weight(k) { var d = df[k] || 1; return d <= 3 ? 6 : (d <= 8 ? 4 : (d <= 20 ? 2 : 1)); }
  for (i = 0; i < G.length; i++) {
    e = G[i]; s = 0; why = []; nameHit = false;
    /* a name of hers (or one of its other wordings) that the question says outright */
    [e.term].concat(e.synonyms || []).forEach(function (ph) {
      var p = norm(String(ph).replace(/\([^)]*\)/g, ' '));
      if (trim(p).length >= 3 && q.indexOf(p) >= 0 && (trim(p).indexOf(' ') > 0 || trim(p).length >= 5 || /^(phi|u|k)$/.test(trim(p)))) { s += trim(p).indexOf(' ') > 0 ? 6 : 4; nameHit = true; if (why.indexOf(trim(p)) < 0) why.push(trim(p)); }
    });
    /* the question's own words in the name of the entry, then in her sentence */
    n = 0;
    nameWords(e).forEach(function (w) { var k = w.length >= 4 ? stemOf(w) : w; if (has(qs, k)) { s += weight(k); nameHit = true; if (why.indexOf(qs[k]) < 0) why.push(qs[k]); } });
    quote = norm((e.definitions || []).map(function (d) { return d.quote; }).join(' '));
    for (j in qs) if (has(qs, j) && contentWords(quote).some(function (w) { return stemOf(w) === j; })) n++;
    s += Math.min(n, 4);
    if ((nameHit && s >= 3) || s >= 6) scored.push({ e: e, s: s, why: why });
  }
  scored.sort(function (a, b) { return b.s - a.s || a.e.n - b.e.n; });
  for (i = 0; i < scored.length && out.length < (max || 8); i++) {
    e = scored[i].e; r = null;
    try { r = E.STEEL.run('lookup_definition', { query: e.term }); } catch (e2) { r = null; }
    if (r && r.ok && r.answer && r.values && r.values.term && String(r.values.term.value) === String(e.term)) out.push({ term: e.term, text: String(r.answer.text), via: scored[i].why.join(', '), score: scored[i].s });
    else out.push({ term: e.term, text: e.term + ': ' + (e.definitions || []).map(function (d) { return '"' + d.quote + '"'; }).join(' / ') + (e.source ? '  (' + e.source + ')' : ''), via: scored[i].why.join(', '), score: scored[i].s });
  }
  return out;
};

/* deps = { callModel(body) -> thenable of the parsed JSON object | null, model: name | null, options: {...} }
   Whatever goes wrong while a stage is read turns THIS part into an error part (see failPart); done() is still called, once, so the queue of parts goes on. */
SOLVE.readStage = function (part, si, deps, done) {
  var called = false;
  function once(st) { if (called) return; called = true; done(st); }
  try { readStageInner(part, si, deps, once); }
  catch (e) {
    if (called) throw e;                           /* the page's own callback threw: not a reading problem */
    SOLVE.failPart(part, e);
    once(null);
  }
};
function readStageInner(part, si, deps, done) {
  var E = env(), stage = part.stages[si], fn = stage.fn, boxes = boxesOf(fn), carried = carriedFor(part, si), i, rr, rm, ruleQs, info;
  deps = deps || {};
  for (i = 0; i < boxes.length; i++) boxes[i].fn = fn;
  stage.form = formOf(fn);
  stage.boxes = boxes;
  stage.carried = carried;
  stage.read = { llm: null, llmError: null, llmUsed: false, ruleError: null, ignored: [], warnings: [], droppedByRules: [], unused: [], ruleQuestions: [], carried: carried };
  if (stage.role === 'words') {
    var q = wordsQuery(part);
    boxes[0].state = 'rule'; boxes[0].proposal = q; boxes[0].words = [{ src: 'rules', text: q }]; boxes[0].notes = ['the whole question is used as the search: the engine looks for the NAMES of her entries inside it'];
    boxes[0].alts = []; boxes[0].llm = null; boxes[0].rule = null; boxes[0].askNow = false;
    var gh0 = grabHint(fn, boxes[0]); boxes[0].grab = gh0 ? gh0.text : null; boxes[0].grabGroup = gh0 ? gh0.group : null;
    stage.read.done = true;
    done(stage);
    return;
  }
  rr = safeRuleRead(E, part, fn);
  rm = ruleMap(rr.res, boxes);
  ruleQs = rr.res && rr.res.questions ? rr.res.questions : [];
  stage.read.ruleError = rr.error;
  stage.read.ignored = rm.ignored;
  stage.read.warnings = rr.res && rr.res.warnings ? rr.res.warnings.slice() : [];
  stage.read.droppedByRules = rr.res && rr.res.notStoredInThisForm ? rr.res.notStoredInThisForm.slice() : [];
  stage.read.unplaced = rr.res && rr.res.unplaced ? rr.res.unplaced.slice() : [];
  stage.read.ruleQuestions = ruleQs;
  function finish(fill) {
    var L = {}, lq = [];
    try {
      if (fill && fill.ok) {
        L = llmMap(fill, boxes, part.ctx); lq = fill.questions || []; stage.read.llmUsed = true; stage.read.llm = fill;
        /* the model reader also lists numbers (with units) that none of ITS boxes used: candidates too; computeUnused removes whatever the final boxes cover */
        if (isArr(fill.unplaced)) stage.read.unplaced = (stage.read.unplaced || []).concat(fill.unplaced);
      }
      else if (fill && fill.error) { stage.read.llmError = fill.error; stage.read.llm = fill; }
      mergeBoxes(boxes, L, rm.map, ruleQs, lq, carried);
      flagAssumedLengths(part, boxes);
      stage.refuse = null; stage.refuseHard = false; stage.plateWhere = false; stage.refuseUnless = null;
      markReaderStops(stage, ruleQs);
      /* (unit D) the THEORETICAL K has an answer line of its own now (signaturePass sets theoLine): the reader's stop for it is lifted for the K look-up */
      if (part.theoLine && fn === 'lookup_K' && /\bTHEORETICAL K\b/.test(String(stage.refuse || ''))) { stage.refuse = null; stage.refuseHard = false; }
      markLevel(part, stage);
      markAdequacy(part, stage);
      markFloorPlan(part, stage);
      markBuiltUp(part, stage);
      markFy(part, stage);
      markHoles(part, stage);
      markBracing(part, stage);
      markAxes(part, stage);
      markDepth(part, stage);
      markPosition(part, stage);
      markSlab(part, stage);
      markGrade(part, stage);
      markStagger(part, stage);
      stage.read.unused = computeUnused(part, stage);
    } catch (e) {
      /* never a dead page: if merging the two readers failed, the student still gets every box, empty, and a note */
      stage.read.mergeError = plainError(e);
      try { mergeBoxes(boxes, {}, {}, [], [], carried); stage.read.unused = []; }
      catch (e3) { SOLVE.failPart(part, e3); stage.read.done = true; done(stage); return; }
    }
    stage.read.done = true;
    done(stage);
  }
  if (deps.callModel && deps.model && E.LLMREADER && typeof E.LLMREADER.fill === 'function') {
    try {
      var opts = { engine: E.STEEL, model: deps.model, options: deps.options || {} }, p;
      p = E.LLMREADER.fill(part.ctx, fn, deps.callModel, opts);
      if (p && typeof p.then === 'function') p.then(finish, function (err) { finish({ ok: false, error: String(err && err.message ? err.message : err) }); });
      else finish(p);
    } catch (e) { finish({ ok: false, error: String(e && e.message ? e.message : e) }); }
  } else finish(null);
}

/* numbers with a unit in the text that no box (of either reader) used: the rule reader lists them, minus any the final boxes cover */
/* what KIND of quantity a phrase of the text is, and what kind each box of a form takes: a number whose kind no box of the form takes cannot be a missed input of
   this form (the stem's loads are no concern of a part that only looks up a shape), so it is not listed as "used by no box" */
function kindOfText(t) {
  var x = String(t).toLowerCase();
  if (/kip\s*-?\s*(?:ft|in)|\bk\s*-\s*(?:ft|in)|(?:ft|in)\s*-\s*kips?/.test(x)) return 'moment';
  if (/k\s*\/\s*ft|kips?\s*\/\s*(?:ft|foot)|klf|lbs?\.?\s*\/\s*(?:ft|foot)(?![\^\d])|plf/.test(x)) return 'lineload';
  if (/psf|lbs?\.?\s*\/\s*(?:sq|sf|ft\s*\^?\s*2)/.test(x)) return 'psf';
  if (/pcf|lbs?\.?\s*\/\s*(?:cu|ft\s*\^?\s*3)/.test(x)) return 'pcf';
  if (/ksi|psi/.test(x)) return 'stress';
  if (/sq\.?\s*ft|square\s+(?:feet|foot)|\bsf\b|in\s*\^\s*2|sq\.?\s*in/.test(x)) return 'area';
  if (/\d\s*-?\s*(?:kips?|k|lbs?|pounds)\b/.test(x)) return 'force';
  if (/\d\s*-?\s*(?:ft|feet|foot|')/.test(x)) return 'length';
  if (/\d\s*-?\s*(?:in|inch|inches|")(?![a-z])/.test(x)) return 'length';
  if (/(?:holes?|bolts?|lines|rows?|floors?|stories|levels?|angles?|plates?|spans?|bays?)\b/.test(x)) return 'count';
  return null;
}
function kindOfBoxUnit(u) {
  var x = String(u || '').toLowerCase();
  if (x === 'in' || x === 'ft') return 'length';
  if (x === 'kips' || x === 'lb') return 'force';
  if (x === 'k/ft' || x === 'lb/ft') return 'lineload';
  if (x === 'kip-ft' || x === 'kip-in') return 'moment';
  if (x === 'ksi' || x === 'psi') return 'stress';
  if (x === 'psf') return 'psf';
  if (x === 'pcf') return 'pcf';
  if (x === 'sq ft' || x === 'in^2') return 'area';
  return null;
}
function boxKinds(stage) {
  var out = {}, i, j, b, k;
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    k = kindOfBoxUnit(b.unit); if (k) out[k] = true;
    if (b.kind === 'num' && !b.unit) { out.force = true; out.lineload = true; out.psf = true; }       /* a number box with no unit (the loads of the combinations form) takes any load */
    if (b.kind === 'int' || b.kind === 'list' || b.kind === 'numlist') out.count = true;
    if (b.items) for (j = 0; j < b.items.length; j++) { k = kindOfBoxUnit(b.items[j].unit); if (k) out[k] = true; if (b.items[j].kind === 'int') out.count = true; }
  }
  return out;
}
/* numbers the two readers' own lists leave out: stresses (the rule reader skips ksi / psi / pcf) and counts of things (three holes, 4 bolts, two floors) */
function extraCandidates(text) {
  var out = [], m, re1 = /(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\d+\/\d+)\s*(?:ksi|psi|pcf)\b/gi, re2 = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:\w+\s+)?(?:holes?|bolts?|lines|rows?|floors?|stories|levels?|angles?|plates?|spans?|bays?)\b/gi;
  while ((m = re1.exec(text)) !== null) {
    if (/^(?:29,?000|11,?200)\s*ksi$/i.test(m[0])) continue;       /* E and G of steel are constants of the engine */
    out.push({ text: m[0], value: null, unit: 'stress' });
  }
  while ((m = re2.exec(text)) !== null) out.push({ text: m[0], value: null, unit: 'count' });
  return out;
}
/* the numbers inside rolled-shape names of the text ("L6 x 4 x 1/2" -> 6, 4, 0.5; "W14 x 90" -> 14, 90): "the 6-in leg" is the shape, not an input.  (Plates "PL 3/8 x 10" are NOT listed: those are inputs.) */
function shapeDims(text) {
  /* a leg may be a mixed number with a hyphen or a space: L5 x 3-1/2 x 1/2 */
  var out = {}, re = /\b(?:WT|MT|ST|HP|HSS|MC|W|M|S|C|L)\s?(\d+(?:[\s-]+\d+\/\d+|\.\d+)?(?:\s*[xX]\s*\d+(?:[\s-]+\d+\/\d+|\/\d+|\.\d+)?){1,2})/g, m, parts, i, v;
  while ((m = re.exec(String(text))) !== null) {
    parts = m[1].split(/\s*[xX]\s*/);
    for (i = 0; i < parts.length; i++) { try { v = parseNum(String(parts[i]).replace(/^(\d+)-(\d+\/\d+)$/, '$1 $2')); } catch (e) { v = NaN; } if (isFinite(v)) out[String(rnd9(v))] = 1; }
  }
  return out;
}
/* a number that equals the value a box holds when it is left empty (its usual value; 50 ksi / 65 ksi for a W shape's steel) is not a missed input */
function coveredByDefault(stage, p, text) {
  var i, b, v, hasW = /\bW\s?\d+\s*[xX]\s*\d/.test(String(text));
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    if (b.state === 'carried' || (b.kind !== 'num' && b.kind !== 'int')) continue;
    v = SOLVE.valueForBox(p, b);
    if (v === null) continue;
    if (b.defaultValue !== undefined && b.defaultValue !== null && b.defaultValue !== '' && typeof b.defaultValue !== 'object' && Number(v) === Number(b.defaultValue)) return true;
    if (hasW && ((b.name === 'Fy' && p.unit === 'ksi' && p.value === 50) || (b.name === 'Fu' && p.unit === 'ksi' && p.value === 65))) return true;
  }
  return false;
}
/* A number that is ALREADY in a box of this form -- read there from other words, or worked out by a rule ("at mid-span" -> 15 ft; a brace "at mid-height
   (14 ft above the base)" -> Ly = 14 ft; "two bolt holes in the top flange" when "two lines of bolts in each flange" filled the box) -- is not a missed input.
   Asking "which box does 15 ft belong in?" about it only holds back a right answer (10/06: 16 of the mock's 41 parts stopped on such questions). */
/* how many number boxes of the stage hold exactly this value (see computeUnused: a load that stands twice in the text needs two of them) */
function boxesHolding(stage, p) {
  var i, b, v, n = 0, x;
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    if ((b.state !== 'agree' && b.state !== 'model' && b.state !== 'rule') || (b.kind !== 'num' && b.kind !== 'int')) continue;
    v = SOLVE.valueForBox(p, b);
    if (v === null) continue;
    try { x = parseNum(b.proposal); } catch (e) { x = NaN; }
    if (isFinite(Number(v)) && isFinite(x) && Math.abs(Number(v) - x) <= 1e-6 * Math.max(1, Math.abs(x))) n++;
  }
  return n;
}
function coveredByBoxValue(stage, p) {
  var i, j, k, b, v, sub, sv, list;
  function same(a, c) { a = Number(a); c = Number(c); return isFinite(a) && isFinite(c) && Math.abs(a - c) <= 1e-6 * Math.max(1, Math.abs(c)); }
  function num(x) { var n; try { n = parseNum(x); } catch (e) { n = NaN; } return n; }
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    if (b.state !== 'agree' && b.state !== 'model' && b.state !== 'rule') continue;
    if (b.kind === 'num' || b.kind === 'int') {
      v = SOLVE.valueForBox(p, b);
      if (v !== null && same(v, num(b.proposal))) return true;
    } else if (b.kind === 'list' && isArr(b.proposal) && b.items) {
      for (j = 0; j < b.proposal.length; j++) for (k = 0; k < b.items.length; k++) {
        sub = b.items[k]; sv = b.proposal[j] ? b.proposal[j][sub.name] : undefined;
        if (sv === undefined || sv === null || sv === '' || (sub.kind !== 'num' && sub.kind !== 'int')) continue;
        v = SOLVE.valueForBox(p, { kind: sub.kind, unit: sub.unit });
        if (v !== null && same(v, num(sv))) return true;
      }
    } else if (b.kind === 'numlist') {
      list = toNumList(b.proposal) || [];
      v = SOLVE.valueForBox(p, { kind: 'num', unit: b.unit });
      for (j = 0; j < list.length; j++) if (v !== null && same(v, list[j])) return true;
    }
  }
  return false;
}
function computeUnused(part, stage) {
  var un = (stage.read.unplaced || []).concat(extraCandidates(part.ctx)), out = [], seenText = {}, spans = [], i, j, b, w, sp, u, at, text = part.ctx, hay, needle, found, covered, from, pv, dims = shapeDims(part.ctx);
  from = part.stemLen;
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    if (b.state === 'carried') continue;
    for (j = 0; j < b.words.length; j++) { sp = SOLVE.spansFor(text, [b.words[j].text], from); spans = spans.concat(sp); }
    for (j = 0; j < b.alts.length; j++) { sp = SOLVE.spansFor(text, [b.alts[j].words], from); spans = spans.concat(sp); }
  }
  /* the words of the covered spans, squeezed ("L = 24 ft" -> "l=24ft"), so a second mention of the same quantity ("24-ft") counts as used too */
  var squeezed = [], sq = function (s) { return ' ' + String(s).toLowerCase().replace(/[\s\-]+/g, ' ').replace(/^ | $/g, '') + ' '; };
  for (i = 0; i < spans.length; i++) squeezed.push(sq(text.slice(spans[i][0], spans[i][1])));
  function sameQuantityCovered(key) {
    var re = new RegExp('[^0-9a-z.]' + key.replace(/^ | $/g, '').replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '(?![a-z0-9])'), s2;
    for (s2 = 0; s2 < squeezed.length; s2++) if (re.test(squeezed[s2])) return true;
    return false;
  }
  var hasFy = false, hasFu = false;
  for (i = 0; i < stage.boxes.length; i++) { if (stage.boxes[i].name === 'Fy') hasFy = true; if (stage.boxes[i].name === 'Fu') hasFu = true; }
  var kindsHere = boxKinds(stage), kt;
  for (i = 0; i < un.length; i++) {
    u = un[i]; needle = collapse(u.text).replace(/[.,;:]+$/, '');         /* "12 ft." and "12 ft" are one number */
    if (!needle || seenText[needle]) continue;
    seenText[needle] = 1;
    kt = kindOfText(needle);
    if (kt && !kindsHere[kt]) continue;                                   /* no box of this form takes this kind of quantity */
    pv = SOLVE.numberFromText(needle);
    if (pv && pv.value === 0) continue;                                   /* "Lb = 0 ft", "0 holes": nothing to put in a box */
    if (pv && coveredByDefault(stage, pv, text)) continue;                /* the box would hold exactly this value when left empty */
    /* (10/07, the rough-typing run) A LOAD THAT STANDS TWICE IN THE TEXT WITH ONE VALUE IS TWO LOADS: "a uniform service dead load of 1.5 k/ft and a
       uniform service live lad of 1.5 k/ft" -- the misspelled word hid the live load, "a box already holds exactly this value" called the second 1.5
       used, and a lighter beam was chosen (W21X44 for W24X68).  For a load (kips, k/ft, psf, kip-ft) the number of boxes that hold the value must
       cover the number of times it stands in the text; other quantities (a length said twice) are as before. */
    var isLoadKind = /^(?:force|lineload|psf|moment)$/.test(kt || ''), nHold = pv ? boxesHolding(stage, pv) : 0;
    if (pv && !isLoadKind && nHold > 0) continue;                         /* a box already holds exactly this value */
    if (pv && pv.unit === 'in' && has(dims, String(rnd9(pv.value)))) continue;   /* "the 6-in leg" of an L6 x 4 x 1/2 */
    hay = text; found = 0; covered = 0; at = 0;
    for (;;) {
      j = hay.indexOf(needle, at);
      if (j < 0) break;
      found++;
      var cv = false, s;
      if (j + needle.length <= (part.coverLen || 0)) cv = true;                                  /* inside the cover-page defaults line */
      /* (a load must stand WHOLLY inside the words a box was read from: the point load's words "5 k/ft, plus a concentrated ... load of 15 kips" touch
         the tail of "1.5 k/ft" and do not make that load used) */
      for (s = 0; s < spans.length; s++) if (isLoadKind ? (spans[s][0] <= j && j + needle.length <= spans[s][1]) : (spans[s][0] < j + needle.length && j < spans[s][1])) cv = true;
      if (!cv && /\b(?:ksi|psi)$/i.test(needle) && /^\s*(?:,|\.)?\s*(?:unless|otherwise|except|for all)/i.test(text.slice(j + needle.length, j + needle.length + 30))) cv = true;   /* "Fy = 50 ksi, unless noted otherwise" is a default statement */
      /* a value the question itself sets aside: the ASD load Pa ("book also gives Pa = 135 k for ASD, not used") */
      if (!cv && (/\bPa\s*=\s*$/i.test(text.slice(Math.max(0, j - 8), j)) || /^\s*(?:\([^)]*\)\s*)?(?:for\s+ASD|\(ASD\)|,?\s*not\s+used)/i.test(text.slice(j + needle.length, j + needle.length + 24)))) cv = true;
      if (!cv && /\b(?:ksi|psi)$/i.test(needle) && ((!hasFy && /^50\s*ksi$/i.test(needle)) || (!hasFu && /^65\s*ksi$/i.test(needle)))) cv = true;     /* the engine's own steel (A992); this form has no such box */
      if (cv) covered++;
      at = j + 1;
    }
    if (isLoadKind) { if (found > 0 && nHold >= found) covered = found; }
    else if (found > 0 && covered < found && sameQuantityCovered(sq(needle))) covered = found;
    if (isLoadKind && found > 0 && covered < found && nHold === 0 && sameQuantityCovered(sq(needle))) covered = found;   /* (a load read into a list or a choice, not a number box) */
    if (found === 0 || covered < found) out.push({ text: needle, value: u.value, unit: u.unit, start: text.indexOf(needle) });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ the values the student starts from, the gate, the engine arguments */
SOLVE.initialValues = function (stage) {
  var vals = {}, i, b;
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    if (b.state === 'agree' || b.state === 'model' || b.state === 'rule') vals[b.path] = b.proposal;
    else if (b.kind === 'list') vals[b.path] = [];
    else vals[b.path] = '';
  }
  return vals;
};
function isEmptyUi(box, v) {
  var i, it, k, any;
  if (v === undefined || v === null) return true;
  if (box.kind === 'list') {
    if (!isArr(v) || !v.length) return true;
    for (i = 0; i < v.length; i++) { it = v[i]; for (k in it) if (has(it, k) && trim(it[k]) !== '') any = true; }
    return !any;
  }
  return trim(v) === '';
}
SOLVE.isEmptyUi = isEmptyUi;

/* what still blocks "calculate" for the whole part: [{kind, stage, path, text}] */
SOLVE.gate = function (part, vals, ticks) {
  var out = [], si, i, st, b, v, resolved;
  ticks = ticks || {}; vals = vals || {};
  for (si = 0; si < part.stages.length; si++) {
    st = part.stages[si];
    if (!st.boxes) { out.push({ kind: 'reading', stage: si, path: '', text: 'Still reading this part.' }); continue; }
    for (i = 0; i < st.boxes.length; i++) {
      b = st.boxes[i]; v = vals[si] ? vals[si][b.path] : undefined;
      if (b.state === 'carried') continue;
      if (b.state === 'conflict' && !(vals[si] && vals[si]['_picked:' + b.path]) && isEmptyUi(b, v)) { out.push({ kind: 'conflict', stage: si, path: b.path, text: 'The two readers disagree about "' + b.label + '": pick one of them.' }); continue; }
      if (b.required && isEmptyUi(b, v)) out.push({ kind: 'required', stage: si, path: b.path, text: '"' + b.label + '" is required: it is empty.' });
    }
  }
  /* a question that asks "is it adequate?" needs a load: at least one of the load boxes of the group must be given */
  for (si = 0; si < part.stages.length; si++) {
    st = part.stages[si];
    if (!st.boxes) continue;
    var grp = [], any = false, names = [];
    for (i = 0; i < st.boxes.length; i++) {
      b = st.boxes[i];
      if (b.reqGroup !== 'load' || b.state === 'carried') continue;
      grp.push(b); names.push(b.label);
      v = vals[si] ? vals[si][b.path] : undefined;
      if (!isEmptyUi(b, v)) any = true;
    }
    if (grp.length && !any) out.push({ kind: 'required', stage: si, path: grp[0].path, text: 'Your question asks whether the member is adequate, so it needs a load: ' + (part.stages[si].fn === 'beam_capacity' ? 'type the factored moment Mu.' : 'type D and L (service loads) or the factored load Pu.') });
  }
  /* plates on a rolled shape whose place the words do not give: ONE of the two boxes (width b on the flange faces / height h at the flange tips) must be filled */
  for (si = 0; si < part.stages.length; si++) {
    st = part.stages[si];
    if (!st.boxes || !st.plateWhere) continue;
    var pg = [], pany = false;
    for (i = 0; i < st.boxes.length; i++) {
      b = st.boxes[i];
      if (b.reqGroup !== 'plateplace') continue;
      pg.push(b);
      if (!isEmptyUi(b, vals[si] ? vals[si][b.path] : undefined)) pany = true;
    }
    if (pg.length && !pany) out.push({ kind: 'required', stage: si, path: pg[0].path, text: 'Your question has plates on a rolled shape and does not say in words WHERE they sit. Look at its picture: plates lying flat on the flanges -> type the plate\'s larger number in "' + pg[0].label + '"; plates standing at the flange tips, closing the sides like a box -> type it in "' + pg[pg.length - 1].label + '".' });
  }
  if (part.figure && !ticks.figure) out.push({ kind: 'figure', stage: 0, path: '', text: 'Your question mentions a figure. This page cannot see it. Look at the figure for each number asked about above, then tick the box.' });
  if (!ticks.unused) {
    /* one question for each number of his text that no box used: where does it belong? (his answer is in ticks.unusedChoices[text]) */
    var uq = SOLVE.unusedQuestions(part), uc = ticks.unusedChoices || {}, ui2, ch, mm, bx, vv, grp2 = [];
    /* a number that a box now HOLDS (he typed it, or took the AI helper's value for that box) is no longer "in no box" */
    var heldNow = function (text) {
      var p = SOLVE.numberFromText(text), s2, k2, k3, bb, vv2, w, sub2;
      function eq(a, c) { a = Number(a); c = Number(c); return isFinite(a) && isFinite(c) && Math.abs(a - c) <= 1e-6 * Math.max(1, Math.abs(c)); }
      function n2(x) { var n; try { n = parseNum(x); } catch (e) { n = NaN; } return n; }
      var cnt = 0;
      if (!p) return 0;
      for (s2 = 0; s2 < part.stages.length; s2++) {
        if (!part.stages[s2].boxes || !vals[s2]) continue;
        for (k2 = 0; k2 < part.stages[s2].boxes.length; k2++) {
          bb = part.stages[s2].boxes[k2]; vv2 = vals[s2][bb.path];
          if (isEmptyUi(bb, vv2)) continue;
          if (bb.kind === 'num' || bb.kind === 'int') { w = SOLVE.valueForBox(p, bb); if (w !== null && eq(w, n2(vv2))) cnt++; }
          else if (bb.kind === 'list' && isArr(vv2) && bb.items) {
            for (k3 = 0; k3 < vv2.length; k3++) for (sub2 = 0; sub2 < bb.items.length; sub2++) {
              if (bb.items[sub2].kind !== 'num' && bb.items[sub2].kind !== 'int') continue;
              w = SOLVE.valueForBox(p, { kind: bb.items[sub2].kind, unit: bb.items[sub2].unit });
              if (w !== null && vv2[k3] && trim(vv2[k3][bb.items[sub2].name]) !== '' && eq(w, n2(vv2[k3][bb.items[sub2].name]))) cnt++;
            }
          }
        }
      }
      return cnt;                                                                      /* how many boxes hold it (0 = none) */
    };
    /* (10/07) a LOAD that stands twice in his text with one value needs two boxes that hold it ("dead load of 1.5 k/ft and ... live lad of 1.5 k/ft") */
    var timesInText = function (text) {
      var own9 = String(part.ctx || '').slice(part.coverLen || 0), nd = collapse(text).replace(/[.,;:]+$/, ''), n9 = 0, at9 = 0, j9;
      if (!nd) return 1;
      for (;;) { j9 = own9.indexOf(nd, at9); if (j9 < 0) break; n9++; at9 = j9 + nd.length; }
      return Math.max(1, n9);
    };
    for (ui2 = 0; ui2 < uq.length; ui2++) {
      if (!uq[ui2].blocking) continue;                                               /* not a load: a note under the answer, not a question (see unusedQuestions) */
      var hn9 = heldNow(uq[ui2].text);
      if (/^(?:force|lineload|psf|moment)$/.test(String(uq[ui2].kind || '')) ? hn9 >= timesInText(uq[ui2].text) : hn9 > 0) continue;
      if (!uq[ui2].open) { grp2.push('"' + uq[ui2].text + '"'); continue; }          /* every box that could take it already has a value: one tick for all of these, below */
      ch = uc[uq[ui2].text];
      if (!ch) { out.push({ kind: 'unused', stage: 0, path: '', text: 'The number "' + uq[ui2].text + '" is in your text but in no box. Say which box it belongs in, or that it belongs in none.' }); continue; }
      mm = /^(\d+):(.+)$/.exec(String(ch));
      if (mm && part.stages[Number(mm[1])] && part.stages[Number(mm[1])].boxes) {
        /* he said it belongs in a box: that box must then hold something */
        bx = null;
        for (i = 0; i < part.stages[Number(mm[1])].boxes.length; i++) if (part.stages[Number(mm[1])].boxes[i].path === mm[2]) bx = part.stages[Number(mm[1])].boxes[i];
        vv = vals[Number(mm[1])] ? vals[Number(mm[1])][mm[2]] : undefined;
        if (bx && isEmptyUi(bx, vv)) out.push({ kind: 'unused', stage: Number(mm[1]), path: mm[2], text: 'You said "' + uq[ui2].text + '" belongs in "' + bx.label + '", but that box is empty. Type it there (or say it belongs in no box).' });
      }
    }
    if (grp2.length && !ticks.unusedGroup) out.push({ kind: 'unusedgroup', stage: 0, path: '', text: 'Numbers in your text that no box used (every box that could take them already has a value): ' + grp2.join(', ') + '. Look at each one, then tick the box.' });
  }
  return out;
};
/* numbers of his text that no box used, over all stages of the part (the page asks him about each one before it calculates) */
SOLVE.unusedOf = function (part) {
  var lists = [], si, st, out = [], i, k, u, inAll, j, found, seen = {}, key;
  for (si = 0; si < part.stages.length; si++) { st = part.stages[si]; if (st.read && st.read.unused) lists.push(st.read.unused); else if (st.read && st.read.done) lists.push([]); }
  if (!lists.length) return out;
  /* a number is "unused" only when NO stage of the chain used it */
  for (i = 0; i < lists[0].length; i++) {
    u = lists[0][i]; inAll = true;
    for (k = 1; k < lists.length; k++) { found = false; for (j = 0; j < lists[k].length; j++) if (lists[k][j].text === u.text) found = true; if (!found) inAll = false; }
    key = String(u.text).toLowerCase().replace(/[\s\-]+/g, '');
    if (inAll && !has(seen, key) && !givenShapeProp(part, u.text)) { seen[key] = 1; out.push(u); }
  }
  return out;
};
/* A number the question GIVES for a property of the shape it names -- "A W10x54 (A = 15.8 in^2, rx = 4.37 in, ry = 2.56 in) has KxLx = 28 ft ..." -- and that
   IS the Manual's value of that property.  The calculation looks the shape up and uses that very value, so the number is not "unused": counted as unused,
   three such numbers kept a clean column question from being worked out at all (another lab's question, 10/07).  A stated property that DIFFERS from the
   Manual's stays in the list. */
var GIVEN_PROP = { a: 'A', ag: 'A', d: 'd', bf: 'bf', tf: 'tf', tw: 'tw', rx: 'rx', ry: 'ry', ix: 'Ix', iy: 'Iy', zx: 'Zx', zy: 'Zy', sx: 'Sx', sy: 'Sy' };
function givenShapeProp(part, text) {
  var own = String(part.ctx || '').slice(part.coverLen || 0), named = SHAPE_NAMED.exec(own), at, lab, num, r, v;
  if (!named) return false;
  num = /-?\d+(?:\.\d+)?/.exec(String(text));
  if (!num) return false;
  at = own.indexOf(String(text));
  while (at >= 0) {
    lab = /(?:^|[^A-Za-z])([A-Za-z]{1,2})\s*=\s*$/.exec(own.slice(Math.max(0, at - 8), at));
    if (lab && has(GIVEN_PROP, lab[1].toLowerCase()) && (lab[1].length > 1 || /^[Ad]$/.test(lab[1]))) {
      try { r = env().STEEL.run('lookup_shape', { shape: named[0].replace(/\s+/g, ''), property: GIVEN_PROP[lab[1].toLowerCase()] }); } catch (e) { r = null; }
      v = r && r.ok && r.answer && isNum(r.answer.value) ? Number(r.answer.value) : NaN;
      if (isFinite(v) && Math.abs(v - Number(num[0])) <= 0.011 * Math.abs(v) + 0.0006) return true;
    }
    at = own.indexOf(String(text), at + 1);
  }
  return false;
}
SOLVE.hasUnused = function (part) { return SOLVE.unusedOf(part).length > 0; };

/* ---- the numbers no box used, as QUESTIONS that name the boxes they could belong in ---- */
var WORDNUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
function unitOfText(t) {
  var x = String(t).toLowerCase();
  if (/kip\s*-?\s*ft|\bk\s*-\s*ft|ft\s*-\s*kips?/.test(x)) return 'kip-ft';
  if (/kip\s*-?\s*in|\bk\s*-\s*in|in\s*-\s*kips?/.test(x)) return 'kip-in';
  if (/k\s*\/\s*ft|kips?\s*\/\s*(?:ft|foot)|klf/.test(x)) return 'k/ft';
  if (/lbs?\.?\s*\/\s*(?:ft|foot)|plf/.test(x)) return 'lb/ft';
  if (/psf/.test(x)) return 'psf';
  if (/pcf/.test(x)) return 'pcf';
  if (/ksi/.test(x)) return 'ksi';
  if (/psi/.test(x)) return 'psi';
  if (/^\s*-?\s*(?:kips?|k)\b/.test(x)) return 'kips';
  if (/^\s*-?\s*(?:lbs?|pounds)\b/.test(x)) return 'lb';
  if (/^\s*-?\s*(?:ft|feet|foot|')/.test(x)) return 'ft';
  if (/^\s*-?\s*(?:in|inch|inches|")(?![a-z])/.test(x)) return 'in';
  if (/(?:holes?|bolts?|lines|rows?|floors?|stories|levels?|angles?|plates?|spans?|bays?)\b/.test(x)) return 'count';
  return '';
}
/* "12 ft", "3-in", "60 k", "two lines" -> {value, unit, kind} ; null when it does not start with a number */
SOLVE.numberFromText = function (text) {
  var t = collapse(text).toLowerCase().replace(/[.,;:]+$/, ''), m, v, rest;
  m = /^(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)\s*-?\s*(.*)$/.exec(t);
  if (m) { v = parseNum(m[1]); rest = m[2]; }
  else {
    m = /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b\s*-?\s*(.*)$/.exec(t);
    if (!m) return null;
    v = WORDNUMS[m[1]]; rest = m[2];
  }
  if (!isFinite(v)) return null;
  return { value: v, unit: unitOfText(rest), kind: kindOfText(t) };
};
var UNIT_CONV = { 'ft': { 'ft': 1, 'in': 1 / 12 }, 'in': { 'in': 1, 'ft': 12 }, 'kips': { 'kips': 1, 'lb': 1 / 1000 }, 'k/ft': { 'k/ft': 1, 'lb/ft': 1 / 1000 }, 'kip-ft': { 'kip-ft': 1, 'kip-in': 1 / 12 }, 'ksi': { 'ksi': 1, 'psi': 1 / 1000 }, 'psf': { 'psf': 1 }, 'pcf': { 'pcf': 1 } };
var LOAD_ANY = { 'kips': 1, 'lb': 1 / 1000, 'k/ft': 1, 'lb/ft': 1 / 1000, 'psf': 1 };
/* the number as the box wants it (in the box's unit), or null when this box cannot take it as a typed number */
SOLVE.valueForBox = function (p, b) {
  var bu = String(b.unit || '').toLowerCase();
  if (!p || (b.kind !== 'num' && b.kind !== 'int')) return null;
  if (b.kind === 'int') return ((p.unit === 'count' || p.unit === '') && Math.round(p.value) === p.value) ? String(p.value) : null;
  if (!bu) return has(LOAD_ANY, p.unit) ? fmtNum(p.value * LOAD_ANY[p.unit]) : null;
  if (has(UNIT_CONV, bu) && has(UNIT_CONV[bu], p.unit)) return fmtNum(p.value * UNIT_CONV[bu][p.unit]);
  return null;
};
function canTake(kind, b) {
  var bk, j;
  if (b.state === 'carried') return false;
  if (b.kind === 'num' || b.kind === 'int' || b.kind === 'numlist') {
    if (kind === 'count') return b.kind === 'int';
    bk = kindOfBoxUnit(b.unit);
    if (!kind) return true;
    if (!bk) return b.kind === 'num' && !b.unit && (kind === 'force' || kind === 'lineload' || kind === 'psf');
    return bk === kind;
  }
  if (b.kind === 'list' && b.items) {
    if (kind === 'count') return false;                    /* a count ("two lines", "four holes") goes in a whole-number box, not in a list of positions */
    if (!kind) return true;
    for (j = 0; j < b.items.length; j++) if (kindOfBoxUnit(b.items[j].unit) === kind) return true;
  }
  return false;
}
/* the label of a box as a student would say it ("OR the effective length KyLy directly" -> "effective length KyLy directly") */
function plainLabel(s) {
  var t = collapse(s).replace(/^OR\s+(?:the\s+)?/i, '').replace(/^A\s+LIST\s+of\s+/i, '');
  return t.length ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
/* [{text, kind, cands:[{si, path, label, unit, kind, fill}]}] : one question per number.  The candidate boxes are the ones that take this KIND of quantity,
   the ones with the number's own unit first (a length in feet goes to a box in feet); when some box has the same unit the others are not offered. */
SOLVE.unusedQuestions = function (part) {
  var list = SOLVE.unusedOf(part), out = [], i, u, kind, cands, si, st, j, b, p, pu, same, all, filled, open;
  for (i = 0; i < list.length; i++) {
    u = list[i]; kind = kindOfText(u.text); all = []; p = SOLVE.numberFromText(u.text); pu = p ? p.unit : '';
    for (si = 0; si < part.stages.length; si++) {
      st = part.stages[si];
      if (!st.boxes) continue;
      for (j = 0; j < st.boxes.length; j++) {
        b = st.boxes[j];
        if (!canTake(kind, b)) continue;
        same = (b.unit && pu && String(b.unit).toLowerCase() === pu) || (!b.unit && has(LOAD_ANY, pu)) || (b.kind === 'list' && !!b.items);
        filled = b.state === 'agree' || b.state === 'model' || b.state === 'rule';
        all.push({ si: si, path: b.path, label: plainLabel(b.label), unit: b.unit, kind: b.kind, state: b.state, fill: b.kind === 'num' || b.kind === 'int', filled: filled, list: b.kind === 'list' || b.kind === 'numlist', rank: (same ? 0 : 2) + (filled || b.state === 'conflict' ? 1 : 0), idx: all.length });
      }
    }
    all.sort(function (a, c) { return a.rank - c.rank || a.idx - c.idx; });
    cands = all.filter(function (c) { return c.rank < 2; });
    if (!cands.length) cands = all;
    cands = cands.slice(0, 8);
    /* "open": some box that could take this number is still empty (or is a list that can take more rows, or the two readers disagree about it).  When every box that
       could take it already holds a value, the number is most likely a different quantity: it is shown in ONE tick for the whole part, not as a question of its own. */
    open = false;
    for (j = 0; j < cands.length; j++) if (!cands[j].filled || cands[j].list) open = true;
    /* "blocking": a LOAD the page did not place (kips, k/ft, psf, kip-ft) holds the answer back until he says where it goes: a missed load is a wrong answer.
       A length, a count or a stress that went into no box is usually a number the form does not need (a bolt spacing, an edge distance, a second mention):
       it is listed under the answer and does not hold it back (10/06: such questions stopped 16 of the mock's 41 parts, every one a false alarm). */
    /* (Tried 10/06: also blocking on an unplaced COUNT of holes or bolts.  It stopped answers that were right (R1-15, R1-26) for one terse test wording, so
       a count stays a note; the page words that note more strongly -- see "holesNote".) */
    /* (10/07, the rough-typing run: "A 6 in. thick normal weight cobcrete salb (145 pcf) ..." -- with "slab" misspelled the thickness and the unit
       weight went into no box, the slab's own weight was left out and wu came out 184 psf for 271.)  A unit weight always becomes a load, and so
       does a thickness in a floor question: unplaced, they hold the answer back like a load does. */
    out.push({ text: u.text, kind: kind, cands: cands, open: open, blocking: kind === 'force' || kind === 'lineload' || kind === 'psf' || kind === 'moment' || labelledLength(part, u.text)
      || kind === 'pcf' || (kind === 'length' && part.stages.some(function (s9) { return /^(?:loads_floor|floor_plan|beam_max_live_load)$/.test(s9.fn); })
        && new RegExp(String(u.text).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '\\.?\\s*-?\\s*(?:thick|deep)', 'i').test(String(part.ctx || '')))
      || (kind === 'area' && /sq\.?\s*ft|square\s+f|\bsf\b|ft\s*\^?\s*2/i.test(u.text)), holesNote: kind === 'count' && /hole|bolt/i.test(u.text) });
  }
  return out;
};

/* "KyLy = 19 ft", "Lx = 22 ft", "Lc = 18 ft": a length the question itself NAMES with a member-length symbol.  When no box holds it the answer is for
   another length (the page once used KxLx for both axes and said W12X96 where W12X65 is right), so it holds the answer back like an unplaced load does. */
function labelledLength(part, text) {
  var ctx = String(part.ctx || ''), from = part.coverLen || 0, at = ctx.indexOf(text, from);
  while (at >= 0) {
    /* only a length named for ONE AXIS (KxLx, KyLy, KLx, KLy, Lx, Ly).  A plain "so KL = 19.5 ft" beside "K = 0.65, L = 30 ft" is the question doing its own
       multiplication: the boxes hold K and L, and stopping there would be a needless question (her class problem of 9/16). */
    if (/(?:^|[^A-Za-z0-9])(?:K[xy]\s?L[xy]|KL[xy]|L[xy])\s*=\s*$/.test(ctx.slice(Math.max(0, at - 14), at))) return true;
    at = ctx.indexOf(text, at + 1);
  }
  return false;
}
/* "Is it adequate / OK / safe / can it carry ...": the question needs a LOAD, so the load boxes are required (D and L, or Pu; for a beam, Mu) */
var ADEQ_RE = /\b(adequate|adequacy|okay|ok|carry|carries|safe|safely|sufficient|check|checks|checked|satisf\w*|strong\s+enough|acceptable|suitable|(?:can|could|may|might|should|would|will)\s+(?:it|this|that|the\s+\w+(?:\s+\w+)?)\s+(?:still\s+)?(?:be\s+used|work|hold|pass|do)|be\s+used\s+(?:for|here|as|instead)|(?:does|did|will|would)\s+it\s+(?:work|pass|hold))\b/i;
function markAdequacy(part, stage) {
  var ask, i, b, fn = stage.fn;
  if (stage.role !== 'main') return;
  ask = String(part.text || '') + ' ' + String(part.route && part.route.question ? part.route.question : '');
  if (!ADEQ_RE.test(ask)) return;
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    if ((fn === 'column_capacity' || fn === 'tension_capacity') && (b.name === 'D' || b.name === 'L' || b.name === 'Pu')) b.reqGroup = 'load';
    if (fn === 'beam_capacity' && b.name === 'Mu') b.reqGroup = 'load';
  }
}

/* Floor plan: once a girder span is read, the girder IS worked out, and its load depends on whether beams frame in from both sides or from one.  When neither
   reader found that in the words, the box is required (a question), not left at the calculator's usual "both". */
/* A W shape WITH plates on it ("a W8X24 with two PL 0.5 x 5 on the flange faces", "a W14X311 with two 0.875 x 11 plates at the flange tips").
   When the reader takes only the plate, or only the W, the answer is for the wrong section and nothing on the page says so (7 of the 30 silent wrong answers
   of the generated problems).  Both must be in the boxes; the one that is missing becomes a required box. */
function markBuiltUp(part, stage) {
  var own, i, b, shape = null, pt = null, pb = null, ph = null, need = [];
  if (!/^(?:section_properties|column_capacity|column_euler)$/.test(stage.fn)) return;
  own = String(part.ctx || '').slice(part.coverLen || 0);
  /* A column made of SEVERAL rolled pieces ("2 MC18X42.7 + PL 1/2 x 20", "two C10X30 channels", "four angles", laced or battened): not in this page.
     The reader took ONE of the pieces and the page answered for that one piece (her book example 5-4: the one wrong answer of her own set since the first
     build).  A pair of angles the reader itself read as a 2L shape is the exception: that section is in the tables. */
  for (i = 0; i < stage.boxes.length; i++) if (stage.boxes[i].name === 'shape') shape = stage.boxes[i];
  var several = /\b(?:2|two|3|three|4|four)\s*-?\s*(?:MC|C|L|WT)\s?\d{1,2}(?:\.\d+)?\s?[xX]/i.exec(own) || /\b(?:two|2|a\s+pair\s+of|pair\s+of|double|three|3|four|4)\s+(?:channels?|angles?|tees?)\b/i.exec(own)
    || /\b(?:laced|latticed|battened|lacing|battens?)\b/i.exec(own);
  if (several && /^column_(?:capacity|euler)$/.test(stage.fn) && !(shape && /^2L/i.test(String(shape.proposal || '')))) {
    stage.refuse = 'Your question\'s column is BUILT UP from more than one rolled piece ("' + trim(several[0]) + '"). This page works out ONE rolled shape, or one W shape with two plates on it. It will not answer for this section, and an answer for one of the pieces alone would be wrong: do not copy a number for this question from this page.';
    stage.refuseHard = true;
    return;
  }
  shape = null;
  if (!/\b(?:W|S|M|HP)\s?\d{1,2}\s?[xX]\s?\d/.test(own)) return;
  if (!/\bplates?\b[^.;]{0,60}\b(?:flange|web|tips?|faces?|each\s+side|both\s+sides|boxed|cover)|\bcover\s+plates?\b|\bwith\s+(?:two|2|a|one|four|4)\s+(?:PL\b|plates?\b|\d[^.;]{0,24}\bplates?\b)|\bPL\s*\d[^.;]{0,40}\b(?:flange|web|tips?|faces?)/i.test(own)) return;
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    if (b.name === 'shape') shape = b; else if (b.name === 'plate_t_in') pt = b; else if (b.name === 'plate_b_in') pb = b; else if (b.name === 'plate_h_in') ph = b;
  }
  function empty(x) { return !x || x.proposal === undefined || isEmptyUi(x, x.proposal) || !(x.state === 'rule' || x.state === 'agree' || x.state === 'model'); }
  if (shape && empty(shape)) need.push(shape);
  if (pt && empty(pt)) need.push(pt);
  if (pb && empty(pb) && !ph) need.push(pb);
  for (i = 0; i < need.length; i++) {
    need[i].required = true;
    if (need[i].state !== 'conflict') need[i].state = 'empty';
    need[i].question = 'Your question has a rolled shape WITH plates on it. The page read only part of that section, so it will not calculate. Type this value (the plate thickness and width are the two numbers written with the plate, for example 0.5 x 5).';
  }
  /* the plate's size was read, but not WHERE the plates sit: that decides the box, and the page does not guess it */
  if (pb && ph && empty(pb) && empty(ph)) {
    pb.question = 'Your question has plates on a rolled shape, and the page cannot tell from the words WHERE they sit. Look at the question and its picture. '
      + 'Plates lying FLAT ON THE FLANGES (top and bottom): type the plate\'s LARGER number in THIS box. '
      + 'Plates standing AT THE FLANGE TIPS, closing the two sides like a box: leave this box empty and type that number in the box "' + (ph.label || 'plate height h') + '" instead.';
    pb.required = false; pb.reqGroup = 'plateplace'; ph.reqGroup = 'plateplace';
    if (ph.state !== 'conflict') ph.state = 'empty';
    stage.plateWhere = true;
  }
}
/* The yield stress the question STATES ("Fy = 36 ksi", "the yield strength of the steel is 36 ksi", "A36", "Grade 50").
   REVIEW 2: a beam was selected from the Fy = 50 table for a question that said Fy = 36 (W21X44 printed, W24X55 right), and three ways of stating the yield
   stress of a column were not read (685 kips printed for 525).  Whatever the reader did: a stated yield stress that is not in the Fy box stops the part. */
function statedFy(own) {
  var m = /\bF\s?y\s*(?:=|of|is|:)?\s*(\d{2}(?:\.\d+)?)(?![\d.])/.exec(own) || /\byield\s+(?:strength|stress|point)\b[^.;]{0,40}?(\d{2}(?:\.\d+)?)\s*-?\s*ksi/i.exec(own) || /(\d{2})\s*-?\s*ksi\s+(?:yield|steel)/i.exec(own);
  if (m && Number(m[1]) >= 30 && Number(m[1]) <= 100) return { value: Number(m[1]), from: trim(m[0]) };
  m = /\bA\s?36\b|\bgrade\s+36\b/i.exec(own);
  if (m) return { value: 36, from: trim(m[0]) };
  m = /\bgrade\s+(42|46|50|55|60|65)\b/i.exec(own);
  if (m) return { value: Number(m[1]), from: trim(m[0]) };
  return null;
}
function markFy(part, stage) {
  var own = String(part.ctx || '').slice(part.coverLen || 0), fy = statedFy(own), i, box = null, filled, v;
  if (!fy || stage.role === 'words') return;
  for (i = 0; i < (stage.boxes || []).length; i++) if (stage.boxes[i].name === 'Fy') box = stage.boxes[i];
  if (box) {
    filled = (box.state === 'rule' || box.state === 'agree' || box.state === 'model') && !isEmptyUi(box, box.proposal);
    v = filled ? Number(box.proposal) : NaN;
    if (!filled) {
      if (fy.value === 50) return;                      /* the calculator's own value */
      box.required = true; if (box.state !== 'conflict') box.state = 'empty';
      box.question = 'Your question gives the yield stress of the steel (' + fy.from + '). The page did not read it into this box and will not calculate with another value: type it (the number in ksi).';
    }
    return;
  }
  /* no Fy box at all: the two forms that pick a beam from Table 3-2, which is printed for Fy = 50 ksi */
  if (fy.value !== 50 && (stage.fn === 'beam_select' || stage.fn === 'floor_plan') && !stage.refuse) stage.refuseHard = true;
  if (fy.value !== 50 && (stage.fn === 'beam_select' || stage.fn === 'floor_plan') && !stage.refuse)
    stage.refuse = 'This calculation picks the beam from Table 3-2, and that table is for Fy = 50 ksi. Your question says ' + fy.from + '. The page will not answer with the wrong steel. On the calculator page use "Required Zx" (it takes Fy), then "Lightest shape with a property at least ..." with that Zx.';
}
/* A rolled shape with holes in the FLANGES and in the WEB: both counts must be in the boxes.
   REVIEW 2: "Each flange has 2 holes and the web has 2 holes" lost the web holes (12.16 printed for 11.48); "2 per flange, 2 in the web" lost the flange holes. */
function markHoles(part, stage) {
  var own, i, b, pf = null, wb = null, fpf, fwb, need;
  if (!/^tension_(?:capacity|net_area|select)$/.test(stage.fn)) return;
  own = String(part.ctx || '').slice(part.coverLen || 0);
  /* words that NAME the web or a flange without putting a hole there: "one on each side of the web", "web thickness".
     (Regression caught by the mock exam: "through its flanges only (there are no bolts in the web) ... one on each side of the web" stopped four parts that
     had answered.  The reader now reads "no bolts in the web" as 0, and these words no longer count as a mention.) */
  own = own.replace(/\b(?:each|either|both|one|opposite|the\s+other)\s+sides?\s+of\s+the\s+(?:web|flanges?)\b/gi, ' ')
    .replace(/\b(?:web|flange)\s+(?:thickness|width|depth|height)\b|\b(?:thickness|width|depth|height)\s+of\s+the\s+(?:web|flanges?)\b/gi, ' ')
    /* the web or the flange of ANOTHER member: "bolted through its flanges to the web of a W14 column", "to the flange of the column" */
    .replace(/\b(?:web|flanges?)(\s+of\s+(?:an?\s+|another\s+|the\s+(?:supporting\s+|other\s+)?(?:column|girder|beam|support|member|gusset)\b))/gi, ' $1');
  if (!/\bflanges?\b/i.test(own) || !/\bweb\b/i.test(own) || !/\b(?:holes?|bolts?)\b/i.test(own)) return;
  for (i = 0; i < (stage.boxes || []).length; i++) { b = stage.boxes[i]; if (b.name === 'holes_per_flange') pf = b; else if (b.name === 'web_holes') wb = b; }
  if (!pf || !wb) return;
  function got(x) { return (x.state === 'rule' || x.state === 'agree' || x.state === 'model') && !isEmptyUi(x, x.proposal); }
  fpf = got(pf); fwb = got(wb);
  if (fpf === fwb) return;
  need = fpf ? wb : pf;
  /* the question itself says the bolts are in the other part ONLY */
  if (need === wb && /\bflanges?\s+only\b|\bonly\s+(?:through|in|at|by|to)\s+(?:its\s+|the\s+|both\s+|each\s+)?flanges?\b/i.test(own)) return;
  if (need === pf && /\bweb\s+only\b|\bonly\s+(?:through|in|at|by|to)\s+(?:its\s+|the\s+)?web\b/i.test(own)) return;
  need.required = true; if (need.state !== 'conflict') need.state = 'empty';
  need.question = 'Your question speaks of holes in the flanges AND of the web. The page read only one of the two counts and will not calculate with half of the holes: type this one (0 if your question says there are none there).';
}
/* ---- REVIEW 3 (10/06 16:10, a third fresh agent, 211 questions): four more kinds of words the page did not read and answered past.  The same rule as before:
   when the question SAYS something that changes the answer and no box holds it, the page stops; it does not print the answer for a different question. */

/* A beam that is NOT fully braced.  This page works out fully braced beams only (Lb = 0, phi Mn = phi Mp).  The finder flags "Lb = 15 ft" as final-exam
   material; most other ways of saying it went through and the fully braced strength was printed (17 of 25 wordings: "lateral bracing every 8 ft", 294 printed,
   247 right; "no bracing between its ends", 358 printed, 58 right).  A sentence that speaks of bracing, lateral support or an unbraced length, does not say the
   bracing is full or continuous, and gives a distance, a place (midspan, third points, the ends) or a "no": the page refuses. */
function markBracing(part, stage) {
  var own, sens, i, s, hit = null, neg, weak;
  if (!/^(?:beam_capacity|beam_select|beam_max_live_load|beam_required_zx|floor_plan)$/.test(stage.fn)) return;
  own = String(part.ctx || '').slice(part.coverLen || 0);
  /* REVIEW 4: bending about the WEAK axis ("bending about its weak axis (y-y)", "loaded in the weak direction", "phi Mny"): the strong-axis strength was
     printed (294 for a W18X40 whose weak-axis strength is a small part of that).  This page works out strong-axis bending only. */
  weak = /\b(?:weak|minor)[\s-]+(?:axis|direction)\b|\babout\s+(?:its|the)\s+y(?:\s*-\s*y)?[\s-]+axis\b|\by\s*-\s*y\s+axis\b|\bphi\s*_?\s*M_?ny\b|\bM_?ny\b|\bZ_?y\b/i.exec(own);
  if (weak && stage.fn !== 'floor_plan') {
    stage.refuse = 'Your question is about bending about the WEAK axis ("' + trim(weak[0]) + '"). This page works out bending about the STRONG axis (x-x) only; the number it would print is the strong-axis strength, which is far too high. NOT IN THE TOOL: do not copy a strength or a shape for this question from this page.';
    stage.refuseHard = true;
    return;
  }
  sens = sentenceList(own);
  for (i = 0; i < sens.length && !hit; i++) {
    s = sens[i];
    /* "Lb" is tested with its capital L: "50 lb/ft" is a weight, not an unbraced length */
    /* (REVIEW 4: "laterally unsupported for 10 ft", "an unrestrained length of 10 ft", "free to buckle laterally over a 12 ft span", "with only end
       supports", "laterally unsupported over its full length" all went through; the last one was even excused by its word "full") */
    if (!/\bbrac(?:e|es|ed|ing)\b|\blateral(?:ly)?\s+(?:un[\s-]?)?(?:support|restrain|brac)\w*|\b(?:un[\s-]?)?(?:support|restrain)\w*\s+laterally\b|\bun[\s-]?braced\b|\bun[\s-]?(?:supported|restrained)\s+(?:length|for|over|along)\b|\bfree\s+to\s+buckle\b|\bbuckl\w+\s+laterally\b|\blateral[\s-]+torsional\b|\bonly\s+(?:at\s+)?(?:its\s+|the\s+)?end\s+supports?\b/i.test(s) && !/\bL_?b\b/.test(s)) continue;
    if (/\bL_?b\s*(?:=|is|of)\s*0(?:\.0+)?(?![\d.])/.test(s) || /\bun[\s-]?braced\s+length\s*(?:\(?\s*L_?b\s*\)?\s*)?(?:=|is|of)\s*(?:0(?:\.0+)?(?![\d.])|zero\b)/i.test(s)) continue;
    neg = /\bun[\s-]?(?:braced|supported|restrained)\b|\bno\s+(?:lateral\s+)?(?:brac|support|restrain)|\bnot\s+(?:laterally\s+|fully\s+|continuously\s+)?(?:braced|supported|restrained)\b|\bwithout\s+(?:any\s+)?(?:lateral\s+)?(?:brac|support)|\bfree\s+to\s+buckle\b|\bonly\s+(?:at\s+)?(?:its\s+|the\s+)?end\s+supports?\b/i.test(s);
    if (!neg && /\bfull(?:y)?\b|\bcontinuous(?:ly)?\b|\bthroughout\b|\b(?:entire|whole)\s+(?:length|span)\b|\badequate(?:ly)?\b|\bby\s+the\s+(?:slab|deck|floor)\b/i.test(s)) continue;
    if (neg || /\d\s*-?\s*(?:ft|feet|foot|in\.?|inch(?:es)?|'|")(?![A-Za-z])/i.test(s)
      || /\bmid[\s-]?span\b|\b(?:third|quarter)[\s-]points?\b|\bcent(?:er|re)\b|\bonly\b|\bends?\b/i.test(s)) hit = trim(s);
  }
  if (hit) stage.refuse = 'Your question says the beam is NOT braced all along its length ("' + hit.slice(0, 110) + '"). This page works out FULLY braced beams only (Lb = 0); the number it would print is the fully braced strength, which is too high for this beam. NOT IN THE TOOL (final-exam material): do not copy a strength or a shape for this question from this page.';
  if (hit) stage.refuseHard = true;
}
/* (10/07, his second manual test: her textbook problem 3-22, "a C12x30 ... three gage lines ... the center row of bolts is staggered with respect to the
   outer row")  STAGGERED HOLES IN A ROLLED SHAPE.  The page works out staggered holes for a PLATE (every path, s^2/4g).  For a channel, a W or an angle it
   has only a count of holes across, and with that count it printed "An = 7.28 in^2" for this question: three holes in a straight line, no stagger term,
   and not the effective area that was asked -- a clean block, and wrong.  A tension question about a rolled shape whose words say the holes are staggered
   (and do not say they are NOT) is not worked out. */
function markStagger(part, stage) {
  var own, i, b, member = null, shape = null;
  if (!/^tension_(?:capacity|net_area|select|required_area)$/.test(stage.fn) || stage.refuse) return;
  /* (words that say there is NO stagger: "not staggered", "no stagger", "no web holes or staggered holes", "neither offset nor staggered") */
  own = String(part.ctx || '').slice(part.coverLen || 0).replace(/\b(?:not|no|non|never|none|without(?:\s+any)?|un|isn't|aren't|are\s+not|is\s+not)[\s-]*stagger\w*/gi, ' ')
    .replace(/\b(?:no|not|without|neither|never)\b[^.;:?!]{0,48}?\b(?:or|nor|and)\s+(?:any\s+)?stagger\w*/gi, ' ');
  if (!/\bstagger/i.test(own)) return;
  for (i = 0; i < (stage.boxes || []).length; i++) { b = stage.boxes[i]; if (b.name === 'member') member = b; else if (b.name === 'shape') shape = b; }
  /* a plate with its hole positions is the page's own staggered form: left alone */
  if (member && String(member.proposal || '') === 'plate') return;
  if (!(shape && (shape.state === 'rule' || shape.state === 'agree' || shape.state === 'model') && !isEmptyUi(shape, shape.proposal)) && !(member && /^(?:shape|angle)$/.test(String(member.proposal || '')))) return;
  stage.refuse = 'Your question says the bolt holes are STAGGERED in a rolled shape (a channel, a W shape or an angle). This page works out staggered holes for a PLATE only; for a rolled shape it would count the holes in a straight line and print a net area that is wrong. NOT IN THE TOOL: do not copy a net area or a strength for this question from this page. By hand, for holes that are all in ONE flat part of thickness t: An = Ag - (number of holes on the path) x (hole diameter) x t + (s^2 / 4g) x t for every diagonal step of the path, s = the stagger along the member, g = the distance between the two gage lines; try the straight path and every zigzag path, and the smallest An governs.';
  stage.refuseHard = true;
}
/* (10/07) A STEEL NAMED BY ITS GRADE ALONE: "What are Fy and Fu for A36 steel?", "(b) Fy and Fu for A992 steel".  The look-up's box takes a product word
   (plate, pipe, HSS) or a shape, and the reader fills it from those only; a bare grade left it empty and the page asked for a shape that the question
   does not have.  The calculator itself knows the rows of her week-1 slide by grade, so the grade goes into the box -- one grade, and only when the
   calculator answers for it. */
function markGrade(part, stage) {
  var own, i, b = null, m, all, g, r;
  if (stage.fn !== 'lookup_material') return;
  for (i = 0; i < stage.boxes.length; i++) if (stage.boxes[i].name === 'what') b = stage.boxes[i];
  if (!b || ((b.state === 'rule' || b.state === 'agree' || b.state === 'model') && !isEmptyUi(b, b.proposal))) return;
  own = String(part.text || '');
  all = own.match(/\b(?:ASTM\s+)?A\s?-?\s?(?:992|36|572|500|53|529|588|913)\b(?:\s*,?\s*(?:Grade|Gr\.?)\s*(?:50|B|C|42|46|60|65))?/gi) || [];
  all = all.map(function (x) { return x.replace(/^ASTM\s+/i, '').replace(/^A\s?-?\s?/i, 'A').replace(/\s*,?\s*Gr(?:ade|\.)?\s*/i, ' Grade ').replace(/\s+/g, ' '); })
    .filter(function (x, k, a) { return a.indexOf(x) === k; });
  if (all.length !== 1) return;
  g = all[0];
  try { r = env().STEEL.run('lookup_material', { what: g }); } catch (e) { r = null; }
  if (!r || !r.ok) return;
  m = new RegExp(g.replace(/ Grade /, '[\\s,]*(?:Grade|Gr\\.?)\\s*').replace(/^A/, 'A\\s?-?\\s?'), 'i').exec(own);
  b.state = 'rule'; b.proposal = g; b.words = [{ src: 'rules', text: m ? m[0] : g }]; b.alts = []; b.askNow = false; b.required = false;
  b.rule = { value: g, quote: m ? m[0] : g, confidence: 'high', rule: 'the steel named by its grade' };
  b.notes = ['read from the grade your question names (' + g + ')'];
}
/* (10/06 night) TWO AXES, ONE LENGTH.  "unbraced 8 ft aboit the y-y axis and 24 ft about the x-x axis": a misspelled word hid the 8 ft, the page read ONE
   length, took it for both axes and printed a strength from the column table as if nothing were missing.  A column question whose own words name BOTH
   axes and give two or more different lengths in feet, while the length boxes hold fewer than two of them, is not worked out.  (The spelling repair now
   fixes that word; this guard is for the next word it cannot fix.) */
function markAxes(part, stage) {
  var own, i, b, used = {}, n = 0, lens = {}, nl = 0, m, re;
  if (!/^column_(?:capacity|select)$/.test(stage.fn) || stage.refuse) return;
  own = String(part.ctx || '').slice(part.coverLen || 0);
  if (!(/\bx\s*-\s*x\b|\bx[\s-]+axis\b|\b(?:strong|major)[\s-]+axis\b/i.test(own) && /\by\s*-\s*y\b|\by[\s-]+axis\b|\b(?:weak|minor)[\s-]+axis\b/i.test(own))) return;
  /* only the lengths of the sentences that speak of an axis or of bracing: "a 30 ft girder frames into the column" is no column length */
  own.split(/[.;]\s+/).forEach(function (sen) {
    if (!/\bax[ie]s\b|\bx\s*-\s*x\b|\by\s*-\s*y\b|brac|\bK\s?L\b|\bL\s?[xy]\b|\bK\s?[xy]\s?L/i.test(sen)) return;
    re = /(\d+(?:\.\d+)?)\s*-?\s*(?:ft\b|feet\b|foot\b)/gi;
    while ((m = re.exec(sen)) !== null) { if (!has(lens, String(Number(m[1])))) { lens[String(Number(m[1]))] = 1; nl++; } }
  });
  if (nl < 2) return;
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    if (!/^(?:Lx_ft|Ly_ft|KLx_ft|KLy_ft|y_segments)$/.test(b.name)) continue;
    if (!(b.state === 'rule' || b.state === 'agree' || b.state === 'model' || b.state === 'carried') || isEmptyUi(b, b.proposal)) continue;
    (JSON.stringify(b.proposal === undefined ? '' : b.proposal).match(/\d+(?:\.\d+)?/g) || []).forEach(function (x) { if (Number(x) >= 3 && !has(used, String(Number(x)))) { used[String(Number(x))] = 1; n++; } });
  }
  /* (none read at all: the calculator itself then asks for the lengths, and he can fill the boxes -- that stop is the better one) */
  if (n !== 1) return;
  stage.refuse = 'Your question speaks of BOTH axes of the column and gives ' + nl + ' different lengths in feet, but the page read only one of them'
    + ' as a column length. A strength worked from one length would be wrong. Check the spelling of the words around each length (about, axis, braced, unbraced), then press Solve again.';
}
/* The reader itself KNOWS it met something it could not use ("two point loads" and one place found for them; a U said in words it did not read; the
   theoretical K).  It says so with a question of kind "stop" (nothing is worked out) or of kind "need" (the boxes it names are asked, and nothing is worked
   out until they are typed).  Before, such a question was a note beside a box and the page answered past it. */
function markReaderStops(stage, ruleQs) {
  var i, j, k, q, b;
  for (i = 0; i < (ruleQs || []).length; i++) {
    q = ruleQs[i];
    if (!q) continue;
    if (q.kind === 'stop') {
      if (!stage.refuse) { stage.refuse = String(q.text); stage.refuseHard = /NOT answered here|NOT IN THE TOOL/.test(String(q.text)); }
    } else if (q.kind === 'need') {
      for (j = 0; j < (q.fields || []).length; j++) for (k = 0; k < (stage.boxes || []).length; k++) {
        b = stage.boxes[k];
        if (b.path !== q.fields[j]) continue;
        /* the question's own words filled it: nothing to ask (a value from the cover page is not the question's own) */
        /* (10/07, reader 0.8) EXCEPT when the reader itself read the bolt count two ways: then the box holds one of two readings, and a silent choice
           is how a clean, plausible, wrong block is made (all three councils: on a conflict, ask).  The box is emptied and asked, with both readings. */
        if ((b.state === 'rule' || b.state === 'agree' || b.state === 'model') && !isEmptyUi(b, b.proposal) && !(b.rule && b.rule.confidence === 'default')
          && !(/^count_/.test(String(q.id || '')) || /can be read two ways/.test(String(q.text || '')))) continue;
        b.state = 'empty'; b.proposal = undefined; b.required = true; b.alts = []; b.question = String(q.text);
      }
    }
  }
}
/* REVIEW 4: the column load asked at a level OTHER than the lowest ("at the third floor level from the top", "the column supports only the 3 floors
   above"): the page printed the load at the base (1728 for 648).  The takedown's answer line is the lowest level; the question is not answered with it. */
function markLevel(part, stage) {
  var own, m;
  if (stage.fn !== 'loads_takedown') return;
  own = String(part.ctx || '').slice(part.coverLen || 0);
  m = /\b(?:floors?|levels?|stor(?:y|ies|eys?))\s+(?:level\s+)?(?:down\s+)?from\s+the\s+(?:top|roof)\b|\b(?:supports?|carr(?:y|ies)|carrying)\s+only\s+the\s+[^.;]{0,25}\babove\b|\bonly\s+the\s+\w+\s+(?:floors?|levels?|stor(?:y|ies|eys?))\s+above\b|\b(?:below|above|under|beneath)\s+the\s+(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|top|upper(?:most)?)\s+(?:floor|level|stor(?:y|ey))\b|\bat\s+the\s+(?:\d+(?:st|nd|rd|th)|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)[\s-]+(?:floor|level|stor(?:y|ey))\b|\bin\s+the\s+(?:\d+(?:st|nd|rd|th)|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|top|upper(?:most)?)[\s-]+(?:floor|level|stor(?:y|ey))\s+column\b|\b(?:top|upper(?:most)?)[\s-]+stor(?:y|ey)\s+column\b|\bat\s+each\s+(?:level|floor|stor(?:y|ey))\b[^.;]{0,30}\bcolumn\s+load\b|\bload\s+(?:in|on)\s+the\s+column\s+at\s+each\s+(?:level|floor|stor(?:y|ey))\b/i.exec(own);
  if (!m || stage.refuse) return;
  stage.refuse = 'Your question asks for the column load at a level that is NOT the lowest one ("' + trim(m[0]) + '"). The answer line of this calculation is the load at the BASE of the column (all the floors together), so it is not the answer to this question. NOT answered here. By hand: count only the floors (and the roof) ABOVE the level asked, add their dead loads and their live loads, then take the larger of 1.2 D + 1.6 L and 1.4 D.';
  stage.refuseHard = true;
}
/* A limit on the DEPTH of the beam to select, or families to choose from, that the reader did not read ("cannot be deeper than 12 in", "headroom restricts
   the beam depth to 12 in", "Use W12 or W14 shapes": the lightest shape of ANY depth was printed, W21X44 for W10X68). */
function markDepth(part, stage) {
  var own, i, b, md = null, ad = null, m, fam;
  /* REVIEW 4: the same limit said in a FLOOR PLAN ("the beam depth cannot exceed 12 inches", "the beams may not be deeper than 10 in"): the worksheet has
     boxes for it (beam / girder: allowed depths, maximum depth).  When the words limit the depth of a beam or a girder and none of those boxes holds it,
     no shape is printed. */
  if (stage.fn === 'floor_plan') {
    own = String(part.ctx || '').slice(part.coverLen || 0);
    var got4 = false, same = false, dm = null, sl = sentenceList(own), k;
    for (i = 0; i < stage.boxes.length; i++) {
      b = stage.boxes[i];
      if (/^(?:beam|girder)_(?:allowed_depths|max_depth_in)$/.test(b.name) && (b.state === 'rule' || b.state === 'agree' || b.state === 'model') && !isEmptyUi(b, b.proposal)) got4 = true;
      if (b.name === 'girder_same_depth_as_beam' && (b.state === 'rule' || b.state === 'agree' || b.state === 'model') && b.proposal !== undefined && String(b.proposal) !== 'false') same = true;
    }
    if (got4 || same || stage.refuse) return;
    for (k = 0; k < sl.length && !dm; k++) {
      if (/\b(?:slab|deck|topping|concrete)\b/i.test(sl[k]) && !/\b(?:beams?|girders?)\b/i.test(sl[k])) continue;
      if (/\b(?:beams?|girders?)\b/i.test(sl[k]) && /\b(?:depth|deep(?:er)?|headroom|head\s+room|clearance|shallow(?:er)?)\b/i.test(sl[k]) && !/\b(?:slab|deck|topping)\s+(?:depth|is|of)\b|\bdeep\s+(?:slab|deck)\b/i.test(sl[k])) dm = trim(sl[k]);
    }
    if (dm) stage.refuse = 'Your question limits how deep the beam or the girder may be ("' + dm.slice(0, 100) + '"), and the page did not read that limit: it would pick the lightest shape of any depth. Open "Change a value" and type the limit in "Beam: maximum depth" (or the girder\'s box), in inches; no shape is printed without it.';
    if (dm) stage.refuseUnless = ['beam_max_depth_in', 'beam_allowed_depths', 'girder_max_depth_in', 'girder_allowed_depths'];
    return;
  }
  if (stage.fn !== 'beam_select') return;
  own = String(part.ctx || '').slice(part.coverLen || 0);
  for (i = 0; i < stage.boxes.length; i++) { b = stage.boxes[i]; if (b.name === 'max_depth_in') md = b; else if (b.name === 'allowed_depths') ad = b; }
  function got(x) { return !!x && (x.state === 'rule' || x.state === 'agree' || x.state === 'model') && !isEmptyUi(x, x.proposal); }
  /* (10/06 night) the limit written as a FORMULA: "Select the lightest W with actual d <= 16.5 in" has no word "depth" in it; the lightest shape of any
     depth was printed (W21X44, 20.7 in deep).  The number after "d <=" is the largest actual depth. */
  if (md && !got(md) && !got(ad) && (m = /\b(?:depth\s+)?d\s*(?:<=|=<|<)\s*(\d+(?:\.\d+)?)\s*-?\s*(?:in\.?|inch(?:es)?|")(?![A-Za-z])/i.exec(own))) {
    md.state = 'rule'; md.proposal = Number(m[1]); md.words = [{ src: 'rules', text: trim(m[0]) }]; md.alts = []; md.askNow = false;
    md.rule = { value: Number(m[1]), quote: trim(m[0]), confidence: 'high', rule: 'the largest actual depth, written as d <= ...' };
    md.notes = ['read from "' + trim(m[0]) + '": the shape\'s actual depth d may not be more than this'];
  }
  /* (10/07) THE FAMILY IS THE LIMIT.  "Lightest W16 that works, W16x____", "Select the lightest W16 or W18 beam": the page saw the family, said it had
     not read the limit, and printed nothing (another lab's clean question).  The nominal depth goes into the box "only these nominal depths", and the
     calculator chooses among those shapes only.  A full designation ("a W16x40 girder") is a member, not a family. */
  if (ad && !got(ad) && !got(md)) {
    var famN = [], fre = /\bW\s?(\d{1,2})\b(?!\s*[xX]\s*\d)/g, fm2;
    while ((fm2 = fre.exec(own)) !== null) if (Number(fm2[1]) >= 4 && Number(fm2[1]) <= 44 && famN.indexOf(Number(fm2[1])) < 0) famN.push(Number(fm2[1]));
    if (famN.length) {
      ad.state = 'rule'; ad.proposal = famN.join(', '); ad.words = [{ src: 'rules', text: famN.map(function (x) { return 'W' + x; }).join(', ') }]; ad.alts = []; ad.askNow = false;
      ad.rule = { value: famN.join(', '), quote: famN.map(function (x) { return 'W' + x; }).join(', '), confidence: 'high', rule: 'the family named in the question: only shapes of that nominal depth' };
      ad.notes = ['read from the family your question names (' + famN.map(function (x) { return 'W' + x; }).join(', ') + '): the choice is made among those shapes only'];
    }
  }
  if (got(md) || got(ad)) return;
  /* (10/07) words that say there is NO limit are not a limit */
  own = own.replace(/\b(?:no|without\s+(?:an?y?\s+)?|not\s+any)\s*(?:depth|headroom|clearance)\s+(?:limit(?:ation)?s?|restrictions?)\b|\bno\s+(?:limit|restriction)s?\s+on\s+(?:the\s+)?depth\b|\bof\s+any\s+depth\b|\bdepth\s+is\s+not\s+(?:limited|restricted)\b|\bany\s+depth\b/gi, ' ');
  /* (REVIEW 4: the depth of a SLAB is not a limit on the beam: "8 ft below a 12 inch deep floor slab" stopped a plain beam selection) */
  own = own.replace(/\b\d+(?:\.\d+)?\s*-?\s*(?:in\.?|inch(?:es)?|")\s*-?\s*(?:deep|thick)\s+(?:(?:concrete|floor|composite|roof|reinforced)\s+)*(?:slab|deck|topping|footing|wall)\b/gi, ' ')
    .replace(/\b(?:slab|deck|topping|footing)\s+(?:depth|thickness)\b[^.;]{0,24}/gi, ' ');
  /* any word about how deep the beam may be, with or without a number ("the beam should be kept shallow, around a foot") */
  m = /\b(?:depth|deep(?:er)?|headroom|head\s+room|clearance|shallow(?:er)?)\b[^.;]{0,70}/i.exec(own);
  /* families named without a size: "Use W12 or W14 shapes", "a W14" (never "W12 x 58", and never the answer blank "W____ x ____") */
  fam = /\bW\s?\d{1,2}\b(?!\s*[xX]\s*[\d_])/.exec(own);
  if (m || fam) stage.refuse = 'Your question limits which shapes may be chosen ("' + trim((m || fam)[0]).slice(0, 80) + '"), and the page did not read that limit: it would pick the lightest shape of any depth. Open "Change a value" and type the limit in "' + plainLabel((md || ad || { label: 'Maximum depth' }).label) + '" (the depth in inches), or leave this question: no shape is printed without it.';
  if (m || fam) stage.refuseUnless = ['max_depth_in', 'allowed_depths'];
}
/* A beam at the EDGE of the floor, said in words the reader did not read ("a perimeter beam", "a beam at the edge of the slab", "only supports slab on one
   side": the interior line load, twice the right one, was printed).  When the question's words put the beam at the edge and the box does not say edge
   (or the other way round), the box is asked. */
var EDGE_WORDS_RE = /\b(?:edge|exterior|perimeter|spandrel|boundary|outer(?:most)?|outside)\s+(?:floor\s+|steel\s+|\(\w+\)\s+)?(?:beam|girder|member)s?\b|\bat\s+the\s+(?:edge|perimeter|boundary)\b|\b(?:slab|floor|deck)\s+on\s+(?:only\s+)?one\s+side\b|\bone\s+side\s+only\b|\bon\s+only\s+one\s+side\b/i,
  INTERIOR_WORDS_RE = /\b(?:interior|intermediate|inner|typical\s+interior)\s+(?:floor\s+|steel\s+)?(?:beam|girder|member|bay)s?\b|\b(?:slab|floor|deck)\s+on\s+both\s+sides\b|\bcontinues\s+on\s+all\s+sides\b|\binterior\s+members?\b/i;
function markPosition(part, stage) {
  var own, i, b, pos = null, isEdge, isInt, v;
  if (!/^(?:loads_floor|floor_plan|beam_max_live_load)$/.test(stage.fn)) return;
  own = String(part.ctx || '').slice(part.coverLen || 0);
  for (i = 0; i < stage.boxes.length; i++) { b = stage.boxes[i]; if (b.name === 'position' || b.name === 'beam_position') pos = b; }
  if (!pos) return;
  isEdge = EDGE_WORDS_RE.test(own); isInt = INTERIOR_WORDS_RE.test(own);
  if (isEdge === isInt) return;                                  /* neither, or both: nothing here decides it */
  v = String(pos.proposal === undefined || pos.proposal === null ? '' : pos.proposal).toLowerCase();
  if ((pos.state === 'rule' || pos.state === 'agree' || pos.state === 'model') && ((isEdge && v === 'edge') || (isInt && v === 'interior'))) return;
  pos.state = 'empty'; pos.proposal = undefined; pos.required = true; pos.alts = [];
  pos.question = 'Your question says where this beam is ("' + trim((isEdge ? EDGE_WORDS_RE : INTERIOR_WORDS_RE).exec(own)[0]) + '"), and the page did not take it from the words. '
    + (isEdge ? 'A beam at the EDGE of the floor has slab on ONE side: choose edge.' : 'A beam INSIDE the floor has slab on BOTH sides: choose interior.');
}
/* The slab's thickness is in the question and in no box ("a 6 in. thick normal weight concrete slab", "whose thickness is 6 in.", "0.5 ft thick"): the floor
   load was printed WITHOUT the slab, under a warning (184 psf for 271).  A floor load without its slab is not an answer: the box is asked. */
function markSlab(part, stage) {
  var own, i, b, th = null, pc = null, m;
  if (!/^(?:loads_floor|floor_plan|beam_max_live_load)$/.test(stage.fn)) return;
  own = String(part.ctx || '').slice(part.coverLen || 0);
  for (i = 0; i < stage.boxes.length; i++) { b = stage.boxes[i]; if (b.name === 'slab_thickness_in') th = b; else if (b.name === 'concrete_pcf') pc = b; }
  /* "lightweight concrete" and no unit weight in the question's own words: the usual 150 lb/ft^3 (the cover page's, or the calculator's) is for normal
     concrete, so the box is asked and nothing is worked out with 150 */
  if (pc && /\blight[\s-]?weight\b/i.test(own) && !((pc.state === 'rule' || pc.state === 'agree' || pc.state === 'model') && !isEmptyUi(pc, pc.proposal))) {
    pc.state = 'empty'; pc.proposal = undefined; pc.required = true;
    pc.question = 'Your question says LIGHTWEIGHT concrete and gives no unit weight. Type its unit weight in lb/ft^3 if your question or its table gives one. The usual 150 is for normal concrete and would be wrong here.';
  }
  if (!th || ((th.state === 'rule' || th.state === 'agree' || th.state === 'model' || th.state === 'default') && !isEmptyUi(th, th.proposal))) return;
  m = /\b(?:slab|topping|concrete\s+(?:floor|deck|fill))\b/i.test(own)
    && (/\d+(?:\.\d+)?(?:\s+\d\/\d)?\s*-?\s*(?:in\.?|inch(?:es)?|ft|feet|foot|")\s*-?\s*(?:\(?[a-z ]{0,24}\)?\s*)?thick\b/i.exec(own) || /\bthick(?:ness)?\b[^.;]{0,30}?\d+(?:\.\d+)?\s*-?\s*(?:in\.?|inch(?:es)?|ft|feet|foot|")/i.exec(own));
  if (!m) return;
  th.state = 'empty'; th.proposal = undefined; th.required = true;
  th.question = 'Your question gives the thickness of the slab ("' + trim(m[0]).slice(0, 60) + '") and the page did not read it. Type the slab thickness in INCHES (6 in = 6; 0.5 ft = 6). Without it the floor load would leave the slab out.';
}
function markFloorPlan(part, stage) {
  var i, span = null, sides = null, b, pos = null, spacing = null, trib = null;
  if (stage.fn !== 'floor_plan') return;
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    if (b.name === 'girder_span_ft') span = b; if (b.name === 'girder_beam_sides') sides = b;
    if (b.name === 'beam_position') pos = b; if (b.name === 'beam_spacing_ft') spacing = b; if (b.name === 'beam_tributary_ft') trib = b;
  }
  /* The text GIVES the beam's own weight ("Each beam has a self-weight of 50 lb/ft"): kept on the stage; runPart enters it (see there). */
  /* Every load per foot the question gives (lb/ft, k/ft).  A floor plan has no box for one, so each must be accounted for:
       the BEAM's own weight ("Each beam has a self-weight of 50 lb/ft", "The weight of each beam is 50 lb/ft", "Beam weight = 50 plf") -> entered by runPart;
       the GIRDER's own weight -> matters only when the worksheet goes on to the girder, and then there is no box for it: the page refuses;
       anything else (a wall on the beam ...) -> the page refuses.
     REVIEW 1: the girder's weight was added to the beam.  REVIEW 2: ten of twelve ways of giving the beam's weight were dropped (169.65 printed for 172.35). */
  var own = String(part.ctx || '').slice(part.coverLen || 0), lineRe = /(\d*\.?\d+)\s*(lb\s*\/\s*ft|plf|lbs?\s+per\s+f(?:oo)?t|k\s*\/\s*ft|klf|kips?\s*\/\s*ft)(?!\s*(?:\^|\*\*)?\s*[23])(?![A-Za-z0-9])/gi, lm, sen, isW, forB, forG,
    sw = null, girderW = null, otherLine = [],
    swOff = /\b(?:ignor\w*|neglect\w*|exclud\w*|do\s+not\s+include|without)\b[^.;]{0,40}\b(?:self[\s-]?weight|own\s+weight|weight)\s+of\s+the\s+beams?\b/i.test(own);
  while ((lm = lineRe.exec(own)) !== null) {
    sen = own.slice(0, lm.index).split(/[.;!?]\s+|\n/).pop() + own.slice(lm.index).split(/[.;!?]\s+|\n/)[0];
    isW = /\b(?:self[\s-]?weight|own\s+weight|weighs?|weight)\b/i.test(sen);
    forB = /\bbeams?\b|\bB\s?\d\b/i.test(sen); forG = /\bgirders?\b|\bG\s?\d\b/i.test(sen);
    if (isW && forB && !forG) { if (!sw) sw = { value: Number(lm[1]) * (/^k/i.test(lm[2]) ? 1000 : 1), from: trim(sen).slice(0, 90) }; }
    else if (isW && forG && !forB) girderW = trim(lm[0]);
    else otherLine.push(trim(lm[0]));
  }
  stage.givenBeamPlf = sw && !swOff ? sw : null;
  stage.givenGirderW = girderW;
  if (otherLine.length) stage.refuse = 'Your question gives a load per foot (' + otherLine.join(', ') + ') and the floor-plan worksheet has no box for it. The page will not answer without it. If it is the beam\'s own weight, say so in the question box the way the paper does (for example "Each beam has a self-weight of ' + otherLine[0] + '") and press Solve again; otherwise this part is not for this page.';
  /* The question asks only about the BEAM, or only for the floor load: the worksheet stops there and does not go on to ask for the girder.
     (Real May 2024 final, Q20: "Determine the design moment Mu for beam B1", blank "Mu = ____ kip-ft": the page asked for the girder span next.) */
  var thr = null, members, stopAt = 0;
  for (i = 0; i < stage.boxes.length; i++) if (stage.boxes[i].name === 'through_step') thr = stage.boxes[i];
  if (thr && (thr.state === 'empty' || thr.state === 'default') && part.asked && part.asked.length) {
    members = part.asked.map(function (bl) { return (bl.id === 'wu' && bl.unit === 'psf') || bl.id === 'deadpsf' || bl.id === 'livepsf' || (bl.id === 'live' && bl.unit === 'psf') ? 'floor' : floorMember(part, bl); });
    if (members.every(function (m) { return m === 'floor'; })) stopAt = 1;
    else if (members.every(function (m) { return m === 'beam' || m === 'floor'; })) stopAt = 2;
    else if (members.every(function (m) { return m === 'girder' || m === 'beam' || m === 'floor'; })) stopAt = 3;
    if (stopAt) {
      thr.state = 'rule'; thr.proposal = String(stopAt); thr.words = [{ src: 'rules', text: part.asked.map(function (bl) { return bl.raw; }).join(' ; ') }];
      thr.notes = ['your answer blank asks about ' + ['', 'the floor load', 'the beam', 'the girder'][stopAt] + ', so the worksheet stops after step ' + stopAt]; thr.alts = []; thr.askNow = false;
    }
  }
  /* the same for the beam: slab on both sides (interior) or on one side (edge) halves or doubles its load */
  if (pos && spacing && spacing.proposal !== undefined && !isEmptyUi(spacing, spacing.proposal) && (pos.state === 'empty' || pos.state === 'default' || pos.state === 'unclear' || pos.state === 'rejected')
    && !(trib && trib.proposal !== undefined && !isEmptyUi(trib, trib.proposal))) {
    pos.state = 'empty'; pos.required = true;
    pos.question = 'Your text does not say it. Look at the plan: is this beam INSIDE the floor (slab on both sides: interior) or at the EDGE of the floor (slab on one side: edge)? Choose one.';
  }
  /* REVIEW 10/06: a worksheet that stops at the beam does not need to know how the beams meet the girder (the page stopped there for a beam's reaction) */
  if ((stopAt && stopAt <= 2) || (thr && Number(thr.proposal) >= 1 && Number(thr.proposal) <= 2)) return;
  /* the girder's own weight is given and the worksheet goes on to the girder: there is no box for a given girder weight */
  if (stage.givenGirderW && !stage.refuse) stage.refuse = 'Your question gives the girder\'s own weight (' + stage.givenGirderW + '). The floor-plan worksheet has no box for a given girder weight, so the page will not answer for the girder. The beam part can still be asked on its own.';
  if (!span || !sides) return;
  if (span.proposal === undefined || isEmptyUi(span, span.proposal)) return;
  if (sides.state !== 'empty' && sides.state !== 'default' && sides.state !== 'unclear' && sides.state !== 'rejected') return;
  sides.state = 'empty'; sides.required = true;
  sides.question = 'Your text does not say it. Look at the plan: do beams frame into this girder from BOTH sides (a girder inside the floor) or from ONE side (a girder at the edge of the floor)? Choose one.';
}

function toEngineValue(box, v) {
  var i, out, it, sub, k, any, o;
  if (box.kind === 'bool') { var t = toBool(v); return t === null ? undefined : t; }
  if (box.kind === 'list') {
    out = [];
    for (i = 0; i < v.length; i++) {
      o = {}; any = false;
      for (k = 0; k < box.items.length; k++) {
        sub = box.items[k]; it = v[i][sub.name];
        if (it === undefined || it === null || trim(it) === '') continue;
        o[sub.name] = (sub.kind === 'num' || sub.kind === 'int') ? trim(it) : (sub.kind === 'bool' ? toBool(it) : trim(it));
        any = true;
      }
      if (any) out.push(o);
    }
    return out.length ? out : undefined;
  }
  if (isStr(v)) v = trim(v);
  if (v === '' || v === undefined || v === null) return undefined;
  return v;
}
/* the nested arguments for the engine from one stage's values; carry = {path: value} replaces the boxes that come from an earlier stage */
function buildArgs(stage, vals, carry, drop) {
  var args = {}, i, b, v, dropSet = {};
  if (drop) for (i = 0; i < drop.length; i++) dropSet[drop[i]] = 1;
  for (i = 0; i < stage.boxes.length; i++) {
    b = stage.boxes[i];
    if (dropSet[b.path]) continue;
    if (carry && has(carry, b.path)) { setNested(args, b.path, carry[b.path]); continue; }
    v = vals ? vals[b.path] : undefined;
    v = toEngineValue(b, v);
    if (v === undefined) continue;
    setNested(args, b.path, v);
  }
  if (carry) { var k; for (k in carry) if (has(carry, k) && getNested(args, k) === undefined) setNested(args, k, carry[k]); }
  return args;
}
SOLVE.buildArgs = buildArgs;

/* ------------------------------------------------------------------------------------------------ running the chain */
function runOne(fn, args) {
  var E = env(), res;
  try { res = E.STEEL.run(fn, clone(args)); } catch (e) { res = { ok: false, name: fn, error: { code: 'INVALID', message: 'Internal error: ' + String(e && e.message ? e.message : e), suggestions: [] } }; }
  return res;
}
/* vals = { stageIndex: { path: uiValue } } */
SOLVE.runPart = function (part, vals) {
  var out = { ok: true, stages: [], failedAt: -1 }, si, st, rule, carry, drop, args, res, prev, src, u, why;
  for (si = 0; si < part.stages.length; si++) {
    st = part.stages[si]; carry = null; drop = null;
    /* a refusal that asks him to TYPE a limit (a depth limit the page did not read) is lifted once one of the boxes it names holds a value */
    var lifted = !!(st.refuse && st.refuseUnless && st.refuseUnless.some(function (nm) { var v0 = (vals[si] || {})[nm]; return v0 !== undefined && v0 !== null && String(v0).replace(/[\s\[\]]+/g, '') !== ''; }));
    if (st.refuse && !lifted) { out.stages.push({ fn: st.fn, role: st.role, ok: false, res: { ok: false, error: { code: st.refuseHard ? 'NOT_IN_TOOL' : 'PAGE_STOP', message: st.refuse } }, args: null }); out.ok = false; out.failedAt = si; break; }
    if (si > 0) {
      prev = out.stages[si - 1];
      rule = carryRule(part.stages[si - 1].fn, st.fn);
      if (!rule) { out.stages.push({ fn: st.fn, role: st.role, ok: false, res: null, args: null, skipped: 'The page cannot carry the result of ' + part.stages[si - 1].fn + ' into ' + st.fn + ' by itself.' }); out.ok = false; out.failedAt = si; break; }
      if (!prev.ok) { out.stages.push({ fn: st.fn, role: st.role, ok: false, res: null, args: null, skipped: 'Step ' + si + ' did not give an answer, so this step was not run.' }); out.ok = false; out.failedAt = si; break; }
      src = rule.take ? prev.res.values[rule.take] : (part.stages[si - 1].fn === 'loads_combinations' ? prev.res.values.U_max : null);
      if (!src || !isNum(src.value)) { out.stages.push({ fn: st.fn, role: st.role, ok: false, res: null, args: null, skipped: 'Step ' + si + ' did not report the number that step ' + (si + 1) + ' needs.' }); out.ok = false; out.failedAt = si; break; }
      carry = {}; carry[rule.from] = src.value;
      for (u in rule.set) if (has(rule.set, u)) carry[u] = rule.set[u];
      drop = rule.drop;
      if (rule.unit) {
        why = null;
        u = prev.args && prev.args.unit ? String(prev.args.unit).toLowerCase() : 'kips';
        if (rule.unit === 'kips' && !(u === 'kips' || u === 'kip' || u === 'k')) why = 'the load combination was run in "' + prev.args.unit + '", not kips';
        if (rule.unit === 'k/ft' && !(u === 'k/ft' || u === 'klf')) why = 'the load combination was run in "' + (prev.args.unit || 'kips') + '", not k/ft';
        if (why) { out.stages.push({ fn: st.fn, role: st.role, ok: false, res: null, args: null, skipped: 'Cannot carry the governing load into ' + st.fn + ': ' + why + '.' }); out.ok = false; out.failedAt = si; break; }
      }
    }
    var v = vals && vals[si] ? vals[si] : {};
    if (si === 0 && part.stages[si].fn === 'loads_combinations' && part.stages.length > 1) {
      /* the unit of the combination is only a print label; the next form needs kips (or k/ft for a beam) */
      var nxt = carryRule('loads_combinations', part.stages[1].fn);
      if (nxt && nxt.unit && !trim(v.unit)) { v = clone(v); v.unit = nxt.unit; }
    }
    args = buildArgs(st, v, carry, drop);
    if (si === 0 && part.stages[si].fn === 'loads_combinations' && part.stages.length > 1) {
      var nr = carryRule('loads_combinations', part.stages[1].fn);
      if (nr && nr.unit && !args.unit) args.unit = nr.unit;
    }
    /* A load question on its own: the calculator labels its answer "kips" unless it is told the unit.  The number was right and the label wrong
       ("216 kips" for loads in psf, "1.19 kips" for k/ft: REVIEW 3).  The unit is the one of the first load in the question's own words. */
    if (/^loads_(?:factored|combinations)$/.test(st.fn) && part.stages.length === 1 && !trim(args.unit === undefined || args.unit === null ? '' : args.unit)) {
      var uOwn = String(part.ctx || '').slice(part.coverLen || 0), uM = /\d\s*(psf|k\s*\/\s*ft|klf|kips?\s*\/\s*ft|plf|lbs?\s*\/\s*ft|kips?|k)(?![A-Za-z0-9\/])/i.exec(uOwn);
      if (uM) args.unit = /psf/i.test(uM[1]) ? 'psf' : (/plf|lb/i.test(uM[1]) ? 'lb/ft' : (/\/|klf/i.test(uM[1]) ? 'k/ft' : 'kips'));
    }
    res = runOne(st.fn, args);
    /* (10/07) A MULTIPLE-CHOICE QUESTION IS NEVER REFUSED BECAUSE OF ITS STEM.  The look-up of the stem's words is only a side line there: what he needs is
       the choices next to her wording, and the letter when her wording singles one out.  Her own 2024 question 16 ("The section property which mostly
       influences the available nominal stress ... for a column is (choose one)") names two of her entries in its stem; the look-up called that a tie and
       the whole part printed "No answer was written" -- the choices were never shown.  With no letter and no look-up, the part still prints. */
    if (part.kind === 'words' && part.mc && !part.mc.best && res && !res.ok && !(v && v['_picked:query'])) {
      res = { ok: true, name: st.fn, answer: { label: 'Multiple choice', text: 'her wording for each choice is in the table' }, values: {}, steps: [], flags: [], sources: [], mcOnly: true };
    }
    /* (10/07) AN OPEN WORD QUESTION IS NOT REFUSED WHILE HER SENTENCES ON IT ARE IN THE STORE.  The look-up matches the NAMES of her entries; "Why is
       1/8 in added to the bolt diameter?" names none and printed "No definition matches".  The order-free matcher found her sentences for 25 of the 26
       word questions the outside labs wrote.  With hits and no look-up, the part prints her sentences (see writeBlock). */
    if (part.kind === 'words' && !part.mc && res && !res.ok && part.wx && ((part.wx.hits && part.wx.hits.length) || part.wx.top) && !(v && v['_picked:query'])) {
      res = { ok: true, name: st.fn, answer: { label: 'Her sentences', text: 'see the lines above' }, values: {}, steps: [], flags: [], sources: [], wxOnly: true };
    }
    /* A floor plan whose text gives the beam's own weight in lb/ft.  The form has no box for it; left alone, the worksheet chose a beam and added THAT beam's
       weight (real May 2024 final, Q20: the page said Mu = 169.65, the answer is 172.35).  The given weight, spread over the beam's tributary width, is the same
       load as a steel-framing weight in psf, which the form does take; the worksheet's own self-weight recheck is switched off.  The tributary width is read
       off the first run (line load / floor load), so it is the engine's own, interior or edge. */
    var selfNote = null;
    if (st.fn === 'floor_plan' && st.givenBeamPlf && res && res.ok && res.values && res.values.step2_wu && res.values.step1_factored_psf
      && (args.framing_psf === undefined || args.framing_psf === null || args.framing_psf === '' || Number(args.framing_psf) === 0) && !args.beam_shape) {
      var tribW = Number(res.values.step2_wu.value) * 1000 / Number(res.values.step1_factored_psf.value), args2, res2, psf;
      if (isFinite(tribW) && tribW > 0) {
        psf = Math.round(st.givenBeamPlf.value / tribW * 10000) / 10000;
        args2 = clone(args); args2.framing_psf = psf; args2.self_weight_recheck = false;
        res2 = runOne(st.fn, args2);
        if (res2 && res2.ok) {
          res = res2; args = args2;
          selfNote = 'Beam self-weight GIVEN in your question: ' + st.givenBeamPlf.value + ' lb/ft ("' + st.givenBeamPlf.from + '"). Over its tributary width of ' + Number(tribW.toFixed(3)) + ' ft that is '
            + st.givenBeamPlf.value + ' / ' + Number(tribW.toFixed(3)) + ' = ' + psf + ' psf, entered below as the steel framing weight. It is the same as adding ' + Number((st.givenBeamPlf.value / 1000).toFixed(4)) + ' k/ft of dead load to the beam.';
        }
      }
    }
    /* A WELDED member for which the question GIVES a shear lag factor below 1 ("connected by welds to its flanges only ... U = 0.85").  The calculator's welded
       mode checks yielding only (her rule for a member with no holes) and does not use U: 463.5 kips was printed where rupture on Ae = U Ag gives 426.8
       (REVIEW 3).  A U the question states is meant to be used: the rupture check is added here, in the open, and the smaller of the two governs.
       (U reaches this box below 1 only from the question's own words or from his typing; the cover page's default is 1.0.) */
    var wU0 = NaN;
    if (st.fn === 'tension_capacity' && args.welded === true && args.U !== undefined && args.U !== null && trim(args.U) !== '') { try { wU0 = Number(parseNum(args.U)); } catch (eU) { wU0 = NaN; } }
    if (st.fn === 'tension_capacity' && res && res.ok && args.welded === true && isFinite(wU0) && wU0 > 0 && wU0 < 1 && res.values && res.answer
      && res.values.Ag && res.values.Fu && res.values.yielding && isNum(res.values.Ag.value) && isNum(res.values.Fu.value) && isNum(res.values.yielding.value)) {
      (function () {
        var wAg = Number(res.values.Ag.value), wFu = Number(res.values.Fu.value), wU = wU0, wAe = Math.round(wU * wAg * 10000) / 10000,
          wRup = Math.round(0.75 * wFu * wAe * 100) / 100, wYld = Number(res.values.yielding.value), wCap = Math.min(wYld, wRup), wGov = wRup < wYld ? 'rupture' : 'yielding';
        res = clone(res);
        res.steps = (res.steps || []).filter(function (s) { return !/rupture is not checked|First failure load/i.test(String(s.text)); });
        res.steps.push({ text: 'Your question GIVES the shear lag factor U = ' + wU + ' for this welded member, so rupture is checked as well: Ae = U Ag = ' + wU + ' x ' + wAg + ' = ' + wAe
          + ' in^2; phi Pn = 0.75 Fu Ae = 0.75 x ' + wFu + ' x ' + wAe + ' = ' + wRup + ' kips.', source: 'AISC D2 / D3: Ae = An U, and An = Ag when there are no holes' });
        res.steps.push({ text: 'First failure load = the SMALLER of yielding ' + wYld + ' and rupture ' + wRup + ': ' + wCap + ' kips (' + wGov + ' governs).', source: '' });
        res.values.U = { value: wU, unit: '', source: '' }; res.values.Ae = { value: wAe, unit: 'in^2', source: '' }; res.values.rupture = { value: wRup, unit: 'kips', source: '' };
        res.values.capacity = { value: wCap, unit: 'kips', source: '' }; res.values.governs = { value: wGov, unit: '', source: '' };
        res.answer = { label: res.answer.label, value: wCap, unit: 'kips', text: 'phi Pn = ' + sigNum(wCap) + ' kips -- ' + wGov + ' governs (yielding ' + sigNum(wYld) + ', rupture ' + sigNum(wRup) + '; welded, U = ' + wU + ' as given)' };
        res.flags = (res.flags || []).filter(function (f) { return !(/only yielding is checked/i.test(String(f)) && /\bU\b/.test(String(f))); });
        res.flags.push('NOTE: the calculator checks yielding only for a welded member. Your question states U = ' + wU + ', so this page added the rupture check on Ae = U x Ag itself (the two lines at the end of the steps).');
      })();
    }
    /* The cover page's "U = 1.0 unless noted otherwise" was followed (no part of the question speaks of shear lag, U or Table D3.1).  Whether SHE means it
       for this question the page cannot know, so the other reading is shown where he reads but does not copy: what Table D3.1 would have given. */
    if (/^tension_(?:capacity|select)$/.test(st.fn) && res && res.ok && res.answer && args.welded !== true && args.U !== undefined && args.U !== null && trim(args.U) !== '') {
      (function () {
        var ub = null, bi, aAlt, rAlt;
        for (bi = 0; bi < (st.boxes || []).length; bi++) if (st.boxes[bi].name === 'U') ub = st.boxes[bi];
        if (!ub || !ub.rule || !/cover page/i.test(String(ub.rule.rule || '')) || String(args.U) !== String(ub.proposal)) return;
        aAlt = clone(args); delete aAlt.U;
        try { rAlt = runOne(st.fn, aAlt); } catch (eA) { rAlt = null; }
        if (!rAlt || !rAlt.ok || !rAlt.answer || String(rAlt.answer.text) === String(res.answer.text)) return;
        res = clone(res);
        res.flags = (res.flags || []).concat(['NOTE: your cover page says "U = 1.0 unless noted otherwise", and no part of this question speaks of shear lag, of U or of Table D3.1, so U = 1.0 was used. With U from Table D3.1 instead, the result would be: ' + String(rAlt.answer.text) + '. Use that one only if your exam tells you to find U for this question.']);
      })();
    }
    /* The question speaks of bolts or holes, and the answer took NO hole out of the area ("yielding governs (no holes)"): the holes are in a figure, or were
       written in a way the page could not read.  That is a wrong answer, not an answer: the page asks for the holes instead. */
    if (/^tension_(?:capacity|net_area)$/.test(st.fn) && res && res.ok && res.values && res.values.An && res.values.Ag && isNum(res.values.An.value) && isNum(res.values.Ag.value)
      && Math.abs(Number(res.values.An.value) - Number(res.values.Ag.value)) < 1e-9) {
      var ownT = String(part.ctx || '').slice(part.coverLen || 0);
      if (/\b(?:bolt(?:s|ed)?|holes?|rivet(?:s|ed)?)\b/i.test(ownT) && !/\bweld|\bno\s+(?:bolt\s+)?holes?\b|\bwithout\s+(?:any\s+)?(?:bolt\s+)?holes?\b|\bnot\s+bolted\b|gross\s+(?:section\s+)?yield/i.test(ownT)) {
        res = { ok: false, error: { code: 'MISSING', message: 'Your question mentions bolts or holes, but the page found no hole to take out of the area: how many holes cross the section (per flange / in the web / across the plate)? Count them in your question or in its figure and fill the hole boxes.' } };
      }
    }
    /* (10/06 night) AN ANSWER OF ZERO IS A READING THAT FAILED.  "A column supports 8 flor levels ... WD = 100 psf, WL = 60 psf" found no floor, the
       takedown added up nothing, and the page printed "Pu = 0 kips" as its ANSWER.  A load, a strength, an area, a moment or a stress that comes out as
       zero, negative or not a number is never printed: a value it needed was not read.  (The two reverse forms may end at zero by themselves -- "no live
       load can be added" -- and a look-up or a conversion may give any number.) */
    if (res && res.ok && res.answer && typeof res.answer.value === 'number' && !/^(?:loads_max_service|beam_max_live_load|units|lookup_)/.test(st.fn)
      && !(isFinite(res.answer.value) && res.answer.value > 0)) {
      res = { ok: false, error: { code: 'MISSING', message: (st.fn === 'loads_takedown'
        ? 'The page found no floor and no roof for this column to carry, so the load came out as ' + res.answer.value + '. A number of your question was not read: check the words that say HOW MANY floors (or levels, or stories) the column supports.'
        : 'The calculation came out as ' + res.answer.value + ', which is not a possible answer here. A number of your question was not read: check the spelling of the words around each number.') } };
    }
    /* (10/06 night, council 2, all four labs) THE PRINT CONTRACT: checked on every result, immediately before it may be printed. */
    if (res && res.ok) { var pcMsg = null; try { pcMsg = printContract(part, st, args, res, si === part.stages.length - 1); } catch (ePC) { pcMsg = null; } if (pcMsg) res = { ok: false, error: { code: 'PAGE_STOP', message: pcMsg } }; }
    out.stages.push({ fn: st.fn, role: st.role, ok: !!(res && res.ok), res: res, args: args, carry: carry, note: selfNote });
    if (!res || !res.ok) { out.ok = false; out.failedAt = si; break; }
  }
  return out;
};
/* THE PRINT CONTRACT.  A wrong reading gives clean arithmetic: the block looks exactly like a right one.  Three things are checked that no reading may break,
   each one a fact the page can test without understanding the question.  A broken contract prints NO number (the message says what did not hold).
     1. A question that NAMES its member and does not ask for a shape is never answered by a form that CHOOSES one (Question 3 of 10/06: "Design strength
        for yielding of the gross section" of a W12x53 was answered with the strength of a shape the page had picked itself).
     2. The gross area the calculator used is the Manual's area of the shape the calculator was given, unless the question states an area itself
        (yielding = 0.90 Fy Ag of THAT shape -- a wrong Ag is a wrong yielding, rupture and capacity, all three plausible).
     3. No load, moment or strength on the way to the answer is zero or negative (a number that was not read turns up as a zero long before the end). */
var SELECT_WORDS = /\b(?:lightest|select\w*|choos\w*|pick\w*|siz(?:e|ing)|economical|least[\s-]+weight|smallest|design\s+(?:a|an|the)\s|required\s+(?:shape|section|size|member|beam|column|girder|W)|(?:what|which)\s+(?:shape|size|section|member|W\s?\d)|replac\w+|substitut\w+|recommend\w*|find\s+(?:a|an|the\s+(?:lightest|smallest|most))\s|would\s+work|can\s+be\s+used|is\s+needed|are\s+needed)\b/i;
var SHAPE_NAMED = /\b(?:W|WT|HP|HSS|MC|C|S|M|L|2L)\s?\d+(?:\.\d+)?\s*[xX]\s*\d+(?:\.\d+)?(?:\s*[xX]\s*\d+(?:[\/.]\d+)?)?/;
function printContract(part, st, args, res, isLast) {
  var own = String(part.ctx || '').slice(part.coverLen || 0) || String(part.text || ''), named = SHAPE_NAMED.exec(own), v = res.values || {}, k, x, db, dbA, agGiven;
  /* 1 */
  if (isLast && /_select$/.test(st.fn) && named && !SELECT_WORDS.test(own) && !(part.asked || []).some(function (b) { return b.id === 'shape'; })
    && !(part.blankCount > 0 && (part.unknownBlanks || []).length)) {
    return 'Your question names the shape ' + named[0].replace(/\s+/g, '') + ' and does not ask to choose one, but the only calculation the page found for it CHOOSES a shape by itself. That would be the answer to another question, so no number is printed. If your question does ask for a shape, type the word it uses (select, lightest, choose) as it stands on the paper.';
  }
  /* 2 */
  /* (a built-up member -- cover plates, boxed with plates -- has MORE area than its rolled shape, by design: the regression dump of 10/07 01:00 caught
     this check refusing three such columns that had been answered right) */
  var builtUp = false;
  for (k in (args || {})) if (has(args, k) && /plate|built|cover|stiffen|doubler/i.test(k) && args[k] !== undefined && args[k] !== null && trim(args[k]) !== '' && args[k] !== false) builtUp = true;
  if (!builtUp && args && args.shape && v.Ag && isNum(v.Ag.value) && /^(?:tension_|column_)/.test(st.fn)) {
    agGiven = /\bA\s?g\s*=\s*\d|\bgross\s+area\s*(?:=|of|is)\s*\d|\barea\s*(?:=|of|is)\s*\d/i.test(own) || (args.Ag !== undefined && args.Ag !== null && trim(args.Ag) !== '');
    if (!agGiven) {
      try { db = env().STEEL.run('lookup_shape', { shape: String(args.shape), property: 'A' }); } catch (eDb) { db = null; }
      dbA = db && db.ok && db.values && db.values.A && isNum(db.values.A.value) ? Number(db.values.A.value) : NaN;
      if (isFinite(dbA) && dbA > 0 && Math.abs(Number(v.Ag.value) - dbA) > 0.011 * dbA + 0.006 && !/^2L/i.test(String(args.shape)) && !(args.member && !/^shape$/i.test(String(args.member)))) {
        return 'The calculator worked with a gross area of ' + v.Ag.value + ' in^2, but the Manual gives ' + dbA + ' in^2 for the ' + String(args.shape).toUpperCase() + ' it was told to use. A number of your question went into the wrong box, so no strength is printed: check the boxes under "Change a value".';
      }
    }
  }
  /* 3 */
  if (!/^(?:loads_max_service|beam_max_live_load|units|lookup_)/.test(st.fn)) {
    for (k in v) if (has(v, k) && /^(?:Pu|wu|Mu|Vu|phiPn|phiMn|capacity|yielding|rupture|Ag|An|Ae|phiFcr|Fcr|Fe|KLr|governing_KLr)$/.test(k)) {
      x = v[k] && typeof v[k] === 'object' ? v[k].value : v[k];
      if (typeof x === 'number' && !(isFinite(x) && x > 0)) return 'On the way to the answer the calculation found ' + k + ' = ' + x + ', which cannot be. A number of your question was not read: check the spelling of the words around each number.';
    }
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------ between the PARTS of one question
   A later part often leaves out what an earlier part gave or found: "Can it be used for this beam?" needs the Mu of part (a); "select the lightest W10 that is"
   needs the column's length and ends from part (b).  carryAcross fills such boxes of parts[idx]:
     - only a box that is EMPTY after the readers (or one this function filled before and nobody has changed since),
     - only from the NEAREST earlier part of the same question that has the number,
     - and it records where each value came from: vals[si]['_from:' + path] = the label of that part.
   parts[j].ui = { vals, run } is what the page keeps for each part.  Returns [{si, path, label, show, fromLabel}] so the page can print "from part (a)". */
var COLUMN_GEOMETRY = ['x_end_condition', 'Lx_ft', 'KLx_ft', 'y_end_condition', 'Ly_ft', 'KLy_ft', 'y_segments'];
var COLUMN_LENGTHS = ['Lx_ft', 'KLx_ft', 'Ly_ft', 'KLy_ft', 'y_segments'];
var AXIAL_LOAD_FORMS = { column_capacity: 'check', tension_capacity: 'check', column_select: 'always', tension_select: 'always', tension_required_area: 'always' };
function boxAt(stage, path) { var i; for (i = 0; i < (stage.boxes || []).length; i++) if (stage.boxes[i].path === path) return stage.boxes[i]; return null; }
function lastOkRun(part) { var run = part && part.ui && part.ui.run; return run && run.ok && run.stages.length ? run.stages[run.stages.length - 1] : null; }
function numValue(res, key) { var v = res && res.values ? res.values[key] : null; return v && isNum(v.value) ? v.value : null; }
/* May the page offer "Use <shape> here" (a shape an EARLIER part chose) in this box?  Only where the form cannot run without a shape.
   In a floor plan the two size boxes are "ONLY if the problem gives it": the worksheet picks the beam and the girder itself, and the offered button put the BEAM
   chosen in part (c) into the GIRDER's box of parts (e) to (g) ("Girder size given: W18X35 -> NOT ADEQUATE" where the girder is W24X55).  Found 10/06 in the mock
   floor plan: with nothing pressed the page was right, with the offered button pressed it was wrong, and the operator is told to match words, never to judge. */
SOLVE.offersEarlierShape = function (stage, b) {
  if (!stage || !b) return false;
  if (stage.fn === 'floor_plan') return false;
  return !!(b.required || b.reqGroup);
};
SOLVE.carryAcross = function (parts, idx, vals) {
  var part = parts[idx], out = [], si, st, j, sj, b, k, src, last, v, ps, pv, allEmpty, any;
  if (!part || !part.stages || !vals) return out;
  function same(a, c) { return JSON.stringify(a) === JSON.stringify(c); }
  function mineStill(si2, b2) { var was = vals[si2]['_fromval:' + b2.path]; return was !== undefined && same(vals[si2][b2.path], was) && !vals[si2]['_picked:' + b2.path]; }
  function canSet(si2, b2) { return b2.state !== 'carried' && (isEmptyUi(b2, vals[si2][b2.path]) || mineStill(si2, b2)); }
  function put(si2, b2, uiVal, fromLabel) {
    vals[si2][b2.path] = uiVal; vals[si2]['_from:' + b2.path] = fromLabel; vals[si2]['_fromval:' + b2.path] = clone(uiVal);
    out.push({ si: si2, path: b2.path, label: b2.label, show: showValue(b2, uiVal), fromLabel: fromLabel });
  }
  /* the earlier part no longer has the number: take our own value back out (never one he typed) */
  function unput(si2, b2) {
    if (vals[si2]['_from:' + b2.path] === undefined) return;
    if (mineStill(si2, b2)) vals[si2][b2.path] = b2.kind === 'list' ? [] : '';
    delete vals[si2]['_from:' + b2.path]; delete vals[si2]['_fromval:' + b2.path];
  }
  function labelOf(p, n) { return p.label || String(n + 1); }
  for (si = 0; si < part.stages.length; si++) {
    st = part.stages[si];
    if (!st.boxes || !vals[si]) continue;

    /* 1. the moment a beam is checked against */
    b = st.fn === 'beam_capacity' ? boxAt(st, 'Mu') : null;
    if (b && b.reqGroup === 'load') {
      src = null;
      for (j = idx - 1; j >= 0 && !src; j--) { last = lastOkRun(parts[j]); v = last ? numValue(last.res, 'Mu') : null; if (v !== null) src = { value: v, label: labelOf(parts[j], j) }; }
      if (src) { if (canSet(si, b)) put(si, b, fmtNum(src.value), src.label); }
      else unput(si, b);
    }

    /* 2. the factored axial load a column or a tension member is checked against, or selected for */
    b = has(AXIAL_LOAD_FORMS, st.fn) ? boxAt(st, 'Pu') : null;
    if (b && b.state !== 'carried' && (AXIAL_LOAD_FORMS[st.fn] === 'always' || b.reqGroup === 'load')) {
      allEmpty = true;
      ['D', 'L', 'Pu'].forEach(function (n) { var bx = boxAt(st, n); if (bx && !isEmptyUi(bx, vals[si][n]) && !(n === 'Pu' && mineStill(si, bx))) allEmpty = false; });
      src = null;
      for (j = idx - 1; j >= 0 && !src; j--) {
        last = lastOkRun(parts[j]);
        if (!last) continue;
        v = last.fn === 'loads_combinations' ? numValue(last.res, 'U_max') : (last.fn === 'loads_takedown' ? numValue(last.res, 'Pu_bottom') : (has(AXIAL_LOAD_FORMS, last.fn) ? numValue(last.res, 'Pu') : null));
        if (v !== null) src = { value: v, label: labelOf(parts[j], j) };
      }
      if (src && allEmpty) {
        put(si, b, fmtNum(src.value), src.label);
        k = boxAt(st, 'already_factored');
        if (k && canSet(si, k)) put(si, k, 'yes', src.label);
      } else if (!src) { unput(si, b); k = boxAt(st, 'already_factored'); if (k) unput(si, k); }
    }

    /* 3. the same column in a later part: its lengths and end conditions (all of them or none, never a mix of two parts) */
    if (st.fn === 'column_select' || st.fn === 'column_capacity') {
      allEmpty = true;
      COLUMN_LENGTHS.forEach(function (n) { var bx = boxAt(st, n); if (bx && !isEmptyUi(bx, vals[si][n]) && !mineStill(si, bx)) allEmpty = false; });
      src = null;
      for (j = idx - 1; j >= 0 && !src && allEmpty; j--) {
        ps = parts[j].stages || []; pv = parts[j].ui && parts[j].ui.vals;
        for (sj = ps.length - 1; sj >= 0 && !src && pv; sj--) {
          if ((ps[sj].fn !== 'column_select' && ps[sj].fn !== 'column_capacity') || !ps[sj].boxes || !pv[sj]) continue;
          any = false;
          COLUMN_LENGTHS.forEach(function (n) { var bx = boxAt(ps[sj], n); if (bx && !isEmptyUi(bx, pv[sj][n])) any = true; });
          if (any) src = { stage: ps[sj], vals: pv[sj], label: labelOf(parts[j], j) };
        }
      }
      if (src) {
        COLUMN_GEOMETRY.concat(['Fy']).forEach(function (n) {
          var bx = boxAt(st, n), sx = boxAt(src.stage, n);
          if (!bx || !sx || isEmptyUi(sx, src.vals[n])) { if (bx && n !== 'Fy' && mineStill(si, bx)) unput(si, bx); return; }
          if (canSet(si, bx)) put(si, bx, clone(src.vals[n]), src.label);
        });
      } else if (allEmpty) COLUMN_GEOMETRY.concat(['Fy']).forEach(function (n) { var bx = boxAt(st, n); if (bx) unput(si, bx); });
    }

    /* 4. (10/07) the same FLOOR in a later part: where the beam stands and from how many sides beams reach the girder.  Part (a) says "a typical beam"
       and the page reads "interior"; parts (b) to (f) -- "Mu of the beam", "Most economical girder" -- say nothing about it again, and each of them
       stopped to ask (another lab's six-part floor plan: one part answered, five asked the same thing).  Only these two choices are carried: they are
       facts of the plan, not numbers of a part. */
    if (st.fn === 'floor_plan') {
      ['beam_position', 'girder_beam_sides'].forEach(function (n) {
        var bx = boxAt(st, n), found = null, j2, sj2, ps2, pv2, sx2;
        if (!bx) return;
        for (j2 = idx - 1; j2 >= 0 && !found; j2--) {
          ps2 = parts[j2].stages || []; pv2 = parts[j2].ui && parts[j2].ui.vals;
          for (sj2 = ps2.length - 1; sj2 >= 0 && !found && pv2; sj2--) {
            if (ps2[sj2].fn !== 'floor_plan' || !ps2[sj2].boxes || !pv2[sj2]) continue;
            sx2 = boxAt(ps2[sj2], n);
            if (sx2 && !isEmptyUi(sx2, pv2[sj2][n])) found = { val: pv2[sj2][n], label: labelOf(parts[j2], j2) };
          }
        }
        if (found) { if (canSet(si, bx)) put(si, bx, clone(found.val), found.label); }
        else unput(si, bx);
      });
    }
  }
  return out;
};

/* ------------------------------------------------------------------------------------------------ word questions: the order-free matcher
   src/wordsx.js matches a question against her stored sentences by which words occur, never by their order, with everyday words mapped to hers
   ("stiffness" -> modulus of elasticity).  It is started once, with the calculator's glossary and the extra entries of 10/07. */
var WX_READY = false;
function wordsx() {
  var W = typeof WORDSX !== 'undefined' ? WORDSX : null, r0, G, X;
  if (!W || typeof W.analyze !== 'function') return null;
  if (!WX_READY) {
    r0 = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    G = (r0.STEEL_DATA && r0.STEEL_DATA.glossary) || []; X = r0.STEEL_GLOSSARY_EXTRA || [];
    try { W.init(G, X); WX_READY = true; } catch (e) { return null; }
  }
  return W;
}
function wxAnalyze(text) { var W = wordsx(); if (!W) return null; try { return W.analyze(String(text === undefined || text === null ? '' : text)); } catch (e) { return null; } }
function clipSentence(s) { var t = collapse(s); return t.length > 620 ? t.slice(0, 600).replace(/\s+\S*$/, '') + ' ...' : t; }
/* WHAT AN OPEN WORD QUESTION PRINTS (all three councils, 10/06 night: a letter or a term only on a unique hit; otherwise at most three of her sentences
   under "the page does not choose"; never a guess).  Before this the page printed whatever entry had its NAME in the question as "ANSWER" -- for "What
   is E, its value and its units for structural steel?" her sentence on what steel is made of.
     keep     the look-up by name and the matcher agree, or the matcher has nothing: the block stays as it was
     replace  the matcher's one clear entry as the ANSWER (her words), or her three nearest sentences with no ANSWER at all
   -> { mode, lines, sources } or null */
function wordAnswer(part, res) {
  var wx = part.wx, lines = [], src = [], eng = res && res.ok && !res.wxOnly && res.values && res.values.term ? String(res.values.term.value) : null, hits, first, i, n;
  if (!wx) return null;
  hits = wx.hits || [];
  /* a bare list of choices ("... identifies: modulus, yield strength, ultimate strength, or hardness?"): the one her sentences support, in its own words */
  if (wx.mc && wx.mc.pick && !String(wx.mc.pick.ch || '')) {
    lines.push('ANSWER: ' + wx.mc.pick.text + '   (her sentence for "' + wx.mc.pick.term + '": "' + clipSentence(wx.mc.pick.sentence) + '")');
    return { mode: 'replace', lines: lines, sources: src };
  }
  first = wx.top ? wx.top.term : (hits.length ? hits[0].term : null);
  if (eng && (!first || first === eng)) return { mode: 'keep', lines: [], sources: [] };
  /* the entry NAMED in the question is also one of the matcher's three nearest, and the matcher has no single clear entry: two readers point at it.
     It stays the ANSWER; her other near sentences follow it.  (The mock's "why does the number of bolts in the line change the capacity?": the look-up
     by name gave her shear-lag sentence, which is right; the matcher ranked it third.) */
  if (eng && !wx.top && hits.slice(0, 3).some(function (h) { return h.term === eng; })) {
    lines.push('HER OTHER SENTENCES NEAR THIS (the page does not choose between them; use one only if it answers your question better):');
    n = 0;
    for (i = 0; i < hits.length && n < 2; i++) { if (hits[i].term === eng) continue; n++; lines.push(n + '. ' + hits[i].term + ': "' + clipSentence(hits[i].sentence) + '"'); }
    return { mode: 'keep', lines: n ? lines : [], sources: [] };
  }
  if (wx.top) {
    lines.push('ANSWER: ' + wx.top.term + ': "' + clipSentence(wx.top.sentence) + '"');
    if (wx.top.source) src.push(wx.top.term + ': ' + collapse(wx.top.source));
    if (eng && eng !== wx.top.term) lines.push('ALSO FOUND (its name is in your question; it may not be what is asked): ' + answerLine(res));
    return { mode: 'replace', lines: lines, sources: src };
  }
  if (hits.length) {
    lines.push('HER SENTENCES ABOUT THIS -- the page does not choose. Read them, and copy the one that answers your question:');
    n = Math.min(3, hits.length);
    for (i = 0; i < n; i++) { lines.push((i + 1) + '. ' + hits[i].term + ': "' + clipSentence(hits[i].sentence) + '"'); if (hits[i].source) src.push((i + 1) + '. ' + collapse(hits[i].source)); }
    if (eng && !hits.slice(0, n).some(function (h) { return h.term === eng; })) lines.push((n + 1) + '. (its name is in your question) ' + answerLine(res));
    return { mode: 'replace', lines: lines, sources: src };
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------ the printed result: WRITE THIS, READ THIS */
function answerLine(res) {
  var a = res.answer, text, hasDigit, tail;
  if (!a) return '';
  text = collapse(a.text || '');
  hasDigit = /\d/.test(text);
  if (isNum(a.value) && !hasDigit) text = text + ' [' + a.value + (a.unit ? ' ' + a.unit : '') + ']';
  /* "Her definition: Yield strength" + "Yield strength: ..." would say the term twice */
  tail = a.label ? String(a.label).split(': ').pop() : '';
  if (tail && text.toLowerCase().indexOf(tail.toLowerCase()) === 0) return text;
  return (a.label ? a.label + ': ' : '') + text;
}
function flagKind(t) { return /^WARNING/i.test(t) ? 'warning' : (/^CHECK/i.test(t) ? 'check' : 'note'); }
SOLVE.flagKind = flagKind;

/* word questions with a list of choices (a. b. c. d.): which choice has the matched term in it */
function choicesOf(text) {
  var re = /(?:^|\s)\(?([a-e])[.)]\s+/g, marks = [], m, next = 'a', out = [], i, e, from, re2;
  text = String(text === undefined || text === null ? '' : text);
  while ((m = re.exec(text)) !== null) {
    if (m[1] === next) { marks.push({ ch: m[1], at: m.index + m[0].length, start: m.index }); next = String.fromCharCode(next.charCodeAt(0) + 1); }
  }
  if (marks.length < 2) {
    /* the May 2024 final prints its choices as a bare letter and the words, no dot and no bracket ("(choose one): a the modulus of elasticity b the allowable
       deflection c ..."): after a "choose one" (or the colon that ends the question) the letters a, b, c ... standing alone, in order, are the marks */
    m = MC_RE.exec(text) || /\bis\s*:|\bare\s*:|\bcalled\s*:/i.exec(text);
    if (!m) return [];
    from = m.index + m[0].length;
    /* first the letters that START a line (he types one choice per line, as the paper prints them): "c Overall depth d" then "d Radius of gyration r" */
    marks = []; next = 'a';
    re2 = /(?:^|\n)[ \t]*([a-e])[ \t]*[.)]?(?=[ \t]*\n|[ \t]+\S)/g; re2.lastIndex = from;
    while ((m = re2.exec(text)) !== null) {
      if (m[1] === next) { marks.push({ ch: m[1], at: m.index + m[0].length, start: m.index }); next = String.fromCharCode(next.charCodeAt(0) + 1); }
    }
    if (marks.length < 3) {
      /* all on one line: bare letters in order.  "... Overall depth d d Radius of gyration r": a letter followed by the same letter is the END of the choice before */
      marks = []; next = 'a';
      re2 = /(?:^|\s)([a-e])(?=\s+\S)/g; re2.lastIndex = from;
      while ((m = re2.exec(text)) !== null) {
        if (m[1] !== next) continue;
        if (new RegExp('^\\s+' + next + '\\s+\\S').test(text.slice(m.index + m[0].length))) continue;
        marks.push({ ch: m[1], at: m.index + m[0].length, start: m.index }); next = String.fromCharCode(next.charCodeAt(0) + 1);
      }
    }
    if (marks.length < 3) return [];
  }
  for (i = 0; i < marks.length; i++) {
    e = i + 1 < marks.length ? marks[i + 1].start : text.length;
    /* the answer blank that follows the last choice ("W____x____", "Answer: ____") is not part of it */
    out.push({ ch: marks[i].ch, text: trim(text.slice(marks[i].at, e).replace(/\s+\S*_{2,}[\s\S]*$/, '').replace(/\s*\banswer\s*:?\s*$/i, '')), start: marks[i].start });
  }
  return out;
}
/* the question of a multiple-choice question: the text before its first choice, without the "(choose one)" */
function mcStem(text, ch) {
  var t = String(text || ''), end = ch && ch.length ? ch[0].start : t.length;
  return trim(t.slice(0, end).replace(MC_RE, ' ').replace(/[\s:]+$/, ''));
}
SOLVE.mcStem = mcStem;
/* COUNCIL 2026-10-06, all three members: a letter is printed only when HER OWN WORDING supports exactly one choice -- never because a word of the question also
   stands in a choice (that printed "a" where the answer was "d" on the real 2024 final).  Two kinds of support:
     1. the question asks what a SYMBOL is ("... in which E is (choose one)"), and her entry for that symbol is one of the choices;
     2. the question IS one of her definitions, nearly word for word ("the ratio of stress to strain in the elastic range is called"), and the term so defined
        is one of the choices.
   Otherwise nothing is chosen: { best: null }.  Returns { stem, choices, best: {ch, text}|null, why, kind } or null when the text has no choices. */
var MC_SYMBOL_RE = /(?:\bin\s+which|\bwhere(?:in)?|\bthe\s+(?:term|symbol|letter|variable|factor|quantity)|\bwhat\s+(?:is|does))\s+(?:the\s+)?(phi|[A-Za-z]{1,3}(?:\/[a-z])?)\s+(?:is|are|means?|stands?\s+for|represents?|denotes?|refers\s+to)\b/;
var MC_SYMBOL_END_RE = /(?:^|[\s,(])(phi|[A-Za-z]{1,3}(?:\/[a-z])?)\s+(?:is|means|stands\s+for|represents|denotes|refers\s+to)\s*$/;
function termWords(term) { return contentWords(String(term).replace(/\([^)]*\)/g, ' ').replace(/=\s*[\d,.]+\s*\w*/g, ' ')); }
function choiceFitsTerm(choiceText, term) {
  var cw = contentWords(choiceText).map(stemOf), tw = termWords(term).map(stemOf), i;
  if (!cw.length || !tw.length) return false;
  for (i = 0; i < cw.length; i++) if (tw.indexOf(cw[i]) < 0) return false;       /* every word of the choice is in the name of her entry */
  return true;
}
SOLVE.choicePick = function (partText) {
  var root3 = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}), G = (root3.STEEL_DATA && root3.STEEL_DATA.glossary) || [],
    text = String(partText || ''), ch = choicesOf(text), stem, m, sym, i, j, e, hits, fits, out, sw, best, bestScore, secondScore, q, n, last, names;
  if (ch.length < 2) return null;
  stem = mcStem(text, ch);
  out = { stem: stem, choices: ch, best: null, why: '', kind: null };
  /* 1. what a symbol is */
  m = MC_SYMBOL_RE.exec(stem) || MC_SYMBOL_END_RE.exec(stem);
  sym = m ? m[1] : null;
  if (sym) {
    fits = {}; names = {};
    for (i = 0; i < G.length; i++) {
      e = G[i];
      /* her entry is FOR this symbol: its name ends with it ("Radius of gyration r", "Moment of inertia I"), or holds it in brackets ("Yield point (Fy)",
         "... (E = 29,000 ksi)").  Single letters must match in case (r is not R, d is not D). */
      last = String(e.term).replace(/\([^)]*\)\s*$/, '').replace(/\s+$/, '').split(/\s+/).pop();
      hits = last === sym || new RegExp('\\(\\s*' + sym.replace(/[\/]/g, '\\/') + '(?:\\s*=[^)]*)?\\s*\\)').test(String(e.term));
      if (!hits) continue;
      for (j = 0; j < ch.length; j++) if (choiceFitsTerm(ch[j].text, e.term)) { fits[ch[j].ch] = ch[j]; names[ch[j].ch] = e.term; }
    }
    hits = Object.keys(fits);
    /* REVIEW 10/06: E is the modulus of elasticity AND the earthquake load; S a section modulus AND the snow load.  When more than one CHOICE is a known meaning
       of the symbol, the question's context decides, and the page does not read context: no letter.  ("In ASCE 7 load combinations, the load E is" got "a".) */
    var MULTI = { E: ['modulus elasticity', 'earthquake', 'seismic'], S: ['section modulus', 'snow'], L: ['live', 'length', 'span'], D: ['dead', 'depth', 'diameter'], W: ['wind', 'weight'],
      R: ['rain', 'reaction', 'resistance'], U: ['shear lag', 'factored', 'ultimate', 'required strength'], K: ['effective length'], A: ['area'], I: ['moment inertia', 'importance'] }, mm = 0;
    if (has(MULTI, sym)) {
      for (j = 0; j < ch.length; j++) {
        var cwj = contentWords(ch[j].text).map(stemOf).concat(String(ch[j].text).toLowerCase().split(/[^a-z]+/));
        if (MULTI[sym].some(function (ph) { return ph.split(' ').every(function (w) { return cwj.indexOf(stemOf(w)) >= 0 || cwj.indexOf(w) >= 0; }); })) mm++;
      }
      if (mm > 1) return out;
    }
    if (hits.length === 1) { out.best = fits[hits[0]]; out.kind = 'symbol'; out.why = 'your question asks what "' + sym + '" is, and her entry for it is "' + names[hits[0]] + '"'; return out; }
  }
  /* 2. the question is one of her definitions, nearly word for word */
  sw = contentWords(stem).map(stemOf).filter(function (w, k, a) { return w.length >= 4 && a.indexOf(w) === k; });
  if (sw.length >= 3) {
    best = null; bestScore = 0; secondScore = 0;
    for (i = 0; i < G.length; i++) {
      e = G[i];
      q = contentWords((e.definitions || []).map(function (d) { return d.quote; }).join(' ')).map(stemOf);
      n = 0; for (j = 0; j < sw.length; j++) if (q.indexOf(sw[j]) >= 0) n++;
      if (n > bestScore) { secondScore = bestScore; bestScore = n; best = e; } else if (n > secondScore) secondScore = n;
    }
    if (best && bestScore >= 3 && bestScore >= Math.ceil(sw.length * 0.7) && bestScore > secondScore) {
      fits = [];
      for (j = 0; j < ch.length; j++) if (choiceFitsTerm(ch[j].text, best.term)) fits.push(ch[j]);
      if (fits.length === 1) { out.best = fits[0]; out.kind = 'definition'; out.why = 'your question is her own definition of "' + best.term + '"'; return out; }
    }
  }
  return out;
};
function normTerm(s) { return String(s).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, ''); }
/* A multiple-choice word question: every choice with HER entry for it (when she has one), and the words that entry shares with the question's own sentence.
   Nothing is chosen for him: he reads the four wordings next to his question.  Returns { stem, list: [{ch, text, found, entry, shared: [words]}] } or null. */
var CHOICE_STOP = ' the a an of in to and or is are it its that this what which when where with without for from by be as at on not no can will would should than then also each every any all some called term following answer name known defined definition does have has was were been being into their there these those such very more most much many only other about above below between both during after before under over same so if but stress stresses material materials steel member members load loads structural structure value values point given ';
function contentWords(s) {
  var w = String(s).toLowerCase().replace(/w\/o/g, ' without ').replace(/[^a-z0-9]+/g, ' ').split(' '), out = [], i, x;
  for (i = 0; i < w.length; i++) { x = w[i]; if (x.length < 4 || CHOICE_STOP.indexOf(' ' + x + ' ') >= 0) continue; out.push(x); }
  return out;
}
function stemOf(word) { return word.replace(/(?:ations?|ation|ments?|ently|ent|ness|ing|ed|ly|es|s)$/, '').slice(0, 7); }
SOLVE.choiceTable = function (partText) {
  var E = env(), text = String(partText || ''), ch = choicesOf(text), stem, stemWords, seen, list = [], i, c, r, entry, words, shared, k, st;
  if (ch.length < 2) return null;
  stem = mcStem(text, ch);
  stemWords = contentWords(stem);
  for (i = 0; i < ch.length; i++) {
    c = trim(String(ch[i].text).replace(/\s*answer\s*:?\s*_*\s*$/i, '').replace(/[_\s.;,]+$/, ''));
    if (!c) continue;
    r = null;
    try { r = E.STEEL.run('lookup_definition', { query: c }); } catch (e) { r = null; }
    entry = r && r.ok && r.answer ? String(r.answer.text) : '';
    shared = []; seen = {};
    if (entry) {
      words = contentWords(entry.replace(/\([^)]*\)\s*$/, ''));
      for (k = 0; k < stemWords.length; k++) {
        st = stemOf(stemWords[k]);
        if (seen[st] || st.length < 4) continue;
        if (words.some(function (w) { return stemOf(w) === st; }) && contentWords(c).every(function (w) { return stemOf(w) !== st; })) { seen[st] = 1; shared.push(stemWords[k]); }
      }
    }
    list.push({ ch: ch[i].ch, text: c, found: !!entry, entry: entry, shared: shared });
  }
  return list.length >= 2 ? { stem: trim(stem), list: list } : null;
};
SOLVE.choiceCheck = function (partText, res) {
  var ch = choicesOf(partText), term, hits = [], i, c;
  if (!ch.length || !res || !res.ok || !res.values || !res.values.term) return null;
  term = normTerm(res.values.term.value);
  for (i = 0; i < ch.length; i++) {
    c = normTerm(ch[i].text).replace(/^(?:the|an?)\s+/, '');
    if (c && term && (c === term || term.indexOf(c) === 0 || c.indexOf(term) === 0)) hits.push(ch[i]);
  }
  return hits.length === 1 ? hits[0] : null;
};

/* run = the result of runPart.  Returns { write, read, other, given, ok } as plain text lines. */
SOLVE.writeBlock = function (part, run, vals) {
  var write = [], read = [], other = [], given = [], sources = [], head, si, sr, res, i, k, st, lines, multi = run.stages.length > 1, e, ch, ack, b;
  head = 'WRITE THIS' + (part.label ? '   (' + part.label + ')' : '');
  write.push(head);
  for (si = 0; si < run.stages.length; si++) {
    sr = run.stages[si]; res = sr.res; st = part.stages[si];
    if (multi) write.push('Step ' + (si + 1) + ' of ' + part.stages.length + ': ' + (st && st.form ? st.form.label : sr.fn));
    if (sr.skipped) { read.push('NOT RUN: ' + sr.skipped); continue; }
    if (!res.ok) {
      e = res.error || {};
      read.push('NO ANSWER from ' + (st && st.form ? st.form.label : sr.fn) + ' (' + (e.code || '?') + '): ' + (e.message || ''));
      continue;
    }
    if (sr.note) write.push(sr.note);
    /* (10/07) an open word question: what the order-free matcher found, beside (or in place of) the look-up by name -- see wordAnswer */
    var wa = null;
    if (part.kind === 'words' && !part.mc && !(vals && vals[si] && vals[si]['_picked:query'])) { try { wa = wordAnswer(part, res); } catch (eWA) { wa = null; } }
    if (wa && wa.mode === 'replace') {
      for (i = 0; i < wa.lines.length; i++) write.push(wa.lines[i]);
      for (i = 0; i < (wa.sources || []).length; i++) sources.push(wa.sources[i]);
      continue;
    }
    for (i = 0; i < res.steps.length; i++) {
      write.push((i + 1) + '. ' + collapse(res.steps[i].text));
      if (res.steps[i].source) sources.push((multi ? 'step ' + (si + 1) + ', ' : '') + 'line ' + (i + 1) + ': ' + collapse(res.steps[i].source));
    }
    write.push('ANSWER' + (multi ? ' (step ' + (si + 1) + ')' : '') + ': ' + answerLine(res));
    if (wa && wa.mode === 'keep' && wa.lines && wa.lines.length) for (i = 0; i < wa.lines.length; i++) write.push(wa.lines[i]);
    if (part.kind === 'words' && part.mc) {
      /* a multiple-choice question: the letter, and only when her own wording supports exactly one choice (or he chose one himself) */
      var pickedHere = !!(vals && vals[si] && vals[si]['_picked:query']);
      ch = SOLVE.choiceCheck(part.text, res);
      if (part.mc.best && !pickedHere) write.push('CIRCLE: ' + part.mc.best.ch + '. ' + part.mc.best.text + '   (' + part.mc.why + ')');
      else if (ch && pickedHere) write.push('Your own choice: ' + ch.ch + '. ' + ch.text + '   (you picked it; the lines above are her wording for it)');
      else {
        write.length = 1;
        write.push('NO LETTER FROM THE PAGE. ' + (part.mc.twoLetters ? 'Two of the page\'s rules point to two different choices, so it gives none.' : 'Her wording does not single out one of the choices, and the page does not guess a letter.'));
        write.push('Read each choice next to her wording for it (the table above). If nothing decides it, circle any one of them: a blank scores nothing.');
        /* (10/07) her sentences that share the question's words, to match against the choices by eye */
        if (part.wx && part.wx.hits && part.wx.hits.length) {
          write.push('HER SENTENCES ABOUT THIS -- the page does not choose:');
          for (i = 0; i < part.wx.hits.length && i < 3; i++) write.push((i + 1) + '. ' + part.wx.hits[i].term + ': "' + clipSentence(part.wx.hits[i].sentence) + '"');
        }
      }
    } else if (part.kind === 'words') {
      ch = SOLVE.choiceCheck(part.text, res);
      if (ch) write.push('Your choice: ' + ch.ch + '. ' + ch.text + '   (the term above is the one in your choice ' + ch.ch + ')');
    }
    for (i = 0; i < (res.flags || []).length; i++) read.push(res.flags[i]);
    /* the question asks for the answer in kip-in (or kip-ft) and the calculator answers in the other one: say so, he must convert before he writes it */
    (function () {
      var ask = String(part.route && part.route.question ? part.route.question : part.text).toLowerCase(), u = res.answer && res.answer.unit;
      var wantIn = /kip\s*-?\s*in\b|\bk\s*-\s*in\b|in\s*-\s*kips?\b/.test(ask), wantFt = /kip\s*-?\s*ft\b|\bk\s*-\s*ft\b|ft\s*-\s*kips?\b/.test(ask);
      if (wantIn && !wantFt && u === 'kip-ft') read.push('CHECK: your question asks for kip-in, but the calculator\'s answer is in kip-ft. Convert it before you write it (kip-in = kip-ft x 12; the Units form of the calculator does it).');
      if (wantFt && !wantIn && u === 'kip-in') read.push('CHECK: your question asks for kip-ft, but the calculator\'s answer is in kip-in. Convert it before you write it (kip-ft = kip-in / 12).');
    })();
    if (res.key_values && res.key_values.length) {
      for (k = 0; k < res.key_values.length; k++) other.push(res.key_values[k].label + ' = ' + (typeof res.key_values[k].value === 'number' ? fmtNum(res.key_values[k].value) : res.key_values[k].value) + (res.key_values[k].unit ? ' ' + res.key_values[k].unit : ''));
    }
    if (part.kind !== 'words' && res.alternatives && res.alternatives.length) {
      for (k = 0; k < res.alternatives.length; k++) other.push('other route: ' + res.alternatives[k].label + (isNum(res.alternatives[k].value) ? ' = ' + fmtNum(res.alternatives[k].value) + (res.alternatives[k].unit ? ' ' + res.alternatives[k].unit : '') : '') + (res.alternatives[k].text ? '  (' + collapse(res.alternatives[k].text) + ')' : ''));
    }
    if (part.kind === 'words' && res.alternatives && res.alternatives.length) {
      for (k = 0; k < res.alternatives.length; k++) other.push('also matched: ' + res.alternatives[k].label);
    }
    /* what he confirmed */
    if (st && st.boxes && vals && vals[si]) {
      for (k = 0; k < st.boxes.length; k++) {
        b = st.boxes[k];
        if (b.state === 'carried') { if (sr.carry && has(sr.carry, b.path) && b.path !== 'already_factored') given.push(b.label + ' = ' + sr.carry[b.path] + (b.unit ? ' ' + b.unit : '') + '   (carried from step ' + si + ')'); continue; }
        if (!isEmptyUi(b, vals[si][b.path])) given.push((multi ? 'step ' + (si + 1) + ': ' : '') + b.label + ' = ' + showValue(b, vals[si][b.path]));
      }
    }
  }
  /* the answer blank of the question: the asked quantity in a line of its own when the form gives it on the way; a plain warning when it does not give it at all */
  var al = [], ai, mainAsked = false, lastFnW = part.stages && part.stages.length ? part.stages[part.stages.length - 1].fn : null;
  try { al = askedLines(part, run); } catch (eA) { al = []; }
  (part.asked || []).forEach(function (b) { if (lastFnW && sigGives(lastFnW, b.id) === 2) mainAsked = true; });
  /* (a floor plan's own ANSWER line is a summary of the worksheet -- beam, girder, reaction -- never the one number a blank asks for) */
  /* asked in a sentence, with no blank: the form's own result loses the word ANSWER only when NOTHING in the question asks for a strength ("Determine the
     design tensile strength. Report An, U and Ae" asks for all four -- the regression dump of 10/07 01:00 caught the strength being marked "not asked") */
  var allProse = (part.asked || []).length > 0 && (part.asked || []).every(function (b) { return b.prose; })
    && !STRENGTH_ASK.test(String(part.ctx || '').slice(part.coverLen || 0) || String(part.text || ''));
  /* (unit D: a part that asks only for the THEORETICAL K never has the design K as its answer, however many blanks it has) */
  if ((al.length || part.theoOnly) && ((part.blankCount || 0) === 1 || allProse || part.theoOnly) && (!mainAsked || lastFnW === 'floor_plan')) {
    /* council 10/06: one answer to copy.  The form's own result is not what the blank asks, so it must not carry the word ANSWER. */
    for (ai = 0; ai < write.length; ai++) if (/^ANSWER(?: \(step \d+\))?: /.test(write[ai])) write[ai] = write[ai].replace(/^ANSWER(?: \(step \d+\))?: /, 'ALSO FOUND (your blank does not ask for this): ');
  }
  for (ai = 0; ai < al.length; ai++) write.push(al[ai]);
  /* the shape the page chose is not of the family the blank names: its own ANSWER line must not carry the word ANSWER either */
  if (part.familyMismatch && run.ok) for (ai = 0; ai < write.length; ai++) if (/^ANSWER(?: \(step \d+\))?: /.test(write[ai])) write[ai] = write[ai].replace(/^ANSWER(?: \(step \d+\))?: /, 'FOUND, BUT NOT IN THE FAMILY YOUR BLANK NAMES: ');
  /* REVIEW 4 / the outside exams: a blank whose NAME the page does not know ("Excess capacity = ____ kips", "KxLx/rx = ____").  The page cannot tell
     whether its answer is what that blank asks, and it printed its usual ANSWER line beside it (877 kips of strength for a blank asking for the 189 kips
     of excess).  It says so, in the place where he copies from. */
  var ub = (part.unknownBlanks || []).filter(function (r0) { return /[A-Za-z]{2}/.test(String(r0).replace(/_+/g, ' ')); });
  /* Zack, 10/06 19:40, on the first question he tried that the page had never seen: part (d) "Is the column adequate for the load? ____".  The page HAD
     worked the verdict out -- it stood at the far end of a long ANSWER line -- and printed under it that it did not know what the blank asked.  He could not
     tell whether the page had solved the question.  A YES / NO blank about adequacy now gets an answer line of its own, from the calculator's own verdict. */
  /* NARROW on purpose (the second model's review of this change, taken): the blank must be a QUESTION, with no "=" and no unit after it, that names adequacy
     itself ("Is the column adequate for the load? ____", "Can the beam carry the load? ____"), or a bare yes / no marker under a part that asks such a
     question ("Is the column adequate? (yes or no) ____").  "The adequacy factor is ____" and "Acceptable load = ____ kips" want a number and get no YES. */
  function adeqBlank(raw) {
    var t = String(raw), bits = t.split(/_{2,}/), before = trim(bits[0] || ''), after = trim(bits.slice(1).join(' ')), own = String(part.text || '');
    /* (10/07) what follows the blank after a full stop belongs to the NEXT blank of the line ("Is it adequate? ____. phi Pn = ____ kips"): it says nothing
       about this one.  A unit straight after the blank still means a number is wanted. */
    if (/^[.;,]/.test(after)) { after = ''; t = before + ' ____'; }
    if (/=/.test(t)) return false;
    if (after && !/^\(?\s*(?:yes|no|y\s*\/\s*n|ok|n\.?g\.?|circle)\b/i.test(after)) return false;
    if (/^(?:\(?[a-h1-9][.)]\s*)?(?:is|are|does|do|can|could|will|would|should)\b/i.test(before) && /\?/.test(before)
      && /\b(?:adequa\w+|sufficient|satisfactory|acceptable|safe(?:ly)?|strong\s+enough|ok(?:ay)?|o\.k\.|work|pass|carry|support|hold)\b/i.test(before)) return true;
    if (/^\(?\s*(?:yes|y)\s*(?:or|\/|,)?\s*(?:no|n)\s*\)?\s*:?$/i.test(before) || /^\(?\s*ok\s*(?:or|\/)\s*n\.?g\.?\s*\)?\s*:?$/i.test(before) || (!before && /^\(?\s*(?:yes|ok)\b/i.test(after)))
      return ADEQ_RE.test(own) && /\?/.test(own);
    return false;
  }
  var lastSt = run.ok && run.stages && run.stages.length ? run.stages[run.stages.length - 1] : null, lv = lastSt && lastSt.res && lastSt.res.values ? lastSt.res.values : null, verdict = null;
  if (lv && lv.adequate && typeof lv.adequate.value === 'boolean') {
    var capK = lv.phiPn ? ['phi Pn', lv.phiPn] : (lv.capacity ? ['phi Pn', lv.capacity] : (lv.phiMn ? ['phi Mn', lv.phiMn] : (lv.phiMp ? ['phi Mn', lv.phiMp] : null))),
      demV = lv.Pu ? ['Pu', lv.Pu.value, lv.Pu.unit] : (lv.Mu ? ['Mu', lv.Mu.value, lv.Mu.unit] : (lastSt.args && lastSt.args.Mu !== undefined && lastSt.args.Mu !== null && lastSt.args.Mu !== '' ? ['Mu', Number(lastSt.args.Mu), 'kip-ft'] : null));
    verdict = (lv.adequate.value ? 'YES' : 'NO') + (capK && demV && isFinite(Number(capK[1].value)) && isFinite(Number(demV[1]))
      ? '   (' + capK[0] + ' = ' + sigNum(Number(capK[1].value)) + (capK[1].unit ? ' ' + capK[1].unit : '') + (lv.adequate.value ? ' is at least ' : ' is LESS than ') + demV[0] + ' = ' + sigNum(Number(demV[1])) + (demV[2] ? ' ' + demV[2] : '') + ')' : '');
  }
  if (verdict && !part.askedMismatch && !part.familyMismatch) {
    var ubRest = [], adeqN = 0;
    ub.forEach(function (r0) {
      if (adeqBlank(r0)) { write.push('ANSWER FOR YOUR BLANK (' + r0 + '): ' + verdict); adeqN++; }
      else ubRest.push(r0);
    });
    ub = ubRest;
    /* the part's ONE blank is the yes / no: the strength line above it is then not the answer to copy (the same rule as for a known blank) */
    if (adeqN && (part.blankCount || 0) === 1) for (ai = 0; ai < write.length; ai++) if (/^ANSWER(?: \(step \d+\))?: /.test(write[ai])) write[ai] = write[ai].replace(/^ANSWER(?: \(step \d+\))?: /, 'ALSO FOUND (your blank does not ask for this): ');
  }
  if (run.ok && ub.length && !part.askedMismatch && !part.familyMismatch) write.push('CHECK YOUR BLANK: the page does not know what "' + ub.join('" ; "') + '" asks for. Before you copy, make sure the ANSWER line above names the SAME thing as that blank. If it names something else, that blank is NOT answered here.');
  if (part.askedMismatch && run.ok) {
    write.push('NOT WHAT YOUR BLANK ASKS: your blank is "' + part.askedMismatch.raw + '". This calculation does not give that. Do NOT copy the ANSWER line above into that blank.');
    read.unshift('WARNING: the page worked out something other than what your answer blank asks for (' + part.askedMismatch.raw + '). Choose another form at the bottom of this part, or use the worked lines as partial credit only.');
  }
  return { write: write.join('\n'), writeLines: write, read: read, other: other, given: given, sources: sources, ok: run.ok, askedLines: al };
};

/* ------------------------------------------------------------------------------------------------ the model: which one, and how to call it (browser side; test.js has its own node caller) */
var NET = {};
NET.BASES = ['http://127.0.0.1:11500', 'http://localhost:11434'];
NET.classify = function (name, details) {
  var n = String(name || ''), m;
  if (n === 'hermies-14b:latest') return 'big';
  if (n === 'qwen3:4b') return 'small';
  m = details && details.parameter_size ? /([\d.]+)\s*B/i.exec(details.parameter_size) : null;
  if (m && Number(m[1]) >= 8) return 'big';
  return 'small';
};
NET.pick = function (models) {
  var i, names = [];
  for (i = 0; i < models.length; i++) names.push(models[i].name || models[i].model);
  for (i = 0; i < models.length; i++) if (names[i] === 'hermies-14b:latest') return { name: names[i], cls: 'big' };
  for (i = 0; i < models.length; i++) if (names[i] === 'qwen3:4b') return { name: names[i], cls: 'small' };
  if (models.length) return { name: names[0], cls: NET.classify(names[0], models[0].details) };
  return null;
};
/* try the bases in order; cb({ok, base, model, cls, error}) ; uses fetch (page only) */
NET.detect = function (cb, bases) {
  var list = (bases || NET.BASES).slice(), errors = [], blocked = [];
  function finish() {
    var msg;
    if (blocked.length) msg = 'a model server answered at ' + blocked[0] + ' but the browser blocked this page from using it (start it with OLLAMA_ORIGINS=*, as Start-AI.bat does), then press Check again';
    else msg = 'no model server answered (' + errors.join('; ') + '). Start Start-AI.bat, wait until it says it is running, then press Check again';
    cb({ ok: false, base: null, model: null, cls: 'none', error: msg, blocked: blocked.length > 0 });
  }
  /* a failed fetch is "not running" OR "running but blocked by CORS"; an opaque no-cors request tells them apart */
  function probe(base, then) {
    try { fetch(base + '/api/tags', { mode: 'no-cors' }).then(function () { blocked.push(base); then(); }, function () { then(); }); } catch (e) { then(); }
  }
  function next() {
    var base, ctl, timer;
    if (!list.length) { finish(); return; }
    base = list.shift();
    ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    timer = setTimeout(function () { if (ctl) ctl.abort(); }, 4000);
    try {
      fetch(base + '/api/tags', ctl ? { signal: ctl.signal } : {}).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) {
        clearTimeout(timer);
        var pick = NET.pick(j.models || []);
        if (!pick) { errors.push(base + ': no model installed'); next(); return; }
        cb({ ok: true, base: base, model: pick.name, cls: pick.cls, error: null });
      }, function (err) { clearTimeout(timer); errors.push(base + ': ' + String(err && err.message ? err.message : err)); probe(base, next); });
    } catch (e) { clearTimeout(timer); errors.push(base + ': ' + String(e && e.message ? e.message : e)); probe(base, next); }
  }
  next();
};
/* what one answer of the model cost (Ollama reports nanoseconds): shown on the page so a slow computer can be told from a broken one */
NET.timing = function (j, t0) {
  function sec(ns) { return isNum(ns) ? Math.round(ns / 1e7) / 100 : null; }
  j = j || {};
  return { wall_s: Math.round((new Date().getTime() - t0) / 100) / 10, total_s: sec(j.total_duration), load_s: sec(j.load_duration),
    prompt_tokens: isNum(j.prompt_eval_count) ? j.prompt_eval_count : null, prompt_s: sec(j.prompt_eval_duration),
    out_tokens: isNum(j.eval_count) ? j.eval_count : null, out_s: sec(j.eval_duration) };
};
/* the callModel LLMREADER.fill wants: POST /api/chat, resolves to the JSON the model produced.
   NO time limit: a slow computer is allowed to be slow (10/06: his laptop needed more than the old 10 minutes for one part, and the page then called the helper
   "not running").  The page shows a clock and a Stop button instead: callModel.abort() ends the request in flight.  callModel.last = the timing of the last answer. */
NET.makeCaller = function (base, onFail) {
  function callModel(body) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, sendBody = {}, k, t0 = new Date().getTime();
    for (k in body) if (has(body, k)) sendBody[k] = body[k];
    sendBody.keep_alive = '8h';
    callModel.inFlight = ctl;
    return fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sendBody), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('the model answered HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        callModel.inFlight = null;
        callModel.last = NET.timing(j, t0); callModel.count = (callModel.count || 0) + 1;
        if (j && j.error) throw new Error(String(j.error));
        var c = j && j.message && j.message.content;
        if (typeof c !== 'string' || !c) throw new Error('the model returned nothing');
        try { return JSON.parse(c); } catch (e) { return c; }        /* the model reader parses damaged JSON tolerantly itself */
      }, function (err) { callModel.inFlight = null; if (onFail) onFail(err); throw err; });
  }
  callModel.inFlight = null; callModel.last = null; callModel.count = 0;
  callModel.abort = function () { var c = callModel.inFlight; if (c) { try { c.abort(); } catch (e) { /* already over */ } } };
  return callModel;
};
SOLVE.net = NET;

root.SOLVE = SOLVE;
if (typeof module !== 'undefined' && module.exports) module.exports = SOLVE;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

