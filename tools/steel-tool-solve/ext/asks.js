/* ==== asks.js ==== */
/* asks.js -- UNIT E (10/07): WHAT IS ONLY IN THE DRAWING IS ASKED IN PLAIN WORDS, ONE QUESTION AT A TIME.   ES5 only, ASCII only, no lookbehind.
   Data and pure functions; no DOM.  Loaded before pipeline.js (ext/_order.json); pipeline's SOLVE.wantedBoxes asks it first, ui.js draws one ask.

   WHY.  His own typing, 03:55: "determane the effective net area of w18 x 46 shown in fig p3-23 assume holes are for 3/4 in phi bolts (ans. 9.67 in^2)".
   The words give the shape and the bolt; the drawing gives the rest (2 holes in each flange, 4 bolts in a line, bolts in the flanges).  The page asked
   for two boxes at once (holes per flange AND web holes, with hints); when he typed 2 and 0 the calculator refused "Where is the member connected?"
   and nothing more was asked: a dead end.  An angle with two lines of bolts printed "Ae = 2.33" once he filled what was asked (the number of lines
   stayed at its default of one, so U = 0.60 instead of her 0.80: she counts ALL the fasteners, HW 3-26).  His rule: "the system asking me for more info
   than the words of the problem is a failure unless its picture is important".  So:
     - an ask exists only for a part that names a drawing (part.figure) and whose calculation stopped with MISSING for something a drawing shows;
     - it asks only what the words did not give (a box with a value is never asked), in the order a child would look at the drawing;
     - ONE ask is shown at a time; the next appears when it is answered; a choice is a button;
     - his answers are HELD (vals[si]['_ask:<id>']) and written into the boxes only when the last ask is answered: a box filled half-way lets the
       calculator answer too early (a column given its length alone printed the strength with no brace, case E-15; an angle given its bolts per line
       alone used one line, case E-09);
     - a choice the page cannot work (zig-zag holes in a rolled shape, ends with no K of hers) ends in a stop sentence with no number in it.
   Anything else (no drawing, another refusal, a member the page cannot tell) returns [] and the page asks as before (pipeline's box list).

   ASKS.list(part, vals, run, P) -> [ask, ...]   the asks still open, in order (the page shows the first).  run = the last refused run or null
       (then a trial run is made: the figure tick holds the real run back, and the asks must show before it).  P = pipeline's helpers { runPart }.
   ASKS.apply(part, vals, ask, value) -> keeps his answer; after the last one, writes every held answer into its box.  false = not a valid answer.
   ask = { ask: true, id, si, path, name, kind: 'int' | 'num' | 'choice' | 'stop', q, hint, unit, choices: [{ key, label }], clear: [keys], msg, label, cands: [] } */
