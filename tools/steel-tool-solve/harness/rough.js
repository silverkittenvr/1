// node harness/rough.js <clean.json> --out <rough.json> [--clean-run <run.json>] [--seed S] [--light N] [--medium N] [--heavy N] [--pairs N] [--no-pure]
// Unit B, "his typing, at scale": rough copies of clean questions [{id,text}] typed the way the student types (student-tests/HOW-HE-TYPES.md,
// his three typed tests, his 03:45 and 03:55 messages).  Deterministic: the same input and seed give the same copies, byte for byte.
//   out: [{id: <cleanId>~<k>, base: <cleanId>, base2?: <cleanId of the second problem>, level, transforms: [...], spec, text}]
// --clean-run (the clean questions run on the page): only the questions with at least one answer line get copies, and the "typed along"
// transform takes the book's answer / a table value from that run (he copies them from the paper; the generator never invents a number).
// The model is HIS typing, not what the page repairs: every transform below comes from his own samples, never from the page's word lists.
// Every copy keeps every number and every count of the paper: checkNumbers() rejects (and counts) any copy whose numbers changed.
'use strict';
var fs = require('fs');

/* ---------- seeded random ---------- */
function hashStr(s) { var h = 2166136261, i; for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seedStr) {
  var a = hashStr(String(seedStr));
  function f() { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
  var R = function () { return f(); };
  R.int = function (n) { return Math.floor(f() * n); };
  R.pick = function (arr) { return arr[Math.floor(f() * arr.length)]; };
  R.chance = function (p) { return f() < p; };
  R.range = function (lo, hi) { return lo + Math.floor(f() * (hi - lo + 1)); };
  return R;
}

/* ---------- numbers: what must never change ---------- */
var NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
var NUMW_RE = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi;
function values(s) {
  var t = String(s).replace(NUMW_RE, function (w) { return ' ' + NUMW[w.toLowerCase()] + ' '; }), out = [], m;
  var re = /(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:\s*\/\s*(\d+(?:\.\d+)?))?/g;
  while ((m = re.exec(t))) {
    var a = parseFloat(m[1].replace(/,/g, '')), v = m[2] ? a / parseFloat(m[2]) : a;
    out.push(String(Math.round(v * 1e6) / 1e6));
  }
  return out.sort();
}
function sameMultiset(a, b) { return a.length === b.length && a.join('|') === b.join('|'); }

/* ---------- his words ---------- */
// misspellings he made or would make of the KEY words (his tests: colum, tention, lenght, modulous, flang, buckeling, streangth, salb, laod,
// stel, simpley, polts, determane); the rest of the key words get a dropped / doubled / swapped / neighbouring-key letter.
var PHON = {
  column: ['colum', 'colmun', 'collumn', 'coloumn'], columns: ['colums', 'colmuns', 'collumns'],
  tension: ['tention', 'tenson', 'tensoin', 'tenshion'], length: ['lenght', 'lengh', 'legnth', 'lentgh'],
  modulus: ['modulous', 'modulas', 'modulis'], flange: ['flang', 'flnage', 'flage'], flanges: ['flangs', 'flanegs', 'flagnes'],
  buckling: ['buckeling', 'bukling', 'buckleing'], strength: ['streangth', 'strenght', 'strengh', 'stregnth'],
  slab: ['salb', 'slabb'], load: ['laod', 'lod', 'loda'], loads: ['laods', 'lods'], steel: ['stel', 'steal', 'steeel'],
  simply: ['simpley', 'simpy', 'simplly'], bolts: ['polts', 'bolst', 'blots', 'boltz'], bolt: ['polt', 'blot', 'boltt'],
  determine: ['determane', 'detremine', 'determin', 'deturmine'], effective: ['efective', 'effectiv', 'affective', 'effecive'],
  design: ['desgin', 'desing', 'disign'], diameter: ['dimater', 'diamter', 'diameater', 'dimeter'], connected: ['conected', 'connectd', 'connnected'],
  member: ['memeber', 'membr', 'memebr'], compression: ['compresion', 'compresison', 'comppression'], compressive: ['compresive', 'compressiv'],
  capacity: ['capasity', 'capcity', 'capacty'], moment: ['momnet', 'momment', 'moement'], beam: ['beem', 'bema', 'baem'],
  section: ['secton', 'sectoin', 'sction'], plastic: ['plastik', 'platsic', 'plastc'], yield: ['yeild', 'yeld', 'yiled'], yielding: ['yeilding', 'yielidng'],
  ultimate: ['ultimite', 'ultamate', 'ultimat'], rupture: ['ruptur', 'rupter', 'ruputre'], gross: ['gros', 'groos', 'grsos'], area: ['aera', 'arae', 'are'],
  factored: ['factord', 'facotred', 'factorred'], radius: ['raduis', 'radious', 'radus'], gyration: ['gyrtion', 'gyraton', 'giration', 'gyrasion'],
  pinned: ['pined', 'pinnned', 'pinend'], fixed: ['fixd', 'fiexd', 'fixxed'], braced: ['bracd', 'braceed', 'barced'], bracing: ['braceing', 'bracign'],
  lateral: ['latteral', 'lateal', 'latral'], support: ['suport', 'supprot', 'supoprt'], supported: ['suported', 'supproted', 'supportd'],
  uniform: ['unifrom', 'uniforn', 'uniformm'], concentrated: ['concentraded', 'concetrated', 'consentrated'], span: ['spna', 'spann'],
  girder: ['girdre', 'grider', 'girdr'], tributary: ['tributery', 'tribuatry', 'tributory'], spacing: ['spaceing', 'spaicing'],
  inertia: ['inertai', 'inersha', 'inerta'], thickness: ['thicknes', 'thickeness', 'thikness'], width: ['widht', 'witdh', 'widt'],
  depth: ['depht', 'deapth', 'dept'], angle: ['angel', 'agle', 'anlge'], channel: ['chanel', 'channle', 'chanell'], lightest: ['lighest', 'lightst', 'litest'],
  select: ['selcet', 'slect', 'selct'], shape: ['shap', 'sahpe', 'shpae'], dead: ['ded', 'daed', 'deadd'], live: ['liev', 'lvie', 'livee'],
  interior: ['interor', 'intirior', 'inteiror'], elasticity: ['elasicity', 'elastisity', 'elastcity'], stress: ['stres', 'strees', 'stresss'],
  critical: ['critcal', 'criticle', 'crtical'], slenderness: ['slendernes', 'slenderniss', 'slenderess'], ratio: ['raito', 'ratoi', 'rattio'],
  shear: ['sheer', 'shaer', 'sher'], factor: ['facter', 'factro', 'factr'], hanger: ['hangar', 'hagner', 'hangr'], gusset: ['gusett', 'gussett', 'guset'],
  plate: ['palte', 'plat', 'plaet'], weak: ['week', 'waek', 'weka'], strong: ['stong', 'srtong', 'strogn'], axis: ['axsis', 'axsi', 'axiss'],
  euler: ['eular', 'uler', 'euller'], required: ['requried', 'requred', 'requird'], minimum: ['minumum', 'minimun', 'minimm'], maximum: ['maximun', 'maxium', 'maxmum'],
  floor: ['flor', 'foor', 'floer'], roof: ['rof', 'rooff', 'ruf'], holes: ['hloes', 'hols', 'holse'], hole: ['hloe', 'hol', 'hoel'],
  staggered: ['stagered', 'staggerd', 'stagerred'], define: ['defien', 'defne', 'difine'], ductility: ['ductilty', 'ductillity', 'duktility'],
  hardening: ['hardning', 'hardenning', 'hardeing'], proportional: ['proportinal', 'propotional', 'proportianal'], elastic: ['elastik', 'elastc', 'elsatic'],
  limit: ['limt', 'limmit', 'limti'], 'true': ['ture', 'treu'], 'false': ['flase', 'fals', 'fasle'], advantage: ['advantge', 'advatage'],
  analysis: ['analisys', 'anaylsis', 'analysys'], brittle: ['britle', 'brittel'], carbon: ['carbin', 'carbn'], effect: ['efect'],
  nominal: ['nomial', 'nominl'], available: ['avaliable', 'availble'], calculate: ['calcualte', 'calulate'], compute: ['comptue', 'compte'],
  service: ['servise', 'servcie'], combination: ['combinaton', 'combintion'], resistance: ['resistence', 'resistanse'], tensile: ['tensil', 'tensle', 'tensiel'],
  net: ['nte'], lines: ['lins', 'liens'], line: ['lien', 'lne'], rows: ['rwos', 'roows'], legs: ['lges'], leg: ['lge'],
  web: ['wbe'], ends: ['edns', 'endss'], gage: ['guage', 'gauge'], stagger: ['stager']
};
// phrases he got wrong as a whole ("frree to swya" for "free to sway" in his first test)
var PHRASES = [
  [/\bfree to sway\b/i, ['frree to swya', 'free to sawy', 'fre to sway']],
  [/\bfree to translate\b/i, ['free to tranlsate', 'frre to translate']],
  [/\bsimply supported\b/i, ['simpley supported', 'simpy suported', 'simply suported']],
  [/\bstress-strain\b/i, ['stress strian', 'stres-strain', 'stress-stain']]
];
// never changed by a typo: they carry a count or a negation (he keeps every number and every count of the paper)
var NOTOUCH = { not: 1, no: 1, none: 1, nor: 1, neither: 1, without: 1, except: 1, unless: 1, only: 1, both: 1, each: 1, every: 1, per: 1, single: 1,
  double: 1, first: 1, second: 1, third: 1, half: 1, all: 1, twice: 1, once: 1 };
Object.keys(NUMW).forEach(function (w) { NOTOUCH[w] = 1; });
var NEIGH = { a: 'sqw', b: 'vgn', c: 'xdv', d: 'sfe', e: 'wrd', f: 'dgr', g: 'fht', h: 'gjy', i: 'uok', j: 'hku', k: 'jli', l: 'ko', m: 'nj', n: 'bmh',
  o: 'ipl', p: 'ol', q: 'wa', r: 'etf', s: 'adw', t: 'ryg', u: 'yij', v: 'cbf', w: 'qes', x: 'zsc', y: 'tuh', z: 'xa' };
function typo(w, R) {
  var L = w.length, k, i, out = w, tries = 0, nb;
  while (out === w && tries++ < 12) {
    k = R.int(4);
    if (k === 0) { i = 1 + R.int(L - 1); out = w.slice(0, i) + w.slice(i + 1); }
    else if (k === 1) { i = R.int(L); out = w.slice(0, i + 1) + w.charAt(i) + w.slice(i + 1); }
    else if (k === 2 && L > 3) { i = 1 + R.int(L - 2); out = w.slice(0, i) + w.charAt(i + 1) + w.charAt(i) + w.slice(i + 2); }
    else { i = 1 + R.int(L - 1); nb = NEIGH[w.charAt(i).toLowerCase()]; if (nb) out = w.slice(0, i) + nb.charAt(R.int(nb.length)) + w.slice(i + 1); }
  }
  return out;
}
function keepCase(orig, w) { return /^[A-Z]/.test(orig) ? w.charAt(0).toUpperCase() + w.slice(1) : w; }
// the word tokens of a text that a typo may touch: letters only, not glued to a digit (W12, 3/4in, A992), not a symbol (Fy, KL, Pn)
function wordTokens(s) {
  var re = /[A-Za-z]+/g, m, out = [];
  while ((m = re.exec(s))) {
    var w = m[0], b = s.charAt(m.index - 1), a = s.charAt(m.index + w.length);
    if (/\d/.test(b) || /\d/.test(a) || a === '-' && /\d/.test(s.charAt(m.index + w.length + 1))) continue;
    if (/[A-Z]/.test(w.slice(1))) continue;
    if (NOTOUCH[w.toLowerCase()]) continue;
    out.push({ w: w, i: m.index });
  }
  return out;
}
function replaceAt(s, i, len, rep) { return s.slice(0, i) + rep + s.slice(i + len); }

/* ---------- the transforms (each: (text, R, level, ctx) -> text; ctx.notes collects the details) ---------- */
var LV = { light: 0, medium: 1, heavy: 2 };

// lower case throughout (sometimes a capital at the start)
function tLower(s, R) { s = s.toLowerCase(); if (R.chance(0.25)) s = s.charAt(0).toUpperCase() + s.slice(1); return s; }

// full stops lost (the decimal point of a number is never a full stop)
function tNostops(s, R, lv) {
  var all = lv === 'pure' || R.chance(0.75);
  return s.replace(/\.(?!\d)/g, function (m) { return all || R.chance(0.6) ? '' : m; });
}

// line breaks lost or added
function tBreaks(s, R, lv, ctx) {
  if (/\n/.test(s) && R.chance(0.7)) { ctx.notes.push('breaks:lost'); return s.replace(/\s*\n\s*/g, ' '); }
  var gaps = [], re = /([.?,;:]) +|\s{1}(?=\S)/g, m, n = 1 + (LV[lv] === 2 ? R.int(2) : 0), k;
  while ((m = re.exec(s))) gaps.push({ i: m.index, len: m[0].length, p: m[1] || '' });
  if (!gaps.length) return s;
  for (k = 0; k < n; k++) {
    var pref = gaps.filter(function (g) { return g.p; }), g = pref.length && R.chance(0.7) ? R.pick(pref) : R.pick(gaps);
    s = s.slice(0, g.i) + g.p + '\n' + s.slice(g.i + g.len);
    gaps = []; re.lastIndex = 0; while ((m = re.exec(s))) gaps.push({ i: m.index, len: m[0].length, p: m[1] || '' });
  }
  ctx.notes.push('breaks:added');
  return s;
}

// KEY words misspelled, one or two per question (heavy: and an ordinary word)
function tMisspell(s, R, lv, ctx) {
  var want = lv === 'pure' ? 1 : (LV[lv] === 0 ? 1 : (LV[lv] === 1 ? R.range(1, 2) : 2)), done = 0, k, toks, keys, c, rep, orig = {};
  (s.toLowerCase().match(/[a-z]+/g) || []).forEach(function (w) { orig[w] = 1; });
  for (k = 0; k < PHRASES.length && done < want; k++) {
    var pm = PHRASES[k][0].exec(s);
    if (pm && R.chance(0.6)) { rep = R.pick(PHRASES[k][1]); s = replaceAt(s, pm.index, pm[0].length, keepCase(pm[0], rep)); ctx.notes.push('misspell:' + pm[0].toLowerCase() + '>' + rep); done++; }
  }
  var used = {};
  while (done < want) {
    toks = wordTokens(s);
    keys = toks.filter(function (t) { var l = t.w.toLowerCase(); return PHON.hasOwnProperty(l) && !used[l]; });
    if (!keys.length) keys = toks.filter(function (t) { return t.w.length >= 5 && !used[t.w.toLowerCase()]; });
    if (!keys.length) break;
    c = R.pick(keys);
    var lw = c.w.toLowerCase();
    rep = PHON.hasOwnProperty(lw) && R.chance(0.6) ? R.pick(PHON[lw]) : typo(lw, R);
    if (rep === lw) rep = typo(lw, R);
    used[lw] = 1;
    s = replaceAt(s, c.i, c.w.length, keepCase(c.w, rep));
    ctx.notes.push('misspell:' + lw + '>' + rep); done++;
  }
  if (LV[lv] === 2) {
    toks = wordTokens(s).filter(function (t) { var l = t.w.toLowerCase(); return t.w.length >= 4 && orig[l] && !PHON.hasOwnProperty(l) && !used[l]; });
    if (toks.length) { c = R.pick(toks); rep = typo(c.w.toLowerCase(), R); s = replaceAt(s, c.i, c.w.length, keepCase(c.w, rep)); ctx.notes.push('misspell-ordinary:' + c.w.toLowerCase() + '>' + rep); }
  }
  return s;
}

// units glued to numbers; kips as k, feet as ', inches as "
function tGlue(s, R, lv, ctx) {
  var p = lv === 'pure' ? 1 : [0.5, 0.75, 0.95][LV[lv]];
  function ch() { return R.chance(p); }
  s = s.replace(/(\d)\s*-?\s*kips?\s*\/\s*(ft|foot)\b\.?/gi, function (m, d) { return ch() ? d + R.pick(['k/ft', 'k/ft', ' k/ft', 'kip/ft']) : m; });
  s = s.replace(/(\d)\s+kips per (foot|ft)\b/gi, function (m, d) { return ch() ? d + R.pick(['k/ft', ' k/ft']) : m; });
  s = s.replace(/\bkip-ft\b/gi, function (m) { return ch() ? R.pick(['k-ft', 'kft', 'k-ft', 'kip ft']) : m; });
  s = s.replace(/\bft-kips?\b/gi, function (m) { return ch() ? R.pick(['ft-k', 'k-ft', 'ftk']) : m; });
  s = s.replace(/(\d)-in\.?-diameter\b/gi, function (m, d) { return ch() ? d + R.pick(['in', 'in diameter', ' in dia', '"', 'in dia']) : m; });
  s = s.replace(/(\d)-in\.?(?=[\s,;)]|$)/g, function (m, d) { return ch() ? d + R.pick(['in', 'in', '"', ' in']) : m; });
  s = s.replace(/(\d)-ft\b\.?/g, function (m, d) { return ch() ? d + R.pick(['ft', 'ft', "'", ' ft']) : m; });
  s = s.replace(/(\d)\s+in\.?\s*\^?\s*([234])\b/g, function (m, d, e) { return ch() ? d + R.pick(['in^' + e, 'in' + e, ' in^' + e]) : m; });
  s = s.replace(/(\d)\s+(ft|ksi|psf|kips|kip|k|klf|lb|in|feet|inches)\b(\.?)(?=(\s+[A-Z])?)/g, function (m, d, u, dot, nextCap) {
    if (!ch()) return m;
    var u2 = u, end = nextCap && dot ? '.' : '';
    if (/^kips?$/.test(u) && R.chance(0.7)) u2 = 'k';
    else if ((u === 'ft' || u === 'feet') && R.chance(0.3)) u2 = "'";
    else if ((u === 'in' || u === 'inches') && R.chance(0.3)) u2 = '"';
    else if (u === 'feet') u2 = 'ft';
    else if (u === 'inches') u2 = 'in';
    return d + u2 + end;
  });
  return s;
}

