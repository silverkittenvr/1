/* ==== wordsx.js ==== */
/* wordsx.js -- WORD questions, matched by which words occur and never by their order.  No DOM: it runs in the page and in node (wordsx-test.js).
     WORDSX.init(glossary, extra)       once; both are arrays of her entries (extra may be empty)
     WORDSX.analyze(questionText) ->  { mc, hits, top }
        mc    null, or { stem, options: [{ ch, text }], pick: null | { ch, text, why, sentence, term }, noLetterWhy: '' }
              ch is the letter as typed, lower case ('a'), or the number ('1'), or '' for a list without letters ("... modulus, yield strength, or hardness?"):
              then text is the option to copy.  noLetterWhy says in plain words why no letter is given.
        hits  [{ term, sentence, source, score, shared }] her entries that share at least two content words with the question (or whose whole name stands
              in it; or, in a question of three content words or fewer, one telling word), best first, at most 5
        top   { term, sentence, source, why }, set ONLY when one entry is clearly THE entry for the question; otherwise null: the page shows hits and does
              not choose.  For a multiple-choice question top is the entry behind the letter, or null.
        also  calculation: true when the text is a calculation (then mc null, hits [], top null); repaired: [{ from, to }] words read as a word of hers
              with two neighbouring letters swapped; n (her entry number) on pick, top and every hit; mc.layout; mc.margin and margin (the measured numbers)
   A letter is given only on a unique hit: a wrong letter is far worse than no letter.  Every sentence that comes out is her stored text, unchanged
   (all the quotes of the entry joined with " / "; an entry that has no sentence of hers shows its summary with its mark "SUMMARY (not her words ...").
   ES5 only.  ASCII only.  No regex lookbehind. */