(function (root) {
'use strict';

var ASKS = { version: 'asks 1 (2026-10-07)' };

function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function trim(s) { return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }
function given(v) {
  var i, k;
  if (v === undefined || v === null) return false;
  if (Object.prototype.toString.call(v) === '[object Array]') {
    for (i = 0; i < v.length; i++) { if (v[i] && typeof v[i] === 'object') { for (k in v[i]) if (has(v[i], k) && trim(v[i][k]) !== '') return true; } else if (trim(v[i]) !== '') return true; }
    return false;
  }
  return trim(v) !== '';
}
/* "14", "14.5", ".75", "3/4", "1 1/2", "1-1/2" -> number (NaN otherwise) */
function toNum(v) {
  var s = trim(v).replace(/\s*(?:ft|in|')\s*$/i, ''), m;
  if (/^\d+(?:\.\d+)?$|^\.\d+$/.test(s)) return parseFloat(s);
  if ((m = /^(\d+)\s*\/\s*(\d+)$/.exec(s))) return Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : NaN;
  if ((m = /^(\d+)[\s-]+(\d+)\s*\/\s*(\d+)$/.exec(s))) return Number(m[3]) > 0 ? Number(m[1]) + Number(m[2]) / Number(m[3]) : NaN;
  return NaN;
}
function fmt(x) { return String(Math.round(x * 1e6) / 1e6); }
function ownWords(part) { return String(part.ctx || '').slice(part.coverLen || 0); }
function boxOf(st, path) { var i; for (i = 0; i < (st.boxes || []).length; i++) if (st.boxes[i].path === path) return st.boxes[i]; return null; }
function held(v, id) { return trim(v['_ask:' + id]); }
/* a value of a box: what the words gave, else his held answer */
function got(v, name) { return given(v[name]) ? trim(v[name]) : held(v, name); }

/* a shape name in his words ("l5x3x1/2", "w 10 x 45", "wt6x17.5"): its fraction is not a bolt size */
var SHAPE_NAME_RE = /\b(?:2L|WT|MT|ST|MC|HP|HSS|W|M|S|C|L)\s*\d+(?:\.\d+)?(?:\s*[xX*]\s*\d+(?:[.\/-]\d+)*)+/gi;
/* the family of a typed shape name: I (W M S HP), C (C MC), T (WT MT ST), L (L 2L); anything else (HSS, pipe, a bar) is not asked about */
function family(name) {
  var m = /^\s*(2L|WT|MT|ST|MC|HP|HSS|PIPE|W|M|S|C|L)\s*\d/i.exec(String(name || ''));
  if (!m) return '';
  m = m[1].toUpperCase();
  if (m === 'W' || m === 'M' || m === 'S' || m === 'HP') return 'I';
  if (m === 'C' || m === 'MC') return 'C';
  if (m === 'WT' || m === 'MT' || m === 'ST') return 'T';
  if (m === 'L' || m === '2L') return 'L';
  return '';
}

/* ---------------------------------------------------------------------------------------------- the words of the asks (data) */
var PARTS = {
  I: { flange: 'ONE flange (the flat bar at the top or at the bottom of the I)', web: 'the web (the upright middle part of the I)',
       where: [['flanges', 'In the flanges (the top and bottom bars of the I)'], ['web', 'In the web only (the upright middle part of the I)'], ['both', 'In the flanges AND in the web']] },
  C: { flange: 'ONE flange (one of the two short legs of the C)', web: 'the web (the flat back of the C)',
       where: [['web', 'In the web only (the flat back of the C)'], ['flanges', 'In the flanges (the two short legs of the C)'], ['both', 'In the web AND in the flanges']] },
  T: { flange: 'the flange (the flat top bar of the T)', web: 'the stem (the upright part of the T)',
       where: [['flanges', 'In the flange (the flat top bar of the T)'], ['web', 'In the stem only (the upright part of the T)'], ['both', 'In the flange AND in the stem']] }
};
var MEMBER_WORD = { I: 'W shape', C: 'channel', T: 'tee', L: 'angle', P: 'plate' };
var ROWS = [['straight', 'Side by side, in a straight line across the member'], ['zigzag', 'Zig-zag (staggered): some holes are shifted along the member']];
var END_BOTTOM = [['fixed', 'Fixed: built in solid (often drawn with hatching); it cannot turn'], ['pinned', 'Pinned: a pin or hinge (a small circle or triangle); it can turn'], ['free', 'Free: nothing holds it']];
var END_TOP = [['fixed', 'Fixed: built in solid; it cannot turn and cannot move sideways'], ['pinned', 'Pinned: a pin or hinge; it can turn but cannot move sideways'],
  ['sway', 'It cannot turn, but it CAN move sideways'], ['free', 'Free: nothing holds it']];
/* the two ends -> the engine's end condition, which carries her recommended design K (AISC Table C-A-7.1).  Any other pair has none of her K values. */
var ENDS = { 'fixed fixed': 'fixed-fixed', 'fixed pinned': 'fixed-pinned', 'pinned fixed': 'fixed-pinned', 'pinned pinned': 'pinned-pinned',
  'fixed free': 'flagpole', 'fixed sway': 'fixed-sway', 'pinned sway': 'pinned-sway' };
var BRACED = [['no', 'No: nothing holds it between its two ends'], ['mid', 'Yes, once, at mid-height (halfway up)'], ['third', 'Yes, twice, at the third points (two braces evenly spaced)'],
  ['other', 'Yes, somewhere else']];
var HELD_BY = [['simple', 'On a support under each end (a simple span)'], ['cantilever', 'Built into a wall at one end, the other end free (a cantilever)'], ['other', 'Some other way (an overhang, three supports, both ends built in)']];

function mk(si, id, kind, q, msg, extra) {
  var a = { ask: true, id: id, si: si, path: '', name: id, kind: kind, q: q, hint: '', unit: '', choices: null, clear: [], msg: msg, label: q, cands: [] }, k;
  for (k in extra) if (has(extra, k)) a[k] = extra[k];
  return a;
}
function choiceList(pairs) { var out = [], i; for (i = 0; i < pairs.length; i++) out.push({ key: pairs[i][0], label: pairs[i][1] }); return out; }
function stopAsk(si, id, q, msg, clear) { return mk(si, id, 'stop', q, msg, { stop: true, clear: clear || [] }); }

/* "L4x4x1/2", "L3-1/2X3-1/2X1/4" -> true (both legs the same) */
function equalLegs(name) { var m = /^\s*2?L\s*(\d+(?:[-\s]\d+\/\d+)?)\s*[xX*]\s*(\d+(?:[-\s]\d+\/\d+)?)\s*[xX*]/i.exec(String(name || '')); return !!m && m[1].replace(/\s/g, '-') === m[2].replace(/\s/g, '-'); }
/* ---------------------------------------------------------------------------------------------- tension: a W, a channel, a tee, an angle, a plate */
function tensionMember(v) {
  var mem = trim(v.member), shp = trim(v.shape), fam = shp ? family(shp) : '';
  if (mem === 'plate' || !shp) {
    /* a plate only when the words SAY plate and give its size: "what is shear lag? see fig 3-34" reaches this form with no member at all (asking it for a
       width would be asking for something that is in no drawing), and "a plate carries D = 40k ... required gross area" is another question (case E-24) */
    if (mem !== 'plate' || shp || !given(v.width_in) || !given(v.thickness_in)) return '';
    return 'P';
  }
  if (mem === 'angle' || (!mem && fam === 'L')) return fam === 'L' ? 'L' : '';
  if (mem === 'shape' || !mem) return fam === 'I' || fam === 'C' || fam === 'T' ? fam : '';
  return '';
}
function tensionAsks(part, si, st, v, msg) {
  var cap = st.fn === 'tension_capacity', fam = tensionMember(v), out = [], P, where, rows, conn, needF, needW, hasF, hasW, perLine, needU;
  if (!fam || given(v.holes)) return [];                                              /* the hole helper's rows have their own flow */
  if (!/how many holes|Where is the member connected|fasteners per line|use Case 2|Missing: bolt diameter/i.test(msg)) return [];
  conn = trim(v.connection);
  if (conn === 'welded' || conn === 'case2') return [];
  needU = cap && !given(v.U);
  rows = held(v, 'hole_rows');
  if (fam === 'I' || fam === 'C' || fam === 'T') {
    P = PARTS[fam];
    where = held(v, 'where_bolts') || (conn === 'all' ? 'both' : (conn === 'flanges' || conn === 'web' ? conn : ''));
    hasF = !!got(v, 'holes_per_flange'); hasW = !!got(v, 'web_holes');
    if (!where && (needU || (!hasF && !hasW))) return [mk(si, 'where_bolts', 'choice', 'Look at the drawing of the ' + MEMBER_WORD[fam] + ' (its end view, the cross-section). Where are the bolt holes?', msg, { choices: choiceList(P.where) })];
    needF = (where === 'flanges' || where === 'both') && !hasF; needW = (where === 'web' || where === 'both') && !hasW;
    if (needF || needW) {
      if (!rows && !given(v.holes_per_flange) && !given(v.web_holes)) return [mk(si, 'hole_rows', 'choice', 'Look at the bolt holes in the drawing. Are they side by side in a straight line across the member, or shifted along it like a zig-zag?', msg, { choices: choiceList(ROWS) })];
      if (rows === 'zigzag') return [stopAsk(si, 'hole_rows_stop', 'This page cannot work out zig-zag (staggered) holes in a ' + MEMBER_WORD[fam] + ': counting them in a straight line would give a wrong net area. Do not copy a net area or a strength from this page for this question.', msg, ['_ask:hole_rows'])];
      if (needF) out.push(mk(si, 'holes_per_flange', 'int', 'Count the bolt holes in ' + P.flange + ', in one cross-section. How many holes are in that one flange?', msg, { path: 'holes_per_flange', hint: 'Count one flange only: the page takes the other flange to be the same.' }));
      if (needW) out.push(mk(si, 'web_holes', 'int', 'Count the bolt holes in ' + P.web + ', in one cross-section. How many holes are there?', msg, { path: 'web_holes' }));
    }
    conn = conn || (where === 'both' ? 'all' : where);
  } else {
    if (!got(v, 'holes_across')) {
      /* a single line of bolts (the words said so) has one hole in a section: there is nothing to zig-zag ("a single lineof four 7/8-in-dia bolts", BC-003~H2) */
      if (!rows && !(trim(v.fastener_lines) === '1' || /\b(?:single|one)\s*line/i.test(ownWords(part)))) return [mk(si, 'hole_rows', 'choice', 'Look at the bolt holes in the drawing. Are they side by side in a straight line across the member, or shifted along it like a zig-zag?', msg, { choices: choiceList(ROWS) })];
      if (rows === 'zigzag') {
        if (fam === 'P') return [stopAsk(si, 'hole_rows_stop', 'Use the hole helper in the figure box above, part B (the holes ZIG-ZAG): type the distances across the plate and the stagger there. The answer then appears by itself.', msg, ['_ask:hole_rows'])];
        return [stopAsk(si, 'hole_rows_stop', 'This page cannot work out zig-zag (staggered) holes in an angle from your answers: counting them in a straight line would give a wrong net area. Do not copy a net area or a strength from this page for this question.', msg, ['_ask:hole_rows'])];
      }
      out.push(mk(si, 'holes_across', 'int', fam === 'P' ? 'Look at the drawing of the plate. How many bolt holes are side by side in ONE row across the plate?'
        : 'Look at the end view of the angle. How many bolt holes does one straight cut across the angle go through?', msg, { path: 'holes_across', hint: fam === 'P' ? '' : 'Count the holes side by side in one cross-section. If two angles are back to back, count ONE angle.' }));
    }
    conn = conn || (fam === 'P' ? 'all' : 'angle');
  }
  /* U: the bolts counted along the member (her Case 7 and Case 8), only when the connection needs them */
  if (needU && (conn === 'flanges' || conn === 'web' || conn === 'angle')) {
    if (!got(v, 'fasteners_per_line')) out.push(mk(si, 'fasteners_per_line', 'int', 'Look at the side view (the member drawn along its length). How many bolts are in ONE line, one behind the other in the direction of the pull?', msg, { path: 'fasteners_per_line', hint: 'Count one line only.' }));
    /* an angle with two or more holes side by side has that many lines of bolts; she counts ALL the fasteners (HW 3-26: two lines of 3 = 6, U = 0.80); the
       default of one line gave U = 0.60 (case E-09) */
    if (fam === 'L' && !got(v, 'fastener_lines') && toNum(got(v, 'holes_across')) >= 2) out.push(mk(si, 'fastener_lines', 'int', 'How many LINES of bolts run along the angle, side by side? (One line = bolts one behind the other along the member.)', msg, { path: 'fastener_lines' }));
  }
  /* Case 2 (U = 1 - x-bar / l): l is in the side view; x-bar the calculator takes from the Manual (x of a channel or an angle, y of a tee), which is the
     distance from the CONNECTED face only for a channel through its web, a tee through its flange, or an angle with equal legs (an unequal angle bolted
     through its short leg needs y, not x).  Anything else: the calculator's own message stands. */
  perLine = toNum(got(v, 'fasteners_per_line'));
  if (!out.length && needU && /use Case 2/i.test(msg) && ((fam === 'C' && conn === 'web') || (fam === 'T' && conn === 'flanges') || (fam === 'L' && equalLegs(v.shape)))
    && !given(v.xbar_in) && !given(v.l_in) && !given(v.pitch_in) && !held(v, 'bolt_spacing') && perLine >= 2) {
    out.push(mk(si, 'bolt_spacing', 'num', 'Look at the side view. How far apart are two neighbouring bolts of one line, center to center?', msg, { unit: 'in', hint: 'The page takes the length of the connection as (bolts in the line - 1) x this spacing.' }));
  }
  /* the bolt size: in the drawing's note when the words do not give it.  Words with a fraction or "dia" in them DO give it ("2 lines of 7/8in bolst",
     BC-014~H3: the reader did not take it); asking would be asking for what the words give, so the calculator's own message stands there */
  if (!out.length && /Missing: bolt diameter/i.test(msg) && !given(v.hole_dia_in) && !got(v, 'bolt_dia_in') && !/\d\s*\/\s*\d|\bdia|\d\s*(?:in\b|")/i.test(ownWords(part).replace(SHAPE_NAME_RE, ' '))) out.push(mk(si, 'bolt_dia_in', 'num', 'What size are the bolts (their diameter)? The drawing or its note gives it, for example 3/4 in.', msg, { path: 'bolt_dia_in', unit: 'in' }));
  return out;
}
/* the boxes his answers decide: the connection (from where the bolts are), the length of the connection (from the spacing) */
function tensionSettle(st, v) {
  var where = held(v, 'where_bolts'), n = toNum(v.fasteners_per_line), s = toNum(held(v, 'bolt_spacing'));
  if (where && boxOf(st, 'connection') && !given(v.connection)) v.connection = where === 'both' ? 'all' : where;
  if (s > 0 && n >= 2 && boxOf(st, 'l_in') && !given(v.l_in)) v.l_in = fmt((n - 1) * s);
}

/* ---------------------------------------------------------------------------------------------- a column: its length, its ends, its braces */
function columnAsks(part, si, st, v, msg) {
  var key, end, b, own = ownWords(part);
  if (!/Enter the effective length|Missing: the strong axis (?:member length|end condition)/i.test(msg)) return [];
  if (!given(v.shape) || given(v.KLx_ft) || given(v.y_segments)) return [];
  /* never ask what the words give: "kxlx = 30ft and kyly = 15 ft" that the reader did not take (BC-053~M1) is an EFFECTIVE length -- asked as the column's
     length and multiplied by K again it would be wrong.  And only a question about the column's strength or load: "a w14x53 column is being checked for
     buckling, give its radii of gyration rx and ry" (BL-012~M2) reaches this form too, and its drawing holds no answer to a length question. */
  if (/\bk\s*[xy]?\s*l\s*[xy]?\b|\bk\s*[xy]?\s*=\s*[0-9.]|effective\s+length|slender/i.test(own)) return [];
  if (!/stren|capac|phi\s*-?\s*p|\bp\s*n\b|pn\b|adequ|\bsafe|support|carry|resist|load/i.test(own)) return [];
  if (!got(v, 'Lx_ft')) return [mk(si, 'Lx_ft', 'num', 'Look at the drawing of the column. How long is it, from the support at the bottom to the support at the top?', msg, { path: 'Lx_ft', unit: 'ft' })];
  end = trim(v.x_end_condition);
  if (!end) {
    if (!held(v, 'end_bottom')) return [mk(si, 'end_bottom', 'choice', 'How is the BOTTOM end of the column held in the drawing?', msg, { choices: choiceList(END_BOTTOM) })];
    if (!held(v, 'end_top')) return [mk(si, 'end_top', 'choice', 'How is the TOP end of the column held in the drawing?', msg, { choices: choiceList(END_TOP) })];
    key = held(v, 'end_bottom') + ' ' + held(v, 'end_top');
    if (!has(ENDS, key)) return [stopAsk(si, 'ends_stop', 'This page has none of her K values for a column held this way at its two ends. Do not copy a strength from this page for this question.', msg, ['_ask:end_bottom', '_ask:end_top'])];
    end = ENDS[key];
  }
  /* the weak axis: the drawing shows a brace part-way up, or nothing.  Asked whenever the words gave no weak-axis length of its own (the calculator
     would use the strong-axis length for both: a column braced at its third points in the drawing printed the unbraced strength, case E-15).  The reader
     copies "16 ft long" into BOTH lengths; a weak-axis length equal to the member length is that copy, not a brace the words gave. */
  if (lyOwn(v)) return [];
  b = held(v, 'braced');
  if (!b) return [mk(si, 'braced', 'choice', 'Look at the drawing again. Is the column held sideways somewhere between its two ends (a brace or a beam joining it part-way up)?', msg, { choices: choiceList(BRACED) })];
  if (b === 'no') return [];
  /* a braced piece of a column whose ends are not both pinned has its own K at each end: not from these answers */
  if (end !== 'pinned-pinned' || (given(v.y_end_condition) && trim(v.y_end_condition) !== 'pinned-pinned')) return [stopAsk(si, 'braced_stop', 'This page cannot take a brace part-way up from your answers when the column ends are not both pinned. Do not copy a strength from this page for this question.', msg, ['_ask:braced'])];
  /* held as brace_len, not Ly_ft: the settle step writes it over the reader's copy of the member length */
  if ((b === 'other' || !(toNum(got(v, 'Lx_ft')) > 0)) && !held(v, 'brace_len')) return [mk(si, 'brace_len', 'num', 'How long is the LONGEST piece of the column between two braces (or between a brace and an end)?', msg, { path: 'Ly_ft', unit: 'ft' })];
  return [];
}
function lyOwn(v) { return given(v.KLy_ft) || (given(v.Ly_ft) && !(toNum(v.Ly_ft) === toNum(got(v, 'Lx_ft')))); }
function columnSettle(st, v) {
  var key = held(v, 'end_bottom') + ' ' + held(v, 'end_top'), b = held(v, 'braced'), lx = toNum(got(v, 'Lx_ft')), byAsk = false;
  if (!given(v.x_end_condition) && has(ENDS, key)) { v.x_end_condition = ENDS[key]; byAsk = true; }
  if (b && b !== 'no' && !lyOwn(v) && trim(v.x_end_condition) === 'pinned-pinned' && (!given(v.y_end_condition) || trim(v.y_end_condition) === 'pinned-pinned')) {
    /* his answer replaces the copy of the member length (see columnAsks) */
    if (b === 'mid' || b === 'third') { if (lx > 0) v.Ly_ft = fmt(lx / (b === 'mid' ? 2 : 3)); }
    else if (held(v, 'brace_len')) v.Ly_ft = held(v, 'brace_len');
    if (!given(v.y_end_condition)) v.y_end_condition = 'pinned-pinned';
  } else if (b === 'no' && byAsk && !given(v.y_end_condition) && given(v.Ly_ft)) v.y_end_condition = v.x_end_condition;   /* no brace: the same two ends hold both axes */
}

/* ---------------------------------------------------------------------------------------------- a beam: its span (and how it is held) */
function beamAsks(part, si, st, v) {
  var h;
  if (given(v.span_ft)) return [];
  /* only a beam whose loads the words gave: "As shown what is the plastic section modulus Zx of a W16x40" lands here with no load at all (case E-22) */
  if (!given(v.wD) && !given(v.wL) && !given(v.w_u) && !given(v.point_loads)) return [];
  h = held(v, 'held_by');
  if (!h && !/simpl|support|cantilever|overhang|fixed|\bwall\b|propped|continuous|\bpin|\bspan/i.test(ownWords(part))) return [mk(si, 'held_by', 'choice', 'Look at the drawing of the beam. How is it held up?', '', { choices: choiceList(HELD_BY) })];
  if (h === 'other') return [stopAsk(si, 'held_by_stop', 'This page works a simple span or a cantilever only. Do not copy a moment from this page for this question.', '', ['_ask:held_by'])];
  if (h === 'cantilever' && given(v.point_loads)) return [stopAsk(si, 'held_by_stop', 'A cantilever with loads at points: type each load and where it stands (measured from the wall) in the boxes below; the page does not ask them one by one.', '', ['_ask:held_by'])];
  if (held(v, 'span_ft')) return [];
  return [mk(si, 'span_ft', 'num', trim(v.support) === 'cantilever' || h === 'cantilever' ? 'Look at the drawing of the beam. How long is it, from the wall to its free end?' : 'Look at the drawing of the beam. How long is it, from one support to the other (the span)?', '', { path: 'span_ft', unit: 'ft' })];
}
function beamSettle(st, v) { var h = held(v, 'held_by'); if ((h === 'simple' || h === 'cantilever') && boxOf(st, 'support')) v.support = h; }

/* ---------------------------------------------------------------------------------------------- a floor plan: the beam and girder dimensions */
function floorAsks(part, si, st, v, msg) {
  var out = [];
  if (/Step 2 needs the beam span/i.test(msg) && !got(v, 'beam_span_ft')) out.push(mk(si, 'beam_span_ft', 'num', 'Look at the floor plan. How long is one beam, from the girder at one end to the girder at the other?', msg, { path: 'beam_span_ft', unit: 'ft', hint: 'The beams are the many lines side by side; read the dimension written ALONG a beam.' }));
  if (/Step 2 needs the beam (?:span|spacing)/i.test(msg) && !got(v, 'beam_spacing_ft') && !given(v.beam_tributary_ft)) out.push(mk(si, 'beam_spacing_ft', 'num', 'Look at the floor plan. How far apart are the beams, from one beam line to the next?', msg, { path: 'beam_spacing_ft', unit: 'ft', hint: 'Read the dimension written ACROSS the beams.' }));
  if (/Step 3 needs the girder span/i.test(msg) && !got(v, 'girder_span_ft')) out.push(mk(si, 'girder_span_ft', 'num', 'Look at the floor plan. How long is the girder (the member the beams rest on), from column to column?', msg, { path: 'girder_span_ft', unit: 'ft' }));
  return out;
}

/* ---------------------------------------------------------------------------------------------- a load takedown: how many floors */
function takedownAsks(part, si, st, v, msg) {
  if (!/found no floor and no roof/i.test(msg) || got(v, 'floors')) return [];
  if (!given(v.floor_D_psf) && !given(v.floor_L_psf) && !given(v.floor_slab_in)) return [];
  if (!given(v.tributary_area_sf) && !(given(v.bay_x_ft) && given(v.bay_y_ft))) return [];
  return [mk(si, 'floors', 'int', 'Look at the drawing of the building. How many FLOORS does this column hold up?', msg, { path: 'floors', hint: 'Count the floor levels above the foundation. The roof is not a floor.' })];
}

var HANDLERS = { tension_capacity: tensionAsks, tension_net_area: tensionAsks, column_capacity: columnAsks, beam_analysis: beamAsks, floor_plan: floorAsks, loads_takedown: takedownAsks };
var SETTLE = { tension_capacity: tensionSettle, tension_net_area: tensionSettle, column_capacity: columnSettle, beam_analysis: beamSettle };

ASKS.list = function (part, vals, run, P) {
  var r = run, si, sr, st, msg, h, v, out;
  if (!part || part.kind !== 'form' || !part.figure || !vals || !part.stages) return [];
  if (!r) { if (!P || !P.runPart) return []; try { r = P.runPart(part, vals); } catch (e) { return []; } }
  if (!r || r.ok || !(r.failedAt >= 0)) return [];
  si = r.failedAt; sr = r.stages[si]; st = part.stages[si]; v = vals[si];
  if (!st || !st.boxes || !sr || sr.skipped || !v) return [];
  /* only a value the calculator says is MISSING: a page stop, a question outside the page, a refused or ambiguous value is never answered with an ask.
     (A beam whose span box is empty: its trial run is refused for the span itself.) */
  if ((!sr.res || !sr.res.error || sr.res.error.code !== 'MISSING') && !(st.fn === 'beam_analysis' && !given(v.span_ft))) return [];
  h = HANDLERS[st.fn];
  if (!h) return [];
  msg = sr.res && sr.res.error ? String(sr.res.error.message || '') : '';
  try { out = h(part, si, st, v, msg) || []; } catch (e2) { out = []; }
  return out;
};

/* his answer to one ask: held; after the last ask of the part, every held answer goes into its box (only a box the words left empty) */
ASKS.apply = function (part, vals, ask, value) {
  var si = ask.si, v = vals[si], st = part.stages[si], i, s, k, left, b;
  if (!v || !st || !HANDLERS[st.fn]) return false;
  if (ask.kind === 'stop') { for (i = 0; i < (ask.clear || []).length; i++) delete v[ask.clear[i]]; return true; }
  if (ask.kind === 'choice') {
    for (i = 0; i < (ask.choices || []).length; i++) if (ask.choices[i].key === String(value)) break;
    if (i >= (ask.choices || []).length) return false;
    v['_ask:' + ask.id] = String(value);
  } else {
    s = trim(value);
    if (!(toNum(s) >= 0) || (ask.kind === 'int' && !/^\d+$/.test(s))) return false;
    v['_ask:' + ask.id] = s;
  }
  try { left = HANDLERS[st.fn](part, si, st, v, ask.msg || '') || []; } catch (e) { left = [{ stop: true }]; }
  if (left.length) return true;
  for (k in v) {
    if (!has(v, k) || k.slice(0, 5) !== '_ask:') continue;
    b = boxOf(st, k.slice(5));
    if (b && (b.kind === 'num' || b.kind === 'int') && !given(v[b.path])) v[b.path] = v[k];
  }
  if (SETTLE[st.fn]) SETTLE[st.fn](st, v);
  return true;
};

root.STEEL_ASKS = ASKS;
if (typeof module !== 'undefined' && module.exports) module.exports = ASKS;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