// shape names typed loosely: w12x53, w 12 x 53, W12X53, w12 53 (and "x" as "*")
var SHAPE_RE = /\b(WT|MC|HSS|HP|W|C|S|M|L)\s?(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?(?:\/\d+)?)(?:\s*[xX]\s*(\d+(?:-\d+)?(?:\/\d+)?))?\b/g;
function tShape(s, R, lv, ctx) {
  return s.replace(SHAPE_RE, function (m, f, a, b, c) {
    var fl = f.toLowerCase(), st;
    if (c) st = R.pick([fl + a + 'x' + b + 'x' + c, f + ' ' + a + 'x' + b + 'x' + c, f + a + 'X' + b + 'X' + c, fl + a + ' x ' + b + ' x ' + c, fl + a + 'x' + b + ' x' + c]);
    else st = R.pick([fl + a + 'x' + b, fl + ' ' + a + ' x ' + b, f + a + 'X' + b, fl + a + ' ' + b, fl + a + '*' + b, f + a + ' x' + b, fl + a + 'x ' + b, f + ' ' + a + 'X' + b]);
    ctx.notes.push('shape:' + st);
    return st;
  });
}

// "phi" for the slashed O in both meanings: the resistance factor (phi Pn, phiPn) and the bolt diameter (7/8in phi bolts)
function tPhi(s, R, lv, ctx) {
  s = s.replace(/\bphi(?:_[bct])?\s*(Pn|Mn|Mp|Fcr|Rn|Pe)\b/g, function (m, q) { var r = R.pick(['phi ' + q, 'phi' + q, 'phi ' + q.toLowerCase(), 'phi' + q.toLowerCase()]); if (r !== m) ctx.notes.push('phi:' + r); return r; });
  s = s.replace(/(\d(?:\/\d+)?)\s*-?\s*in\.?\s*-?\s*diameter(?=\s+bolts?\b)/gi, function (m, d) { var r = d + R.pick(['in phi', ' in phi', 'in. phi', '" phi']); ctx.notes.push('phi:diameter'); return r; });
  s = s.replace(/(\d(?:\/\d+)?)\s+in\.?\s+diameter(?=\s+bolts?\b)/gi, function (m, d) { ctx.notes.push('phi:diameter'); return d + R.pick(['in phi', ' in phi']); });
  return s;
}