(function (root) {
'use strict';
var WORDSX = {};

/* the margins, measured with wordsx-test.js (sets A to E); see the report of 2026-10-07 */
var CFG = {
  MC_RATIO: 1.5,        /* the picked option's entry must score this many times the best entry of every other option */
  MC_DIFF: 2.0,         /* and be ahead by this much weight */
  MC_MIN_SHARED: 2,     /* content words the stem shares with the picked entry's sentences */
  MC_MIN_COVER: 0.3,    /* share of the stem's weight that is found in the picked entry's sentences */
  MC_MIN_SCORE: 8,      /* the weight itself: two everyday words are not enough, two telling words are */
  MC_UNKNOWN_SHARED: 3, /* when another option is no name of hers at all: three shared words, */
  MC_UNKNOWN_SCORE: 12, /* this weight, */
  MC_UNKNOWN_RATIO: 2,  /* and twice the next option */
  TOP_RATIO: 1.4,       /* an open question: the best entry against the best entry on another subject */
  TOP_MIN_SHARED: 3,
  TOP_MIN_COVER: 0.34,
  HIT_MIN_SHARED: 2,
  MAX_HITS: 5
};
WORDSX.CFG = CFG;

function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function trim(s) { return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }
function collapse(s) { return trim(String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ')); }
function mkset(str) { var o = {}, a = str.split(' '), i; for (i = 0; i < a.length; i++) if (a[i]) o[a[i]] = true; return o; }
function keysOf(o) { var out = [], k; for (k in o) if (has(o, k)) out.push(k); return out; }

/* words that say nothing about the subject of a question */
var STOP = mkset('the a an of in to and or is are was were it its that this these those what why how does do did for with on at by be been as if not no nor from can could would '
  + 'should will may might which who whom when where there their they them you your we our she her his he into than then also each every any all some one two three four five '
  + 'name names list lists give gives state states define defines explain explains describe describes called call calls mean means meant briefly sentence sentences word words '
  + 'term terms use uses used using following answer answers question questions choose pick select best correct statement statements about most more very much many such so '
  + 'because while but has have had having being both either neither only just like known refer refers referred between during up down out over under again same other another per '
  + 'thing things something way kind type types happen happens happening without am me my mine blank fill identify identifies identified explanation reason reasons distinct '
  + 'distinction distinctions sketch show shows shown above below given must need needs termed occurs occur occurring taken take takes get gets got make makes made let lets say '
  + 'says said tell tells here now still yet ever etc eg ie vs versus mostly usually often class her hers terms course exam does '
  /* fillers of speech: her sentences are captions of what she said in class, and a filler that a question shares with one is no evidence */
  + 'actually really basically plus going know okay ok right well even back today way lot bit sort stuff look looking see saying talk talking want wants wanted think thinking '
  + 'guess maybe probably pretty quite yes yeah gonna put puts come comes came go goes went told ask asked remember everything anything nothing somebody everybody anybody');

/* words that turn a question round: no letter is given when the stem has one */
var NEG_RE = /\b(?:not|except|excluding|false|incorrect|never|least|cannot|can\s?'?t|neither|nor|untrue|wrong|worst|opposite|opposed|unlike|instead|rather\s+than|other\s+than|[a-z]+n't|isnt|doesnt|dont|arent|wont)\b/i;
/* an option that is one of these cannot be chosen from her sentences */
var ALLNONE_RE = /\ball\s+of\b|\bnone\s+of\b|\bboth\b|\bneither\b|\ball\s+(?:the\s+)?above\b|^\s*none\s*$|\bcannot\s+be\s+determined\b|\bnot\s+enough\b|\b[a-h]\s+(?:and|&)\s+[a-h]\b/i;
/* words that flip what an option says ("LOW strength-to-weight ratio"): an option with one of them must BE a name of hers, word for word */
var POL_WORDS = 'low lower lowest high higher highest poor good bad better worse worst weak weaker weakest strong stronger strongest small smaller smallest large larger '
  + 'largest big bigger biggest great greater greatest less lesser least more most zero lack lacks lacking never always brittle ductile sudden slow slower fast faster cheap '
  + 'cheaper cheapest expensive heavy heavier heaviest light lighter lightest short shorter shortest long longer longest minimum maximum minimal maximal increase increased '
  + 'increases increasing decrease decreased decreases decreasing reduce reduced reduces reducing unlimited limited negative positive opposite excessive insufficient '
  + 'inadequate adequate unsafe safe unstable stable deep deeper deepest shallow shallower thick thicker thin thinner wide wider narrow narrower';
var POL_RAW_RE = /\b(?:no|not|non|without|never|un[a-z]{4,}|in(?:elastic|adequate|sufficient|flexible|combustible))\b/i;
var POL = {};

/* everyday words a question may use for one of her terms; the term is added to the search with less weight (the table is order-free: one word or a short phrase) */
var LAY = [
  [/\b(?:pull(?:ed|ing|s)?|tug(?:s|ged|ging)?)\b/, 'tension tensile'],
  [/\b(?:stretch(?:ed|ing|es|y)?|elongat(?:e|es|ed|ing|ion)|lengthen(?:s|ed|ing)?|gets?\s+longer)\b/, 'strain elongation'],
  [/\b(?:push(?:ed|ing|es)?|squeez(?:e|ed|ing|es)|press(?:ed|ing|es)?|shorten(?:s|ed|ing)?)\b/, 'compression'],
  [/\b(?:squash(?:ed|ing|es)?|crush(?:ed|ing|es)?|flatten(?:s|ed|ing)?)\b/, 'crushing crushes yielding compression'],
  [/\b(?:bow(?:s|ed|ing)?|bends?\s+sideways|bending\s+sideways|kink(?:s|ed|ing)?|bulg(?:e|es|ed|ing))\b/, 'buckling buckle'],
  [/\b(?:snap(?:s|ped|ping)?|tear(?:s|ing)?|torn|tore|rip(?:s|ped|ping)?|break(?:s|ing)?|broke|broken|fractur(?:e|es|ed|ing)|pulls?\s+apart)\b/, 'rupture ripping'],
  [/\b(?:rust(?:s|ed|ing|y)?|corrod(?:e|es|ed|ing))\b/, 'corrosion rust'],
  [/\b(?:fire|heat(?:s|ed|ing)?|hot|burn(?:s|ing|ed)?|flames?|noncombustible|combustible|temperatures?)\b/, 'fire fireproofing heat temperatures'],
  [/\b(?:permanent(?:ly)?|irreversibl[ey])\b/, 'yield plastic permanently'],
  [/\b(?:springs?\s+back|returns?\s+to\s+(?:its\s+)?(?:original|first)\s+(?:shape|length)|recovers?)\b/, 'elastic'],
  [/\b(?:stiff(?:er|ness)?|rigidity)\b/, 'modulus elasticity stiffness'],
  [/\b(?:skinny|skinnier|slim(?:mer)?|lanky|long\s+and\s+thin|slender(?:ness)?)\b/, 'slender slenderness'],
  [/\b(?:weight\s+of\s+the\s+(?:building|structure|member|beam|slab)(?:\s+itself)?|self[\s-]?weight|own\s+weight)\b/, 'dead load'],
  [/\b(?:people|furniture|occupants?|movable)\b/, 'live load'],
  [/\b(?:wind|earthquakes?|seismic)\b/, 'lateral loads'],
  [/\b(?:cheap(?:er|est)?|econom(?:y|ical|ic)|least\s+expensive|lowest\s+cost)\b/, 'lightest economical'],
  [/\b(?:holes?\s+(?:punched|drilled|cut))\b/, 'bolt hole net area'],
  [/\b(?:zig[\s-]?zag(?:ged|s)?)\b/, 'stagger staggered'],
  [/\b(?:safety\s+margin|margin\s+of\s+safety)\b/, 'safety factor'],
  [/\b(?:tired|repeated\s+load(?:ing|s)?|cycles?|cyclic)\b/, 'fatigue'],
  [/\b(?:hangers?)\b/, 'tension member'],
  [/\b(?:posts?|struts?)\b/, 'column compression member'],
  [/\b(?:joists?)\b/, 'beam'],
  [/\b(?:large|big|great(?:\s+deal)?|significant|considerable)\b/, 'substantial'],
  [/\b(?:match(?:ing|es)?|accompanying)\b/, 'corresponding'],
  [/\b(?:ris(?:e|es|ing)|grows?)\b/, 'increase'],
  [/\b(?:plateau|flat\s+part)\b/, 'yield'],
  [/\b(?:unfactored)\b/, 'service working'],
  [/\b(?:curves?|graphs?|plots?)\b/, 'diagram'],
  [/\b(?:formulas?)\b/, 'equation'],
  [/\b(?:equations?)\b/, 'formula'],
  [/\b(?:fasteners?)\b/, 'bolt'],
  [/\b(?:hinged?|hinges)\b/, 'pinned pin'],
  [/\b(?:sway(?:s|ing)?)\b/, 'sidesway'],
  [/\b(?:flexur(?:e|al))\b/, 'bending'],
  [/\b(?:tubes?|hollow)\b/, 'hss'],
  [/\b(?:rigid\s+frames?)\b/, 'moment unbraced frame'],
  [/\b(?:demand)\b/, 'required factored load'],
  [/\b(?:resistance|capacity)\b/, 'strength'],
  [/\b(?:w|wt|hp|hss|mc|c|l)\s?[0-9]+(?:\s[0-9]+)?\s?x\s?[0-9]/, 'designation']
];
WORDSX.LAY = LAY;

/* ---------------------------------------------------------------------------------------------- words */
function norm(s) {
  return String(s === null || s === undefined ? '' : s).toLowerCase().replace(/[^\x00-\x7f]/g, ' ').replace(/w\/o/g, ' without ').replace(/\bwrt\b/g, ' with respect to ')
    .replace(/(\d),(?=\d\d\d(?!\d))/g, '$1').replace(/'s\b/g, '').replace(/'/g, '');
}
var TOKEN = /[a-z][a-z0-9]*|[0-9]+(?:[.\/][0-9]+)*(?:-[0-9]+)?/g;
function words(s) {
  var w = norm(s).match(TOKEN) || [], out = [], i, m;
  for (i = 0; i < w.length; i++) {
    out.push(w[i]);
    m = /^(hss|wt|hp|mc|st|mt)[0-9]/.exec(w[i]);                 /* HSS6x4x3/8, WT7x45: the family is a word of its own */
    if (m) out.push(m[1]);
  }
  return out;
}
function isContent(w) {
  if (has(STOP, w)) return false;
  if (/^[0-9]/.test(w)) return w.length >= 2;        /* 29000, 1/8, 3-2, 0.9; a lone digit says nothing */
  return w.length >= 2;
}

/* one word to its root, crude on purpose */
var IRR0 = { designation: 'designat', designations: 'designat', torn: 'tear', tore: 'tear', broke: 'break', broken: 'break', bent: 'bend', strong: 'strength', stronger: 'strength',
  strongest: 'strength', gross: 'gross', stress: 'stress', stresses: 'stress', axis: 'axis', axes: 'axis', analysis: 'analysis', radius: 'radius', radii: 'radius',
  modulus: 'modulus', moduli: 'modulus', lighter: 'light', lightest: 'light', heavier: 'heavy', heaviest: 'heavy', deeper: 'deep', deepest: 'deep', depth: 'depth',
  economy: 'econom', economic: 'econom', economical: 'econom', economically: 'econom', truss: 'truss', trusses: 'truss', less: 'less', mass: 'mass',
  ductile: 'ductil', ductility: 'ductil', tensile: 'tens', tension: 'tens', weigh: 'weight', weighs: 'weight', weighed: 'weight', lbs: 'lb', feet: 'ft', foot: 'ft', inches: 'in',
  inch: 'in', kips: 'kip', failure: 'fail', failures: 'fail', buckle: 'buckl', bolt: 'bolt', bolts: 'bolt', bolted: 'bolt', thickness: 'thick', thicknesses: 'thick',
  corrode: 'corros', corrodes: 'corros', corroded: 'corros', corroding: 'corros', stable: 'stabl', stability: 'stabl', instability: 'instabl', reduction: 'reduc',
  series: 'series', lateral: 'lateral', laterally: 'lateral' };
var IRR1 = { elongat: 'elong', deformat: 'deform', tensil: 'tens', failur: 'fail', corrod: 'corros', reduct: 'reduc', stabil: 'stabl', compressiv: 'compress', heavi: 'heavy' };
var SUFFIX = [['ations', '', 4], ['ation', '', 4], ['ness', '', 3], ['ity', '', 4], ['ally', 'al', 3], ['ions', '', 4], ['ion', '', 4], ['ive', '', 4], ['ing', '', 4], ['ies', 'y', 3],
  ['ed', '', 3], ['es', '', 3], ['ly', '', 4], ['s', '', 3], ['e', '', 3]];
function stem(w) {
  var i, s, round, changed, cut;
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (has(IRR0, w)) return IRR0[w];
  for (round = 0; round < 3; round++) {
    changed = false;
    for (i = 0; i < SUFFIX.length; i++) {
      s = SUFFIX[i][0];
      if (w.length - s.length >= SUFFIX[i][2] && w.slice(-s.length) === s) {
        if (s === 's' && /(?:ss|us|is)$/.test(w)) continue;
        cut = w.slice(0, w.length - s.length) + SUFFIX[i][1];
        w = cut; changed = true; break;
      }
    }
    if (!changed) break;
    if (has(IRR0, w)) return IRR0[w];
  }
  if (w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w) && !/(?:ss|ll)$/.test(w)) w = w.slice(0, -1);      /* pinned -> pin, stiff -> stif */
  if (has(IRR1, w)) w = IRR1[w];
  return w;
}
WORDSX.stem = stem;
function contentStems(s) {
  var w = words(s), out = [], i;
  for (i = 0; i < w.length; i++) if (w[i].length > 1 && isContent(w[i])) out.push(stem(w[i]));
  return out;
}
WORDSX.tokens = contentStems;

/* ---------------------------------------------------------------------------------------------- the index */
var IDX = null;
/* a bracket in a name of hers that says where the entry comes from, not what it is */
var BOOK_RE = /her\s+slides?|aisc|glossary|symbols|table\s*\d|slide|\bclass\b|\bspec\b|wk\s*\d|said\s+in|caption|garbled|anchor|manual|figure|diagram\s*\d|her\s+video|her\s+story|as\s+she|definition|her\s+list|p\.\s*\d|partly|her\s+week|^\s*vs\b|composition|availability/i;
var GENERIC = { steel: true, structur: true };

function quotesOf(e) {
  var out = [], i, d = e.definitions || [];
  for (i = 0; i < d.length; i++) if (d[i] && d[i].quote) out.push(String(d[i].quote));
  return out;
}
/* her stored text for one entry, exactly as stored; an entry that has no sentence of hers shows its summary WITH its mark */
function sentenceOf(e) {
  var q = quotesOf(e), s;
  if (q.length) return q.join(' / ');
  s = trim(e.summary);
  if (!s) return '';
  return /^SUMMARY\b/.test(s) ? s : 'SUMMARY (not her words): ' + s;
}
WORDSX.sentenceOf = sentenceOf;
function setKey(set) {
  var k = keysOf(set), out = [], i;
  for (i = 0; i < k.length; i++) if (!has(GENERIC, k[i])) out.push(k[i]);
  if (!out.length) return '';
  out.sort();
  return out.join(' ');
}
function buildDoc(e) {
  var d = { e: e, tf: {}, len: 0, sent: {}, aux: {}, full: {}, names: [], nameUnion: {}, syms: {}, nots: [], symNames: {} };
  var term = String(e.term || ''), quotes = quotesOf(e), syn = e.synonyms || [], notes = e.notes || [], answers = e.answers || [], i, core, inner, parts, fullName, m;
  function add(text, weight, where) {
    var t = contentStems(text), j;
    for (j = 0; j < t.length; j++) {
      d.tf[t[j]] = (d.tf[t[j]] || 0) + weight; d.len += weight; d.full[t[j]] = true;
      if (where === 'sent') d.sent[t[j]] = true; else if (where === 'aux') d.aux[t[j]] = true;
    }
  }
  function addName(raw, isTerm) {
    var w = words(raw), set = {}, n = 0, syms = {}, ns = 0, j, st;
    for (j = 0; j < w.length; j++) {
      if (w[j].length === 1 && /[a-z]/.test(w[j])) { if (w[j] !== 'a') { syms[w[j]] = true; ns++; d.syms[w[j]] = true; } continue; }
      if (!isContent(w[j])) continue;
      st = stem(w[j]);
      if (!has(set, st)) { set[st] = true; n++; }
      d.nameUnion[st] = true;
    }
    if (!n && !ns) return;
    if (!n && ns === 1) d.symNames[keysOf(syms)[0]] = true;                 /* a name that is one symbol: "e", "what is e" */
    if (n === 1 && keysOf(set)[0].length <= 3) d.symNames[keysOf(set)[0]] = true;      /* "fy", "zx", "hss" */
    d.names.push({ raw: raw, set: set, n: n, syms: syms, isTerm: !!isTerm, key: setKey(set) });
  }
  add(term, 3, null); add(syn.join(' . '), 2, 'aux'); add(quotes.join(' . '), 1.5, 'sent');
  add(notes.join(' . '), 0.4, 'aux'); add(String(e.summary || ''), 0.7, quotes.length ? 'aux' : 'sent'); add(answers.join(' . '), 1.5, 'aux'); add(String(e.topic || ''), 0.5, null);
  /* names: the term without its brackets, its parts ("Yield strength / yielding", "Load path: slab to beam ..."), the term with the brackets that are not bookkeeping, the synonyms */
  core = term.replace(/\([^)]*\)/g, ' ');
  inner = [];
  term.replace(/\(([^)]*)\)/g, function (all, x) { if (!BOOK_RE.test(x)) inner.push(x); return all; });
  addName(core, true);
  parts = core.split(/\s+\/\s+|\s+vs\.?\s+|:\s+|\s+=\s+|\s+--\s+/);
  if (parts.length > 1) for (i = 0; i < parts.length; i++) addName(parts[i], i === 0);
  if (inner.length) {
    fullName = core + ' ' + inner.join(' ');
    addName(fullName, true);
    for (i = 0; i < inner.length; i++) {
      m = words(inner[i]);
      if (m.length === 1 && m[0].length <= 3) addName(inner[i], false);       /* "(Fy)", "(s)", "(phi)" */
    }
  }
  for (i = 0; i < syn.length; i++) addName(String(syn[i]), false);
  for (i = 0; i < (e.not || []).length; i++) { m = contentStems(String(e.not[i])); if (m.length) d.nots.push({ set: mkset(m.join(' ')), n: keysOf(mkset(m.join(' '))).length }); }
  d.sentence = sentenceOf(e);
  d.quoteKeys = quotes.map(function (q) { return collapse(norm(q)); }).filter(function (q) { return q.length >= 12; });
  return d;
}
WORDSX.init = function (glossary, extra) {
  var G = (glossary || []).concat(extra || []), docs = [], df = {}, total = 0, i, j, k, d, byKey = {}, byQuote = {}, list, a, b, vocab = {}, w, p;
  p = POL_WORDS.split(' ');
  for (i = 0; i < p.length; i++) POL[p[i]] = true;
  for (i = 0; i < G.length; i++) {
    if (!G[i] || typeof G[i] !== 'object') continue;
    d = buildDoc(G[i]); d.i = docs.length; d.sib = {};
    for (k in d.full) if (has(d.full, k)) df[k] = (df[k] || 0) + 1;
    total += d.len;
    /* the raw words of her store: a typed word that is none of them and one slip away from one of them is read as that word */
    w = norm([G[i].term, (G[i].synonyms || []).join(' '), quotesOf(G[i]).join(' '), (G[i].notes || []).join(' '), G[i].summary || '', (G[i].answers || []).join(' ')].join(' ')).match(/[a-z]{3,}/g) || [];
    for (j = 0; j < w.length; j++) vocab[w[j]] = (vocab[w[j]] || 0) + 1;
    docs.push(d);
  }
  /* entries on the same subject: a shared name, or the same sentence of hers stored twice */
  for (i = 0; i < docs.length; i++) {
    d = docs[i];
    for (j = 0; j < d.names.length; j++) {
      if (!d.names[j].key) continue;
      if (d.names[j].n >= 2 || d.names[j].isTerm) { if (!has(byKey, d.names[j].key)) byKey[d.names[j].key] = {}; byKey[d.names[j].key][i] = true; }
    }
    for (j = 0; j < d.quoteKeys.length; j++) { if (!has(byQuote, d.quoteKeys[j])) byQuote[d.quoteKeys[j]] = {}; byQuote[d.quoteKeys[j]][i] = true; }
  }
  function link(map) {
    var key, ids, x, y;
    for (key in map) {
      if (!has(map, key)) continue;
      ids = keysOf(map[key]);
      if (ids.length < 2 || ids.length > 12) continue;
      for (x = 0; x < ids.length; x++) for (y = 0; y < ids.length; y++) if (x !== y) docs[+ids[x]].sib[+ids[y]] = true;
    }
  }
  link(byKey); link(byQuote);
  IDX = { docs: docs, df: df, n: docs.length, avg: docs.length ? total / docs.length : 1, vocab: vocab };
  return IDX;
};
function idf(k) {
  var d = IDX.df[k] || 0;
  if (!d) return 1.5;                                  /* a word her store never uses: it counts, but it must not drown the rest */
  return Math.log(1 + (IDX.n - d + 0.5) / (d + 0.5));
}

/* ---------------------------------------------------------------------------------------------- rough typing */
/* true when b is a with two neighbouring letters swapped (swapOnly), or with one letter changed, dropped or added */
function oneSlip(a, b, mode) {
  var la = a.length, lb = b.length, i, j, diff;
  if (la === lb) {
    i = 0; while (i < la && a.charAt(i) === b.charAt(i)) i++;
    if (i === la) return false;
    if (i + 1 < la && a.charAt(i) === b.charAt(i + 1) && a.charAt(i + 1) === b.charAt(i) && a.slice(i + 2) === b.slice(i + 2)) return true;
    if (mode !== 'all') return false;
    return a.slice(i + 1) === b.slice(i + 1);
  }
  if (mode === 'swap' || Math.abs(la - lb) !== 1) return false;
  if (la > lb) { i = a; a = b; b = i; la = a.length; lb = b.length; }
  i = 0; j = 0; diff = 0;
  while (i < la && j < lb) { if (a.charAt(i) === b.charAt(j)) { i++; j++; } else { diff++; if (diff > 1) return false; j++; } }
  return true;
}
function knownWord(w) {
  var i;
  if (has(STOP, w) || has(IDX.vocab, w)) return true;
  if (has(IDX.df, stem(w))) return true;
  for (i = 0; i < LAY.length; i++) if (LAY[i][0].test(w)) return true;
  return false;
}
WORDSX.knownWord = function (w) { return knownWord(String(w).toLowerCase()); };
/* stricter, for the words of an option: the word itself is hers, or a regular form of a word of hers (girder / girders, yield / yielding, brace / bracing).
   A root alone is not enough: "hardeing" has the root of "hard" and is still a slip for "hardening". */
var FORMS = ['s', 'es', 'd', 'ed', 'ing', 'ly', 'al', 'ally', 'er', 'est', 'ity', 'ness', 'ion', 'ions', 'ive'];
function ownWord(w) {
  var i, s, base;
  if (has(STOP, w) || has(IDX.vocab, w)) return true;
  for (i = 0; i < LAY.length; i++) if (LAY[i][0].test(w)) return true;
  for (i = 0; i < FORMS.length; i++) {
    s = FORMS[i];
    if (has(IDX.vocab, w + s)) return true;
    if (w.length - s.length >= 3 && w.slice(-s.length) === s) {
      base = w.slice(0, w.length - s.length);
      if (has(IDX.vocab, base) || (/^[aei]/.test(s) && has(IDX.vocab, base + 'e'))) return true;      /* brac-ing from brace; but not "bracd" */
      if (/([b-df-hj-np-tv-z])\1$/.test(base) && has(IDX.vocab, base.slice(0, -1))) return true;
    }
    if (/e$/.test(w) && has(IDX.vocab, w.slice(0, -1) + s)) return true;
  }
  return false;
}
/* a word of her store that is one slip (a swap, or a letter changed, dropped or added) from w; null when there is none */
function nearWord(w) {
  var c;
  for (c in IDX.vocab) if (has(IDX.vocab, c) && Math.abs(c.length - w.length) <= 1 && oneSlip(w, c, 'all')) return c;
  return null;
}
function repairWord(w) {
  var best = null, bestN = 0, tie = false, c, n;
  if (w.length < 4 || knownWord(w)) return w;
  for (c in IDX.vocab) {
    if (!has(IDX.vocab, c) || Math.abs(c.length - w.length) > 1) continue;
    /* two neighbouring letters swapped, and nothing else: measured on 1353 correctly typed texts, repairing a changed, dropped or added letter turned
       38 good English words that are not in her store into words of hers ("cooling" -> "cooking", "cables" -> "tables"); a swap did that once.
       (The page's own spelling repair, which has a dictionary, runs before this module.) */
    if (!oneSlip(w, c, 'swap')) continue;
    n = IDX.vocab[c];
    if (n > bestN) { best = c; bestN = n; tie = false; } else if (n === bestN && c !== best) tie = true;
  }
  return best && !tie ? best : w;
}
function repairText(text, log) {
  return String(text).replace(/[A-Za-z]{4,}/g, function (w) {
    var low = w.toLowerCase(), r = repairWord(low);
    if (r === low) return w;
    log.push({ from: w, to: r });
    return r;
  });
}

/* ---------------------------------------------------------------------------------------------- a question as a bag of words */
function makeQuery(text) {
  var w = words(text), q = { lit: {}, order: [], raw: {}, syms: {}, lay: [] }, low = ' ' + collapse(norm(text).replace(/[^a-z0-9]+/g, ' ')) + ' ', i, st, m;
  for (i = 0; i < w.length; i++) {
    if (w[i].length === 1 && /[a-z]/.test(w[i])) { if (w[i] !== 'a' && w[i] !== 'i') q.syms[w[i]] = true; continue; }
    if (!isContent(w[i])) continue;
    st = stem(w[i]);
    if (!has(q.lit, st)) { q.lit[st] = 1; q.order.push(st); q.raw[st] = w[i]; } else q.lit[st]++;
  }
  for (i = 0; i < LAY.length; i++) {
    m = LAY[i][0].exec(low);
    if (m) q.lay.push({ trigger: collapse(m[0]), own: contentStems(m[0]), stems: contentStems(LAY[i][1]) });
  }
  return q;
}
/* the symbol a question asks about: "in which E is", "what is E", "the symbol Fy" */
var NOTSYM = mkset('it he she we us me my no so do go up ok hi if or an as at by be in is of on to the and for its his her our you one two six ten any all per why how who can may was has '
  + 'had did not now new old few big top end use yes a');
function askedSymbol(text) {
  var t = ' ' + collapse(String(text).toLowerCase().replace(/\(\s*(?:choose|circle|select)[^)]*\)/g, ' ').replace(/[^a-z0-9?]+/g, ' ')) + ' ', m;
  m = /\b(?:in which|where|wherein|in (?:this|the|that) (?:expression|formula|equation)(?: above)?)\s+(?:the\s+)?(?:symbol\s+|letter\s+|term\s+|variable\s+)?([a-z]{1,3})\s+(?:is|stands for|represents|denotes|means|refers to|equals)\b/.exec(t)
    || /\bwhat\s+(?:is|does|are)\s+(?:the\s+)?(?:symbol\s+|letter\s+|term\s+|variable\s+)?([a-z]{1,3})\s*(?:\?|stand|represent|mean|denote|in\s|for\s|its\s|and\s|$)/.exec(t)
    || /\bthe\s+(?:symbol|letter|variable)\s+([a-z]{1,3})\b/.exec(t);
  if (!m || has(NOTSYM, m[1])) return null;
  return m[1];
}

