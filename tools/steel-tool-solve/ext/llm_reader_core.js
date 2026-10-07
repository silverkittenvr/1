/* ==== llm_reader_core.js ==== */
/* llm_reader_core.js -- the portable CORE of the LLM "reader" for the steel calculator's form boxes.
   ES5 ONLY (no arrow functions, no let/const, no template strings, no Promise/Map/Set).  ASCII only.  It touches no file, no network, no
   process, no require: the model is reached through ONE injected function.

       LLMREADER.fill(problemText, formName, callModel, opts)

   callModel(body) receives the request body for Ollama's POST /api/chat  ({model, messages, format:'json', stream:false, think:false, options})
   and returns the PARSED JSON object the model produced (or its raw text: the core parses that tolerantly) -- or a thenable of either (a browser
   supplies a fetch()-based one).  fill() returns the verified result, or a thenable of it when callModel returned one; it never throws.
   opts.engine = the STEEL object (default root.STEEL).  opts.model = the Ollama model name.

   CHANGED FROM THE FIRST DRAFT (core-0.1) -- see PROGRESS.md / REPORT.md:
     * the request no longer carries a JSON schema in `format`.  On Ollama 0.24.0 schema-constrained decoding garbles hermies-14b's JSON
       (strings end in  '}, "  and the object never closes); format:'json' (syntax only) is clean.  The answer shape is taught in the prompt and
       EVERY safety property is enforced afterwards by verify(), which never trusted the decoder anyway.
     * a missing key / a list the model did not mention is "empty", not "rejected"; "unclear" may be a list of names or of {box, quote};
       the model may answer with text; objects of nulls are "empty".
     * verify() reports WHERE the quote sits in the problem (detail[box].at, res.problem) and the value it would have used for a rejected
       box (detail[box].proposed), and res.unplaced = the numbers-with-units in the problem that no accepted box used.

   WHAT THE MODEL MAY DO (the owner's rule: it never computes and has no opening to make things up).  For every box of the form it may only
     - answer null (the problem does not state it), or
     - POINT at words:   { quote: <exact words of the problem>, text: <the value exactly as written inside the quote>, unit: <one of a fixed list> }
     - PICK from the box's own closed list: { quote: <exact words that decide it>, value: <one option> }
   and the PROGRAM verifies every answer (verify()): the quote must be a substring of the problem (whitespace / quote-mark / dash / case
   normalised), the text must sit inside the quote as a whole number token, CODE parses the number (7/8, 1 1/2, 1-1/2, 29,000, 18 ft 6 in, three)
   and converts units, the unit must be written right next to the number, the quote must not hold a second value of the same kind (opts.strictQuote),
   the value must respect the engine's own min/max, a choice must be one of the engine's options.  Anything that fails is REJECTED and becomes a
   question for the student -- never a filled box.  List boxes (point loads, hole positions, segments) are all-or-nothing: one rejected item
   withholds the whole list and raises a question.  A box the model calls "unclear" (the problem speaks of it but gives no copyable value: it
   needs arithmetic, a figure, a judgement) also becomes a question and its value is withheld.

   Result of fill():
     { ok, version, form, args, fields, detail, questions, unfilled, unplaced, problem, raw, error, request }
       args      nested object ready for STEEL.run(form, args)           (only boxes that passed every check)
       detail    { <box path>: { status: 'filled'|'rejected'|'empty'|'unclear', value, quote, text, unit, reason, at, proposed } }
       questions [ { field, reason, quote, kind } ]                      (what the student must be asked)
       unplaced  [ { text, value, unit, at } ]                           (numbers in the problem no accepted box used: show them)
       problem   the problem text as the checks saw it (whitespace collapsed); detail[].at and unplaced[].at index into it
*/
(function (root) {
'use strict';

var VERSION = 'llmreader-core-0.2';

/* ------------------------------------------------------------------------------------------------ prompt text */
function buildSystem(withUnclear) {
  var L = [
    'You are a careful reader of engineering problems. You are given a PROBLEM and the BOXES of a calculator form. For each box decide whether the problem ITSELF states the value (or states the choice). You are a reader, not a calculator: never compute, convert, round or guess, and never use anything you know from outside the problem.',
    '',
    'Answer with ONE JSON object and nothing else. Its keys are the box names exactly as listed, in the listed order' + (withUnclear ? ', then "unclear"' : '') + '. A box the problem does not state is null.',
    'How to answer each kind of box:',
    '  number box:  {"quote": "...", "text": "...", "unit": "..."}',
    '  name box:    {"quote": "...", "text": "..."}',
    '  choice box:  {"quote": "...", "value": "..."}',
    '  yes/no box:  {"quote": "...", "value": "yes"}   (or "no")',
    '  list box:    an array; each item answers the item boxes listed for it (number or choice boxes as above); null when the problem lists none'
  ];
  if (withUnclear) L.push('  "unclear":   an array of {"box": "<box name>", "quote": "<words>"}');
  L.push('',
    'Rules:',
    '1. quote = the SHORTEST exact words of the PROBLEM that hold the value, its unit and the words saying what it is. Copy them character for character from the problem text (never from the box descriptions or the option lists). Never reword, never join two places, never put two different values in one quote.',
    '2. text = the number exactly as printed inside the quote (7/8, 1 1/2, 36, 29,000, 0.85, 18 ft 6 in, or a number word such as three for a count); for a name, only the name itself (W14 x 90, not "A W14 x 90"). Never convert units, never add, divide or round: if the problem says 300 in and the box wants feet, answer text 300 and unit in.',
    '3. unit = the unit printed next to the number, taken from that box\'s unit choices (lb/ft is not psf; kips is not kip-ft). A choice box has "value" (one of its options), never "text".',
    '4. A value given in a general defaults line ("unless noted otherwise, assume Fy = 50 ksi, pinned ends, K = 1.0") counts as stated. A value given for this particular case beats a general default.',
    '5. Never work a value out. If a box would need arithmetic (a third of a length, a sum or product of loads, a line load from a load per area, a position from a spacing) or only a figure shows it, answer null for that box' + (withUnclear ? ' and add it to "unclear" with the words of the problem that carry the figures (at most 4 entries; a box the problem never mentions is simply null).' : '.'),
    '6. Fill a box only when the words are there. Do not fill a box because a value would be typical.',
    '7. For a choice, value must be exactly one of the listed options, and the quote must contain the words that decide it. A yes/no box is "yes" only when the problem says what the box says.',
    '8. When one statement gives the value for several boxes, fill every box it applies to, quoting the same words (for example one length and one end condition given for a column without naming an axis apply to BOTH axes: fill the x boxes and the y boxes).',
    '',
    'EXAMPLE (a made-up form, to show the shape of the answer)',
    'Boxes:',
    '  width (number; unit choices: in, ft)',
    '  depth (number; unit choices: in, ft)',
    '  load (number; unit choices: kips, lb)',
    '  material (choice; options: wood, steel)',
    '  painted (yes/no)',
    '  holes (list); each item has: diameter (number; unit choices: in), count (whole number)',
    'Problem: "A steel plate is 3 ft wide and its depth is a third of the width. It carries 500 lb. The plate is not painted. It has 2 holes of 3/4-in diameter."',
    'Answer:',
    '{"width": {"quote": "3 ft wide", "text": "3", "unit": "ft"}, "depth": null, "load": {"quote": "carries 500 lb", "text": "500", "unit": "lb"}, "material": {"quote": "A steel plate", "value": "steel"}, "painted": {"quote": "is not painted", "value": "no"}, "holes": [{"diameter": {"quote": "3/4-in diameter", "text": "3/4", "unit": "in"}, "count": {"quote": "2 holes", "text": "2"}}]' + (withUnclear ? ', "unclear": [{"box": "depth", "quote": "its depth is a third of the width"}]' : '') + '}');
  return L.join('\n');
}
var PROMPT = { system: buildSystem(false), systemWithUnclear: buildSystem(true) };

/* ------------------------------------------------------------------------------------------------ text helpers */
function codes(list) { var s = '', i; for (i = 0; i < list.length; i++) s += String.fromCharCode(list[i]); return s; }
var CHARMAP = {}, CHARCLASS = '';
(function () {
  function add(list, rep) { var i, ch; for (i = 0; i < list.length; i++) { ch = String.fromCharCode(list[i]); CHARMAP[ch] = rep; CHARCLASS += ch; } }
  add([0xa0, 0x2007, 0x202f, 0x200b, 0x2009, 0x2002, 0x2003, 0xfeff], ' ');
  add([0x2018, 0x2019, 0x2bc, 0x2032], "'");
  add([0x201c, 0x201d, 0x2033], '"');
  add([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212], '-');
  add([0xb2], '^2'); add([0xb3], '^3'); add([0xb7], '*'); add([0xd7], 'x');
})();
var CHARRE = new RegExp('[' + CHARCLASS + ']', 'g');
function normText(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(CHARRE, function (ch) { return CHARMAP[ch]; })
    .replace(/\s+/g, ' ')
    .replace(/^ | $/g, '');
}
function isStr(x) { return typeof x === 'string'; }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function rnd9(x) { return Math.round(x * 1e9) / 1e9; }

/* ------------------------------------------------------------------------------------------------ number parsing (CODE reads the number, never the model) */
var WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, single: 1, double: 2 };
var UFRAC = {};
UFRAC[String.fromCharCode(0xbd)] = 0.5; UFRAC[String.fromCharCode(0xbc)] = 0.25; UFRAC[String.fromCharCode(0xbe)] = 0.75;
UFRAC[String.fromCharCode(0x215b)] = 0.125; UFRAC[String.fromCharCode(0x215c)] = 0.375; UFRAC[String.fromCharCode(0x215d)] = 0.625; UFRAC[String.fromCharCode(0x215e)] = 0.875;
var UFRAC_RE = new RegExp('^([-+]?\\d+)?\\s*([' + codes([0xbd, 0xbc, 0xbe, 0x215b, 0x215c, 0x215d, 0x215e]) + '])$');

/* a number written as a number: 3 | 2.5 | .5 | 29,000 | 7/8 | 1 1/2 | 1-1/2 | a unicode fraction.  null when it is anything else. */
function parseBare(s) {
  var m, t = normText(s), u, k;
  if (!t) return null;
  if ((m = UFRAC_RE.exec(t))) { u = UFRAC[m[2]]; k = m[1] ? Number(m[1]) : 0; return k < 0 ? k - u : k + u; }
  if (/^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''));
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
  if ((m = /^(\d+)\s*\/\s*(\d+)$/.exec(t))) return Number(m[2]) === 0 ? null : Number(m[1]) / Number(m[2]);
  if ((m = /^(\d+)\s*[- ]\s*(\d+)\s*\/\s*(\d+)$/.exec(t))) return Number(m[3]) === 0 ? null : Number(m[1]) + Number(m[2]) / Number(m[3]);
  return null;
}
/* a value as the problem writes it.  Returns {value, composite} or null.  composite = a feet-and-inches value (18 ft 6 in, 18'-6") read as feet. */
function parseNumberText(raw, allowWords) {
  var t = normText(raw), m, inch, v;
  if (!t) return null;
  m = /^(\d+(?:\.\d+)?)\s*(?:ft\.?|feet|foot|')\s*-?\s*(\d+(?:\s+\d+\/\d+|\/\d+|\.\d+)?)\s*(?:in\.?|inch(?:es)?|")?$/i.exec(t);
  if (m) { inch = parseBare(m[2]); if (inch !== null) return { value: Number(m[1]) + inch / 12, composite: true }; }
  v = parseBare(t);
  if (v !== null) return { value: v, composite: false };
  if (allowWords && WORDNUM.hasOwnProperty(t.toLowerCase())) return { value: WORDNUM[t.toLowerCase()], composite: false };
  return null;
}

/* ------------------------------------------------------------------------------------------------ units: a fixed enum per box, code converts */
var TOK = {
  'in': /(?:in\.?|inch(?:es)?|"|'')(?![A-Za-z\^\d])/,
  'ft': /(?:ft\.?|feet|foot|')(?![A-Za-z\^\d])/,
  'kips': /(?:kips?|k)(?![A-Za-z\/\^\d]|\s*-\s*(?:ft|in)\b)/,
  'lb': /(?:lbs?\.?|pounds?)(?![A-Za-z\/])/,
  'ksi': /ksi(?![A-Za-z])/,
  'psi': /psi(?![A-Za-z])/,
  'psf': /(?:psf|lbs?\.?\s*\/\s*(?:ft|sq\.?\s*ft|sf)\s*(?:\^\s*2|2)|lbs?\s*\/\s*sf|pounds? per square foot)(?![A-Za-z])/,
  'pcf': /(?:pcf|lbs?\.?\s*\/\s*ft\s*(?:\^\s*3|3)|lbs?\s*\/\s*cu\.?\s*ft|pounds? per cubic foot)(?![A-Za-z])/,
  'k/ft': /(?:k\s*\/\s*ft|kips?\s*\/\s*(?:ft|foot)|klf)(?![A-Za-z\^\d])/,
  'lb/ft': /(?:lbs?\.?\s*\/\s*(?:ft|foot)(?![\^\d])|plf|pounds? per (?:foot|ft))(?![A-Za-z])/,
  'kip-ft': /(?:kips?\s*-\s*ft|k\s*-\s*ft|kip\s*ft|kips?\s*\*\s*ft|kip-feet|ft\s*-\s*kips?|ft\s*-\s*k)(?![A-Za-z])/,
  'kip-in': /(?:kips?\s*-\s*in|k\s*-\s*in|kip\s*in|kips?\s*\*\s*in|in\s*-\s*kips?|in\s*-\s*k)(?![A-Za-z])/,
  'sq ft': /(?:sq\.?\s*ft|sf|ft\s*\^?\s*2|square (?:feet|foot))(?![A-Za-z])/,
  'in^2': /(?:in\s*\^\s*2|sq\.?\s*in|in2)(?![A-Za-z])/
};
/* field unit -> the units the model may name, and the factor that turns each into the field's own unit (value * factor) */
var UNITSET = {
  'in': { 'in': 1, 'ft': 12, 'ft-in': 12 },
  'ft': { 'ft': 1, 'in': 1 / 12, 'ft-in': 1 },
  'kips': { 'kips': 1, 'lb': 1 / 1000 },
  'ksi': { 'ksi': 1, 'psi': 1 / 1000 },
  'psf': { 'psf': 1 },
  'pcf': { 'pcf': 1 },
  'k/ft': { 'k/ft': 1, 'lb/ft': 1 / 1000 },
  'lb/ft': { 'lb/ft': 1, 'k/ft': 1000 },
  'kip-ft': { 'kip-ft': 1, 'kip-in': 1 / 12 },
  'sq ft': { 'sq ft': 1 },
  'in^2': { 'in^2': 1 }
};
function unitEnum(fieldUnit) {
  var set = UNITSET[fieldUnit], k, out = [];
  if (!set) return null;
  for (k in set) if (set.hasOwnProperty(k)) out.push(k);
  return out;
}
/* is the unit `u` written right after position `pos` of `q` (an optional space or hyphen between)? */
function unitAfter(q, pos, u) {
  var rest = q.slice(pos), re;
  if (u === 'ft-in') return /^\s*-?\s*(?:ft\.?|feet|foot|')/i.test(rest);
  if (!TOK[u]) return false;
  re = new RegExp('^\\s*-?\\s*' + TOK[u].source, 'i');
  return re.test(rest);
}
/* the model glued the unit to the text ("24 ft", "7/8 in"): peel it off.  returns {text, unit} or null */
function stripUnitFromText(t, allowed) {
  var i, u, re, m;
  for (i = 0; i < allowed.length; i++) {
    u = allowed[i];
    if (u === 'ft-in' || !TOK[u]) continue;
    re = new RegExp('^(.*?\\d)\\s*-?\\s*(?:' + TOK[u].source + ')\\s*$', 'i');
    m = re.exec(t);
    if (m) return { text: m[1], unit: u };
  }
  return null;
}

/* where does the number text `t` sit inside the quote `q` as a WHOLE number token?  returns the index or -1.  Never the "1" of "10", the "5" of
   "2.5", the "1/2" of "1 1/2", the "14" of "W14x90", the "4" of "6 x 4". */
function locateToken(q, t) {
  var from = 0, i, before, after, a2, pre, post, bad, startsDigit = /^[\d.]/.test(t), endsDigit = /\d$/.test(t), isFrac = /^\d+\s*\/\s*\d+$/.test(t), startsLetter = /^[A-Za-z]/.test(t);
  if (!t) return -1;
  for (;;) {
    i = q.indexOf(t, from);
    if (i < 0) return -1;
    before = i > 0 ? q.charAt(i - 1) : '';
    after = q.charAt(i + t.length);
    a2 = q.charAt(i + t.length + 1);
    pre = q.slice(Math.max(0, i - 12), i);
    post = q.slice(i + t.length, i + t.length + 4);
    bad = false;
    if (startsDigit && (/[\d.A-Za-z]/.test(before) || (before === ',' && /\d/.test(q.charAt(i - 2))))) bad = true;
    if (isFrac && /\d\s*-?\s*$/.test(pre)) bad = true;
    if (endsDigit && (/\d/.test(after) || (after === '.' && /\d/.test(a2)) || (after === '/' && /\d/.test(a2)) || (after === ',' && /\d{3}/.test(post)) || /^\s*[xX]\s*\d/.test(q.slice(i + t.length)))) bad = true;
    if (startsLetter && /[A-Za-z0-9]/.test(before)) bad = true;
    if (!bad) return i;
    from = i + 1;
  }
}

/* ------------------------------------------------------------------------------------------------ numbers WITH UNITS found in a text (the quote-ambiguity guard and the "unplaced" list) */
var NUMRE = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\s*-\\s*\\d+\\/\\d+|\\d+\\/\\d+|\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d*\\.\\d+|\\d+)';
var UNITRE = '(?:kips?\\s*-\\s*ft|k\\s*-\\s*ft|kips?\\s*-\\s*in|k\\s*-\\s*in|kips?\\s*\\/\\s*(?:ft|foot)|k\\s*\\/\\s*ft|klf|lbs?\\.?\\s*\\/\\s*(?:ft|foot)(?![\\^\\d])|plf|lbs?\\.?\\s*\\/\\s*(?:ft|sq\\.?\\s*ft|sf)\\s*(?:\\^\\s*[23]|[23])?|lbs?\\.?\\s*\\/\\s*cu\\.?\\s*ft|pcf|psf|psi|ksi|kips?|k(?![A-Za-z\\/\\-])|lbs?\\.?|pounds?|ft\\s*\\^\\s*2|sq\\.?\\s*ft|square (?:feet|foot)|sq\\.?\\s*in|in\\s*\\^\\s*2|feet|foot|ft\\.?|inch(?:es)?|in\\.?|"|\'\')(?![A-Za-z\\^])';
/* returns [{start, end, text, value, unit}]; composite 18 ft 6 in / 18'-6" counted once.  Units are the printed words, lower-cased. */
function valuesWithUnits(s) {
  var out = [], used = [], m, re, inch, comp, i, j, ov;
  function overlaps(a, b) { var k; for (k = 0; k < used.length; k++) if (a < used[k][1] && b > used[k][0]) return true; return false; }
  re = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(?:ft\\.?|feet|foot|\')\\s*-?\\s*(\\d+(?:\\s+\\d+\\/\\d+|\\/\\d+|\\.\\d+)?)\\s*(?:in\\.?|inch(?:es)?|")', 'gi');
  while ((m = re.exec(s)) !== null) {
    inch = parseBare(m[2]);
    if (inch === null) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], value: Number(m[1]) + inch / 12, unit: 'ft-in' });
    used.push([m.index, m.index + m[0].length]);
  }
  re = new RegExp('(^|[^A-Za-z0-9.\\/])(' + NUMRE + ')\\s*-?\\s*(' + UNITRE + ')', 'gi');
  while ((m = re.exec(s)) !== null) {
    i = m.index + m[1].length; j = m.index + m[0].length;
    if (overlaps(i, j)) continue;
    comp = parseBare(m[2].replace(/(\d)\s*-\s*(\d+\/)/, '$1 $2'));
    if (comp === null) continue;
    out.push({ start: i, end: j, text: m[2] + ' ' + m[3], value: comp, unit: String(m[3]).toLowerCase().replace(/\s+/g, '') });
    used.push([i, j]);
  }
  out.sort(function (a, b) { return a.start - b.start; });
  return out;
}
/* the unit families: tokens of the same family are "the same kind of value" (two of them in one quote = ambiguous) */
var FAMILY = { 'in': 'len', 'ft': 'len', 'ft-in': 'len', 'inch': 'len', 'inches': 'len', 'feet': 'len', 'foot': 'len', 'ft.': 'len', 'in.': 'len', '"': 'len', "''": 'len', "'": 'len',
  'kips': 'load', 'kip': 'load', 'k': 'load', 'lb': 'load', 'lbs': 'load', 'lb.': 'load', 'lbs.': 'load', 'pound': 'load', 'pounds': 'load',
  'ksi': 'stress', 'psi': 'stress', 'psf': 'psf', 'pcf': 'pcf' };