// compression: "2 per flange", "both flanges", "one each side of the web", DL/LL, dia
function tCompress(s, R, lv, ctx) {
  var p = lv === 'pure' ? 0.9 : [0.4, 0.6, 0.85][LV[lv]], s0 = s;
  function ch() { return R.chance(p); }
  function rule(re, f, name) { s = s.replace(re, function () { if (!ch()) return arguments[0]; var r = f.apply(null, arguments); if (r !== arguments[0]) ctx.notes.push('compress:' + name); return r; }); }
  rule(/\b(?:in|on) each flange\b/gi, function () { return R.pick(['per flange', 'each flange']); }, 'per-flange');
  rule(/\bbolts? (?:in each|per) (line|row)\b/gi, function (m, l) { return 'per ' + l; }, 'per-line');
  rule(/\b(?:in|on) each (line|row)\b/gi, function (m, l) { return R.pick(['per ' + l, 'each ' + l]); }, 'each-line');
  rule(/\bthrough (?:both|the) flanges\b/gi, function (m) { return /both/i.test(m) ? R.pick(['both flanges', 'thru both flanges']) : R.pick(['thru flanges', 'through flanges', 'at the flanges']); }, 'flanges');
  rule(/\b(one )?on each side of the web\b/gi, function (m, o) { return (o || '') + 'each side of the web'; }, 'each-side');
  // (not before a size: "four 7/8-in. bolts" -> "4 7/8in bolts" reads as a mixed number to anyone, and he keeps every count readable)
  rule(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?=(?:lines|rows|bolts|holes|gage lines|floors|levels|stories|concentrated)\b)/gi, function (m, w) { return NUMW[w.toLowerCase()] + ' '; }, 'digits');
  rule(/\bat both ends\b/gi, function () { return R.pick(['both ends', 'at both ends', 'both end']); }, 'both-ends');
  rule(/\b(fixed|pinned|free) at (?:the|its) (base|bottom|top)\b/gi, function (m, a, b) { return a + ' ' + R.pick([b, 'at ' + b, b]); }, 'end-cond');
  rule(/\bwith pinned ends\b/gi, function () { return R.pick(['pinned ends', 'pin ends', 'pinned both ends']); }, 'pinned-ends');
  // (only where a load VALUE follows: "Define dead load" keeps its words)
  rule(/\b(service )?dead load (?=of |=|\d)/gi, function (m, sv) { return (sv && R.chance(0.5) ? sv : '') + R.pick(['DL ', 'dead ', 'DL ']); }, 'DL');
  rule(/\b(service )?live load (?=of |=|\d)/gi, function (m, sv) { return (sv && R.chance(0.5) ? sv : '') + R.pick(['LL ', 'live ', 'LL ']); }, 'LL');
  rule(/\bdiameter\b/gi, function () { return R.pick(['dia', 'dia.', 'diam']); }, 'dia');
  rule(/\beffective length\b/gi, function () { return R.pick(['eff length', 'eff. length', 'eff len']); }, 'eff');
  if (LV[lv] === 2 || lv === 'pure') rule(/\bthe /gi, function (m) { return R.chance(0.5) ? '' : m; }, 'no-the');
  if (s === s0) return s;
  return s.replace(/ {2,}/g, ' ');
}