/* how much of a question one entry's SENTENCES hold: her sentences count in full, what we wrote about them (other wordings, notes) counts half */
function evidence(q, d) {
  var s = 0, total = 0, shared = [], i, j, k, w, L, hit, own;
  for (i = 0; i < q.order.length; i++) {
    k = q.order[i]; w = idf(k); total += w;
    if (has(d.sent, k)) { s += w; shared.push(q.raw[k]); }
    else if (has(d.aux, k)) s += 0.5 * w;
  }
  for (i = 0; i < q.lay.length; i++) {
    L = q.lay[i]; hit = 0; own = false;
    for (j = 0; j < L.own.length; j++) if (has(d.sent, L.own[j])) own = true;
    if (own) continue;                                   /* she uses the everyday word herself: counted above */
    for (j = 0; j < L.stems.length; j++) if (has(d.sent, L.stems[j]) && !has(q.lit, L.stems[j])) hit = Math.max(hit, idf(L.stems[j]));
    if (hit) { s += 0.6 * hit; shared.push(L.trigger); }
  }
  return { s: s, shared: shared, cover: total ? Math.min(1, s / total) : 0 };
}
/* the question's words that an entry has anywhere (name, other wordings, sentences, notes): shown next to a hit */
function sharedAnywhere(q, d) {
  var out = [], i, j, k, L, own, hit;
  for (i = 0; i < q.order.length; i++) { k = q.order[i]; if (has(d.full, k)) out.push(q.raw[k]); }
  for (i = 0; i < q.lay.length; i++) {
    L = q.lay[i]; own = false; hit = false;
    for (j = 0; j < L.own.length; j++) if (has(d.full, L.own[j])) own = true;
    if (own) continue;
    for (j = 0; j < L.stems.length; j++) if (has(d.full, L.stems[j]) && !has(q.lit, L.stems[j])) hit = true;
    if (hit) out.push(L.trigger);
  }
  return out;
}
function subsetOf(a, b) { var k; for (k in a) if (has(a, k) && !has(b, k)) return false; return true; }

