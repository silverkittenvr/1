/* ==== reader.js ==== */
/* reader.js -- a deterministic "problem reader" for the ARCH-232 steel calculator.  No AI model, no dependencies, ASCII only.

   READER.read(text [, opts]) -> {
     candidates : [{fn, score, because:[phrase,...]}]      ranked calculator functions
     asks       : [{ask, phrase}]                          what the problem wants
     fields     : [{name, value, from, confidence}]        form fields for the top candidate (every value copied from the text;
                                                           units converted only by the explicit rules listed in RULES below)
     questions  : [{id, text, fields:[names], choices:[..]|null}]   what it could not decide
     warnings   : [string]                                  cautions that do not block (e.g. "the text mentions a figure")
     defaults   : [{name, value, from}]                     "unless noted otherwise" values taken from an exam-defaults line
     parts      : [{label, text, read:{...same shape...}}]  (a) (b) (c) ... read separately; [] when the problem has one part
   }
   opts.fn forces the form (used when a person answers the "which form?" question).

   Principles: a value is filled only when a phrase in the text says it; anything the text does not say, or says two ways, becomes a
   question.  The reader never computes an engineering quantity (no areas, no loads, no moments).  The only arithmetic it does is the
   explicit unit/geometry rules in RULES.  This file loads in a browser (window.READER) and in node (module.exports). */
(function (root) {
'use strict';

var VERSION = 'reader-0.8';      /* 0.8 (10/07 night): the count grammar for bolts and holes (4a), the ends one at a time (endPairs), loads named by kind, data-sheet floor wordings */

var RULES = [
  'inches -> feet: 300 in = 25 ft (divide by 12), 18 ft 6 in = 18.5, 18\'-6" = 18.5',
  'lb/ft -> k/ft: 800 lb/ft = 0.8 k/ft (divide by 1000); psi -> ksi: 36,000 psi = 36 ksi',
  'a bolt size given as a fraction stays a fraction string: 7/8" -> "7/8"',
  'braced at the third points of L -> weak-axis segments of L/3; at mid-height -> L/2',
  'grade A36 -> Fy 36 / Fu 58; A992 or A572 Gr 50 -> Fy 50 / Fu 65 (the table printed on her week-1 slide)',
  'a printed effective length factor K maps to the end condition with that recommended K (0.65 fixed-fixed, 0.8 fixed-pinned, 1.0 pinned-pinned, 1.2 fixed-sway, 2.0 flagpole, 2.1 pinned-sway)',
  'a plate "A x B": the smaller number is the thickness, the larger the width'
];

/* valid input names per calculator form (copied from STEEL.list(); eval.js re-checks them against the snapshot) */
var FIELDS = {
  lookup_shape: 'shape property',
  lookup_by_property: 'property minimum family nominal_depths show',
  lookup_material: 'what',
  lookup_U: 'connection fasteners_per_line fastener_lines shape tee_rule xbar_in l_in',
  lookup_K: 'end_condition',
  lookup_critical_stress: 'KL_over_r Fy round_up',
  lookup_hole: 'bolt_dia_in',
  units: 'conversion value width_ft pcf',
  lookup_definition: 'query',
  section_properties: 'shape bar_dia_in rect_b_in rect_t_in plate_t_in plate_b_in plate_h_in plate_Fy',
  loads_factored: 'D L self_weight already_factored factored_value unit',
  loads_floor: 'slab_thickness_in concrete_pcf superimposed_dead_psf framing_psf live_psf live2_psf position spacing_ft tributary_ft',
  loads_takedown: 'tributary_area_sf bay_x_ft bay_y_ft concrete_pcf roof_slab_in roof_D_psf roof_L_psf roof_L2_psf floor_slab_in floor_D_psf floor_L_psf floor_L2_psf floors',
  loads_combinations: 'D L Lr S R W W_reverse E E_reverse L_star unit',
  loads_max_service: 'phiRn D unit',
  beam_analysis: 'span_ft support positions_from already_factored wD wL w_u self_weight_plf w_includes_self_weight point_loads',
  beam_capacity: 'shape Fy Mu',
  beam_required_zx: 'Mu Fy',
  beam_select: 'Mu analysis allowed_depths max_depth_in self_weight_recheck span_ft support show',
  beam_max_live_load: 'shape span_ft position spacing_ft tributary_ft slab_thickness_in concrete_pcf superimposed_dead_psf framing_psf include_self_weight Fy',
  floor_plan: 'slab_thickness_in concrete_pcf superimposed_dead_psf framing_psf live_psf live2_psf beam_span_ft beam_spacing_ft beam_position beam_tributary_ft beam_shape beam_allowed_depths beam_max_depth_in self_weight_recheck girder_span_ft girder_beam_sides girder_beam_positions girder_shape girder_same_depth_as_beam girder_allowed_depths girder_max_depth_in include_column column_floors column_position column_tributary_sf column_KL_ft column_families through_step',
  column_euler: 'shape A r K L_ft Fy bar_dia_in rect_b_in rect_t_in plate_t_in plate_b_in plate_h_in plate_Fy proportional_limit_ksi',
  column_capacity: 'shape Fy bar_dia_in rect_b_in rect_t_in plate_t_in plate_b_in plate_h_in plate_Fy x_end_condition Lx_ft KLx_ft y_end_condition Ly_ft KLy_ft y_segments D L already_factored Pu',
  column_select: 'families D L already_factored Pu x_end_condition Lx_ft KLx_ft y_end_condition Ly_ft KLy_ft y_segments Fy',
  tension_net_area: 'member shape angles width_in thickness_in bolt_dia_in hole_dia_in holes_across holes holes_per_flange web_holes',
  tension_capacity: 'member shape angles width_in thickness_in bolt_dia_in hole_dia_in holes_across holes holes_per_flange web_holes welded connection fasteners_per_line fastener_lines tee_rule xbar_in l_in pitch_in U Fy Fu length_ft D L already_factored Pu',
  tension_required_area: 'D L already_factored Pu Fy Fu',
  tension_select: 'family welded angles bolt_dia_in holes_per_flange web_holes holes_across connection fasteners_per_line fastener_lines tee_rule length_ft Fy Fu D L already_factored Pu'
};
var VALID = {};
(function () { for (var f in FIELDS) { VALID[f] = {}; FIELDS[f].split(' ').forEach(function (n) { VALID[f][n] = true; }); } })();

/* ---------------------------------------------------------------- 1. text folding (same length, so offsets map back) */
var FOLD = {
  '\u00d7': 'x', '\u2715': 'x', '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u2010': '-', '\u2011': '-', '\u2018': "'", '\u2019': "'",
  '\u201c': '"', '\u201d': '"', '\u2033': '"', '\u2032': "'", '\u00a0': ' ', '\u2009': ' ', '\u202f': ' ', '\u03a6': 'f', '\u03c6': 'f',
  '\u00b2': '2', '\u00b3': '3', '\u2044': '/', '\u00b0': ' ', '\u03b5': 'e', '\u2264': '<', '\u2265': '>', '\u00bd': ' ', '\u00bc': ' '
};
function fold(s) {
  var o = '', i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charAt(i);
    if (s.charCodeAt(i) < 128) o += c; else o += (FOLD[c] !== undefined ? FOLD[c] : ' ');
  }
  /* 0.5: a mixed number written with a hyphen ("3-1/2", "2-1/2 in", "4-1/2-in slab") becomes "3 1/2" (same length), so every number pattern below reads it as
     ONE number.  Not when a bolt follows: "2-3/4 in bolts" is two bolts of 3/4 in. */
  o = o.replace(/(\d)-(\d+\/\d+)(?!\s*-?\s*(?:in\.?|inch(?:es)?|")?\s*-?\s*(?:diameter\s+|dia\.?\s+)?(?:high[- ]strength\s+)?(?:bolt|rivet|hole|A325|A490))/gi, '$1 $2');
  return o;
}

/* ---------------------------------------------------------------- 2. numbers and units */
var N = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d*\\.\\d+|\\d+)';
var UNITS = '(?:kip\\s?-?\\s?ft|k\\s?-\\s?ft|kip\\s?-?\\s?in|k\\s?-\\s?in|kips?\\s?\\/\\s?ft|k\\s?\\/\\s?ft|klf|kips?|k(?![A-Za-z])|lbs?\\s?\\/\\s?ft\\s?\\^?\\s?3|lbs?\\s?\\/\\s?cu\\.?\\s?ft|pcf|lbs?\\s?\\/\\s?ft|plf|lbs?(?![A-Za-z])|pounds|psf|psi|ksi|ft\\s?\\^\\s?2|sq\\.?\\s?ft|square\\s+(?:feet|foot)|sf(?![A-Za-z])|feet|foot|ft(?![A-Za-z])|in\\s?\\^\\s?2|inches|inch|in(?![A-Za-z])|"|\')';

function parseNum(s) {
  var m;
  s = String(s).replace(/,/g, '').replace(/^\s+|\s+$/g, '');
  m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = /^(\d+)\/(\d+)$/.exec(s);
  if (m) return Number(m[1]) / Number(m[2]);
  return parseFloat(s);
}
function canonUnit(u) {
  var s;
  if (!u) return '';
  s = u.toLowerCase().replace(/[\s\-]/g, '').replace(/\.$/, '');
  if (s === 'kipft' || s === 'kft') return 'kipft';
  if (s === 'kipin' || s === 'kin') return 'kipin';
  if (/^(kips?|k)\/ft$/.test(s) || s === 'klf') return 'klf';
  if (s === 'kip' || s === 'kips' || s === 'k') return 'k';
  if (/^lbs?\/(ft\^?3|cu\.?ft)$/.test(s) || s === 'pcf') return 'pcf';
  if (/^lbs?\/ft$/.test(s) || s === 'plf') return 'plf';
  if (s === 'lb' || s === 'lbs' || s === 'pounds') return 'lb';
  if (s === 'psf') return 'psf';
  if (s === 'psi') return 'psi';
  if (s === 'ksi') return 'ksi';
  if (/^(ft\^?2|sq\.?ft|squarefeet|squarefoot|sf)$/.test(s)) return 'sf';
  if (s === 'feet' || s === 'foot' || s === 'ft' || s === "'") return 'ft';
  if (s === 'in^2') return 'in2';
  if (s === 'in' || s === 'inch' || s === 'inches' || s === '"') return 'in';
  return s;
}
function rx(src, flags) { return new RegExp(src, flags || 'gi'); }

/* a fraction typed in the text stays a string ("7/8"); everything else is a number */
function dimValue(raw) {
  var s = String(raw).replace(/,/g, '').replace(/^\s+|\s+$/g, '');
  if (/^\d+\/\d+$/.test(s)) return s;
  return parseNum(s);
}
function round6(x) { return Math.round(x * 1e6) / 1e6; }

var WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, single: 1 };
var WN = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+)';
function wnum(s) {
  s = String(s).toLowerCase();
  if (WORDNUM[s] !== undefined) return WORDNUM[s];
  return parseInt(s, 10);
}

/* every number in the text with its unit (numbers glued to a letter, like the 14 of W14 or the 36 of A36, are skipped) */
function scanQuantities(t) {
  var re = new RegExp('(' + N + ')(?:\\s*-?\\s*(' + UNITS + '))?', 'gi'), out = [], m, before, after;
  while ((m = re.exec(t)) !== null) {
    before = m.index > 0 ? t.charAt(m.index - 1) : ' ';
    if (/[A-Za-z]/.test(before)) continue;
    after = t.charAt(m.index + m[1].length);
    out.push({ v: parseNum(m[1]), raw: m[1], unit: canonUnit(m[2]), start: m.index, end: m.index + m[0].length, nend: m.index + m[1].length, text: m[0] });
  }
  return out;
}

/* ---------------------------------------------------------------- 3. shapes */
var FR = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+)';
function compactDim(s) { return String(s).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''); }

function findShapes(t) {
  var res = [], plates = [], fams = [], work = t, m, re, i;
  function mask(s, e) { work = work.slice(0, s) + new Array(e - s + 1).join(' ') + work.slice(e); }
  function addShape(kind, m, norm, family, depth) {
    res.push({ kind: kind, raw: m[0], norm: norm, family: family, depth: depth, start: m.index, end: m.index + m[0].length });
    mask(m.index, m.index + m[0].length);
  }
  // double angles, angles
  /* 0.5: a leg may be a mixed number (L5 x 3-1/2 x 1/2, folded to "3 1/2"); the Manual writes it with a hyphen (L5X3-1/2X1/2) */
  var LEG = '(\\d+\\s+\\d+\\/\\d+|\\d+(?:\\.\\d+)?)';
  function legName(s) { return compactDim(s).replace(/^(\d+)\s+(\d+\/\d+)$/, '$1-$2'); }
  re = rx('\\b2\\s*-?\\s*L\\s*' + LEG + '\\s*x\\s*' + LEG + '\\s*x\\s*(' + FR + ')');
  while ((m = re.exec(work)) !== null) addShape('2L', m, '2L' + legName(m[1]) + 'x' + legName(m[2]) + 'x' + legName(m[3]), 'L', null);
  re = rx('\\bL\\s*' + LEG + '\\s*x\\s*' + LEG + '\\s*x\\s*(' + FR + ')');
  while ((m = re.exec(work)) !== null) addShape('L', m, 'L' + legName(m[1]) + 'x' + legName(m[2]) + 'x' + legName(m[3]), 'L', null);
  // HSS rectangular / round
  re = rx('\\bHSS\\s*(\\d+(?:\\.\\d+)?)\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*x\\s*(' + FR + ')');
  while ((m = re.exec(work)) !== null) addShape('HSS', m, 'HSS' + m[1] + 'x' + m[2] + 'x' + compactDim(m[3]), 'HSS', null);
  re = rx('\\bHSS\\s*(\\d+(?:\\.\\d+)?)\\s*x\\s*(\\d*\\.\\d+|\\d+\\/\\d+)(?!\\s*x)');
  while ((m = re.exec(work)) !== null) addShape('HSS', m, 'HSS' + m[1] + 'x' + compactDim(m[2]), 'HSS', null);
  // pipe
  re = rx('\\bpipe\\s*(\\d+(?:\\.\\d+)?)\\s*(STD|XXS|XS|standard|x-?strong|extra[- ]strong|double[- ]extra[- ]strong)\\b');
  while ((m = re.exec(work)) !== null) {
    var wall = /^(std|standard)$/i.test(m[2]) ? 'STD' : (/^(xxs|double)/i.test(m[2]) ? 'XXS' : 'XS');
    addShape('PIPE', m, 'Pipe ' + m[1] + ' ' + wall, 'PIPE', null);
  }
  // tees
  re = rx('\\b(WT|MT|ST)\\s*(\\d+(?:\\.\\d+)?)\\s*x\\s*(\\d+(?:\\.\\d+)?)\\b');
  while ((m = re.exec(work)) !== null) addShape(m[1].toUpperCase(), m, m[1].toUpperCase() + m[2] + 'x' + m[3], m[1].toUpperCase() + m[2], Number(m[2]));
  // W, M, S, HP
  re = rx('\\b(W|M|S|HP)\\s*(\\d{1,2})\\s*x\\s*(\\d+(?:\\.\\d+)?)\\b');
  while ((m = re.exec(work)) !== null) addShape(m[1].toUpperCase(), m, m[1].toUpperCase() + m[2] + 'x' + m[3], m[1].toUpperCase() + m[2], Number(m[2]));
  // channels
  re = rx('\\b(MC|C)\\s*(\\d{1,2})\\s*x\\s*(\\d+(?:\\.\\d+)?)\\b');
  while ((m = re.exec(work)) !== null) addShape(m[1].toUpperCase(), m, m[1].toUpperCase() + m[2] + 'x' + m[3], m[1].toUpperCase() + m[2], Number(m[2]));
  // plates: "PL 1/2 x 10", "1/2 x 10 plate", "7 in x 1/4 in steel plate"
  re = rx('\\bPL\\s*(' + FR + ')\\s*(?:in\\.?|")?\\s*x\\s*(' + FR + ')');
  while ((m = re.exec(work)) !== null) { plates.push({ a: m[1], b: m[2], raw: m[0], start: m.index, end: m.index + m[0].length }); mask(m.index, m.index + m[0].length); }
  re = rx('(' + FR + ')\\s*(?:-?\\s*(?:in\\.?|inch(?:es)?)|")?\\s*x\\s*(' + FR + ')\\s*(?:-?\\s*(?:in\\.?|inch(?:es)?)|")?\\s*(?:steel\\s+|cover\\s+|flat\\s+)*plates?\\b');
  while ((m = re.exec(work)) !== null) { plates.push({ a: m[1], b: m[2], raw: m[0], start: m.index, end: m.index + m[0].length }); mask(m.index, m.index + m[0].length); }
  // bare families (W12, C10, L4) and "10 in deep channel"
  /* 0.6: "W10/W12": the slash is allowed when ANOTHER family follows it (it still excludes "W12/..." before anything else) */
  re = rx('\\b(WT|MT|ST|HP|MC|HSS|W|C|S|M|L)(\\d{1,2})(?![\\d.])(?!\\s*\\/(?!\\s*(?:WT|MT|ST|HP|MC|HSS|W|C|S|M|L)\\d))');
  while ((m = re.exec(work)) !== null) {
    if (/^(S|M|L)$/i.test(m[1]) && !/[a-z]/.test(m[1]) === false && false) continue;
    fams.push({ kind: m[1].toUpperCase(), norm: m[1].toUpperCase() + m[2], raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  re = rx('\\b(\\d{1,2})\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*-?\\s*deep\\s+(channel|wide[- ]flange|angle)');
  while ((m = re.exec(work)) !== null) {
    var k = /channel/i.test(m[2]) ? 'C' : (/angle/i.test(m[2]) ? 'L' : 'W');
    fams.push({ kind: k, norm: k + m[1], raw: m[0], start: m.index, end: m.index + m[0].length, deep: true });
  }
  res.sort(function (a, b) { return a.start - b.start; });
  fams.sort(function (a, b) { return a.start - b.start; });
  return { shapes: res, plates: plates, families: fams, masked: work };
}
function distinctShapes(shapes) {
  var seen = {}, out = [], i, k;
  for (i = 0; i < shapes.length; i++) {
    k = shapes[i].norm.toUpperCase().replace(/\s+/g, '');
    if (!seen[k]) { seen[k] = true; out.push(shapes[i]); }
  }
  return out;
}

/* ---------------------------------------------------------------- 4. fact finders */
function grab(t, re, fn) {
  var out = [], m, r = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g');
  while ((m = r.exec(t)) !== null) {
    var o = fn(m);
    if (o) { o.start = m.index; o.end = m.index + m[0].length; o.from = m[0]; out.push(o); }
    if (m[0].length === 0) r.lastIndex++;
  }
  return out;
}
function lenToFt(v, unit) { return unit === 'in' ? v / 12 : v; }

/* loads: symbol forms (PD = 115 k, wL = 0.9 k/ft, Pu = 800 kips) and word forms (a live load of 40 psf) */
var SYMKIND = { D: 'D', DL: 'D', L: 'L', LL: 'L', E: 'E', W: 'W', S: 'S', R: 'R', Lr: 'Lr', u: 'u', ult: 'u' };
function findLoads(t) {
  var out = [], m, re, v, u;
  var LU = '(k|klf|plf|psf|lb|pcf|kipft|kipin)';
  // symbol forms
  re = new RegExp('(?:^|[^A-Za-z0-9])((?:P|W|w|M|V)\\s?_?\\s?(?:DL|LL|Lr|D|L|E|W|S|R|u))\\s*(?:=|:)\\s*(' + N + ')(?:\\s*-?\\s*(' + UNITS + ')|(?![A-Za-z0-9]))', 'g');
  while ((m = re.exec(t)) !== null) {
    var sym = m[1].replace(/[\s_]/g, ''), first = sym.charAt(0), kind = SYMKIND[sym.slice(1)];
    if (!kind) continue;
    u = canonUnit(m[3]);
    v = parseNum(m[2]);
    if (u === 'ft' || u === 'in' || u === 'ksi' || u === 'psi' || u === 'sf' || u === 'in2') continue;
    out.push({ sym: sym, first: first, kind: kind, value: v, unit: u, basis: kind === 'u' ? 'factored' : null, via: 'symbol',
      from: m[0].replace(/^[^A-Za-z0-9]/, ''), start: m.index + (m[0].length - m[0].replace(/^[^A-Za-z0-9]/, '').length), end: m.index + m[0].length });
  }
  /* 0.5: the same symbols with no "=": "PD 236 k, PL 106 k", "wD 0.8 k/ft" (only when a load unit follows) */
  re = new RegExp('(?:^|[^A-Za-z0-9])((?:P|w)\\s?_?\\s?(?:DL|LL|D|L|u))\\s+(' + N + ')\\s*-?\\s*(kips?\\s?\\/\\s?ft|k\\s?\\/\\s?ft|klf|kips?|k(?![A-Za-z]))', 'g');
  while ((m = re.exec(t)) !== null) {
    var sym0 = m[1].replace(/[\s_]/g, ''), kind0 = SYMKIND[sym0.slice(1)], st0 = m.index + (m[0].length - m[0].replace(/^[^A-Za-z0-9]/, '').length), dup0 = false, j0;
    if (!kind0) continue;
    for (j0 = 0; j0 < out.length; j0++) if (out[j0].start <= st0 && out[j0].end > st0) dup0 = true;
    if (dup0) continue;
    out.push({ sym: sym0, first: sym0.charAt(0), kind: kind0, value: parseNum(m[2]), unit: canonUnit(m[3]), basis: kind0 === 'u' ? 'factored' : null, via: 'symbol',
      from: m[0].replace(/^[^A-Za-z0-9]/, ''), start: st0, end: m.index + m[0].length });
  }
  // bare D = 50 k, L = 30 k (only with a load unit)
  /* 0.5: the longer units first -- "D = 1.50 k/ft" used to be read as 1.50 k (a point load), because "k" matched before "k/ft" */
  re = new RegExp('(?:^|[^A-Za-z0-9])(D|L|S|W|E|R|Lr)\\s*=\\s*(' + N + ')\\s*-?\\s*(kips?\\s?\\/\\s?ft|k\\s?\\/\\s?ft|klf|lbs?\\s?\\/\\s?ft|plf|psf|kips?|k)(?![A-Za-z\\/])', 'g');
  while ((m = re.exec(t)) !== null) {
    var already = false, st = m.index + (m[0].length - m[0].replace(/^[^A-Za-z0-9]/, '').length), j;
    for (j = 0; j < out.length; j++) if (out[j].start <= st && out[j].end > st) already = true;
    if (already) continue;
    out.push({ sym: m[1], first: '', kind: SYMKIND[m[1]], value: parseNum(m[2]), unit: canonUnit(m[3]), basis: null, via: 'symbol',
      from: m[0].replace(/^[^A-Za-z0-9]/, ''), start: st, end: m.index + m[0].length });
  }
  // word forms: <kind> load ... <number> <unit>
  re = new RegExp('(?:(service|working|unfactored|factored|ultimate|design)\\s+)?(?:(partition|superimposed|additional|roof|movable|fixed)\\s+)?(dead|live|snow|wind|rain|earthquake|seismic)\\s+loads?\\b', 'gi');
  while ((m = re.exec(t)) !== null) {
    var after = t.slice(m.index + m[0].length, m.index + m[0].length + 60), f = new RegExp('^((?:\\s*\\([^)]*\\))?[^0-9.;=]{0,28}?(?:=|:|of|is|are|totaling|totalling|equal to|equals|being|at)?\\s*)(' + N + ')\\s*-?\\s*(' + UNITS + ')', 'i').exec(after);
    var kw = m[3].toLowerCase(), kk = kw === 'dead' ? 'D' : kw === 'live' ? 'L' : kw === 'snow' ? 'S' : kw === 'wind' ? 'W' : kw === 'rain' ? 'R' : 'E';
    if (m[2] && /^roof$/i.test(m[2]) && kk === 'L') kk = 'Lr';
    /* 0.8: a parenthesis between the kind and its number, which must then follow "=", ":", "of" or "is":
       "live load from floors (reduced as applicable for large floor area and multistory columns) = 250 k" */
    if (!f) { after = t.slice(m.index + m[0].length, m.index + m[0].length + 160); f = new RegExp('^([^0-9.;=(]{0,28}?\\([^)0-9]{0,100}\\)\\s*(?:=|:|of|is|are)\\s*)(' + N + ')\\s*-?\\s*(' + UNITS + ')', 'i').exec(after); }
    if (!f) continue;
    u = canonUnit(f[3]);
    if (u === 'ft' || u === 'in' || u === 'ksi' || u === 'psi') continue;
    out.push({ sym: null, first: '', kind: kk, value: parseNum(f[2]), unit: u, basis: m[1] ? (/^(service|working|unfactored)$/i.test(m[1]) ? 'service' : 'factored') : null,
      qualifier: m[2] ? m[2].toLowerCase() : null, via: 'words', from: (m[0] + after.slice(0, f[0].length)).replace(/^\s+/, ''), start: m.index, end: m.index + m[0].length + f[0].length });
  }
  // number first: "a 40 psf live load"
  re = new RegExp('(' + N + ')\\s*-?\\s*(psf|k|kips?|klf|plf|lb\\/ft)\\s+(?:of\\s+)?(?:(service|working|factored|ultimate)\\s+)?(?:(partition|superimposed|roof)\\s+)?(dead|live|snow|wind)\\s+loads?\\b', 'gi');
  while ((m = re.exec(t)) !== null) {
    var ex = false, jj;
    for (jj = 0; jj < out.length; jj++) if (Math.abs(out[jj].start - m.index) < 3) ex = true;
    if (ex) continue;
    var kw2 = m[5].toLowerCase();
    out.push({ sym: null, first: '', kind: kw2 === 'dead' ? 'D' : kw2 === 'live' ? 'L' : kw2 === 'snow' ? 'S' : 'W', value: parseNum(m[1]), unit: canonUnit(m[2]),
      basis: m[3] ? (/^(service|working)$/i.test(m[3]) ? 'service' : 'factored') : null, qualifier: m[4] ? m[4].toLowerCase() : null, via: 'words', from: m[0], start: m.index, end: m.index + m[0].length });
  }
  /* 0.5: the number first and no word "load": "100 k dead + 150 k live", "90 kips dead and 120 kips live" */
  re = new RegExp('(' + N + ')\\s*-?\\s*(kips?\\s?\\/\\s?ft|k\\s?\\/\\s?ft|klf|kips?|k(?![A-Za-z])|psf|plf)\\s+(?:of\\s+)?(?:service\\s+)?(dead|live)\\b(?!\\s+loads?\\b)', 'gi');
  while ((m = re.exec(t)) !== null) {
    var ex3 = false, j3;
    for (j3 = 0; j3 < out.length; j3++) if (out[j3].start < m.index + m[0].length && out[j3].end > m.index) ex3 = true;
    if (ex3) continue;
    out.push({ sym: null, first: '', kind: /dead/i.test(m[3]) ? 'D' : 'L', value: parseNum(m[1]), unit: canonUnit(m[2]), basis: /service/i.test(m[0]) ? 'service' : null, via: 'words', from: m[0], start: m.index, end: m.index + m[0].length });
  }
  /* 0.5: a factored load given in words: "an ultimate axial load of 660 kips", "a factored load of 3.2 k/ft", "factored tension force = 250 k".
     (Symbol forms such as Pu = 660 kips were read above; a "factored dead load" is one of the word forms above.) */
  re = new RegExp('\\b(?:factored|ultimate)\\s+(?:(?:axial|compressive|compression|tensile|tension|column|concentric|total|uniform|uniformly\\s+distributed|distributed|line|design|service)\\s+)*(?:loads?|force)\\b(?:\\s*,?\\s*\\(?[PwW]\\s?_?u\\)?\\s*,?)?\\s*(?:=|:|of|is|equal\\s+to)?\\s*(' + N + ')\\s*-?\\s*(' + UNITS + ')', 'gi');
  while ((m = re.exec(t)) !== null) {
    var uu = canonUnit(m[2]), dupe = false, q;
    if (uu !== 'k' && uu !== 'klf' && uu !== 'plf') continue;
    for (q = 0; q < out.length; q++) if (out[q].start < m.index + m[0].length && out[q].end > m.index) dupe = true;
    if (dupe) continue;
    out.push({ sym: uu === 'k' ? 'Pu' : 'wu', first: uu === 'k' ? 'P' : 'w', kind: 'u', value: parseNum(m[1]), unit: uu, basis: 'factored', via: 'words', from: m[0], start: m.index, end: m.index + m[0].length });
  }
  /* 0.8: the KIND named and no word "load": "wind = 144 kips", "live: 80 psf", "roof dead 40 psf, roof live 30 psf", "other dead: 15 psf".
     The number must follow the kind word at once (after "=", ":", "of", "is" at most) and carry a load unit; a phrase one of the rules above read is skipped. */
  /* (a wind or an earthquake load said to be TENSILE / uplift / reverse is the reverse value of the combinations form, kinds Wrev and Erev) */
  re = new RegExp('\\b(?:(roof|floor|other|superimposed|additional|compression|compressive|tensile|tension|uplift|reverse)\\s+)?(dead|live|snow|wind|rain|seismic|earthquake)\\s*(?:=|:|of|is)?\\s*(' + N + ')\\s*-?\\s*(kips?\\s?\\/\\s?ft|k\\s?\\/\\s?ft|klf|lbs?\\s?\\/\\s?ft|plf|psf|kips?|k(?![A-Za-z]))(?![A-Za-z\\/^])', 'gi');
  while ((m = re.exec(t)) !== null) {
    var dup8 = false, q8, kw8 = m[2].toLowerCase(), k8 = kw8 === 'dead' ? 'D' : kw8 === 'live' ? 'L' : kw8 === 'snow' ? 'S' : kw8 === 'wind' ? 'W' : kw8 === 'rain' ? 'R' : 'E', ql8 = m[1] ? m[1].toLowerCase() : null;
    if (ql8 && /^(?:tensile|tension|uplift|reverse)$/.test(ql8)) { if (k8 === 'W' || k8 === 'E') k8 = k8 + 'rev'; else continue; }
    if (ql8 && /^compress/.test(ql8) && k8 !== 'W' && k8 !== 'E') continue;
    for (q8 = 0; q8 < out.length; q8++) if (out[q8].start < m.index + m[0].length && out[q8].end > m.index) dup8 = true;
    if (dup8) continue;
    if (/\b(?:dead|live|snow|wind|rain|D|L)\s*(?:\+|&|and|plus)\s*(?:\d+(?:\.\d+)?\s*)?$/i.test(t.slice(Math.max(0, m.index - 24), m.index))) continue;       /* "dead + live = 120 psf" is a sum, not the live load */
    if (/\b(?:total|combined|factored|ultimate)\s+$/i.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;                                           /* "total dead = 87.5 psf", "factored live ..." are not a service load to enter */
    if (ql8 === 'roof' && k8 === 'L') k8 = 'Lr';
    out.push({ sym: null, first: '', kind: k8, value: parseNum(m[3]), unit: canonUnit(m[4]), basis: null, qualifier: ql8 === 'other' || ql8 === 'additional' ? 'superimposed' : ql8, via: 'words', from: m[0], start: m.index, end: m.index + m[0].length });
  }
  /* 0.8: the kind named in a parenthesis AFTER the number: "load from roof = 30 k (roof live load)" */
  re = new RegExp('(' + N + ')\\s*-?\\s*(kips?\\s?\\/\\s?ft|k\\s?\\/\\s?ft|klf|plf|psf|kips?|k(?![A-Za-z]))\\s*\\(\\s*(roof\\s+live|dead|live|snow|wind|rain|earthquake|seismic)\\s+loads?\\s*\\)', 'gi');
  while ((m = re.exec(t)) !== null) {
    var dup9 = false, q9, kw9 = m[3].toLowerCase().replace(/\s+/g, ' ');
    for (q9 = 0; q9 < out.length; q9++) if (out[q9].start < m.index + m[0].length && out[q9].end > m.index) dup9 = true;
    if (dup9) continue;
    out.push({ sym: null, first: '', kind: kw9 === 'roof live' ? 'Lr' : kw9 === 'dead' ? 'D' : kw9 === 'live' ? 'L' : kw9 === 'snow' ? 'S' : kw9 === 'wind' ? 'W' : kw9 === 'rain' ? 'R' : 'E', value: parseNum(m[1]), unit: canonUnit(m[2]), basis: null, qualifier: null, via: 'words', from: m[0], start: m.index, end: m.index + m[0].length });
  }
  out.sort(function (a, b) { return a.start - b.start; });
  return out;
}

var ENDS = ['pinned-pinned', 'fixed-fixed', 'fixed-pinned', 'fixed-sway', 'flagpole', 'pinned-sway'];
var KMAP = { '0.65': 'fixed-fixed', '0.8': 'fixed-pinned', '0.80': 'fixed-pinned', '1': 'pinned-pinned', '1.0': 'pinned-pinned', '1.2': 'fixed-sway', '2': 'flagpole', '2.0': 'flagpole', '2.1': 'pinned-sway' };
/* 0.6: does the text say the column can SWAY?  The phrases that say it cannot are taken out first ("braced against sidesway", "sidesway is prevented",
   "fixed against rotation and translation", "braced frame"); any sway / translation / lateral-movement word that is left counts.
   REVIEW 2: "unbraced against sidesway", "the top is allowed to translate", "sway is permitted", "the frame is unbraced" all slipped past the first version
   of this guard, and the braced K was used (1050 kips printed where 766 is right). */
function maySway(t) {
  var x = String(t)
    .replace(/\bbraced\s+against\s+(?:side[\s-]?)?sway\b/gi, ' ')
    .replace(/\b(?:side[\s-]?)?sway\s+(?:is\s+)?(?:prevented|inhibited|restrained|not\s+(?:permitted|allowed|possible))/gi, ' ')
    .replace(/\bno\s+(?:side[\s-]?)?sway\b|\bwithout\s+(?:side[\s-]?)?sway\b|\bnot\s+free\s+to\s+(?:sway|translate|move)\b/gi, ' ')
    .replace(/\b(?:fixed|restrained|held|braced)\s+against\s+(?:rotation\s+and\s+)?translation\b|\bagainst\s+rotation\s+and\s+translation\b|\btranslation\s+(?:is\s+)?(?:prevented|restrained|fixed)\b/gi, ' ')
    .replace(/\bbraced\s+frame\b|\bnon-?sway\b/gi, ' ');
  return /\b(?:side[\s-]?)?sway(?:s|ing)?\b|\bsidesway\b|\btranslat\w*|\bmoves?\s+laterally\b|\blateral\s+(?:movement|translation|displacement)\b|\bunbraced\s+(?:frame|against)\b|\bmoment\s+frame\b|\bframe\s+is\s+(?:not\s+braced|unbraced)\b|\bnot\s+braced\s+against\b/i.test(x);
}
/* 0.8: the end conditions said one end at a time, as PAIRS of a condition (fixed / pinned / hinged / free / built-in / rigid) and an end (base, bottom,
   foundation, footing, lower end; top, upper end), with either word first and anything between the two statements:
     "fixed at the foundation and pinned at the top girder connection"   "fixed base/pinned top"   "base fixed, top pinned"   "pinned top, fixed base"
   Both ends must be named, each with ONE condition, inside one short stretch of text.  fixed + fixed = fixed-fixed; fixed + pinned (either way round) =
   fixed-pinned; pinned + pinned = pinned-pinned; fixed base + free top = flagpole.  Anything else is not a reading (the page asks).  Whether the column can
   sway is judged afterwards by the caller, as for every other wording. */
function endPairs(t) {
  var COND = '(fixed|pinned|hinged|free|built[\\s-]in|rigid)', BASE = 'base|bottom|foundation|footing|lower\\s+end', TOP = 'top|upper\\s+end',
    re = new RegExp('\\b' + COND + '\\s+(?:at|on|to)\\s+(?:the\\s+|its\\s+)?(' + BASE + '|' + TOP + ')\\b|\\b(' + BASE + '|' + TOP + ')\\s+(?:(?:is|being)\\s+)?' + COND + '\\b|\\b' + COND + '\\s+(' + BASE + '|' + TOP + ')\\b', 'gi'),
    m, got = { base: null, top: null }, first = -1, last = -1, cond, end, bad = false, id = null;
  while ((m = re.exec(t)) !== null) {
    cond = (m[1] || m[4] || m[5]).toLowerCase(); end = new RegExp('^(?:' + TOP + ')$', 'i').test(m[2] || m[3] || m[6]) ? 'top' : 'base';
    cond = /^(?:fixed|built|rigid)/.test(cond) ? 'fixed' : (cond === 'free' ? 'free' : 'pinned');
    /* "free" must end its statement: "the top is free to rotate but cannot translate" is a pinned top */
    if (cond === 'free' && !/^\s*(?:[.,;)\/]|$|and\b|about\b)/i.test(t.slice(m.index + m[0].length, m.index + m[0].length + 8))) { bad = true; continue; }
    if (got[end] && got[end] !== cond) bad = true;
    got[end] = cond;
    if (first < 0) first = m.index;
    last = m.index + m[0].length;
  }
  if (bad || !got.base || !got.top || last - first > 110) return null;
  if (got.base === 'fixed' && got.top === 'fixed') id = 'fixed-fixed';
  else if ((got.base === 'fixed' && got.top === 'pinned') || (got.base === 'pinned' && got.top === 'fixed')) id = 'fixed-pinned';
  else if (got.base === 'pinned' && got.top === 'pinned') id = 'pinned-pinned';
  else if (got.base === 'fixed' && got.top === 'free') id = 'flagpole';
  if (!id) return null;
  return { id: id, from: t.slice(first, last), start: first, end: last, why: 'the two ends, one at a time' };
}
function findEnds(t) {
  var m, r = [], re;
  function add(id, m, why) { r.push({ id: id, from: m[0], start: m.index, end: m.index + m[0].length, why: why }); }
  /* 0.6: "pinned at the base and fixed at the top against rotation but free to sway" (the words "at the top" between "fixed" and "against rotation") */
  re = /(?:pinned|hinged|pin)\s+(?:at\s+)?(?:the\s+)?(?:base|bottom)[^.;]{0,60}?fixed\s+(?:at\s+(?:the\s+)?top\s+)?against\s+rotation[^.;]{0,40}?(?:free\s+to|allowed\s+to|able\s+to|can|may)\s+(?:translate|sway|move)/i;
  if ((m = re.exec(t))) add('pinned-sway', m);
  re = /fixed\s+(?:at\s+(?:the\s+)?(?:bottom|base)\s*(?:,|and)?\s*(?:and\s+)?)?(?:fixed\s+)?against\s+rotation\s+(?:but|and)\s+(?:is\s+)?free\s+to\s+(?:translate|sway|move)[^.;]{0,20}/i;
  if (!r.length && (m = re.exec(t))) add('fixed-sway', m);
  re = /fixed\s+at\s+(?:the\s+)?(?:bottom|base)[^.;]{0,25}?(?:and\s+)?(?:fixed\s+)?(?:against\s+rotation\s+)?(?:but\s+)?free\s+to\s+(?:translate|sway|move)/i;
  if (!r.length && (m = re.exec(t))) add('fixed-sway', m);
  /* 0.6 (review 3): "Both ends are fixed against rotation, but the top can translate (sway)", "fixed at both ends against rotation but free to translate":
     rotation held at both ends, the top free to move sideways = the same case (design K 1.2).  The page stopped on these. */
  re = /(?:both\s+ends\s+(?:are\s+)?fixed\s+against\s+rotation|fixed\s+against\s+rotation\s+at\s+both\s+ends|fixed\s+at\s+both\s+ends\s+against\s+rotation)[^.;]{0,40}?(?:(?:the\s+)?(?:top|upper\s+end|one\s+end)\s+(?:can|may|is\s+free\s+to|is\s+allowed\s+to)\s+(?:translate|sway|move(?:\s+sideways)?)|free\s+to\s+(?:translate|sway|move))/i;
  if (!r.length && (m = re.exec(t))) add('fixed-sway', m);
  /* 0.6 (fresh exam 10/06): the same case over two sentences: "Both ends of a column are restrained against rotation. The base is restrained against
     translation, but the top is free to sway laterally." */
  re = /\bboth\s+ends\s+(?:of\s+(?:a|the)\s+(?:column|member)\s+)?(?:are\s+)?(?:fixed|restrained|held)\s+against\s+rotation\b[^;]{0,130}?\b(?:the\s+)?(?:top|upper\s+end)\s+(?:is\s+free\s+to|can|may|is\s+allowed\s+to)\s+(?:sway|translate|move)(?:\s+(?:laterally|sideways))?/i;
  if (!r.length && (m = re.exec(t))) add('fixed-sway', m);
  re = /(?:flag\s?pole|cantilever(?:ed)?\s+column|fixed\s+at\s+(?:the\s+)?(?:bottom|base)\s*(?:and|,)\s*free\s+at\s+(?:the\s+)?top|fixed\s+(?:base|at\s+the\s+base)[^.;]{0,15}free\s+(?:top|at\s+the\s+top))/i;
  if (!r.length && (m = re.exec(t))) add('flagpole', m);
  re = /(?:one\s+end\s+(?:of\s+(?:a|the)\s+(?:column|member)\s+)?(?:is\s+)?fixed\s*(?:,|and)?\s*(?:and\s+)?the\s+other\s+(?:end\s+)?(?:is\s+)?(?:pinned|hinged)|fixed\s+at\s+(?:the\s+)?(?:one\s+end|base|bottom)\s+and\s+pinned\s+at\s+(?:the\s+)?(?:other\s+end|top)|pinned\s+at\s+(?:the\s+)?(?:one\s+end|base|bottom)\s+and\s+fixed\s+at\s+(?:the\s+)?(?:other\s+end|top)|fixed[- ]pinned|fixed\s+and\s+pinned|one\s+end\s+pinned\s+(?:and\s+)?the\s+other\s+(?:end\s+)?fixed|(?:fixed|built[- ]in)\s+at\s+(?:the\s+|its\s+)?(?:one\s+end|base|bottom|top|lower\s+end|upper\s+end)\s*(?:,|;|and|but)?\s*(?:and\s+)?(?:is\s+)?(?:pinned|hinged)\s+at\s+(?:the\s+|its\s+)?(?:other(?:\s+end)?|top|base|bottom|upper\s+end|lower\s+end)|(?:pinned|hinged)\s+at\s+(?:the\s+|its\s+)?(?:one\s+end|base|bottom|top|lower\s+end|upper\s+end)\s*(?:,|;|and|but)?\s*(?:and\s+)?(?:is\s+)?(?:fixed|built[- ]in)\s+at\s+(?:the\s+|its\s+)?(?:other(?:\s+end)?|top|base|bottom|upper\s+end|lower\s+end))/i;   /* 0.5: either end may be the fixed one, in either order, with "and" or a comma ("pinned at the top and fixed at the base"; "fixed at the bottom, pinned at the top") */
  if (!r.length && (m = re.exec(t))) add('fixed-pinned', m);
  re = /(?:fixed\s+(?:ends?|at\s+both\s+ends|at\s+(?:the\s+)?top\s+and\s+(?:the\s+)?bottom|top\s+and\s+bottom|supports|at\s+both|at\s+its\s+ends)|both\s+ends\s+fixed|fixed\s+against\s+rotation\s+and\s+translation|built-in\s+at\s+both\s+ends|fixed-fixed)/i;
  if (!r.length && (m = re.exec(t))) add('fixed-fixed', m);
  re = /(?:pinned\s+(?:at\s+)?(?:both\s+ends|top\s+and\s+(?:the\s+)?bottom|its\s+(?:two\s+)?ends|the\s+top\s+and\s+(?:the\s+)?bottom)|pinned\s+(?:end|ends|supports?|connections?|conditions?)|pinned-pinned|simple\s+(?:end|ends|supports?)|simply\s+supported\s+(?:at\s+both\s+ends)|hinged\s+(?:at\s+)?(?:both\s+)?ends|pin-ended|pinned\s+top\s+and\s+bottom|pinned\s+at\s+the\s+top)/i;
  if (!r.length && (m = re.exec(t))) add('pinned-pinned', m);
  /* 0.6: the ends said one at a time with "is": "The base is fixed and the top is pinned", "the top is pinned and the base is fixed", "the base is fixed
     and the top is free", "the top and the bottom are fixed" (with her cover page typed in these were answered as pinned-pinned before the cover rule was
     tightened; now they are read) */
  var END_A = '(?:the\\s+|its\\s+)?(?:base|bottom|lower\\s+end|top|upper\\s+end)', BASE = '(?:the\\s+|its\\s+)?(?:base|bottom|lower\\s+end)', TOP = '(?:the\\s+|its\\s+)?(?:top|upper\\s+end)', JOIN = '\\s*(?:,|;|and|while|but)?\\s*(?:and\\s+)?';
  if (!r.length) {
    if ((m = new RegExp('\\b' + BASE + '\\s+is\\s+fixed' + JOIN + TOP + '\\s+is\\s+(?:pinned|hinged)\\b|\\b' + TOP + '\\s+is\\s+(?:pinned|hinged)' + JOIN + BASE + '\\s+is\\s+fixed\\b|\\b' + TOP + '\\s+is\\s+fixed' + JOIN + BASE + '\\s+is\\s+(?:pinned|hinged)\\b|\\b' + BASE + '\\s+is\\s+(?:pinned|hinged)' + JOIN + TOP + '\\s+is\\s+fixed\\b', 'i').exec(t))) add('fixed-pinned', m);
    /* "free" must END the clause: "the top is free to rotate but cannot translate" is a PINNED top, not a free one (it was read as a flagpole for a minute) */
    else if ((m = new RegExp('\\b' + BASE + '\\s+is\\s+fixed' + JOIN + TOP + '\\s+is\\s+free(?=\\s*(?:[.,;)]|$))|\\b' + TOP + '\\s+is\\s+free' + JOIN + BASE + '\\s+is\\s+fixed\\b', 'i').exec(t))) add('flagpole', m);
    else if ((m = new RegExp('\\b' + END_A + '\\s+and\\s+' + END_A + '\\s+are\\s+(?:both\\s+)?fixed\\b|\\bboth\\s+' + END_A + '\\s+and\\s+' + END_A + '\\s+are\\s+fixed\\b', 'i').exec(t))) add('fixed-fixed', m);
    else if ((m = new RegExp('\\b' + END_A + '\\s+and\\s+' + END_A + '\\s+are\\s+(?:both\\s+)?(?:pinned|hinged)\\b|\\bboth\\s+' + END_A + '\\s+and\\s+' + END_A + '\\s+are\\s+(?:pinned|hinged)\\b', 'i').exec(t))) add('pinned-pinned', m);
  }
  /* 0.6: "All supports are pinned" (her own sentence, 2024 final Q4), "both ends are pinned", "the ends are pinned": read as said, so that the answer does
     not hang on the cover page's default */
  re = /\b(?:all|both)\s+(?:the\s+)?(?:supports?|ends|connections?)\s+(?:are\s+)?(?:pinned|hinged)\b|\b(?:the\s+|its\s+)?(?:supports|ends)\s+are\s+(?:pinned|hinged)\b|\b(?:pinned|hinged)\s+at\s+(?:its\s+|the\s+)(?:supports|ends)\b/i;
  if (!r.length && (m = re.exec(t))) add('pinned-pinned', m);
  /* 0.8: when none of the sentences above fits, the two ends are read ONE AT A TIME, in any order and with either word first (see endPairs) */
  /* (never in a text that speaks of sway, translation or sideways movement in any words: those are left to the rules above, or asked) */
  var noMove = !/\bsway|\btranslat|\bsideways|\blateral(?:ly)?\s+(?:mov|displac|translat)|\bmoves?\b|\bunbraced\b|\bmoment\s+frame\b|\bfree\s+to\b/i.test(t);
  if (!r.length && noMove) { var ep = endPairs(t); if (ep) r.push(ep); }
  /* 0.6: a SECOND, different end condition said in full somewhere else in the text ("Lx = 15 ft (fixed at both ends), Ly = 13 ft (fixed at the base and pinned
     at the top)").  The chain above keeps one condition only, so the other was dropped without a word and one K went to both axes.  Only statements that name
     BOTH ends count here, and only where they do not overlap what the chain found; fillEnds then gives each axis its own, or asks. */
  if (r.length === 1) {
    var FULL_ENDS = [
      ['fixed-fixed', /\bfixed\s+at\s+both\s+ends\b|\bboth\s+ends\s+(?:are\s+)?fixed\b|\bfixed[\s-]fixed\b|\bfixed\s+at\s+(?:the\s+)?top\s+and\s+(?:at\s+)?(?:the\s+)?(?:bottom|base)\b|\bfixed\s+at\s+(?:the\s+)?(?:base|bottom)\s+and\s+(?:fixed\s+)?at\s+(?:the\s+)?top\b|\bbuilt[\s-]in\s+at\s+both\s+ends\b/gi],
      ['pinned-pinned', /\b(?:pinned|hinged)\s+at\s+both\s+ends\b|\bboth\s+ends\s+(?:are\s+)?(?:pinned|hinged)\b|\bpinned[\s-]pinned\b|\bpin[\s-]ended\b|\b(?:pinned|hinged)\s+at\s+(?:the\s+)?top\s+and\s+(?:at\s+)?(?:the\s+)?(?:bottom|base)\b|\b(?:pinned|hinged)\s+at\s+(?:the\s+)?(?:base|bottom)\s+and\s+(?:pinned\s+)?at\s+(?:the\s+)?top\b|\bpinned\s+top\s+and\s+bottom\b/gi],
      ['fixed-pinned', /\bfixed\s+at\s+(?:the\s+|its\s+)?(?:one\s+end|base|bottom|top)\s*(?:,|and|but)\s*(?:and\s+)?(?:is\s+)?(?:pinned|hinged)\s+at\s+(?:the\s+|its\s+)?(?:other(?:\s+end)?|top|base|bottom)\b|\b(?:pinned|hinged)\s+at\s+(?:the\s+|its\s+)?(?:one\s+end|base|bottom|top)\s*(?:,|and|but)\s*(?:and\s+)?(?:is\s+)?fixed\s+at\s+(?:the\s+|its\s+)?(?:other(?:\s+end)?|top|base|bottom)\b|\bfixed[\s-]pinned\b|\bpinned[\s-]fixed\b/gi]
    ], fe, fm, p0 = r[0];
    for (fe = 0; fe < FULL_ENDS.length; fe++) {
      if (FULL_ENDS[fe][0] === p0.id) continue;
      FULL_ENDS[fe][1].lastIndex = 0;
      while ((fm = FULL_ENDS[fe][1].exec(t)) !== null) {
        if (fm.index < p0.end && fm.index + fm[0].length > p0.start) continue;      /* part of what the chain already read */
        r.push({ id: FULL_ENDS[fe][0], from: fm[0], start: fm.index, end: fm.index + fm[0].length, extra: true });
        break;
      }
    }
  }
  /* 0.6 (10/06 16:45): what was found must not contradict a plain word of the text.  "The base is PINNED and the top is fixed against rotation but is free
     to move sideways" matched the fixed-with-sway pattern (K 1.2) although one end is pinned (K 2.0).  Both ends fixed, or a flagpole, with a pinned or
     hinged end in the text is not a reading; neither is pinned-pinned with a fixed end in the text.  (Two FULL statements, one per axis, are left to
     fillEnds: this is only for a single reading.)  The reading is dropped; one more rule may still read the sentence; if not, the page asks. */
  if (r.length === 1) {
    /* (braces along the height are not ends: "additional pinned lateral supports at 13 ft and 24 ft above the base" on a column fixed at both ends) */
    var tEndsOnly = t.replace(/\b(?:pinned|hinged)\s+lateral\s+\w+|\b(?:additional|intermediate|extra)\s+(?:pinned|hinged)\s+\w+/gi, ' '),
      hasPinW = /\b(?:pinned|hinged|pin[\s-]ended|pin)\b/i.test(tEndsOnly), hasFixW = /\bfixed\b|\bfixity\b|\bbuilt[\s-]in\b/i.test(t);
    if (((r[0].id === 'fixed-fixed' || r[0].id === 'fixed-sway' || r[0].id === 'flagpole') && hasPinW) || (r[0].id === 'pinned-pinned' && hasFixW)) {
      r = [];
      if ((m = new RegExp('\\b' + BASE + '\\s+is\\s+(?:pinned|hinged)' + JOIN + TOP + '\\s+is\\s+fixed(?:\\s+against\\s+rotation)?[^.;]{0,40}?(?:free\\s+to|allowed\\s+to|able\\s+to|can|may)\\s+(?:translate|sway|move)', 'i').exec(t))) add('pinned-sway', m);
      /* 0.8: "fixed at the foundation and pinned at the top girder connection": "pinned at the top" alone had been taken as pinned at both ends and was
         dropped just above because of the word "fixed"; the two ends are now read one at a time */
      else if (noMove) { var ep2 = endPairs(t); if (ep2) r.push(ep2); }
    }
  }
  /* 0.6: the text says the column can SWAY, and what was recognised is a braced case (pinned-pinned, fixed-fixed, fixed-pinned): that reading is wrong
     by a factor of up to 2.5 in K (K 0.8 was used where K is 2.0: 203 kips printed, 35 right).  The braced reading is dropped; the page then asks. */
  /* (10/06 16:40) ONE of those has a single meaning: both ends FIXED against rotation and the column free to sway is the "fixed with sway" case of her
     table (design K 1.2).  The other two (which end is pinned? is the base or the top free?) are still asked. */
  if (r.length === 1 && r[0].id === 'fixed-fixed' && maySway(t)) { r[0].id = 'fixed-sway'; r[0].why = 'fixed at both ends, and the text says the column can sway'; }
  if (r.length && /^(?:pinned-pinned|fixed-fixed|fixed-pinned)$/.test(r[0].id) && maySway(t)) r = [];
  // printed K
  re = /\bK\s*=\s*(\d*\.?\d+)\b/g;
  var km;
  while ((km = re.exec(t)) !== null) {
    if (KMAP[km[1]] !== undefined) r.push({ id: KMAP[km[1]], from: km[0], start: km.index, end: km.index + km[0].length, why: 'K', viaK: true });
  }
  return r;
}

/* ---------------------------------------------------------------- 5. defaults line ("Exam defaults ... unless noted otherwise, assume: ...") */
function splitPreamble(t) {
  /* 0.6: EVERY leading line that is a cover-page line is preamble, not only the first.  With the cover page typed into the page's own box AND a cover line
     pasted into the question as well, the second one was read as the question's own words ("pinned support conditions", "K = 1.0 for all columns": her
     Q23, fixed top and bottom, came out with K = 1.0). */
  var end = 0, nl, line, last = 0;
  for (;;) {
    nl = t.indexOf('\n', end);
    if (nl < 0) break;                                      /* the last line is never preamble: there must be a question after it */
    line = t.slice(end, nl);
    if (!(/(unless\s+(?:otherwise\s+)?noted|exam\s+defaults|cover\s+page)/i.test(line) && /assume|default/i.test(line) && line.length > 80)) break;
    last = nl; end = nl + 1;
  }
  if (last > 0) return { pre: t.slice(0, last), preEnd: last, body: t.slice(last) };
  return { pre: '', preEnd: 0, body: t };
}
function parseDefaults(pre, offset) {
  var d = [], m;
  function add(name, value, mm) { d.push({ name: name, value: value, from: mm[0], start: (offset || 0) + mm.index }); }
  /* 0.6: HER line is "all loads given are service (unfactored)", with no second "loads" after it: the old pattern wanted one and her own cover page's
     first assumption was not understood (the note under the box listed 6 of her 7) */
  if ((m = /\b(?:all\s+)?loads\s+(?:given\s+)?are\s+(?:service|unfactored)(?:\s*\(\s*unfactored\s*\))?(?:\s+loads?)?/i.exec(pre))) add('loads_basis', 'service', m);
  if ((m = /\bFy\s*=\s*(\d+(?:\.\d+)?)\s*ksi/i.exec(pre))) add('Fy', Number(m[1]), m);
  if ((m = /pinned\s+support\s+conditions?/i.exec(pre))) add('end_condition', 'pinned-pinned', m);
  if ((m = /\bK\s*=\s*1(?:\.0)?\s+for\s+all\s+columns/i.exec(pre))) add('K', 1, m);
  if ((m = /concrete\s+unit\s+weight[^=]*=\s*(\d+(?:\.\d+)?)\s*(?:lb\s*\/\s*ft\s*\^?\s*3|pcf|pounds?\s*\/\s*ft\s*\^?\s*3)/i.exec(pre))) add('concrete_pcf', Number(m[1]), m);
  if ((m = /connection\s+shear\s+lag\s+factor\s+U\s*=\s*(\d*\.?\d+)/i.exec(pre))) add('U', Number(m[1]), m);
  if ((m = /full\s+lateral\s+bracing[^;]*/i.exec(pre))) add('full_lateral_bracing', true, m);
  return d;
}

/* ---------------------------------------------------------------- 6. asks */
var ASKDEFS = [
  ['effective_net_area', /effective\s+net\s+area|\bAe\b/i],
  ['net_area', /\bnet\s+area\b|\bA_n\b|\bAn(?=\s*(?:=|\?|,|\)|:|;|\.\s|\s+in\b))|\bA\s*_?\s*net\b/i],
  ['U', /shear[\s-]*lag(?:\s+factor)?/i],
  ['capacity', /(?:design\s+)?(?:tensile|compressive|flexural|axial|moment)?\s*(?:strength|capacity)\b|\bf\s*[cbt]?\s*_?\s*[PM]n\b|phi\s*_?\s*[cbt]?\s*\*?\s*[PM]n|how\s+much\s+(?:axial\s+)?(?:compression|tension|tensile|load)|\bcan\s+(?:support|carry|resist)\b/i],
  ['select', /\bselect\b|\blightest\b|most\s+economical|\bsmallest\b|what\s+size|which\s+(?:W|shape|section)|\bchoose\b|W\s*_{2,}\s*x|C\s*10\s*x\s*_/i],
  ['adequate', /\badequate\b|\bsatisf(?:y|ies|actory)\b|\bis\s+(?:it|the\s+\w+)\s+(?:safe|ok|okay)\b|check\s+(?:whether|if|that)/i],
  ['max_load', /maximum\s+(?:service\s+|superimposed\s+|allowable\s+)?(?:live\s+|dead\s+|axial\s+|factored\s+)?load|largest\s+(?:service\s+)?(?:live\s+)?load|how\s+much\s+live\s+load|maximum\s+(?:service\s+)?live\s+load|\bWL\b[^.]{0,40}\bsupport/i],
  ['moment', /\b(?:maximum\s+|design\s+|factored\s+|ultimate\s+)?moment\b|\bMu\b/i],
  ['reactions', /\breactions?\b/i],
  ['factored_load', /factored\s+load|\bPu\b|\bwu\b|ultimate\s+load|(?:governing|critical|controlling)\s+(?:load\s+)?combination/i],
  ['definition', /\bis\s+called\b|\bcalled\s*:|what\s+is\s+the\s+(?:term|name)|defined\s+as|\bdefinition\b/i],
  ['slenderness', /slenderness|KL\s*\/\s*r\b/i],
  ['critical_load', /critical\s+(?:buckling\s+)?load|\beuler\b/i],
  ['K', /effective\s+length\s+factor|recommended\s+(?:design\s+)?k\b|value\s+of\s+K\b/i],
  ['property', /\b(?:actual\s+|nominal\s+)?(?:depth|width|thickness|area|weight)\s+of\s+a\b|section\s+modulus|radius\s+of\s+gyration|moment\s+of\s+inertia|\bproperties\b/i]
];
function findAsks(t) {
  var out = [], i, m;
  for (i = 0; i < ASKDEFS.length; i++) {
    m = ASKDEFS[i][1].exec(t);
    if (m) out.push({ ask: ASKDEFS[i][0], phrase: m[0].replace(/^\s+|\s+$/g, ''), start: m.index });
  }
  return out;
}

/* ---------------------------------------------------------------- 7. classifier */
function evid(t, list) {
  var score = 0, because = [], i, m;
  for (i = 0; i < list.length; i++) {
    m = list[i][0].exec(t);
    if (m) { score += list[i][1]; if (list[i][1] > 0) because.push(m[0].replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '')); }
  }
  return { score: score, because: because };
}

var DOM = {
  T: [[/\btension\s+member|\btensile\b|\bin\s+tension\b|\btension\b/i, 4], [/\bnet\s+area\b/i, 3], [/shear[\s-]*lag/i, 3], [/block\s+shear/i, 2.5],
      [/bolt\s+holes?|holes?\s+(?:in|across|through)\s+(?:each|every|the|its)\s+(?:flange|web|leg)|lines?\s+of\s+(?:\S+\s+){0,4}?(?:bolts|holes)|staggered|\bgage\b|\bpitch\b/i, 2.5],
      [/\bbolted\b|\bbolts?\b/i, 1.2], [/gross[\s-]*(?:section\s+)?yield|yielding\s+of\s+the\s+gross/i, 2.5], [/\brupture\b/i, 1.5], [/no\s+bolt\s+holes|all\s+connections\s+are\s+welded|\bwelded\b/i, 1.0],
      [/\bL\s*\d+(?:\.\d+)?\s*x\s*\d|\bangles?\b/i, 1.2], [/\bWT\s*\d/i, 1.2], [/\bplate\b[^.]{0,60}\b(?:tension|bolt)/i, 1.5], [/\bAe\b|\bA_n\b|\bAn(?=\s*(?:=|\?|,|\)|:|;))|\bAg\b/, 1.5]],
  C: [[/\bcolumns?\b/i, 4], [/compress(?:ion|ive)/i, 3.5], [/\bbuckl(?:ing|e)\b/i, 3], [/KL\s*\/\s*r\b|slenderness/i, 3.5], [/\beuler\b/i, 3.5], [/effective\s+length|\bK\s*=\s*\d/i, 2],
      [/unbraced\s+length|\bLc\b|\bLx\b|\bLy\b/i, 1.5], [/(?:pinned|fixed|hinged|simple)\s+(?:end|ends|support|supports|at\s+(?:the\s+)?(?:base|bottom|top)|top\s+and\s+bottom)|free\s+to\s+(?:translate|sway)|against\s+rotation|\bsidesway\b/i, 1.8],
      [/laterally\s+supported|weak\s+(?:axis|direction)|\by-y\s+axis|one-third\s+points|third\s+points|mid-?height|braced\s+(?:at|by|perpendicular)/i, 1.5], [/axial\s+(?:compression|load)/i, 1.5],
      [/\bHSS\b|\bpipe\b/i, 0.8], [/cover\s+plates?/i, 1.5], [/proportional\s+limit/i, 2.5], [/\bphi_?c\b|\bf\s*c\s*P\s*n\b/i, 1.5]],
  B: [[/\bbeams?\b/i, 3.5], [/\bgirders?\b/i, 2.5], [/\bmoment\b|\bMu\b|flexur|bending/i, 3], [/simply\s+supported|simple\s+span|\bcantilever\b|\bspans?\b|spanning/i, 2], [/\breactions?\b/i, 2],
      [/lateral(?:ly)?\s+(?:braced|supported)|\bLb\b|fully\s+braced/i, 1.5], [/\bZx\b|plastic\s+section\s+modulus/i, 2], [/uniformly\s+distributed|concentrated\s+loads?|point\s+loads?|k\s*\/\s*ft|lb\s*\/\s*ft|\bplf\b|\bklf\b/i, 1.5],
      [/\bphi_?b\b|\bf\s*b\s*M\s*n\b/i, 1.5], [/kip-?\s?ft|k-ft/i, 1.2]],
  F: [[/\bslab\b/i, 3], [/\bfloors?\b/i, 1.5], [/tributary/i, 2.5], [/framing\s+plan|floor\s+plan|plan\s+view|\bbay\b/i, 2.5], [/\bpsf\b/i, 2], [/on\s+center|\bo\.?c\.?\b|\bspacing\b|spaced/i, 1.5],
      [/interior\s+(?:beam|girder|column)|edge\s+(?:beam|girder)|exterior\s+beam|corner\s+column/i, 2], [/\bgirders?\b/i, 1.0], [/concrete/i, 1.0]],
  L: [[/factored\s+load|load\s+combinations?|governing\s+combination|1\.2\s*D|1\.6\s*L|\bLRFD\s+combinations?/i, 4], [/\bPu\b|\bwu\b/i, 1.5], [/\bwind\b|\bsnow\b|earthquake|seismic|\bPE\b|\bPW\b|\bPS\b/i, 2]]
};
function domainScores(t) {
  var k, o = {};
  for (k in DOM) if (DOM.hasOwnProperty(k)) o[k] = evid(t, DOM[k]);
  return o;
}