function familyOf(printedUnit) {
  var u = String(printedUnit).toLowerCase();
  if (FAMILY.hasOwnProperty(u)) return FAMILY[u];
  if (/^(kips?|k)\/ft$|^klf$|^lbs?\.?\/(ft|foot)$|^plf$/.test(u)) return 'lineload';
  if (/-/.test(u) && /^(kips?|k)-(ft|in)$|^(ft|in)-(kips?|k)$/.test(u)) return 'moment';
  return u;
}
function fieldFamily(fieldUnit) {
  if (fieldUnit === 'in' || fieldUnit === 'ft') return 'len';
  if (fieldUnit === 'kips') return 'load';
  if (fieldUnit === 'ksi') return 'stress';
  if (fieldUnit === 'k/ft' || fieldUnit === 'lb/ft') return 'lineload';
  if (fieldUnit === 'kip-ft') return 'moment';
  return fieldUnit || '';
}

/* ------------------------------------------------------------------------------------------------ engine spec -> flat list of boxes */
var SKIP = { unit: 1, show: 1 };            /* print labels / how-many-to-list: not read from a problem */
function findForm(engine, name) {
  var L = engine.list(), i;
  for (i = 0; i < L.length; i++) if (L[i].name === name) return L[i];
  return null;
}
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
function optionValues(f) { var o = [], i; for (i = 0; i < (f.values || []).length; i++) o.push(f.values[i].value); return o; }
/* property names the shape tables know (for lookup_shape's "property" box): learned from the engine itself */
function propertyVocab(engine) {
  var probes = ['W14x90', 'HSS5x2x3/8', 'L4x4x1/2', 'WT7x45', 'C10x20', 'S12x35', 'Pipe 10 STD'], seen = {}, out = [], i, r, k;
  for (i = 0; i < probes.length; i++) {
    try { r = engine.run('lookup_shape', { shape: probes[i], property: 'all' }); } catch (e) { r = null; }
    if (r && r.ok && r.values) for (k in r.values) if (r.values.hasOwnProperty(k) && !seen[k]) { seen[k] = 1; out.push(k); }
  }
  out.push('all');
  return out;
}
/* the end-condition options (the item boxes of y_segments are typed "endcond" but carry no list of their own): the engine's own K table */
function endcondOptions(engine) {
  var f = findForm(engine, 'lookup_K'), i;
  if (f) for (i = 0; i < f.fields.length; i++) if (f.fields[i].name === 'end_condition') return optionValues(f.fields[i]);
  return [];
}
function flatFields(engine, form) {
  var out = [], i, f, j, subform;
  function add(prefix, spec) {
    var kind = kindOf(spec), c;
    if (!kind || SKIP[spec.name]) return;
    c = { path: prefix + spec.name, name: spec.name, spec: spec, kind: kind, unit: spec.unit || '', required: !!spec.required && !prefix };
    if (kind === 'choice') c.options = optionValues(spec);
    if (kind === 'num' || kind === 'int') c.unitEnum = unitEnum(c.unit);
    if (kind === 'name' && spec.name === 'property' && (form.name === 'lookup_shape' || form.name === 'lookup_by_property')) { c.kind = 'choice'; c.options = propertyVocab(engine); c.vocab = true; }
    if (kind === 'list') { c.items = (spec.item || []); c.endconds = endcondOptions(engine); }
    out.push(c);
  }
  for (i = 0; i < form.fields.length; i++) {
    f = form.fields[i];
    if (f.type === 'object' && f.name === 'analysis') {
      subform = findForm(engine, 'beam_analysis');
      if (subform) for (j = 0; j < subform.fields.length; j++) add('analysis.', subform.fields[j]);
    } else add('', f);
  }
  return out;
}
function subFields(c) {       /* the boxes of one list item */
  var out = [], i, s, kind, d;
  for (i = 0; i < c.items.length; i++) {
    s = c.items[i]; kind = kindOf(s);
    if (!kind || kind === 'list' || kind === 'numlist' || kind === 'strlist') continue;
    d = { path: c.path + '[].' + s.name, name: s.name, spec: s, kind: kind, unit: s.unit || '', required: !!s.required };
    if (kind === 'choice') { d.options = optionValues(s); if (!d.options.length && s.type === 'endcond') d.options = c.endconds || []; }
    if (kind === 'num' || kind === 'int') d.unitEnum = unitEnum(d.unit);
    out.push(d);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ JSON schema (NOT used by default: see the header) */
function nullable(s) { return { anyOf: [{ type: 'null' }, s] }; }
function obj(props, req) { return { type: 'object', properties: props, required: req, additionalProperties: false }; }
function valueSchema(c) {
  var props, req;
  if (c.kind === 'num' || c.kind === 'int') {
    props = { quote: { type: 'string' }, text: { type: 'string' } }; req = ['quote', 'text'];
    if (c.unitEnum) { props.unit = { type: 'string', 'enum': c.unitEnum }; req.push('unit'); }
    return obj(props, req);
  }
  if (c.kind === 'name') return obj({ quote: { type: 'string' }, text: { type: 'string' } }, ['quote', 'text']);
  if (c.kind === 'choice') return obj({ quote: { type: 'string' }, value: { type: 'string', 'enum': c.options } }, ['quote', 'value']);
  if (c.kind === 'bool') return obj({ quote: { type: 'string' }, value: { type: 'string', 'enum': ['yes', 'no'] } }, ['quote', 'value']);
  return null;
}
function fieldSchema(c) {
  var subs, props, req, i;
  if (c.kind === 'numlist' || c.kind === 'strlist') return nullable({ type: 'array', maxItems: 8, items: obj({ quote: { type: 'string' }, text: { type: 'string' } }, ['quote', 'text']) });
  if (c.kind === 'list') {
    subs = subFields(c); props = {}; req = [];
    for (i = 0; i < subs.length; i++) { props[subs[i].name] = nullable(valueSchema(subs[i])); req.push(subs[i].name); }
    return nullable({ type: 'array', maxItems: 8, items: obj(props, req) });
  }
  return nullable(valueSchema(c));
}
function buildSchema(fields, o) {
  var props = {}, req = [], i, names = [];
  for (i = 0; i < fields.length; i++) { props[fields[i].path] = fieldSchema(fields[i]); req.push(fields[i].path); names.push(fields[i].path); }
  if (o && o.unclear) {
    props.unclear = { type: 'array', maxItems: 6, items: obj({ box: { type: 'string', 'enum': names }, quote: { type: 'string' } }, ['box', 'quote']) };
    req.push('unclear');
  }
  return { type: 'object', properties: props, required: req, additionalProperties: false };
}

/* ------------------------------------------------------------------------------------------------ the prompt */
function shortLabel(s, max) {
  s = String(s || '').replace(/\s+/g, ' ');
  if (s.length <= max) return s;
  s = s.slice(0, max);
  return s.replace(/\s+\S*$/, '') + '...';
}
function kindWord(c) {
  if (c.kind === 'num') return 'number' + (c.unitEnum ? '; unit choices: ' + c.unitEnum.join(', ') : '');
  if (c.kind === 'int') return 'whole number';
  if (c.kind === 'name') return 'name or phrase';
  if (c.kind === 'choice') return 'choice';
  if (c.kind === 'bool') return 'yes/no';
  if (c.kind === 'numlist') return 'list of numbers';
  if (c.kind === 'strlist') return 'list of names';
  if (c.kind === 'list') return 'list';
  return c.kind;
}
var PROPERTY_HINT = 'A area; d depth; bf flange width; tw web thickness; tf flange thickness; Ix, Iy moment of inertia (strong, weak axis); Sx, Sy elastic section modulus; Zx, Zy plastic section modulus; rx, ry radius of gyration; J torsion constant; W weight per foot';
/* a few boxes whose meaning the model gets wrong or misses; these are reading instructions, never values */
var HINT = {
  Lx_ft: 'a single length given for the whole column with no axis named fills BOTH Lx_ft and Ly_ft',
  Ly_ft: 'if the problem names no axis for the length, use the same words as for Lx_ft',
  x_end_condition: 'ends described without naming an axis fill BOTH x_end_condition and y_end_condition',
  y_end_condition: 'if no axis is named, use the same words as for x_end_condition',
  query: 'copy the exact words of the problem that DESCRIBE the term asked about (not the answer you think is right)'
};
function describe(fields) {
  var lines = [], seenOpts = {}, i, c, line, j, opt, key, subs, s, parts;
  for (i = 0; i < fields.length; i++) {
    c = fields[i];
    line = c.path + ' (' + kindWord(c) + '): ' + shortLabel(c.spec.label, 120);
    if (HINT.hasOwnProperty(c.name)) line += ' [' + HINT[c.name] + ']';
    if (c.kind === 'choice' && !c.vocab) {
      key = c.options.join('|');
      if (seenOpts[key]) line += ' [options: same as ' + seenOpts[key] + ']';
      else {
        seenOpts[key] = c.path; parts = [];
        for (j = 0; j < (c.spec.values || []).length; j++) { opt = c.spec.values[j]; parts.push(opt.value + ' = ' + shortLabel(opt.label, 70)); }
        line += '\n      options: ' + parts.join('; ');
      }
    } else if (c.vocab) line += '\n      options: ' + c.options.join(', ') + '\n      meaning: ' + PROPERTY_HINT;
    else if (c.kind === 'list') {
      subs = subFields(c); parts = [];
      for (j = 0; j < subs.length; j++) { s = subs[j]; parts.push(s.name + ' (' + (s.kind === 'choice' ? 'choice; options: ' + s.options.join(', ') : s.kind === 'int' ? 'whole number' : 'number' + (s.unitEnum ? '; unit choices: ' + s.unitEnum.join(', ') : '')) + '): ' + shortLabel(s.spec.label, 60)); }
      line += '\n      each item has: ' + parts.join(' | ');
    }
    lines.push(line);
  }
  return lines.join('\n');
}
function buildUser(problemText, form, fields, o) {
  return 'FORM: ' + form.name + ' - ' + form.label + '\n' + shortLabel(form.description, 240) + '\n\nBOXES:\n' + describe(fields) +
    (o.unclear ? '\nunclear: boxes the problem speaks of but gives no copyable value for (needs arithmetic, a figure or a judgement), each with the words that mention it.' : '') +
    '\n\nPROBLEM:\n"""\n' + String(problemText).replace(/^\s+|\s+$/g, '') + '\n"""';
}

function getEngine(opts) {
  var e = (opts && opts.engine) || (root && root.STEEL);
  if (!e || typeof e.list !== 'function') throw new Error('no engine: pass opts.engine = STEEL');
  return e;
}
function optsOf(opts) {
  opts = opts || {};
  return { unclear: opts.unclear === undefined ? false : !!opts.unclear, model: opts.model, options: opts.options || {}, numPredict: opts.numPredict || 1600,
           format: opts.format || 'json', strictQuote: opts.strictQuote === undefined ? true : !!opts.strictQuote,
           honorUnclear: opts.honorUnclear === undefined ? (opts.unclear === undefined ? false : !!opts.unclear) : !!opts.honorUnclear,
           anchors: opts.anchors === undefined ? true : !!opts.anchors, countWords: opts.countWords === undefined ? true : !!opts.countWords,
           inferAxes: opts.inferAxes === undefined ? true : !!opts.inferAxes };
}

/* the request body for Ollama /api/chat, plus the context verify() needs */
function buildRequest(problemText, formName, opts) {
  var o = optsOf(opts), engine = getEngine(opts), form = findForm(engine, formName), fields, options, k, body;
  if (!form) throw new Error('unknown form ' + formName);
  fields = flatFields(engine, form);
  options = { temperature: 0, seed: 1, num_ctx: 8192, num_predict: o.numPredict };
  for (k in o.options) if (o.options.hasOwnProperty(k)) options[k] = o.options[k];
  body = {
    model: o.model,
    messages: [{ role: 'system', content: o.unclear ? PROMPT.systemWithUnclear : PROMPT.system }, { role: 'user', content: buildUser(problemText, form, fields, o) }],
    format: o.format === 'schema' ? buildSchema(fields, o) : 'json', stream: false, think: false, options: options
  };
  return { body: body, ctx: { form: form, fields: fields, unclear: o.honorUnclear, strictQuote: o.strictQuote, anchors: o.anchors, countWords: o.countWords, inferAxes: o.inferAxes, problem: String(problemText) } };
}

/* ------------------------------------------------------------------------------------------------ the model's answer as an object */
function parseModelJson(x) {
  var t, a, b, v;
  if (x && typeof x === 'object') return x;
  if (!isStr(x)) return null;
  t = x.replace(/^\s+|\s+$/g, '').replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '');
  try { v = JSON.parse(t); if (v && typeof v === 'object') return v; } catch (e) { /* fall through */ }
  a = t.indexOf('{'); b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { v = JSON.parse(t.slice(a, b + 1)); if (v && typeof v === 'object') return v; } catch (e2) { /* give up */ } }
  return null;
}