/* every entry against an open question, best first */
function rank(q, sym) {
  var out = [], K1 = 1.2, B = 0.6, i, j, k, d, s, f, w, L, hit, nm, best, bonus, sum, cancel, t, nameLit = q.nameLit || q.lit, shortQ = q.order.length <= 4, symShared, numeric;
  for (i = 0; i < IDX.docs.length; i++) {
    d = IDX.docs[i]; s = 0; symShared = [];
    for (j = 0; j < q.order.length; j++) {
      k = q.order[j];
      if (!has(d.tf, k)) continue;
      f = d.tf[k];
      s += Math.min(q.lit[k], 2) * idf(k) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / IDX.avg));
    }
    for (j = 0; j < q.lay.length; j++) {
      L = q.lay[j]; hit = 0;
      for (k = 0; k < L.stems.length; k++) {
        t = L.stems[k];
        if (has(q.lit, t) || !has(d.tf, t)) continue;
        f = d.tf[t];
        hit = Math.max(hit, idf(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / IDX.avg)));
      }
      s += 0.5 * hit;
    }
    /* a whole name of hers in the question, its words in any order, is a strong sign; a name the entry says it is NOT takes it back */
    best = null; bonus = 0;
    for (j = 0; j < d.names.length; j++) {
      nm = d.names[j];
      if (!nm.n || !subsetOf(nm.set, nameLit)) continue;
      sum = 0;
      for (k in nm.set) if (has(nm.set, k)) sum += idf(k);
      if (sum > bonus) { bonus = sum; best = nm; }
    }
    cancel = false;
    if (best) for (j = 0; j < d.nots.length; j++) if (d.nots[j].n > best.n && subsetOf(d.nots[j].set, nameLit)) cancel = true;
    if (best && !cancel) s += 0.8 * bonus;
    if (cancel) s *= 0.6;
    /* a lone letter of the question that is a symbol of hers: "U for a tee", "S from Z", "K factor".  It counts where the entry is NAMED by it; in a short question also where a name holds it */
    w = false;
    for (k in q.syms) {
      if (!has(q.syms, k)) continue;
      if (has(d.symNames, k)) { s += 2.4; symShared.push(k.toUpperCase()); w = true; }
      else if (shortQ && has(d.syms, k)) { s += 1; symShared.push(k.toUpperCase()); }
    }
    /* a "why" question is answered by an entry of hers that gives a reason */
    if (q.why && s > 0 && (d.e.kind === 'reason' || /^why\b/i.test(String(d.e.term || '')))) s *= 1.2;
    numeric = true;
    if (best) for (k in best.set) if (has(best.set, k) && !/^[0-9]/.test(k)) numeric = false;
    if (s > 0 || (sym && has(d.symNames, sym))) out.push({ d: d, s: s, name: best && !cancel && !numeric ? best : null, symShared: symShared, symName: w });
  }
  /* a question that asks what a symbol is: the entries that carry that symbol as a name go to the front */
  if (sym) {
    best = 0;
    for (i = 0; i < out.length; i++) if (out[i].s > best) best = out[i].s;
    for (i = 0; i < out.length; i++) if (has(out[i].d.symNames, sym)) out[i].s += 2 + 0.75 * best;
  }
  out.sort(function (a, b) { return b.s - a.s || a.d.i - b.d.i; });
  return out;
}

