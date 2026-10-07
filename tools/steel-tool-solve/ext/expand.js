/* ==== expand.js ==== */
/* expand.js -- A LIST OF LOOK-UPS IN ONE SENTENCE -> LETTERED PARTS, ONE LOOK-UP EACH.   Text in, text out.  ES5, ASCII only, no lookbehind.

     SOLVE_EXPAND.expand(text) -> { text: <rewritten, or the very same text>, expanded: [ { kind, items, from, skipped? } ] }

   The page answers ONE look-up per question part.  A paper asks several in one item ("Give W14x90 Ix; C10x20 tw; WT7x45 Sx ... ___; ___; ___.").
   This file rewrites such an item into parts (a) (b) (c) ..., each in a wording the page already answers (found by experiment, 10/07; the wordings are
   listed at WORDINGS below and tested by expand-test.js).  It never puts a value into the text, and a shape, a grade or an end condition only when the
   text itself names it.

   HOW IT STAYS OFF EVERYTHING ELSE.  A text is rewritten only when EVERY sentence of it is understood, word by word, as part of one kind of look-up:
   each sentence is stripped of the things the kind knows (shapes, property names, end conditions, products, bolt sizes, KL/r values, blanks, units, table
   references); what is left must be nothing but the kind's small list of filler words.  One unknown word, one number that is not accounted for (a load, a
   length), a cover-page line, a figure, a multiple choice: the text comes back character for character.  Any error inside: the same.

   Kinds, in this order:  shape (a property of a named shape) ; K (effective length factor, recommended design value) ; material (Fy and Fu of a product
   or a shape) ; hole (hole diameter for a bolt) ; fcr (phi Fcr for a KL/r) ; U (shear lag factor for a number of bolts per line).
   Not answered by the page, and named in "skipped":
     the THEORETICAL K -- the part is left exactly as typed (the page's table holds design values; it says so itself);
     Fy / Fu of a bare GRADE (A36, A992) -- the page's reader fills its box from a product word or a shape only, so that part stops with one empty box.
       It still gets its own lettered line when other items of the list ARE answered (the blanks keep their order); a list of bare grades only is
       left as typed.
   ONE look-up is not a list and is left as typed.  The one exception: a K question whose end condition the page's reader does not read.

   THREE QUESTIONS ARE ASKED OF THE PAGE'S OWN PARTS, when they are there (globals STEEL, READER, STEEL_FINDER; without them the careful answer is taken):
     STEEL.run('lookup_material')      is the page's steel for this product the grade the text names?   ("A500 Grade C HSS" yes; "A572 Grade 50 plate" no)
     READER._internal.findEnds         does the reader read this end condition itself?                   (then a single K question is left alone)
     STEEL_FINDER.route / .identify    does the page split this one-look-up-per-sentence text itself?    (her quiz format; then it is left alone)
   So a text the page already handles is not touched, and when the page learns more, this file steps back by itself. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SOLVE_EXPAND = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)), function (root) {
  'use strict';
  var NL = '\n', BL = '____', SH = '\u0001';
  var KINDS = ['shape', 'K', 'material', 'hole', 'fcr', 'U'];

  function trim(s) { return String(s).replace(/^\s+|\s+$/g, ''); }
  function collapse(s) { return trim(String(s).replace(/\s+/g, ' ')); }
  function fill(n, ch) { return new Array(n + 1).join(ch || ' '); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function set(words) { var o = {}, a = words.split(/\s+/), i; for (i = 0; i < a.length; i++) if (a[i]) o[a[i]] = 1; return o; }
  function uniq(a) { var o = [], s = {}, i; for (i = 0; i < a.length; i++) if (!has(s, '$' + a[i])) { s['$' + a[i]] = 1; o.push(a[i]); } return o; }
  function capFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /* every match of re (global) in work: cb(m, start, end, body) -> false = leave it; otherwise the span is blanked with ch (same length).
     pre = the regex's group 1 is the character in front (there is no lookbehind in ES5): it is not part of the span. */
  function scan(work, re, pre, cb, ch) {
    var m, out = work, s, e;
    re.lastIndex = 0;
    while ((m = re.exec(work)) !== null) {
      s = m.index + (pre ? m[1].length : 0); e = m.index + m[0].length;
      if (e <= s) { re.lastIndex = m.index + 1; continue; }
      if (cb(m, s, e, work.slice(s, e)) !== false) out = out.slice(0, s) + fill(e - s, ch) + out.slice(e);
      re.lastIndex = e;
    }
    return out;
  }

  /* ------------------------------------------------------------------------------------------------ things every kind knows */
  var XS = '\\s?[xX\\u00d7]\\s?', DN = '\\d+(?:\\.\\d+)?', FRQ = '(?:\\d+-\\d+\\/\\d+|\\d+ \\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+)';
  var SHAPE_RE = new RegExp('(^|[^A-Za-z0-9])(' +
    '2\\s?L\\s?' + FRQ + XS + FRQ + XS + FRQ +
    '|L\\s?' + FRQ + XS + FRQ + XS + FRQ +
    '|HSS\\s?' + DN + XS + DN + XS + FRQ +
    '|HSS\\s?' + DN + XS + '(?:\\d*\\.\\d+|\\d+\\/\\d+)' +
    '|(?:WT|MT|ST|HP|MC|W|M|S|C)\\s?\\d{1,2}(?:\\.\\d+)?' + XS + DN +
    ')(?![A-Za-z0-9\\/])', 'gi');
  var X_RE = new RegExp('\\s*[xX' + String.fromCharCode(215) + ']\\s*', 'g');          /* x, X or the multiplication sign, written by number: this file is ASCII */
  function canonShape(s) {
    var t = String(s).replace(X_RE, 'x'), m = /^(2\s?)?([A-Za-z]+)\s?([\s\S]*)$/.exec(t);
    return (m[1] ? '2' : '') + m[2].toUpperCase() + m[3];
  }
  function shapeKey(s) { return String(s).toUpperCase().replace(/\s+/g, ''); }
  function artFor(word) { return /^(?:HSS|L\d|M\d|MC|MT|S\d|ST|HP|angle|A\d)/.test(word) ? 'an' : 'a'; }

  /* references to a table or a section ("From Table 2-4", "Using D3.1 case 8", "(Table C-A-7.1)", "in Part 1 of the AISC Manual"): no part of a look-up;
     kept as an instruction in the stem line */
  var REF_RE = /(^|[^A-Za-z0-9])((?:(?:from|in|using|use|per|see|by|with)\s+)?(?:(?:the\s+)?AISC\s+)?(?:(?:the\s+)?(?:Steel\s+Construction\s+)?Manual(?:'s)?\s+)?(?:Specification\s+)?(?:Table|Tables|Section|Sect\.|Chapter|Part)\s+[A-Z]?\d*[A-Za-z]?(?:[.-][A-Za-z0-9]+)*(?:\s+case\s+\d[a-z]?)?(?:\s+of\s+the\s+(?:AISC\s+)?(?:Steel\s+Construction\s+)?(?:Manual|Specification))?|(?:(?:from|in|using|use|per)\s+)?D3\.1(?:\s+case\s+\d[a-z]?)?|case\s+\d[a-z]?)(?![A-Za-z0-9])/gi;
  var UNITS_PHRASE_RE = /(^|[^A-Za-z0-9])((?:with|include|including|show|showing|give|state)\s+(?:the\s+|its\s+|their\s+)?(?:correct\s+|proper\s+|appropriate\s+|applicable\s+)?units(?:\s+(?:for|with)\s+each(?:\s+(?:value|one|answer|property))?)?)(?![A-Za-z0-9])/gi;
  var BLANK_RE = /_{2,}/g;
  var UNIT_RE = /(^|[^A-Za-z0-9])(in\.?\s?\^?\s?[234]|inch(?:es)?|in\.?|lb\s?\/\s?ft|plf|ksi)(?![A-Za-z0-9])/gi;

  /* what is left of a sentence after its known things are blanked: only filler words of the kind, and no digit */
  function residueOk(work, fillers) {
    var t = work.split(SH).join(' '), w, i;
    if (/\d/.test(t)) return false;
    w = t.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ');
    for (i = 0; i < w.length; i++) if (w[i] && !has(fillers, w[i])) return false;
    return true;
  }
  function common(u, info) {
    var w = u;
    w = scan(w, REF_RE, true, function (m, s, e, body) { info.instr.push(collapse(body)); });
    w = scan(w, UNITS_PHRASE_RE, true, function (m, s, e, body) { info.instr.push(collapse(body)); });
    return w;
  }
  function blanksAndUnits(w, info) {
    w = scan(w, BLANK_RE, false, function () { info.blanks++; });
    w = scan(w, UNIT_RE, true, function () { return true; });
    return w;
  }

  var ASK = 'give gives find state list report record write determine provide read obtain tabulate look up what whats is are the a an of for its their each every all ' +
    'these this that those following from in on to by as at and or with also please respectively value values answer answers blank blanks fill complete where ' +
    'it you would do does we be now then next first second third finally number numbers symbol symbols name named given listed per using use used quick short ' +
    'direct lookup lookups question questions problem problems item items aisc manual table tables database steel construction units unit correct proper include including';

  /* ------------------------------------------------------------------------------------------------ kind 1: a property of a named shape */
  var PW = [
    ['(?:(?:total|overall|actual|full)\\s+)?depth(?:\\s*,?\\s*\\(?d\\)?)?', 'd'],
    ['(?:actual\\s+)?flange\\s+width(?:\\s*,?\\s*\\(?bf\\)?)?', 'bf'],
    ['(?:actual\\s+)?flange\\s+thickness(?:\\s*,?\\s*\\(?tf\\)?)?', 'tf'],
    ['(?:actual\\s+)?web\\s+(?:width|thickness)(?:\\s*,?\\s*\\(?tw\\)?)?', 'tw'],      /* "web width" is her word for tw (quiz 1) */
    ['design\\s+(?:wall\\s+)?thickness(?:\\s*,?\\s*\\(?t\\s?des\\)?)?', 'tdes'],
    ['nominal\\s+(?:wall\\s+)?thickness(?:\\s*,?\\s*\\(?t\\s?nom\\)?)?', 'tnom'],
    ['plastic\\s+(?:section\\s+)?modulus(?:\\s*,?\\s*\\(?Z([xy])?\\)?)?', 'Z'],
    ['(?:elastic\\s+)?section\\s+modulus(?:\\s*,?\\s*\\(?S([xy])?\\)?)?', 'S'],
    ['moment\\s+of\\s+inertia(?:\\s*,?\\s*\\(?I([xy])?\\)?)?', 'I'],
    ['radius\\s+of\\s+gyration(?:\\s*,?\\s*\\(?r([xy])?\\)?)?', 'r'],
    ['(?:(?:gross|cross[\\s-]sectional|total|section)\\s+)?area(?:\\s*,?\\s*\\(?A(?:g)?\\)?)?', 'A'],
    ['(?:nominal\\s+)?weight(?:\\s+per\\s+(?:linear\\s+|lineal\\s+)?(?:foot|ft))?', 'W']
  ], PW_RE = [], pwi;
  for (pwi = 0; pwi < PW.length; pwi++) PW_RE.push(new RegExp('(^|[^A-Za-z0-9])(' + PW[pwi][0] + ')(?![A-Za-z0-9])', 'gi'));
  var AXIS_RE = /(^|[^A-Za-z0-9])((?:(about|with\s+respect\s+to|for|in|on)\s+(?:the\s+|its\s+)?)?(strong|weak|major|minor|x|y)(?:\s*-\s*[xy])?[\s-]*(?:axis|direction))(?![A-Za-z0-9])/gi;
  var SYM_RE = /(^|[^A-Za-z0-9_])([Ii][xy]|[Ss][xy]|[Zz][xy]|[Rr][xy]|[Tt][wf]|[Bb]f|[Tt]\s?des|[Tt]\s?nom|Ag|A|a|d)(?![A-Za-z0-9_])/g;
  var SYM_CANON = { ix: 'Ix', iy: 'Iy', sx: 'Sx', sy: 'Sy', zx: 'Zx', zy: 'Zy', rx: 'rx', ry: 'ry', tw: 'tw', tf: 'tf', bf: 'bf', tdes: 'tdes', tnom: 'tnom', ag: 'A', a: 'A', d: 'd' };
  var SYM_BLANK = { Ix: 1, Iy: 1, Sx: 1, Sy: 1, Zx: 1, Zy: 1, rx: 1, ry: 1, tw: 1, tf: 1, bf: 1 };   /* blanks the page knows by their symbol */
  var FILL_SHAPE = set(ASK + ' property properties tabulated dimension dimensions quantity quantities section sections shape shapes member members rolled wide flange ' +
    'channel angle tee hss round rectangular square structural tube hollow column beam girder');
  /* "A" is the area only where it cannot be the article: before a comma, a blank, "=", "of", "and", the end */
  function articleA(work, e) {
    var rest = work.slice(e), m = /^\s*([A-Za-z\u0001]+)/.exec(rest);
    if (!m) return false;
    return !/^(?:of|for|and|or|in|is)$/i.test(m[1]);
  }
  function parseShape(u) {
    var info = { kind: 'shape', els: [], blanks: 0, instr: [] }, w, i, xs = [];
    if (/nominal\s+depth/i.test(u)) return null;
    /* "An" and "Ae" as SYMBOLS (the net and the effective area: calculations) must not pass as the article "an": "Give Ag, An and rx of an L4x4x1/2" */
    if (/(?:^|[^A-Za-z0-9])(?:An|Ae)(?=\s*(?:[,;:=.?)_]|$)|\s+(?:and|or|of|for)(?![A-Za-z]))/.test(u)) return null;
    w = common(u, info);
    w = scan(w, SHAPE_RE, true, function (m, s, e, body) { info.els.push({ t: 'S', at: s, shape: canonShape(body) }); }, SH);
    w = scan(w, /(^|[^A-Za-z0-9])(W[\s-](?:shapes?|sections?))(?![A-Za-z0-9])/g, true, function () { return true; });   /* "a W shape": words, not the weight W */
    for (i = 0; i < PW_RE.length; i++) (function (key) {
      w = scan(w, PW_RE[i], true, function (m, s, e, body) { info.els.push({ t: 'P', at: s, end: e, key: key, axis: m[3] ? m[3].toLowerCase() : null, words: collapse(body) }); });
    })(PW[i][1]);
    w = scan(w, AXIS_RE, true, function (m, s, e, body) { xs.push({ at: s, end: e, after: !!m[3], axis: /^(?:strong|major|x)$/i.test(m[4]) ? 'x' : 'y' }); });
    w = scan(w, SYM_RE, true, function (m, s, e, body) {
      var c = SYM_CANON[body.replace(/\s+/g, '').toLowerCase()];
      if (body === 'A' && articleA(w, e)) return false;
      /* a small "a" is the area only where no article can stand: in front of a comma, a blank, "=", "and", "or", "of" ("give a, rx and ry of a w14x90") */
      if (body === 'a' && !/^\s*(?:[,;:=?)_]|(?:and|or|of)(?![A-Za-z]))/.test(w.slice(e))) return false;
      info.els.push({ t: 'P', at: s, end: e, sym: c });
    });
    w = blanksAndUnits(w, info);
    if (!residueOk(w, FILL_SHAPE)) return null;
    info.els.sort(function (a, b) { return a.at - b.at; });
    /* an axis in words belongs to the property name next to it */
    for (i = 0; i < xs.length; i++) {
      var best = null, k, el;
      for (k = 0; k < info.els.length; k++) {
        el = info.els[k];
        if (el.t !== 'P' || !el.key || !/^[ZSIr]$/.test(el.key)) continue;
        if (xs[i].after ? el.at < xs[i].at : el.at > xs[i].at) { if (!best || Math.abs(el.at - xs[i].at) < Math.abs(best.at - xs[i].at)) best = el; }
      }
      if (!best) for (k = 0; k < info.els.length; k++) { el = info.els[k]; if (el.t === 'P' && el.key && /^[ZSIr]$/.test(el.key) && (!best || Math.abs(el.at - xs[i].at) < Math.abs(best.at - xs[i].at))) best = el; }
      if (!best || (best.axis && best.axis !== xs[i].axis)) return null;
      best.axis = xs[i].axis;
    }
    for (i = 0; i < info.els.length; i++) {
      el = info.els[i];
      if (el.t !== 'P' || el.sym) continue;
      if (/^[ZSIr]$/.test(el.key)) el.sym = el.axis ? el.key + el.axis : null;
      else el.sym = el.key;
    }
    return info;
  }
  function wordShape(it) {
    var of = ' of ' + artFor(it.shape) + ' ' + it.shape;
    if (it.sym && has(SYM_BLANK, it.sym)) return it.sym + of + ': ' + it.sym + ' = ' + BL;
    if (it.sym === 'A') return 'A' + of + ': A = ' + BL + ' in^2';
    if (it.sym === 'W') return 'weight per foot' + of;
    if (it.sym) return it.sym + of;
    return it.words.replace(/\s*,?\s*\(?[ZSIr]\)?$/, '') + of;          /* no axis in the text: none is made up; the page shows both */
  }
  /* the pairs of one sentence.  ctx = { shape, prop } named elsewhere in the question (exactly one of each kind, or null) */
  function pairShape(els, ctx) {
    var seq = '', i, S = [], P = [], out = [], cur, grp;
    for (i = 0; i < els.length; i++) { seq += els[i].t; if (els[i].t === 'S') S.push(els[i]); else P.push(els[i]); }
    function item(s, p) { out.push({ shape: s.shape, sym: p.sym, words: p.words }); }
    if (!P.length && !S.length) return [];
    /* a shape in the stem AND another one in the part: the page would see two shapes and ask which; left alone */
    if (ctx && ctx.shape) for (i = 0; i < S.length; i++) if (shapeKey(S[i].shape) !== shapeKey(ctx.shape)) return null;
    if (uniq(S.map(function (s) { return shapeKey(s.shape); })).length === 1 && P.length) { for (i = 0; i < P.length; i++) item(S[0], P[i]); return out; }
    if (!S.length) { if (!ctx || !ctx.shape) return null; for (i = 0; i < P.length; i++) item({ shape: ctx.shape }, P[i]); return out; }
    if (!P.length) { if (!ctx || !ctx.prop) return null; for (i = 0; i < S.length; i++) item(S[i], ctx.prop); return out; }
    if (/^(?:SP+)+$/.test(seq)) { for (i = 0; i < els.length; i++) { if (els[i].t === 'S') cur = els[i]; else item(cur, els[i]); } return out; }
    if (/^(?:P+S)+$/.test(seq)) { grp = []; for (i = 0; i < els.length; i++) { if (els[i].t === 'P') grp.push(els[i]); else { while (grp.length) item(els[i], grp.shift()); } } return out; }
    if (/^PS+$/.test(seq)) { for (i = 1; i < els.length; i++) item(els[i], els[0]); return out; }
    if (/^S+P$/.test(seq)) { for (i = 0; i < els.length - 1; i++) item(els[i], els[els.length - 1]); return out; }
    return null;
  }

  /* ------------------------------------------------------------------------------------------------ kind 2: K for end conditions */
  var END_TEXT = { 'pinned-pinned': 'pinned at both ends', 'fixed-fixed': 'fixed at both ends', 'fixed-pinned': 'fixed at one end and pinned at the other end',
    'flagpole': 'fixed at the base and free at the top', 'fixed-sway': 'fixed at both ends against rotation but free to translate',
    'pinned-sway': 'pinned at the base and fixed at the top against rotation but free to translate' };
  var BASE = '(?:the\\s+|its\\s+)?(?:base|bottom|foundation|footing|lower\\s+end)', TOP = '(?:the\\s+|its\\s+)?(?:top|upper\\s+end)', PIN = '(?:pinned|hinged)';
  var ENDS = [
    ['fixed-sway', 'fixed[\\s-]fixed\\s+with\\s+(?:side)?sway|fixed\\s+at\\s+both\\s+ends\\s+(?:against\\s+rotation\\s+)?(?:but\\s+|and\\s+)?(?:with\\s+(?:side)?sway|free\\s+to\\s+(?:sway|translate))'],
    ['pinned-sway', PIN + '\\s+at\\s+' + BASE + '\\s+and\\s+fixed\\s+at\\s+' + TOP + '\\s+against\\s+rotation\\s+but\\s+free\\s+to\\s+(?:sway|translate)'],
    ['fixed-pinned', 'fixed\\s+at\\s+(?:' + BASE + '|' + TOP + '|one\\s+end)\\s*(?:,|and|but)?\\s*(?:and\\s+)?' + PIN + '\\s+at\\s+(?:' + TOP + '|' + BASE + '|the\\s+other(?:\\s+end)?)' +
      '|' + PIN + '\\s+at\\s+(?:' + BASE + '|' + TOP + '|one\\s+end)\\s*(?:,|and|but)?\\s*(?:and\\s+)?fixed\\s+at\\s+(?:' + TOP + '|' + BASE + '|the\\s+other(?:\\s+end)?)' +
      '|one\\s+end\\s+fixed\\s*(?:,|and)?\\s*(?:and\\s+)?the\\s+other\\s+(?:end\\s+)?' + PIN + '|one\\s+end\\s+' + PIN + '\\s*(?:,|and)?\\s*(?:and\\s+)?the\\s+other\\s+(?:end\\s+)?fixed' +
      '|fixed\\s+(?:base|bottom)\\s*(?:,|and)\\s*' + PIN + '\\s+top|' + PIN + '\\s+(?:base|bottom)\\s*(?:,|and)\\s*fixed\\s+top|fixed[\\s-]pin(?:ned)?|pin(?:ned)?[\\s-]fixed'],
    ['flagpole', 'fixed\\s+at\\s+' + BASE + '\\s*(?:,|and|but)?\\s*(?:and\\s+)?free\\s+at\\s+' + TOP + '|free\\s+at\\s+' + TOP + '\\s*(?:,|and)?\\s*(?:and\\s+)?fixed\\s+at\\s+' + BASE +
      '|fixed\\s+(?:base|bottom)\\s*(?:,|and)?\\s*(?:and\\s+)?free\\s+top|fixed[\\s-]free|flag\\s?pole|cantilever(?:ed)?(?:\\s+column)?'],
    ['fixed-fixed', 'fixed\\s+at\\s+both\\s+ends|both\\s+ends\\s+(?:are\\s+)?fixed|fixed\\s+at\\s+' + TOP + '\\s+and\\s+(?:at\\s+)?' + BASE + '|fixed\\s+at\\s+' + BASE + '\\s+and\\s+(?:at\\s+)?' + TOP +
      '|fixed\\s+top\\s+and\\s+bottom|fixed\\s+ends|fixed[\\s-]fixed'],
    ['pinned-pinned', PIN + '\\s+at\\s+both\\s+ends|both\\s+ends\\s+(?:are\\s+)?' + PIN + '|' + PIN + '\\s+at\\s+' + TOP + '\\s+and\\s+(?:at\\s+)?' + BASE + '|' + PIN + '\\s+at\\s+' + BASE + '\\s+and\\s+(?:at\\s+)?' + TOP +
      '|pinned\\s+top\\s+and\\s+bottom|pinned\\s+ends|pin[\\s-]ended|pin(?:ned)?[\\s-]pin(?:ned)?']
  ], ENDS_RE = [], ei;
  for (ei = 0; ei < ENDS.length; ei++) ENDS_RE.push(new RegExp('(^|[^A-Za-z0-9-])(' + ENDS[ei][1] + ')(?![A-Za-z0-9-])', 'gi'));
  /* the compounds first, each whole: "pinned-pinned, fixed-pinned" must not be read across the comma or the space */
  var COMPOUND_RE = /(^|[^A-Za-z0-9-])(pin(?:ned)?-pin(?:ned)?|fixed-fixed|fixed-pin(?:ned)?|pin(?:ned)?-fixed|fixed-free)(?![A-Za-z0-9-])/gi;
  var COMPOUND_ID = { pp: 'pinned-pinned', ff: 'fixed-fixed', fp: 'fixed-pinned', pf: 'fixed-pinned', fr: 'flagpole' };
  var K_RE = /(^|[^A-Za-z0-9])([Kk]|effective[\s-]length\s+factors?)(?![A-Za-z0-9])/g;
  var NOT_THEO_RE = /(^|[^A-Za-z0-9])((?:not|rather\s+than|instead\s+of)\s+(?:the\s+|a\s+)?theoretical(?:\s+(?:values?|ones?|K))?)(?![A-Za-z0-9])/gi;
  var FILL_K = set(ASK + ' recommended design theoretical k factor factors column columns member members end ends condition conditions case cases ' +
    'that which has having have braced building frame girder connection connections support supports supported whose both when if should compression usual base top one');
  function chunksOf(w, marks) {
    /* the items of a list: at ";" when the sentence has one between its things, else at commas, "and", "or", "/" and line ends */
    var first = marks[0].at, last = marks[marks.length - 1].at, mid = w.slice(first, last), re, m, cuts = [], i, k, out = [];
    re = /;/.test(mid) ? /;/g : /,|\/|\n|\.|\?|(?:^|[^A-Za-z])(?:and|or|versus|vs)(?![A-Za-z])/gi;
    while ((m = re.exec(w)) !== null) cuts.push(m.index);
    for (i = 0; i < marks.length; i++) {
      for (k = 0; k < cuts.length && cuts[k] < marks[i].at; k++) { /* count the cuts in front */ }
      if (!out.length || out[out.length - 1].k !== k) out.push({ k: k, marks: [] });
      out[out.length - 1].marks.push(marks[i]);
    }
    return out;
  }
  function parseK(u) {
    var info = { kind: 'K', ends: [], k: false, design: /recommended|design/i.test(u), theo: false, blanks: 0, instr: [] }, w, i;
    if (/sway|translat|unbraced|moment\s+frame|rotation/i.test(u.replace(new RegExp(ENDS[0][1] + '|' + ENDS[1][1], 'gi'), ' '))) return null;
    w = common(u, info);
    /* "not the theoretical value" says DESIGN; any other "theoretical" asks for the theoretical value.  ("not" is no filler word: "not fixed at both ends".) */
    w = scan(w, NOT_THEO_RE, true, function () { info.instr.push('not the theoretical value'); });
    info.theo = /theoretical/i.test(w);
    function ends(from, to) { for (i = from; i < to; i++) (function (id) { w = scan(w, ENDS_RE[i], true, function (m, s) { info.ends.push({ at: s, id: id }); }, SH); })(ENDS[i][0]); }
    ends(0, 2);                                                            /* the two sway cases first: "fixed-fixed with sway" is not "fixed-fixed" */
    w = scan(w, COMPOUND_RE, true, function (m, s, e, body) {
      var b = body.toLowerCase().split('-'), key = b[0].charAt(0) + (b[1] === 'free' ? 'r' : b[1].charAt(0));
      info.ends.push({ at: s, id: COMPOUND_ID[key] });
    }, SH);
    ends(2, ENDS_RE.length);
    w = scan(w, K_RE, true, function () { info.k = true; });
    w = blanksAndUnits(w, info);
    if (!residueOk(w, FILL_K)) return null;
    info.ends.sort(function (a, b) { return a.at - b.at; });
    info.items = [];
    if (info.ends.length) {
      var ch = chunksOf(w, info.ends), ids;
      for (i = 0; i < ch.length; i++) {
        ids = uniq(ch[i].marks.map(function (x) { return x.id; }));
        if (ids.length !== 1) return null;
        info.items.push(ids[0]);
      }
    }
    return info;
  }
  function wordK(id, design) { return (design ? 'Recommended design K' : 'K') + ' for a column ' + END_TEXT[id] + ': K = ' + BL; }

  /* ------------------------------------------------------------------------------------------------ kind 3: Fy and Fu of a product, a shape or a grade */
  var GRADE_RE = /(^|[^A-Za-z0-9])((?:ASTM\s+)?A\s?-?\s?(?:36|53|242|500|501|529|572|588|913|992|1085)(?:\s*,?\s*Gr(?:ade|\.)?\s*[A-C0-9]{1,2})?)(?![A-Za-z0-9])/gi;
  var PRODUCTS = [
    ['wide flange', 'W[\\s-]?(?:shapes?|sections?)|wide[\\s-]flange(?:\\s+(?:shapes?|sections?|beams?|columns?))?'],
    ['HSS', '(?:(rectangular|square|round|circular)\\s+)?HSS(?:\\s+(?:shapes?|sections?|tubes?))?'],
    ['pipe', '(?:(standard|steel)\\s+)?pipes?'],
    ['plate', '(?:steel\\s+)?plates?'],
    ['angle', 'angles?'],
    ['channel', 'channels?']
  ], PRODUCTS_RE = [], pi;
  for (pi = 0; pi < PRODUCTS.length; pi++) PRODUCTS_RE.push(new RegExp('(^|[^A-Za-z0-9])(' + PRODUCTS[pi][1] + ')(?![A-Za-z0-9])', 'gi'));
  var FYFU_RE = /(^|[^A-Za-z0-9])(F\s?y|F\s?u|yield\s+(?:stress|strength|point)(?:es|s)?|(?:tensile|ultimate)\s+(?:stress|strength)(?:es|s)?)(?![A-Za-z0-9])/gi;
  var FILL_MAT = set(ASK + ' usual usually typical typically default common commonly assumed assume preferred minimum specified grade grades astm material materials shape shapes ' +
    'section sections structural product products type types if when no not problem name named does unless noted otherwise would steels her his your them they have has be ' +
    'should can without there');
  function productPhrase(word, m, body) {
    if (word === 'wide flange') return /wide/i.test(body) ? 'wide flange shape' : 'W shape (wide flange)';
    if (word === 'HSS') return (m[3] ? m[3].toLowerCase() + ' ' : '') + 'HSS';
    if (word === 'pipe') return (m[3] && /standard/i.test(m[3]) ? 'standard ' : '') + 'pipe';
    return word;
  }
  function parseMat(u) {
    var info = { kind: 'material', things: [], fy: false, fu: false, blanks: 0, instr: [] }, w, i, marks = [];
    /* a blank of its own for one of the two only ("Fy and Fu for a plate: Fy = ____ ksi"): that one is what is asked */
    info.fyBlank = /(^|[^A-Za-z0-9])F\s?y\s*=\s*_{2,}/i.test(u); info.fuBlank = /(^|[^A-Za-z0-9])F\s?u\s*=\s*_{2,}/i.test(u);
    w = common(u, info);
    w = scan(w, SHAPE_RE, true, function (m, s, e, body) { marks.push({ at: s, t: 'shape', text: canonShape(body) }); }, SH);
    w = scan(w, GRADE_RE, true, function (m, s, e, body) { marks.push({ at: s, t: 'grade', text: collapse(body) }); }, SH);
    for (i = 0; i < PRODUCTS_RE.length; i++) (function (word) {
      w = scan(w, PRODUCTS_RE[i], true, function (m, s, e, body) { marks.push({ at: s, t: 'product', word: word, text: productPhrase(word, m, body) }); }, SH);
    })(PRODUCTS[i][0]);
    w = scan(w, FYFU_RE, true, function (m, s, e, body) { if (/^f\s?y$|yield/i.test(body)) info.fy = true; else info.fu = true; });
    w = blanksAndUnits(w, info);
    if (!residueOk(w, FILL_MAT)) return null;
    marks.sort(function (a, b) { return a.at - b.at; });
    if (marks.length) {
      var ch = chunksOf(w, marks), th, k;
      for (i = 0; i < ch.length; i++) {
        th = { shape: null, grade: null, product: null, word: null };
        for (k = 0; k < ch[i].marks.length; k++) {
          var mk = ch[i].marks[k];
          if (mk.t === 'shape') { if (th.shape) return null; th.shape = mk.text; }
          else if (mk.t === 'grade') { if (th.grade) return null; th.grade = mk.text; }
          else { if (th.product) return null; th.product = mk.text; th.word = mk.word; }
        }
        if (th.shape && (th.grade || th.product)) return null;
        info.things.push(th);
      }
    }
    return info;
  }
  /* a grade named WITH a product ("A500 Grade C HSS") is answered by the page from the product word alone: it is used only when the page's steel for that
     product IS the grade named (asked of the engine, never assumed) */
  function gradeIsDefault(grade, word) {
    var ST = root.STEEL, r, g, d;
    try {
      if (!ST || typeof ST.run !== 'function') return false;
      r = ST.run('lookup_material', { what: word });
      if (!r || !r.ok || !r.answer || !r.answer.text) return false;
      d = /ASTM\s+A\s?(\d+)(?:\s+Gr(?:ade|\.)?\s*([A-Za-z0-9]+))?/i.exec(String(r.answer.text));
      g = /A\s?-?\s?(\d+)(?:\s*,?\s*Gr(?:ade|\.)?\s*([A-Za-z0-9]+))?/i.exec(grade);
      if (!d || !g || d[1] !== g[1]) return false;
      return !g[2] || (!!d[2] && d[2].toUpperCase() === g[2].toUpperCase());
    } catch (e) { return false; }
  }
  function wordMat(th, fy, fu, skipped) {
    var what, tail = ': ' + (fy || !fu ? 'Fy = ' + BL + ' ksi' : '') + ((fy || !fu) && (fu || !fy) ? ', ' : '') + (fu || !fy ? 'Fu = ' + BL + ' ksi' : '');
    if (th.shape) what = artFor(th.shape) + ' ' + th.shape;
    else if (th.grade && th.product && gradeIsDefault(th.grade, th.word)) what = th.grade + ' ' + th.product;
    else if (th.grade) { what = th.grade + ' steel'; skipped.push('Fy / Fu of the grade ' + th.grade + ': the page looks steel up by product or shape, not by grade'); }
    else what = artFor(th.product) + ' ' + th.product;
    return 'Fy and Fu for ' + what + tail;
  }

  /* ------------------------------------------------------------------------------------------------ kind 4: hole diameter for a bolt */
  var SIZE_RE = new RegExp('(^|[^A-Za-z0-9.\\/-])(' + FRQ + ')(\\s*-?\\s*(?:in\\.?|inch(?:es)?|"))?(?:\\s*-?\\s*(?:diameter|dia\\.?|diam\\.?))?(?![A-Za-z0-9\\/])', 'gi');
  var FILL_HOLE = set(ASK + ' hole holes diameter diameters dia size sizes deducted deduct deduction computing calculating net area bolt bolts bolted when taken assumed should effective width ' +
    'that which');
  function sizeValue(t) { var m = /^(\d+)[ -](\d+)\/(\d+)$/.exec(t); if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]); m = /^(\d+)\/(\d+)$/.exec(t); return m ? Number(m[1]) / Number(m[2]) : Number(t); }
  function parseHole(u) {
    var info = { kind: 'hole', sizes: [], hole: /\bholes?\b/i.test(u), bolt: /\bbolt/i.test(u), blanks: 0, instr: [] }, w, bad = false;
    if (/standard|nominal|oversize|slot|J3|1\/16|punch|damage/i.test(u)) return null;
    w = common(u, info);
    w = scan(w, BLANK_RE, false, function () { info.blanks++; });
    w = scan(w, SIZE_RE, true, function (m, s, e, body) {
      var txt = collapse(m[2]).replace(/^(\d+)-(\d+\/\d+)$/, '$1 $2'), v = sizeValue(txt);
      if (!(v >= 0.375 && v <= 1.5)) { bad = true; return false; }
      info.sizes.push(txt);
    }, SH);
    w = blanksAndUnits(w, info);
    if (bad || !residueOk(w, FILL_HOLE)) return null;
    return info;
  }
  function wordHole(size) { return 'What hole diameter is used for a ' + size + ' in bolt? hole diameter = ' + BL + ' in'; }

  /* ------------------------------------------------------------------------------------------------ kind 5: phi Fcr for a KL/r */
  var KLR_RE = /(^|[^A-Za-z0-9])((?:(?:governing\s+)?(?:slenderness\s+ratios?\s*(?:,\s*)?)?(?:K\s?L|L\s?c)\s*\/\s*r|slenderness\s+ratios?)\s*(?:=|of|is|:)?\s*)(\d+(?:\.\d+)?(?:\s*(?:,\s*and|,\s*or|,|;|and|or|&)\s*\d+(?:\.\d+)?)*)(?![A-Za-z0-9\/])/gi;
  var FYGIVEN_RE = /(^|[^A-Za-z0-9])(Fy\s*(?:=|of|is)\s*(\d+(?:\.\d+)?)\s*ksi)(?![A-Za-z0-9])/gi;
  var PHIFCR_RE = /(^|[^A-Za-z0-9])(phi\s*_?\s*c?\s*\*?\s*F\s?cr|(?:design|available)\s+(?:critical\s+|compressive\s+|buckling\s+)?stress(?:es)?)(?![A-Za-z0-9])/gi;
  var FILL_FCR = set(ASK + ' design available critical stress stresses governing column columns when if for determine fcr c');
  function parseFcr(u) {
    var info = { kind: 'fcr', klr: [], fy: [], phi: false, blanks: 0, instr: [] }, w, bad = false;
    w = common(u, info);
    w = scan(w, FYGIVEN_RE, true, function (m) { info.fy.push(m[3]); });
    w = scan(w, KLR_RE, true, function (m) {
      var nums = m[3].match(/\d+(?:\.\d+)?/g), i;
      for (i = 0; i < nums.length; i++) { if (!(Number(nums[i]) >= 1 && Number(nums[i]) <= 250)) bad = true; info.klr.push(nums[i]); }
    });
    w = scan(w, PHIFCR_RE, true, function () { info.phi = true; });
    w = blanksAndUnits(w, info);
    if (bad || !residueOk(w, FILL_FCR)) return null;
    return info;
  }
  function wordFcr(klr, fy) { return 'KL/r = ' + klr + (fy ? ', Fy = ' + fy + ' ksi' : '') + ': phi Fcr = ' + BL + ' ksi'; }

  /* ------------------------------------------------------------------------------------------------ kind 6: U for a number of bolts per line */
  var CONN_RE = /(^|[^A-Za-z0-9])((?:(?:is\s+|are\s+)?(?:connected|bolted|attached|fastened)\s+)?(?:through|by|at|along|on)\s+(?:its|the|both|one|only\s+one|a\s+single)\s+(?:two\s+)?(flanges?|web|legs?)(?:\s+only)?)(?![A-Za-z0-9])/gi;
  var COUNT_RE = /(^|[^A-Za-z0-9\/.-])(\d|two|three|four|five|six|seven|eight)(\s+(?:bolts?|fasteners?))?(\s+(?:per|in\s+a|in\s+each|in\s+the|each)\s+(?:line|row))?(?![A-Za-z0-9\/])/gi;
  var ULABEL_RE = /(^|[^A-Za-z0-9])([Uu]\s?_?\d?)(?![A-Za-z0-9])/g;             /* U, U3, and "u" / "u3" as he types them */
  var FILL_U = set(ASK + ' shear lag connected bolted compare versus vs factor factors when there same member angle tension line lines per row bolt bolts fastener fasteners ' +
    'direction single only one both cases case');
  function parseU(u) {
    var info = { kind: 'U', shapes: [], conn: [], counts: [], perLine: false, u: /shear[\s-]*lag/i.test(u), blanks: 0, instr: [] }, w;
    w = common(u, info);
    w = scan(w, SHAPE_RE, true, function (m, s, e, body) { info.shapes.push(canonShape(body)); }, SH);
    w = scan(w, CONN_RE, true, function (m) { info.conn.push(/^flange/i.test(m[3]) ? (/s$/i.test(m[3]) ? 'its flanges' : 'its flange') : (/^web/i.test(m[3]) ? 'its web' : 'one leg')); });
    w = scan(w, ULABEL_RE, true, function () { info.u = true; });
    w = scan(w, BLANK_RE, false, function () { info.blanks++; });
    w = scan(w, COUNT_RE, true, function (m) { info.counts.push(m[2].toLowerCase()); if (m[4]) info.perLine = true; });
    if (!residueOk(w, FILL_U)) return null;
    return info;
  }
  function wordU(shape, conn, count) { return 'Shear lag factor U for ' + artFor(shape) + ' ' + shape + ' connected through ' + conn + ' with ' + count + ' bolts per line: U = ' + BL; }

  var PARSE = { shape: parseShape, K: parseK, material: parseMat, hole: parseHole, fcr: parseFcr, U: parseU };

  /* ------------------------------------------------------------------------------------------------ sentences and lettered parts */
  /* a sentence ends at . ? ! when a capital, a bracket or a blank follows; never inside "Gr. 50", "in. bolts", "D3.1", a decimal */
  function sentences(text) {
    var out = [], lines = String(text).split(NL), i, ln, k, start, c, rest, m;
    for (i = 0; i < lines.length; i++) {
      ln = lines[i]; start = 0;
      for (k = 0; k < ln.length; k++) {
        c = ln.charAt(k);
        if (c !== '.' && c !== '?' && c !== '!') continue;
        rest = ln.slice(k + 1);
        m = /^(\s+)(?=[A-Z(_\[])/.exec(rest);
        /* typed without capitals: a word that starts a sentence does the same after a period or a question mark */
        if (!m) m = /^(\s+)(?=(?:if|the|an?|give|state|what|which|find|determine|for|how|why|explain|list|name|use|using|assume|no|it|this|each|all|also|then|there|when|where|show|report|write|look|read|record|include)(?![A-Za-z0-9]))/.exec(rest);
        if (!m) continue;
        if (c === '.' && /(?:\bGr|\bFig|\bvs|\bapprox|\bdia|\bdiam|\bSect|\be\.g|\bi\.e)$/i.test(ln.slice(0, k))) continue;
        out.push(ln.slice(start, k + 1)); start = k + 1 + m[1].length; k = start - 1;
      }
      if (trim(ln.slice(start))) out.push(ln.slice(start));
    }
    return out.map(trim).filter(function (s) { return !!s; });
  }
  /* "(a) ... (b) ..." in order from (a), at least two, at most eight: the page's own way of seeing parts */
  function lettered(text) {
    var re = /(^|\s)\(([a-h])\)[:.]?[ \t]*/g, m, marks = [], want = 'a', i, parts = [];
    while ((m = re.exec(text)) !== null) {
      if (m[2] === want) { marks.push({ ch: m[2], start: m.index + m[1].length, textStart: m.index + m[0].length }); want = String.fromCharCode(want.charCodeAt(0) + 1); }
      else return 'odd';
    }
    if (!marks.length) return null;
    if (marks.length < 2) return 'odd';
    for (i = 0; i < marks.length; i++) parts.push({ ch: marks[i].ch, text: trim(text.slice(marks[i].textStart, i + 1 < marks.length ? marks[i + 1].start : text.length)) });
    return { stem: trim(text.slice(0, marks[0].start)), parts: parts };
  }

  /* the whole text is left alone when it is anything but plain look-ups */
  var NEVER_RE = /exam\s+defaults|cover\s+(?:page|defaults)|unless\s+(?:otherwise\s+)?noted|\(\s*(?:choose|circle|check|pick|select)\s+one\s*\)|\b(?:choose|circle|pick|check)\s+(?:only\s+)?one\b|which\s+(?:one\s+)?of\s+the\s+following|multiple\s+choice|true\s+or\s+false|\bfig(?:ure|\.)?\s*[A-Za-z]?\d|\bfigure\b|\bas\s+shown\b|\bshown\b|\bsketch\b|\bdiagram\b|\bplan\s+view\b|\bsee\s+below\b/i;
  var OTHER_MARKS_RE = /(?:^|\n)[ \t]*(?:[a-hA-H][.)]|\(?\d{1,2}\)|\d{1,2}\.|\((?:i{1,3}|iv|v|vi{1,3})\)|[-*])[ \t]+\S/;
  /* a sentence left over after the last part ("If a strength is printed as a range, which number? ____."): a word question of its own, never a calculation */
  var CALC_RE = /\d|\b(?:loads?|kips?|span|spans|long|length|capacity|capacities|adequa\w+|select|lightest|economical|cheapest|choose|pick|size|safe|carry|carries|support|supports|resist|heavier|lighter|larger|smaller|greater|compare|moment|shear|reaction|deflection|slab|floor|tributary|beams?|girders?|columns?|members?|factored|net\s+area|effective|rupture|yielding|buckl\w*|slenderness|phi|design\s+strength|available\s+strength|tensile\s+strength|compressive\s+strength|nominal\s+strength|determine|calculate|compute|check|find|select)\b/i;

  function infoHasItems(kind, f) {
    if (kind === 'shape') return f.els.length > 0;
    if (kind === 'K') return f.ends.length > 0 || f.k;
    if (kind === 'material') return f.things.length > 0 || f.fy || f.fu;
    if (kind === 'hole') return f.sizes.length > 0 || f.hole;
    if (kind === 'fcr') return f.klr.length > 0 || f.phi || f.fy.length > 0;
    return f.shapes.length > 0 || f.conn.length > 0 || f.counts.length > 0 || f.u;
  }
  /* the look-ups of a group of sentences of one kind, with what the rest of the question gives (ctx).  -> { lines: [text], skipped: [..] } or null.
     own = true: the sentences are one lettered part (exactly one look-up is wanted) */
  function itemsOf(kind, infos, ctx, own) {
    var lines = [], skipped = [], i, k, f, p, els = [], S, P, fy = false, fu = false, things = [], ids = [], design = false, theo = false, kk = false,
      sizes = [], hole = false, bolt = false, klr = [], fys = [], phi = false, shapes = [], conn = [], counts = [], per = false, uu = false;
    ctx = ctx || {};
    if (kind === 'shape') {
      for (i = 0; i < infos.length; i++) {
        if (!infos[i].els.length) continue;
        p = pairShape(infos[i].els, ctx);
        if (p === null) return null;
        for (k = 0; k < p.length; k++) { lines.push(wordShape(p[k])); els.push(p[k]); }
      }
      return { lines: lines, skipped: skipped, pairs: els };
    }
    if (kind === 'K') {
      for (i = 0; i < infos.length; i++) { f = infos[i]; ids = ids.concat(f.items); design = design || f.design; theo = theo || f.theo; kk = kk || f.k; }
      if (!kk && !ctx.k) return null;
      /* the theoretical value is asked (by the part itself, or by the stem while the part does not say "design"): not answered by the page, left as typed */
      if (theo || (ctx.theo && !design)) return { lines: [], skipped: ['theoretical K: the page\'s answer line is always the recommended design value'], theo: true };
      if (!ids.length) { if (!ctx.end) return null; ids = [ctx.end]; }
      else if (ctx.end && own) return null;
      for (i = 0; i < ids.length; i++) lines.push(wordK(ids[i], design || ctx.design));
      return { lines: lines, skipped: skipped, ids: ids };
    }
    if (kind === 'material') {
      var fyB = false, fuB = false;
      for (i = 0; i < infos.length; i++) { f = infos[i]; fy = fy || f.fy; fu = fu || f.fu; fyB = fyB || f.fyBlank; fuB = fuB || f.fuBlank; things = things.concat(f.things); }
      if (!fy && !fu) { fy = !!ctx.fy; fu = !!ctx.fu; }
      if (!fy && !fu) return null;
      if (fyB !== fuB) { fy = fyB; fu = fuB; }
      for (i = 0; i < things.length; i++) lines.push(wordMat(things[i], fy, fu, skipped));
      return { lines: lines, skipped: skipped };
    }
    if (kind === 'hole') {
      for (i = 0; i < infos.length; i++) { f = infos[i]; sizes = sizes.concat(f.sizes); hole = hole || f.hole; bolt = bolt || f.bolt; }
      if (!(hole || ctx.hole) || !(bolt || ctx.bolt)) return null;
      for (i = 0; i < sizes.length; i++) lines.push(wordHole(sizes[i]));
      return { lines: lines, skipped: skipped };
    }
    if (kind === 'fcr') {
      for (i = 0; i < infos.length; i++) { f = infos[i]; klr = klr.concat(f.klr); fys = fys.concat(f.fy); phi = phi || f.phi; }
      fys = uniq(fys.concat(ctx.fy || []));
      if (!(phi || ctx.phi) || fys.length > 1) return null;
      for (i = 0; i < klr.length; i++) lines.push(wordFcr(klr[i], fys[0] || null));
      return { lines: lines, skipped: skipped };
    }
    for (i = 0; i < infos.length; i++) { f = infos[i]; shapes = shapes.concat(f.shapes); conn = conn.concat(f.conn); counts = counts.concat(f.counts); per = per || f.perLine; uu = uu || f.u; }
    shapes = uniq(shapes.concat(ctx.shapes || []).map(shapeKey)).length === 1 ? [shapes.concat(ctx.shapes || [])[0]] : [];
    conn = uniq(conn.concat(ctx.conn || []));
    if (!(uu || ctx.u) || !(per || ctx.perLine) || shapes.length !== 1 || conn.length !== 1 || uniq(counts).length !== counts.length) return null;
    for (i = 0; i < counts.length; i++) lines.push(wordU(shapes[0], conn[0], counts[i]));
    return { lines: lines, skipped: skipped };
  }
  /* what the stem of a lettered question gives to its parts, for one kind; null = the stem is not understood as that kind */
  function stemCtx(kind, sents) {
    var infos = [], i, f, ctx = { infos: infos }, S = [], P = [], ids = [];
    for (i = 0; i < sents.length; i++) { f = PARSE[kind](sents[i]); if (!f) return null; infos.push(f); }
    if (kind === 'shape') {
      for (i = 0; i < infos.length; i++) infos[i].els.forEach(function (e) { if (e.t === 'S') S.push(e); else P.push(e); });
      if (S.length && P.length) return null;                               /* the stem holds a whole look-up of its own */
      if (uniq(S.map(function (s) { return shapeKey(s.shape); })).length > 1 || P.length > 1) return null;
      ctx.shape = S.length ? S[0].shape : null; ctx.prop = P.length ? P[0] : null;
    } else if (kind === 'K') {
      for (i = 0; i < infos.length; i++) { ids = ids.concat(infos[i].items); ctx.k = ctx.k || infos[i].k; ctx.design = ctx.design || infos[i].design; ctx.theo = ctx.theo || infos[i].theo; }
      if (uniq(ids).length > 1) return null;
      ctx.end = ids.length ? ids[0] : null;
    } else if (kind === 'material') {
      for (i = 0; i < infos.length; i++) { if (infos[i].things.length) return null; ctx.fy = ctx.fy || infos[i].fy; ctx.fu = ctx.fu || infos[i].fu; }
    } else if (kind === 'hole') {
      for (i = 0; i < infos.length; i++) { if (infos[i].sizes.length) return null; ctx.hole = ctx.hole || infos[i].hole; ctx.bolt = ctx.bolt || infos[i].bolt; }
    } else if (kind === 'fcr') {
      ctx.fy = [];
      for (i = 0; i < infos.length; i++) { if (infos[i].klr.length) return null; ctx.fy = ctx.fy.concat(infos[i].fy); ctx.phi = ctx.phi || infos[i].phi; }
    } else {
      ctx.shapes = []; ctx.conn = [];
      for (i = 0; i < infos.length; i++) { if (infos[i].counts.length) return null; ctx.shapes = ctx.shapes.concat(infos[i].shapes); ctx.conn = ctx.conn.concat(infos[i].conn); ctx.u = ctx.u || infos[i].u; ctx.perLine = ctx.perLine || infos[i].perLine; }
    }
    return ctx;
  }
  function instrLine(list) {
    var u = uniq(list.map(function (s) { return collapse(s).replace(/^[(\s]+|[)\s.,;:]+$/g, ''); }).filter(function (s) { return !!s; }));
    return u.length ? capFirst(u.join(', ')) + '.' : '';
  }
  function blanksFit(kind, blanks, n) { return blanks === 0 || blanks === n || (kind === 'material' && blanks === 2 * n); }

  /* ---- a question the paper already letters: every part must be one look-up; each is put in the page's wording and keeps its letter */
  function runLettered(L) {
    var stemS = sentences(L.stem), ctxs = {}, i, k, kind, out = [], groups = {}, order = [], extra = null, anyChange = false, P, ss, done, j, infos, r, bl, cut, tail, ok;
    for (i = 0; i < KINDS.length; i++) ctxs[KINDS[i]] = stemCtx(KINDS[i], stemS);
    for (i = 0; i < L.parts.length; i++) {
      P = L.parts[i]; ss = sentences(P.text); done = false;
      if (!ss.length) return null;
      for (cut = ss.length; cut >= 1 && !done; cut--) {
        if (cut < ss.length && i !== L.parts.length - 1) break;            /* only the LAST part may have a sentence after its look-up */
        tail = ss.slice(cut).join(' ');
        if (cut < ss.length && (CALC_RE.test(tail.replace(BLANK_RE, ' ')) || SHAPE_RE.test(tail))) { SHAPE_RE.lastIndex = 0; continue; }
        SHAPE_RE.lastIndex = 0;
        for (k = 0; k < KINDS.length && !done; k++) {
          kind = KINDS[k];
          if (!ctxs[kind]) continue;
          infos = []; ok = true; bl = 0;
          for (j = 0; j < cut; j++) { r = PARSE[kind](ss[j]); if (!r) { ok = false; break; } infos.push(r); bl += r.blanks; }
          if (!ok) continue;
          if (!infos.some(function (f) { return infoHasItems(kind, f); })) continue;
          r = itemsOf(kind, infos, ctxs[kind], true);
          if (!r) continue;
          if (r.theo) { out.push({ ch: P.ch, text: P.text, kind: kind, skipped: r.skipped, same: true }); done = true; break; }
          if (r.lines.length !== 1 || !blanksFit(kind, bl, 1)) continue;
          out.push({ ch: P.ch, text: r.lines[0], kind: kind, skipped: r.skipped, same: collapse(r.lines[0]) === collapse(P.text) && cut === ss.length });
          if (cut < ss.length) extra = tail;
          done = true;
        }
      }
      if (!done) return null;
    }
    if (extra !== null) { if (out.length >= 8) return null; out.push({ ch: String.fromCharCode(97 + out.length), text: extra, kind: null, skipped: [], same: false }); }
    for (i = 0; i < out.length; i++) {
      if (!out[i].same) anyChange = true;
      if (!out[i].kind || (out[i].same && !out[i].skipped.length)) continue;
      if (!groups[out[i].kind]) { groups[out[i].kind] = { kind: out[i].kind, items: 0, from: [], skipped: [] }; order.push(out[i].kind); }
      if (!out[i].same) { groups[out[i].kind].items++; groups[out[i].kind].from.push('(' + out[i].ch + ') ' + L.parts[i].text); }
      groups[out[i].kind].skipped = groups[out[i].kind].skipped.concat(out[i].skipped.map(function (s) { return '(' + out[i].ch + ') ' + s; }));
    }
    if (!anyChange) return null;
    /* nothing the page can answer came out of it (every rewritten part is a bare grade): left as typed */
    if (!out.some(function (p) { return !p.same && p.kind && !p.skipped.length; })) return null;
    return { text: (L.stem ? L.stem + NL : '') + out.map(function (p) { return '(' + p.ch + ') ' + p.text; }).join(NL),
      expanded: order.map(function (kd) { var g = groups[kd], e = { kind: g.kind, items: g.items, from: collapse((L.stem ? L.stem + ' ' : '') + g.from.join(' ')) }; if (g.skipped.length) e.skipped = g.skipped; return e; }) };
  }

  /* the properties the page's "all properties" line prints for a rolled I, channel or tee shape */
  var ALL_LINE = { W: 1, A: 1, d: 1, bf: 1, tw: 1, tf: 1, Ix: 1, Zx: 1, Sx: 1, rx: 1, Iy: 1, Zy: 1, Sy: 1, ry: 1 };
  function allOfOneShape(pairs) {
    var i;
    if (!pairs || !pairs.length || !/^(?:W|M|S|HP|C|MC|WT|MT|ST)\d/.test(pairs[0].shape)) return false;
    for (i = 0; i < pairs.length; i++) if (shapeKey(pairs[i].shape) !== shapeKey(pairs[0].shape) || !pairs[i].sym || !has(ALL_LINE, pairs[i].sym)) return false;
    return true;
  }
  /* does the page's rule reader read an end condition from this text by itself?  (asked of the reader; when it cannot be asked: yes, leave the text alone) */
  function readerReadsEnds(text) {
    var R = root.READER, f = R && R._internal && R._internal.findEnds, e;
    if (typeof f !== 'function') return true;
    try { e = f(String(text)); } catch (err) { return true; }
    return !!(e && e.filter(function (x) { return !x.viaK; }).length);
  }
  /* HER QUIZ FORMAT, one look-up to a sentence ("The actual depth of a M8 x 6.5. The section modulus about the strong axis of a WT12 x 185.").  The page
     splits such a text itself -- but only when its finder takes the whole text for a look-up and each sentence for a shape look-up, and its reader knows
     the property (with "The weight of a C10 x 20." or "The design wall thickness of a HSS ..." among the sentences the page sends the whole question to
     the column form and stops).  So the page's own finder is asked: when it would handle every sentence, the text is left exactly as typed; when it
     would not (or cannot be asked), the sentences become parts like any other list. */
  var READER_PROPS = { d: 1, bf: 1, tf: 1, tw: 1, A: 1, Ix: 1, Iy: 1, Sx: 1, Sy: 1, Zx: 1, Zy: 1, rx: 1, ry: 1 };
  function onePerSentence(ss, infos) {
    var i, els, n = 0, F = root.STEEL_FINDER, r, rr, pre = [], seen = false;
    if (!F || typeof F.route !== 'function' || typeof F.identify !== 'function') return false;
    try {
      r = F.route(ss.join(' '));
      if (!r || !r.parts || r.parts.length !== 1 || r.parts[0].letter || r.parts[0].family !== 'lookup') return false;
      for (i = 0; i < infos.length; i++) {
        if (!infos[i].els.length) { if (!seen) pre.push(ss[i]); continue; }
        seen = true;
        rr = F.identify(pre.join(' '), ss[i]);
        if (!rr || rr.fn !== 'lookup_shape') return false;
      }
    } catch (e) { return false; }
    for (i = 0; i < infos.length; i++) {
      els = infos[i].els;
      if (!els.length) continue;
      n++;
      if (els.length !== 2 || els[0].t !== 'P' || els[1].t !== 'S' || !els[0].sym || !has(READER_PROPS, els[0].sym)) return false;
      if (!/^\s*(?:of|for)\s+(?:a|an|the)\s*$/i.test(ss[i].slice(els[0].end, els[1].at)
        .replace(/(?:(?:about|with\s+respect\s+to|for|in|on)\s+(?:the\s+|its\s+)?)?(?:strong|weak|major|minor|x|y)(?:\s*-\s*[xy])?[\s-]*(?:axis|direction)/gi, ' '))) return false;
    }
    return n > 0;
  }

  /* ---- a question with no letters: all of its sentences are one kind of look-up; the list becomes parts (a) (b) ... */
  function runPlain(text) {
    var ss = sentences(text), k, kind, i, infos, f, r, blanks, keep, instr, from, lines, stem;
    if (!ss.length) return null;
    for (k = 0; k < KINDS.length; k++) {
      kind = KINDS[k]; infos = []; blanks = 0; keep = []; instr = []; from = [];
      for (i = 0; i < ss.length; i++) { f = PARSE[kind](ss[i]); if (!f) break; infos.push(f); }
      if (infos.length < ss.length) continue;
      r = itemsOf(kind, infos, null, false);
      if (!r || r.theo || !r.lines.length) continue;
      for (i = 0; i < ss.length; i++) {
        f = infos[i]; blanks += f.blanks;
        if (infoHasItems(kind, f) || f.blanks) { instr = instr.concat(f.instr); if (infoHasItems(kind, f)) from.push(ss[i]); }
        else keep.push(ss[i]);
      }
      if (r.lines.length === 1) {
        /* ONE look-up is not a list: it is left as typed.  The only one rewritten: a K question whose end condition the page's own reader does not read
           ("fixed at the foundation and pinned at the top girder connection", "a fixed-free column", "pin-pin"): the page stops on those. */
        if (kind !== 'K' || readerReadsEnds(text)) return 'leave';
        keep = []; from = [];
        for (i = 0; i < ss.length; i++) { if (infos[i].k || infos[i].blanks) { if (infos[i].k) from.push(ss[i]); } else keep.push(ss[i]); }
        return { text: (keep.length ? keep.join(' ') + NL : '') + r.lines[0], expanded: [{ kind: kind, items: 1, from: from.join(' ') }] };
      }
      if (!blanksFit(kind, blanks, r.lines.length)) return 'leave';
      /* a list of bare grades only ("Fy and Fu for A36 and A992"): the page answers none of them, so splitting it gains nothing: left as typed */
      if (r.skipped.length >= r.lines.length) return 'leave';
      if (r.lines.length > 8) {
        /* the page letters eight parts at most.  More than eight properties of ONE rolled shape: one look-up of all its properties (the page's answer
           line then lists them all; left alone, the page answers the last one of the list only) */
        if (kind !== 'shape' || !allOfOneShape(r.pairs)) return 'leave';
        stem = collapse(keep.join(' ') + ' ' + instrLine(instr));
        return { text: (stem ? stem + NL : '') + 'All properties of ' + artFor(r.pairs[0].shape) + ' ' + r.pairs[0].shape,
          expanded: [{ kind: kind, items: r.lines.length, from: from.join(' '), note: 'more than eight properties of one shape: one look-up of all of them' }] };
      }
      /* her own quiz writes one look-up to a sentence ("The actual depth of a M8 x 6.5. The section modulus about the strong axis of a WT12 x 185."):
         the page already splits those itself, so they are left exactly as typed */
      if (kind === 'shape' && onePerSentence(ss, infos)) return 'leave';
      stem = collapse(keep.join(' ') + ' ' + instrLine(instr));
      lines = r.lines.map(function (ln, n) { return '(' + String.fromCharCode(97 + n) + ') ' + ln; });
      f = { kind: kind, items: r.lines.length, from: from.join(' ') };
      if (r.skipped.length) f.skipped = r.skipped;
      return { text: (stem ? stem + NL : '') + lines.join(NL), expanded: [f] };
    }
    return null;
  }

  function run(src) {
    var text = String(src).replace(/\r\n?/g, NL), L, r, lead = '', m;
    if (!/\S/.test(text) || text.length > 1600 || NEVER_RE.test(text)) return null;
    /* the question's own number in front ("3. Give ...", "Problem 3:") stays where it is */
    m = /^\s*(?:(?:problem|question|q)\s*\d{1,2}\s*[.:)]?|\d{1,2}[.)])[ \t]+/i.exec(text);
    if (m) { lead = trim(m[0]) + ' '; text = text.slice(m[0].length); }
    if (OTHER_MARKS_RE.test(text)) return null;
    L = lettered(text);
    if (L === 'odd') return null;
    r = L ? runLettered(L) : runPlain(trim(text));
    /* a list typed with the paper's line breaks inside a sentence: read once more as one paragraph */
    if (!r && !L && /\n/.test(trim(text))) r = runPlain(collapse(text));
    if (!r || r === 'leave') return null;                                  /* 'leave' = understood, and deliberately left as typed */
    /* (the number goes on a line of its own when the parts follow at once: "3. (a) ..." on one line hides the (a) from the page's part splitter) */
    r.text = (lead && /^\(a\)/.test(r.text) ? trim(lead) + NL : lead) + r.text;
    return r;
  }

  function expand(text) {
    var src = String(text === undefined || text === null ? '' : text), r = null;
    try { r = run(src); } catch (e) { r = null; }
    if (!r || r.text === src) return { text: src, expanded: [] };
    return r;
  }

  /* WORDINGS: the single-part wordings this file emits (each is tested against the page by expand-test.js) */
  var WORDINGS = {
    shape: ['<Ix|Iy|Sx|Sy|Zx|Zy|rx|ry|tw|tf|bf> of a <shape>: <sym> = ____', 'A of a <shape>: A = ____ in^2', '<d|tdes|tnom> of a <shape>', 'weight per foot of a <shape>',
      '<property in words, no axis given> of a <shape>'],
    K: ['Recommended design K for a column <end condition>: K = ____', 'K for a column <end condition>: K = ____'],
    K_ends: END_TEXT,
    material: ['Fy and Fu for a <W shape (wide flange)|wide flange shape|plate|angle|channel|[rectangular|square|round] HSS|[standard] pipe>: Fy = ____ ksi, Fu = ____ ksi',
      'Fy and Fu for a <shape>: Fy = ____ ksi, Fu = ____ ksi', 'Fy and Fu for <grade> <product>: ...   (only when the page\'s steel for the product is that grade)',
      'Fy and Fu for <grade> steel: ...   (NOT answered by the page today: listed in skipped)'],
    hole: ['What hole diameter is used for a <size> in bolt? hole diameter = ____ in'],
    fcr: ['KL/r = <n>, Fy = <n> ksi: phi Fcr = ____ ksi', 'KL/r = <n>: phi Fcr = ____ ksi'],
    U: ['Shear lag factor U for a <shape> connected through <its flanges|its flange|its web|one leg> with <n> bolts per line: U = ____']
  };

  return { expand: expand, version: 'expand 1 (2026-10-07)', WORDINGS: WORDINGS, _internal: { sentences: sentences, lettered: lettered, PARSE: PARSE } };
});