/* ------------------------------------------------------------------------------------------------ verification (the program, not the model, decides) */
function rejectIf(reason, extra) { var r = { status: 'rejected', reason: reason }, k; if (extra) for (k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k]; return r; }
function checkRange(c, v) {
  var s = c.spec;
  if (isNum(s.min)) { if (s.minExclusive ? v <= s.min : v < s.min) return false; }
  if (isNum(s.max) && v > s.max) return false;
  return true;
}
function emptyish(x) { return x === null || x === undefined || (isStr(x) && /^\s*(?:null|none|n\/a)?\s*$/i.test(x)); }
/* find the quote in the problem.  P = {n: normalised problem, lc: lower-cased}.  returns {at, text} (text = the problem's own words) or null */
function findQuote(P, q) {
  var i, t, tries = [q], k;
  t = q.replace(/^[\s.,;:!?]+|[\s.,;:!?]+$/g, '');
  if (t && t !== q) tries.push(t);
  for (k = 0; k < tries.length; k++) {
    if (tries[k].length < 2) continue;
    i = P.n.indexOf(tries[k]);
    if (i >= 0) return { at: i, text: P.n.substr(i, tries[k].length) };
    i = P.lc.indexOf(tries[k].toLowerCase());
    if (i >= 0) return { at: i, text: P.n.substr(i, tries[k].length) };
  }
  return null;
}
/* does the quote hold a SECOND value of the same kind as the box (two lengths, two loads...)?  true -> ambiguous */
function holdsOtherValue(qtext, fieldUnit, tokenStart, tokenEnd) {
  var fam = fieldFamily(fieldUnit), vals, i, v, seen = {}, n = 0, key;
  if (!fam) return false;
  vals = valuesWithUnits(qtext);
  for (i = 0; i < vals.length; i++) {
    v = vals[i];
    if (familyOf(v.unit) !== fam) continue;
    key = String(rnd9(v.value)) + '|' + familyOf(v.unit);
    if (!seen[key]) { seen[key] = 1; n++; }
  }
  return n > 1;
}
/* a choice must be backed by words: the option's own key words have to be in the quote (the model may not pick "flanges" with a quote about bolts).
   Only for the boxes whose options are ordinary words of an exam problem; any other box has no key-word test. */
