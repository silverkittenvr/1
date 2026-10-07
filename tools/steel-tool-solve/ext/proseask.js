/* ==== proseask.js ==== */
/* proseask.js -- what a question with NO answer blank asks for, where its words turn the quantity into ANOTHER one (lane L3 "prose-asks", 10/07).
   pipeline.js reads the plain quantities of an asking sentence itself (ASK_WORDS: "find Ae", "what is the governing KL/r").  The words read here change
   the quantity, and the page printed the form's own result as a clean ANSWER for all of these (red team A1, every one confirmed by hand):
     "Determine the nominal tensile strength Pn" / "find Pn"  -> phi Pn printed; no phi is asked              A1-tcap-24/25, A1-ccap-269/270, A1-tsel-26
     "design strength for yielding?" / "rupture strength"     -> the governing capacity printed              A1-tcap-27..31, A1-tsel-27/28
     "what is the excess capacity" / "what percent ... used"  -> the capacity printed                         A1-tsel-23/24/25
     "ASD allowable strength?" / "allowable strength"         -> the LRFD phi Pn printed (her class is LRFD)  A1-tsel-29, A1-ccap-283
     "find the euler critical stress"                         -> the Euler LOAD printed                       A1-ccap-220
     "find KL/r about the x axis"                             -> the governing (y) KL/r printed               A1-ccap-215
     "what is the effective length KL"                        -> the factor K printed                         A1-ccap-292
   and a last clause with no asking verb ("... 3 per line. nominal yield strength", "... length 20ft. L/r?", "gross yielding?") asked nothing at all.
     PROSEASK.read(sentences, asksInProse) -> { sens, asking, finish(out) }   askedInWords: the sentences with these phrases taken out (so ASK_WORDS
                                                                             does not read "nominal tensile strength" as the design strength), which of
                                                                             them ask, and finish() adds the asks read here
     PROSEASK.settle(part, asks, known)     -> known                         signaturePass: what the member's family decides (a NOMINAL tension
                                                                             strength has two phis; ASD is not her class); the rest become part.proseStops
     PROSEASK.plain(text)                   -> text without these phrases    writeBlock: "nominal strength" is not a request for the design strength
   Where the right reading is not certain the page STOPS for that ask (a plain sentence, no number) rather than answer.
   ES5 only.  ASCII only.  No regex lookbehind. */