/* ---------------------------------------------------------------------------------------------- multiple choice: reading the layout */
function stripTail(t) {
  var prev;
  do {
    prev = t;
    t = t.replace(/\s+$/, '');
    t = t.replace(/(?:^|\s)\S*_{2,}\S*$/, '');                                     /* an answer blank and whatever is glued to it: "____.", "W____x____" */
    t = t.replace(/[\s;:,]*\b(?:answer(?:\s+blank)?|ans)\s*:?\s*$/i, '');
  } while (t !== prev);
  return t;
}
function cleanOption(s) {
  return collapse(String(s).replace(/\s+\S*_{2,}[\s\S]*$/, '')).replace(/^[\s,;:.\-]+/, '').replace(/[\s,;.]+$/, '').replace(/\s+(?:or|and)$/i, '').replace(/[\s,;.]+$/, '');
}
/* a part of a calculation or a question of its own is not an option */
var SUBQ_RE = /^(?:why|how|what|which|when|where|does|do|did|if|determine|calculate|compute|find|explain|state|give|name|list|select|check|draw|sketch|show|describe|identify)\b/i;
function optionsOk(opts) {
  var i, t;
  if (opts.length < 2) return false;
  for (i = 0; i < opts.length; i++) {
    t = opts[i].text;
    if (!t) return false;
    if (/_{2,}|\?|=\s*$/.test(t)) return false;
    if (SUBQ_RE.test(t)) return false;
    if (t.split(' ').length > 14) return false;
  }
  return true;
}
function runFrom(marks, minLen, t) {
  var best = null, i, j, run, want, first;
  for (i = 0; i < marks.length; i++) {
    first = marks[i].ch;
    if (first !== 'a' && first !== '1') continue;
    run = [marks[i]];
    for (j = i + 1; j < marks.length; j++) {
      want = first === '1' ? String(run.length + 1) : String.fromCharCode(97 + run.length);
      if (marks[j].ch !== want || marks[j].style !== marks[i].style || marks[j].at <= run[run.length - 1].end) continue;
      /* "... overall depth d. d. radius ...": the same mark twice with nothing between is a symbol and then the letter */
      if (j + 1 < marks.length && marks[j + 1].ch === want && marks[j + 1].style === marks[j].style && !/\S/.test(t.slice(marks[j].end, marks[j + 1].at))) continue;
      run.push(marks[j]);
    }
    if (run.length < minLen(run[0].style)) continue;
    /* the longest run; of two equally long ones the later start (an "a" in the stem is the article) */
    if (!best || run.length > best.length || (run.length === best.length && run[0].at > best[0].at)) best = run;
  }
  return best;
}
function build(t, run, layout) {
  var stem0 = collapse(t.slice(0, run[0].at)).replace(/[\s:;,\-]+$/, ''), opts = [], i;
  for (i = 0; i < run.length; i++) opts.push({ ch: run[i].ch, text: cleanOption(t.slice(run[i].end, i + 1 < run.length ? run[i + 1].at : t.length)) });
  if (!stem0 || stem0.split(' ').length < 2 || !optionsOk(opts)) return null;
  return { stem: stem0, options: opts, layout: layout };
}
/* "(a) ...", "a) ...", "A. ...", "1. ..." -- on their own lines or inline after the stem */
function parseMarked(t) {
  var re = /(^|[^A-Za-z0-9_])(\(?)([A-Ha-h]|[1-8])([).])(?=\s|$)/g, m, marks = [], kind, run;
  while ((m = re.exec(t))) {
    if (m[2] && m[4] === '.') continue;
    kind = /[0-9]/.test(m[3]) ? 'n' : (m[3] === m[3].toLowerCase() ? 'l' : 'U');
    marks.push({ at: m.index + m[1].length, end: re.lastIndex, ch: m[3].toLowerCase(), style: (m[2] ? '(' : '') + kind + m[4] });
  }
  run = runFrom(marks, function (style) { return style.indexOf('n') >= 0 || style.indexOf('.') >= 0 ? 3 : 2; }, t);
  return run ? build(t, run, 'marked ' + run[0].style) : null;
}
/* a bare letter at the start of a line, its words after it or on the next line ("a" / "the modulus of elasticity" / "b" / ...) */
function parseLineLetters(t) {
  var re = /(^|\n)[ \t]*([A-Ha-h])(?=[ \t]*(?:\n|$)|[ \t]+\S)/g, m, marks = [], run;
  while ((m = re.exec(t))) marks.push({ at: m.index + m[1].length, end: re.lastIndex, ch: m[2].toLowerCase(), style: m[2] === m[2].toLowerCase() ? 'l' : 'U' });
  run = runFrom(marks, function () { return 3; }, t);
  return run ? build(t, run, 'letters at line starts') : null;
}
/* letters with no brackets and no line breaks: "... is (choose one): a Plastic section modulus Zx b Flange width bf c Overall depth d d Radius of gyration r".
   A letter that stands twice in a row ("d d") is a symbol that ends one option and then the letter of the next. */