var RE_PIN = /\b(?:pinned|pin|pins|hinged|hinge|simply[- ]supported|simple support)/i, RE_FIX = /\b(?:fixed|fix|clamped|built[- ]in|rigid)/i,
    RE_SWAY = /(?:\bsway|sidesway|\bunbraced|free to (?:move|translate|sway)|translat)/i, RE_FLAG = /(?:flag ?pole|\bfree\b|cantilever)/i;
var ANCHOR_RE = {
  'pinned-pinned': function (q) { return RE_PIN.test(q); },
  'fixed-fixed': function (q) { return RE_FIX.test(q); },
  'fixed-pinned': function (q) { return RE_FIX.test(q) && RE_PIN.test(q); },
  'fixed-sway': function (q) { return RE_FIX.test(q) && RE_SWAY.test(q); },
  'flagpole': function (q) { return RE_FLAG.test(q); },
  'pinned-sway': function (q) { return RE_PIN.test(q) && RE_SWAY.test(q); },
  'flanges': function (q) { return /flange/i.test(q); },
  'web': function (q) { return /\bweb\b|\bstem\b/i.test(q); },
  'angle': function (q) { return /\bangles?\b|\bleg\b|\bL\s?\d/i.test(q); },
  'welded': function (q) { return /weld/i.test(q); },
  'plate': function (q) { return /\bplate|\bPL\b/i.test(q); },
  'cantilever': function (q) { return /cantilever/i.test(q); }
};
function anchorOk(c, value, q) {
  var t = c.spec && c.spec.type, key = String(value), f;
  if (c.vocab) return true;
  if (!(t === 'endcond' || c.name === 'connection' || c.name === 'member' || c.name === 'support')) return true;
  f = ANCHOR_RE[key];
  return f ? f(q) : true;
}
/* an integer box whose number is written as a word: text "2" for "two lines" is traceable -- find the word.  returns {at, len} in q or null */
function findCountWord(q, n) {
  var w, re, m;
  for (w in WORDNUM) if (WORDNUM.hasOwnProperty(w) && WORDNUM[w] === n) { re = new RegExp('\\b' + w + '\\b', 'i'); m = re.exec(q); if (m) return { at: m.index, len: w.length }; }
  return null;
}
/* the unit as the model names it -> the box's own unit name (k -> kips, plf -> lb/ft ...); anything else stays as it is and fails the list test */
var UNIT_ALIAS = { k: 'kips', kip: 'kips', kips: 'kips', lbs: 'lb', 'lb.': 'lb', lbf: 'lb', pound: 'lb', pounds: 'lb', feet: 'ft', foot: 'ft', 'ft.': 'ft', inch: 'in', inches: 'in', 'in.': 'in', klf: 'k/ft', 'kip/ft': 'k/ft', 'kips/ft': 'k/ft', plf: 'lb/ft', 'k-ft': 'kip-ft', 'kips-ft': 'kip-ft', 'k-in': 'kip-in', 'kips-in': 'kip-in', sf: 'sq ft', sqft: 'sq ft', 'sq. ft': 'sq ft', 'ft^2': 'sq ft', 'ft2': 'sq ft', 'in2': 'in^2' };
function canonUnit(u, allowed) {
  var t;
  if (!isStr(u)) return u;
  if (allowed.indexOf(u) >= 0) return u;
  t = u.replace(/^\s+|\s+$/g, '').toLowerCase();
  if (allowed.indexOf(t) >= 0) return t;
  if (UNIT_ALIAS.hasOwnProperty(t) && allowed.indexOf(UNIT_ALIAS[t]) >= 0) return UNIT_ALIAS[t];
  return u;
}
/* one value object from the model -> {status:'filled', value, ...} | {status:'rejected', reason} | {status:'empty'} */
function verifyValue(c, v, P, vo) {
  var qn, tn, f, q, idx, p, u, factor, stripped, val, raw, textHit, lcq, proposed, base, cw, ci, cv;
  if (emptyish(v)) return { status: 'empty' };
  if (typeof v !== 'object' || Array.isArray(v)) return rejectIf('not in the quote / value form');
  if (emptyish(v.text) && emptyish(v.value) && typeof v.value !== 'boolean') return { status: 'empty' };      /* words but no value claimed: nothing is stated */
  if (!isStr(v.quote) || emptyish(v.quote)) return rejectIf('no quote');
  qn = normText(v.quote);
  f = findQuote(P, qn);
  if (!f) return rejectIf('quote is not in the problem');
  q = f.text;
  base = { quote: q, at: f.at };
  if (c.kind === 'choice' || c.kind === 'bool') {
    cv = isStr(v.value) ? v.value : (typeof v.value === 'boolean' ? v.value : (isStr(v.text) ? v.text : null));
    if (cv === null) return rejectIf('no choice');
    if (c.kind === 'bool') {
      u = isStr(cv) ? cv.toLowerCase() : (cv ? 'yes' : 'no');
      if (u === 'yes' || u === 'true') return { status: 'filled', value: true, quote: q, at: f.at };
      if (u === 'no' || u === 'false') return { status: 'filled', value: false, quote: q, at: f.at };
      return rejectIf('choice is not yes/no', base);
    }
    ci = c.options.indexOf(cv);
    if (ci < 0) { u = String(cv).replace(/^\s+|\s+$/g, '').toLowerCase(); for (ci = 0; ci < c.options.length; ci++) if (String(c.options[ci]).toLowerCase() === u) break; if (ci >= c.options.length) ci = -1; }
    if (ci < 0) return rejectIf('choice is not one of the options', base);
    cv = c.options[ci];
    if (q.split(/[^A-Za-z0-9]+/).filter(function (w) { return w; }).length < 2) return rejectIf('the quote is too short to show why this option was chosen', { quote: q, at: f.at, proposed: cv });
    if (vo.anchors && !anchorOk(c, cv, q)) return rejectIf('the quote does not contain the words that mean ' + cv, { quote: q, at: f.at, proposed: cv });
    return { status: 'filled', value: cv, quote: q, at: f.at };
  }
  if (emptyish(v.text) && (isStr(v.value) || isNum(v.value)) && !emptyish(v.value)) v = { quote: v.quote, text: v.value, unit: v.unit };      /* a number given under "value" */
  if (emptyish(v.text) || !(isStr(v.text) || isNum(v.text))) return rejectIf('no text', base);
  tn = normText(String(v.text));
  lcq = q.toLowerCase();
  if (c.kind === 'name') {
    tn = tn.replace(/^(?:an?|the)\s+(?=\S)/i, '');            /* "A Pipe 10 STD": the article is not part of the name */
    textHit = lcq.indexOf(tn.toLowerCase());
    if (textHit < 0) return rejectIf('text is not inside the quote', base);
    val = q.substr(textHit, tn.length);
    if (c.spec.type === 'shape') val = val.replace(/\s+/g, '');
    return { status: 'filled', value: val, quote: q, text: val, at: f.at };
  }
  /* numbers */
  u = c.unitEnum ? canonUnit(v.unit, c.unitEnum) : null;
  if (c.unitEnum && emptyish(u) && stripUnitFromText(tn, c.unitEnum)) u = stripUnitFromText(tn, c.unitEnum).unit;
  if (c.unitEnum && (!isStr(u) || c.unitEnum.indexOf(u) < 0)) return rejectIf('unit is not in the list', base);
  raw = tn;
  if (c.unitEnum && !parseNumberText(tn, c.kind === 'int')) {
    stripped = stripUnitFromText(tn, c.unitEnum);
    if (stripped && q.indexOf(tn) >= 0) { if (stripped.unit !== u) return rejectIf('the unit written inside text differs from the unit named', base); tn = stripped.text; }
  }
  idx = locateToken(q, tn);
  if (idx < 0 && c.kind === 'int' && vo.countWords) {         /* "2" for "two lines": the number word is in the quote */
    p = parseNumberText(tn, true);
    if (p && !p.composite && Math.round(p.value) === p.value) { cw = findCountWord(q, p.value); if (cw) { idx = cw.at; tn = q.substr(cw.at, cw.len); } }
  }
  if (idx < 0) return rejectIf(q.indexOf(tn) >= 0 ? 'text is only part of a number or name in the quote' : 'text is not inside the quote', base);
  p = parseNumberText(tn, c.kind === 'int');
  if (!p) return rejectIf('text is not a number the program can read', base);
  val = p.value;
  if (c.unitEnum) {
    if (p.composite) factor = UNITSET[c.unit]['ft-in'];
    else {
      if (!unitAfter(q, idx + tn.length, u)) return rejectIf('the unit ' + u + ' is not written next to the number', base);
      factor = UNITSET[c.unit][u];
    }
    val = val * factor;
  }
  val = rnd9(val);
  base.proposed = val;
  if (c.kind === 'int' && Math.round(val) !== val) return rejectIf('not a whole number', base);
  if (!checkRange(c, val)) return rejectIf('outside the range the box allows', base);
  if (vo.strictQuote && c.unitEnum && holdsOtherValue(q, c.unit)) return rejectIf('the quote holds more than one value of this kind: it is not clear which one is meant', base);
  return { status: 'filled', value: val, quote: q, text: raw, unit: u || '', at: f.at, tokenAt: f.at + idx, tokenLen: tn.length };
}
function verifyList(c, arr, P, vo) {
  var subs = subFields(c), out = [], i, j, it, sub, r, item, reason = null;
  if (arr === null || arr === undefined) return { status: 'empty' };
  if (!Array.isArray(arr)) return { status: 'rejected', reason: 'not a list' };
  if (!arr.length) return { status: 'empty' };
  for (i = 0; i < arr.length && !reason; i++) {
    it = arr[i]; item = {};
    if (!it || typeof it !== 'object') { reason = 'item ' + (i + 1) + ': not an object'; break; }
    for (j = 0; j < subs.length; j++) {
      sub = subs[j]; r = verifyValue(sub, it[sub.name], P, vo);
      if (r.status === 'rejected') { reason = 'item ' + (i + 1) + ' ' + sub.name + ': ' + r.reason; break; }
      if (r.status === 'filled') item[sub.name] = r.value;
      else if (sub.required) { reason = 'item ' + (i + 1) + ' ' + sub.name + ' is missing'; break; }
    }
    if (!reason) out.push(item);
  }
  if (reason) return { status: 'rejected', reason: reason };
  return { status: 'filled', value: out };
}
function verifyNameList(c, arr, P) {
  var out = [], i, r, v, qn, tn, f, hit;
  if (arr === null || arr === undefined) return { status: 'empty' };
  if (arr && typeof arr === 'object' && !Array.isArray(arr) && isStr(arr.quote)) arr = [arr];      /* one item given without the brackets */
  if (!Array.isArray(arr)) return { status: 'rejected', reason: 'not a list' };
  if (!arr.length) return { status: 'empty' };
  for (i = 0; i < arr.length; i++) {
    v = arr[i];
    if (!v || !isStr(v.quote) || !(isStr(v.text) || isNum(v.text))) return { status: 'rejected', reason: 'item ' + (i + 1) + ': no quote/text' };
    qn = normText(v.quote); tn = normText(String(v.text));
    f = findQuote(P, qn);
    if (!f) return { status: 'rejected', reason: 'item ' + (i + 1) + ': quote is not in the problem' };
    hit = f.text.toLowerCase().indexOf(tn.toLowerCase());
    if (hit < 0) return { status: 'rejected', reason: 'item ' + (i + 1) + ': text is not inside the quote' };
    if (c.kind === 'numlist') {
      r = parseNumberText(tn, false);
      if (!r || locateToken(f.text, tn) < 0) return { status: 'rejected', reason: 'item ' + (i + 1) + ': not a number the program can read' };
      out.push(rnd9(r.value));
    } else out.push(tn.replace(/\s+/g, '').toUpperCase());
  }
  return { status: 'filled', value: out };
}