// blanks typed as "____", "= ?", "=", or dropped
function tBlanks(s, R, lv, ctx) {
  return s.replace(/(\s*=\s*)?_{2,}/g, function (m, eq) {
    var r = eq ? R.pick([' = ?', ' =', ' = ___', '=', ' = _']) : R.pick([' = ?', ' =', ' ___', '', ' ?', ' = ____']);
    ctx.notes.push('blanks:' + (r.trim() || '(dropped)'));
    return r;
  });
}

// sentence order changed
function splitSentences(s) {
  var out = [], re = /[.?!]+\s+(?=[A-Z(])/g, last = 0, m;
  while ((m = re.exec(s))) { out.push(s.slice(last, m.index + m[0].length).trim()); last = m.index + m[0].length; }
  out.push(s.slice(last).trim());
  return out.filter(function (x) { return x; });
}
function isMC(s) { return /\n\s*[a-dA-D][.)]|\([a-dA-D]\)\s|\b[a-d]\)\s|\[ \]|\b[1-4]\)\s/.test(s); }
function tShuffle(s, R, lv, ctx) {
  if (isMC(s)) return s;
  var ss = splitSentences(s), k, perm;
  if (ss.length < 2) return s;
  for (k = 0; k < 8; k++) {
    perm = ss.slice(); var i, j, t;
    for (i = perm.length - 1; i > 0; i--) { j = R.int(i + 1); t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
    if (perm.join(' ') !== ss.join(' ')) break;
  }
  ctx.notes.push('shuffle:' + perm.map(function (x) { return ss.indexOf(x) + 1; }).join(''));
  return perm.join(' ');
}

// the book's answer or a table value typed along: "(ans 312 k)", "from the table Ag = 15.6" -- only numbers that ARE on his paper or in his book
function unitShort(u) {
  u = String(u || '').trim();
  if (/^kips?$/.test(u)) return R0pick(['k', ' k', ' kips']);
  if (/^kip-ft$/.test(u)) return R0pick(['k-ft', ' k-ft', ' kip-ft']);
  if (/^k\/ft$|^kips?\/ft$/.test(u)) return R0pick(['k/ft', ' k/ft']);
  if (/^in\^2$/.test(u)) return R0pick([' in^2', 'in^2', ' in2']);
  if (/^in\^3$/.test(u)) return R0pick([' in^3', 'in^3', ' in3']);
  if (/^in\^4$/.test(u)) return R0pick([' in^4', 'in^4']);
  if (/^(in|ft|ksi|psf)$/.test(u)) return R0pick([u, ' ' + u]);
  return u ? ' ' + u : '';
}
var R0 = null; function R0pick(a) { return R0.pick(a); }
function tTyped(s, R, lv, ctx) {
  var run = ctx.cleanRun && ctx.cleanRun[ctx.id], cands = [], m, i;
  if (!run) return s;
  R0 = R;
  (run.parts || []).forEach(function (p) {
    (p.write || []).forEach(function (l) {
      var a = /^ANSWER(?: \(step \d+\))?: (.*)$/.exec(l), t;
      if (a) {
        t = a[1];
        // the book's answer is what the line is about: a chosen shape ("Most economical beam: W18X35 (35 lb/ft, d = 17.7 in)") or the first value
        if ((m = /^[^:]*:\s*((?:W|WT|C|MC|L|HSS|S|M|HP)\d+(?:\.\d+)?X\d+(?:\.\d+)?(?:X\d+(?:\/\d+)?)?)\b/.exec(t))) cands.push({ kind: 'ans', shape: m[1] });
        else if ((m = /\bphi (?:Pn|Mp|Mn) = (\d[\d,]*(?:\.\d+)?) (kips|kip-ft)\b/.exec(t))) cands.push({ kind: 'ans', num: m[1], unit: m[2] });
        else if ((m = /^[^:]*:\s*(?:[A-Za-z ]+:\s*)?(?:[A-Za-z]+(?: [A-Za-z]+)?\s*(?:>=|=)\s*|)(\d[\d,]*(?:\.\d+)?)\s*(kips|kip|kip-ft|k\/ft|in\^2|in\^3|in\^4|in|ft|ksi|psf)?(?=[\s,;)]|$)/.exec(t))) cands.push({ kind: 'ans', num: m[1], unit: m[2] || '' });
      } else if (/^\d+\. .*(?:Manual|[Tt]able)/.test(l)) {
        // a table value as printed in the Manual (never a working value like "0.90 Fy Ag = 0.90 x 50 ...")
        var tre = /\b(Ag|rx|ry|Zx|Sx|Ix|bf|tf|tw)\s*=\s*(\d+(?:\.\d+)?)\s*(in\^2|in\^3|in\^4|in)?/g, tr;
        while ((tr = tre.exec(l))) { if (!/^\s*[x*\/]/.test(l.slice(tr.index + tr[0].length))) cands.push({ kind: 'table', sym: tr[1], num: tr[2], unit: tr[3] || '' }); }
      }
    });
  });
  if (!cands.length) return s;
  var ans = cands.filter(function (c) { return c.kind === 'ans'; }), tab = cands.filter(function (c) { return c.kind === 'table'; }), c, add;
  c = ans.length && (!tab.length || R.chance(0.7)) ? ans[0] : R.pick(tab);
  if (c.kind === 'ans') {
    var num = c.num;
    if (num && /\./.test(num) && R.chance(0.3)) { /* the book prints fewer decimals sometimes: keep only digits that are there (no rounding: a typo never changes a digit) */ }
    var body = c.shape ? R.pick([c.shape.toLowerCase(), c.shape]) : num + unitShort(c.unit);
    add = R.pick(['(ans ' + body + ')', '(ans. ' + body + ')', 'ans = ' + body, 'answer ' + body, '(answer: ' + body + ')', 'ans ' + body]);
    ctx.added.push(add);
  } else {
    add = R.pick(['from the table ' + c.sym + ' = ' + c.num, 'from table ' + c.sym + '=' + c.num + unitShort(c.unit), c.sym + ' = ' + c.num + ' from the table', '(table ' + c.sym + ' = ' + c.num + ')']);
    ctx.added.push(add);
  }
  ctx.notes.push('typed:' + add);
  var ss = splitSentences(s);
  if (ss.length > 1 && R.chance(0.3)) { i = 1 + R.int(ss.length - 1); ss.splice(i, 0, add); return ss.join(' '); }
  return s.replace(/\s*$/, '') + ' ' + add;
}