function parseInlineLetters(t) {
  var flat = collapse(t), re = /(^|\s)([A-Ha-h])(?=\s|$)/g, m, c = [], i, j, bi, a, run, cur, want, pick, before, strong;
  while ((m = re.exec(flat))) c.push({ at: m.index + m[1].length, end: m.index + m[1].length + 1, ch: m[2].toLowerCase(), up: m[2] !== m[2].toLowerCase() });
  function nextMark(from, letter, up) {
    var x, first = -1;
    for (x = from; x < c.length; x++) {
      if (c[x].ch !== letter || c[x].up !== up) continue;
      if (first < 0) first = x;
      if (x + 1 < c.length && c[x + 1].ch === letter && c[x + 1].at === c[x].end + 1) continue;      /* "d d": the second one is the letter */
      return x;
    }
    return first;
  }
  /* an "a" straight after a colon, a question mark or a bracket opens the options: nothing before it is a letter */
  strong = -1;
  for (i = 0; i < c.length; i++) if (c[i].ch === 'a' && /[:?)]$/.test(flat.slice(0, c[i].at).replace(/\s+$/, ''))) strong = i;
  for (bi = strong + 1; bi < c.length; bi++) {
    if (c[bi].ch !== 'b') continue;
    /* the "a" that opens the options: the last one before this "b" that follows a colon, a question mark or a bracket; else the last one that leaves words for option a */
    a = -1; strong = -1;
    for (i = 0; i < bi; i++) {
      if (c[i].ch !== 'a' || c[i].up !== c[bi].up || c[bi].at - c[i].end < 3) continue;
      a = i;
      before = flat.slice(0, c[i].at).replace(/\s+$/, '');
      if (/[:?)]$/.test(before)) strong = i;
    }
    if (strong >= 0) a = strong;
    if (a < 0) continue;
    j = nextMark(bi, 'b', c[bi].up);
    run = [c[a], c[j]]; cur = j;
    for (;;) {
      want = String.fromCharCode(97 + run.length);
      pick = -1;
      for (i = cur + 1; i < c.length; i++) if (c[i].ch === want && c[i].up === c[a].up && c[i].at - c[cur].end >= 3) { pick = nextMark(i, want, c[a].up); break; }
      if (pick < 0) break;
      run.push(c[pick]); cur = pick;
    }
    if (run.length < 3) continue;
    for (i = 0; i < run.length; i++) run[i] = { at: run[i].at, end: run[i].end, ch: run[i].ch };
    a = build(flat, run, 'letters in one line');
    if (a) return a;
  }
  return null;
}
/* a bare list: "... identifies: modulus, yield strength, ultimate strength, or hardness?" */
var LISTVERB_RE = /\b(?:is|are|was|were|which|that|used|has|have|does|do|will|can)\b/i;
function shortPiece(s) { s = collapse(s); return !!s && s.split(' ').length <= 6 && !LISTVERB_RE.test(s); }
function parseBareList(t) {
  var flat = collapse(t).replace(/[?.!\s]+$/, ''), low = flat.toLowerCase(), at = low.lastIndexOf(' or '), head, last, pieces, first, cut, stem0, opts = [], i, cues, k, p, from;
  if (at < 0) return null;
  head = flat.slice(0, at); last = flat.slice(at + 4);
  cut = head.lastIndexOf(':');
  if (cut >= 0) {
    /* the list is what stands after the last colon */
    stem0 = head.slice(0, cut); pieces = head.slice(cut + 1).split(',');
    if (pieces.length < 2) return null;
    first = pieces[0]; from = 1;
  } else {
    /* no colon: the options are the short pieces at the end; the piece before them holds the end of the stem and the first option, parted by "is", "called" ... */
    pieces = head.split(',');
    if (pieces.length < 2) return null;
    from = pieces.length;
    while (from > 1 && (shortPiece(pieces[from - 1]) || !collapse(pieces[from - 1]))) from--;
    first = pieces[from - 1];
    cues = [' is it ', ' identifies ', ' is called ', ' are called ', ' called ', ' termed ', ' means ', ' is ', ' are '];
    p = -1;
    for (k = 0; k < cues.length && p < 0; k++) { p = first.toLowerCase().lastIndexOf(cues[k]); if (p >= 0) p = p + cues[k].length - 1; }
    if (p < 0) return null;
    stem0 = pieces.slice(0, from - 1).concat([first.slice(0, p + 1)]).join(','); first = first.slice(p + 1);
  }
  stem0 = collapse(stem0).replace(/[\s:;,\-]+$/, '');
  opts.push({ ch: '', text: cleanOption(first) });
  for (i = from; i < pieces.length; i++) if (collapse(pieces[i])) opts.push({ ch: '', text: cleanOption(pieces[i]) });
  opts.push({ ch: '', text: cleanOption(last) });
  if (opts.length < 3 || stem0.split(' ').length < 3) return null;
  for (i = 0; i < opts.length; i++) {
    if (!opts[i].text || opts[i].text.split(' ').length > 6 || LISTVERB_RE.test(opts[i].text) || /\d\s*(?:kips?|ksi|psf|plf|pcf|ft|in\b|lb)/i.test(opts[i].text)) return null;
  }
  if (!optionsOk(opts)) return null;
  return { stem: stem0, options: opts, layout: 'bare list' };
}
function parseMC(text) {
  var t = stripTail(String(text === null || text === undefined ? '' : text).replace(/\r/g, ''));
  return parseMarked(t) || parseLineLetters(t) || parseInlineLetters(t) || parseBareList(t);
}
WORDSX.parseMC = parseMC;

/* ---------------------------------------------------------------------------------------------- multiple choice: a letter only on a unique hit */
var NEGATOR = mkset('no not non without never lack lacks lacking zero none');
function optionBag(text) {
  var w = words(text), o = { set: {}, n: 0, syms: {}, pol: false, raw: text, neg: [] }, i, st;
  for (i = 0; i < w.length; i++) {
    if (has(NEGATOR, w[i])) { o.neg.push(w[i]); o.pol = true; }
    if (w[i].length === 1 && /[a-z]/.test(w[i])) { if (w[i] !== 'a') o.syms[w[i]] = true; continue; }
    if (!isContent(w[i])) continue;
    st = stem(w[i]);
    if (has(POL, w[i])) o.pol = true;
    if (!has(o.set, st)) { o.set[st] = true; o.n++; }
  }
  if (POL_RAW_RE.test(text)) o.pol = true;
  return o;
}
/* her entries for one option.  exact: a name of hers IS the option.  strict: the option holds a whole name of hers and every word of it is a word of her names.
   loose: the option holds a whole name of hers, or is a part of one (the option gets the benefit of these when it is a RIVAL, never when it is the one picked). */