var FN_DOMAIN = {
  tension_capacity: 'T', tension_net_area: 'T', tension_select: 'T', tension_required_area: 'T', lookup_U: 'T',
  column_capacity: 'C', column_select: 'C', column_euler: 'C', lookup_K: 'C', lookup_critical_stress: 'C', section_properties: 'C',
  beam_analysis: 'B', beam_capacity: 'B', beam_required_zx: 'B', beam_select: 'B', beam_max_live_load: 'B',
  floor_plan: 'F', loads_floor: 'F', loads_takedown: 'F',
  loads_factored: 'L', loads_combinations: 'L', loads_max_service: 'L'
};

function classify(t, F) {
  var dom = domainScores(t), S = {}, fn, A = {}, i;
  var hasFull = F.shapes.length > 0, fullShapes = distinctShapes(F.shapes), nShapes = fullShapes.length;
  var kinds = {};
  fullShapes.forEach(function (s) { kinds[s.kind] = true; });
  var anyFam = F.families.length > 0;
  for (i = 0; i < F.asks.length; i++) A[F.asks[i].ask] = F.asks[i].phrase;
  var selectish = !!A.select;
  var capacityish = !!A.capacity;
  var loadsGiven = F.loads.length > 0;
  var hasLineLoad = F.loads.some(function (l) { return l.unit === 'klf' || l.unit === 'plf'; });
  var hasPointLoad = F.loads.some(function (l) { return l.unit === 'k' && l.kind !== 'u'; });
  var hasPsf = F.loads.some(function (l) { return l.unit === 'psf'; });
  var wordsDomainTotal = 0;

  function put(name, v, because) {
    if (!S[name]) S[name] = { raw: 0, because: [] };
    S[name].raw += v;
    if (because) S[name].because.push(because);
  }
  for (fn in FN_DOMAIN) {
    if (!FN_DOMAIN.hasOwnProperty(fn)) continue;
    var d = dom[FN_DOMAIN[fn]];
    S[fn] = { raw: d.score, because: d.because.slice(0, 3) };
  }
  function bonus(fn, v, why) { if (!S[fn]) S[fn] = { raw: 0, because: [] }; S[fn].raw += v; if (why) S[fn].because.push(why); }
  function pen(fn, v) { if (S[fn]) S[fn].raw -= v; }

  // ---- mode: select / capacity / net area / U / analysis ...
  var selWhy = A.select || '';
  if (selectish) {
    bonus('tension_select', 4, selWhy); bonus('column_select', 4, selWhy); bonus('beam_select', 4, selWhy);
    bonus('floor_plan', 1.0, selWhy);
  }
  if (capacityish) {
    bonus('tension_capacity', 3, A.capacity); bonus('column_capacity', 3, A.capacity); bonus('beam_capacity', 3, A.capacity);
  }
  if (A.net_area && !A.effective_net_area) { bonus('tension_net_area', 5, A.net_area); }
  if (A.effective_net_area) { bonus('tension_capacity', 4, A.effective_net_area); bonus('tension_net_area', 2.5, A.effective_net_area); bonus('lookup_U', 1.5, A.effective_net_area); }
  if (A.U) { bonus('lookup_U', 5, A.U); }
  if (A.critical_load) { bonus('column_euler', 4, A.critical_load); }
  if (A.slenderness) { bonus('column_capacity', 3, A.slenderness); }
  if (A.max_load) { bonus('beam_max_live_load', 3, A.max_load); bonus('loads_max_service', 1.5, A.max_load); }
  if (A.reactions) { bonus('beam_analysis', 3, A.reactions); }
  if (A.moment) { bonus('beam_analysis', 2, A.moment); bonus('beam_capacity', 1, A.moment); bonus('beam_select', 1, A.moment); }
  if (A.definition) { S.lookup_definition = { raw: 7, because: [A.definition] }; }
  if (A.K && !loadsGiven && !hasFull) { bonus('lookup_K', 5, A.K); }

  // ---- what the member is
  var hasTee = kinds.WT || kinds.MT || kinds.ST, hasAngle = kinds.L || kinds['2L'], hasChan = kinds.C || kinds.MC;
  if (hasAngle) { bonus('tension_capacity', 1.5); bonus('tension_net_area', 1.0); }
  if (hasTee) { bonus('tension_capacity', 1.5); }
  if (kinds.HSS || kinds.PIPE) { bonus('column_capacity', 1.0); bonus('column_select', 0.5); }
  if (F.plates.length) { bonus('tension_capacity', 1.5); }

  // ---- shapes vs families
  if (hasFull) {
    ['tension_capacity', 'column_capacity', 'beam_capacity', 'beam_max_live_load'].forEach(function (f) { bonus(f, 1.0); });
    ['tension_select', 'column_select', 'beam_select'].forEach(function (f) { pen(f, selectish ? 0 : 1.5); });
  }
  if (anyFam && !hasFull && !F.plates.length) { ['tension_select', 'column_select', 'beam_select'].forEach(function (f) { bonus(f, 1.5); }); }

  // ---- loads
  if (hasPsf && F.slab) { bonus('loads_floor', 3.5, 'slab + psf'); bonus('floor_plan', 3, 'slab + psf'); bonus('beam_max_live_load', 1.0); bonus('loads_takedown', 1.5); }
  if (F.floorsN) { bonus('loads_takedown', 5, F.floorsN.from); }
  if (F.slab && !hasPsf) { bonus('loads_floor', 1.5); bonus('floor_plan', 1.5); }
  if (hasPsf && !F.slab) { bonus('loads_takedown', 1.0); }
  if (F.loads.some(function (l) { return l.kind === 'E' || l.kind === 'W' || l.kind === 'S' || l.kind === 'R' || l.kind === 'Lr'; })) { bonus('loads_combinations', 3.5, 'E/W/S/R/Lr load'); }
  if (/load\s+combinations?|governing\s+(?:load\s+)?combination|critical\s+(?:load\s+)?combination|each\s+(?:LRFD\s+)?(?:load\s+)?combination|combinations?\s+of\s+loads|\bLRFD\s+combinations?/i.test(t)) { bonus('loads_combinations', 5, 'load combinations'); pen('loads_factored', 1); }
  else if (/factored\s+loads?|ultimate\s+load/i.test(t)) { bonus('loads_factored', 3); bonus('loads_combinations', 1); }
  if (F.loads.some(function (l) { return l.kind === 'E' || l.kind === 'W' || l.kind === 'S' || l.kind === 'R' || l.kind === 'Lr'; })) { pen('loads_factored', 2.5); }
  if (A.capacity === undefined) { /* nothing */ }
  if (A.capacity && !A.net_area && !A.effective_net_area) { pen('tension_net_area', 2.5); }
  if (A.max_load && /phi\s*_?\s*[PMR]n\s*=\s*\d|design\s+strength\s+(?:of|is|=)\s*\d/i.test(t)) { bonus('loads_max_service', 6, 'design strength given'); }
  if (/hole\s+(?:size|diameter)\b/i.test(t) && F.bolt && !F.holes.perFlange && !F.holes.web && !F.holes.perLine) { bonus('lookup_hole', 7, 'hole size for a bolt'); pen('tension_net_area', 3); pen('tension_capacity', 3); }
  if (A.factored_load && !F.shapes.length && !anyFam) { bonus('loads_factored', 2.5); }
  if (hasLineLoad || (hasPointLoad && /span|beam|girder/i.test(t))) { bonus('beam_analysis', 2); bonus('beam_select', 1.5); bonus('beam_capacity', 0.5); }
  if (F.pu && !hasFull && !anyFam) { bonus('loads_factored', 1.5); }

  // ---- floor chain
  if (/\bgirders?\b/i.test(t) && /\bcolumn\b/i.test(t) && /\bbeams?\b/i.test(t) && F.slab) { bonus('floor_plan', 3, 'beam + girder + column on a slab'); }
  if (F.slab && F.beamHint) { bonus('loads_floor', 1); }

  // ---- euler / properties
  if (/proportional\s+limit|euler|critical\s+buckling\s+load/i.test(t)) { bonus('column_euler', 3.5); pen('column_capacity', 1.5); pen('column_select', 2); }
  if (F.cover || (F.bar && /\b(?:column|buckl|euler|compress)/i.test(t) === false)) { bonus('section_properties', 4, F.cover ? F.cover.from : 'solid bar'); }
  if (F.cover) { bonus('column_capacity', 1.5); }
  if (F.bar && /\b(?:column|buckl|euler|critical)/i.test(t)) { bonus('column_euler', 3, F.bar.from); }
  if (F.bar && !/\b(?:column|buckl|euler|compress|critical)/i.test(t)) { bonus('section_properties', 2, F.bar.from); }

  // ---- lookups
  var propPhrase = F.property ? F.property.from : '';
  if (propPhrase && nShapes >= 1 && !loadsGiven && !/\b(?:capacity|strength|select|lightest|economical)\b/i.test(t)) { S.lookup_shape = { raw: 8, because: [propPhrase] }; }
  else if (propPhrase && nShapes >= 1) { bonus('lookup_shape', 1.0); }
  if (/(?:lightest|smallest|least\s+weight)[^.]{0,40}(?:with|having|whose)[^.]{0,40}(?:\bI[xy]\b|\bZ[xy]\b|\bS[xy]\b|\bA\b|\br[xy]\b)[^.]{0,30}(?:at\s+least|of\s+at\s+least|greater|no\s+less|minimum|>=)/i.test(t)) { bonus('lookup_by_property', 7, 'lightest with property at least'); }
  if (/hole\s+(?:size|diameter)\s+for|diameter\s+of\s+the\s+hole|(?:what|find)[^.]{0,20}hole\s+(?:size|diameter)/i.test(t) && !F.holes.perFlange && !F.holes.web) { bonus('lookup_hole', 5, 'hole size'); }
  if (/\bFy\s+and\s+Fu\b|yield\s+(?:stress|strength)\s+(?:and|of)\s+(?:a|an|the)\s+(?:W|HSS|pipe|plate|angle|channel)|what\s+(?:steel\s+)?grade/i.test(t) && !loadsGiven) { bonus('lookup_material', 5, 'Fy and Fu of a shape'); }
  if (/\bconvert\b|how\s+many\s+(?:inches|feet|kips|k\/ft)|\bin\s+kip-?ft\s+to\b/i.test(t) && !loadsGiven) { bonus('units', 3, 'convert'); }
  if (/\bFcr\b|critical\s+stress|table\s+4-14|design\s+stress/i.test(t) && /KL\s*\/\s*r\s*=?\s*\d/i.test(t)) { bonus('lookup_critical_stress', 6, 'critical stress for KL/r'); }
  if (/required\s+(?:gross\s+)?area|minimum\s+gross\s+area|Ag\s+required|\bAg\s*,?\s*req/i.test(t)) { bonus('tension_required_area', 5, 'required area'); pen('tension_select', 0); }
  if (/required\s+(?:plastic\s+)?section\s+modulus|\bZ\s*x?\s*,?\s*req|minimum\s+Zx/i.test(t)) { bonus('beam_required_zx', 5, 'required Zx'); }
  if (/(?:maximum|largest)\s+(?:service\s+)?(?:live|working|allowable)\s+load|how\s+much\s+(?:live\s+)?load[^.]{0,40}(?:given|if)\b[^.]{0,60}\bD\b/i.test(t) && (/phi\s*_?\s*[RPM]n|design\s+strength|capacity/i.test(t))) { bonus('loads_max_service', 3.5, 'maximum service load from a design strength'); }
  if (/(?:effective\s+length\s+factor|recommended\s+(?:design\s+)?K|value\s+of\s+K|what\s+is\s+K)\b/i.test(t) && !F.shapes.length) { bonus('lookup_K', 3); }

  // ---- beam-specific
  if (/\bcantilever\b/i.test(t) && !/column/i.test(t)) { bonus('beam_analysis', 1); bonus('beam_select', 1); }
  if (F.shapes.length && A.max_load && F.slab) { bonus('beam_max_live_load', 2); }
  if (/(?:most\s+economical|lightest)\s+(?:W|beam|shape|section)/i.test(t) && (dom.B.score > dom.C.score)) { bonus('beam_select', 1.5); }

  // ---- final list
  var list = [], k;
  // a question that is only words ("... is called:" with a list of terms) and names no shape and gives no quantity is a definition look-up
  var verbal = /word\s+question|\b(?:list|explain|define|state|describe|why)\b|\bwhat\s+(?:is|are|does)\b|\bhow\s+(?:much|many)\b/i.test(t) && !F.plates.length && F.loads.length === 0;
  if ((A.definition || verbal) && !hasFull && !anyFam && !F.q.some(function (q) { return q.unit; })) {
    var mx = 0; for (k in S) if (S.hasOwnProperty(k) && S[k].raw > mx) mx = S[k].raw;
    S.lookup_definition = { raw: mx + 6, because: [A.definition, 'no shape and no quantity in the text'] };
  }
  for (k in S) if (S.hasOwnProperty(k)) list.push({ fn: k, raw: S[k].raw, because: dedupe(S[k].because) });
  list.sort(function (a, b) { return b.raw - a.raw; });
  var top = list.length && list[0].raw > 0 ? list[0].raw : 1;
  list.forEach(function (c) { c.score = Math.max(0, Math.round((c.raw / (top + 4)) * 100) / 100); });
  return { list: list.slice(0, 8), dom: dom };
}
/* 0.6: a reason that is not a string (line 539 can pass an undefined one) made this throw, and the throw emptied the WHOLE read, even when the page had named the
   form: "If a column has ... slenderness ratio kL/r = 100, what is the available nominal stress?" came back with no field at all (real May 2024 final, Q18). */