// figure references kept: "see fig 3-22", "as shown"
function tFig(s, R, lv, ctx) {
  var ch = R.range(1, 9), pr = R.range(1, 40);
  var add = R.pick(['see fig ' + ch + '-' + pr, 'as shown', 'shown in fig p' + ch + '-' + pr, '(see figure)', 'as shown in the figure', 'fig. ' + ch + '.' + pr, 'see figure p' + ch + '.' + pr, 'refer to fig ' + ch + '-' + pr]);
  ctx.added.push(add); ctx.notes.push('fig:' + add);
  var ss = splitSentences(s), r = R();
  if (r < 0.5 || ss.length < 2) return s.replace(/\s*$/, '') + ' ' + add;
  if (r < 0.8) { ss[0] = ss[0].replace(/([.?!]*)$/, ' ' + add + '$1'); return ss.join(' '); }
  return add.charAt(0).toUpperCase() + add.slice(1) + '. ' + s;
}

// the problem's label typed as a prefix: "Problem 3-22."
function tLabel(s, R, lv, ctx) {
  var ch = R.range(1, 9), pr = R.range(1, 40);
  var add = R.pick(['Problem ' + ch + '-' + pr + '.', ch + '-' + pr + ')', 'prob ' + ch + '.' + pr, '#' + pr, 'Q' + pr + '.', 'P' + ch + '-' + pr, ch + '.' + pr, ch + '-' + pr, '(a)', 'a)', 'hw ' + ch + ' #' + pr]);
  ctx.added.push(add); ctx.notes.push('label:' + add);
  return add + ' ' + s;
}