/* put a flat path ("analysis.span_ft") into a nested args object */
function setPath(args, path, val) {
  var parts = path.split('.'), cur = args, i;
  for (i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = val;
}
/* the numbers-with-units of the problem that no accepted box used (a quote of a question counts as "asked about") */
function computeUnplaced(P, spans) {
  var vals = valuesWithUnits(P.n), out = [], i, j, s, hit;
  for (i = 0; i < vals.length; i++) {
    hit = false;
    for (j = 0; j < spans.length && !hit; j++) { s = spans[j]; if (vals[i].start < s[1] && vals[i].end > s[0]) hit = true; }
    if (!hit) out.push({ text: vals[i].text, value: rnd9(vals[i].value), unit: vals[i].unit, at: vals[i].start });
  }
  return out;
}
/* the model may nest "analysis.span_ft" as {analysis: {span_ft: ...}}: both shapes are the same box */
function modelValue(model, path) {
  var parts, cur, i;
  if (model.hasOwnProperty(path)) return model[path];
  parts = path.split("."); if (parts.length < 2) return undefined;
  cur = model;
  for (i = 0; i < parts.length; i++) { if (!cur || typeof cur !== "object" || Array.isArray(cur) || !cur.hasOwnProperty(parts[i])) return undefined; cur = cur[parts[i]]; }
  return cur;
}
/* ONE length / one set of end conditions for a column with no axis named applies to BOTH axes (the 14B will not fill the y boxes on its own).  This is a
   fixed rule applied to words that are really in the problem, never a value from the model: it copies the x box's own quote to the y box, only when
   (a) the x quote names no axis and (b) the problem as a whole speaks of no bracing, no weak axis, no segments.  The y box says it was inferred. */
var RE_AXIS_WORD = /\b(?:x-x|y-y|x axis|y axis|x-axis|y-axis|strong|weak|major|minor)\b/i;
var RE_BRACE_WORD = /\bbrac|\bweak\b|\bminor\b|y-y|\bsegment|third point|mid-?height|mid-?span|laterally/i;
function inferAxes(res, ctx, P) {
  var d = res.detail, pairs = [['Lx_ft', 'Ly_ft'], ['x_end_condition', 'y_end_condition']], i, a, b, src, dst, k;
  if (!d.Lx_ft || !d.Ly_ft || RE_BRACE_WORD.test(P.n)) return;
  for (i = 0; i < pairs.length; i++) {
    a = pairs[i][0]; b = pairs[i][1]; src = d[a]; dst = d[b];
    if (!src || !dst || src.status !== 'filled' || dst.status !== 'empty') continue;
    if (RE_AXIS_WORD.test(src.quote || '')) continue;
    if (pairs[i][0] === 'Lx_ft' && d.KLy_ft && d.KLy_ft.status !== 'empty') continue;
    if (d.y_segments && d.y_segments.status !== 'empty') continue;
    d[b] = {}; for (k in src) if (src.hasOwnProperty(k)) d[b][k] = src[k];
    d[b].inferred = 'same words as ' + a + ': the problem names no axis';
    res.fields[b] = d[b].value; setPath(res.args, b, d[b].value);
    for (k = 0; k < res.unfilled.length; k++) if (res.unfilled[k] === b) { res.unfilled.splice(k, 1); break; }
  }
}
function verify(ctx, model) {
  var res = { ok: true, version: VERSION, form: ctx.form.name, args: {}, fields: {}, detail: {}, questions: [], unfilled: [], unplaced: [], problem: '', raw: model, error: null },
      P, i, j, c, r, v, flagged = {}, u, un, q, vo = { strictQuote: ctx.strictQuote !== false, anchors: ctx.anchors !== false, countWords: ctx.countWords !== false }, spans = [], key, fq, list;
  P = { n: normText(ctx.problem) }; P.lc = P.n.toLowerCase(); res.problem = P.n;
  if (!model || typeof model !== 'object' || Array.isArray(model)) { res.ok = false; res.error = 'the model gave no usable JSON'; return res; }
  list = model.unclear;
  if (ctx.unclear && Array.isArray(list)) {
    for (i = 0; i < list.length; i++) {
      u = list[i];
      if (!u || typeof u !== 'object') continue;                 /* a bare name with no words is noise, not a flag */
      key = isStr(u.box) ? u.box : (isStr(u.field) ? u.field : (isStr(u.name) ? u.name : null));
      if (!key) continue;
      q = isStr(u.quote) ? normText(u.quote) : '';
      fq = q ? findQuote(P, q) : null;
      /* a flag counts only when it points at real words that carry a number (the problem gives figures for this box but they need work) */
      if (!fq || !/\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|third|quarter|fourth|fifth)\b/i.test(fq.text)) continue;
      flagged[key] = { quote: fq.text, at: fq.at, verified: true };
    }
  }
  for (i = 0; i < ctx.fields.length; i++) {
    c = ctx.fields[i]; v = modelValue(model, c.path);
    if (c.kind === 'list') r = verifyList(c, v, P, vo);
    else if (c.kind === 'numlist' || c.kind === 'strlist') r = verifyNameList(c, v, P);
    else r = verifyValue(c, v, P, vo);
    if (flagged[c.path]) {
      un = flagged[c.path];
      r = { status: 'unclear', reason: 'the problem speaks of this box but gives no value to copy' + (r.status === 'filled' ? ' (a value was also offered; withheld)' : ''), quote: un.verified ? un.quote : null, at: un.at };
    }
    res.detail[c.path] = r;
    if (r.status === 'filled') {
      res.fields[c.path] = r.value; setPath(res.args, c.path, r.value);
      if (r.tokenAt !== undefined) spans.push([r.tokenAt, r.tokenAt + r.tokenLen]);
      else if (r.at !== undefined && c.kind === 'name') spans.push([r.at, r.at + String(r.quote).length]);
    } else if (r.status === 'rejected' || r.status === 'unclear') {
      res.questions.push({ field: c.path, reason: r.reason, quote: r.quote || null, kind: r.status });
      if (r.quote && r.at !== undefined && r.at !== null) spans.push([r.at, r.at + String(r.quote).length]);
    } else {
      res.unfilled.push(c.path);
      if (c.required) res.questions.push({ field: c.path, reason: 'required and not stated in the problem', quote: null, kind: 'required' });
    }
  }
  if (ctx.inferAxes !== false) inferAxes(res, ctx, P);
  res.unplaced = computeUnplaced(P, spans);
  return res;
}