function dedupe(a) { var seen = {}, o = []; (a || []).forEach(function (x) { if (x === undefined || x === null || x === '') return; var k = String(x).toLowerCase(); if (!seen[k]) { seen[k] = 1; o.push(String(x)); } }); return o; }

/* ---------------------------------------------------------------- 8. facts for one chunk of text */
function gatherFacts(t, pre, partStart) {
  var F = { t: t, partStart: partStart || 0 }, m, s;
  var sh = findShapes(t);
  F.shapes = sh.shapes; F.plates = sh.plates; F.families = sh.families;
  F.dshapes = distinctShapes(sh.shapes);
  F.q = scanQuantities(sh.masked);
  F.loads = findLoads(sh.masked);
  F.asks = findAsks(t);
  F.ends = findEnds(t);
  F.pu = F.loads.some(function (l) { return l.kind === 'u' && l.first === 'P'; });
  // slab
  F.slab = null;
  m = new RegExp('(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*-?\\s*(?:thick(?:ness)?\\s+)?(?:reinforced\\s+)?(?:concrete\\s+)?(?:floor\\s+)?slab', 'i').exec(t);
  if (m) F.slab = { value: dimValue(m[1]), from: m[0] };
  if (!F.slab) {
    m = new RegExp('slab\\s+(?:thickness\\s*(?:=|of|is)\\s*|is\\s+)(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")', 'i').exec(t);
    if (m) F.slab = { value: dimValue(m[1]), from: m[0] };
  }
  /* 0.6 (review 3): "a 6 in. thick normal weight concrete slab", "a slab whose thickness is 6 in.", "a slab 6 in. thick", "0.5 ft thick": the floor load
     was worked out with NO slab (184 psf printed for 271) */
  if (!F.slab) {
    m = new RegExp('(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*-?\\s*thick\\s+(?:[A-Za-z-]+\\s+){0,4}?slab', 'i').exec(t)
      || new RegExp('\\bslab\\b[^.;]{0,40}?\\bthickness\\s+(?:is|of|=)\\s*(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")', 'i').exec(t)
      || new RegExp('\\bslab\\b[^.;0-9]{0,30}?(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*-?\\s*thick\\b', 'i').exec(t);
    if (m) F.slab = { value: dimValue(m[1]), from: m[0] };
  }
  if (!F.slab && /\bslab\b/i.test(t)) {
    m = new RegExp('(' + N + ')\\s*-?\\s*(?:ft|feet|foot)\\s*-?\\s*thick\\b', 'i').exec(t);
    if (m) F.slab = { value: round6(parseNum(m[1]) * 12), from: m[0], rule: 'ft -> in' };
  }
  /* 0.6 (review 4, the worst of its holes): the usual adjectives between the thickness and the word: "a 6 in. normal weight concrete slab",
     "6 inch normal-weight concrete floor slab", "a 6 inch concrete floor", "a six inch concrete slab", "a slab of 6 in. thickness".  The floor load was
     worked out with NO slab (93.6 kip-ft printed for 174.6), because a dead load in psf was also given. */
  if (!F.slab) {
    var SLAB_ADJ = '(?:(?:thick|normal[\\s-]?weight|light[\\s-]?weight|reinforced|concrete|composite|structural|solid|floor|deck|cast[\\s-]in[\\s-]place|RC)\\s+){0,5}';
    m = new RegExp('(' + N + '|four|five|six|seven|eight|nine|ten)\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*-?\\s*' + SLAB_ADJ + '(?:slab|concrete\\s+floor)\\b', 'i').exec(t)
      || new RegExp('\\bslab\\s+of\\s+(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*-?\\s*thick(?:ness)?', 'i').exec(t)
      || new RegExp('\\bslab\\s+thickness\\s+t\\s*=\\s*(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")', 'i').exec(t);
    if (m) F.slab = { value: /^[a-z]/i.test(m[1]) ? wnum(m[1]) : dimValue(m[1]), from: m[0] };
  }
  /* 0.8: the thickness right after the word, as on a data sheet: "Slab: 5 in, 150 pcf", "Slab 5 in, live load 80 psf", "slab = 6 in." */
  if (!F.slab) {
    m = new RegExp('\\bslab\\s*(?::|=|,)?\\s*(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")(?![A-Za-z])(?!\\s*(?:o\\.?c|on\\s+cent|apart|from|above|below|wide|long))', 'i').exec(t);
    if (m && parseNum(m[1]) >= 2 && parseNum(m[1]) <= 14) F.slab = { value: dimValue(m[1]), from: m[0] };
  }
  if (!F.slab && /\bslab\b/i.test(t)) F.slabWord = true;
  // number of floors
  m = new RegExp('(' + WN + ')\\s+(?:floor|story|storey)(?:s)?(?:\\s+levels?)?\\b|(' + WN + ')\\s+floor\\s+levels?', 'i').exec(t);
  if (m && /column|supports?|carr(?:y|ies)/i.test(t)) F.floorsN = { value: wnum(m[1] || m[2]), from: m[0] };
  /* 0.6 (fresh exams 10/06): "four office floors", "three typical floor levels", "a single floor" */
  if (!F.floorsN && /column/i.test(t)) {
    m = new RegExp('\\b(' + WN + ')\\s+(?:(?:office|typical|identical|residential|occupied|elevated|upper|storage|retail|classroom|framed|supported)\\s+){1,2}(?:floor|story|storey)(?:s)?(?:\\s+levels?)?\\b', 'i').exec(t);
    if (m) F.floorsN = { value: wnum(m[1]), from: m[0] };
    else if ((m = /\b(?:a\s+)?(?:single|one)\s+(?:(?:office|typical|elevated)\s+)?(?:floor|story|storey)(?:\s+level)?\b(?!\s+slab)/i.exec(t)) && /\bsupports?\b|\bcarr(?:y|ies)\b/i.test(t)) F.floorsN = { value: 1, from: m[0] };
  }
  // plate/bar facts
  m = new RegExp('(?:solid\\s+)?(?:round|circular)\\s+bar\\s+(?:of\\s+)?(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")?\\s*(?:in\\s+)?(?:diameter|dia\\.?)', 'i').exec(t);
  if (!m) m = new RegExp('(?:solid\\s+)?(?:round\\s+)?(?:bar|rod)[^.]{0,20}?(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*(?:in\\s+)?(?:diameter|dia\\.?)', 'i').exec(t);
  if (m) F.bar = { value: dimValue(m[1]), from: m[0] };
  m = new RegExp('(?:with|and|plus|has|having|reinforced\\s+(?:with|by))\\s+(?:a\\s+|two\\s+|2\\s+)?(' + FR + ')\\s*(?:in\\.?|")?\\s*x\\s*(' + FR + ')\\s*(?:in\\.?|")?\\s*(?:steel\\s+)?(?:cover\\s+)?plates?', 'i').exec(t);
  if (m && /cover|welded|flange/i.test(t)) F.cover = { a: m[1], b: m[2], from: m[0] };
  if (!F.cover && /cover\s+plates?/i.test(t) && F.plates.length) F.cover = { a: F.plates[0].a, b: F.plates[0].b, from: F.plates[0].raw };
  // shape property question (lookup_shape)
  F.property = findProperty(t);
  // holes
  F.holes = findHoles(sh.masked);
  F.bolt = findBolt(sh.masked);
  if (!F.bolt && F.holes.gBolt) F.bolt = F.holes.gBolt;        /* 0.8: "bolts (7/8 in)", "two bolts in each flange, all 7/8 inch diameter" */
  F.grade = findGrade(t, F.partStart);
  F.lengths = findLengths(sh.masked);
  F.pre = pre;
  return F;
}