// weird spaces: double/triple spaces, a space inside a word or before punctuation, spaces around "=" (and in a fraction: "3 /4")
function tSpaces(s, R, lv, ctx) {
  var n = lv === 'pure' ? 3 : [1, 2, 4][LV[lv]] + R.int(2), k, kinds = [];
  for (k = 0; k < n; k++) {
    var kind = R.int(5), toks, c, m, list = [], re;
    if (kind === 0) { re = / (?=\S)/g; while ((m = re.exec(s))) list.push(m.index); if (list.length) { c = R.pick(list); s = s.slice(0, c) + R.pick(['  ', '   ']) + s.slice(c + 1); kinds.push('double'); } }
    else if (kind === 1) { toks = wordTokens(s).filter(function (t) { return t.w.length >= 5; }); if (toks.length) { c = R.pick(toks); var at = 2 + R.int(c.w.length - 3); s = replaceAt(s, c.i, c.w.length, c.w.slice(0, at) + ' ' + c.w.slice(at)); kinds.push('inword:' + c.w.toLowerCase()); } }
    else if (kind === 2) { re = /([A-Za-z])([,.?])(?=\s|$)/g; while ((m = re.exec(s))) list.push(m.index + 1); if (list.length) { c = R.pick(list); s = s.slice(0, c) + ' ' + s.slice(c); kinds.push('before-punct'); } }
    else if (kind === 3) { re = /\s*=\s*/g; while ((m = re.exec(s))) list.push({ i: m.index, len: m[0].length }); if (list.length) { c = R.pick(list); s = s.slice(0, c.i) + R.pick(['=', ' =', '= ', '  =  ']) + s.slice(c.i + c.len); kinds.push('eq'); } }
    else { re = /(\d)\/(\d)/g; while ((m = re.exec(s))) list.push(m.index + 1); if (list.length) { c = R.pick(list); s = s.slice(0, c) + R.pick([' /', '/ ', ' / ']) + s.slice(c); kinds.push('frac-space'); } }
  }
  if (kinds.length) ctx.notes.push('spaces:' + kinds.join(','));
  return s;
}