function mapOption(o) {
  var out = { exact: [], strict: [], loose: [] }, i, j, k, d, nm, isExact, isStrict, isLoose, okNeg, rawWords, symOnly = !o.n && keysOf(o.syms).length === 1 ? keysOf(o.syms)[0] : null;
  for (i = 0; i < IDX.docs.length; i++) {
    d = IDX.docs[i]; isExact = false; isStrict = false; isLoose = false;
    if (symOnly) { if (has(d.symNames, symOnly)) { out.exact.push(d); out.strict.push(d); out.loose.push(d); } continue; }
    if (!o.n) continue;
    for (j = 0; j < d.names.length; j++) {
      nm = d.names[j];
      if (!nm.n) continue;
      /* the option holds a whole name of hers: its words AND its symbols ("I + Ad^2" is not the name "Ad^2") */
      if (subsetOf(nm.set, o.set) && subsetOf(nm.syms, o.syms)) {
        isLoose = true;
        if (nm.n === o.n) {
          /* word for word: a "no" / "not" / "without" of the option must stand in her name too */
          okNeg = true;
          if (o.neg.length) { rawWords = words(nm.raw); for (k = 0; k < o.neg.length; k++) if (rawWords.indexOf(o.neg[k]) < 0) okNeg = false; }
          if (okNeg) isExact = true;
        }
        if (subsetOf(o.set, d.nameUnion)) isStrict = true;
      } else if (subsetOf(o.set, nm.set)) isLoose = true;
    }
    if (isExact) out.exact.push(d);
    if (isExact || isStrict) out.strict.push(d);
    if (isLoose) out.loose.push(d);
  }
  return out;
}
function letterOf(o) { return o.ch ? '(' + o.ch + ')' : '"' + o.text + '"'; }
function choose(mc, text) {
  var q = makeQuery(mc.stem), n = mc.options.length, bags = [], maps = [], best = [], rival = [], i, j, k, d, ev, x, y, seen, dup, top1, top2, sym, withSym, supp, w, unknown;
  mc.pick = null; mc.noLetterWhy = '';
  if (NEG_RE.test(mc.stem)) { mc.noLetterWhy = 'the question says NOT / EXCEPT / LEAST or the like: her sentences say what IS so, the page does not turn them round'; return; }
  for (i = 0; i < n; i++) {
    if (ALLNONE_RE.test(mc.options[i].text)) { mc.noLetterWhy = 'one option is "all / none / both of ...": her sentences cannot decide that'; return; }
    bags.push(optionBag(mc.options[i].text)); maps.push(mapOption(bags[i]));
  }
  /* an option with a word that is none of hers but ONE SLIP from a word of hers is probably mistyped: it cannot be weighed, and it may be the right one */
  for (i = 0; i < n; i++) {
    w = (mc.options[i].text.toLowerCase().match(/[a-z]{3,}/g) || []);
    for (j = 0; j < w.length; j++) {
      if (ownWord(w[j])) continue;
      k = nearWord(w[j]);
      if (k) {
        mc.noLetterWhy = 'option ' + letterOf(mc.options[i]) + ' has the word "' + w[j] + '", which is none of hers but one slip from her word "' + k + '": if it is mistyped, correct it and ask again';
        return;
      }
    }
  }
  for (i = 0; i < n; i++) {
    if (bags[i].pol && !maps[i].exact.length) {
      mc.noLetterWhy = 'option ' + letterOf(mc.options[i]) + ' carries a word that can flip its meaning (low, poor, no, brittle ...) and is not a name of hers word for word';
      return;
    }
  }
  /* two options that are the same entry of hers: her sentences cannot tell them apart, so neither of the two is ever given.
     (A third option can still be given: the two that share an entry are then both ruled out by the same sentences.) */
  seen = {}; dup = {};
  for (i = 0; i < n; i++) for (j = 0; j < maps[i].strict.length; j++) {
    k = maps[i].strict[j].i;
    if (has(seen, k) && seen[k] !== i) { dup[i] = { other: seen[k], d: maps[i].strict[j] }; dup[seen[k]] = { other: i, d: maps[i].strict[j] }; }
    else seen[k] = i;
  }
  /* the symbol route: "in which E is": exactly one option's entry carries that symbol in its name, and her sentence says the symbol together with the option's words */
  sym = askedSymbol(mc.stem);
  if (sym) {
    withSym = [];
    for (i = 0; i < n; i++) {
      supp = null;
      for (j = 0; j < maps[i].loose.length; j++) {
        d = maps[i].loose[j];
        if (!has(d.symNames, sym)) continue;                 /* the entry is NAMED by the symbol ("e", "what is e"); a letter inside a longer name is not enough */
        w = words(d.sentence);
        if (w.indexOf(sym) < 0) continue;
        for (k in bags[i].set) if (has(bags[i].set, k) && has(d.sent, k)) { if (!supp) supp = d; }
      }
      if (supp) withSym.push({ i: i, d: supp });
      else for (j = 0; j < maps[i].loose.length; j++) if (has(maps[i].loose[j].symNames, sym)) { withSym.push({ i: i, d: null }); break; }
    }
    if (withSym.length === 1 && withSym[0].d && maps[withSym[0].i].strict.length && !has(dup, withSym[0].i)) {
      i = withSym[0].i; d = withSym[0].d;
      mc.pick = { ch: mc.options[i].ch, text: mc.options[i].text, term: String(d.e.term || ''), sentence: d.sentence, source: String(d.e.source || ''), n: d.e.n,
        why: 'the question asks what "' + sym.toUpperCase() + '" is; her sentence names ' + sym.toUpperCase() + ' with the words of this option, and no other option\'s entry carries that symbol' };
      return;
    }
  }
  /* the stem against the sentences of each option's entries */
  for (i = 0; i < n; i++) {
    best.push(null); rival.push(0);
    for (j = 0; j < maps[i].strict.length; j++) {
      ev = evidence(q, maps[i].strict[j]);
      if (!best[i] || ev.s > best[i].ev.s) best[i] = { d: maps[i].strict[j], ev: ev };
    }
    for (j = 0; j < maps[i].loose.length; j++) { ev = evidence(q, maps[i].loose[j]); if (ev.s > rival[i]) rival[i] = ev.s; }
  }
  top1 = -1;
  for (i = 0; i < n; i++) if (best[i] && (top1 < 0 || best[i].ev.s > best[top1].ev.s)) top1 = i;
  if (top1 < 0 || !best[top1].ev.s) { mc.noLetterWhy = 'none of the options is a name of hers whose sentences share words with the question'; return; }
  top2 = 0; y = -1;
  for (i = 0; i < n; i++) if (i !== top1 && rival[i] > top2) { top2 = rival[i]; y = i; }
  x = best[top1];
  mc.margin = { option: top1, s: Math.round(x.ev.s * 100) / 100, next: Math.round(top2 * 100) / 100, shared: x.ev.shared.length, cover: Math.round(x.ev.cover * 100) / 100 };
  if (has(dup, top1)) {
    mc.noLetterWhy = 'options ' + letterOf(mc.options[Math.min(top1, dup[top1].other)]) + ' and ' + letterOf(mc.options[Math.max(top1, dup[top1].other)]) + ' are the same entry of hers ("' + String(dup[top1].d.e.term || '') + '")';
    return;
  }
  if (x.ev.shared.length < CFG.MC_MIN_SHARED) {
    mc.noLetterWhy = 'the best option, ' + letterOf(mc.options[top1]) + ', shares only ' + x.ev.shared.length + ' content word' + (x.ev.shared.length === 1 ? '' : 's') + ' with her sentence about it (two are needed)';
    return;
  }
  if (x.ev.cover < CFG.MC_MIN_COVER || x.ev.s < CFG.MC_MIN_SCORE) {
    mc.noLetterWhy = 'her sentence about ' + letterOf(mc.options[top1]) + ' holds too little of the question (' + Math.round(x.ev.cover * 100) + ' percent of its weight, score ' + (Math.round(x.ev.s * 10) / 10) + ')';
    return;
  }
  /* an option that is no name of hers at all (the store does not know it, or it is mistyped) may be the right one: then her sentences must say much more */
  unknown = -1;
  for (i = 0; i < n; i++) if (i !== top1 && !maps[i].loose.length) unknown = i;
  if (unknown >= 0 && (x.ev.shared.length < CFG.MC_UNKNOWN_SHARED || x.ev.s < CFG.MC_UNKNOWN_SCORE || x.ev.s < CFG.MC_UNKNOWN_RATIO * top2)) {
    mc.noLetterWhy = 'option ' + letterOf(mc.options[unknown]) + ' is no name of hers, so it cannot be ruled out, and her sentence about ' + letterOf(mc.options[top1]) + ' is not strong enough to choose over it (shares '
      + x.ev.shared.length + ' words, score ' + (Math.round(x.ev.s * 10) / 10) + ')';
    return;
  }
  if (x.ev.s < CFG.MC_RATIO * top2 || x.ev.s - top2 < CFG.MC_DIFF) {
    mc.noLetterWhy = 'her sentences do not single out one option: ' + letterOf(mc.options[top1]) + ' scores ' + (Math.round(x.ev.s * 10) / 10) + (y >= 0 ? ', ' + letterOf(mc.options[y]) + ' scores ' + (Math.round(top2 * 10) / 10) : '')
      + ' (needed: ' + CFG.MC_RATIO + ' times the next and ' + CFG.MC_DIFF + ' ahead)';
    return;
  }
  mc.pick = { ch: mc.options[top1].ch, text: mc.options[top1].text, term: String(x.d.e.term || ''), sentence: x.d.sentence, source: String(x.d.e.source || ''), n: x.d.e.n,
    why: 'her sentence for "' + String(x.d.e.term || '') + '" shares ' + x.ev.shared.length + ' of the question\'s words (' + x.ev.shared.join(', ') + '); score ' + (Math.round(x.ev.s * 10) / 10)
      + ' against ' + (Math.round(top2 * 10) / 10) + ' for the next option' };
}