var PROPS = [
  [/(?:actual\s+)?web\s+(?:width|thickness)|\btw\b/i, 'tw'], [/flange\s+thickness|\btf\b/i, 'tf'], [/flange\s+width|\bbf\b/i, 'bf'],
  [/plastic\s+section\s+modulus|plastic\s+modulus|\bZ\s*([xy])\b/i, 'Z'], [/section\s+modulus/i, 'S'],
  [/radius\s+of\s+gyration/i, 'r'], [/moment\s+of\s+inertia/i, 'I'], [/(?:actual\s+|nominal\s+)?depth\b/i, 'd'], [/\b(?:cross[- ]sectional\s+)?area\b/i, 'A'],
  [/weight\s+per\s+(?:foot|ft)|\bweight\b/i, 'W']
];
function trim0(x) { return String(x).replace(/^[\s(,:;]+|\s+$/g, ''); }
function findProperty(t) {
  var i, m, p = null, axis = null;
  if (!/\b(?:of|for)\s+(?:a|an|the)\s+(?:W|M|S|HP|C|MC|L|WT|MT|ST|HSS|pipe)/i.test(t)) return null;
  /* 0.6: the symbol itself, right in front of "of a <shape>": "Give ry of a W12X30", "A of a WT12X88", "tdes of a HSS9X9X1/2".  Before, such a question
     came back with EVERY property of the shape and no way to tell which one was asked. */
  var sym = /(?:^|[\s(,:;])(I[xy]|S[xy]|Z[xy]|r[xy]|t[wf]|bf|tdes|tnom|d|A)\s+(?:of|for)\s+(?:a|an|the)\s+(?:W|M|S|HP|C|MC|L|WT|MT|ST|HSS|pipe)/.exec(t);
  if (sym) return { key: sym[1], name: sym[1], axis: /[xy]$/.test(sym[1]) && sym[1].length === 2 && /^[ISZr]/.test(sym[1]) ? sym[1].slice(-1) : null, from: trim0(sym[0]), axisAmbiguous: false };
  for (i = 0; i < PROPS.length; i++) {
    m = PROPS[i][0].exec(t);
    if (m) { p = { key: PROPS[i][1], from: m[0], idx: m.index, zxy: m[1] }; break; }
  }
  if (!p) return null;
  var ax = /(strong|major|x-x|x\s*axis)/i.exec(t), ay = /(weak|minor|y-y|y\s*axis)/i.exec(t);
  if (ax && !ay) axis = 'x'; else if (ay && !ax) axis = 'y';
  if (p.zxy) axis = p.zxy.toLowerCase();
  /* 0.6: the axis written as part of the symbol next to the name: "the moment of inertia Ix of a W14x90" */
  if (!axis && (p.key === 'I' || p.key === 'S' || p.key === 'Z' || p.key === 'r')) { var sa = new RegExp('(?:^|[^A-Za-z])' + p.key + '([xy])(?![A-Za-z0-9])').exec(t); if (sa) axis = sa[1]; }
  var name = null;
  if (p.key === 'tw' || p.key === 'tf' || p.key === 'bf' || p.key === 'd' || p.key === 'A' || p.key === 'W') name = p.key === 'W' ? null : p.key;
  else if (axis) name = (p.key === 'Z' ? 'Z' : p.key) + axis;
  return { key: p.key, name: name, axis: axis, from: p.from, axisAmbiguous: !name && (p.key === 'S' || p.key === 'Z' || p.key === 'r' || p.key === 'I') };
}

/* ---------------------------------------------------------------- 4a. the count grammar (0.8)
   Bolt and hole patterns are read CLAUSE BY CLAUSE from tokens, in any order, not from one pattern per sentence:
     count   a number word or a whole number that stands alone (never part of a size: the 8 of "7/8", the 3 of "3 in.")
     size    a number with an inch unit, or a fraction / a decimal: a bolt diameter, a pitch, a gage, an edge distance -- NEVER a count
     thing   line / row ; bolt / fastener / rivet ; hole                               (singular or plural)
     place   each flange, per flange, both flanges, the flanges, the flange, the web, the leg, each line, per line, the section
   An ITEM is   count [size] [adjectives] [web | flange] thing [of [count] [size] bolts]   with its place after it or before it in the same clause:
     "two lines of three 7/8-in bolts in each flange"    "each flange has two lines"    "three bolts per line, two lines per flange"
     "bolts (7/8 in) in two rows on both flanges"        "two transverse web holes"     "four 3/4-in bolts per longitudinal line"     "4 per line"
   What an item means (the same meanings the older rules have):
     lines, bolts or holes IN EACH flange (per flange, on both flanges) -> holes across each flange (a section cuts one hole in each line)
     lines or holes in THE FLANGES (the two together)                   -> a total; each flange has half of it (her May 2024 final, Q8)
     lines, bolts or holes in the web                                   -> holes in the web
     bolts PER LINE, and the M of "N lines of M bolts"                  -> fasteners per line (for U): never holes across a section
     lines with no place                                                -> the number of lines (a plate or an angle: one hole across for each line)
   The grammar only FILLS what the older rules left empty.  Where both read the same thing and differ, the OLDER reading is kept and the difference is put
   in H.conflicts, so the form can say so.  A count the words do not give stays missing: nothing here ever turns "not found" into 0. */
var CG_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, single: 1, 'double': 2 };
var CG_CLASS = {};
(function () {
  function put(kind, words) { words.split(' ').forEach(function (w) { CG_CLASS[w] = kind; }); }
  put('LINE', 'line lines row rows');
  put('BOLT', 'bolt bolts fastener fasteners rivet rivets');
  put('HOLE', 'hole holes');
  put('FLANGE', 'flange'); put('FLANGES', 'flanges'); put('WEB', 'web stem'); put('LEG', 'leg legs'); put('SECTION', 'section width');
  put('EACH', 'each every either'); put('BOTH', 'both'); put('PER', 'per'); put('NO', 'no none without'); put('ANY', 'any');
  put('DET', 'the its their this that'); put('A', 'a an');
  put('PREP', 'in through thru across on along at into within');
  put('OF', 'of'); put('WITH', 'with by using having'); put('FOR', 'for'); put('TO', 'to');
  put('VERB', 'has have had contains contain carries carry is are was were');
  put('AND', 'and plus');
  put('ADJ', 'transverse transversely longitudinal longitudinally staggered standard high strength structural a325 a490 diameter dia diam drilled punched located placed arranged cut gage gauge more additional equal connected attached long short longer shorter outstanding critical net cross gross top bottom same parallel only all total');
})();
function cgTokens(t) {
  var re = new RegExp('(' + N + ')(?:(\\s*-?\\s*)(' + UNITS + ')(\\.(?=\\s+(?:[a-z0-9(]|A\\d)))?)?|([A-Za-z][A-Za-z0-9\']*)|([,;:()=.\\/])|(\\n\\s*\\n)', 'g'), out = [], m, raw, v, u, prev, isInt, w, nx, rest, k;
  while ((m = re.exec(t)) !== null) {
    if (m[1] !== undefined) {
      raw = m[1]; prev = m.index > 0 ? t.charAt(m.index - 1) : ' ';
      if (/[A-Za-z_\/.\d]/.test(prev)) { out.push({ k: 'X', s: m.index, e: m.index + m[0].length }); continue; }            /* glued to a letter (A36, g1), or the tail of another number */
      isInt = /^\d+$/.test(raw); v = parseNum(raw); u = m[3] ? canonUnit(m[3]) : '';
      /* "2 in each flange", "7/8 in each flange": after a number the word "in" before each / the / both ... is the PREPOSITION, not the inch */
      if (u === 'in' && /^in$/i.test(m[3]) && /^\s+$/.test(m[2]) && !m[4]) {
        nx = /^\s+([A-Za-z]+)/.exec(t.slice(m.index + m[0].length));
        if (nx && /^(?:each|every|either|the|its|their|both|a|an|any|one|all|total)$/i.test(nx[1])) { u = isInt ? '' : 'in'; re.lastIndex = m.index + raw.length; m[0] = raw; }
      }
      rest = t.slice(m.index + m[0].length, m.index + m[0].length + 6);
      if (u && u !== 'in') { out.push({ k: 'QTY', s: m.index, e: m.index + m[0].length }); continue; }                      /* feet, kips, psf ...: never a count */
      if (/=\s*$/.test(t.slice(Math.max(0, m.index - 3), m.index))) { out.push({ k: 'X', s: m.index, e: m.index + m[0].length }); continue; }   /* "g = 3", "U = 1": a value */
      if (u === 'in' || !isInt) { out.push({ k: 'SIZE', v: v, val: dimValue(raw), unit: u === 'in', s: m.index, e: m.index + m[0].length, raw: m[0] }); continue; }
      if (v > 40 || /^\s*(?:[xX]\s*\d|%|\/)/.test(rest)) { out.push({ k: 'X', s: m.index, e: m.index + m[0].length }); continue; }       /* a year, a dimension "9 x 1/4" */
      if (/\b(?:case|table|part|hole|bolt|question|problem|step|figure|fig|line|row|section|chapter|item|no|number|grade|type|class|example|combination|eq|equation|page|week|slide|diagram|path|level|floor|story|span)\.?\s+$/i.test(t.slice(Math.max(0, m.index - 14), m.index))) { out.push({ k: 'X', s: m.index, e: m.index + m[0].length }); continue; }   /* "case 8", "hole 1": a label */
      out.push({ k: 'CNT', v: v, s: m.index, e: m.index + m[0].length, raw: raw });
    } else if (m[5] !== undefined) {
      w = m[5].toLowerCase();
      if (CG_NUM[w] !== undefined) out.push({ k: 'CNT', v: CG_NUM[w], word: true, s: m.index, e: m.index + m[0].length, raw: m[5] });
      else out.push({ k: CG_CLASS[w] || 'W', w: w, s: m.index, e: m.index + m[0].length, raw: m[5] });
    } else if (m[7] !== undefined) out.push({ k: 'STOP', s: m.index, e: m.index + m[0].length });
    else {
      k = m[6];
      if (k === '.') { if (/^(?:\s+[A-Z0-9(]|\s*$)/.test(t.slice(m.index + 1, m.index + 12)) || m.index + 1 >= t.length) out.push({ k: 'STOP', s: m.index, e: m.index + 1 }); }
      else if (k === '/') { if (out.length && (out[out.length - 1].k === 'LINE' || out[out.length - 1].k === 'BOLT' || out[out.length - 1].k === 'HOLE') && out[out.length - 1].e === m.index) out.push({ k: 'PER', w: 'per', s: m.index, e: m.index + 1, raw: k }); }   /* "2 lines/flange", "3 bolts/line" */
      else out.push({ k: k === ',' ? 'COMMA' : (k === ';' ? 'STOP' : (k === '=' ? 'EQ' : 'PUNC')), s: m.index, e: m.index + 1, raw: k });
    }
  }
  /* "2 3/4-in bolts" is two bolts of 3/4 in: a mixed number over 1 1/2 in right before a bolt or a hole is a count and a size */
  for (k = 0; k < out.length; k++) {
    if (out[k].k === 'SIZE' && out[k].v > 1.5 && /^\d+\s+\d+\/\d+/.test(out[k].raw) && k + 1 < out.length && (out[k + 1].k === 'BOLT' || out[k + 1].k === 'HOLE' || out[k + 1].k === 'ADJ')) {
      m = /^(\d+)(\s+)(\d+\/\d+)/.exec(out[k].raw);
      if (Number(m[1]) <= 12) out.splice(k, 1, { k: 'CNT', v: Number(m[1]), s: out[k].s, e: out[k].s + m[1].length, raw: m[1] },
        { k: 'SIZE', v: parseNum(m[3]), val: m[3], unit: out[k].unit, s: out[k].s + m[1].length + m[2].length, e: out[k].e, raw: out[k].raw.slice(m[1].length + m[2].length) });
    }
  }
  return out;
}
function cgItems(t) {
  var toks = cgTokens(t), n = toks.length, items = [], sizes = [], i = 0, pend = null, neg = false, clause = 0, tk, it, sc, k, via;
  /* a place phrase at token j: [in | through | across | on | along | at | per] [each | both | the | its | a | one | any] [adjectives] flange(s) | web | leg | line | section */
  function scopeAt(j) {
    var a = j, q = null, prep = null, pl, s0 = null, x, one = false;
    if (a < n && (toks[a].k === 'PREP' || toks[a].k === 'PER' || toks[a].k === 'TO')) { prep = toks[a]; a++; }
    if (a < n && (toks[a].k === 'EACH' || toks[a].k === 'BOTH' || toks[a].k === 'DET' || toks[a].k === 'A' || toks[a].k === 'ANY' || (toks[a].k === 'CNT' && toks[a].v === 1 && toks[a].word))) { q = toks[a]; a++; }
    if (q && q.k === 'EACH' && a < n && toks[a].k === 'OF') { a++; while (a < n && (toks[a].k === 'DET' || toks[a].k === 'BOTH' || (toks[a].k === 'CNT' && toks[a].v === 2))) a++; }      /* "each of the two flanges" */
    else if (q && (q.k === 'DET' || q.k === 'BOTH') && a < n && (toks[a].k === 'CNT' && toks[a].v === 2 || toks[a].k === 'DET')) a++;                                           /* "the two flanges", "both the flanges" */
    else if (q && q.k === 'A' && a < n && toks[a].k === 'CNT' && toks[a].v === 1 && toks[a].word) { a++; one = true; }                                                          /* "in a single line" */
    if (q && q.k === 'CNT' && prep && prep.k === 'PREP') one = true;                                                                                                             /* "in one line" */
    while (a < n && (toks[a].k === 'ADJ' || toks[a].k === 'SIZE' || (toks[a].k === 'BOLT' && a + 1 < n && toks[a + 1].k === 'LINE'))) a++;
    if (a >= n || (!prep && !q)) return null;
    pl = toks[a];
    if (prep && prep.k === 'TO' && !(pl.k === 'LINE' && q)) return null;                                                                                                         /* "three bolts to a line" only */
    if (pl.k === 'LINE') { if ((prep && prep.k === 'PER') || (q && (q.k === 'EACH' || q.k === 'A' || q.k === 'ANY' || q.k === 'CNT' || (q.k === 'DET' && q.w === 'the')))) s0 = 'PERLINE'; }
    else if (pl.k === 'FLANGE') s0 = ((prep && prep.k === 'PER') || (q && (q.k === 'EACH' || q.k === 'BOTH' || q.k === 'ANY'))) ? 'EACHFLANGE' : 'ONEFLANGE';
    else if (pl.k === 'FLANGES') s0 = (q && (q.k === 'EACH' || q.k === 'BOTH')) ? 'EACHFLANGE' : 'FLANGES';
    else if (pl.k === 'WEB') s0 = 'WEB';
    else if (pl.k === 'LEG') s0 = 'LEG';
    else if (pl.k === 'SECTION') s0 = 'SECTION';
    if (!s0) return null;
    a++;
    if (s0 === 'FLANGES' && a < n && toks[a].k === 'EACH' && !(a + 1 < n && (toks[a + 1].k === 'LINE' || toks[a + 1].k === 'FLANGE'))) { s0 = 'EACHFLANGE'; a++; }                 /* "the flanges each have ..." */
    /* the flange or the web of ANOTHER member ("to the web of a W14 column", "the flange of the supporting girder") is not a place on this one */
    if (a < n && toks[a].k === 'OF') {
      for (x = a + 1; x < n && x <= a + 4; x++) if (toks[x].k === 'W' && /^(?:column|columns|girder|girders|beam|beams|support|supports|gusset|plate|plates|chord|bracket)$/.test(toks[x].w)) return { foreign: true, end: x + 1 };
    }
    return { scope: s0, end: a, prep: !!prep, quant: !!(q && (q.k === 'EACH' || q.k === 'BOTH')), oneLine: one && s0 === 'PERLINE' };
  }
  /* is the word bolt / hole in the same clause as token i0 (a clause ends at a period or a semicolon)? */
  function boltInClause(i0) {
    var x;
    for (x = i0 - 1; x >= 0 && toks[x].k !== 'STOP'; x--) if (toks[x].k === 'BOLT' || toks[x].k === 'HOLE') return true;
    for (x = i0 + 1; x < n && toks[x].k !== 'STOP'; x++) if (toks[x].k === 'BOLT' || toks[x].k === 'HOLE') return true;
    return false;
  }
  function verbAfter(e) {
    var x = e;
    if (x < n && toks[x].k === 'OF') { x++; while (x < n && x < e + 5 && (toks[x].k === 'DET' || toks[x].k === 'A' || toks[x].k === 'W')) x++; }
    while (x < n && toks[x].k === 'ADJ') x++;
    return x < n && toks[x].k === 'VERB';
  }
  function itemAt(i0) {
    var c = toks[i0], j = i0 + 1, size = null, adj = {}, placeAdj = null, thing = null, inner = null, a, e, s1 = null, k1, hold, skipped = 0, post = false;
    if (j < n && toks[j].k === 'PUNC' && toks[j].raw === ')' && i0 > 0 && toks[i0 - 1].k === 'PUNC' && toks[i0 - 1].raw === '(') j++;                           /* "(2) 7/8-in bolts" */
    for (;;) {
      if (j >= n) break;
      a = toks[j];
      if (a.k === 'SIZE' && !size) { size = a; j++; continue; }
      if (a.k === 'ADJ') { adj[a.w] = true; j++; continue; }
      if (a.k === 'BOLT' && j + 1 < n && (toks[j + 1].k === 'HOLE' || toks[j + 1].k === 'LINE')) { j++; continue; }                                             /* "bolt holes", "bolt lines" */
      if ((a.k === 'WEB' || a.k === 'FLANGE' || a.k === 'FLANGES') && !placeAdj && j + 1 < n && (toks[j + 1].k === 'HOLE' || toks[j + 1].k === 'BOLT' || toks[j + 1].k === 'LINE')) { placeAdj = a.k; j++; continue; }   /* "two web holes" */
      break;
    }
    if (j < n && (toks[j].k === 'LINE' || toks[j].k === 'BOLT' || toks[j].k === 'HOLE')) { thing = toks[j].k; j++; }
    if (c.k === 'A' && thing !== 'LINE') return null;
    if (thing === 'LINE' && j < n && toks[j].k === 'W' && /^loads?$/.test(toks[j].w)) return null;                                                              /* a line load */
    e = j;
    if (thing === 'LINE' && j < n && toks[j].k === 'OF') {                                                                                                     /* "... lines of [three] [7/8-in] bolts" */
      k1 = j + 1;
      if (k1 < n && toks[k1].k === 'CNT') { inner = toks[k1]; k1++; }
      for (;;) {
        if (k1 < n && toks[k1].k === 'SIZE' && !size) { size = toks[k1]; k1++; continue; }
        if (k1 < n && toks[k1].k === 'ADJ') { k1++; continue; }
        if (k1 + 1 < n && toks[k1].k === 'BOLT' && toks[k1 + 1].k === 'HOLE') { k1++; continue; }
        break;
      }
      if (k1 < n && (toks[k1].k === 'BOLT' || toks[k1].k === 'HOLE')) e = k1 + 1; else { inner = null; if (size && size.s > toks[j].s) size = null; }
    } else if (thing === 'HOLE' && j < n && toks[j].k === 'FOR') {                                                                                             /* "two holes for 3/4-in bolts" */
      k1 = j + 1; if (k1 < n && (toks[k1].k === 'A' || toks[k1].k === 'CNT')) k1++;
      if (k1 < n && toks[k1].k === 'SIZE') { hold = toks[k1]; k1++; while (k1 < n && toks[k1].k === 'ADJ') k1++; if (k1 < n && toks[k1].k === 'BOLT') { if (!size) size = hold; e = k1 + 1; } }
    }
    k1 = e;
    while (k1 < n && skipped < 3 && (toks[k1].k === 'VERB' || toks[k1].k === 'ADJ')) { k1++; skipped++; }
    if (k1 < n && (toks[k1].k === 'PREP' || toks[k1].k === 'PER' || toks[k1].k === 'TO')) s1 = scopeAt(k1);
    if (!s1 && e < n && toks[e].k === 'EACH') { s1 = scopeAt(e); if (!s1) { post = true; e++; } }                                                              /* "three bolts each" */
    if (s1 && s1.foreign) return { foreign: true, endTok: s1.end };
    if (thing === null) {                                                                                                                                      /* "two per line", "2 in each flange", "one in the web" */
      if (c.k !== 'CNT' || !s1 || k1 !== e || !(s1.scope === 'PERLINE' || s1.scope === 'EACHFLANGE' || s1.scope === 'WEB')) return null;
    }
    return { c: c.k === 'A' ? 1 : c.v, thing: thing, inner: inner ? inner.v : null, size: size, adj: adj, post: post, clause: clause, oneLine: !!(s1 && s1.oneLine),
      scope: s1 ? s1.scope : (placeAdj === 'WEB' ? 'WEB' : (placeAdj ? 'FLANGES' : null)), s: c.s, e: toks[(s1 ? s1.end : e) - 1].e, endTok: s1 ? s1.end : e };
  }
  while (i < n) {
    tk = toks[i];
    if (tk.k === 'STOP') { pend = null; neg = false; clause++; i++; continue; }
    if (tk.k === 'COMMA' || tk.k === 'AND') { neg = false; i++; continue; }
    if (tk.k === 'NO') { neg = true; i++; continue; }
    /* a size that stands right beside the word bolt / hole: "7/8-in bolts", "bolts (7/8 in)", "bolts of 3/4 in. diameter" */
    if (tk.k === 'SIZE') {
      k = i + 1; while (k < n && (toks[k].k === 'ADJ' || (toks[k].k === 'PUNC' && toks[k].raw === ')'))) k++;
      if (k < n && (toks[k].k === 'BOLT' || toks[k].k === 'HOLE')) sizes.push({ size: tk, noun: toks[k].k === 'HOLE' || (k + 1 < n && toks[k + 1].k === 'HOLE') ? 'hole' : 'bolt', s: tk.s, e: toks[k].e });
      else {
        k = i - 1; while (k >= 0 && (toks[k].k === 'ADJ' || toks[k].k === 'OF' || toks[k].k === 'VERB' || (toks[k].k === 'PUNC' && (toks[k].raw === '(' || toks[k].raw === ':')))) k--;
        if (k >= 0 && (toks[k].k === 'BOLT' || toks[k].k === 'HOLE') && toks[k].e + 12 >= tk.s) sizes.push({ size: tk, noun: toks[k].k === 'HOLE' ? 'hole' : 'bolt', s: toks[k].s, e: tk.e });
        else if (i + 1 < n && toks[i + 1].k === 'ADJ' && /^dia/.test(toks[i + 1].w) && boltInClause(i) && (k < 0 || toks[k].k === 'COMMA' || toks[k].k === 'STOP')) sizes.push({ size: tk, noun: 'bolt', s: tk.s, e: toks[i + 1].e, loose: true });   /* "two bolts in each flange, all 7/8 inch diameter" (after a comma only: "the figure labels a 7/8-in diameter" is not the question's own statement) */
      }
    }
    it = (tk.k === 'CNT' || (tk.k === 'A' && i + 1 < n && (toks[i + 1].k === 'LINE' || (toks[i + 1].k === 'ADJ' && i + 2 < n && toks[i + 2].k === 'LINE')))) ? itemAt(i) : null;
    if (it) {
      if (!it.foreign && !neg) {
        if (!it.scope && pend && (it.thing === 'LINE' || it.thing === null || pend.via === 'verb' || pend.scope === 'EACHFLANGE') && !(pend.scope === 'PERLINE' && it.thing === 'LINE')) { it.scope = pend.scope; it.s = Math.min(it.s, pend.s); }
        if (it.size && (it.thing === 'BOLT' || it.thing === 'HOLE' || it.thing === 'LINE' || it.thing === null)) sizes.push({ size: it.size, noun: it.thing === 'HOLE' ? 'hole' : 'bolt', s: it.s, e: it.e });
        items.push(it);
      }
      i = it.endTok; continue;
    }
    /* the count LAST, as on a data sheet: "lines per flange: two", "bolts per line = 3" */
    if ((tk.k === 'LINE' || tk.k === 'BOLT' || tk.k === 'HOLE') && i + 1 < n && toks[i + 1].k === 'PER' && !neg) {
      sc = scopeAt(i + 1);
      if (sc && !sc.foreign && sc.end + 1 < n && ((toks[sc.end].k === 'PUNC' && toks[sc.end].raw === ':') || toks[sc.end].k === 'EQ' || toks[sc.end].k === 'VERB') && toks[sc.end + 1].k === 'CNT') {
        items.push({ c: toks[sc.end + 1].v, thing: tk.k, inner: null, size: null, adj: {}, post: false, clause: clause, scope: sc.scope, s: tk.s, e: toks[sc.end + 1].e, endTok: sc.end + 2 });
        i = sc.end + 2; continue;
      }
    }
    /* a place phrase that stands by itself: it is the place of the items that follow in this clause, and of the item just before it when that one has none */
    if ((tk.k === 'PREP' || tk.k === 'PER' || tk.k === 'EACH' || tk.k === 'BOTH' || tk.k === 'DET') && !(i > 0 && toks[i - 1].k === 'OF')) {
      sc = scopeAt(i);
      if (sc && sc.foreign) { i = sc.end; continue; }
      if (sc && (sc.prep || sc.quant || verbAfter(sc.end))) {
        if (!neg) {
          via = verbAfter(sc.end) ? 'verb' : (sc.prep ? 'prep' : 'each');
          if (via !== 'verb') {
            for (k = items.length - 1; k >= 0 && items[k].clause === clause; k--) {
              if (!items[k].scope && !(sc.scope === 'PERLINE' && items[k].thing === 'LINE')) { items[k].scope = sc.scope; items[k].e = Math.max(items[k].e, toks[sc.end - 1].e); break; }
            }
          }
          pend = { scope: sc.scope, via: via, s: tk.s };
        }
        i = sc.end; continue;
      }
    }
    i++;
  }
  return { items: items, sizes: sizes };
}
function cgApply(t, H) {
  var P, g = {}, i, it, oldPf, newPf, oldAc, x;
  H.conflicts = [];
  if (!/\b(?:bolts?|holes?|fasteners?|rivets?)\b/i.test(t)) return;
  try { P = cgItems(t); } catch (e) { return; }
  function put(slot, v, it0, extra) {
    var o = { value: v, from: t.slice(it0.s, it0.e).replace(/\s+/g, ' '), viaGrammar: true }, k0;
    if (extra) for (k0 in extra) if (extra.hasOwnProperty(k0)) o[k0] = extra[k0];
    if (g[slot]) { if (g[slot].value !== v) g[slot].clash = true; return; }             /* two different counts for one thing: neither is used */
    g[slot] = o;
  }
  /* "two rows with three 7/8-in bolts on each flange", "2 rows x 3 bolts per flange": with a count of LINES in the same clause, a count of BOLTS said for
     the flange is the bolts of a line or of the whole flange, not the holes across it.  The lines take the place; the bolt count fills nothing. */
  for (i = 0; i < P.items.length; i++) {
    it = P.items[i];
    if ((it.thing === 'BOLT' || it.thing === 'HOLE') && (it.scope === 'EACHFLANGE' || it.scope === 'ONEFLANGE' || it.scope === 'WEB')) {
      for (x = 0; x < P.items.length; x++) {
        if (x !== i && P.items[x].clause === it.clause && P.items[x].thing === 'LINE' && (!P.items[x].scope || P.items[x].scope === it.scope) && P.items[x].c !== it.c) {
          if (!P.items[x].scope) { P.items[x].scope = it.scope; P.items[x].e = Math.max(P.items[x].e, it.e); P.items[x].s = Math.min(P.items[x].s, it.s); }
          it.dropped = true;
        }
      }
    }
  }
  for (i = 0; i < P.items.length; i++) {
    it = P.items[i];
    if (it.dropped) continue;
    if (it.adj.staggered) continue;                                                     /* a staggered pattern is asked for hole by hole, never counted here */
    if (it.inner !== null) put('perLine', it.inner, it);
    if (it.post && !it.scope) {                                                         /* "three bolts each": each LINE, when a count of lines stands before it in the clause */
      for (x = i - 1; x >= 0 && P.items[x].clause === it.clause; x--) if (P.items[x].thing === 'LINE') { it.scope = 'PERLINE'; break; }
      if (!it.scope) continue;
    }
    if (it.scope === 'PERLINE') { if (it.thing !== 'LINE') { put('perLine', it.c, it); if (it.oneLine) put('lines', 1, it, { only: false }); } }   /* "four bolts in a single line": four per line, and ONE line */
    else if (it.scope === 'EACHFLANGE' || it.scope === 'ONEFLANGE') put('perFlange', it.c, it, { lines: it.thing === 'LINE' });
    else if (it.scope === 'FLANGES') put('cutFlange', it.c, it, { plural: true, lines: it.thing === 'LINE' });
    else if (it.scope === 'WEB') put('web', it.c, it, { lines: it.thing === 'LINE' });
    else if (it.scope === 'LEG') { if (it.thing === 'HOLE') put('inSection', it.c, it); else if (it.thing === 'LINE') put('lines', it.c, it, { only: it.inner === null }); }
    else if (it.scope === 'SECTION') { if (it.thing === 'LINE') put('lines', it.c, it, { only: it.inner === null }); else put('inSection', it.c, it); }
    else if (it.thing === 'LINE') put('lines', it.c, it, { only: it.inner === null });
    else if (it.adj.transverse) put('inSection', it.c, it);
  }
  function differ(slot, a, b, fromB) { H.conflicts.push({ slot: slot, old: a.value, oldFrom: a.from, neu: b, from: fromB }); }
  /* the flanges: "in each flange" (a count per flange) and "in the flanges" (a total, halved) are one question */
  oldPf = H.perFlange ? H.perFlange.value : (H.cutFlange ? (H.cutFlange.plural ? H.cutFlange.value / 2 : H.cutFlange.value) : null);
  x = (g.perFlange && !g.perFlange.clash) ? g.perFlange : ((g.cutFlange && !g.cutFlange.clash) ? g.cutFlange : null);
  newPf = x ? (x === g.cutFlange ? x.value / 2 : x.value) : null;
  if (oldPf !== null) { if (newPf !== null && newPf !== oldPf) differ('perFlange', { value: oldPf, from: (H.perFlange || H.cutFlange).from }, newPf, x.from); }   /* (the number the box holds: per flange) */
  else if (x && !H.inSection) { if (x === g.cutFlange) H.cutFlange = x; else H.perFlange = x; }
  if (g.web && !g.web.clash) { if (H.web) { if (H.web.value !== g.web.value) differ('web', H.web, g.web.value, g.web.from); } else if (!H.inSection && !H.noWeb) H.web = g.web; }
  if (g.perLine && !g.perLine.clash) { if (H.perLine) { if (H.perLine.value !== g.perLine.value) differ('perLine', H.perLine, g.perLine.value, g.perLine.from); } else H.perLine = g.perLine; }
  /* a plate or an angle: holes across the section */
  oldAc = H.across || H.inSection || H.oneHole || H.forBolt || H.lines || null;
  if (g.inSection && !g.inSection.clash) { if (oldAc) { if (oldAc.value !== g.inSection.value) differ('across', oldAc, g.inSection.value, g.inSection.from); } else H.inSection = g.inSection; }
  if (g.lines && !g.lines.clash) { if (H.lines) { if (H.lines.value !== g.lines.value) differ('lines', H.lines, g.lines.value, g.lines.from); } else H.lines = g.lines; }
  /* (10/07, from the student's own typing of her homework 3-23: "bolted through both flanges. one each side of the web.")  A line of bolts on EACH SIDE
     of the web is two holes across each flange: that is where a flange's bolts stand.  Only when the text speaks of the flanges and no count per flange
     (and no count across a plate) was read. */
  if (!H.perFlange && !H.cutFlange && !H.inSection && /\bflanges?\b/i.test(t)) {
    x = /\b(one|two|a|1|2)\s+(?:(?:line|row|bolt|hole)s?\s+)?(?:of\s+(?:bolts?|holes?)\s+)?(?:on\s+|at\s+|to\s+|in\s+)?(?:each|either|both|every)\s+sides?\s+of\s+(?:the\s+|its\s+)?(?:web|stem)\b/i.exec(t);
    if (x) H.perFlange = { value: (/^(?:two|2)$/i.test(x[1]) ? 2 : 1) * 2, from: x[0], viaGrammar: true };
  }
  /* the bolt size the grammar met beside the word bolt or hole (used only when the older rules found none) */
  for (i = 0; i < P.sizes.length; i++) {
    x = P.sizes[i];
    if (x.size.v >= 0.25 && x.size.v <= 1.5 && (x.size.unit || !x.loose)) { H.gBolt = { value: x.size.val, from: t.slice(x.s, x.e).replace(/\s+/g, ' '), kind: x.noun === 'hole' ? 'hole' : 'bolt' }; break; }
  }
}

/* (10/07, red team A1-tcap-01..08) the first "no bolt holes" / "no holes" that says the WHOLE member has none, or null.  One that names where there are
   none is not that: "no bolt holes in the web", "no holes in its flanges", "no bolt holes in web", "the short leg has no bolt holes", "no bolt holes
   elsewhere" (each of these was read as a welded member, and only yielding was worked out).  One word may stand before the part ("in teh web"). */
var NOHOLE_PART = '(?:web|stem|flanges?|(?:(?:short|long|outstanding|other|connected|unconnected|attached|vertical|horizontal)\\s+)?legs?)';
function noHolesWord(t, re) {
  var m, after, before;
  re = re || /no\s+bolt\s+holes|no\s+holes\b/gi;
  re.lastIndex = 0;
  while ((m = re.exec(t)) !== null) {
    after = t.slice(m.index + m[0].length, m.index + m[0].length + 60);
    before = t.slice(Math.max(0, m.index - 40), m.index);
    if (new RegExp('^\\s*(?:are\\s+|is\\s+)?(?:(?:drilled|punched|located|placed|made|cut)\\s+)?(?:in|through|thru|on|at|along|across)\\s+(?:\\S+\\s+)?' + NOHOLE_PART + '\\b', 'i').test(after)) continue;
    if (/^\s*(?:anywhere\s+)?else(?:where)?\b/i.test(after)) continue;
    if (new RegExp('\\b' + NOHOLE_PART + '\\s+(?:has|have|contains?|carries|carry|with)\\s+$', 'i').test(before)) continue;
    return m;
  }
  return null;
}

function findHoles(t) {
  var H = { perFlange: null, web: null, perLine: null, lines: null, angle: null, noFlange: false, noWeb: false, locFlange: null, locWeb: null, locLeg: null, oneHole: null, weldedWord: null };
  var m, re;
  /* 0.8: the M of "N lines of M bolts" is the number of bolts in a line, never a count of holes across (see the count grammar); and a number glued to a
     letter is a name, not a count ("two lines of 7/8 in. diameter A325 bolts in each flange" was read as 325 holes in each flange) */
  function innerOfLines(mm) { return /\b(?:lines?|rows?)\s+(?:of|with|having|x)\s+$/i.test(t.slice(Math.max(0, mm.index - 16), mm.index)) || (mm.index > 0 && /[A-Za-z0-9\/.]/.test(t.charAt(mm.index - 1))); }
  var DIA = '(?:' + N + '\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*-?\\s*(?:diameter\\s+|dia\\.?\\s+)?)?';
  re = new RegExp('(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?(?:holes?|bolts?)\\s+(?:in|across|through)\\s+(?:each|every|both)\\s+flanges?', 'i');
  if ((m = re.exec(t)) && !innerOfLines(m)) H.perFlange = { value: wnum(m[1]), from: m[0] };
  /* 0.6 (the second fresh exam of 10/06, another model family again): the hole named BY ITS BOLT: "has one hole for a 3/4-inch-diameter bolt in each
     flange", "One hole for a 3/4-inch-diameter bolt is drilled in each flange", "two holes for 1-inch-diameter bolts", "with one hole for a 5/8-inch-diameter
     bolt".  Seven of its ten stops were this wording.  In each flange: the count per flange.  With no place said: the count of a plate or an angle (a
     rolled shape still asks where the holes are). */
  var FORB = '\\s+for\\s+(?:an?\\s+|' + WN + '\\s+)?' + N + '\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*-?\\s*(?:diameter\\s+|dia\\.?\\s+)?bolts?';
  re = new RegExp('\\b(' + WN + ')\\s+(?:bolt\\s+)?holes?' + FORB + '\\s+(?:(?:is|are)\\s+)?(?:(?:drilled|punched|located|placed|made|cut)\\s+)?(?:in|through|across)\\s+(?:each|every)\\s+flange\\b', 'i');
  if (!H.perFlange && (m = re.exec(t))) H.perFlange = { value: wnum(m[1]), from: m[0] };
  re = new RegExp('\\b(' + WN + ')\\s+(?:bolt\\s+)?holes?' + FORB + '(?!\\s+(?:(?:is|are)\\s+)?(?:(?:drilled|punched|located|placed|made|cut)\\s+)?(?:in|through|across)\\s+(?:each|every|both|the|its)\\s+(?:flanges?|web|stem))', 'i');
  if ((m = re.exec(t))) H.forBolt = { value: wnum(m[1]), from: m[0] };
  /* 0.5: the part named first: "connected through its WEB by two lines of 7/8-in diameter bolts" (a channel), "through its FLANGE by two lines of ... bolts" (a tee) */
  re = new RegExp('\\bthrough\\s+(?:its|the)\\s+web\\s+(?:only\\s+)?(?:by|with)\\s+(' + WN + '|a\\s+single|a)\\s+lines?\\s+of\\s+(?:\\S+\\s+){0,5}?(?:bolts?|holes?)', 'i');
  if (!H.web && (m = re.exec(t))) H.web = { value: wnum(m[1].replace(/^a\s+single$/i, 'single')), from: m[0], lines: true };
  re = new RegExp('\\bthrough\\s+(?:its|the)\\s+flange\\s+(?:only\\s+)?(?:by|with)\\s+(' + WN + '|a\\s+single|a)\\s+lines?\\s+of\\s+(?:\\S+\\s+){0,5}?(?:bolts?|holes?)', 'i');
  if (!H.perFlange && (m = re.exec(t))) H.perFlange = { value: wnum(m[1].replace(/^a\s+single$/i, 'single')), from: m[0], lines: true };
  /* 0.6: BOTH flanges named together: "connected at its ends through its flanges using four lines of 7/8 inch diameter bolts" (real May 2024 final, Q8).
     The lines are shared by the two flanges, so each flange has half of them (the same rule as "cuts four holes in the flanges" below). */
  re = new RegExp('\\bthrough\\s+(?:its|the|both)\\s+(?:two\\s+)?flanges\\s+(?:only\\s+)?(?:using|by|with)\\s+(' + WN + ')\\s+(?:lines?|rows?)\\s+of\\s+(?:\\S+\\s+){0,5}?(?:bolts?|holes?)', 'i');
  if (!H.perFlange && (m = re.exec(t))) H.cutFlange = { value: wnum(m[1]), from: m[0], plural: true, lines: true };
  /* (10/07, A1-tcap-09/10/11) the words skipped between "N lines of" and the place never cross a "no" (also glued: "bolts,no"): "four lines of 3/4in
     bolts, no holes in the web" put the four lines IN the web (603.5 printed where 596.2 is right).  (Not a comma: "two lines of 3/4-in;: bolts in each
     flange" must still be read, or the halving rule of "through the flanges with two lines" takes its place.) */
  var SK = '(?:(?!\\S*\\b(?:no|not|none|without)\\b)\\S+\\s+){0,5}?';
  re = new RegExp('\\b(' + WN + ')\\s+(?:lines?|rows?)\\s+of\\s+' + SK + '(?:bolts?|holes?)\\s+(?:in|through|across)\\s+(?:its|the|both)\\s+(?:two\\s+)?flanges\\b', 'i');
  if (!H.perFlange && !H.cutFlange && (m = re.exec(t))) H.cutFlange = { value: wnum(m[1]), from: m[0], plural: true, lines: true };
  /* 0.6 (review 2): "Each flange has 2 holes and the web has 2 holes"; "2 per flange, 2 in the web"; "2 in each flange and 2 in the web" */
  re = new RegExp('\\bweb\\s+has\\s+(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?holes?\\b', 'i');
  if (!H.web && (m = re.exec(t))) H.web = { value: wnum(m[1]), from: m[0] };
  /* the number must stand alone: not the tail of a size ("7/8 in each flange" is a bolt, not eight holes) */
  re = new RegExp('(?:^|[^/\\d.\\w-])(' + WN + ')\\s+(?:per|in\\s+each|in\\s+every)\\s+flange\\b', 'i');
  if (!H.perFlange && /\b(?:holes?|bolts?)\b/i.test(t) && (m = re.exec(t))) H.perFlange = { value: wnum(m[1]), from: m[0].replace(/^[^A-Za-z0-9]+/, '') };
  /* 0.5: "two holes cut by the critical section", "two holes in any cross-section": which part they are in comes from "through the WEB only" / the member */
  re = new RegExp('\\b(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?holes?\\s+(?:are\\s+)?(?:cut\\s+by|in|at|across|on|along)\\s+(?:the|any|each|every|a|its)\\s+(?:critical\\s+|net\\s+)?(?:cross[- ]?)?section\\b', 'i');
  if ((m = re.exec(t))) H.inSection = { value: wnum(m[1]), from: m[0] };
  /* 0.6 (the fresh exam of 10/06, written by another model family in plain exam wording): the same thing said the other way round, and the flange holes
     counted together: "The critical section crosses one bolt hole", "the critical section passes through four flange holes in total", "has four flange
     holes on its critical section".  All of these stopped the page. */
  re = new RegExp('\\bcritical\\s+(?:cross[- ]?)?section\\s+(?:passes\\s+through|crosses|cuts(?:\\s+through)?|intersects|includes|contains|has)\\s+(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?holes?\\b', 'i');
  if (!H.inSection && (m = re.exec(t))) H.inSection = { value: wnum(m[1]), from: m[0] };
  re = new RegExp('\\b(' + WN + ')\\s+(?:bolt\\s+)?flange\\s+(?:bolt\\s+)?holes?\\b', 'i');
  if (!H.perFlange && !H.cutFlange && (m = re.exec(t))) H.cutFlange = { value: wnum(m[1]), from: m[0], plural: true };
  /* 0.5: "3 bolts at 4 in on centre" (the bolts of one line, given with their spacing) */
  re = new RegExp('\\b(' + WN + ')\\s+(?:bolts?|fasteners?)\\s+(?:spaced\\s+)?at\\s+' + N + '\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s+(?:on\\s+cent(?:er|re)s?|o\\.?c\\.?)', 'i');
  if (!H.perLine && (m = re.exec(t))) H.perLine = { value: wnum(m[1]), from: m[0] };
  /* 0.5: "2 web holes", "4 holes in its web" said the short way */
  re = new RegExp('\\b(' + WN + ')\\s+(?:bolt\\s+)?web\\s+(?:bolt\\s+)?holes?\\b', 'i');
  if (!H.web && (m = re.exec(t))) H.web = { value: wnum(m[1]), from: m[0] };
  /* 0.5: "2 holes per flange" */
  re = new RegExp('(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?(?:holes?|bolts?)\\s+per\\s+flange\\b', 'i');
  if (!H.perFlange && (m = re.exec(t)) && !innerOfLines(m)) H.perFlange = { value: wnum(m[1]), from: m[0] };
  re = new RegExp('(' + WN + ')\\s+lines?\\s+of\\s+' + SK + '(?:bolts?|holes?)(?:\\s+for\\s+\\S+\\s+bolts?)?\\s+(?:in|across|through)\\s+(?:each|every)\\s+flange', 'i');
  if (!H.perFlange && (m = re.exec(t))) H.perFlange = { value: wnum(m[1]), from: m[0], lines: true };
  /* 0.5: the flange named first: "Each flange has two lines of 7/8-in diameter bolts", "each flange is bolted with two rows of bolts" */
  re = new RegExp('\\b(?:each|every)\\s+flange\\s+(?:has|have|contains?|carries|is\\s+(?:bolted|connected|attached|fastened)\\s+(?:with|by|through))\\s+(' + WN + ')\\s+(?:lines?|rows?)\\s+of\\s+(?:\\S+\\s+){0,5}?(?:bolts?|holes?)', 'i');
  if (!H.perFlange && (m = re.exec(t))) H.perFlange = { value: wnum(m[1]), from: m[0], lines: true };
  re = new RegExp('\\b(?:each|every)\\s+flange\\s+(?:has|have|contains?)\\s+(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?(?:holes?|bolts?)\\b(?!\\s+(?:in|per)\\s+(?:each|a|every)\\s+(?:line|row))', 'i');
  if (!H.perFlange && (m = re.exec(t))) H.perFlange = { value: wnum(m[1]), from: m[0] };
  re = new RegExp('(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?(?:holes?|bolts?)\\s+(?:in|across|through)\\s+(?:its|the|their)\\s+web', 'i');
  if ((m = re.exec(t)) && !innerOfLines(m)) H.web = { value: wnum(m[1]), from: m[0] };
  re = new RegExp('(' + WN + ')\\s+lines?\\s+of\\s+' + SK + '(?:bolts?|holes?)\\s+(?:in|across|through)\\s+the\\s+web', 'i');
  if (!H.web && (m = re.exec(t))) H.web = { value: wnum(m[1]), from: m[0], lines: true };
  re = new RegExp('cuts?\\s+(' + WN + ')\\s+holes?\\s*,?\\s*(?:all|both)?\\s*in\\s+the\\s+(flanges?|web)', 'i');
  if ((m = re.exec(t))) {
    if (/^web/i.test(m[2])) { if (!H.web) H.web = { value: wnum(m[1]), from: m[0], viaCut: true }; }
    else H.cutFlange = { value: wnum(m[1]), from: m[0], plural: /flanges/i.test(m[2]) };
  }
  /* 0.5: "4 bolts per line", "three bolts per line", "4 bolts in the line", "3 bolts in a row" as well as "in each line" */
  re = new RegExp('(?:at\\s+least\\s+)?(' + WN + ')\\s+(?:bolts?|holes?|fasteners?)\\s+(?:in\\s+(?:each|every|a|the|one)|per|a|each)\\s+(?:longitudinal\\s+|bolt\\s+|gage\\s+)?(?:line|row)\\b', 'i');
  if ((m = re.exec(t))) H.perLine = { value: wnum(m[1]), from: m[0] };
  /* 0.5: "... holes in each flange and three in the web" (the web count follows the flange count without repeating the word "holes") */
  re = new RegExp('flanges?\\s*(?:,|and|plus|,\\s*and)\\s+(' + WN + ')\\s+(?:more\\s+)?(?:(?:bolts?|holes?)\\s+)?(?:in|through|across)\\s+(?:the|its)\\s+web\\b', 'i');
  if (!H.web && (m = re.exec(t))) H.web = { value: wnum(m[1]), from: m[0] };
  /* 0.6 (regression of review 2): "Two lines of holes in each flange and ONE LINE IN THE WEB" (her HW 4-6): a cross-section cuts one hole in each line.
     The web's line was dropped: An = 4.41 was printed where her key has 4.15, and U came from the flanges-only case where every part is connected (U = 1.0). */
  re = new RegExp('\\b(' + WN + '|a\\s+single|single)\\s+(?:lines?|rows?)\\s+(?:in|through|across|along)\\s+(?:the|its)\\s+web\\b', 'i');
  if (!H.web && (m = re.exec(t))) H.web = { value: wnum(m[1].replace(/^a\s+single$/i, 'single')), from: m[0], lines: true };
  /* 0.5: a tee has ONE flange: "two lines of 3/4-in bolts in the flange", "two holes across the flange" */
  re = new RegExp('(' + WN + ')\\s+lines?\\s+of\\s+' + SK + '(?:bolts?|holes?)\\s+(?:in|across|through)\\s+(?:the|its)\\s+flange\\b(?!s)', 'i');
  if (!H.perFlange && (m = re.exec(t))) H.perFlange = { value: wnum(m[1]), from: m[0], lines: true };
  re = new RegExp('(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?(?:holes?|bolts?)\\s+across\\s+(?:the|its|each)\\s+flange\\b', 'i');
  if (!H.perFlange && (m = re.exec(t)) && !innerOfLines(m)) H.perFlange = { value: wnum(m[1]), from: m[0] };
  re = new RegExp('(?:single|one|a)\\s+line\\s+of\\s+(' + WN + ')\\s+(?:bolts?|holes?|fasteners?)', 'i');
  if (!H.perLine && (m = re.exec(t))) { H.perLine = { value: wnum(m[1]), from: m[0] }; H.lines = { value: 1, from: m[0] }; }
  re = new RegExp('(' + WN + ')\\s+lines?\\s+of\\s+(' + WN + ')\\s+(?:bolts?|holes?|fasteners?)', 'i');
  if ((m = re.exec(t))) { if (!H.perLine) H.perLine = { value: wnum(m[2]), from: m[0] }; H.lines = { value: wnum(m[1]), from: m[0] }; }
  /* 0.5: the number of LINES when the bolts in a line are not counted in the same breath: "one line of 3/4-in diameter bolts", "two lines of bolts" */
  re = new RegExp('\\b(' + WN + '|single|a)\\s+(?:gage\\s+)?(?:lines?|rows?)\\s+of\\s+' + DIA + '(?:(?:high[- ]strength|standard|A325|A490)\\s+)*(?:bolts?|holes?|fasteners?)\\b', 'i');
  if (!H.lines && (m = re.exec(t))) H.lines = { value: wnum(m[1]), from: m[0], only: true };
  re = /(?:the|a|one|single)\s+(?:bolt\s+)?hole\s+is\s+in/i;
  if ((m = re.exec(t))) H.oneHole = { value: 1, from: m[0] };
  /* 0.6 (review 3): "two 3/4 in. bolt holes across its width", and a hole in an angle's leg: "one 3/4 in. diameter bolt hole in the connected leg" */
  re = new RegExp('(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?(?:bolts?|holes?)\\s+across\\s+(?:the\\s+|its\\s+)?(?:width|plate|section|member|angle)', 'i');
  if ((m = re.exec(t))) H.across = { value: wnum(m[1]), from: m[0] };
  /* (10/07, A1-tcap-07 / n08) "PL 1/2 x 8 ... with 2 holes across for 3/4in bolts": across with nothing after it but the bolt (or the end of the clause).
     Read before, it was the welded reading of "no bolt holes elsewhere" that answered it.  Not when the question names one limit state ("find design
     rupture strength", k05..k07): the page still prints the governing one for those (the prose-asks fix), so they stay stopped as before */
  re = new RegExp('\\b(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?holes?\\s+across(?=\\s+for\\s|\\s*[,.;)]|\\s*$)', 'i');
  if (!H.across && !/ruptur|fractur|yield|(?:net|gross)[\s-]+(?:section|area)/i.test(t) && (m = re.exec(t)) && !innerOfLines(m)) H.across = { value: wnum(m[1]), from: m[0] };
  re = new RegExp('\\b(' + WN + ')\\s+' + DIA + '(?:bolt\\s+)?holes?\\s+in\\s+(?:the|its|one|each)\\s+(?:connected\\s+|attached\\s+|bolted\\s+|long\\s+|short\\s+|outstanding\\s+|\\d+(?:\\s*-\\s*\\d\\/\\d)?\\s*-?\\s*in\\.?\\s+)?leg\\b', 'i');
  if (!H.across && (m = re.exec(t))) H.across = { value: wnum(m[1]), from: m[0] };
  /* 0.6: the question SAYS there are none there, in more wordings: "(there are no bolts in the web)", "No holes in the web", "no web holes", "the web is not bolted" */
  /* (10/07, A1-tcap-03: "there are no bolt holes in web", typed without "the") */
  re = /the\s+flanges?\s+(?:have|has|contains?)\s+no\s+(?:bolt\s+)?(?:holes?|bolts?)|\bno\s+(?:bolt\s+)?(?:holes?|bolts?)\s+(?:are\s+|is\s+)?(?:in|through|on|at)\s+(?:(?:the|its|either|each|any)\s+)?flanges?\b|\bno\s+flange\s+(?:bolt\s+)?(?:holes?|bolts?)\b|\bflanges?\s+(?:is|are)\s+not\s+(?:bolted|connected|drilled|punched)\b/i;
  if ((m = re.exec(t))) { H.noFlange = true; H.noFlangeFrom = m[0]; }
  re = /the\s+(?:web|stem)\s+(?:have|has|contains?)\s+no\s+(?:bolt\s+)?(?:holes?|bolts?)|\bno\s+(?:bolt\s+)?(?:holes?|bolts?)\s+(?:are\s+|is\s+)?(?:in|through|on|at)\s+(?:(?:the|its)\s+)?(?:web|stem)\b|\bno\s+(?:web|stem)\s+(?:bolt\s+)?(?:holes?|bolts?)\b|\b(?:web|stem)\s+is\s+not\s+(?:bolted|connected|drilled|punched)\b/i;
  if ((m = re.exec(t))) { H.noWeb = true; H.noWebFrom = m[0]; }
  /* 0.8: "one hole in each flange and none in the web", "two lines in the web, none in the flanges" */
  if (!H.noWeb && (m = /\bnone\s+(?:in|through|on|at)\s+(?:the|its)\s+(?:web|stem)\b/i.exec(t)) && /\b(?:holes?|bolts?)\b/i.test(t)) { H.noWeb = true; H.noWebFrom = m[0]; }
  if (!H.noFlange && (m = /\bnone\s+(?:in|through|on|at)\s+(?:the|its|either|each)\s+flanges?\b/i.exec(t)) && /\b(?:holes?|bolts?)\b/i.test(t)) { H.noFlange = true; H.noFlangeFrom = m[0]; }
  // where are the holes / bolts
  re = /(?:bolts?|holes?|bolted|connect(?:ed|ion))[^.;]{0,70}?(?:through|in|to)\s+(?:its\s+|the\s+|each\s+|both\s+)?(flanges?|web|stem|one\s+leg|(?:the\s+)?(?:short|long|\d+-in)\s+leg)\b/gi;
  while ((m = re.exec(t)) !== null) {
    if (/flange/i.test(m[1]) && !H.locFlange) H.locFlange = m[0];
    else if (/web|stem/i.test(m[1]) && !H.locWeb) H.locWeb = m[0];
    else if (/leg/i.test(m[1]) && !H.locLeg) H.locLeg = m[0];
  }
  re = /through\s+(?:its\s+|the\s+|each\s+)?(flanges?|web)\s+only/i;
  if ((m = re.exec(t))) { if (/flange/i.test(m[1])) H.onlyFlange = m[0]; else H.onlyWeb = m[0]; }
  re = /\bone\s+leg\b|through\s+(?:its|the)\s+(?:short|long|\d+-in)\s+leg/i;
  if ((m = re.exec(t))) H.locLeg = H.locLeg || m[0];
  re = /staggered|stagger|gage|\bpitch\b|\bs\s*=\s*\d|\bg\s*=\s*\d/i;
  if ((m = re.exec(t))) H.stagger = m[0];
  /* (0.6, review 4: "connected with welds", "attached by fillet welds", "a welded connection" are the same thing: the page asked for holes) */
  re = /all\s+connections\s+are\s+welded|\bwelded\b(?!\s+to\s+(?:each|the\s+flange))|\b(?:connected|attached|joined|fastened)\s+(?:\w+\s+){0,4}?(?:with|by|using)\s+(?:\w+\s+){0,2}?welds?\b|\bweld(?:ed)?\s+connections?\b/i;
  m = re.exec(t);
  /* (10/07, red team A1-tcap-01..08) "no bolt holes" / "no holes" is a welded member only when it says where nowhere: "no bolt holes in the web", "the
     short leg has no bolt holes", "no bolt holes elsewhere" are members WITH holes (702 printed for a W12x53 with two lines of bolts in each flange, where
     596.2 is right).  The first of the welded words still names it, as before. */
  var nh = noHolesWord(t);
  if (nh) H.noHoles = nh[0];
  if (nh && (!m || nh.index < m.index)) m = nh;
  if (m) H.weldedWord = m[0];
  re = /gross[\s-]*(?:section\s+)?yield(?:ing)?|yielding\s+of\s+the\s+gross/i;
  if ((m = re.exec(t))) H.grossYield = m[0];
  /* 0.8: what the rules above left empty is read by the count grammar (any order of the words inside a clause) */
  cgApply(t, H);
  return H;
}

function findBolt(t) {
  var m, re, o = null;
  re = new RegExp('(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*-?\\s*(?:diameter|dia\\.?|diam\\.?)\\s+(?:high[- ]strength\\s+|structural\\s+)?(bolts?|bolt\\s+holes?|rivets?|holes?)', 'i');
  if ((m = re.exec(t))) o = { value: dimValue(m[1]), from: m[0], kind: /hole/i.test(m[2]) ? 'hole' : 'bolt' };
  if (!o) {
    re = new RegExp('(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s+(?:high[- ]strength\\s+)?bolts?\\b', 'i');
    if ((m = re.exec(t))) o = { value: dimValue(m[1]), from: m[0], kind: 'bolt' };
  }
  if (!o) {
    re = new RegExp('bolts?\\s+(?:diameter|size)\\s*(?:=|of|is|:)?\\s*(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")?', 'i');
    if ((m = re.exec(t))) o = { value: dimValue(m[1]), from: m[0], kind: 'bolt' };
  }
  if (!o) {
    re = new RegExp('(?:bolts?|holes?)\\s+(?:are|is)?\\s*\\(?(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*(?:in\\s+)?(?:diameter|dia\\.?)', 'i');
    if ((m = re.exec(t))) o = { value: dimValue(m[1]), from: m[0], kind: 'bolt' };
  }
  return o;
}

var GRADES = [
  [/\bA\s?-?\s?36\b/i, 36, 58, 'A36'], [/\bA\s?-?\s?992\b/i, 50, 65, 'A992'], [/\bA\s?-?\s?572\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?50\b/i, 50, 65, 'A572 Gr 50'],
  [/\bA\s?-?\s?572\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?42\b/i, 42, 60, 'A572 Gr 42'],
  /* 0.6 (review 4): more steels of AISC Manual Table 2-4.  Before, "A588" and "A572 Grade 65" were worked out with Fu = 65 ksi (592.8 for 638.4). */
  [/\bA\s?-?\s?572\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?55\b/i, 55, 70, 'A572 Gr 55'], [/\bA\s?-?\s?572\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?60\b/i, 60, 75, 'A572 Gr 60'],
  [/\bA\s?-?\s?572\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?65\b/i, 65, 80, 'A572 Gr 65'], [/\bA\s?-?\s?588\b/i, 50, 70, 'A588'], [/\bA\s?-?\s?242\b/i, 50, 70, 'A242'],
  [/\bA\s?-?\s?913\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?50\b/i, 50, 65, 'A913 Gr 50'], [/\bA\s?-?\s?913\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?60\b/i, 60, 75, 'A913 Gr 60'],
  [/\bA\s?-?\s?913\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?65\b/i, 65, 80, 'A913 Gr 65'], [/\bA\s?-?\s?913\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?70\b/i, 70, 90, 'A913 Gr 70'],
  [/\bA\s?-?\s?529\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?50\b/i, 50, 65, 'A529 Gr 50'], [/\bA\s?-?\s?529\s*[,\-]?\s*(?:Gr(?:ade|\.)?\s*)?55\b/i, 55, 70, 'A529 Gr 55']
];
/* first match of re in t that starts at or after ps (the part's own text); else the first match anywhere (the stem) */
function pickMatch(re, t, ps) {
  var r = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g'), m, first = null;
  while ((m = r.exec(t)) !== null) {
    if (!first) first = m;
    if (m.index >= (ps || 0)) return m;
    if (m[0].length === 0) r.lastIndex++;
  }
  return first;
}
function findGrade(t, ps) {
  var G = { Fy: null, Fu: null, grade: null }, m, i, re;
  re = /\bFy\s*=\s*(\d+(?:\.\d+)?)\s*ksi/i;
  if ((m = pickMatch(re, t, ps))) G.Fy = { value: Number(m[1]), from: m[0] };
  /* 0.6: "(Fy 36)", "Fy 50", "Fy of 36 ksi": no "=" and perhaps no unit.  Before, the page used 50 and printed Zx = 491 where 683 is right. */
  if (!G.Fy) { re = /\bFy\s*(?:of\s+|is\s+|:\s*)?(\d{2}(?:\.\d+)?)(?:\s*ksi)?(?![\d.]|\s*(?:in|ft|kips?|k\b|psf))/; if ((m = pickMatch(re, t, ps)) && Number(m[1]) >= 30 && Number(m[1]) <= 100) G.Fy = { value: Number(m[1]), from: m[0] }; }
  re = /\bFu\s*=\s*(\d+(?:\.\d+)?)\s*ksi/i;
  if ((m = pickMatch(re, t, ps))) G.Fu = { value: Number(m[1]), from: m[0] };
  for (i = 0; i < GRADES.length; i++) {
    m = pickMatch(GRADES[i][0], t, ps);
    if (m) { G.grade = { Fy: GRADES[i][1], Fu: GRADES[i][2], name: GRADES[i][3], from: m[0] }; break; }
  }
  /* 0.6 (review 2): "The yield strength of the steel is 36 ksi", "The yield point of the steel is 36 ksi", "Grade 36 steel": Fy = 50 was used (685 for 525) */
  if (!G.Fy) { re = /\byield\s+(?:strength|stress|point)\s+(?:of\s+(?:the\s+)?(?:steel|material|member|column|beam|plate|angle)\s+)?(?:is|=|of|:|equals)\s*(\d{2}(?:\.\d+)?)\s*-?\s*ksi/i; if ((m = pickMatch(re, t, ps))) G.Fy = { value: Number(m[1]), from: m[0] }; }
  if (!G.Fy && !G.grade) { re = /\bgrade\s+(36|42|46|50|55|60|65)\b(?!\s*(?:bolts?|rebar|bars?|reinforc))/i; if ((m = pickMatch(re, t, ps))) G.Fy = { value: Number(m[1]), from: m[0], loose: true }; }
  if (ps && G.Fy && G.Fy.from && t.indexOf(G.Fy.from, ps) < 0) {
    // the part itself names a different yield stress in a looser form ("Pipe 10 STD, 35 ksi")? let the loose form below override
    G.FyFromStem = true;
  }
  if (!G.Fy || G.FyFromStem) {
    re = /(?:yield\s+(?:stress|strength)\s+(?:of|is|=)\s*|\b)(\d{2})\s*-?\s*ksi\s+(?:steel|yield)|(\d{2})\s*ksi\s+steel|(?:,|\bof)\s*(\d{2})\s*ksi\b/i;
    m = ps ? pickMatch(re, t.slice(ps), 0) : re.exec(t);
    if (m && ps && G.FyFromStem) { var tmpv = Number(m[1] || m[2] || m[3]); if (tmpv >= 30 && tmpv <= 80) { G.Fy = null; } else m = null; }
    if (m) {
      var v = Number(m[1] || m[2] || m[3]);
      if (v >= 30 && v <= 80 && !/\bFu\s*=\s*$/i.test(t.slice(Math.max(0, m.index - 6), m.index))) G.Fy = { value: v, from: m[0].replace(/^[,\s]+/, ''), loose: true };
    }
  }
  return G;
}

function findLengths(t) {
  var L = { items: [], span: null, length: null, unbraced: null, kl: null, lc: null, lx: null, ly: null, spacing: null };
  var m, re, v;
  function mk(m, vIdx, uIdx, label) {
    var v = parseNum(m[vIdx]), u = canonUnit(m[uIdx]);
    if (u !== 'ft' && u !== 'in') return null;
    return { value: round6(lenToFt(v, u)), from: m[0], unit: u, raw: m[vIdx], label: label, start: m.index, end: m.index + m[0].length };
  }
  var UL = '(ft|feet|foot|in\\.?|inch(?:es)?|\'|")';
  // feet-inches: 18 ft 6 in, 18'-6", 6 ft 6 in
  re = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(?:ft\\.?|feet|foot|\')\\s*-?\\s*(\\d+(?:\\.\\d+)?(?:\\s*\\d+\\/\\d+)?)\\s*(?:in\\.?|inch(?:es)?|")', 'gi');
  var combos = [];
  while ((m = re.exec(t)) !== null) combos.push({ value: round6(Number(m[1]) + parseNum(m[2]) / 12), from: m[0], start: m.index, end: m.index + m[0].length, combo: true });
  L.combos = combos;
  // labelled symbols: L = 18 ft, Lc = 20 ft, KL = Lc = 20 ft, Lx = ..., Ly = ...
  re = new RegExp('((?:\\b(?:KL[xy]?|K[xy]L[xy]|L[xycb]?|l)\\s*=\\s*)+)(' + N + ')\\s*-?\\s*' + UL + '(?:\\s*-?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:in\\.?|inch(?:es)?|"))?', 'g');
  while ((m = re.exec(t)) !== null) {
    var labs = m[1].replace(/\s/g, '').split('=').filter(Boolean), u = canonUnit(m[3]);
    if (u !== 'ft' && u !== 'in') continue;
    var val = lenToFt(parseNum(m[2]), u);
    if (m[4] !== undefined && u === 'ft') val += parseNum(m[4]) / 12;
    var item = { value: round6(val), from: m[0], labels: labs, start: m.index, end: m.index + m[0].length, unit: u, raw: m[2] };
    L.items.push(item);
  }
  // "20 ft long", "30 ft tall"
  re = new RegExp('(' + N + ')\\s*-?\\s*(ft|feet|foot|in\\.?|inch(?:es)?|\'|")\\s*(?:-\\s*)?(?:long|high|tall|in\\s+length|in\\s+height)\\b', 'gi');
  while ((m = re.exec(t)) !== null) {
    var it = mk(m, 1, 2, 'long');
    if (!it) continue;
    if (/(?:\bPL\b|\bplates?\b|\bflanges?\b|\bweb\b|\bleg\b)[^.;]{0,40}$/i.test(t.slice(Math.max(0, m.index - 50), m.index)) && it.unit === 'in') continue;   // "a plate 10 in tall" is not the member length
    if (it.unit === 'in' && it.value < 3) continue;
    if (L.length === null) L.length = it;
  }
  // spans
  re = new RegExp('(?:\\bspans?\\b|\\bspanning\\b|span\\s+(?:length\\s+)?of|\\bspan\\s*=)\\s*(?:of\\s+|=\\s*)?(' + N + ')\\s*-?\\s*(ft|feet|foot|in\\.?|inch(?:es)?|\'|")', 'gi');
  while ((m = re.exec(t)) !== null) {
    var it2 = mk(m, 1, 2, 'span');
    if (!it2) continue;
    if (/\bslab\b[^.;]{0,25}$/i.test(t.slice(Math.max(0, m.index - 30), m.index))) { if (!L.slabSpan) L.slabSpan = it2; continue; }   // "a slab spanning 10 ft" is the beam SPACING
    if (L.span === null) L.span = it2; else if (Math.abs(L.span.value - it2.value) > 1e-9) L.spanConflict = it2;
  }
  re = new RegExp('(' + N + ')\\s*-?\\s*(ft|feet|foot|\'|in\\.?|inch(?:es)?)\\s*-?\\s*span\\b', 'gi');
  while ((m = re.exec(t)) !== null) { var it3 = mk(m, 1, 2, 'span'); if (it3 && L.span === null) L.span = it3; }
  /* 0.6 (fresh exam 10/06): the span said with "is": "The span of a simply supported beam is 28 ft", "the beam span is 30 ft", "span L = 30 ft" */
  re = new RegExp('\\bspan\\b(?:\\s+L)?(?:\\s+of\\s+(?:the|a|an|each)\\s+[^.;,=]{0,40}?)?\\s*(?:is|=|:)\\s*(' + N + ')\\s*-?\\s*(ft|feet|foot|\')', 'gi');
  while ((m = re.exec(t)) !== null) { var it3s = mk(m, 1, 2, 'span'); if (it3s && L.span === null) L.span = it3s; }
  /* 0.6 (review 4): the member's length said with a noun: "with a height of 16 ft", "of length 16 ft", "its length is 20 ft" (never an EFFECTIVE or an
     UNBRACED length: those are KL and the braced length, read elsewhere) */
  re = new RegExp('\\b(?:height|length)\\s*(?:of|is|=|:)?\\s*(' + N + ')\\s*-?\\s*(ft|feet|foot|\')(?![A-Za-z])', 'gi');
  while ((m = re.exec(t)) !== null) {
    if (/\b(?:effective|unbraced|unsupported|braced|embedment|weld|development|segment)\s+$/i.test(t.slice(Math.max(0, m.index - 14), m.index))) continue;
    var it3h = mk(m, 1, 2, 'long'); if (it3h && L.length === null) L.length = it3h;
  }
  /* 0.5: "a 28-ft simple span", "a 24 ft simply supported beam", "a 15-ft cantilever", "a 12-ft cantilever beam" */
  re = new RegExp('(' + N + ')\\s*-?\\s*(ft|feet|foot|\')\\s*-?\\s*(?:long\\s+)?(?:(?:simple|simply[- ]supported|single|clear)\\s+span|cantilever(?:ed)?(?:\\s+(?:beam|span|girder))?|(?:simple|simply[- ]supported)\\s+(?:beam|girder))\\b', 'gi');
  while ((m = re.exec(t)) !== null) { var it3b = mk(m, 1, 2, 'span'); if (it3b && L.span === null) L.span = it3b; }
  /* 0.5: the length written before the member: "a 28-ft axially loaded W10x54 column", "the 20-ft column", "a 16 ft pinned-end strut" */
  re = new RegExp('(' + N + ')\\s*-?\\s*(ft|feet|foot|\')\\s*-?\\s*(?:long\\s+|tall\\s+|high\\s+)?(?:(?!(?:above|below|from|on|of|at|to|about|between|apart|and|or|with|spacing|in|for|is|are|the)\\b)[A-Za-z0-9][A-Za-z0-9\\/-]*\\s+){0,4}?(?:columns?|strut|post|compression\\s+member|tension\\s+member|hanger)\\b', 'gi');
  while ((m = re.exec(t)) !== null) { var it3c = mk(m, 1, 2, 'long'); if (it3c && L.length === null) L.length = it3c; }
  // y = 30 ft style (figure dimensions) are NOT read as spans (they are ambiguous)
  // spacing
  re = new RegExp('(?:spaced|spacing\\s+(?:of\\s+|is\\s+)?|spacing\\s*=\\s*)\\s*(?:at\\s+)?(' + N + ')\\s*-?\\s*(ft|feet|foot|\')(?:\\s+(?:on\\s+center|o\\.?c\\.?|apart))?', 'gi');
  while ((m = re.exec(t)) !== null) { var it4 = mk(m, 1, 2, 'spacing'); if (it4 && L.spacing === null) L.spacing = it4; }
  /* 0.6 (review 4): the number BEFORE the word: "Interior beams are at 8 ft spacing" (and "The beam spacing is 8 ft", read by the line above now) */
  re = new RegExp('(' + N + ')\\s*-?\\s*(ft|feet|foot|\')\\s+(?:beam\\s+|joist\\s+|cent(?:er|re)[\\s-]to[\\s-]cent(?:er|re)\\s+)?spacing\\b', 'gi');
  while ((m = re.exec(t)) !== null) { var it4b = mk(m, 1, 2, 'spacing'); if (it4b && L.spacing === null) L.spacing = it4b; }
  re = new RegExp('(' + N + ')\\s*-?\\s*(ft|feet|foot|\')\\s+(?:on\\s+center|o\\.?c\\.?|apart)\\b', 'gi');
  while ((m = re.exec(t)) !== null) { var it5 = mk(m, 1, 2, 'spacing'); if (it5 && L.spacing === null) L.spacing = it5; }
  /* 0.5: "3 spaces of 6 ft 8 in", "4 spaces at 7 ft", "3 @ 9 ft": the spacing of the beams */
  re = new RegExp('\\b(?:' + WN + ')\\s+(?:equal\\s+)?(?:spaces?\\s+(?:of|at|@)|@)\\s*(\\d+(?:\\.\\d+)?)\\s*-?\\s*(?:ft\\.?|feet|foot|\')(?:\\s*-?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:in\\.?|inch(?:es)?|"))?', 'gi');
  while ((m = re.exec(t)) !== null) {
    if (L.spacing === null) L.spacing = { value: round6(Number(m[1]) + (m[2] !== undefined ? Number(m[2]) / 12 : 0)), from: m[0], unit: 'ft', raw: m[1], label: 'spacing', start: m.index, end: m.index + m[0].length };
  }
  // unbraced about an axis
  re = new RegExp('unbraced\\s+(?:length\\s+)?(?:of\\s+)?(' + N + ')\\s*-?\\s*(ft|feet|foot|\')\\s+(?:about|in|for)\\s+(?:the\\s+)?(weak|strong|x-x|y-y|x|y|minor|major)', 'gi');
  while ((m = re.exec(t)) !== null) { var itu = mk(m, 1, 2, 'unbraced'); if (itu) { itu.axis = /^(weak|y|minor)/i.test(m[3]) ? 'y' : 'x'; (L.axes = L.axes || []).push(itu); } }
  re = new RegExp('(?:unbraced|braced|supported)\\s+(?:for\\s+|over\\s+|about\\s+)?(?:a\\s+length\\s+of\\s+)?(' + N + ')\\s*-?\\s*(ft|feet|foot|\')\\s+(?:about|in|for|with\\s+respect\\s+to)\\s+(?:the\\s+)?(weak|strong|x-x|y-y|x|y|minor|major)', 'gi');
  while ((m = re.exec(t)) !== null) { var itv = mk(m, 1, 2, 'unbraced'); if (itv) { itv.axis = /^(weak|y|minor)/i.test(m[3]) ? 'y' : 'x'; (L.axes = L.axes || []).push(itv); } }
  re = new RegExp('(' + N + ')\\s*-?\\s*(ft|feet|foot|\')\\s+about\\s+(?:the\\s+)?(weak|strong|x-x|y-y|x|y|minor|major)(?:\\s+axis)?', 'gi');
  while ((m = re.exec(t)) !== null) {
    var itw = mk(m, 1, 2, 'unbraced');
    if (itw) { itw.axis = /^(weak|y|minor)/i.test(m[3]) ? 'y' : 'x'; L.axes = L.axes || []; var dup = false; L.axes.forEach(function (a) { if (Math.abs(a.start - itw.start) < 12) dup = true; }); if (!dup) L.axes.push(itw); }
  }
  return L;
}

/* ---------------------------------------------------------------- 9. field builder */
function Builder(fn) {
  this.fields = []; this.questions = []; this.warnings = []; this.names = {}; this.qids = {}; this.fn = fn; this.dropped = [];
}
Builder.prototype.set = function (name, value, from, conf, rule) {
  if (this.names[name]) return false;
  if (this.fn && VALID[this.fn] && !VALID[this.fn][name]) { this.dropped.push(name + ' = ' + JSON.stringify(value) + ' ("' + String(from).replace(/\s+/g, ' ').slice(0, 60) + '")'); return false; }
  this.names[name] = true;
  var f = { name: name, value: value, from: String(from).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''), confidence: conf || 'high' };
  if (rule) f.rule = rule;
  this.fields.push(f);
  return true;
};
Builder.prototype.has = function (name) { return !!this.names[name]; };
Builder.prototype.ask = function (id, text, fields, choices, kind) {
  if (this.qids[id]) return;
  this.qids[id] = true;
  this.questions.push({ id: id, text: text, fields: fields, choices: choices || null, kind: kind || (choices ? 'choice' : 'value') });
};
Builder.prototype.warn = function (w) { if (this.warnings.indexOf(w) < 0) this.warnings.push(w); };

/* shared sub-fillers -------------------------------------------------------------------------------------------------- */
function pickShape(F, B, fieldName, askId, opts) {
  opts = opts || {};
  var ds = F.dshapes;
  if (ds.length === 1) { B.set(fieldName, ds[0].norm, ds[0].raw, 'high'); return ds[0]; }
  if (ds.length > 1) {
    B.ask(askId || 'which_shape', 'The text names more than one shape. Which one is this calculation for?', [fieldName], ds.map(function (s) { return s.norm; }));
    return null;
  }
  if (!opts.silent) B.ask(askId || 'which_shape', 'No full shape designation (like W14x90) was found. Which shape?', [fieldName], null);
  return null;
}
function pickFamily(F, B, fieldName, asList) {
  var fam = F.families.slice();
  if (!fam.length) {
    // a full designation given where a family is wanted -> its family
    if (F.dshapes.length === 1 && F.dshapes[0].family) { var fs = F.dshapes[0]; return fillFamily(B, fieldName, fs.family, fs.raw, asList, 'medium'); }
    B.ask('which_family', 'Which family of shapes should it choose from (W8, W10, W12, W14, C10, WT6, L4 ...)?', [fieldName], null);
    return null;
  }
  var seen = {}, d = [];
  fam.forEach(function (f) { if (!seen[f.norm]) { seen[f.norm] = 1; d.push(f); } });
  /* 0.5: a form that takes a LIST of families (the column selection) is given all of them: "the lightest W10, the lightest W12 and the lightest W14" */
  if (d.length > 1 && asList) { B.set(fieldName, d.map(function (x) { return x.norm; }), d.map(function (x) { return x.raw; }).join(', '), 'medium', 'every family named in the text: the lightest of each is worked out'); return d[0].norm; }
  if (d.length > 1) { B.ask('which_family', 'The text mentions more than one family. Which one should it choose from?', [fieldName], d.map(function (x) { return x.norm; })); return null; }
  return fillFamily(B, fieldName, d[0].norm, d[0].raw, asList, 'high');
}
function fillFamily(B, fieldName, famNorm, from, asList, conf) {
  B.set(fieldName, asList ? [famNorm] : famNorm, from, conf);
  return famNorm;
}

function loadBasis(F, B, defaults) {
  // returns {mode:'service'|'factored'|null}
  var hasU = F.loads.filter(function (l) { return l.kind === 'u'; }), t0 = F.t.replace(/unfactored/ig, ''),
    givenFactored = /loads?\s+(?:given\s+)?(?:are|is)\s+(?:already\s+)?factored|already\s+factored|(?:factored|ultimate)\s+(?:dead|live)\s+loads?|(?:factored|ultimate)\s+loads?\s*(?:of|=|:)\s*\d/i.test(t0),
    explicitService = /\bservice\b|\bworking\b|\bunfactored\b/i.test(F.t);
  if (hasU.length) return 'factored';
  if (explicitService && !givenFactored) return 'service';
  if (givenFactored && !explicitService) return 'factored';
  if (givenFactored && explicitService) return null;
  if (defaults && defaults.loads_basis) return 'service-default';
  return 'service-symbol';          // PD, PL, WD, WL, wD, wL are the service (nominal) loads by definition; the factored ones are written Pu, wu, Mu
}

function loadValue(l) { return l.value; }
/* point loads / axial loads in k: D, L, Pu (tension, column, selects) */
function fillAxialLoads(F, B, D) {
  var basis = loadBasis(F, B, D), pu = null, d = null, l = null, i, c;
  var axial = F.loads.filter(function (x) { return (x.unit === 'k' || x.unit === '') && x.kind !== 'W' && x.kind !== 'S' && x.kind !== 'R' && x.kind !== 'Lr'; });
  for (i = 0; i < axial.length; i++) {
    c = axial[i];
    if (c.kind === 'u' && c.first === 'P') pu = pu || c;
    else if (c.kind === 'D') d = d || c;
    else if (c.kind === 'L') l = l || c;
  }
  var other = F.loads.filter(function (x) { return x.kind === 'E' || x.kind === 'W' || x.kind === 'S' || x.kind === 'R' || x.kind === 'Lr'; });
  if (other.length) {
    B.ask('other_load_types', 'The problem has ' + other.map(function (o) { return o.kind; }).join('/') + ' load(s) as well as D and L. This form takes only D and L (service) or one factored Pu. Use the load-combinations form first, then enter the governing Pu here.', ['D', 'L', 'Pu', 'already_factored'], null, 'info');
    return;
  }
  if (pu) {
    B.set('already_factored', true, pu.from, 'high', 'Pu is a factored load');
    B.set('Pu', pu.value, pu.from, 'high');
    return;
  }
  if (d || l) {
    if (basis === 'factored') {
      // "factored loads PD = .. PL = .." -> they are already factored: one number would be needed
      B.ask('loads_basis', 'The text says the loads are factored but gives D and L. Enter the factored total Pu.', ['already_factored', 'D', 'L', 'Pu'], null);
      return;
    }
    if (basis === null) {
      B.ask('loads_basis', 'Are these loads service loads (D and L, to be factored by 1.2D + 1.6L) or already factored?', ['already_factored', 'D', 'L', 'Pu'], ['service (D and L)', 'already factored (Pu)']);
      return;
    }
    if (d) B.set('D', d.value, d.from, 'high');
    if (l) B.set('L', l.value, l.from, 'high');
    if (basis === 'service-default' && D.loads_basis) B.warn('Loads taken as service loads because of: "' + D.loads_basis.from + '"');
    if (basis === 'service-symbol') B.warn('D and L are treated as SERVICE loads (the symbols PD, PL mean service dead and live load; a factored load is written Pu). Check that the problem does not say otherwise.');
    return;
  }
  // loads absent -> nothing to fill (e.g. capacity of a given member)
}

function fillFy(F, B, D, opts) {
  opts = opts || {};
  var G = F.grade, haveFy = false;
  if (G.Fy) { B.set('Fy', G.Fy.value, G.Fy.from, G.Fy.loose ? 'medium' : 'high'); haveFy = true; }
  else if (G.grade) { B.set('Fy', G.grade.Fy, G.grade.from, 'high', 'grade ' + G.grade.name + ' -> Fy ' + G.grade.Fy); haveFy = true; }
  if (opts.fu) {
    if (G.Fu) B.set('Fu', G.Fu.value, G.Fu.from, 'high');
    else if (G.grade && opts.fuFromGrade) B.set('Fu', G.grade.Fu, G.grade.from, 'high', 'grade ' + G.grade.name + ' -> Fu ' + G.grade.Fu);
  }
  if (!haveFy && D.Fy && opts.useDefault) B.set('Fy', D.Fy.value, D.Fy.from, 'default', 'exam default');
  return haveFy;
}

/* 0.6: which axis an end condition is said for: the axis word nearest BEFORE it in its own clause ("Lx = 15 ft (fixed at both ends)"), else the first one
   after it ("fixed at both ends about the strong axis").  The clause runs from the end of the sentence or of the other end condition before it. */
var AX_X = /\b(?:K\s?x\s?)?L\s?x\b|\bx[\s-]*(?:x[\s-]*)?(?:axis|direction)\b|\bstrong(?:er)?[\s-]*(?:axis|direction)\b|\bmajor[\s-]*axis\b/gi,
  AX_Y = /\b(?:K\s?y\s?)?L\s?y\b|\by[\s-]*(?:y[\s-]*)?(?:axis|direction)\b|\bweak(?:er)?[\s-]*(?:axis|direction)\b|\bminor[\s-]*axis\b/gi;
function endAxis(t, e, all) {
  var lo = 0, hi = t.length, i, sb, se, before, after, bx, by;
  for (i = 0; i < all.length; i++) {
    if (all[i] === e) continue;
    if (all[i].end <= e.start && all[i].end > lo) lo = all[i].end;
    if (all[i].start >= e.end && all[i].start < hi) hi = all[i].start;
  }
  sb = Math.max(t.lastIndexOf('. ', e.start), t.lastIndexOf(';', e.start), t.lastIndexOf('\n', e.start));
  if (sb + 1 > lo) lo = sb + 1;
  se = [t.indexOf('. ', e.end), t.indexOf(';', e.end), t.indexOf('\n', e.end)].filter(function (x) { return x >= 0; });
  if (se.length && Math.min.apply(null, se) < hi) hi = Math.min.apply(null, se);
  before = t.slice(lo, e.start); after = t.slice(e.end, hi);
  function last(re, s) { var m, p = -1; re.lastIndex = 0; while ((m = re.exec(s)) !== null) { p = m.index; if (m[0].length === 0) re.lastIndex++; } return p; }
  function first(re, s) { var m; re.lastIndex = 0; m = re.exec(s); return m ? m.index : -1; }
  bx = last(AX_X, before); by = last(AX_Y, before);
  if (bx >= 0 || by >= 0) return bx > by ? 'x' : 'y';
  bx = first(AX_X, after); by = first(AX_Y, after);
  if (bx >= 0 && by < 0) return 'x';
  if (by >= 0 && bx < 0) return 'y';
  if (bx >= 0 && by >= 0) return bx < by ? 'x' : 'y';
  return null;
}
/* 0.6 (10/06 16:35): the cover page's "pinned support conditions / K = 1.0 for all columns" is for a question that says NOTHING about its ends.  A question
   that does say something (fixed, pinned, free, sway, translate, rotation, cantilever, a printed K ...) which the reader could not turn into ONE end
   condition is asked.  Found by running the review cases WITH her cover page typed in, which is the exam condition: the two sway columns of the second
   review, which stop without the cover page, were answered with K = 1.0 (877 kips printed where 766 and about 330 are right). */
/* (Words that merely AGREE with the cover page -- "All supports are pinned", her own sentence in the 2024 final, Q4 -- do not block it: only words that
   could mean something other than pinned ends do.  The first version listed "pinned" as well and Q4 of her real final stopped.) */
var SAYS_ENDS_RE = /\bfixed\b|\bfixity\b|\bfree\b|\b(?:side[\s-]?)?sway(?:s|ing)?\b|\brigid(?:ly)?\b|\btheoretical\b|\btranslat\w*|\brotation(?:al)?\b|\bcantilever\w*|\bflag\s?pole\b|\bbuilt[\s-]in\b|\bunbraced\s+frame\b|\bmoment\s+frame\b|\bK\s*=\s*(?!1(?:\.0+)?(?![\d.]))\d/i;
function fillEnds(F, B, D, fx, fy, o) {
  o = o || {};
  var ends = F.ends.filter(function (e) { return !e.viaK; }), kEnds = F.ends.filter(function (e) { return e.viaK; }), id = null, from = null, rule;
  /* 0.6 (review 4): "Use the THEORETICAL K value".  The table of this page holds the recommended design values only (0.8 was used where 0.7 is asked:
     KL/r 51.06 printed for 44.68).  The question is not worked out with the other set of values. */
  if (/\btheoretical\b/i.test(F.t) && !/\b(?:not|rather\s+than|instead\s+of)\s+(?:the\s+)?theoretical\b/i.test(F.t))
    B.ask('theoretical_k', 'Your question asks for the THEORETICAL K. This page uses the RECOMMENDED DESIGN values of her table (0.65, 0.8, 1.0, 1.2, 2.1, 2.0), so it does not answer this question. The theoretical values of the same table: fixed-fixed 0.5; fixed-pinned 0.7; pinned-pinned 1.0; fixed with sway 1.0; flagpole 2.0; pinned with sway 2.0. NOT answered here.', [], null, 'stop');
  if (ends.length) {
    var ids = {};
    ends.forEach(function (e) { ids[e.id] = e; });
    var keys = Object.keys(ids);
    if (keys.length === 1) { id = keys[0]; from = ids[id].from; }
    else {
      /* 0.6: two DIFFERENT end conditions in one question.
         (a) each is said for its own axis ("Lx = 15 ft (fixed at both ends), Ly = 13 ft (fixed at the base and pinned at the top)"): one per axis;
         (b) the part's own words say one and the shared stem another: the part's own;
         (c) otherwise the page asks, and does not calculate with one of them. */
      var two = null, a0, a1, own, ownIds = {}, ownKeys;
      if (ends.length === 2 && !o.skipY) {
        a0 = endAxis(F.t, ends[0], ends); a1 = endAxis(F.t, ends[1], ends);
        if (a0 && a1 && a0 !== a1) two = a0 === 'x' ? [ends[0], ends[1]] : [ends[1], ends[0]];
      }
      if (two) {
        B.set(fx, two[0].id, two[0].from, 'high', 'said for the strong (x) axis');
        B.set(fy, two[1].id, two[1].from, 'high', 'said for the weak (y) axis');
        return two[0].id;
      }
      own = ends.filter(function (e) { return e.start >= (F.partStart || 0); });
      own.forEach(function (e) { ownIds[e.id] = e; });
      ownKeys = Object.keys(ownIds);
      if (F.partStart && ownKeys.length === 1) { id = ownKeys[0]; from = ownIds[id].from; }
      else { B.ask('end_conditions', 'The text describes more than one end condition (' + keys.join(', ') + '). Which applies to the member?', [fx, fy], ENDS); return null; }
    }
  } else if (kEnds.length) {
    id = kEnds[0].id; from = kEnds[0].from; rule = 'printed K -> ' + id;
    if (/K\s*=\s*1(?:\.0)?\s+for\s+all/i.test(from)) rule = null;
  } else if (D.end_condition && !SAYS_ENDS_RE.test(F.t)) {
    id = D.end_condition.value; from = D.end_condition.from; B.set(fx, id, from, 'default', 'exam default'); if (!o.skipY) B.set(fy, id, from, 'default', 'exam default');
    return id;
  } else {
    B.ask('end_conditions', 'What are the end conditions of the member?', [fx, fy], ENDS);
    return null;
  }
  B.set(fx, id, from, rule ? 'medium' : 'high', rule);
  if (!o.skipY) B.set(fy, id, from, rule ? 'medium' : 'high', rule);
  return id;
}

/* ---------------------------------------------------------------- 10. fillers per function */
var FILL = {};

function tensionCommon(fn, F, B, D) {
  var t = F.t, H = F.holes, sh = F.dshapes, kind = null, shp = null;
  var plate = F.plates.length ? F.plates[0] : null, hasPlateWord = /\bplate\b/i.test(t);
  var isSelect = fn === 'tension_select', isNet = fn === 'tension_net_area', isU = fn === 'lookup_U';
  // ---- what the member is
  var shapeKinds = {};
  sh.forEach(function (s) { shapeKinds[s.kind] = true; });
  var angleLike = !!(shapeKinds.L || shapeKinds['2L'] || (!sh.length && /\bangles?\b/i.test(t)));
  if (!isSelect && !isU) {
    if (sh.length === 1) {
      shp = sh[0];
      B.set('shape', shp.norm, shp.raw, 'high');
      if (shp.kind === 'L' || shp.kind === '2L') { B.set('member', 'angle', shp.raw, 'high', 'angle shape'); if (shp.kind === '2L') B.set('angles', 2, shp.raw, 'high', '2L = two angles'); else if (/\b(?:double|pair\s+of|two)\s+angles?\b/i.test(t)) B.set('angles', 2, t.match(/\b(?:double|pair\s+of|two)\s+angles?\b/i)[0], 'high'); }
      else B.set('member', 'shape', shp.raw, 'high', 'rolled shape');
    } else if (sh.length > 1) {
      B.ask('which_shape', 'The text names more than one shape. Which is the tension member?', ['shape', 'member'], sh.map(function (s) { return s.norm; }));
    } else if (plate || hasPlateWord) {
      B.set('member', 'plate', plate ? plate.raw : t.match(/\bplate\b/i)[0], 'high');
      fillPlateDims(F, B, plate);
    } else if (angleLike) {
      B.set('member', 'angle', 'angle', 'medium');
      B.ask('which_shape', 'Which angle (L4x4x1/2 ...)?', ['shape'], null);
    } else {
      B.ask('which_member', 'What is the tension member (a rolled shape, an angle, or a plate)? Give the shape name.', ['member', 'shape'], ['shape', 'angle', 'plate']);
    }
    if (shp && !(isNet)) { /* nothing */ }
  }
  if (isSelect) {
    if (!pickFamily(F, B, 'family', false)) { /* question already added */ }
    if (shapeKinds['2L'] || /\b(?:double|pair\s+of|two)\s+angles?\b/i.test(t)) B.set('angles', 2, (t.match(/\b(?:double|pair\s+of|two)\s+angles?\b/i) || ['2L'])[0], 'medium');
  }
  if (isU && sh.length === 1) B.set('shape', sh[0].norm, sh[0].raw, 'high');
  else if (isU && sh.length > 1) B.ask('which_shape', 'The text names more than one shape. Which one is the member?', ['shape'], sh.map(function (s) { return s.norm; }));

  // ---- bolt / holes
  var memberIsPlate = !isSelect && !isU && !sh.length && (plate || hasPlateWord);
  var memberIsAngle = angleLike;
  /* (10/07, A1-tcap-01..08) a "no bolt holes" that names a place ("in the web", "the short leg has ...", "elsewhere") is not H.noHoles, and does not
     make the member welded any more.  One that names no place, beside words that count holes or bolts, cannot both be true: welded was yielding only
     (684.45 printed for "4 holes in the flanges ..., no holes in the web, U=0.9", 596.2 right).  Then the hole boxes are asked, below. */
  var holesSaid = !!(H.perFlange || H.cutFlange || H.web || H.perLine || H.lines || H.across || H.inSection || H.forBolt || H.oneHole);
  var noBoltHoles = !!H.noHoles && /bolt/i.test(H.noHoles), noHolesClash = !!H.noHoles && holesSaid;
  var welded = !!H.weldedWord && !H.perFlange && !H.web && !H.perLine && !(F.bolt && /hole/i.test(H.weldedWord) === false && /bolt/i.test(t) && !noBoltHoles);
  if (H.weldedWord && /no\s+bolt\s+holes|all\s+connections\s+are\s+welded|welded/i.test(H.weldedWord) && !F.bolt) welded = true;
  if (noBoltHoles) welded = true;
  if (noHolesClash) welded = false;
  /* (0.6: not when the same text also names rupture or the net section -- "Enter 1 for gross-section yielding or 2 for net-section rupture" is a list of
     choices, and the member has holes) */
  /* (0.7, 10/06 night: and not when the text DESCRIBES bolts -- a diameter, holes per flange, in the web, per line.  "A W12x53 ... two lines of 7/8 in.
     bolts in each flange ... (c) Design strength for yielding of the gross section" is one limit state of a member that HAS holes: the no-holes mode made
     the capacity form refuse, and the page then answered from a member selection: 526.5 kips where 702 is right) */
  if (H.grossYield && !isU && !/\brupture\b|\bfracture\b|\bnet[\s-]*section\b|\bnet\s+area\b/i.test(t) && !F.bolt && !H.perFlange && !H.web && !H.perLine) { if (fn !== 'tension_select') { B.set('welded', true, H.grossYield, 'medium', 'yielding of the gross section only = no-holes mode'); welded = true; } }
  if (welded && !B.has('welded') && !isU) { B.set('welded', true, H.weldedWord || 'welded', 'high'); }
  if (!welded && !isU) {
    if (F.bolt) {
      if (F.bolt.kind === 'hole') B.ask('bolt_or_hole', '"' + F.bolt.from + '": is ' + F.bolt.value + ' in the BOLT diameter (hole = bolt + 1/8) or the HOLE diameter itself?', ['bolt_dia_in', 'hole_dia_in'], ['bolt diameter', 'hole diameter']);
      else B.set('bolt_dia_in', F.bolt.value, F.bolt.from, 'high');
    } else {
      B.ask('bolt_dia', 'What is the bolt diameter (in)?', ['bolt_dia_in'], null);
    }
  }
  var shapeIsTee = shapeKinds.WT || shapeKinds.MT || shapeKinds.ST;
  if (!isU && !welded) {
    if (!memberIsPlate && !memberIsAngle) {
      // rolled shape: holes per flange / in the web
      var pf = H.perFlange, wb = H.web, cutF = H.cutFlange;
      /* 0.5: "N holes cut by the critical section" belongs to the one part the text says is bolted: the web ("through the WEB only"), or the flange of a tee */
      if (H.inSection && !pf && !wb) {
        if (H.onlyWeb || (H.locWeb && !H.locFlange)) wb = { value: H.inSection.value, from: H.inSection.from };
        else if (shapeIsTee && (H.onlyFlange || (H.locFlange && !H.locWeb))) pf = { value: H.inSection.value, from: H.inSection.from };
        /* 0.6 (fresh exam): "bolted through both flanges. The critical section crosses four holes ... and no web holes": all of them in the two flanges */
        else if (!shapeIsTee && !cutF && H.inSection.value % 2 === 0 && (H.onlyFlange || (H.locFlange && (!H.locWeb || H.noWeb)))) pf = { value: H.inSection.value / 2, from: H.inSection.from, half: true };
      }
      if (!pf && cutF) {
        if (shapeIsTee || !cutF.plural) pf = { value: cutF.value, from: cutF.from, viaCut: true };
        else if (cutF.value % 2 === 0) pf = { value: cutF.value / 2, from: cutF.from, viaCut: true, half: true };
      }
      if (pf) B.set('holes_per_flange', pf.value, pf.from, pf.half ? 'medium' : 'high', pf.half ? 'holes cut in both flanges / 2' : null);
      else if (H.noFlange) B.set('holes_per_flange', 0, H.noFlangeFrom, 'high');
      if (wb) B.set('web_holes', wb.value, wb.from, 'high');
      else if (H.noWeb) B.set('web_holes', 0, H.noWebFrom, 'high');
      /* (10/07, A1-tcap-09) holes counted in the web AND "no holes in the web": the count won silently (603.5 printed, 596.2 right).  Asked instead. */
      if (wb && H.noWeb) B.ask('count_web', 'Your question counts holes in the web and also says "' + H.noWebFrom + '". The page does not choose: type the number of web holes your paper means (count on the drawing if there is one).', ['web_holes'], null, 'need');
      if (pf && H.noFlange) B.ask('count_perFlange', 'Your question counts holes in the flanges and also says "' + H.noFlangeFrom + '". The page does not choose: type the number of holes in each flange your paper means (count on the drawing if there is one).', ['holes_per_flange'], null, 'need');
      if (!B.has('holes_per_flange') && !B.has('web_holes')) {
        if (!shapeIsTee) B.ask('holes_count', 'How many holes does a cross-section cut: in each flange, and in the web?', ['holes_per_flange', 'web_holes'], null);
        else B.ask('holes_count', 'For this tee: how many holes in the flange, and how many in the stem?', ['holes_per_flange', 'web_holes'], null);
      } else if (!B.has('holes_per_flange') && !H.onlyWeb && !/web/i.test(H.locFlange || '') && (fn === 'tension_capacity' || isNet)) {
        // only web holes mentioned: flanges assumed 0 only if "web only"
        if (H.onlyWeb) B.set('holes_per_flange', 0, H.onlyWeb, 'medium');
      }
    } else {
      // plate or angle
      if (H.across && !H.stagger) B.set('holes_across', H.across.value, H.across.from, 'high');
      else if (H.inSection && !H.stagger) B.set('holes_across', H.inSection.value, H.inSection.from, 'high');      /* 0.5: "one hole in any cross-section" */
      else if (H.oneHole) B.set('holes_across', H.oneHole.value, H.oneHole.from, 'medium');
      else if (H.forBolt && !H.stagger) B.set('holes_across', H.forBolt.value, H.forBolt.from, 'medium', 'the holes of this plate or angle, named by their bolt');
      else if (H.lines && !H.stagger) B.set('holes_across', H.lines.value, H.lines.from, 'medium', 'a cross-section cuts one hole in each line of bolts');   /* 0.5 */
      if (H.stagger) B.ask('stagger', 'The holes look staggered (' + H.stagger + '). Give the position of every hole (along the member, across the width); the text alone does not fix them.', ['holes', 'holes_across'], null);
      else if (!B.has('holes_across')) B.ask('holes_across', 'How many holes are in the critical cross-section (across the width, no stagger)? Is the pattern staggered?', ['holes_across', 'holes'], ['0', '1', '2', '3', 'staggered (give positions)']);
    }
  }
  if (isSelect && !welded) {
    // select: family given, hole counts for the family
    var pf2 = H.perFlange, wb2 = H.web;
    if (pf2) B.set('holes_per_flange', pf2.value, pf2.from, 'high');
    if (wb2) B.set('web_holes', wb2.value, wb2.from, 'high');
    if (!pf2 && !wb2) {
      if (/\bangles?\b/i.test(t) || (F.families[0] && /^(L|2L)/.test(F.families[0].norm))) { if (H.oneHole) B.set('holes_across', H.oneHole.value, H.oneHole.from, 'medium'); else B.ask('holes_across', 'How many holes are in the critical cross-section?', ['holes_across'], null); }
      else B.ask('holes_count', 'How many holes does a cross-section cut: in each flange, and in the web?', ['holes_per_flange', 'web_holes', 'holes_across'], null);
    }
  }
  /* (10/07) "no holes" that names no place, and holes or bolts counted as well (see noHolesClash above): the hole boxes are emptied and asked */
  if (noHolesClash && !isU && !welded) B.ask('count_noholes', 'Your question says "' + H.noHoles + '" and also counts bolts or holes, without saying where there are none. The page does not choose: type the holes one cross-section cuts, as your paper or its drawing shows them.', (memberIsPlate || memberIsAngle) ? ['holes_across'] : ['holes_per_flange', 'web_holes'], null, 'need');
  if (isSelect && welded) B.set('welded', true, H.weldedWord || 'welded', 'high');

  // ---- a U the question STATES.  It is set FIRST: a field that is set twice keeps its first value, and the cover page's "U = 1.0" used to be set before
  //      this one whenever the kind of connection was not clear ("Use U = 0.90 and Fu = 65 ksi" came out with U = 1.0 with the cover page typed in).
  //      More ways of saying it (review 4): "The shear lag factor U is 0.7", "Take U as 0.7", "a U factor of 0.7", "the shear lag coefficient is 0.70".
  var um = /\bU\s*(?:=|:|is|as|of|equals|equal\s+to)\s*(\d*\.\d+|1(?:\.0+)?)\b|\bU[\s-]*(?:factor|value)\s*(?:of|is|=|:|equals)\s*(\d*\.\d+|1(?:\.0+)?)\b|shear[\s-]*lag\s+(?:factor|coefficient)(?:\s*,?\s*U)?\s*(?:of|is\s+taken\s+as|taken\s+as|is|=|:|as|equals)\s*(\d*\.\d+|1(?:\.0+)?)\b|\btake\s+(?:the\s+)?(?:shear[\s-]*lag\s+(?:factor|coefficient)|U)\s+(?:as|=|to\s+be)\s*(\d*\.\d+|1(?:\.0+)?)\b/i.exec(t);
  /* 0.6 (review 4): the same thing said through the areas: "Ae = 0.7 Ag", "the effective net area Ae is 0.7 times the gross area", "the effective area is
     70% of the gross area" (yielding alone was printed for these: 859.5 where 651.8 is right) */
  var ua = um ? null : /\bA_?e\s*(?:=|is|equals)\s*(0?\.\d+)\s*(?:x|\*|times)?\s*(?:A_?[gn]\b|the\s+(?:gross|net)\s+area)|\beffective\s+(?:net\s+)?area\s*(?:\(?A_?e\)?\s*)?(?:=|is|equals)\s*(?:(0?\.\d+)\s*(?:x|\*|times)\s*(?:the\s+)?(?:(?:gross|net)\s+area|A_?[gn]\b)|(\d{1,3})\s*(?:%|percent)\s+of\s+(?:the\s+)?(?:(?:gross|net)\s+area|A_?[gn]\b))/i.exec(t);
  var uStated = null;
  if (um) uStated = { v: Number(um[1] || um[2] || um[3] || um[4]), from: um[0] };
  else if (ua) uStated = { v: ua[3] ? Number(ua[3]) / 100 : Number(ua[1] || ua[2]), from: ua[0] };
  if (uStated && !(uStated.v > 0 && uStated.v <= 1)) uStated = null;
  if (uStated && !isU) {
    /* the SELECTION of a tension member has no box for a given U: it picks by yielding, and by its own U from the bolts.  With a given U below 1.0 the
       rupture check decides more often than not (W12X65 printed where W12X72 is right), so the page says it does not answer */
    if (isSelect) {
      if (uStated.v < 1) B.ask('u_in_selection', 'Your question gives a shear lag factor ("' + uStated.from + '"). The selection of a tension member on this page does not take a given U, so the shape it would print may be too light. NOT answered here. By hand: required Ag = the larger of Pu / (0.90 x Fy) and Pu / (0.75 x Fu x U); then the lightest shape of the family with at least that area.', [], null, 'stop');
    }
    else B.set('U', uStated.v, uStated.from, 'high');
  }
  /* a U (or an effective area) the question gives in words the lines above did not read: nothing is worked out with another U */
  else if (!isU && !isNet && (fn === 'tension_capacity' || isSelect) && /\bshear[\s-]*lag\b[^.;]{0,50}?(?:[\s=:(](?:0\.\d+|\.\d+)\b|[\s=:(]\d\s*,\s*\d+|\d{1,3}\s*(?:%|percent))|\bU(?:[\s-]*(?:factor|value))?\s*(?:=|:|is|equals|of)\s*\d|\bA_?e\s*(?:=|is|equals)\s*(?:0?\.\d|\d{1,3}\s*%)|\beffective\s+(?:net\s+)?area\b[^.;]{0,40}?(?:\d\s*(?:%|percent)|\btimes\b)/i.test(t)) {
    if (isSelect) B.ask('u_in_selection', 'Your question gives a shear lag factor U (or an effective area as a share of the gross area). The selection of a tension member on this page does not take a given U. NOT answered here.', [], null, 'stop');
    else B.ask('u_unread', 'Your question gives a shear lag factor U (or an effective area as a share of the gross area) in words this page did not read. It will not work this out with another U. Type U here (for "Ae = 0.7 Ag" or "70% of the gross area" type 0.7).', ['U'], null, 'need');
  }
  // ---- connection (for U)
  if (!welded || isU) {
    var conn = null, cfrom = null, why = null;
    var fromF = (H.perFlange || H.cutFlange || {}).from || H.locFlange || null, fromW = (H.web || {}).from || H.locWeb || null;
    var hasF = !!(H.perFlange || H.cutFlange) && (H.perFlange || H.cutFlange).value > 0, hasW = !!H.web && H.web.value > 0;
    if (!hasF && !hasW) { hasF = !!H.locFlange && !H.noFlange; hasW = !!H.locWeb && !H.noWeb; }
    if (H.onlyFlange) { conn = 'flanges'; cfrom = H.onlyFlange; }
    else if (H.onlyWeb) { conn = 'web'; cfrom = H.onlyWeb; }
    else if (hasF && hasW) { conn = 'all'; cfrom = fromF + ' ... ' + fromW; why = 'holes in both flanges and web = all parts connected'; }
    else if (hasF && !hasW) { conn = 'flanges'; cfrom = fromF; why = 'holes only in the flanges'; }
    else if (hasW && !hasF) { conn = 'web'; cfrom = fromW; why = 'holes only in the web'; }
    else if (memberIsAngle && (H.locLeg || F.bolt || H.oneHole)) { conn = 'angle'; cfrom = H.locLeg || (F.bolt ? F.bolt.from : H.oneHole.from); why = 'angle bolted through one leg'; }
    else if (memberIsPlate) { conn = 'all'; cfrom = plate ? plate.raw : 'plate'; why = 'a plain plate: all of the cross-section connected'; }
    if (conn) B.set('connection', conn, cfrom, (why && !H.onlyFlange && !H.onlyWeb) ? 'medium' : 'high', why);
    /* 0.6: HER OWN RULE, when he has typed the cover page: "Unless noted otherwise, assume ... connection shear lag factor U = 1.0" (May 2024 final).
       A question that only DESCRIBES the bolts does not note otherwise, so U is the cover page's.  Before, any described connection sent the page to Table D3.1
       (731.8 kips printed where her rule gives 813.2).  The question notes otherwise when it speaks of shear lag, of Table D3.1, or of U itself. */
    /* 0.6 (10/06 16:40): "noted otherwise" is looked for in the WHOLE question.  With her cover page typed in, a question whose part (a) asks "Which shear
       lag factor U applies?" had its parts (b) to (d) worked with the cover page's U = 1.0 (704 kips printed, 633.6 right), because those parts do not
       repeat the word. */
    if (conn && D.U && !isU && !isNet && (fn === 'tension_capacity' || isSelect) && !/shear[\s-]*lag|table\s+D\s?-?\s?3\.?1|\bU\s*(?:=|factor|value)|\bfind\s+U\b|\bdetermine\s+U\b|\bwhich\s+U\b|\bvalue\s+of\s+U\b/i.test(t + ' ' + (F.whole || ''))) {
      B.set('U', D.U.value, D.U.from, 'default', 'your cover page: U = ' + D.U.value + ' unless noted otherwise (Table D3.1 is not used for this question)');
    }
    else if (!conn && !isU && (fn === 'tension_capacity' || isSelect)) {
      if (D.U) { B.set('U', D.U.value, D.U.from, 'default', 'exam default'); }
      else B.ask('connection', 'Is the member bolted through the flanges, the web, or both (or is it an angle through one leg)?', ['connection'], ['flanges', 'web', 'all', 'angle']);
    } else if (!conn && isU) B.ask('connection', 'Where are the bolts: through the flanges only, the web only, all parts of the section, or one leg of an angle?', ['connection'], ['flanges', 'web', 'all', 'angle', 'welded', 'case2']);
  } else if (isU) {
    B.set('connection', 'welded', H.weldedWord, 'high');
  }
  // ---- fasteners per line
  if (isU || fn === 'tension_capacity' || isSelect) {
    if (H.perLine) B.set('fasteners_per_line', H.perLine.value, H.perLine.from, 'high');
    if (memberIsAngle && H.lines) B.set('fastener_lines', H.lines.value, H.lines.from, 'high');
    else if (memberIsAngle && H.perLine && /single|one\s+line/i.test(H.perLine.from)) B.set('fastener_lines', 1, H.perLine.from, 'high');
  }
  /* 0.8: the count grammar read one of these counts differently from the older rules: the OLDER reading stays in the box, and the difference is said */
  (H.conflicts || []).forEach(function (c) {
    var fld = { perFlange: 'holes_per_flange', web: 'web_holes', perLine: 'fasteners_per_line', lines: 'fastener_lines', across: 'holes_across' }[c.slot];
    if (fld && VALID[fn] && VALID[fn][fld]) B.ask('count_' + c.slot, 'The words about the bolts can be read two ways for this box: ' + c.old + ' ("' + c.oldFrom + '") or ' + c.neu + ' ("' + c.from + '"). The page does not choose between them: type the number your paper means (count on the drawing if there is one).', [fld], null, 'need');
  });
  // ---- explicit U: read at the top of the connection section now (see there), so that a U the question states always wins over the cover page's
  // ---- grade
  fillFy(F, B, D, { fu: !isU, fuFromGrade: true });
  /* 0.6 (review 4): a steel the page does not know ("Fy = 60 ksi steel") with holes, or with a given U: the rupture check needs ITS Fu.  The calculator
     would use 65 ksi (744.9 printed where 859.5 is right).  Fu is asked; nothing is worked out with a guessed one. */
  if (!isU && !isNet && (fn === 'tension_capacity' || isSelect) && F.grade.Fy && !F.grade.Fu && !F.grade.grade && F.grade.Fy.value !== 50 && F.grade.Fy.value !== 36 && (!welded || (uStated && uStated.v < 1)))
    B.ask('fu_needed', 'Your question says ' + F.grade.Fy.from + ' and does not give the tensile strength Fu of that steel. The rupture check needs it, and this page knows Fu only for the steels of her table. Type Fu in ksi if your question, its cover page or its table gives it; if not, this question is NOT answered here.', ['Fu'], null, 'need');
  // ---- length
  if (!isU && !isNet) {
    var len = F.lengths.length;
    if (len && !/\bspan\b/i.test(len.from)) B.set('length_ft', len.value, len.from, 'high', len.unit === 'in' ? 'in -> ft' : null);
  }
  // ---- loads
  if (fn === 'tension_capacity' || isSelect || fn === 'tension_required_area') fillAxialLoads(F, B, D);
}

function fillPlateDims(F, B, plate) {
  var t = F.t, m, w = null, th = null;
  m = new RegExp('(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")?\\s*(?:wide|width)\\b', 'i').exec(t);
  if (m) w = { v: dimValue(m[1]), from: m[0] };
  m = new RegExp('(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")?\\s*thick(?:ness)?\\b', 'i').exec(t);
  if (m) th = { v: dimValue(m[1]), from: m[0] };
  if (plate && (!w || !th)) {
    var a = parseNum(plate.a), b = parseNum(plate.b);
    if (isFinite(a) && isFinite(b)) {
      var thin = a <= b ? plate.a : plate.b, wide = a <= b ? plate.b : plate.a;
      if (!th) th = { v: dimValue(thin), from: plate.raw, rule: 'plate A x B: smaller = thickness' };
      if (!w) w = { v: dimValue(wide), from: plate.raw, rule: 'plate A x B: larger = width' };
    }
  }
  if (w) B.set('width_in', w.v, w.from, w.rule ? 'medium' : 'high', w.rule); else B.ask('plate_width', 'What is the plate width (in)?', ['width_in'], null);
  if (th) B.set('thickness_in', th.v, th.from, th.rule ? 'medium' : 'high', th.rule); else B.ask('plate_thk', 'What is the plate thickness (in)?', ['thickness_in'], null);
}

FILL.tension_capacity = function (F, B, D) { tensionCommon('tension_capacity', F, B, D); };
FILL.tension_net_area = function (F, B, D) { tensionCommon('tension_net_area', F, B, D); };
FILL.tension_select = function (F, B, D) { tensionCommon('tension_select', F, B, D); };
FILL.tension_required_area = function (F, B, D) { fillAxialLoads(F, B, D); fillFy(F, B, D, { fu: true, fuFromGrade: true }); };
FILL.lookup_U = function (F, B, D) { tensionCommon('lookup_U', F, B, D); };

/* ---- columns */
function columnLengths(F, B, D, fn) {
  var L = F.lengths, t = F.t, lx = null, ly = null, klx = null, kly = null, segs = null, i;
  // axis-specific lengths
  if (L.axes) L.axes.forEach(function (a) { if (a.axis === 'y' && !ly) ly = a; if (a.axis === 'x' && !lx) lx = a; });
  // labelled
  L.items.forEach(function (it) {
    var labs = it.labels;
    if (labs.indexOf('Lx') >= 0 && !lx) lx = it;
    else if (labs.indexOf('Ly') >= 0 && !ly) ly = it;
    else if ((labs.indexOf('KLy') >= 0 || labs.indexOf('KyLy') >= 0) && !kly) kly = it;                                  /* 0.6: KyLy is its own number */
    else if ((labs.indexOf('KL') >= 0 || labs.indexOf('KLx') >= 0 || labs.indexOf('KxLx') >= 0) && !klx) klx = it;      /* 0.5: also "Lc = KL = 18 ft": the text itself says the number IS the effective length */
    else if ((labs.indexOf('L') >= 0 || labs.indexOf('Lc') >= 0 || labs.indexOf('l') >= 0 || labs.indexOf('Lb') >= 0) && !F.common) F.common = F.common || it;
  });
  var common = F.common || null;
  if (!common && !klx && L.length) common = L.length;
  if (!common && !klx && L.combos.length === 1) common = L.combos[0];
  if (!common && !klx && !lx && !ly) {
    /* 0.5: no word such as "long" or "tall": when the whole text holds exactly ONE length in feet (and it is not a spacing or a span), it is the member's
       length ("W14x99 column (...), 30 ft, fixed at top and bottom") */
    var only = null, many = false, reL = new RegExp('(' + N + ')\\s*-?\\s*(ft|feet|foot)(?![A-Za-z])(?!\\s*-?\\s*\\d)', 'gi'), mL, vL;
    /* lengths of the weak-axis SEGMENTS are not the member's length: "three 10-ft segments", "segments of 12, 8 and 8 ft" */
    var tSeg = t.replace(new RegExp('\\b(?:' + WN + ')\\s+(?:equal\\s+)?' + N + '\\s*-?\\s*(?:ft|feet|foot)\\s*-?\\s*(?:long\\s+)?segments?', 'gi'), function (x) { return new Array(x.length + 1).join(' '); })
      .replace(new RegExp('segments?\\s+of\\s+[^.;)]{0,40}?(?:ft|feet|foot)', 'gi'), function (x) { return new Array(x.length + 1).join(' '); })
      /* 0.8: nor is the height of a BRACE: "W14x109, 24 ft, pinned ends; weak-axis brace 8 ft above the base" has one member length, 24 ft */
      .replace(new RegExp(N + '\\s*-?\\s*(?:ft|feet|foot)\\s+(?:above|below|from)\\s+(?:the\\s+|its\\s+)?(?:bottom|base|top|foundation|floor)\\b', 'gi'), function (x) { return new Array(x.length + 1).join(' '); });
    while ((mL = reL.exec(tSeg)) !== null) {
      vL = parseNum(mL[1]);
      if (only === null) only = { value: round6(vL), from: mL[0], unit: 'ft', raw: mL[1], start: mL.index, end: mL.index + mL[0].length, label: 'only' };
      else if (Math.abs(only.value - vL) > 1e-9) many = true;
    }
    /* ...and only when it stands by itself between commas (or right after "height" / "length"): "K 0.80 over 32 ft" is not that */
    /* (0.8: the member need not be CALLED a column when the words are a column's own: "A W12x50, 20 ft, pinned-pinned, E = 29,000 ksi. Euler Pcr = ____",
       "W14x109, 24 ft, pinned ends; weak-axis pin brace 8 ft above the base. Find governing KL/r") */
    if (only && !many && !L.span && !L.spacing && /column|strut|compression|\bKL\s*\/\s*r\b|\bslenderness\b|\bbuckl|\b(?:weak|strong)[\s-]axis\b|\beuler\b|\bproportional\s+limit\b|\bP\s?cr\b/i.test(t) && /(?:[,;)]|\b(?:height|length|long|tall)(?:\s+(?:of|is|=))?)\s*$/i.test(t.slice(0, only.start))
      && /^\s*(?:[,;.]|$|and\b|with\b|fixed\b|pinned\b)/i.test(t.slice(only.end))) { common = only; common.only = true; }
  }
  /* 0.6 (review 3): the effective lengths said in words: "an effective length of 30 ft about the strong axis and 15 ft about the weak axis" = KxLx and KyLy
     (the page took 30 ft as the member's length and stopped for the end conditions) */
  if (!klx && !kly) {
    var UFT = '\\s*-?\\s*(?:ft|feet|foot|\')', AXX = '(?:strong|major|x(?:\\s*-\\s*x)?)(?:[\\s-]*axis)?', AXY = '(?:weak|minor|y(?:\\s*-\\s*y)?)(?:[\\s-]*axis)?', ABOUT = '\\s+(?:about|for|along|in)\\s+(?:the\\s+|its\\s+)?', mE;
    mE = new RegExp('\\beffective\\s+lengths?\\s+(?:of\\s+|is\\s+|are\\s+|=\\s*)?(' + N + ')' + UFT + ABOUT + AXX + '\\b[^.;]{0,25}?(' + N + ')' + UFT + ABOUT + AXY + '\\b', 'i').exec(t);
    if (mE) { klx = { value: round6(parseNum(mE[1])), from: mE[0], unit: 'ft', labels: ['KxLx'] }; kly = { value: round6(parseNum(mE[2])), from: mE[0], unit: 'ft', labels: ['KyLy'] }; common = null; lx = null; ly = null; }
    else {
      mE = new RegExp('\\beffective\\s+lengths?\\s+(?:of\\s+|is\\s+|are\\s+|=\\s*)?(' + N + ')' + UFT + ABOUT + AXY + '\\b[^.;]{0,25}?(' + N + ')' + UFT + ABOUT + AXX + '\\b', 'i').exec(t);
      if (mE) { kly = { value: round6(parseNum(mE[1])), from: mE[0], unit: 'ft', labels: ['KyLy'] }; klx = { value: round6(parseNum(mE[2])), from: mE[0], unit: 'ft', labels: ['KxLx'] }; common = null; lx = null; ly = null; }
    }
  }
  /* 0.6 (review 3): "The unbraced length is 16 ft about both axes": the member's length, the same both ways (the page stopped for the length) */
  if (!common && !klx && !kly && !lx && !ly) {
    var mU = new RegExp('\\b(?:unbraced|unsupported)\\s+(?:length|height)\\s+(?:is\\s+|of\\s+|=\\s*)?(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')\\s+(?:about|for|in)\\s+(?:both|each|either)\\s+(?:ax[ei]s|directions?)', 'i').exec(t)
      /* (review 4) "the unbraced length about both axes is 16 ft" */
      || new RegExp('\\b(?:unbraced|unsupported)\\s+(?:length|height)\\s+(?:about|for|in)\\s+(?:both|each|either)\\s+(?:ax[ei]s|directions?)\\s+(?:is|=|of)\\s*(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')', 'i').exec(t);
    if (mU) common = { value: round6(parseNum(mU[1])), from: mU[0], unit: 'ft', raw: mU[1], label: 'unbraced' };
  }
  // bracing phrases
  var brace = findBracing(t, common ? common.value : null);
  if (kly && !klx && common) { /* a KyLy next to a plain member length: the plain length stays the strong-axis one; the weak axis is KyLy (set below by the caller) */ }
  return { lx: lx, ly: ly, klx: klx, kly: kly, common: common, brace: brace };
}

function findBracing(t, total) {
  var o = { fraction: null, segs: null, from: null, mid: null };
  var m = /(?:braced|supported|restrained|bracing|brace[ds]?)[^.;]{0,90}?(?:at\s+)?(?:its\s+|the\s+)?(?:one[- ])?(third|quarter|mid)[- ]?(?:points?|height|length|span)/i.exec(t);
  if (!m) m = /(one[- ]third|1\/3|third)\s+points?[^.;]{0,40}/i.exec(t);
  if (m) {
    var w = /third/i.test(m[0]) ? 3 : (/quarter/i.test(m[0]) ? 4 : 2);
    o.fraction = w; o.from = m[0];
  }
  if (!m) { m = /(?:braced|supported)[^.;]{0,50}?(?:at\s+)?mid-?(?:height|length|span|point)|at\s+its\s+mid-?(?:height|length|point)|at\s+mid-?(?:height|length|point)/i.exec(t); if (m) { o.fraction = 2; o.from = m[0]; } }
  var b = new RegExp('(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')\\s+(?:above|from)\\s+(?:the\\s+)?(?:bottom|base|top)', 'i').exec(t);
  if (b && /brace|support/i.test(t)) { o.above = { value: parseNum(b[1]), from: b[0] }; }
  return o;
}

/* 0.6: where the plates of a plated W shape sit, when the text SAYS it: 'tips' (at the flange tips, boxing the section), 'faces' (flat on the flanges; a
   "cover plate" is one by its name), or null when the text does not say or says both. */
function platePlace(t) {
  var tips = /\bflange\s+tips?\b|\btips?\s+of\s+(?:the\s+|its\s+|both\s+)?flanges?\b|\bflange\s+toes?\b|\btoes?\s+of\s+(?:the\s+|its\s+)?flanges?\b|\bboxed\b|\bboxing\b|\bbox(?:ed)?\s+(?:section|shape|column)\b|\bform(?:s|ing)?\s+a\s+box\b/i.test(t),
    faces = /\bflat\s+on\s+the\s+outside\b|\boutside\s+faces?\b|\bflange\s+faces?\b|\bfaces?\s+of\s+(?:each|the|both)\s+flanges?\b|\bwelded\s+to\s+(?:each|the|both|the\s+top\s+and\s+(?:the\s+)?bottom)\s+flanges?\b|\b(?:on|to)\s+(?:each|both|the\s+top\s+and\s+(?:the\s+)?bottom)\s+flanges?\b|\bcover\s+plates?\b|\bcover[\s-]plated\b/i.test(t);
  if (tips && faces) return /\bcover\s+plates?\b|\bcover[\s-]plated\b/i.test(t) && !/\bflat\s+on\s+the\s+outside\b|\boutside\s+faces?\b|\bflange\s+faces?\b|\bfaces?\s+of\s+(?:each|the|both)\s+flanges?\b/i.test(t) ? 'tips' : null;
  return tips ? 'tips' : (faces ? 'faces' : null);
}
function fillColumn(fn, F, B, D) {
  var t = F.t, isSel = fn === 'column_select';
  var shapeKinds = {};
  F.dshapes.forEach(function (s) { shapeKinds[s.kind] = true; });
  if (isSel) { pickFamily(F, B, 'families', true); }
  else {
    var coverPl = F.cover;
    if (F.dshapes.length === 1) B.set('shape', F.dshapes[0].norm, F.dshapes[0].raw, 'high');
    else if (F.dshapes.length > 1) B.ask('which_shape', 'The text names more than one shape. Which one is the column?', ['shape'], F.dshapes.map(function (s) { return s.norm; }));
    else B.ask('which_shape', 'Which column shape (W14x90, HSS8x8x3/8, Pipe 10 STD ...)?', ['shape'], null);
    if (coverPl) {
      var a = parseNum(coverPl.a), b = parseNum(coverPl.b), tt = a <= b ? coverPl.a : coverPl.b, bb = a <= b ? coverPl.b : coverPl.a, where = platePlace(t);
      B.set('plate_t_in', dimValue(tt), coverPl.from, 'medium', 'plate A x B: smaller = thickness');
      /* 0.6: WHERE the plates sit decides the box: on the flange faces -> width b; at the flange tips (boxing the section) -> height h.  Before, the larger
         number always went into the width box, so "two plates at the flange tips (boxed)" was worked out as cover plates on the flanges, without a word. */
      if (where === 'tips') B.set('plate_h_in', dimValue(bb), coverPl.from, 'medium', 'plates at the flange tips: the larger number is the height h');
      else if (where === 'faces') B.set('plate_b_in', dimValue(bb), coverPl.from, 'medium', 'plate A x B: larger = width');
      else B.ask('plate_place', 'Are the cover plates on the flange FACES (flat), or at the flange TIPS (boxing the section)?', ['plate_b_in', 'plate_h_in'], ['on the flange faces', 'at the flange tips']);
    }
  }
  fillFy(F, B, D, {});
  var Ls = columnLengths(F, B, D, fn);
  var tot = Ls.common ? Ls.common.value : null;
  var useSeg = !Ls.ly && !Ls.brace.fraction && tot !== null && !!Ls.brace.above;
  /* 0.6 (review 4): a K the question PRINTS is a number, and KL = K x L.  It used to be turned into "the end condition that has this K" through a small
     table: K = 0.5, 0.7, 0.9, 1.5, 2.5 were not in the table, so the cover page's K = 1.0 was used (KL/r 63.83 printed for 31.91), and K = 2.0 came out
     as the flagpole's 2.1.  Now: one printed K, a plain member length, no brace along the height -> KL is entered directly, with the arithmetic shown. */
  var kPr = /\bK\s*(?:=|is|of)\s*(\d*\.?\d+)\b(?!\s*for\s+all)/.exec(t) || /\beffective\s+length\s+factor\s+(?:K\s*)?(?:of|is|=)\s*(\d*\.?\d+)\b/i.exec(t),
    kNum = kPr ? Number(kPr[1]) : null, kLx = Ls.lx ? Ls.lx.value : tot, kLy = Ls.ly ? Ls.ly.value : tot;
  if (kNum !== null && kNum >= 0.3 && kNum <= 3 && !Ls.klx && !Ls.kly && kLx !== null && kLy !== null && !Ls.brace.fraction && !Ls.brace.above && !useSeg
    && (t.match(/\bK\s*(?:=|is|of)\s*\d*\.?\d+/g) || []).length <= 1 && !/\bK\s?[xy]\s*=/.test(t)) {
    B.set('KLx_ft', round6(kNum * kLx), kPr[0], 'high', 'K is given in the question: KL = K x L = ' + kNum + ' x ' + kLx + ' = ' + round6(kNum * kLx) + ' ft');
    B.set('KLy_ft', round6(kNum * kLy), kPr[0], 'high', 'K is given in the question: KL = K x L = ' + kNum + ' x ' + kLy + ' = ' + round6(kNum * kLy) + ' ft');
    fillAxialLoads(F, B, D);
    return;
  }
  /* 0.5: the weak axis braced into SEGMENTS (HW 5-17 "segments of 12, 8 and 8 ft"; the 9/9 class column "lateral supports at the third points ... three 10-ft
     segments").  Her method: a brace is a pin.  An END segment keeps the column's own end (a fixed end gives K = 0.8 for that segment), every other segment is
     pinned-pinned (K = 1.0), and the largest K x L governs.  Giving the whole weak axis the column's K (0.65 x L/3 for a fixed-fixed column) is NOT her method.
     Built only when the ends are plain pinned / fixed; a pinned-pinned column keeps the simpler Ly = L/n (same numbers). */
  var ends0 = F.ends.filter(function (e) { return !e.viaK; }), id0 = ends0.length ? ends0[0].id : null, segLens = null, segFrom = null, fx = null, mseg, nw;
  if (id0 === 'fixed-fixed') fx = { top: true, bottom: true };
  else if (id0 === 'fixed-pinned') {
    var topFixed = /fixed\s+at\s+(?:the\s+|its\s+)?top|pinned\s+at\s+(?:the\s+|its\s+)?(?:base|bottom)/i.test(t), botFixed = /fixed\s+at\s+(?:the\s+|its\s+)?(?:base|bottom)|pinned\s+at\s+(?:the\s+|its\s+)?top/i.test(t);
    fx = (topFixed && !botFixed) ? { top: true, bottom: false } : ((botFixed && !topFixed) ? { top: false, bottom: true } : { top: false, bottom: true, guessed: true });
  }
  if (fx && !Ls.ly) {
    mseg = new RegExp('segments?\\s+of\\s+((?:' + N + '\\s*(?:ft|feet|foot|\')?\\s*(?:,\\s*and\\s+|,\\s*|\\s+and\\s+))+' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')', 'i').exec(t);
    if (mseg) { segLens = (mseg[1].match(new RegExp(N, 'g')) || []).map(parseNum); segFrom = mseg[0]; }
    if (!segLens) {
      mseg = new RegExp('\\b(' + WN + ')\\s+(?:equal\\s+)?(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')\\s*-?\\s*(?:long\\s+)?segments?', 'i').exec(t);
      if (mseg) { nw = wnum(mseg[1]); if (nw >= 2 && nw <= 8) { segLens = []; while (segLens.length < nw) segLens.push(parseNum(mseg[2])); segFrom = mseg[0]; } }
    }
    if (!segLens && Ls.brace.fraction && tot !== null) { segLens = []; while (segLens.length < Ls.brace.fraction) segLens.push(round6(tot / Ls.brace.fraction)); segFrom = Ls.brace.from; }
    /* unequal segments on a column with ONE fixed end: which end is which must be known (lengths are listed from the top down) */
    if (segLens && fx.guessed && segLens.some(function (x) { return Math.abs(x - segLens[0]) > 1e-9; })) segLens = null;
    if (segLens && fx.top !== fx.bottom && segLens.some(function (x) { return Math.abs(x - segLens[0]) > 1e-9; }) && /above\s+the\s+(?:base|bottom)|from\s+the\s+(?:base|bottom)/i.test(t) && !/below\s+the\s+top|from\s+the\s+top/i.test(t)) segLens = segLens.slice().reverse();
  }
  var segRows = segLens ? segLens.map(function (len, i) {
    var a = i === 0 && fx.top, b2 = i === segLens.length - 1 && fx.bottom;
    return { length_ft: len, end_condition: (a && b2) ? 'fixed-fixed' : ((a || b2) ? 'fixed-pinned' : 'pinned-pinned') };
  }) : null;
  if (segRows) useSeg = false;
  var endId = fillEnds(F, B, D, 'x_end_condition', 'y_end_condition', { skipY: useSeg || !!segRows });
  // lengths
  if ((Ls.klx || Ls.kly) && !Ls.common) {
    /* 0.6: "KxLx = 28 ft, KyLy = 19 ft" are two numbers.  Before, KyLy was dropped and KxLx went into both boxes (W12X96 chosen where W12X65 is right).
       A plain "KL = 18 ft" with no axis is still the same both ways; "KxLx" alone leaves the weak axis to be asked. */
    var genericKL = !!(Ls.klx && Ls.klx.labels && Ls.klx.labels.indexOf('KL') >= 0);
    if (Ls.klx) B.set('KLx_ft', Ls.klx.value, Ls.klx.from, 'high');
    else B.ask('klx', 'Your text gives KyLy only. What is KxLx (the effective length about the strong axis)?', ['KLx_ft'], null);
    if (Ls.kly) B.set('KLy_ft', Ls.kly.value, Ls.kly.from, 'high');
    else if (genericKL) B.set('KLy_ft', Ls.klx.value, Ls.klx.from, 'high');
    else B.ask('kly', 'Your text gives KxLx only. What is KyLy (the effective length about the weak axis)?', ['KLy_ft'], null);
  }
  else {
    /* 0.6 (review 4): "braced at mid-height in BOTH directions" / "about both axes": the brace shortens the strong axis too (1015 printed for 1068) */
    var bothDir = !!(Ls.brace && Ls.brace.fraction && tot !== null && !segRows && /\b(?:braced|supported|restrained|bracing)\b[^.;]{0,90}?\b(?:in|about|along|for)\s+both\s+(?:principal\s+)?(?:directions|axes)\b/i.test(t));
    if (Ls.lx) B.set('Lx_ft', Ls.lx.value, Ls.lx.from, 'high');
    else if (bothDir) B.set('Lx_ft', round6(tot / Ls.brace.fraction), Ls.brace.from, 'medium', 'braced in both directions: Lx = L/' + Ls.brace.fraction + ' too');
    else if (tot !== null) B.set('Lx_ft', tot, Ls.common.from, 'high', Ls.common.unit === 'in' ? 'in -> ft' : null);
    // weak axis
    if (Ls.ly) B.set('Ly_ft', Ls.ly.value, Ls.ly.from, 'high');
    else if (segRows) B.set('y_segments', segRows, segFrom, 'medium', 'a brace is a pin: an end segment keeps the column\'s own end (fixed end: K 0.8), the others are pinned-pinned (K 1.0); the largest K x L governs');
    else if (Ls.brace.fraction && tot !== null) {
      var n = Ls.brace.fraction;
      B.set('Ly_ft', round6(tot / n), Ls.brace.from, 'medium', 'braced at the ' + (n === 3 ? 'third' : n === 4 ? 'quarter' : 'mid') + ' points: Ly = L/' + n);
    }
    else if (useSeg) {
      var a1 = Ls.brace.above.value, a2 = round6(tot - a1), eid = endId || 'pinned-pinned';
      B.set('y_segments', [{ length_ft: a1, end_condition: eid }, { length_ft: a2, end_condition: eid }], Ls.brace.above.from, 'medium', 'a brace at a height splits the length in two segments');
    }
    else if (tot !== null) B.set('Ly_ft', tot, Ls.common.from, 'high', 'one length, same for both axes');
    else if (!Ls.lx && !Ls.ly) B.ask('column_length', 'What is the column length (ft)? (Say if the weak axis is braced.)', ['Lx_ft', 'Ly_ft'], null);
    if (!B.has('Lx_ft') && B.has('Ly_ft') && !Ls.lx) { /* only weak axis given */ B.ask('column_Lx', 'What is the strong-axis length Lx (ft)?', ['Lx_ft'], null); }
  }
  // loads
  fillAxialLoads(F, B, D);
  if (isSel) { /* families handled */ }
}

FILL.column_capacity = function (F, B, D) { fillColumn('column_capacity', F, B, D); };
FILL.column_select = function (F, B, D) { fillColumn('column_select', F, B, D); };
FILL.column_euler = function (F, B, D) {
  var t = F.t, m;
  /* 0.5: the area and the radius of gyration printed in the question ("A = 11.9 in^2, r = 3.67 in") are HER numbers: they are used instead of the table's */
  /* (0.8: the weak-axis radius written as "ry = 1.33 in" is the r of the buckling axis when it is the only r given) */
  var mA = new RegExp('(?:^|[^A-Za-z])A\\s*=\\s*(' + N + ')\\s*(?:in\\.?\\s?\\^?\\s?2|sq\\.?\\s*in|in2)', '').exec(t), mR = new RegExp('(?:^|[^A-Za-z])r\\s*=\\s*(' + N + ')\\s*(?:in\\.?|inch(?:es)?)(?![A-Za-z^0-9])', '').exec(t);
  if (!mR && !/(?:^|[^A-Za-z])r\s?_?x\s*=/.test(t)) mR = new RegExp('(?:^|[^A-Za-z])r\\s?_?(?:y|min)\\s*=\\s*(' + N + ')\\s*(?:in\\.?|inch(?:es)?)(?![A-Za-z^0-9])', '').exec(t);
  if (mA && mR) { B.set('A', parseNum(mA[1]), mA[0].replace(/^[^A]/, ''), 'high', 'A given in the question'); B.set('r', parseNum(mR[1]), mR[0].replace(/^[^r]/, ''), 'high', 'r given in the question'); }
  else if (F.bar) { B.set('bar_dia_in', F.bar.value, F.bar.from, 'high'); }
  else if (F.dshapes.length === 1) B.set('shape', F.dshapes[0].norm, F.dshapes[0].raw, 'high');
  else if (F.plates.length) {
    var a = parseNum(F.plates[0].a), b = parseNum(F.plates[0].b);
    B.set('rect_t_in', dimValue(a <= b ? F.plates[0].a : F.plates[0].b), F.plates[0].raw, 'medium', 'plate A x B: smaller = thickness');
    B.set('rect_b_in', dimValue(a <= b ? F.plates[0].b : F.plates[0].a), F.plates[0].raw, 'medium', 'plate A x B: larger = width');
  }
  else B.ask('euler_section', 'What is the section: a shape (W8x35 ...), a solid round bar (diameter), or a rectangle (b x t)?', ['shape', 'bar_dia_in', 'rect_b_in', 'rect_t_in'], null);
  var Ls = columnLengths(F, B, D, 'column_euler'), len = Ls.lx || Ls.common;
  if (len) B.set('L_ft', len.value, len.from, 'high', len.unit === 'in' ? 'in -> ft' : null);
  else B.ask('euler_L', 'What is the column length L (ft)?', ['L_ft'], null);
  var ends = F.ends.filter(function (e) { return !e.viaK; });
  var kPrinted = /\bK\s*=\s*(\d*\.?\d+)/i.exec(t);
  if (kPrinted) B.set('K', Number(kPrinted[1]), kPrinted[0], 'high');
  else if (ends.length === 1 && ends[0].id === 'pinned-pinned') B.set('K', 1, ends[0].from, 'high', 'pinned ends: K = 1.0');
  else if (ends.length === 1) B.ask('euler_K', 'End conditions "' + ends[0].from + '": what K should be used?', ['K'], ['0.65', '0.8', '1.0', '1.2', '2.0', '2.1']);
  m = /proportional\s+limit\s*(?:=|of|is)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(ksi|psi)/i.exec(t);
  if (m) { var pv = parseNum(m[1]); B.set('proportional_limit_ksi', m[2].toLowerCase() === 'psi' ? round6(pv / 1000) : pv, m[0], 'high', m[2].toLowerCase() === 'psi' ? 'psi -> ksi' : null); }
  fillFy(F, B, D, {});
};
FILL.section_properties = function (F, B, D) {
  if (F.bar) B.set('bar_dia_in', F.bar.value, F.bar.from, 'high');
  if (F.cover) {
    var a = parseNum(F.cover.a), b = parseNum(F.cover.b);
    if (F.dshapes.length === 1) B.set('shape', F.dshapes[0].norm, F.dshapes[0].raw, 'high');
    B.set('plate_t_in', dimValue(a <= b ? F.cover.a : F.cover.b), F.cover.from, 'medium', 'plate A x B: smaller = thickness');
    var where2 = platePlace(F.t);
    if (where2 === 'tips') B.set('plate_h_in', dimValue(a <= b ? F.cover.b : F.cover.a), F.cover.from, 'medium', 'plates at the flange tips: the larger number is the height h');
    else if (where2 === 'faces') B.set('plate_b_in', dimValue(a <= b ? F.cover.b : F.cover.a), F.cover.from, 'medium', 'plate A x B: larger = width');
    else B.ask('plate_place', 'Are the plates on the flange FACES (flat) or at the flange TIPS (boxing the section)?', ['plate_b_in', 'plate_h_in'], ['faces', 'tips']);
  } else if (F.plates.length && !F.bar) {
    var p = F.plates[0], a2 = parseNum(p.a), b2 = parseNum(p.b);
    B.set('rect_t_in', dimValue(a2 <= b2 ? p.a : p.b), p.raw, 'medium', 'plate A x B: smaller = thickness');
    B.set('rect_b_in', dimValue(a2 <= b2 ? p.b : p.a), p.raw, 'medium', 'plate A x B: larger = width');
  }
  if (!B.fields.length) B.ask('section_what', 'Which section: a solid bar (diameter), a plate (t x b), or a W with cover plates?', ['bar_dia_in', 'rect_b_in', 'rect_t_in', 'plate_t_in', 'plate_b_in'], null);
};
FILL.lookup_K = function (F, B, D) {
  var ends = F.ends.filter(function (e) { return !e.viaK; }), own = F.t.slice(F.partStart || 0);
  /* 0.8: a part that asks for the THEORETICAL K is not answered with the recommended design value (the same stop the column forms have) */
  if (/\btheoretical\b/i.test(own) && !/\b(?:not|rather\s+than|instead\s+of)\s+(?:the\s+)?theoretical\b/i.test(own) && !/\b(?:recommended|design)\b/i.test(own))
    B.ask('theoretical_k', 'Your question asks for the THEORETICAL K. This page gives the RECOMMENDED DESIGN values of her table (0.65, 0.8, 1.0, 1.2, 2.1, 2.0). The theoretical values of the same table: fixed-fixed 0.5; fixed-pinned 0.7; pinned-pinned 1.0; fixed with sway 1.0; flagpole 2.0; pinned with sway 2.0. NOT answered here.', [], null, 'stop');
  if (ends.length === 1) B.set('end_condition', ends[0].id, ends[0].from, 'high');
  else if (ends.length > 1) B.ask('end_conditions', 'More than one end condition is described. Which one?', ['end_condition'], ENDS);
  else B.ask('end_conditions', 'What are the end conditions?', ['end_condition'], ENDS);
};
FILL.lookup_critical_stress = function (F, B, D) {
  var m = /KL\s*\/\s*r\s*(?:=|of|is)?\s*(\d+(?:\.\d+)?)/i.exec(F.t);
  if (m) B.set('KL_over_r', Number(m[1]), m[0], 'high'); else B.ask('klr', 'What is KL/r?', ['KL_over_r'], null);
  fillFy(F, B, D, {});
};

/* ---- beams */
function uniformLoads(F) {
  var o = { wD: null, wL: null, wu: null, self: null, include: null };
  F.loads.forEach(function (l) {
    if (l.unit !== 'klf' && l.unit !== 'plf') return;
    var v = l.unit === 'plf' ? round6(l.value / 1000) : l.value;
    var rec = { value: v, from: l.from, unit: l.unit, rule: l.unit === 'plf' ? 'lb/ft -> k/ft' : null, basis: l.basis, via: l.via };
    if (l.kind === 'D' && !o.wD) o.wD = rec;
    else if (l.kind === 'L' && !o.wL) o.wL = rec;
    else if (l.kind === 'u' && !o.wu) o.wu = rec;
  });
  return o;
}
function selfWeight(F) {
  var t = F.t, m = new RegExp('(?:self[- ]weight|weighs?|weight)\\s+(?:of\\s+)?(?:the\\s+beam\\s+)?(?:is\\s+)?(?:about\\s+)?(' + N + ')\\s*(?:lb\\s*\\/\\s*ft|plf|lbs?\\s*\\/\\s*ft)', 'i').exec(t);
  if (m) return { value: parseNum(m[1]), from: m[0] };
  m = new RegExp('(?:each\\s+)?beam\\s+(?:has|have)\\s+a\\s+self[- ]weight\\s+of\\s+(' + N + ')\\s*(?:lb\\s*\\/\\s*ft|plf)', 'i').exec(t);
  if (m) return { value: parseNum(m[1]), from: m[0] };
  return null;
}
/* 0.6: three different sentences were all read as "the load already includes the beam's weight", and the weight was then left out:
     "(Include the self-weight of the beam in your calculation.)"   an INSTRUCTION to add it  (her May 2024 final, Q20)        -> 495 printed, 501.75 right
     "wD = 1.0 k/ft (not including the weight of the beam)"          the load does NOT include it                             -> 405 printed, 410.94 right
     "Determine the maximum moment, including the beam weight."      an instruction again
   Only a statement ABOUT THE LOAD counts: "this includes self-weight", "which includes the weight of the beam", "loads include ...", "... of 1 k/ft
   including the beam's weight". */
var SELF_RE = /(includes?|including|included|incl\.|inclusive\s+of)\s+(?:the\s+|its\s+|an?\s+)?(?:weight\s+of\s+the\s+(?:beam|member)|(?:beam|member)'?s?\s+(?:own\s+)?(?:self[- ])?weight|(?:own\s+)?self[- ]?weight|own\s+weight)/gi;
var SELF_PASSIVE_RE = /(?:self[- ]?weight|own\s+weight|weight\s+of\s+the\s+(?:beam|member)|(?:beam|member)(?:'s)?\s+(?:own\s+)?weight)[^.;]{0,30}?\b(is|are)\s+(not\s+)?(?:already\s+)?included\b/gi;
function selfMentions(t) {
  var out = [], m, pre, verb, before, sent, kind;
  SELF_RE.lastIndex = 0;
  while ((m = SELF_RE.exec(t)) !== null) {
    pre = t.slice(Math.max(0, m.index - 18), m.index);
    verb = m[1].toLowerCase();
    before = (/([A-Za-z']+)[\s(]*$/.exec(pre) || [])[1] || '';
    sent = t.slice(0, m.index).split(/[.;?!]\s/).pop();
    if (/(?:\bnot|n't|\bnever|\bwithout)\s+(?:yet\s+)?$/i.test(pre)) kind = 'not';
    else if (verb === 'include') kind = /^(?:loads?|values?|they|these|those|figures?|numbers?|which|that|weights?)$/i.test(before) ? 'has' : 'add';
    else if (verb === 'including') {
      /* 0.6 (review 2): right after a load ("a dead load of 1.0 k/ft (including the weight of the beam)") it DESCRIBES the load, whatever verb opens the
         sentence; the beam's weight was added a second time (415.26 printed for 405) */
      if (/(?:\d\s*(?:k\/ft|klf|kips?\/ft|lb\/ft|plf|psf|kips?|k)\s*[,(]?\s*|\bloads?\s*[,(]?\s*)$/i.test(t.slice(Math.max(0, m.index - 30), m.index))) kind = 'has';
      else kind = /\b(?:determine|find|calculate|compute|select|design|size|what|check)\b/i.test(sent) ? 'add' : 'has';
    }
    else kind = 'has';
    out.push({ kind: kind, from: m[0] });
  }
  /* "The beam weight of 50 lb/ft is included in the dead load." */
  SELF_PASSIVE_RE.lastIndex = 0;
  while ((m = SELF_PASSIVE_RE.exec(t)) !== null) out.push({ kind: m[2] ? 'not' : 'has', from: m[0] });
  return out;
}
function includesSelf(t) {
  var ms = selfMentions(t), i, m;
  for (i = 0; i < ms.length; i++) if (ms[i].kind === 'has') return ms[i].from;
  m = /\(this\s+includes\s+the\s+weight\s+of\s+the\s+beam\)/i.exec(t);
  return m ? m[0] : null;
}
/* the question tells him to ADD the beam's own weight (or says the load does not hold it) */
function addSelf(t) {
  var ms = selfMentions(t), i, m;
  for (i = 0; i < ms.length; i++) if (ms[i].kind === 'add' || ms[i].kind === 'not') return ms[i].from;
  m = /\b(?:add|account\s+for|allow\s+for|consider)\s+(?:the\s+)?(?:beam'?s?\s+)?(?:own\s+|self[- ]?)weight\b/i.exec(t);
  return m ? m[0] : null;
}
function neglectSelf(t) {
  var m = /(?:neglect|ignore|disregard|not\s+include|do\s+not\s+include|self[- ]weights?\s+(?:are\s+)?not\s+(?:included|considered))[^.;]{0,40}(?:weight|self)/i.exec(t);
  if (!m) m = /beam\s+self[- ]weights?\s+(?:are\s+)?not\s+included/i.exec(t);
  /* 0.6 (review 4): more ways of saying the steel's own weight is not to be added: "this includes the weight of the framing", "the beam weight is
     negligible", "may be ignored", "is not considered", "without the self-weight", "excluding beam self-weight", "already included in the ... dead load"
     (the worksheet added the weight of the beam it picked: 173.25 printed for 169.2) */
  /* ("this INCLUDES the weight of the framing" only: her own sentence "(Include the self-weight of the beam in your calculation.)" means ADD it) */
  if (!m) m = /\b(?:this|which|that)\s+(?:already\s+)?includes\s+(?:the\s+)?(?:self[- ]?)?weight\s+of\s+(?:the\s+)?(?:steel\s+)?(?:framing|beams?|steel|members?)\b|\b(?:beam|member|steel|framing)(?:'s)?\s+(?:self[- ]?)?weights?\s+(?:is|are|may\s+be|can\s+be|should\s+be)\s+(?:negligible|neglected|ignored|disregarded|not\s+considered|already\s+included|included\s+in)|\b(?:self[- ]?weight|own\s+weight|weight\s+of\s+the\s+(?:steel\s+)?(?:beams?|framing|steel|members?))\s+(?:is|are|may\s+be|can\s+be|should\s+be)\s+(?:negligible|neglected|ignored|disregarded|not\s+considered|already\s+included|included\s+in)|\b(?:without|excluding|exclusive\s+of)\s+(?:the\s+)?(?:beam(?:'s)?\s+)?(?:self[- ]?weight|own\s+weight)|\bdead\s+load\b[^.;]{0,24}?\bincluding\s+(?:the\s+)?(?:beam|framing|steel|member)s?(?:'s)?\s+(?:self[- ]?)?weights?\b/i.exec(t);
  return m ? m[0] : null;
}

function pointLoads(F) {
  // positions "at 8 ft and 16 ft", "one 10 ft and one 20 ft from the left support"
  var t = F.t, out = { positions: [], from: null, fromFree: false };
  var TRIG = /concentrated|point\s+loads?|frame\s+into|delivers?|(?:two|three|four|\d+)\s+(?:(?:equal|service|live|dead|factored|concentrated|point)\s+)*loads\b|\bloads?\s+P\b|hangs?\s+from|hung\s+from|suspended\s+from|rests?\s+on\s+the\s+(?:beam|girder)|\bloads?\s+of\s+\d[^.;]{0,20}\beach\b|\d\s*-?\s*(?:kips?|k)\s+loads?\s+at\s+\d/i;   /* 0.5: "two service live loads of 5 k each"; 0.8: "factored 20-k loads at 6, 12 and 18 ft" */
  if (!TRIG.test(t)) return out;
  named(out);
  if (out.positions.length) return out;
  /* 0.5: a load placed by NAME, not by a distance: "at mid-span", "at the third points", "at the quarter points".  The span turns the name into feet.
     Read from the sentence that speaks of the load; a distance written in feet (below) is used only when no name is there. */
  function named(o) {
    var span = F.lengths && (F.lengths.span || F.lengths.length), mt = TRIG.exec(t), a, b, sen, k, re0 = /\.(?=\s+[A-Z(]|\s*$)/g, mm;
    if (!span || !mt) return;
    a = 0; b = t.length;
    while ((mm = re0.exec(t)) !== null) { if (mm.index < mt.index) a = mm.index + 1; else { b = mm.index + 1; break; } }
    sen = t.slice(a, b);
    if (new RegExp('(?:\\bat\\b|,|\\band\\b)\\s*' + N + '\\s*-?\\s*(?:ft|feet|foot|\')\\s+from\\s+(?:the\\s+)?(?:left|right|free|fixed|wall|each)', 'i').test(sen) && !/third|quarter|mid/i.test(sen)) return;
    if ((k = /\bmid-?\s?span\b|\bat\s+(?:the|its)\s+(?:center|centre|middle|mid-?point)\b|\bat\s+(?:center|centre)\b|\bcent(?:er|re)(?:ed)?\s+(?:on|of)\s+the\s+(?:span|beam|girder)\b/i.exec(sen))) { o.positions = [round6(span.value / 2)]; o.rule = 'mid-span = L/2 = ' + round6(span.value / 2) + ' ft'; }
    else if ((k = /\b(?:one[- ])?third[- ]points?\b/i.exec(sen))) { o.positions = [round6(span.value / 3), round6(2 * span.value / 3)]; o.rule = 'third points = L/3 and 2L/3 = ' + o.positions.join(' and ') + ' ft'; }
    else if ((k = /\bquarter[- ]points?\b/i.exec(sen))) { o.positions = [round6(span.value / 4), round6(span.value / 2), round6(3 * span.value / 4)]; o.rule = 'quarter points = L/4, L/2, 3L/4 = ' + o.positions.join(', ') + ' ft'; }
    if (k) { o.from = k[0]; o.named = true; }
  }
  var re = new RegExp('(?:\\bat\\b|\\bone\\b|\\band\\b|,)\\s*(' + N + ')\\s*(?:-|\\s)*(?:ft|feet|foot|\')\\s*(?:(?:from)\\s+(?:the\\s+)?(left|right|free|fixed|wall)[^.,;]{0,25})?', 'gi'), m, parts = [];
  /* 0.6 (review 4): "two point loads of 30 kips each, 8 ft from EACH support": one load at 8 ft and one at L - 8 ft (one of the two was dropped before) */
  var mEach = new RegExp('(' + N + ')\\s*(?:-|\\s)*(?:ft|feet|foot|\')\\s+(?:in\\s+)?from\\s+(?:each|either|both)\\s+(?:support|end|reaction)s?\\b', 'i').exec(t), spE = F.lengths && (F.lengths.span || F.lengths.length);
  if (mEach && spE && !/\bcantilever/i.test(t)) {
    var vE = parseNum(mEach[1]);
    if (vE > 0 && vE < spE.value / 2) { out.positions = [vE, round6(spE.value - vE)]; out.from = mEach[0]; out.rule = vE + ' ft from each support = ' + vE + ' ft and L - ' + vE + ' = ' + round6(spE.value - vE) + ' ft'; return out; }
  }
  var zone = /(?:concentrated|point\s+loads?|frame\s+into|delivers?|two\s+(?:equal\s+)?loads|\bloads?\s+P\b|\d\s*-?\s*(?:kips?|k)\s+loads?\s+at\s+\d)[^.]*\./i.exec(t);
  var seg = zone ? zone[0] : '';
  var re2 = new RegExp('(?:\\bat\\b|\\bone\\b|\\band\\b|\\bone\\s+at\\b|,)\\s*(' + N + ')\\s*(?:-|\\s)*(?:ft|feet|foot|\')(?![A-Za-z])', 'gi');
  // sentence containing "from the left support" / "from the free end"
  var sent = /[^.]*\b(?:from\s+the\s+(?:left|right|free|fixed|wall)\b)[^.]*\./i.exec(t);
  var area = sent ? sent[0] : seg;
  if (!area) return out;
  /* 0.5: a list of distances that shares ONE unit at its end: "at 5, 10 and 15 ft", "at 8 and 16 ft" (the old pattern kept only the last one) */
  var reList = new RegExp('\\bat\\s+((?:' + N + '\\s*(?:ft|feet|foot|\')?\\s*(?:,\\s*and\\s+|,\\s*|\\s+and\\s+|\\s*&\\s*))+' + N + ')\\s*(?:-|\\s)*(?:ft|feet|foot|\')(?![A-Za-z])', 'i'), ml = reList.exec(area);
  /* 0.6 (review 4): the same list with no "at": "located 8 ft and 16 ft from the left support" (only the 16 was kept: Mu 160 printed for 240) */
  if (!ml) ml = new RegExp('\\b(?:located|placed|applied|acting|positioned|situated|act)\\s+(?:at\\s+)?((?:' + N + '\\s*(?:-|\\s)*(?:ft|feet|foot|\')?\\s*(?:,\\s*and\\s+|,\\s*|\\s+and\\s+|\\s*&\\s*))+' + N + ')\\s*(?:-|\\s)*(?:ft|feet|foot|\')(?![A-Za-z])', 'i').exec(area);
  if (ml) (ml[1].match(new RegExp(N, 'g')) || []).forEach(function (x) { parts.push({ value: parseNum(x), idx: ml.index }); });
  else while ((m = re2.exec(area)) !== null) parts.push({ value: parseNum(m[1]), idx: m.index });
  /* 0.5: the distance however it is introduced: "located 20 ft from the left support", "placed 6 ft from the right end", "acting 8 ft from the wall".
     On a simple span a distance from the RIGHT support is turned into the distance from the left (x = L - distance). */
  if (!parts.length) {
    var reFrom = new RegExp('(' + N + ')\\s*(?:-|\\s)*(?:ft|feet|foot|\')\\s+(?:measured\\s+)?from\\s+(?:the\\s+|its\\s+)?(left|right|free|fixed|wall)', 'gi'), sp0 = F.lengths && (F.lengths.span || F.lengths.length), v0;
    while ((m = reFrom.exec(area)) !== null) {
      v0 = parseNum(m[1]);
      if (/^right$/i.test(m[2]) && !/\bcantilever/i.test(t)) { if (!sp0) continue; v0 = round6(sp0.value - v0); out.rule = 'measured from the right support: x = L - ' + parseNum(m[1]) + ' = ' + v0 + ' ft from the left'; }
      parts.push({ value: v0, idx: m.index });
    }
  }
  out.positions = parts.map(function (p) { return p.value; });
  out.from = area.replace(/^\s+/, '');
  out.fromFree = /from\s+the\s+free/i.test(area);
  out.fromWall = /from\s+the\s+(?:wall|fixed)/i.test(area);
  return out;
}

function beamAnalysisFields(F, B, D, prefix, hoist) {
  // fills span/support/loads. Returns the object; when hoist is false the fields are collected into obj (for beam_select analysis)
  var t = F.t, obj = {}, froms = [];
  function put(name, value, from, conf, rule) { if (hoist) B.set(name, value, from, conf, rule); else { obj[name] = value; froms.push(from); } }
  var sp = F.lengths.span || F.lengths.length;
  var spanItem = F.lengths.span;
  if (!spanItem && F.lengths.items.length) { F.lengths.items.forEach(function (it) { if (!spanItem && (it.labels.indexOf('L') >= 0)) spanItem = it; }); }
  if (!spanItem && F.lengths.length) spanItem = F.lengths.length;
  if (!spanItem && F.lengths.combos.length === 1) spanItem = F.lengths.combos[0];
  if (spanItem) put('span_ft', spanItem.value, spanItem.from, 'high', spanItem.unit === 'in' ? 'in -> ft' : null);
  else B.ask('span', 'What is the span (ft)?', [hoist ? 'span_ft' : 'analysis'], null);
  var cant = /\bcantilever(?:ed)?\b/i.exec(t);
  if (cant) {
    put('support', 'cantilever', cant[0], 'high');
    var pl0 = pointLoads(F);
    if (pl0.positions.length) {
      if (pl0.fromFree) put('positions_from', 'free_end', pl0.from.slice(0, 60), 'high');
      else if (pl0.fromWall) put('positions_from', 'wall', pl0.from.slice(0, 60), 'high');
    }
  } else if (/simply\s+supported|simple\s+span|simple\s+beam/i.test(t)) put('support', 'simple', t.match(/simply\s+supported|simple\s+span|simple\s+beam/i)[0], 'high');
  var U = uniformLoads(F), basis = loadBasis(F, B, D), factored = basis === 'factored';
  if (U.wu) { put('already_factored', true, U.wu.from, 'high', 'wu is a factored load'); put('w_u', U.wu.value, U.wu.from, 'high', U.wu.rule); }
  else {
    if (U.wD) put('wD', U.wD.value, U.wD.from, 'high', U.wD.rule);
    if (U.wL) put('wL', U.wL.value, U.wL.from, 'high', U.wL.rule);
    if ((U.wD || U.wL) && basis === null) B.ask('loads_basis', 'Are these loads service loads or already factored?', ['already_factored', 'wD', 'wL', 'w_u'], ['service', 'already factored']);
    if ((U.wD || U.wL) && factored) B.ask('loads_basis', 'The text says the loads are factored: is the uniform load ALREADY factored (then give wu)?', ['already_factored', 'wD', 'wL', 'w_u'], ['already factored', 'service']);
  }
  var sw = selfWeight(F);
  if (sw) put('self_weight_plf', sw.value, sw.from, 'high');
  var inc = includesSelf(t), addIt = addSelf(t);
  if (inc && !addIt) put('w_includes_self_weight', true, inc, 'high');
  /* 0.6: told to add the beam's own weight, no weight given, but the beam is NAMED: a W21x44 weighs 44 lb/ft */
  if (addIt && !sw && !neglectSelf(t) && F.dshapes.length === 1) {
    var wm = /^(?:W|M|S|HP|C|MC)\s?\d+(?:\.\d+)?\s*x\s*(\d+(?:\.\d+)?)$/i.exec(String(F.dshapes[0].norm));
    if (wm) put('self_weight_plf', Number(wm[1]), addIt + ' ... ' + F.dshapes[0].raw, 'medium', 'the beam is named: its own weight is the second number of its name, in lb/ft');
  }
  // point loads
  var pl = pointLoads(F), pls = F.loads.filter(function (l) { return l.unit === 'k' && (l.kind === 'D' || l.kind === 'L' || l.kind === 'u'); });
  /* 0.6 (review 3): "a service live point load of 12 kips at midspan", "two equal factored point loads of 20 kips each": the KIND of the load stands in
     front of the words "point load", where the general load finder does not look (the page stopped: "12 kips is in no box") */
  if (pl.positions.length && !pls.length) {
    var mp1 = new RegExp('\\b((?:(?:equal|service|unfactored|working|factored|ultimate|live|dead|concentrated|point)\\s+){0,5})(?:point|concentrated)\\s+loads?\\s+(?:of\\s+)?(' + N + ')\\s*-?\\s*(?:kips?|k)(?![A-Za-z/])', 'i').exec(t);
    if (mp1) {
      var adj1 = mp1[1].toLowerCase(), kd1 = /\b(?:factored|ultimate)\b/.test(adj1) ? 'u' : (/\blive\b/.test(adj1) ? 'L' : (/\bdead\b/.test(adj1) ? 'D' : null));
      if (kd1) pls = [{ kind: kd1, unit: 'k', value: parseNum(mp1[2]), from: mp1[0].replace(/^\s+/, '') }];
    }
    /* 0.8: the number between the kind and the word: "factored 20-k loads at 6, 12 and 18 ft", "service live 5-kip point loads" */
    if (!pls.length) {
      var mp2 = new RegExp('\\b((?:(?:equal|service|unfactored|working|factored|ultimate|live|dead|concentrated|point)\\s+){1,5})(' + N + ')\\s*-?\\s*(?:kips?|k)\\s+((?:(?:equal|concentrated|point|service|factored|live|dead)\\s+){0,3})loads?\\b', 'i').exec(t);
      if (mp2) {
        var adj2 = (mp2[1] + ' ' + mp2[3]).toLowerCase(), kd2 = /\b(?:factored|ultimate)\b/.test(adj2) ? 'u' : (/\blive\b/.test(adj2) ? 'L' : (/\bdead\b/.test(adj2) ? 'D' : null));
        if (kd2) pls = [{ kind: kd2, unit: 'k', value: parseNum(mp2[2]), from: mp2[0].replace(/^\s+/, '') }];
      }
    }
  }
  /* 0.6 (review 4): the question COUNTS its point loads ("two factored point loads of 30 kips each") and the page found another number of places for
     them: a load is missing or misplaced, and the moment would be wrong (160 and 180 were printed for 240).  Nothing is worked out. */
  var cwP = /\b(two|three|four|five|2|3|4|5)\s+(?:(?:equal|identical|service|unfactored|working|factored|ultimate|live|dead)\s+){0,4}(?:(?:concentrated|point)\s+loads\b|loads\s+of\s+\d[^.;]{0,12}?\bk(?:ips?)?\b(?!\s*\/))/i.exec(t), CNP = { two: 2, three: 3, four: 4, five: 5 },
    wantP = cwP ? (CNP[cwP[1].toLowerCase()] || Number(cwP[1])) : 0;
  if (wantP && pl.positions.length !== wantP && !/\b(?:dead|live)\s+and\s+(?:dead|live)\b/i.test(cwP[0]))
    B.ask('point_load_count', 'Your question has ' + wantP + ' point loads ("' + cwP[0] + '") and the page found ' + (pl.positions.length ? 'only ' + pl.positions.length + ' place' + (pl.positions.length === 1 ? '' : 's') + ' for them (' + pl.positions.join(', ') + ' ft)' : 'no place for them') + '. It will not work the beam out with a load missing. NOT answered here: if you can, retype the sentence as "' + wantP + ' point loads of ... kips at A ft and B ft from the left support".', [], null, 'stop');
  if (pl.positions.length) {
    var Dv = null, Lv = null, Pv = null;
    pls.forEach(function (l) { if (l.kind === 'D' && Dv === null) Dv = l; else if (l.kind === 'L' && Lv === null) Lv = l; else if (l.kind === 'u' && Pv === null) Pv = l; });
    if (pls.length && pls.length <= 2 + 0 && (Dv || Lv || Pv) && pls.length === (Dv ? 1 : 0) + (Lv ? 1 : 0) + (Pv ? 1 : 0)) {
      var list = pl.positions.map(function (x) { var o = { x: x }; if (Dv) o.D = Dv.value; if (Lv) o.L = Lv.value; if (Pv) o.Pu = Pv.value; return o; });
      put('point_loads', list, pl.from.slice(0, 80) + ' ... ' + pls.map(function (l) { return l.from; }).join(', '), 'medium', (pl.rule ? pl.rule + '; ' : '') + (list.length > 1 ? 'same load at each position' : 'one load'));
    } else B.ask('point_loads', 'Point loads: give each load and its distance from the support (the text lists ' + pl.positions.join(', ') + ' ft).', [hoist ? 'point_loads' : 'analysis'], null);
  } else if (/concentrated|point\s+load/i.test(t)) B.ask('point_loads', 'Point loads: give each load and its distance from the support.', [hoist ? 'point_loads' : 'analysis'], null);
  if (!hoist) return { obj: obj, from: froms.filter(Boolean).join(' | ') };
  return null;
}

/* 0.6 (fresh exam 10/06): a moment given in WORDS: "a factored bending moment of 315 kip-ft", "an ultimate moment of 900 kip-ft", "a required
   flexural strength of 250 kip-ft".  Only beam_select read such words, and not with "bending" in them. */
function wordsMoment(t) {
  var mm = /(?:ultimate|factored|design|maximum|required)\s+(?:bending\s+|flexural\s+)?(?:moment|flexural\s+strength)\s+(?:strength\s+)?(?:Mu\s*)?(?:=|of|is)?\s*(\d+(?:\.\d+)?)\s*(kip-?\s?ft|k-ft|ft-?\s?kips?|kip-?\s?in|k-in)/i.exec(t), inch;
  if (!mm) return null;
  inch = /in/i.test(mm[2].slice(-2)) && !/ft/i.test(mm[2]);
  return { value: inch ? round6(Number(mm[1]) / 12) : Number(mm[1]), from: mm[0], rule: inch ? 'kip-in -> kip-ft' : null };
}
FILL.beam_analysis = function (F, B, D) { beamAnalysisFields(F, B, D, '', true); };
FILL.beam_capacity = function (F, B, D) {
  pickShape(F, B, 'shape', 'which_shape');
  fillFy(F, B, D, {});
  var mu = F.loads.filter(function (l) { return l.sym && /^M/.test(l.sym) && l.kind === 'u'; })[0], wm = wordsMoment(F.t);
  if (mu && mu.unit === 'kipft') B.set('Mu', mu.value, mu.from, 'high');
  else if (wm) B.set('Mu', wm.value, wm.from, 'high', wm.rule);
};
FILL.beam_required_zx = function (F, B, D) {
  var mu = F.loads.filter(function (l) { return l.sym && /^M/.test(l.sym) && l.kind === 'u'; })[0], wm = wordsMoment(F.t);
  if (mu) B.set('Mu', mu.unit === 'kipin' ? round6(mu.value / 12) : mu.value, mu.from, 'high', mu.unit === 'kipin' ? 'kip-in -> kip-ft' : null);
  else if (wm) B.set('Mu', wm.value, wm.from, 'high', wm.rule);
  else B.ask('mu', 'What is the factored moment Mu (kip-ft)?', ['Mu'], null);
  fillFy(F, B, D, {});
};
FILL.beam_select = function (F, B, D) {
  var t = F.t;
  var mu = F.loads.filter(function (l) { return l.sym && /^M/.test(l.sym) && l.kind === 'u'; })[0];
  var mm = /(?:ultimate|factored|design|maximum|required)\s+(?:bending\s+|flexural\s+)?(?:moment|flexural\s+strength)\s+(?:strength\s+)?(?:Mu\s*)?(?:=|of|is)?\s*(\d+(?:\.\d+)?)\s*(kip-?\s?ft|k-ft|kip-?\s?in|k-in)/i.exec(t);
  if (mu) B.set('Mu', mu.unit === 'kipin' ? round6(mu.value / 12) : mu.value, mu.from, 'high', mu.unit === 'kipin' ? 'kip-in -> kip-ft' : null);
  else if (mm) { var inch = /in/i.test(mm[2].slice(-2)) && !/ft/i.test(mm[2]); B.set('Mu', inch ? round6(Number(mm[1]) / 12) : Number(mm[1]), mm[0], 'high', inch ? 'kip-in -> kip-ft' : null); }
  else {
    var res = beamAnalysisFields(F, B, D, '', false);
    if (res && Object.keys(res.obj).length) B.set('analysis', res.obj, res.from, 'medium');
  }
  /* 0.6: a moment GIVEN, and the beam's own weight to be added to it: "Mu = 501.5 kip-ft, include the beam self-weight (span 38 ft)" */
  var swI = /\b(?:includ\w*|add(?:ing|ed)?|account\w*\s+for|allow\w*\s+for)\b[^.;]{0,40}?\b(?:self[\s-]?weight|own\s+weight|weight\s+of\s+the\s+beam|beam(?:'s)?\s+(?:own\s+)?weight)/i.exec(t);
  if ((mu || mm) && swI && !/\b(?:neglect|ignor|exclud|do\s+not\s+(?:add|include)|not\s+includ|already\s+includ|includes\s+(?:the\s+)?(?:beam\s+)?(?:self|own))/i.test(t)) {
    var spI = /\bspan\s*(?:of\s+|=\s*|is\s+|length\s+(?:of\s+|=\s*)?)?(\d+(?:\.\d+)?)\s*-?\s*(?:ft|feet|foot)\b/i.exec(t) || /(\d+(?:\.\d+)?)\s*-?\s*(?:ft|feet|foot)\s+(?:simple\s+)?span\b/i.exec(t);
    B.set('self_weight_recheck', true, swI[0], 'medium');
    if (spI) B.set('span_ft', Number(spI[1]), spI[0], 'medium');
    else B.ask('span_for_self_weight', 'Your question adds the beam\'s own weight to the given moment. What is the span (ft)?', ['span_ft'], null);
  }
  /* 0.6: loads given, and the question says to add the beam's own weight ("select the lightest W beam and include its self-weight in the design moment"):
     the selection is rechecked with the weight of the beam it picks.  (405 was printed where 411.75 is right.) */
  else if (!(mu || mm) && addSelf(t) && !neglectSelf(t)) B.set('self_weight_recheck', true, addSelf(t), 'medium', 'the question says to add the beam\'s own weight');
  // allowed depths: "must be a W16", "W16 only", "W16 (nominal depth 16 in)"
  var famSeen = {}, fam = F.families.filter(function (f) { if (f.kind !== 'W' || famSeen[f.norm]) return false; famSeen[f.norm] = 1; return true; });   /* 0.8: the same family named twice ("Lightest W16 that works, W16x____") is one family */
  var dm = /(?:must\s+be\s+(?:a\s+)?|only\s+|restricted\s+to\s+)(W\s?\d{1,2})\b|\b(W\s?\d{1,2})\s+only\b|nominal\s+depth\s+(?:of\s+)?(\d{1,2})\s*(?:in|inch)/i.exec(t);
  if (dm) { var dn = Number((dm[1] || dm[2] || '').replace(/[^0-9]/g, '') || dm[3]); if (dn) B.set('allowed_depths', [dn], dm[0], 'high'); }
  else if (fam.length === 1 && /\bbeam|girder|W\d/i.test(t) && /(?:select|lightest|economical)/i.test(t)) { B.set('allowed_depths', [Number(fam[0].norm.slice(1))], fam[0].raw, 'medium', 'a W family named in the question restricts the depth'); }
  /* 0.6 (review 3): "Use W12 or W14 shapes": several families named to choose from (the lightest shape of ANY depth was printed) */
  else if (fam.length >= 2 && /(?:select|lightest|economical|pick|choose)/i.test(t) && /\b(?:use|using|from|among|only|limited\s+to|restricted\s+to|either)\b/i.test(t)) {
    B.set('allowed_depths', fam.map(function (f) { return Number(f.norm.slice(1)); }), fam.map(function (f) { return f.raw; }).join(', '), 'medium', 'the W families named in the question restrict the depth');
  }
  var md = /(?:maximum|max\.?|not\s+(?:to\s+)?exceed(?:ing)?|no\s+deeper\s+than|depth\s+(?:limited|limit)\s+(?:to|of))\s*(?:depth\s+(?:of\s+)?)?(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in|inch)/i.exec(t);
  if (md && /depth|deep/i.test(md[0] + t.slice(md.index, md.index + 50))) B.set('max_depth_in', Number(md[1]), md[0], 'medium');
  else {
    /* 0.6: before, "depth no more than 16 in" was not read and a W24 was chosen where a W14 is right */
    var md2 = /\bdepth\b[^.;]{0,30}?\b(?:is|are|be|must\s+be)\s+(?:limited|restricted|held|kept)\s+to\s+(?:a\s+maximum\s+of\s+)?(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\b|inch)/i.exec(t)
      || /\bdepth\b[^.;]{0,30}?\b(?:must|may|can|should|shall)\s*(?:not|n't)\s+(?:exceed|be\s+(?:more|greater|deeper)\s+than)\s+(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\b|inch)/i.exec(t)
      || /\bdepth\s+(?:of\s+)?(?:no\s+more\s+than|not\s+more\s+than|at\s+most|up\s+to|less\s+than|under|<=?)\s*(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\b|inch)/i.exec(t)
      || /\b(?:no\s+more\s+than|not\s+more\s+than|at\s+most)\s*(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\.?|inch(?:es)?)\s+(?:deep|in\s+depth)/i.exec(t)
      || /\bdepth\s+(?:of\s+)?(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\.?|inch(?:es)?)\s+or\s+less\b/i.exec(t)
      /* 0.6 (review 3): five more ways of limiting the depth, each of which let a W21 through where a W10 is right */
      || /\b(?:cannot|can\s*not|can't|must\s+not|may\s+not|shall\s+not|should\s+not)\s+be\s+(?:deeper|more)\s+than\s+(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\b|inch)/i.exec(t)
      || /\b(?:headroom|head\s+room|clearance)\b[^.;]{0,40}?\bdepth\s+to\s+(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\b|inch)/i.exec(t)
      || /\bdepth\b[^.;]{0,30}?\b(?:not\s+(?:be\s+)?(?:greater|more|larger)\s+than|no\s+(?:greater|more|larger)\s+than)\s+(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\b|inch)/i.exec(t)
      || /\bdepth\s+(?:must|shall|should|is\s+to)\s+be\s+(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\.?|inch(?:es)?)\s+or\s+less\b/i.exec(t)
      || /\bfits?\s+(?:with)?in\s+(?:a\s+|an\s+)?(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\.?|inch(?:es)?)\s*-?\s*deep\b/i.exec(t);
    /* a limit on the NOMINAL depth ("the nominal depth must be 12 in. or less") allows every family up to that one: W12X58 is 12.2 in deep and is a W12 */
    if (md2 && /\bnominal\s+depth\b/i.test(t.slice(Math.max(0, md2.index - 20), md2.index + md2[0].length))) {
      var NOMS = [4, 5, 6, 8, 10, 12, 14, 16, 18, 21, 24, 27, 30, 33, 36, 40, 44], lim = Number(md2[1]);
      B.set('allowed_depths', NOMS.filter(function (x) { return x <= lim; }), md2[0], 'medium', 'nominal depth limit: every W family up to W' + lim);
    }
    else if (md2) B.set('max_depth_in', Number(md2[1]), md2[0], 'medium');
  }
  fillFy(F, B, D, {});
};
FILL.beam_max_live_load = function (F, B, D) {
  pickShape(F, B, 'shape', 'which_shape');
  var sp = F.lengths.span || F.lengths.length;
  if (sp) B.set('span_ft', sp.value, sp.from, 'high', sp.unit === 'in' ? 'in -> ft' : null); else B.ask('span', 'What is the beam span (ft)?', ['span_ft'], null);
  floorBits(F, B, D, { span: false, prefix: '', maxLive: true });
  fillFy(F, B, D, {});
  /* 0.6 (review 4): "The weight of the beam must also be considered" (the live load was printed without the beam's weight: 214.1 for 209.8) */
  var neg = neglectSelf(F.t), inc = /(?:include|including|add|consider)\s+(?:the\s+)?(?:beam'?s?\s+)?(?:own\s+)?(?:self[- ])?weight/i.exec(F.t)
    || /\b(?:self[- ]?weight|own\s+weight|weight\s+of\s+the\s+beam|beam(?:'s)?\s+(?:own\s+|self[- ]?)?weight)\s+(?:must|should|shall|is\s+to|needs?\s+to)\s+(?:also\s+)?be\s+(?:considered|included|added|accounted\s+for|taken\s+into\s+account)/i.exec(F.t), framing = B.has('framing_psf');
  if (neg) B.set('include_self_weight', false, neg, 'high');
  else if (inc) B.set('include_self_weight', true, inc[0], 'high');
  else if (framing) B.set('include_self_weight', false, 'a steel-framing allowance (psf) is given', 'medium', 'framing allowance replaces the beam weight');
  else B.ask('self_weight', "Should the beam's own weight be counted as dead load? (the text does not say)", ['include_self_weight'], ['yes, include it', 'no, ignore it']);
  if (F.lengths.spanConflict) B.ask('span_conflict', 'Two different spans appear (' + (F.lengths.span && F.lengths.span.from) + ' and ' + F.lengths.spanConflict.from + '). Which is the beam span?', ['span_ft'], [String(F.lengths.span.value), String(F.lengths.spanConflict.value)]);
};

/* ---- floor and loads */
function floorBits(F, B, D, o) {
  var t = F.t, pos = null, m;
  /* 0.8: the dead load given in psf AND said to be the slab's ("Dead load is 62.5 psf from a 5-inch slab"): the same weight said twice.  The psf goes in the
     dead-load box as it is printed and the slab box stays blank, so the slab is counted once.  Only when no other dead load in psf is in the text. */
  var dSlab = new RegExp('\\bdead\\s+load\\s+(?:is|of|=|:)\\s*(' + N + ')\\s*psf\\s+(?:from|for|due\\s+to)\\s+(?:the\\s+|an?\\s+)?(?:' + N + '\\s*-?\\s*(?:in\\.?|inch(?:es)?|")\\s*-?\\s*)?(?:thick\\s+)?(?:concrete\\s+)?slab\\b', 'i').exec(t);
  if (dSlab && !o.noSdl && F.loads.filter(function (l) { return l.unit === 'psf' && l.kind === 'D'; }).length === 1 && !/\bsuperimposed|\bceiling|\bmechanical|\bpartition|\bframing\b/i.test(t)) {
    B.set('superimposed_dead_psf', parseNum(dSlab[1]), dSlab[0], 'medium', 'the dead load is given in psf and the question says it is the slab\'s: the slab box stays blank (the slab is not counted twice)');
    B.qids.slab = true;
  }
  else if (F.slab) B.set(o.slabName || 'slab_thickness_in', F.slab.value, F.slab.from, 'high'); else if (!(o.optionalSlab)) B.ask('slab', 'What is the slab thickness (in)?', [o.slabName || 'slab_thickness_in'], null);
  // concrete weight
  m = /(\d{2,3})\s*(?:lb\s*\/\s*ft\s*\^?\s*3|pcf|lbs?\s*\/\s*cu\.?\s*ft)/i.exec(t);
  if (m) B.set('concrete_pcf', Number(m[1]), m[0], 'high');
  /* 0.6: "lightweight concrete" with no weight given is NOT the cover page's 150 pcf: the page asks */
  else if (/\blight[\s-]?weight\b/i.test(t)) B.ask('concrete_pcf', 'Your question says LIGHTWEIGHT concrete and gives no unit weight. What is it (lb/ft^3)? The cover page\'s 150 is for normal concrete.', ['concrete_pcf'], null);
  else if (D.concrete_pcf) B.set('concrete_pcf', D.concrete_pcf.value, D.concrete_pcf.from, 'default', 'exam default');
  // psf loads
  var live = null, live2 = null, sdl = null, frame = null;
  F.loads.forEach(function (l) {
    if (l.unit !== 'psf') return;
    if (l.kind === 'L') {
      /* the word must be in the load's OWN sentence: "... 25 psf for finishes and partitions. The floor live load is 80 psf" made the floor's live load a
         partition load, and the page stopped for a live load (fresh exam 10/06) */
      var lb = t.slice(Math.max(0, l.start - 25), l.start + 10), ld = lb.lastIndexOf('. ');
      if (l.qualifier === 'partition' || /partition|movable/i.test(ld >= 0 && ld < 25 ? lb.slice(ld + 1) : lb)) { if (!live2) live2 = l; }
      else if (!live) live = l;
    } else if (l.kind === 'D') { if (!sdl) sdl = l; }
  });
  /* 0.5: "movable partitions: 15 psf" is her SECOND LIVE load (she takes the larger of the two live loads), not a dead load */
  var mp = /\b(?:movable|moveable|demountable)\s+partitions?\b[^.;0-9]{0,40}?(\d+(?:\.\d+)?)\s*psf/i.exec(t) || /\bpartitions?\s*\(\s*(?:movable|moveable)\s*\)[^.;0-9]{0,20}?(\d+(?:\.\d+)?)\s*psf/i.exec(t);
  var tNoMp = mp ? t.slice(0, mp.index) + new Array(mp[0].length + 1).join(' ') + t.slice(mp.index + mp[0].length) : t;
  if (mp && !live2) live2 = { value: Number(mp[1]), from: mp[0] };
  var supD = /(?:partitions?|ceiling|mechanical|flooring|superimposed|additional\s+dead)[^.;]{0,60}?(?:totaling|totalling|of|=|:)?\s*(\d+(?:\.\d+)?)\s*psf/i.exec(tNoMp);
  if (supD && /\blive\b/i.test(supD[0])) supD = null;       // "partition live load = 15 psf" is a second LIVE load, not a dead load
  if (live) B.set(o.liveName || 'live_psf', live.value, live.from, 'high'); else if (!o.maxLive) B.ask('live', 'What is the live load (psf)?', [o.liveName || 'live_psf'], null);
  if (live2) B.set('live2_psf', live2.value, live2.from, 'high', 'partition live load: the LARGER of the two live loads is used');
  if (supD && !o.noSdl) B.set('superimposed_dead_psf', Number(supD[1]), supD[0], 'high');
  else if (sdl && sdl.qualifier !== null && /superimposed|additional|fixed/.test(sdl.qualifier)) B.set('superimposed_dead_psf', sdl.value, sdl.from, 'high');
  /* 0.5: "dead load 85 psf (includes self-weight)" and no slab thickness anywhere: the whole dead load is given, so it goes in the dead-load box (slab left blank) */
  else if (sdl && !F.slab && !o.noSdl) B.set('superimposed_dead_psf', sdl.value, sdl.from, 'medium', 'the dead load is given in psf and no slab thickness is given: the slab box stays blank');
  var fr = /(?:steel\s+)?framing[^.;)]{0,40}?(\d+(?:\.\d+)?)\s*psf/i.exec(t);
  /* (cloud, holdout C-28) the number after "framing" must be the framing's OWN weight.  "The floor dead load is 75 psf (including the weight of the
     framing) and the floor live load is 100 psf" took the LIVE load as a framing weight (D = 75 + 100 = 175 psf: wu 3.7, Mu 473.6, W24X55 printed clean;
     right 2.5, 320, W21X44); typed without the bracket ("dead 75psf including weight of framing live 100psf") the same.  Words of another load, or of
     "including", between the two never make it a framing weight; with lost full stops "framing plan ... dead load 75psf" neither. */
  if (fr && /\b(?:dead|live|loads?|includ\w*|plan|slab|floor|roof|partitions?|superimposed|snow|ceiling|mechanical)\b/i.test(fr[0].replace(/^(?:steel\s+)?framing/i, '').replace(/\d+(?:\.\d+)?\s*psf$/i, ''))) fr = null;
  /* 0.8: the number FIRST: "10 psf for framing", "8 psf of steel framing"; and a dead load named by what it is: "10 psf of roofing", "15 psf for ceiling
     and mechanical" (never when the words call it a live load) */
  if (!fr) fr = /(\d+(?:\.\d+)?)\s*psf\s+(?:of|for)\s+(?:the\s+)?(?:steel\s+)?(?:framing|beams\s+and\s+girders|structural\s+steel)\b/i.exec(t);
  if (fr) B.set('framing_psf', Number(fr[1]), fr[0], 'high');
  if (!B.has('superimposed_dead_psf') && !o.noSdl) {
    var sd2 = /(\d+(?:\.\d+)?)\s*psf\s+(?:of|for)\s+(?:the\s+)?(?:roofing|ceiling|mechanical|ductwork|flooring|floor\s+finish(?:es)?|finishes|insulation|MEP|fixed\s+partitions|topping|waterproofing)\b/i.exec(tNoMp);
    if (sd2 && !/\blive\b/i.test(t.slice(Math.max(0, sd2.index - 12), sd2.index + sd2[0].length + 12))) B.set('superimposed_dead_psf', Number(sd2[1]), sd2[0], 'high');
  }
  // position
  /* 0.6 (review 3): "a perimeter beam", "an exterior (edge) beam", "an exterior floor beam", "a beam at the edge of the slab / of the building",
     "only supports slab on one side": the interior line load, twice the right one, was printed for these */
  var edge = /\b(?:edge|exterior|spandrel|perimeter|boundary|outer(?:most)?|outside)\s+(?:floor\s+|steel\s+|\(\w+\)\s+)?(?:beam|girder|column)s?\b|beam\b[^.]{0,30}\balong\s+the\s+(?:left|right)?\s*edge|\b(?:at|on|along)\s+the\s+(?:edge|perimeter)\s+of\s+the\s+(?:floor|slab|building|bay|deck|structure|plan)\b|\bedge\s+of\s+the\s+floor|\b(?:slab|floor|deck)\s+on\s+(?:only\s+)?one\s+side\b|\bone\s+side\s+only\b|\bon\s+only\s+one\s+side\b/i.exec(t);
  var inter = /\b(?:interior|inner|typical)\s+(?:beam|girder)|every\s+beam\s+is\s+an\s+interior|is\s+an\s+interior\s+beam|\binterior\s+beam\b|\b(?:interior|inner)\s+members?\b|\bfloor\s+continues\s+on\s+(?:all|both)\s+sides\b|\b(?:interior|inner)\s+bays?\b/i.exec(t);   /* 0.5: "B1 and G1 are interior members", "the floor continues on all sides"; 0.8: "a typical interior bay" */
  var posName = o.posName || 'position';
  /* 0.6 (fresh exam 10/06): the beam's tributary WIDTH given outright ("over a tributary width of 6 ft"): no spacing and no position are needed */
  var twM = new RegExp('\\btributary\\s+width\\s*(?:of\\s+|is\\s+|=\\s*|:\\s*)?(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')(?![A-Za-z0-9])', 'i').exec(t);
  if (twM && !o.noPos) {
    B.set(posName === 'beam_position' ? 'beam_tributary_ft' : 'tributary_ft', parseNum(twM[1]), twM[0], 'high');
    B.set(posName, 'custom', twM[0], 'high', 'the tributary width is given: no spacing and no edge / interior choice are needed');
    B.qids.position = true; B.qids.spacing = true;
  }
  else if (edge && !inter) B.set(posName, 'edge', edge[0], 'high');
  else if (inter && !edge) B.set(posName, 'interior', inter[0], 'high');
  else if (!o.noPos) B.ask('position', 'Is this beam on the edge or interior of the floor?', [posName], ['interior', 'edge', 'custom (give the tributary width)']);
  var sp = F.lengths.spacing || null;
  if (!sp && F.lengths.slabSpan && !o.noSpacing) { sp = F.lengths.slabSpan; B.set(o.spacingName || 'spacing_ft', sp.value, sp.from, 'medium', 'slab span = beam spacing'); }
  else if (sp && !o.noSpacing) B.set(o.spacingName || 'spacing_ft', sp.value, sp.from, 'high');
  else if (!o.noSpacing && !o.noPos) { var each =/(\d+(?:\.\d+)?)\s*(?:ft|feet|\')\s+on\s+each\s+side/i.exec(t); if (each) B.set(o.spacingName || 'spacing_ft', Number(each[1]), each[0], 'medium', 'slab span on each side = spacing'); else B.ask('spacing', 'What is the beam spacing (ft)?', [o.spacingName || 'spacing_ft'], null); }
}
FILL.loads_floor = function (F, B, D) { floorBits(F, B, D, {}); };
FILL.floor_plan = function (F, B, D) {
  floorBits(F, B, D, { posName: 'beam_position', spacingName: 'beam_spacing_ft' });
  var t = F.t, sp = F.lengths.span || F.lengths.length, UF = '\\s*-?\\s*(?:ft|feet|foot|\')';
  /* 0.6: "Ignore the self-weight of the beam" switches the worksheet's own self-weight recheck off (it stayed on: 169.65 printed where 165.6 is right) */
  var negF = neglectSelf(t);
  if (negF) B.set('self_weight_recheck', false, negF, 'high');
  /* (cloud, holdout C-28) "The floor dead load is 75 psf (including the weight of the framing)": the steel is already IN the dead load, so the worksheet
     must not add each member's weight again (it did: Mu 326.76 printed where 320 is right).  "not including the framing" says the opposite: left alone. */
  var inclF = /\b(?:includ(?:es|ing|ed)?|incl\.)\s+(?:the\s+)?(?:(?:self[- ]?)?weights?\s+of\s+(?:the\s+)?)?(?:steel\s+)?(?:framing|beams\s+and\s+girders|structural\s+steel)\b|\b(?:steel\s+)?framing(?:\s+weight)?\s+(?:is\s+)?(?:already\s+)?included\b/i.exec(t);
  if (inclF && /\bnot\s+$|\bexcluding\s+$|\bwithout\s+$/i.test(t.slice(Math.max(0, inclF.index - 12), inclF.index))) inclF = null;
  if (inclF && !negF && !B.has('framing_psf')) B.set('self_weight_recheck', false, inclF[0], 'high', 'the dead load already includes the weight of the framing');
  /* 0.5: the beam's span and the girder's span are named apart: "the beams span 36 ft between girders ...; the girders span 27 ft between columns" */
  var gs = new RegExp('\\bgirders?\\b[^.;]{0,40}?\\bspan(?:s|ning)?\\s*(?:of\\s+|is\\s+|=\\s*)?(' + N + ')' + UF, 'i').exec(t) || new RegExp('(' + N + ')' + UF + '\\s*-?\\s*(?:long\\s+)?girders?\\b', 'i').exec(t)
    || new RegExp('\\bgirder\\s+span\\s*(?:of\\s+|is\\s+|=\\s*|:\\s*)?(' + N + ')' + UF, 'i').exec(t);
  var bs = new RegExp('\\bbeams?\\b[^.;]{0,40}?\\bspan(?:s|ning)?\\s*(?:of\\s+|is\\s+|=\\s*)?(' + N + ')' + UF, 'i').exec(t) || new RegExp('\\bbeam\\s+span\\s*(?:of\\s+|is\\s+|=\\s*|:\\s*)?(' + N + ')' + UF, 'i').exec(t);
  if (bs && !/girder/i.test(bs[0].replace(/between\s+(?:the\s+)?girders?/i, ''))) B.set('beam_span_ft', parseNum(bs[1]), bs[0], 'high');
  else if (sp && !(gs && Math.abs(parseNum(gs[1]) - sp.value) < 1e-9 && gs.index <= sp.start && sp.start < gs.index + gs[0].length)) B.set('beam_span_ft', sp.value, sp.from, 'medium');
  else B.ask('beam_span', 'What is the beam span (ft)?', ['beam_span_ft'], null);
  if (gs) B.set('girder_span_ft', parseNum(gs[1]), gs[0], 'high');
  /* 0.5: do beams load the girder from both sides (an interior girder) or from one side (a girder at the edge)?  It halves or doubles the girder's load, so when
     the girder is worked out and the words do not say, it is a QUESTION (the page makes the box required), never the usual value. */
  if (gs) {
    var gBoth = /\b(?:interior|inner)\s+(?:members?|girders?)\b|\bgirders?\b[^.;]{0,40}\binterior\b|\bfrom\s+(?:both|each|either)\s+sides?\b|\bon\s+both\s+sides\b|\bboth\s+sides\s+of\s+the\s+girder|\binto\s+(?:both|each|either)\s+sides?\b|\b(?:each|either)\s+side\s+of\s+(?:the\s+|a\s+|each\s+)?girder/i.exec(t);
    var gOne = /\b(?:edge|exterior|spandrel|perimeter)\s+girders?\b|\bgirders?\b[^.;]{0,40}\b(?:edge|exterior|spandrel|perimeter)\b|\bfrom\s+one\s+side\b|\bon\s+one\s+side\s+only\b/i.exec(t);
    if (gOne && !gBoth) B.set('girder_beam_sides', 'one', gOne[0], 'high');
    else if (gBoth && !gOne) B.set('girder_beam_sides', 'both', gBoth[0], 'high');
    else B.ask('girder_sides', 'Do beams frame into the girder from BOTH sides (an interior girder) or from ONE side (a girder at the edge of the floor)?', ['girder_beam_sides'], ['both', 'one']);
  }
  /* 0.5: a beam or a girder whose shape is GIVEN (the worksheet then checks that shape instead of choosing one) */
  var SHP = '(W\\s?\\d{1,2}\\s?x\\s?\\d+(?:\\.\\d+)?)', bsh = new RegExp('\\b' + SHP + '\\s+(?:(?:floor|steel|interior|typical|edge)\\s+)*beams?\\b|\\bbeams?\\s+(?:are|is|:)\\s+(?:an?\\s+)?' + SHP, 'i').exec(t),
    gsh = new RegExp('\\b' + SHP + '\\s+(?:(?:steel|interior|typical|edge)\\s+)*girders?\\b|\\bgirders?\\s+(?:are|is|:)\\s+(?:an?\\s+)?' + SHP, 'i').exec(t);
  if (bsh) B.set('beam_shape', (bsh[1] || bsh[2]).replace(/\s+/g, '').replace(/X/, 'x'), bsh[0], 'medium', 'the beam is given: it is checked, not chosen');
  if (gsh) B.set('girder_shape', (gsh[1] || gsh[2]).replace(/\s+/g, '').replace(/X/, 'x'), gsh[0], 'medium', 'the girder is given: it is checked, not chosen');
  var flat = /\bflat\s+ceiling\b[^.;]{0,80}|\bgirders?\b[^.;]{0,40}?\bsame\s+(?:nominal\s+)?depth\s+as\s+the\s+beams?|\bsame\s+(?:nominal\s+)?depth\s+as\s+the\s+beams?/i.exec(t);
  if (flat) B.set('girder_same_depth_as_beam', true, flat[0].slice(0, 80), 'high');
  /* 0.6 (review 4): the beam or the girder limited to ONE W family, or to a depth ("Select the lightest W16 for an interior beam", "the girder must be a
     W24 and the beam a W18", "the beam depth cannot exceed 12 inches").  The worksheet has boxes for both and the reader never filled them: the lightest
     shape of ANY depth was printed (W14X30 into a "W16 x ____" blank).  The member is taken from the words right beside the family, never guessed. */
  var famRe = /\bW\s?(\d{1,2})\b(?!\s*[xX]\s*[\d_])/g, fm2, cB, cA, wB, wA, who;
  while ((fm2 = famRe.exec(t)) !== null) {
    cB = t.slice(Math.max(0, fm2.index - 44), fm2.index); cA = t.slice(fm2.index + fm2[0].length, fm2.index + fm2[0].length + 48);
    wB = /\b(beam|girder)s?\s+(?:(?:must\s+be|shall\s+be|should\s+be|is\s+to\s+be|is|are|to\s+be|as)\s+)?(?:an?\s+|the\s+lightest\s+)?$/i.exec(cB);
    wA = /^\s*(?:(?:shapes?|sections?|members?)\s+)?(?:for\s+(?:the|an?|each|every)\s+)?(?:(?:interior|edge|typical|floor|steel|exterior)\s+)*(beam|girder)s?\b/i.exec(cA);
    who = wB ? wB[1].toLowerCase() : (wA ? wA[1].toLowerCase() : null);
    if (who === 'beam' && !B.has('beam_allowed_depths')) B.set('beam_allowed_depths', [Number(fm2[1])], (cB.slice(-20) + fm2[0] + cA.slice(0, 24)).replace(/^\s+|\s+$/g, ''), 'medium', 'the beam is limited to the W' + fm2[1] + ' family');
    else if (who === 'girder' && !B.has('girder_allowed_depths')) B.set('girder_allowed_depths', [Number(fm2[1])], (cB.slice(-20) + fm2[0] + cA.slice(0, 24)).replace(/^\s+|\s+$/g, ''), 'medium', 'the girder is limited to the W' + fm2[1] + ' family');
  }
  var fd = /\b(beam|girder)s?\s+depths?\b[^.;]{0,40}?(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\b|inch)|\b(beam|girder)s?\b[^.;]{0,30}?\b(?:deeper|more)\s+than\s+(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)*(?:in\b|inch)/i.exec(t);
  if (fd && !/\b(?:at\s+least|minimum|no\s+less\s+than|not\s+less\s+than)\b/i.test(fd[0])) {
    var fdWho = (fd[1] || fd[3]).toLowerCase(), fdN = Number(fd[2] || fd[4]);
    if (fdN >= 4 && fdN <= 44) B.set(fdWho + '_max_depth_in', fdN, fd[0], 'medium', 'a limit on the ' + fdWho + '\'s actual depth');
  }
  var sw = selfWeight(F);
  if (sw) B.ask('self_weight', 'A beam self-weight of ' + sw.value + ' lb/ft is given; this form takes framing in psf. Chain loads_floor then beam_analysis (self_weight_plf), or give the framing in psf.', ['framing_psf'], null, 'info');
};
FILL.loads_takedown = function (F, B, D) {
  var t = F.t, m;
  m = new RegExp('(' + N + ')\\s*(?:sq\\.?\\s*ft|square\\s+(?:feet|foot)|ft\\s?\\^?2|sf)\\b', 'i').exec(t);
  if (m) B.set('tributary_area_sf', parseNum(m[1]), m[0], 'high');
  else {
    /* 0.6 (review 4): "An INTERIOR column in a building with 20 ft by 30 ft bays": the tributary area of an interior column is one bay.  Only when the
       question says interior: an edge or a corner column carries half or a quarter of a bay, and that is not guessed. */
    var bay = new RegExp('(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')?\\s*(?:by|x)\\s*(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')\\s*-?\\s*bays?\\b|\\bbays?\\s+(?:of|are|is|measur\\w+)?\\s*(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')?\\s*(?:by|x)\\s*(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')', 'i').exec(t);
    /* 0.8: the tributary area given by its two sides: "tributary area 20 ft by 30 ft" (the product is the calculator's own first step) */
    var tab = new RegExp('\\btributary\\s+area\\s*(?:of|is|=|:)?\\s*(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')?\\s*(?:by|x)\\s*(' + N + ')\\s*-?\\s*(?:ft|feet|foot|\')(?![A-Za-z])', 'i').exec(t);
    if (tab) {
      B.set('bay_x_ft', parseNum(tab[1]), tab[0], 'high', 'the tributary area is given by its two sides');
      B.set('bay_y_ft', parseNum(tab[2]), tab[0], 'high', 'the tributary area is given by its two sides');
    }
    else if (bay && /\b(?:interior|typical\s+interior)\s+column\b/i.test(t) && !/\b(?:edge|corner|exterior|perimeter)\s+column\b/i.test(t)) {
      B.set('bay_x_ft', parseNum(bay[1] || bay[3]), bay[0], 'medium', 'an interior column: tributary area = one bay');
      B.set('bay_y_ft', parseNum(bay[2] || bay[4]), bay[0], 'medium', 'an interior column: tributary area = one bay');
    }
    else B.ask('trib_area', 'What is the tributary area of the column (sq ft)?', ['tributary_area_sf'], null);
  }
  if (F.floorsN) B.set('floors', F.floorsN.value, F.floorsN.from, 'high');
  else B.ask('floors', 'How many floors does the column carry below the roof?', ['floors'], null);
  /* 0.6 (fresh exams 10/06): the ROOF has its own loads, said in its own sentence ("Roof service loads are 25 psf dead and 20 psf live. Each floor has
     service loads of 100 psf dead and 80 psf live.").  Before, the first dead and the first live load of the text went into the FLOOR boxes whichever level
     they were said for, and the roof boxes were never filled.  A load is the roof's when its own sentence speaks of the roof and not of a floor. */
  var d = null, l = null, rd = null, rl = null, cuts = [0], cm, cre = /[.;!?]\s+(?=[A-Z(])/g;
  while ((cm = cre.exec(t)) !== null) cuts.push(cm.index + 1);
  cuts.push(t.length);
  function senAt(pos) { var q; for (q = 0; q + 1 < cuts.length; q++) if (pos >= cuts[q] && pos < cuts[q + 1]) return t.slice(cuts[q], cuts[q + 1]); return t; }
  function isRoof(x) { var s = senAt(typeof x.start === 'number' ? x.start : t.indexOf(x.from)); return /\broof\b/i.test(s) && !/\b(?:floors?|stor(?:y|ies|eys?))\b/i.test(s.replace(/\broof\s+(?:floor|level)\b/gi, ' ')); }
  F.loads.forEach(function (x) {
    if (x.unit !== 'psf') return;
    if (isRoof(x)) { if (x.kind === 'D' && !rd) rd = x; else if ((x.kind === 'L' || x.kind === 'Lr') && !rl) rl = x; }
    else { if (x.kind === 'D' && !d) d = x; if (x.kind === 'L' && !l) l = x; }
  });
  if (d) B.set('floor_D_psf', d.value, d.from, 'high'); if (l) B.set('floor_L_psf', l.value, l.from, 'high');
  if (!d && !l) B.ask('floor_loads', 'What are the floor dead and live loads (psf)?', ['floor_D_psf', 'floor_L_psf'], null);
  if (rd) B.set('roof_D_psf', rd.value, rd.from, 'high', 'said in the sentence about the roof');
  if (rl) B.set('roof_L_psf', rl.value, rl.from, 'high', 'said in the sentence about the roof (roof live load is factored 1.6 like floor live load)');
  /* a roof in the words and no roof load read: the calculator would leave the roof out.  The two boxes are asked (0 and 0 = the column carries no roof) */
  if (/\broof\b/i.test(t) && !rd && !rl) B.ask('roof', 'Your question has a ROOF and the page did not read its loads. Type the roof\'s dead load and live load in psf (the same numbers as a floor when your question says every level carries the same loads; 0 and 0 when the column carries no roof).', ['roof_D_psf', 'roof_L_psf'], null, 'need');
  else if (/\broof\b/i.test(t) && (!rd || !rl)) B.ask('roof', 'Your question has a ROOF and the page read only one of its two loads. Type the other one in psf (0 if there is none).', [rd ? 'roof_L_psf' : 'roof_D_psf'], null, 'need');
  if (F.slab) B.set('floor_slab_in', F.slab.value, F.slab.from, 'medium');
};
FILL.loads_factored = function (F, B, D) {
  var d = null, l = null, any = null;
  F.loads.forEach(function (x) { if (x.kind === 'D' && !d) d = x; if (x.kind === 'L' && !l) l = x; });
  var basis = loadBasis(F, B, D);
  if (d) B.set('D', d.value, d.from, 'high'); if (l) B.set('L', l.value, l.from, 'high');
  var u = F.loads.filter(function (x) { return x.kind === 'u'; })[0];
  if (u) { B.set('already_factored', true, u.from, 'high'); B.set('factored_value', u.value, u.from, 'high'); }
  var unit = (d || l || u || {}).unit; if (unit) B.set('unit', unit === 'klf' ? 'k/ft' : unit === 'k' ? 'kips' : unit, (d || l || u).from, 'medium');
  if (!d && !l && !u) B.ask('loads', 'What are the dead and live loads?', ['D', 'L'], null);
  var sw = selfWeight(F);
  if (sw) B.ask('self_weight', 'A self-weight is mentioned; enter it in the self-weight box in the same unit as D.', ['self_weight'], null, 'info');
};
FILL.loads_combinations = function (F, B, D) {
  var map = { D: 'D', L: 'L', Lr: 'Lr', S: 'S', R: 'R', W: 'W', E: 'E', Wrev: 'W_reverse', Erev: 'E_reverse' };       /* 0.8: "tensile wind = 100 k" is the reverse value */
  F.loads.forEach(function (x) { if (map[x.kind] && x.kind !== 'u') B.set(map[x.kind], x.value, x.from, 'high'); });
  var u = F.loads.filter(function (x) { return x.unit; })[0];
  if (u) B.set('unit', u.unit === 'klf' ? 'k/ft' : u.unit === 'k' ? 'kips' : u.unit, u.from, 'medium');
  if (!B.fields.length) B.ask('loads', 'Which loads are given (D, L, Lr, S, R, W, E)?', ['D', 'L'], null);
  if (B.has('W') || B.has('E')) B.ask('uplift', 'Is there a reverse (uplift / tension) value of the wind or earthquake load? Enter it as a positive number, or leave empty.', ['W_reverse', 'E_reverse'], null);
};
FILL.loads_max_service = function (F, B, D) {
  var m = new RegExp('(?:phi\\s*_?\\s*[PMR]n|f\\s*[PMR]n|design\\s+strength|capacity)\\s*(?:=|of|is)?\\s*(' + N + ')\\s*(kips?|k|kip-?\\s?ft|k-ft)', 'i').exec(F.t);
  if (m) B.set('phiRn', parseNum(m[1]), m[0], 'high'); else B.ask('phiRn', 'What is the design strength phi Rn (phi included)?', ['phiRn'], null);
  var d = F.loads.filter(function (x) { return x.kind === 'D'; })[0];
  if (d) B.set('D', d.value, d.from, 'high'); else B.ask('D', 'What is the service dead load D (type 0 if none)?', ['D'], null);
};
FILL.lookup_shape = function (F, B, D) {
  if (F.dshapes.length === 1) B.set('shape', F.dshapes[0].norm, F.dshapes[0].raw, 'high');
  else if (F.dshapes.length > 1) B.ask('which_shape', 'More than one shape is named. Which one?', ['shape'], F.dshapes.map(function (s) { return s.norm; }));
  else B.ask('which_shape', 'Which shape?', ['shape'], null);
  var p = F.property;
  if (p && p.name) B.set('property', p.name, p.from, 'high', p.axis ? ('axis: ' + p.axis) : null);
  else if (p && p.axisAmbiguous) B.ask('which_axis', 'About which axis (strong x, or weak y)?', ['property'], ['x (strong)', 'y (weak)']);
  else B.set('property', 'all', 'no single property named', 'default');
};
FILL.lookup_by_property = function (F, B, D) {
  var m = /(?:with|having|whose)\s+(?:an?\s+|the\s+)?(?:\w+\s+){0,3}?(I[xy]|Z[xy]|S[xy]|A|r[xy]|d)\s+(?:of\s+)?(?:at\s+least|greater\s+than|no\s+less\s+than|minimum|>=)\s*(?:of\s+)?(\d+(?:\.\d+)?)/i.exec(F.t);
  /* 0.5: the May 2024 final's wording: "the required Ix for a beam is 3000 in4", "required Zx = 150 in3", "Ix required is 1,200 in^4" */
  if (!m) m = /\b(?:required|needed|minimum|necessary)\s+(?:value\s+of\s+)?(I[xy]|Z[xy]|S[xy]|r[xy])\b[^.;0-9]{0,40}?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/i.exec(F.t);
  if (!m) m = /\b(I[xy]|Z[xy]|S[xy]|r[xy])\s+(?:required|needed|req'?d)\b[^.;0-9]{0,30}?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/i.exec(F.t);
  if (m) { B.set('property', m[1].charAt(0).toUpperCase() + m[1].slice(1), m[0], 'high'); B.set('minimum', parseNum(m[2]), m[0], 'high'); }
  else B.ask('prop', 'Which property, and what minimum value?', ['property', 'minimum'], null);
  var wf = F.families.filter(function (f) { return f.kind === 'W'; });
  if (wf.length >= 2 && wf.length === F.families.length) { B.set('family', 'W', wf.map(function (f) { return f.raw; }).join(' and '), 'medium', 'several W depths named: family W restricted to those depths'); B.set('nominal_depths', wf.map(function (f) { return Number(f.norm.slice(1)); }), wf.map(function (f) { return f.raw; }).join(' and '), 'medium'); }
  else pickFamily(F, B, 'family', false);
};
FILL.lookup_material = function (F, B, D) {
  if (F.dshapes.length === 1) B.set('what', F.dshapes[0].norm, F.dshapes[0].raw, 'high');
  else { var w = /\b(plate|pipe|HSS|angle|channel|wide[- ]flange)\b/i.exec(F.t); if (w) B.set('what', w[1], w[0], 'medium'); else B.ask('what', 'Which shape or type?', ['what'], null); }
};
FILL.lookup_hole = function (F, B, D) {
  if (F.bolt) B.set('bolt_dia_in', F.bolt.value, F.bolt.from, 'high'); else { var m = new RegExp('(' + N + ')\\s*-?\\s*(?:in\\.?|inch(?:es)?|")', 'i').exec(F.t); if (m) B.set('bolt_dia_in', dimValue(m[1]), m[0], 'medium'); else B.ask('bolt', 'What is the bolt diameter?', ['bolt_dia_in'], null); }
};
FILL.units = function (F, B, D) { B.ask('units_what', 'Which conversion, and what value?', ['conversion', 'value'], null); };
FILL.lookup_definition = function (F, B, D) {
  var t = F.t, m = /(?:^|\n)\s*(?:\d+\)\s*)?([^\n]*?)(?:,?\s*(?:is|are)\s+called\s*:?|\bcalled\s*:|is\s+defined\s+as|\bis\s+known\s+as)/i.exec(t);
  var q = m ? m[1] : null;
  if (!q) { var d = /(?:what\s+is\s+(?:the\s+)?(?:term\s+for\s+|meaning\s+of\s+|definition\s+of\s+)?)([^?\n]+)/i.exec(t); if (d) q = d[1]; }
  if (q) {
    q = q.replace(/^\s*(?:the\s+)?/i, '').replace(/\s+/g, ' ').replace(/\s*,\s*without\b/i, ' without').replace(/[,;:]+\s*$/, '');
    B.set('query', q, q, 'medium', 'the question text without its lead-in');
  } else {
    var whole = t.replace(/^\s*\(?[a-h]\)\s*/i, '').replace(/^\s*word\s+question\s*(?:\([^)]*\))?\s*\.?\s*/i, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (whole.length >= 8) B.set('query', whole.slice(0, 220), whole.slice(0, 220), 'medium', 'the whole question, as typed');
    else B.ask('query', 'What word or phrase should it look up?', ['query'], null);
  }
};

/* ---------------------------------------------------------------- 11. read one chunk */
function questionTypeIfClose(cands, B) {
  if (cands.length >= 2 && cands[0].raw - cands[1].raw < 2.0 && cands[0].raw > 0) {
    B.ask('which_form', 'Two forms fit about equally well. Which is it?', ['__form__'], [cands[0].fn, cands[1].fn]);
  }
}

function readChunk(text, opts) {
  opts = opts || {};
  var T = fold(text), sp = splitPreamble(T), pre = sp.pre, body = sp.body;
  var defaults = {}, defList = [];
  if (pre) { parseDefaults(pre, 0).forEach(function (d) { defaults[d.name === 'loads_basis' ? 'loads_basis' : d.name] = d; defList.push({ name: d.name, value: d.value, from: d.from }); }); }
  var work = pre ? new Array(sp.preEnd + 1).join(' ') + body : T;       // keep offsets; blank the preamble for all fact finders
  work = work.replace(/(^|\n)([ \t]*Q\s?\d+\.\s)/g, function (m0, g1, g2) { return g1 + new Array(g2.length + 1).join(' '); });
  var F = gatherFacts(work, defaults, opts.partStart);
  F.originalText = text;
  /* 0.6: the words of the WHOLE question (all its parts), when the caller has them: "unless noted otherwise" is about the question, not about one part */
  F.whole = opts.whole ? fold(String(opts.whole)) : '';
  /* 0.6: when the caller names the form, a failure while GUESSING the form must not cost the fields of that form */
  var cls;
  try { cls = classify(work, F); } catch (eCls) { if (!opts.fn) throw eCls; cls = { list: [], dom: {} }; }
  var list = cls.list, forced = opts.fn;
  var fn = forced || (list.length ? list[0].fn : null);
  var B = new Builder(fn);
  var res = { candidates: list.map(function (c) { return { fn: c.fn, score: c.score, because: c.because }; }), asks: F.asks.map(function (a) { return { ask: a.ask, phrase: a.phrase }; }),
    fields: [], questions: [], warnings: [], defaults: defList, version: VERSION };
  if (fn && FILL[fn]) { try { FILL[fn](F, B, defaults); } catch (e) { B.warn('internal error while filling ' + fn + ': ' + e.message); } }
  else if (fn) B.ask('no_filler', 'No field reader exists for ' + fn + '.', [], null, 'info');
  if (!forced) questionTypeIfClose(list, B);
  if (/\b(?:fig(?:ure|\.)?|shown|as\s+shown|plan\s+view|sketch|diagram|below)\b/i.test(work)) B.warn('The problem refers to a figure or drawing. This reader cannot see it: check every value against the figure.');
  // safety net: every number with a unit that no field used is listed, so a value the rules missed is at least visible
  /* 0.8b (10/07, the rough-typing run):
     - a UNIT WEIGHT (pcf) is listed too: "A 6 in. thick normal weight cobcrete salb (145 pcf)" -- with "slab" misspelled nothing read the 145, the
       list did not show it, and the slab's own weight was left out of the answer;
     - a LOAD that stands twice with one value is two loads: "a dead load of 1.5 k/ft and a ... live lad of 1.5 k/ft" -- one field quoted "1.5 k/ft"
       and BOTH were called used.  For a load, as many occurrences count as used as the fields quote. */
  var coll = function (s) { return String(s).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''); }, unplaced = [], seenN = {};
  var occ = function (hay, needle) { var n = 0, at = 0, j; hay = String(hay); if (!needle) return 0; for (;;) { j = hay.indexOf(needle, at); if (j < 0) break; n++; at = j + needle.length; } return n; };
  F.q.forEach(function (q) {
    if (!q.unit || q.unit === 'ksi' || q.unit === 'psi' || q.unit === 'in2') return;
    var txt = coll(q.text), isLoad = /kip|^k$|k\/ft|klf|psf|plf|lb/i.test(String(q.unit)), nFrom = 0, used;
    if (isLoad) {
      B.fields.forEach(function (f) { nFrom += occ(f.from, txt); });
      B.questions.forEach(function (qq) { nFrom += occ(qq.text, txt); });
      seenN[txt] = (seenN[txt] || 0) + 1;
      used = seenN[txt] <= nFrom;
    } else used = B.fields.some(function (f) { return String(f.from).indexOf(txt) >= 0; }) || B.questions.some(function (qq) { return qq.text.indexOf(txt) >= 0; });
    if (!used) unplaced.push({ text: txt, value: q.v, unit: q.unit });
  });
  if (unplaced.length && fn && !forced) B.warn('Numbers in the text that no field used: ' + unplaced.map(function (u) { return u.text; }).join(', ') + '. Check that none of them matters.');
  res.unplaced = unplaced;
  res.fields = B.fields; res.questions = B.questions; res.warnings = B.warnings;
  if (B.dropped.length) res.notStoredInThisForm = B.dropped;
  return { res: res, F: F, top: fn };
}

/* ---------------------------------------------------------------- 12. parts */
function splitParts(T) {
  // labelled parts: (a) (b) ... at line starts or inline in sequence
  var re = /(?:^|\n|\s)\(([a-h])\)\s/g, m, marks = [];
  while ((m = re.exec(T)) !== null) { marks.push({ ch: m[1], idx: m.index + (m[0].charAt(0) === '(' ? 0 : 1) }); }
  var chain = null, i, j, start;
  for (i = 0; i < marks.length; i++) {
    if (marks[i].ch !== 'a') continue;
    var cur = [marks[i]], next = 'b';
    for (j = i + 1; j < marks.length; j++) { if (marks[j].ch === next) { cur.push(marks[j]); next = String.fromCharCode(next.charCodeAt(0) + 1); } }
    if (cur.length >= 2 && (!chain || cur.length > chain.length)) chain = cur;
  }
  if (!chain) {
    // "a)" "b)" at line starts
    var re2 = /(?:^|\n)\s*([a-h])\)\s/g, marks2 = [];
    while ((m = re2.exec(T)) !== null) marks2.push({ ch: m[1], idx: m.index + (m[0].charAt(0) === '\n' ? 1 : 0) });
    var cur2 = [], nx = 'a';
    for (i = 0; i < marks2.length; i++) if (marks2[i].ch === nx) { cur2.push(marks2[i]); nx = String.fromCharCode(nx.charCodeAt(0) + 1); }
    if (cur2.length >= 2) chain = cur2;
  }
  if (chain) {
    var parts = [], stem = T.slice(0, chain[0].idx);
    for (i = 0; i < chain.length; i++) { var e = i + 1 < chain.length ? chain[i + 1].idx : T.length; parts.push({ label: chain[i].ch, text: T.slice(chain[i].idx, e) }); }
    return { stem: stem, parts: parts };
  }
  // a list of lines, each holding its own shape, under a "determine the following:" stem
  var lines = T.split('\n'), items = [], firstItem = -1;
  for (i = 1; i < lines.length; i++) {
    if (findShapes(lines[i]).shapes.length >= 1 && lines[i].replace(/\s/g, '').length > 6) { if (firstItem < 0) firstItem = i; items.push(i); }
  }
  if (items.length >= 2 && firstItem >= 1 && /following|each\s+of|for\s+each/i.test(lines.slice(0, firstItem).join(' ')) && items.length >= lines.length - firstItem - 1) {
    var stem2 = lines.slice(0, firstItem).join('\n'), parts2 = [];
    for (i = 0; i < items.length; i++) parts2.push({ label: String(i + 1), text: lines[items[i]] });
    return { stem: stem2, parts: parts2 };
  }
  return null;
}

function read(text, opts) {
  opts = opts || {};
  text = String(text === undefined || text === null ? '' : text);
  var T = fold(text), out;
  try {
    var sp = opts.noParts ? null : splitParts(T);
    var whole = readChunk(text, opts);
    out = whole.res;
    out.parts = [];
    if (sp) {
      var stemDef = null;
      sp.parts.forEach(function (p) {
        var chunk = (sp.stem ? sp.stem + '\n' : '') + p.text;
        var r = readChunk(chunk, opts.fn ? { fn: opts.fn, partStart: sp.stem ? sp.stem.length + 1 : 0 } : { partStart: sp.stem ? sp.stem.length + 1 : 0 });
        out.parts.push({ label: p.label, text: p.text.replace(/^\s+|\s+$/g, ''), read: r.res });
      });
      // the top-level candidates are from the whole text; fields at the top level are the stem's own
      var stemRead = sp.stem && sp.stem.replace(/\s/g, '').length ? readChunk(sp.stem, { fn: whole.top }) : null;
      out.fields = stemRead ? stemRead.res.fields : [];
      out.questions = [{ id: 'multi_part', text: 'This problem has ' + sp.parts.length + ' parts; each is read separately (see parts).', fields: [], choices: null, kind: 'info' }];
    }
  } catch (e) {
    out = { candidates: [], asks: [], fields: [], questions: [], warnings: ['internal error: ' + e.message], defaults: [], parts: [], version: VERSION, error: String(e && e.stack || e) };
  }
  return out;
}

var READER = { read: read, version: VERSION, rules: RULES, _fold: fold, _internal: { findShapes: findShapes, findLoads: findLoads, scanQuantities: scanQuantities, findEnds: findEnds, findHoles: findHoles, findLengths: findLengths, splitParts: splitParts } };
READER._internal.noHolesWord = noHolesWord;     /* (10/07) pipeline's "mentions bolts or holes" guard asks the same question: does "no holes" name a place? */
if (typeof module !== 'undefined' && module.exports) module.exports = READER;
if (root) root.READER = READER;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