// lack of spaces: words run together, a number glued to the next word, no space after a comma or a full stop
function tNospace(s, R, lv, ctx) {
  var n = lv === 'pure' ? 3 : [1, 2, 3][LV[lv]] + R.int(2), k, kinds = [];
  for (k = 0; k < n; k++) {
    var kind = R.int(3), m, list = [], re, c;
    if (kind === 0) {
      re = /([a-z]{2,}) ([a-z]{2,})/gi;
      while ((m = re.exec(s))) { if (!NUMW[m[1].toLowerCase()] && !NUMW[m[2].toLowerCase()]) list.push(m.index + m[1].length); re.lastIndex = m.index + m[1].length + 1; }
      if (list.length) { c = R.pick(list); s = s.slice(0, c) + s.slice(c + 1); kinds.push('join'); }
    }
    else if (kind === 1) { re = /(\d[a-z"']*) ([a-z]{2,})/gi; while ((m = re.exec(s))) list.push(m.index + m[1].length); if (list.length) { c = R.pick(list); s = s.slice(0, c) + s.slice(c + 1); kinds.push('num-word'); } }
    else { re = /([^\d\s][,.]) (?=[^\d\s])/g; while ((m = re.exec(s))) list.push(m.index + 2); if (list.length) { c = R.pick(list); s = s.slice(0, c) + s.slice(c + 1); kinds.push('after-punct'); } }
  }
  if (kinds.length) ctx.notes.push('nospace:' + kinds.join(','));
  return s;
}

// syntax errors: an unclosed or missing bracket, stray or doubled punctuation, "?" in the middle, a lettered part without its bracket
function tSyntax(s, R, lv, ctx) {
  var n = lv === 'pure' ? 2 : [1, 1, 2][LV[lv]] + (LV[lv] === 2 ? R.int(2) : 0), k, kinds = [];
  for (k = 0; k < n; k++) {
    var kind = R.int(4), m, list = [], re, c;
    if (kind === 0) { re = /[()]/g; while ((m = re.exec(s))) list.push(m.index); if (list.length) { c = R.pick(list); s = s.slice(0, c) + s.slice(c + 1); kinds.push('bracket'); continue; } kind = 1; }
    if (kind === 1) { re = /([A-Za-z])([.,])(?=\s|$)/g; while ((m = re.exec(s))) list.push(m.index + 1); if (list.length) { c = R.pick(list); s = s.slice(0, c) + R.pick([',,', '..', ';:', '.,', ',.']) + s.slice(c + 1); kinds.push('punct'); } }
    else if (kind === 2) { re = /([a-z]{3,}) (?=[a-z])/g; while ((m = re.exec(s))) list.push(m.index + m[1].length); if (list.length) { c = R.pick(list); s = s.slice(0, c) + '?' + s.slice(c); kinds.push('qmark'); } }
    else { re = /\(([a-dA-D])\)/g; while ((m = re.exec(s))) list.push({ i: m.index, l: m[1] }); if (list.length) { c = R.pick(list); s = s.slice(0, c.i) + c.l + s.slice(c.i + 3); kinds.push('letter-no-bracket'); } }
  }
  if (kinds.length) ctx.notes.push('syntax:' + kinds.join(','));
  return s;
}

// fractions as "3/4" or "0.75" or ".75" or "3-4" (bolt sizes and plate thicknesses, never inside a shape name)
var FRAC = { '1/2': ['.5', '0.5', '1-2'], '3/4': ['.75', '0.75', '3-4'], '7/8': ['.875', '0.875', '7-8'], '5/8': ['.625', '0.625', '5-8'], '3/8': ['.375', '0.375', '3-8'], '1/4': ['.25', '0.25', '1-4'] };
function tFrac(s, R, lv, ctx) {
  var re = /([1357])\/([248])(?=\s*(?:-|")?\s*(?:in\b|inch|"|phi|dia|bolts?|thick|plate|x\s))/g;
  return s.replace(re, function (m, a, b, off) {
    var f = a + '/' + b, v = FRAC[f], before = s.slice(0, off);
    if (/[\d.\/-]$|[xX*]\s*$/.test(before)) return m;   // part of a mixed number (1-1/8) or of a shape name (L4x4x1/2)
    if (!v || !(lv === 'pure' || R.chance(0.7))) return m;
    var r = R.pick(v); ctx.notes.push('frac:' + f + '>' + r); return r;
  });
}

// a space inside a number: "2 0 ft" (his 03:45 message) -- digits kept, only split
function tNumspace(s, R, lv, ctx) {
  var re = /(^|[\s(=$])(\d{2,})(?=[\sa-zA-Z'")\];:?]|,(?!\d)|$)/g, m, list = [];
  while ((m = re.exec(s))) list.push({ i: m.index + m[1].length, d: m[2] });
  if (!list.length) return s;
  var c = R.pick(list), at = 1 + R.int(c.d.length - 1);
  ctx.notes.push('numspace:' + c.d + '>' + c.d.slice(0, at) + ' ' + c.d.slice(at));
  return s.slice(0, c.i + at) + ' ' + s.slice(c.i + at);
}

/* ---------- copies ---------- */
// the order a mixed copy applies its transforms in; "check" marks where the numbers are compared (frac and numspace change how a number is
// written, never its value, and come after the check)
var ORDER = ['compress', 'shape', 'phi', 'glue', 'blanks', 'misspell', 'shuffle', 'typed', 'fig', 'label', 'lower', 'nostops', 'syntax', 'nospace', 'spaces', 'breaks', 'frac', 'numspace'];
var FN = { compress: tCompress, shape: tShape, phi: tPhi, glue: tGlue, blanks: tBlanks, misspell: tMisspell, shuffle: tShuffle, typed: tTyped, fig: tFig, label: tLabel,
  lower: tLower, nostops: tNostops, syntax: tSyntax, nospace: tNospace, spaces: tSpaces, breaks: tBreaks, frac: tFrac, numspace: tNumspace };
var LATE = { frac: 1, numspace: 1 };
var PROB = {
  light: { lower: 0.6, nostops: 0.5, glue: 0.4, shape: 0.4, misspell: 0.5, phi: 0.3, spaces: 0.3, breaks: 0.15, blanks: 0.4 },
  medium: { lower: 0.9, nostops: 0.8, glue: 0.7, shape: 0.6, misspell: 0.9, compress: 0.5, phi: 0.5, blanks: 0.6, typed: 0.2, fig: 0.15, label: 0.2, shuffle: 0.15,
    spaces: 0.5, nospace: 0.4, syntax: 0.3, breaks: 0.3, frac: 0.25 },
  heavy: { lower: 0.95, nostops: 0.9, glue: 0.9, shape: 0.8, misspell: 1, compress: 0.8, phi: 0.7, blanks: 0.8, typed: 0.35, fig: 0.3, label: 0.35, shuffle: 0.3,
    spaces: 0.8, nospace: 0.7, syntax: 0.6, breaks: 0.5, frac: 0.45, numspace: 0.25 }
};
var PURE = ['lower', 'nostops', 'shuffle', 'glue', 'misspell', 'misspell', 'typed', 'fig', 'label', 'shape', 'phi', 'compress', 'blanks', 'breaks', 'spaces', 'nospace', 'syntax', 'frac', 'numspace'];

// one copy from a spec {level, enabled:[names], seed}.  Each transform draws from its own stream (seed + name), so a copy replayed with one
// transform left out (the ablation in rough-cause.js) keeps every other transform's choices as far as the text allows.
function applySpec(q, spec, ctx0) {
  var s = String(q.text), ctx = { id: q.id, cleanRun: ctx0 && ctx0.cleanRun, notes: [], added: [] }, i, name, checked = false, ok = true, before;
  for (i = 0; i < ORDER.length; i++) {
    name = ORDER[i];
    if (LATE[name] && !checked) { checked = true; ok = checkNumbers(q.text, s, ctx.added); }
    if (spec.enabled.indexOf(name) < 0) continue;
    before = s;
    s = FN[name](s, rng(spec.seed + ':' + name), spec.level, ctx);
    if (s !== before && !ctx.notes.some(function (n) { return n.split(':')[0] === name || n.split(':')[0] === name + '-ordinary'; })) ctx.notes.push(name);
  }
  if (!checked) ok = checkNumbers(q.text, s, ctx.added);
  return { text: s, notes: ctx.notes, added: ctx.added, numbersOk: ok };
}
function checkNumbers(clean, rough, added) {
  var want = values(clean).concat(values(added.join(' '))).sort();
  return sameMultiset(want, values(rough));
}

function decide(level, R, q) {
  var P = PROB[level], en = [];
  ORDER.forEach(function (n) { if (P[n] && R.chance(P[n])) en.push(n); });
  return en;
}

function family(q) { return String(q.topic || q.id).replace(/[^a-z].*$/i, '') || String(q.id).replace(/-.*$/, ''); }

function generate(qs, opt) {
  var out = [], rej = { numbers: 0, unchanged: 0 }, cleanRun = opt.cleanRun || null, byFam = {};
  var keep = qs.filter(function (q) { return !cleanRun || answerCount(cleanRun[q.id]) > 0; });
  keep.forEach(function (q) { var f = family(q); (byFam[f] = byFam[f] || []).push(q); });
  function push(q, k, level, spec, kind, base2q) {
    var r = applySpec(q, spec, { cleanRun: cleanRun }), text = r.text, notes = r.notes, ok = r.numbersOk, rec;
    if (base2q) {
      var spec2 = { level: spec.level2, enabled: spec.enabled2, seed: spec.seed + ':B' }, r2 = applySpec(base2q, spec2, { cleanRun: cleanRun });
      ok = ok && r2.numbersOk;
      text = spec.fmt.replace('%A', function () { return text; }).replace('%B', function () { return r2.text; });
      notes = ['pair:' + spec.fmtName].concat(notes.map(function (n) { return 'A.' + n; }), r2.notes.map(function (n) { return 'B.' + n; }));
    }
    if (!ok) { rej.numbers++; return; }
    if (text === q.text && kind !== 'pair') { rej.unchanged++; return; }
    rec = { id: q.id + '~' + k, base: q.id };
    if (base2q) rec.base2 = base2q.id;
    rec.level = level; rec.kind = kind; rec.transforms = notes; rec.spec = spec; rec.text = text;
    if (q.defaults) rec.defaults = q.defaults;
    out.push(rec);
  }
  keep.forEach(function (q) {
    var R = rng(opt.seed + ':' + q.id), k, lv, n, seen = {};
    if (opt.pure) PURE.forEach(function (name) {
      n = seen[name] = (seen[name] || 0) + 1;
      push(q, name + (n > 1 ? n : ''), 'pure', { level: 'pure', enabled: [name], seed: opt.seed + ':' + q.id + ':pure:' + name + n }, 'pure');
    });
    ['light', 'medium', 'heavy'].forEach(function (level) {
      for (k = 1; k <= opt[level]; k++) {
        var en = decide(level, R, q), tries = 0;
        while (en.length < 2 && tries++ < 5) en = decide(level, R, q);
        push(q, level.charAt(0).toUpperCase() + k, level, { level: level, enabled: en, seed: opt.seed + ':' + q.id + ':' + level + k }, 'mix');
      }
    });
    for (k = 1; k <= opt.pairs; k++) {
      var fam = byFam[family(q)].filter(function (x) { return x.id !== q.id; });
      if (!fam.length) continue;
      var q2 = R.pick(fam), l1 = R.pick(['light', 'medium']), l2 = R.pick(['light', 'medium']);
      var fmts = [['(a) %A (b) %B', 'paren'], ['a) %A b) %B', 'close'], ['a) %A\nb) %B', 'close-nl'], ['a. %A b. %B', 'dot'], ['a %A b %B', 'bare']], f = R.pick(fmts);
      push(q, 'pair' + k, 'pair', { level: l1, enabled: decide(l1, R, q), level2: l2, enabled2: decide(l2, R, q2), seed: opt.seed + ':' + q.id + ':pair' + k, fmt: f[0], fmtName: f[1] }, 'pair', q2);
    }
  });
  return { copies: out, rejected: rej, questions: keep.length };
}

// answer lines of a run result (the same reading as rough-compare.js)
function answerCount(r) {
  var n = 0;
  if (!r || !r.parts) return 0;
  r.parts.forEach(function (p) { (p.write || []).forEach(function (l) { if (/^(?:ANSWER(?: \(step \d+\))?: |(?:ANSWER )?FOR YOUR BLANK \(|ANSWER TO "|CIRCLE: )/.test(l)) n++; }); });
  return n;
}

module.exports = { generate: generate, applySpec: applySpec, values: values, answerCount: answerCount, ORDER: ORDER, PURE: PURE };

if (require.main === module) {
  var a = process.argv.slice(2), inp = a[0], o = { out: null, seed: 'B1', light: 3, medium: 3, heavy: 3, pairs: 1, pure: true, cleanRun: null }, i;
  for (i = 1; i < a.length; i++) {
    if (a[i] === '--out') o.out = a[++i]; else if (a[i] === '--seed') o.seed = a[++i]; else if (a[i] === '--clean-run') o.cleanRun = JSON.parse(fs.readFileSync(a[++i], 'utf8'));
    else if (a[i] === '--no-pure') o.pure = false; else if (/^--(light|medium|heavy|pairs)$/.test(a[i])) o[a[i].slice(2)] = +a[++i];
  }
  if (!inp || !o.out) { console.error('usage: node harness/rough.js <clean.json> --out <rough.json> [--clean-run run.json] [--seed S] [--light N --medium N --heavy N --pairs N] [--no-pure]'); process.exit(2); }
  var res = generate(JSON.parse(fs.readFileSync(inp, 'utf8')), o);
  fs.writeFileSync(o.out, JSON.stringify(res.copies, null, 1));
  var byKind = {}; res.copies.forEach(function (c) { var k = c.kind === 'pure' ? 'pure:' + c.spec.enabled[0] : c.level; byKind[k] = (byKind[k] || 0) + 1; });
  console.log(res.copies.length + ' rough copies of ' + res.questions + ' questions -> ' + o.out + '  (rejected: ' + res.rejected.numbers + ' changed a number, ' + res.rejected.unchanged + ' unchanged)');
  console.log(JSON.stringify(byKind));
}