/* ------------------------------------------------------------------------------------------------ the one entry point */
function failure(formName, err) { return { ok: false, version: VERSION, form: formName, args: {}, fields: {}, detail: {}, questions: [], unfilled: [], unplaced: [], problem: '', raw: null, error: String(err && err.message ? err.message : err) }; }
function fill(problemText, formName, callModel, opts) {
  var req, r, out;
  try { req = buildRequest(problemText, formName, opts); } catch (e) { return failure(formName, e); }
  function done(model) { try { out = verify(req.ctx, parseModelJson(model)); } catch (e2) { out = failure(formName, e2); } out.request = req.body; return out; }
  function bad(err) { out = failure(formName, err); out.request = req.body; return out; }
  try { r = callModel(req.body); } catch (e3) { return bad(e3); }
  if (r && typeof r.then === 'function') return r.then(done, bad);
  return done(r);
}

/* ------------------------------------------------------------------------------------------------ (a) (b) (c) parts: deterministic, never the model's job */
function splitParts(text) {
  var t = String(text), re = /(?:^|\n)[ \t]*\(([a-h])\)[ \t]+/g, marks = [], m, next = 'a', stem, parts = [], i, end, start;
  while ((m = re.exec(t)) !== null) {
    if (m[1] === next) { start = m.index + (t.charAt(m.index) === '\n' ? 1 : 0); marks.push({ label: m[1], start: start }); next = String.fromCharCode(next.charCodeAt(0) + 1); }
  }
  if (marks.length < 2) return null;
  stem = t.slice(0, marks[0].start).replace(/\s+$/, '');
  for (i = 0; i < marks.length; i++) {
    end = i + 1 < marks.length ? marks[i + 1].start : t.length;
    parts.push({ label: marks[i].label, text: (stem ? stem + '\n' : '') + t.slice(marks[i].start, end).replace(/\s+$/, '') });
  }
  return { stem: stem, parts: parts };
}

var API = {
  version: VERSION, PROMPT: PROMPT, fill: fill, buildRequest: buildRequest, verify: verify, splitParts: splitParts,
  normText: normText, parseNumberText: parseNumberText, parseModelJson: parseModelJson, locateToken: locateToken, unitEnum: unitEnum, flatFields: flatFields,
  buildSchema: buildSchema, valuesWithUnits: valuesWithUnits, UNITSET: UNITSET
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (root) root.LLMREADER = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