/* ---------------------------------------------------------------------------------------------- calculation or word question */
/* A question that has something to calculate belongs to the calculator.  Sure signs only, because a word question may hold numbers too. */
function looksLikeCalculation(text) {
  var t = String(text || ''), units = t.match(/\b\d+(?:\.\d+)?[\s-]*(?:kips?|kip-ft|k-ft|k\/ft|klf|plf|psf|pcf|ksi|psi|ft|feet|foot|in\.?|inch(?:es)?|lbs?|k)(?![A-Za-z])/gi) || [], order;
  if (/\b(?:choose\s+one|which\s+of\s+the\s+following|circle\s+(?:one|the)|select\s+(?:one|the\s+(?:best|correct))|(?:best|correct)\s+answer|true\s+or\s+false)\b/i.test(t)) return false;
  /* a question that asks for words is a word question even when it holds numbers and a blank ("Explain why 1/8 in is added ...") */
  if (/\b(?:why|explain|define|describe|what\s+is\s+meant|is\s+called|are\s+called|what\s+does|in\s+words|one\s+sentence)\b/i.test(t)) return false;
  if (/=\s*_{2,}/.test(t)) return true;
  if (/\b(?:W|WT|C|MC|HP|L|HSS)\s*\d*\s*x?\s*_{2,}|\bW\d+\s*x\s*_{2,}/.test(t)) return true;
  if (/_{2,}\s*(?:kips?|kip-ft|k-ft|ksi|psi|in\.?\s*\^?[234]|sq\.?\s*in|inch(?:es)?|in\.?|ft|psf|plf|pcf|k\/ft|lbs?|k)(?![A-Za-z])/i.test(t)) return true;
  if (/(?:^|\n)[ \t]*(?:phi\s*)?[A-Za-z][A-Za-z\/]{0,6}\s*=\s*(?:kips?|kip-ft|k-ft|ksi|in\.?\s*\^?[234]?|inch(?:es)?|psf|plf|k\/ft)[ \t]*(?:\n|$)/.test(t)) return true;
  if (/\n[ \t]*W[ \t]*$/.test(t)) return true;
  order = /\b(?:determine|calculate|compute|find|select|size|design|check\s+(?:if|whether)|(?:choose|pick)\s+the|what\s+is\s+the\s+(?:total|factored|required|design|maximum|nominal|available))\b/i.test(t);
  if (units.length >= 2 && order) return true;
  if (units.length >= 1 && order && /[A-Za-z]\s*=\s*\d/.test(t)) return true;
  return units.length >= 1 && /\b(?:W|WT|HP|HSS|MC|C|L)\s?\d+(?:\.\d+)?\s*x\s*\d/.test(t);
}
WORDSX.looksLikeCalculation = looksLikeCalculation;

/* ---------------------------------------------------------------------------------------------- analyze */
function hitOf(r, q) {
  return { term: String(r.d.e.term || ''), sentence: r.d.sentence, source: String(r.d.e.source || ''), score: Math.round(r.s * 100) / 100, shared: sharedAnywhere(q, r.d).concat(r.symShared || []), n: r.d.e.n };
}
WORDSX.analyze = function (questionText) {
  var out = { mc: null, hits: [], top: null, repaired: [], calculation: false }, text, mc, q, sym, ranked, i, j, h, seenSent = {}, first, second, ev, nameWords, okName, why, nStem, shortQ, rare, parts;
  if (!IDX) throw new Error('WORDSX.init was not called');
  text = repairText(String(questionText === null || questionText === undefined ? '' : questionText), out.repaired);
  if (!trim(text)) return out;
  if (looksLikeCalculation(text)) { out.calculation = true; return out; }
  mc = parseMC(text);
  if (mc) { choose(mc, text); out.mc = { stem: mc.stem, options: mc.options, pick: mc.pick, noLetterWhy: mc.noLetterWhy, layout: mc.layout, margin: mc.margin || null }; }
  q = makeQuery(mc ? mc.stem : text);
  q.why = /\bwhy\b|\breasons?\b|\bpurpose\b/i.test(mc ? mc.stem : text);
  nStem = q.order.length; shortQ = nStem <= 3;
  if (mc) {
    q.nameLit = {};
    for (i = 0; i < q.order.length; i++) q.nameLit[q.order[i]] = 1;
    /* the words of the options count too, at half weight: her sentence that holds the stem AND the options is the one to read */
    first = contentStems(mc.options.map(function (o) { return o.text; }).join(' . '));
    second = words(mc.options.map(function (o) { return o.text; }).join(' . ')).filter(function (x) { return x.length > 1 && isContent(x); });
    for (i = 0; i < first.length; i++) if (!has(q.lit, first[i])) { q.lit[first[i]] = 0.5; q.order.push(first[i]); q.raw[first[i]] = second[i]; }
  }
  sym = askedSymbol(mc ? mc.stem : text);
  ranked = rank(q, sym);
  if (mc && mc.pick) {
    /* the entry behind the letter is the first sentence shown */
    for (i = 0; i < IDX.docs.length; i++) if (IDX.docs[i].e.n === mc.pick.n && IDX.docs[i].sentence === mc.pick.sentence) { ranked.unshift({ d: IDX.docs[i], s: ranked.length ? ranked[0].s : 0, name: null, forced: true }); break; }
  }
  for (i = 0; i < ranked.length && out.hits.length < CFG.MAX_HITS; i++) {
    h = hitOf(ranked[i], q);
    if (ranked[i].forced) { seenSent[h.sentence] = true; out.hits.push(h); continue; }
    /* two shared content words; or the question holds a whole name of the entry; or it asks for the symbol the entry is named by; or, in a question of
       three content words or fewer, one shared word that is not an everyday one in her store (or a symbol the entry is named by) */
    if (h.shared.length < CFG.HIT_MIN_SHARED && !ranked[i].name && !(sym && has(ranked[i].d.symNames, sym))) {
      if (!shortQ) continue;
      rare = ranked[i].symName;
      for (j = 0; j < nStem && !rare; j++) if (has(ranked[i].d.full, q.order[j]) && idf(q.order[j]) >= 2.5) rare = true;
      if (!rare) continue;
    }
    if (!h.sentence || has(seenSent, h.sentence)) continue;
    seenSent[h.sentence] = true;
    out.hits.push(h);
  }
  if (mc) {
    /* a multiple-choice question is answered by a letter or not at all: the entry behind the letter is THE entry */
    if (mc.pick) out.top = { term: mc.pick.term, sentence: mc.pick.sentence, source: mc.pick.source, why: 'the entry behind option ' + (mc.pick.ch ? '(' + mc.pick.ch + ')' : '"' + mc.pick.text + '"'), n: mc.pick.n };
    return out;
  }
  /* an open question: one entry clearly ahead of every entry on another subject, and enough of the question in it */
  if (!ranked.length || !out.hits.length || ranked[0].d.e.n !== out.hits[0].n) return out;
  first = ranked[0]; second = null;
  for (i = 1; i < ranked.length; i++) if (!has(first.d.sib, ranked[i].d.i)) { second = ranked[i]; break; }
  h = out.hits[0];
  /* a full multi-word name: the name the entry goes by (two words or more), or another wording of three words or more; a fragment of two words is not one */
  nameWords = first.name ? first.name.n : 0;
  okName = !!first.name && ((first.name.isTerm && nameWords >= 2) || nameWords >= 3);
  ev = evidence(q, first.d);
  out.margin = { ratio: second ? Math.round(100 * first.s / second.s) / 100 : 99, cover: Math.round(100 * ev.cover) / 100, shared: h.shared.length, name: okName };
  /* a question in several parts (two blanks, two question marks, parts (a) (b)) has no ONE entry */
  parts = Math.max((text.match(/_{2,}/g) || []).length, (text.match(/\?/g) || []).length, (text.match(/(?:^|\s)\([a-h]\)\s/gi) || []).length);
  out.margin.parts = parts;
  if (parts >= 2) return out;
  /* a "why" question is answered only by an entry of hers that gives a reason */
  if (q.why && !(first.d.e.kind === 'reason' || /^why\b/i.test(String(first.d.e.term || '')))) return out;
  if (h.shared.length < CFG.TOP_MIN_SHARED && !okName) return out;
  if (second && first.s < CFG.TOP_RATIO * second.s) return out;
  if (ev.cover < CFG.TOP_MIN_COVER) return out;
  why = (okName ? 'the question holds her name "' + collapse(first.name.raw) + '"; ' : '') + 'shares ' + h.shared.length + ' words (' + h.shared.join(', ') + '); score ' + h.score
    + (second ? ' against ' + (Math.round(second.s * 100) / 100) + ' for the next subject ("' + String(second.d.e.term || '') + '")' : '') + '; ' + Math.round(100 * ev.cover) + ' percent of the question is in her sentence';
  out.top = { term: h.term, sentence: h.sentence, source: h.source, why: why, n: h.n };
  return out;
};

root.WORDSX = WORDSX;
if (typeof module !== 'undefined' && module.exports) module.exports = WORDSX;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