(function (root) {
'use strict';
var PA = {};
function trim(s) { return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }
function spaces(n) { return new Array(n + 1).join(' '); }
/* her table names carry digits but are not numbers of the problem */
function hasDigit(s) { return /\d/.test(String(s).replace(/\bD3\.1\b|\bJ3\.3\b|\b4-1[a4]?\b|\b3-2\b/gi, ' ')); }
/* a quantity followed by its VALUE is a given, not an ask (the same test as askedInWords) */
var GIVEN_AFTER = /^\s*(?:of|=|is|:|was|equals?)?\s*-?\d/;
/* the asks read here that are never a form's own main result: the form's ANSWER line is not their answer (writeBlock) */
var QUAL = { pn: 1, pn_y: 1, pn_r: 1, phipn_y: 1, phipn_r: 1, fe: 1, klrx: 1, klry: 1, kl: 1 };
PA.QUAL = QUAL;

function matches(re, s) {
  var out = [], m;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) { out.push(m); if (m[0] === '') re.lastIndex++; }
  return out;
}
function cut(s, m) { return s.slice(0, m.index) + spaces(m[0].length) + s.slice(m.index + m[0].length); }
function before(s, m, n) { return s.slice(Math.max(0, m.index - (n || 30)), m.index); }
function after(s, m) { return s.slice(m.index + m[0].length); }

/* ASD.  Her class is LRFD only (one combination, phi).  "Pn/omega", "ASD", "allowable strength" ask for Pn / omega, never for phi Pn.  ("allowable LOAD"
   is not here: "the maximum allowable live load" is an LRFD question about the service load a member can take.)  "LRFD, not ASD" asks nothing of ASD. */
var ASD_RE = [
  /\b(?:P\s?n|F\s?cr|F\s?n|M\s?[np]|R\s?n|T\s?n|V\s?n)\s*\/\s*omega\w*/gi,
  /\bomega(?:\s*_?\s*[ctb])?\b/gi,
  /\bASD\b/gi,
  /\ballowable\s+(?:(?:axial|tensile|tension|compressive|compression|flexural|bending|moment|design|column|member|available)\s+)*(?:strength|capacity|stress|moment)\b/gi
];
var ASD_NEG = /\b(?:not|no|without|instead\s+of|rather\s+than|never)\s+(?:by\s+|using\s+|use\s+|the\s+|an?\s+)?(?:\w+\s+)?\(?\s*$/i;

/* "not phi Pn", "(nominal Pn not needed)": a quantity named only to say it is NOT asked (A2-look-24: "what is Pn (not phi Pn)") */
var NEG_RE = [
  /\b(?:not|no|without|instead\s+of|rather\s+than)\s+(?:the\s+)?(?:phi\s*\*?\s*[PM]\s?[np]|design\s+strength|P\s?n|M\s?n|nominal\s+(?:\w+\s+)?strength)\b/gi,
  /\b(?:nominal\s+)?(?:phi\s*\*?\s*)?[PM]\s?n\s+(?:is\s+|are\s+)?not\s+(?:needed|required|asked|wanted|necessary)\b/gi
];

/* NOT IN THE PAGE: an excess, a margin, a percentage, "how much more load".  phi Pn - Pu could be worked by hand, but which load (factored or service)
   and which difference is meant is not certain, and the capacity printed as the ANSWER is NOT it (A1-tsel-23: 249.2 printed for an excess of 57.2) */
var STOP_RE = [
  [/\b(?:excess|spare|reserve|remaining|unused|residual|surplus|extra|additional)\s+(?:(?:axial|tensile|tension|compressive|compression|design|factored|load[\s-]+carrying|moment|flexural)\s+)*(?:capacity|strength)\b/gi, 'excess capacity'],
  [/\bhow\s+much\s+(?:more|extra|additional|bigger|larger|greater)\b/gi, 'how much more load it can take'],
  [/\b(?:extra|additional|more)\s+(?:(?:factored|service|live|dead|axial|tensile|tension)\s+)*(?:load|force|kips?)\s+(?:can|could|would|will|may|might|that|it|before)\b/gi, 'how much more load it can take'],
  /* (with its "of the capacity": A1-tsel-25 "what percent of the capacity is used" is no request for the capacity) */
  [/\b(?:percent(?:age)?|%|utili[sz](?:ation|ed|ing)|how\s+much|what\s+(?:part|fraction|portion|share))(?:\s+of\s+(?:the\s+|its\s+)?(?:[a-z]+\s+)?(?:capacity|strength))\b|\bpercent(?:age)?\b|%|\butili[sz](?:ation|ed|ing)\b|\b(?:demand|capacity|unity|interaction)[\s-]+(?:to[\s-]+(?:capacity|demand)[\s-]+)?ratio\b|\bD\s*\/\s*C\b/gi, 'percent (or ratio) of the capacity used'],
  [/\bby\s+how\s+much\b/gi, 'by how much'],
  [/\bmargin(?:\s+of\s+safety)?\b|\bfactor\s+of\s+safety\b|\bsafety\s+factor\b/gi, 'margin (or factor) of safety']
];

/* ONE LIMIT STATE of a tension member.  "strength for yielding", "phi Pn for rupture", "yielding strength", "rupture strength", "phi Pn (yielding)";
   with "nominal" or a bare Pn the nominal one (Fy Ag, Fu Ae).  The other limit state named in the same breath ("for yielding and rupture") is no ONE
   limit state (REVIEW 2: that question printed the yielding value). */
var LS_STR = /\b(?:(?:the|design|available|nominal|tensile|tension|axial)\s+)*(?:strength|capacity|phi\s*\*?\s*P\s?n|P\s?n)\s+(?:for|in|by|of|against|on|from|considering|under|based\s+on|due\s+to|governed\s+by|controlled\s+by)\s+(?:the\s+)?(?:limit\s+state\s+of\s+)?(?:tensile\s+|tension\s+|gross[\s-]*section\s+|gross\s+|net[\s-]*section\s+|net\s+|effective\s+net\s+area\s+)?(yield(?:ing)?|rupture|fracture)\b(?:\s+(?:of|on|in|at)\s+the\s+(?:gross|net|effective)(?:\s+net)?\s+(?:section|area))?/gi;
var LS_NOUN = /\b(?:(?:the|design|available|nominal|tensile|tension|axial)\s+)*(?:gross[\s-]*section\s+|gross\s+|net[\s-]*section\s+|net\s+)?(yield(?:ing)?|rupture|fracture)\s+(?:design\s+|limit[\s-]+state\s+)?(?:strength|capacity)\b/gi;
var LS_PAREN = /\b(?:phi\s*\*?\s*)?P\s?n\s*\(\s*(yield(?:ing)?|rupture|fracture)\s*\)/gi;
/* (only a short clause of its own: "gross yielding?", "net section rupture?") */
var LS_BARE = /\b(?:gross[\s-]*(?:section\s+)?|tensile\s+|tension\s+)(yield(?:ing)?)\b|\bnet[\s-]*(?:section\s+)?(rupture|fracture)\b|\btensile\s+(rupture|fracture)\b|\byield(?:ing)?\s+(?:of|on|at)\s+(?:the\s+)?gross\s+(?:section|area)\b|\b(rupture|fracture)\s+(?:of|on|at)\s+(?:the\s+)?(?:net|effective)\s+(?:net\s+)?(?:section|area)\b/gi;
var LS_ALONE = /^\s*(?:the\s+)?(yield(?:ing)?|rupture|fracture)\s*\?*\s*$/i;
/* "the yield strength of A36 steel", "minimum yield strength": the material's Fy, not a strength of the member */
var YIELD_MATERIAL_AFTER = /^\s*(?:,?\s*\(?\s*F\s?y\b|(?:of|for)\s+(?:the\s+|an?\s+|this\s+)?(?:A\s?\d|steel|material|grade|plate\s+material))/i;
var YIELD_MATERIAL_BEFORE = /(?:minimum|specified|steel|material|steel's|grade)\s+$/i;
var OTHER_LS_AFTER = /^\s*(?:,|and|or|&|\/|plus)\s*(?:the\s+|for\s+|in\s+)?(?:limit\s+state\s+of\s+)?(?:[a-z]+[\s-]+){0,2}(?:yield|yielding|rupture|fracture)\b/i;
var OTHER_LS_BEFORE = /(?:yield(?:ing)?|rupture|fracture)\s*(?:,|and|or|&|\/)\s*(?:[a-z]+\s+)?$/i;

/* NOMINAL: no phi.  A column's Pn = phi Pn / 0.90 (SIG_NOMINAL, as for a blank "Pn = ____"); a tension member's depends on the limit state. */
var NOM_P = /\bnominal\s+(?:(?:axial|compressive|compression|tensile|tension|design|column|member|load[\s-]+carrying|carrying)\s+)*(?:strength|capacity|resistance)\b(?:\s*,?\s*\(?\s*P\s?n\b\s*\)?)?/gi;
var NOM_STOP = [
  [/\bnominal\s+(?:(?:flexural|bending|moment)\s+)+(?:strength|capacity)\b(?:\s*,?\s*\(?\s*M\s?n\b\s*\)?)?|\bnominal\s+moment\b(?:\s*,?\s*\(?\s*M\s?n\b\s*\)?)?/gi, 'nominal moment strength Mn'],
  [/\bnominal\s+(?:(?:critical|buckling|compressive|compression|axial)\s+)*stress\b(?:\s*,?\s*\(?\s*F\s?cr\b\s*\)?)?/gi, 'nominal critical stress Fcr']
];
var BARE_PN = /\bP\s?n\b|\bpn\b/g;
var BARE_MN = /\bM\s?n\b|\bmn\b/g;
var PHI_BEFORE = /phi\s*\)?\s*[*._]?\s*$/i;
/* "the design strength Pn": the words say design, the symbol lost its phi -- not a request for the nominal value */
var DESIGN_BEFORE = /(?:design|available)\s+(?:[a-z]+\s+)?(?:strength|capacity)\s*,?\s*\(?\s*$/i;

/* the Euler STRESS Fe (the Euler form's headline is the LOAD Pcr) */
var FE_RE = /\beuler(?:'?s)?\s+(?:(?:critical|buckling|elastic)\s+)*stress\b(?:\s*,?\s*\(?\s*F\s?e\b\s*\)?)?|\belastic\s+(?:critical\s+)?buckling\s+stress\b(?:\s*,?\s*\(?\s*F\s?e\b\s*\)?)?|\belastic\s+critical\s+stress\b(?:\s*,?\s*\(?\s*F\s?e\b\s*\)?)?/gi;
/* KL/r about ONE named axis (the column form gives both; "governing KL/r" is the larger) */
var KLR_SYM = [[/\bK\s?x\s?L\s?x\s*\/\s*r\s?x\b|\bL\s?x\s*\/\s*r\s?x\b|\bK\s?L\s*\/\s*r\s?x\b/gi, 'x'], [/\bK\s?y\s?L\s?y\s*\/\s*r\s?y\b|\bL\s?y\s*\/\s*r\s?y\b|\bK\s?L\s*\/\s*r\s?y\b/gi, 'y']];
var KLR_AXIS = /\b(?:(?:governing|controlling)\s+)?(?:K\s?L\s*\/\s*r|L\s*\/\s*r|slenderness(?:\s+ratio)?)\s*\(?\s*(?:(?:about|for|along|around|in|on|wrt|w\.r\.t\.?)\s+(?:the\s+)?)?(x|y|strong|weak|major|minor)(?:\s*-\s*(?:x|y))?(?:[\s-]*ax[ie]s)?\b\s*\)?/gi;
/* the effective LENGTH KL = K x L (not the factor K) */
var KL_RE = [/\beffective\s+(?:column\s+)?length\s*,?\s*\(?\s*K\s?L\b\s*\)?(?!\s*(?:\/|=|x\b|y\b))/gi, /\beffective\s+(?:column\s+)?length\s*\??\s*$/gi];
var KL_ALONE = /^\s*(?:(?:find|what\s+is|whats|what's|determine|calculate|compute|give)\s+)?(?:the\s+)?K\s?L\s*\??\s*$/i;

/* the LAST clause of a question, when it asks without an asking verb: "... 3 per line. nominal yield strength", "... 20ft. L/r?", "... 3 per line gross
   yielding?" (A1-tcap-26/28/32, A1-ccap-269).  Not an instruction ("use Table D3.1", "assume pinned ends"), never more than eight words. */
var ASK_START = /^\s*(?:what|whats|what's|wat|which|how|find|determine|calculate|compute|give|state|show|list|is|are|does|can)\b/i;
var INSTRUCTION = /^\s*(?:use|using|assume|assuming|assumed|neglect|neglecting|ignore|ignoring|take|taking|given|note|let|where|if|when|since|because|unless|except|with|without|for\s+(?:a|an|the|this|all|each)\b|see|refer|hint)\b/i;

/* one sentence: the phrases read here, taken out of it.  -> { s, asks: [{id, raw, ls}], stops: [label] } */
function scan(s, tail, whole) {
  var out = { asks: [], stops: [] }, i, list, k, m, a, ls, nom, pre, post, yAny = /\byield(?:ing)?\b/i.test(whole), rAny = /\b(?:rupture|fracture)\b/i.test(whole);
  function ask(id, raw, extra) { var o = { id: id, raw: raw }, q; for (q in (extra || {})) if (Object.prototype.hasOwnProperty.call(extra, q)) o[q] = extra[q]; out.asks.push(o); }
  for (i = 0; i < NEG_RE.length; i++) { list = matches(NEG_RE[i], s); for (k = 0; k < list.length; k++) s = cut(s, list[k]); }
  for (i = 0; i < STOP_RE.length; i++) {
    list = matches(STOP_RE[i][0], s);
    for (k = 0; k < list.length; k++) {
      m = list[k];
      if (GIVEN_AFTER.test(after(s, m)) || /\d\s*$/.test(before(s, m, 4))) continue;
      out.stops.push(STOP_RE[i][1]); s = cut(s, m);
    }
  }
  /* the limit state: phrases that name it with the strength, then (only in a short clause of its own) the bare words */
  var lsRes = [LS_PAREN, LS_STR, LS_NOUN];
  for (i = 0; i < lsRes.length; i++) {
    list = matches(lsRes[i], s);
    for (k = 0; k < list.length; k++) {
      m = list[k]; pre = before(s, m); post = after(s, m);
      if (GIVEN_AFTER.test(post)) continue;
      ls = /^y/i.test(m[1]) ? 'y' : 'r';
      /* ("the yield strength and the rupture strength" are two self-contained asks; "strength for yielding and rupture" is no ONE limit state) */
      if ((lsRes[i] === LS_STR && OTHER_LS_AFTER.test(post)) || OTHER_LS_BEFORE.test(pre)) continue;
      if (ls === 'y' && (YIELD_MATERIAL_AFTER.test(post) || YIELD_MATERIAL_BEFORE.test(pre))) continue;
      nom = /\bnominal\b/i.test(m[0]) || (/\bP\s?n\b/.test(m[0]) && !/phi/i.test(m[0]));
      ask((nom ? 'pn_' : 'phipn_') + ls, nom ? 'nominal strength Pn' : 'design strength phi Pn');
      s = cut(s, m);
    }
  }
  if (tail) {
    list = matches(LS_BARE, s);
    for (k = 0; k < list.length; k++) {
      m = list[k];
      ls = (m[1] || /^\s*(?:the\s+)?yield/i.test(m[0])) ? 'y' : 'r';
      if (ls === 'y' ? rAny : yAny) continue;
      ask('phipn_' + ls, 'design strength phi Pn'); s = cut(s, m);
    }
    if ((m = LS_ALONE.exec(s))) { ls = /^y/i.test(m[1]) ? 'y' : 'r'; if (!(ls === 'y' ? rAny : yAny)) { ask('phipn_' + ls, 'design strength phi Pn'); s = spaces(s.length); } }
  }
  /* nominal */
  list = matches(NOM_P, s);
  for (k = 0; k < list.length; k++) { m = list[k]; if (GIVEN_AFTER.test(after(s, m))) continue; ask('pn', 'nominal strength Pn'); s = cut(s, m); }
  for (i = 0; i < NOM_STOP.length; i++) {
    list = matches(NOM_STOP[i][0], s);
    for (k = 0; k < list.length; k++) { m = list[k]; if (GIVEN_AFTER.test(after(s, m))) continue; out.stops.push(NOM_STOP[i][1]); s = cut(s, m); }
  }
  list = matches(BARE_PN, s);
  for (k = 0; k < list.length; k++) {
    m = list[k]; pre = before(s, m, 14); post = after(s, m);
    if (PHI_BEFORE.test(pre) || DESIGN_BEFORE.test(before(s, m, 40)) || /^\s*(?:=|\/)/.test(post) || GIVEN_AFTER.test(post)) continue;
    ask('pn', 'nominal strength Pn'); s = cut(s, m);
  }
  list = matches(BARE_MN, s);
  for (k = 0; k < list.length; k++) {
    m = list[k]; pre = before(s, m, 14); post = after(s, m);
    if (PHI_BEFORE.test(pre) || DESIGN_BEFORE.test(before(s, m, 40)) || /^\s*(?:=|\/)/.test(post) || GIVEN_AFTER.test(post)) continue;
    out.stops.push('nominal moment strength Mn'); s = cut(s, m);
  }
  /* Euler stress, KL/r about one axis, effective length KL */
  list = matches(FE_RE, s);
  for (k = 0; k < list.length; k++) { m = list[k]; if (GIVEN_AFTER.test(after(s, m))) continue; ask('fe', 'Euler stress Fe'); s = cut(s, m); }
  for (i = 0; i < KLR_SYM.length; i++) {
    list = matches(KLR_SYM[i][0], s);
    for (k = 0; k < list.length; k++) { m = list[k]; if (GIVEN_AFTER.test(after(s, m))) continue; ask('klr' + KLR_SYM[i][1], 'KL/r about the ' + KLR_SYM[i][1] + ' axis'); s = cut(s, m); }
  }
  list = matches(KLR_AXIS, s);
  for (k = 0; k < list.length; k++) {
    m = list[k];
    /* "KL/r x" alone is no axis: the words must say about / for, or axis, or x-x */
    if (!/\b(?:about|for|along|around|in|on|wrt|w\.r\.t)\b|ax[ie]s|[xy]\s*-\s*[xy]/i.test(m[0]) || GIVEN_AFTER.test(after(s, m))) continue;
    a = /^(?:x|strong|major)$/i.test(m[1]) ? 'x' : 'y';
    ask('klr' + a, 'KL/r about the ' + a + ' axis'); s = cut(s, m);
  }
  for (i = 0; i < KL_RE.length; i++) {
    list = matches(KL_RE[i], s.replace(/[.\s]+$/, ''));
    for (k = 0; k < list.length; k++) { ask('kl', 'effective length KL'); s = cut(s, list[k]); }
  }
  if (KL_ALONE.test(lastClause(s).replace(/[.\s]+$/, ''))) { ask('kl', 'effective length KL'); s = s.replace(/\bK\s?L\s*\??\s*$/i, ''); }
  out.s = s;
  return out;
}
/* the text after the last break ". " "; " "? " ", " of a sentence (a break is followed by a letter: "0.75" and "3/4" do not break) */
function lastClause(s) {
  var re = /[.;?!,]\s*(?=[A-Za-z(])/g, m, at = -1;
  while ((m = re.exec(s)) !== null) at = m.index + m[0].length;
  return at >= 0 ? s.slice(at) : s;
}
/* -> null, or { head, tail } when the last clause of the sentence asks by itself */
function tailOf(s, whole) {
  var re = /[.;?!,]\s*(?=[A-Za-z(])/g, m, at = -1, head, tail, run, sc, words;
  while ((m = re.exec(s)) !== null) at = m.index + m[0].length;
  head = at >= 0 ? s.slice(0, at) : ''; tail = at >= 0 ? s.slice(at) : s;
  if (hasDigit(tail)) {
    /* a question typed with no full stop ("W14x90 KL=20ft nominal strength"): the words after its last number, and only a phrase read here */
    run = /^([\s\S]*\d\S*)\s+(\D+)$/.exec(tail);
    if (!run || hasDigit(run[2])) return null;
    sc = scan(run[2], false, whole);
    if (!sc.asks.length && !sc.stops.length) return null;
    return { head: head + run[1], tail: run[2] };
  }
  words = trim(tail).split(/\s+/).filter(function (w) { return /[A-Za-z]/.test(w); });
  if (!words.length || words.length > 8 || INSTRUCTION.test(tail)) return null;
  if (/\?\s*$/.test(tail) || ASK_START.test(tail)) return { head: head, tail: tail };
  sc = scan(tail, true, whole);
  return sc.asks.length || sc.stops.length ? { head: head, tail: tail } : null;
}

PA.read = function (sens, asksInProse) {
  var S = (sens || []).slice(), asking = [], found = [], stops = [], asd = [], whole = S.join(' '), i, k, j, list, t, sc, last;
  /* 1. the last clause, when it asks with no verb (only when the whole last sentence does not ask already: then nothing of it changes) */
  if (S.length) {
    last = S[S.length - 1];
    if (!asksInProse(last)) {
      t = tailOf(last, whole);
      if (t) { S.splice(S.length - 1, 1); if (trim(t.head)) S.push(trim(t.head)); S.push(trim(t.tail)); asking[S.length - 1] = true; }
    }
  }
  /* 2. ASD, in any sentence of the part ("Pn/omega for a W10x49 with KL=14 ft" has no asking verb at all) */
  for (i = 0; i < S.length; i++) {
    for (k = 0; k < ASD_RE.length; k++) {
      list = matches(ASD_RE[k], S[i]);
      for (j = 0; j < list.length; j++) {
        if (ASD_NEG.test(before(S[i], list[j], 30))) continue;
        asd.push(trim(list[j][0])); S[i] = cut(S[i], list[j]);
      }
    }
  }
  /* 3. the asking sentences */
  for (i = 0; i < S.length; i++) {
    if (!asking[i] && !asksInProse(S[i])) continue;
    sc = scan(S[i], !!asking[i], whole);
    S[i] = sc.s;
    for (k = 0; k < sc.asks.length; k++) { sc.asks[k].ctx = trim(sens[Math.min(i, sens.length - 1)] || '').slice(-40); found.push(sc.asks[k]); }
    for (k = 0; k < sc.stops.length; k++) if (stops.indexOf(sc.stops[k]) < 0) stops.push(sc.stops[k]);
  }
  return {
    sens: S, asking: asking,
    finish: function (out) {
      var seen = {}, q;
      for (q = 0; q < out.length; q++) seen[out[q].id] = 1;
      for (q = 0; q < found.length; q++) {
        if (seen[found[q].id]) continue;
        seen[found[q].id] = 1;
        out.push({ id: found[q].id, unit: '', raw: found[q].raw, sym: found[q].raw, byWords: true, prose: true, px: true, context: found[q].ctx || '', after: '' });
      }
      out.fromProse = true; out.stops = stops; out.asd = asd;
      return out;
    }
  };
};

/* the ASD part: one sentence, no number */
var ASD_WHY = 'Allowable strength (ASD, with omega) is not her method: her class works LRFD with phi only, so the page does not work it out.';
PA.settle = function (part, asks, known) {
  var fns = (part.stages || []).map(function (s0) { return s0.fn; }), fn = fns.length ? fns[fns.length - 1] : '', fam = part.route && part.route.family,
    own = String(part.text || ''), own1 = String(part.ctx || own).slice(part.coverLen || 0), stops = (asks.stops || []).slice(), keep = [], lens = [], lm,
    lre = /(\d+(?:\.\d+)?)\s*-?\s*(?:ft|feet|foot)\b(?!\s*\^?\s*[23])/gi,
    tension = fam === 'tension' || /^tension_/.test(fn) || (!/^(?:column|beam)/.test(String(fam || '')) && /\btension|tensile/i.test(own)),
    column = /^column_(?:capacity|select)$/.test(fn);
  part.proseStops = [];
  /* a word question, or a part already out of the page, keeps its own reading */
  if (part.kind !== 'form') return known;
  known.forEach(function (b) {
    if (!b.prose || !b.px && !QUAL[b.id]) { keep.push(b); return; }
    /* one limit state is a tension member's; for any other member the page does not know what it is */
    if (/^(?:phipn|pn)_[yr]$/.test(b.id) && !tension) { stops.push(b.raw); return; }
    /* a NOMINAL tension strength with no limit state: yielding (phi 0.90) and rupture (phi 0.75) each have their own.  Answered only where both
       readings give one value (PROSEASK.tensionPn); a beam's or any other member's "Pn" is not the page's to guess */
    if (b.id === 'pn' && tension) b.tpn = true;
    else if (b.id === 'pn' && !column) { stops.push(b.raw); return; }
    if (b.id === 'kl') {
      /* KL = K x L with the ONE length of the question (as for a blank "KL = ____ ft") */
      while ((lm = lre.exec(own1)) !== null) if (lens.indexOf(Number(lm[1])) < 0) lens.push(Number(lm[1]));
      if (fn !== 'lookup_K' || lens.length !== 1) { stops.push(b.raw); return; }
      b.len = lens[0];
    }
    if (QUAL[b.id]) b.qual = true;
    keep.push(b);
  });
  if ((asks.asd || []).length) {
    /* (an LRFD quantity asked beside it keeps its answer; the ASD one is said to be out) */
    if (keep.length) stops.push('allowable strength (ASD)');
    else { part.kind = 'not_in_tool'; part.notIn = [{ id: 'asd', when: 'ASD / allowable strength', 'do': ASD_WHY, words: asks.asd.slice(0, 3), not_in_tool: true }]; keep = []; stops = []; }
  }
  part.proseStops = stops.filter(function (x, k9) { return stops.indexOf(x) === k9; });
  return keep;
};

/* THE NOMINAL STRENGTH Pn OF A TENSION MEMBER, asked with no limit state (A1-tcap-24 "Determine the nominal tensile strength Pn", A1-tsel-26).  Two readings
   are in use: the nominal value of the limit state that governs the DESIGN strength, and the smaller of the two nominal values (Fy Ag, Fu Ae).  When
   yielding governs the design strength (0.90 Fy Ag <= 0.75 Fu Ae) Fy Ag is also the smaller nominal value; when rupture governs, the two readings agree
   only if Fu Ae < Fy Ag.  One value -> it is the answer (W10x33: Fu Ae = 478.97 < Fy Ag = 485.5, rupture governs); two values -> null, and the page stops.
   -> { key, value, unit, stage, nominal } like pipeline's sigValue, or null */
PA.tensionPn = function (run) {
  var si, v, y, r, ny, nr;
  for (si = (run && run.stages ? run.stages.length : 0) - 1; si >= 0; si--) {
    v = run.stages[si] && run.stages[si].res && run.stages[si].res.ok ? run.stages[si].res.values : null;
    if (!v || !v.yielding || !v.rupture || !/^tension_(?:capacity|select)$/.test(String(run.stages[si].fn))) continue;
    y = Number(v.yielding.value); r = Number(v.rupture.value);
    if (!isFinite(y) || !isFinite(r) || y <= 0 || r <= 0) return null;
    ny = y / 0.9; nr = r / 0.75;
    if (y < r) return { key: 'yielding', value: ny, unit: v.yielding.unit || 'kips', stage: si, nominal: { phi: 0.9, design: y, label: 'phi Pn (yielding)' } };
    if (nr < ny) return { key: 'rupture', value: nr, unit: v.rupture.unit || 'kips', stage: si, nominal: { phi: 0.75, design: r, label: 'phi Pn (rupture)' } };
    return null;
  }
  return null;
};

/* the text without the phrases read here (STRENGTH_ASK reads what is left: "nominal strength" and "rupture strength" are not the design strength) */
PA.plain = function (text) {
  var s = String(text === undefined || text === null ? '' : text), whole = s, all = [], i, k, list;
  all = all.concat(ASD_RE, NEG_RE, STOP_RE.map(function (x) { return x[0]; }), [LS_PAREN, LS_STR, LS_NOUN, NOM_P], NOM_STOP.map(function (x) { return x[0]; }), [FE_RE]);
  for (i = 0; i < all.length; i++) {
    list = matches(all[i], s);
    for (k = 0; k < list.length; k++) {
      if (all[i] === LS_STR && (OTHER_LS_AFTER.test(after(s, list[k])) || OTHER_LS_BEFORE.test(before(s, list[k])))) continue;
      if (all[i] === LS_NOUN && (OTHER_LS_BEFORE.test(before(s, list[k])) || (/^y/i.test(list[k][1]) && (YIELD_MATERIAL_AFTER.test(after(s, list[k])) || YIELD_MATERIAL_BEFORE.test(before(s, list[k])))))) continue;
      s = cut(s, list[k]);
    }
  }
  return whole === s ? whole : s;
};

root.PROSEASK = PA;
if (typeof module !== 'undefined' && module.exports) module.exports = PA;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
