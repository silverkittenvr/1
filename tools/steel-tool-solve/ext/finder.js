/* ==== finder.js ==== */
/* Problem finder: follow the ladders in finder.json mechanically. Text of a problem -> family -> form.
 *
 * The same follower as finder.py, line for line (test_parity.py holds the two to identical answers on every
 * test problem). No judgment added: first matching step wins, exactly as the chart says.
 *   browser:  window.STEEL_FINDER = factory(window.STEEL_FINDER_DATA)   -> STEEL_FINDER.route(text)
 *   node:     var F = require('./finder.js')(require('./finder.json'))
 * ES5 only, no dependencies, ASCII only.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.STEEL_FINDER = factory(root.STEEL_FINDER_DATA || (root.STEEL_DATA && root.STEEL_DATA.finder));
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (DATA) {
  'use strict';
  var TABS = DATA.tabs;
  var HEADER = /problem\s+\d{1,3}\b|\b\d{1,3}\s*(?:points?|pts?)\b|\(\s*\d{1,3}\s*(?:points?|pts?)?\s*each\s*\)/g;
  var ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var CHOICE_STEMS = ['is called', 'are called', 'which of the following', 'true or false', 'is known as', 'is termed',
    'best describes', 'refers to', 'is defined as', 'which one', 'which term', 'the term for'];
  var RX = {};

  function trim(s) { return String(s).replace(/^\s+|\s+$/g, ''); }

  function norm(text) {
    var t = String(text).replace(/\u2013/g, '-').replace(/\u2014/g, '-').replace(/\u00d7/g, 'x')
      .replace(/\u03c6/g, 'phi').replace(/\u03a6/g, 'phi').replace(/\u03d5/g, 'phi').replace(/\u2019/g, "'")
      .replace(/\*/g, ' ').replace(/_/g, ' ').toLowerCase();
    // phiPn, phicPn, phi b Mn -> phi [c] pn
    t = t.replace(/\bphi\s*([cbt]?)\s*(pn|mn|mp|fcr|rn|vn)\b/g, function (m, a, b) { return 'phi ' + (a ? a + ' ' : '') + b; });
    return ' ' + t.replace(/\s+/g, ' ').replace(/^ +| +$/g, '') + ' ';
  }

  // the cover page (the list of defaults) is not part of the problem; a 'Note:' line is kept
  function dropCover(text) {
    var lines = String(text).split(/\r\n|\r|\n/), keep = [], i;
    for (i = 0; i < lines.length; i++) {
      if (!/^\s*(exam defaults|cover defaults|unless noted)/i.test(lines[i])) keep.push(lines[i]);
    }
    return keep.length ? keep.join('\n') : String(text);
  }

  // split after ? ; : when a space follows, after a full stop when the next word does not start with a small
  // letter (so '3 in. on center' and 0.5 stay whole), and at line breaks
  function sentences(text) {
    var out = [], lines = String(text).split(/\n+/), i, k, bits;
    for (i = 0; i < lines.length; i++) {
      // 'Find: the lightest W10' stays one sentence
      bits = lines[i].replace(/\b(find|to find|required|determine|asked|question|unknown|compute|calculate|select)\s*:\s+/gi, '$1:\u0002')
        .replace(/([?;:])\s+|(\.)\s+(?=[^a-z\s])/g, function (m, a, b) { return (a || b) + '\u0001'; }).split('\u0001');
      for (k = 0; k < bits.length; k++) if (/\S/.test(bits[k])) out.push(bits[k].replace(/\u0002/g, ' '));
    }
    return out;
  }

  // a signal is a plain phrase, or 're:<regex>|<what the page shows>'; returns the matched text or null.
  // A plain phrase that starts with a letter or digit must START a word ('tension' is not in 'extension').
  function hit(sig, t) {
    var body, pat, m, i;
    if (sig.slice(0, 3) === 're:') {
      body = sig.slice(3);
      pat = body.indexOf('|') < 0 ? body : body.slice(0, body.lastIndexOf('|'));
      if (!RX[pat]) RX[pat] = new RegExp(pat);
      m = RX[pat].exec(t);
      return m ? trim(m[0]) : null;
    }
    i = t.indexOf(sig);
    if (i < 0) return null;
    if (ALNUM.indexOf(sig.charAt(0)) >= 0) {
      while (i >= 0) {
        if (i === 0 || ALNUM.indexOf(t.charAt(i - 1)) < 0) return trim(sig);
        i = t.indexOf(sig, i + 1);
      }
      return null;
    }
    return trim(sig);
  }

  function hits(signals, t) {
    var out = [], i, h;
    signals = signals || [];
    for (i = 0; i < signals.length; i++) { h = hit(signals[i], t); if (h) out.push(h); }
    return out;
  }

  // n = a normalised sentence: does it hold one of the question words?
  function asksSomething(n) {
    for (var k = 0; k < DATA.question_words.length; k++) if (hit(DATA.question_words[k], n)) return true;
    return false;
  }

  // the QUESTION = the sentences that say what to find; falls back to the whole problem
  function questionOf(text) {
    var ss = sentences(text), qs = [], i;
    for (i = 0; i < ss.length; i++) if (asksSomething(norm(ss[i]))) qs.push(ss[i]);
    return qs.length ? qs.join(' ') : text;
  }

  function hasNumbers(text) { return /\d/.test(String(text).toLowerCase().replace(HEADER, ' ')); }

  function wordCount(text) {
    var w = trim(text);
    return w ? w.split(/\s+/).length : 0;
  }

  function sentenceLike(text) {
    var n = wordCount(text);
    return n >= 8 || (String(text).indexOf('?') >= 0 && n >= 3);
  }

  function distinct(list) {
    var seen = {}, n = 0, i;
    for (i = 0; i < list.length; i++) if (!seen['$' + list[i]]) { seen['$' + list[i]] = 1; n++; }
    return n;
  }

  // unless -> no. strong -> yes. Otherwise the plain signals count, unless a 'weak_unless' word is there,
  // and only when every 'all' word is there. 'unless_anywhere' is checked on the whole problem.
  function familyMatches(fam, t, P) {
    var strong, need, i;
    if (hits(fam.unless, t).length) return [];
    if (P != null && hits(fam.unless_anywhere, P).length) return [];
    strong = hits(fam.strong, t);
    if (strong.length) return strong;
    if (hits(fam.weak_unless, t).length) return [];
    need = fam.all || [];
    for (i = 0; i < need.length; i++) if (!hit(need[i], t)) return [];
    return hits(fam.signals, t);
  }

  function trapsFound(P, familyId) {
    var out = [], i, tr, got;
    for (i = 0; i < DATA.traps.length; i++) {
      tr = DATA.traps[i];
      if (tr.families && tr.families.length && tr.families.indexOf(familyId) < 0) continue;
      if (familyId === 'words' && tr.not_in_tool) continue;   // a word question ABOUT a final-exam topic is still answered in words
      got = hits(tr.signals, P);
      if (!got.length || hits(tr.unless, P).length) continue;
      out.push({ id: tr.id, when: tr.when, 'do': tr['do'], words: got.slice(0, 3), not_in_tool: !!tr.not_in_tool });
    }
    return out;
  }

  function anyNotInTool(traps) {
    for (var i = 0; i < traps.length; i++) if (traps[i].not_in_tool) return true;
    return false;
  }

  function identify(text, asks) {
    var body = dropCover(text);
    var rawAll = body + ' ' + (asks || '');
    var P = norm(rawAll);
    var Q = asks ? norm(asks) : norm(questionOf(body));
    var why = [], comboFirst = false, family = null, also = [];
    var fams = DATA.families, byId = {}, i, fam, got, weak, cands, best, c, traps;
    var memberAction = hits(DATA.member_action_words, Q).length > 0;
    var loadAsk = hits(DATA.load_ask_words, Q).length > 0;
    var marks = { family: [], form: [] };
    for (i = 0; i < fams.length; i++) byId[fams[i].id] = fams[i];

    function scopeText(f, passNo) {
      var use = f.use || 'problem';
      if (use === 'question') return Q;
      if (use === 'question_then_problem') return passNo === 1 ? Q : P;
      return P;
    }

    for (i = 0; i < fams.length; i++) {            // pass 1: the ladder, top to bottom, on the QUESTION
      fam = fams[i];
      if (fam.last) continue;                       // last-resort steps are tried after both passes
      got = familyMatches(fam, scopeText(fam, 1), P);
      if (!got.length && fam.no_numbers && !hasNumbers(rawAll) && sentenceLike(rawAll) && !hits(fam.unless, Q).length &&
          !hits(fam.no_numbers_unless, P).length) {
        got = ['no numbers anywhere'];
      }
      if (!got.length && fam['continue'] && !memberAction) {
        got = hits(fam.alone, scopeText(fam, 1));   // words that count only when no member is asked for
        if (got.length) loadAsk = true;
      }
      if (!got.length) continue;
      if (fam['continue']) {
        comboFirst = true;
        why.push(fam.id + ': ' + got.slice(0, 3).join(', '));
        if (loadAsk && !memberAction) { family = fam; comboFirst = false; marks.family = got; break; }
        continue;                                   // otherwise: combinations FIRST, then on down to the member
      }
      if (family === null) {
        family = fam;
        marks.family = got;
        why.push(fam.id + ': ' + got.slice(0, 3).join(', '));
      } else if (fam.use === 'question_then_problem') {
        also.push(fam.id);                          // a second member family named in the same question
      }
      if (fam.use !== 'question_then_problem') break;
    }
    if (family === null) {                          // pass 2: the whole problem; most giveaway words wins
      cands = [];                                   // (weak words -- bolts, holes, welds -- count, but lose a tie)
      for (i = 0; i < fams.length; i++) {
        fam = fams[i];
        if (fam.use !== 'question_then_problem' || fam.last) continue;
        got = familyMatches(fam, P, P);
        weak = hits(fam.unless_anywhere, P).length ? [] : hits(fam.weak, P);
        if (got.length || weak.length) cands.push([distinct(got) + distinct(weak), distinct(got), fam, got.concat(weak)]);
      }
      if (cands.length) {
        best = cands[0];
        for (i = 1; i < cands.length; i++) {
          c = cands[i];
          if (c[0] > best[0] || (c[0] === best[0] && c[1] > best[1])) best = c;
        }
        family = best[2];
        marks.family = best[3];
        why.push(family.id + ': ' + best[3].slice(0, 3).join(', '));
        also = [];
        for (i = 0; i < cands.length; i++) if (cands[i][2] !== family) also.push(cands[i][2].id);
      }
    }
    if (family === null) {
      for (i = 0; i < fams.length; i++) {
        fam = fams[i];
        if (!fam.last) continue;
        got = familyMatches(fam, P);
        if (got.length) { family = fam; marks.family = got; why.push(fam.id + ': ' + got.slice(0, 3).join(', ')); break; }
      }
    }
    if (family === null) {
      if (comboFirst) { family = byId.combo; comboFirst = false; }
      else {
        traps = trapsFound(P, null);
        return { family: null, form: null, tab: null, then: null, page: null, fn: null, then_fn: null,
          combo_first: false, why: ['no step matched'], question: Q.replace(/^ +| +$/g, ''), rider: false,
          traps: traps, want: null, go: null, also: [], clear: false, by_default: false, last_resort: false,
          not_in_tool: anyNotInTool(traps),
          marks: marks };
      }
    }
    if (comboFirst && family.id === 'loads') { family = byId.combo; comboFirst = false; }
    var famId = family.forms || family.id;
    var form = null, forms = DATA.forms[famId], si, scope, k, f, sig, ok, anySignals = false;
    for (k = 0; k < forms.length; k++) if (forms[k].signals && forms[k].signals.length) anySignals = true;
    for (si = 0; si < 2 && !form; si++) {
      scope = si === 0 ? Q : P;
      for (k = 0; k < forms.length; k++) {
        f = forms[k];
        sig = f.signals || [];
        if (f.q_only && si === 1) continue;          // counts only when the QUESTION itself says it
        if (!sig.length && si === 0 && anySignals) continue;   // defaults only after the whole problem was tried
        ok = true;
        for (i = 0; i < (f.signals_all || []).length; i++) if (!hit(f.signals_all[i], P)) ok = false;
        if (!ok) continue;
        got = hits(sig, scope);
        if (sig.length && !got.length) continue;
        if (hits(f.unless, scope).length) continue;
        form = f;
        marks.form = got;
        why.push(f.id + ': ' + (got.length ? got.slice(0, 3).join(', ') : 'default'));
        break;
      }
    }
    var words = byId.words;
    var rider = famId !== 'words' && hits((words.strong || []).concat(words.signals || []), Q).length > 0;
    var tab = form ? form.tab : null;
    var then = form && form.then !== undefined ? form.then : null;
    traps = trapsFound(P, famId);
    var byDefault = !!form && !(form.signals && form.signals.length) && forms.length > 1;
    var clear = !!form && !also.length && !byDefault;
    var alsoGo = [];
    for (i = 0; i < also.length; i++) alsoGo.push(byId[also[i]].go === undefined ? null : byId[also[i]].go);
    return { family: famId, form: form ? form.id : null, tab: tab, then: then,
      page: tab ? TABS[tab][0] : null, fn: tab ? TABS[tab][1] : null, then_fn: then ? TABS[then][1] : null,
      combo_first: comboFirst, why: why, question: Q.replace(/^ +| +$/g, ''), rider: rider, traps: traps,
      want: form ? form.want : null, go: family.go === undefined ? null : family.go, also: alsoGo, clear: clear,
      by_default: byDefault, last_resort: !!family.last && byDefault,
      not_in_tool: anyNotInTool(traps), marks: marks };
  }

  // '(a) yield strength (b) plastic strain ...' after a stem that says 'is called' / 'which of the following':
  // short, no numbers, none of them asks anything. A list of short asks after 'Determine the following:' is NOT
  // answer choices: each is a part.
  function answerChoices(stem, parts) {
    var i;
    for (i = 0; i < parts.length; i++) if (!(wordCount(parts[i][1]) <= 6 && !/\d/.test(parts[i][1]))) return false;
    for (i = 0; i < parts.length; i++) if (asksSomething(norm(parts[i][1]))) return false;
    return hits(CHOICE_STEMS, norm(stem)).length > 0;
  }

  // Lettered or numbered parts. Returns { stem, parts: [[label, text]] }; no parts -> parts = [].
  // Markers must come in order (a, b, c ... or 1, 2, 3 ...), so 'Repeat (a) for ...' inside part (b) is not a
  // new part. Three styles: (a) (a): (a)Find  |  a) at a line start or after a sentence  |  1. 2) at a line start.
  function splitParts(text) {
    text = String(text);
    var re = /(?:^|\s)\(([a-h])\)[:.]?\s*|(?:^|\n|[.?;:]\s)\s*([a-h])\)\s+|(?:^|\n|[.?;:]\s)\s*([1-9])[.)]\s+|(?:^|\s)\((i{1,3}|iv|v|vi{1,3})\)[:.]?\s*/g;
    var ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii'], ORDER = [1, 2, 4, 3];   // (a)   a)   (i)   1.
    var cands = [], m, style, seq = [], want, i, o, k, end, parts = [], stem;
    while ((m = re.exec(text)) !== null) {
      for (style = 1; style <= 4; style++) if (m[style]) cands.push([m.index, m.index + m[0].length, m[style], style]);
      if (m[0].length === 0) re.lastIndex++;
    }
    for (o = 0; o < ORDER.length; o++) {
      style = ORDER[o];
      seq = [];
      for (i = 0; i < cands.length; i++) {
        k = seq.length;
        if (cands[i][3] !== style || k >= 8) continue;
        want = style === 4 ? ROMAN[k] : (style === 3 ? String(k + 1) : String.fromCharCode(97 + k));
        if (cands[i][2] === want) seq.push(cands[i]);
      }
      if (seq.length >= 2) break;
      seq = [];
    }
    if (!seq.length) return { stem: text, parts: [] };
    for (i = 0; i < seq.length; i++) {
      end = i + 1 < seq.length ? seq[i + 1][0] : text.length;
      parts.push([seq[i][2], trim(text.slice(seq[i][1], end))]);
    }
    stem = trim(text.slice(0, seq[0][0]));
    if (answerChoices(stem, parts)) return { stem: text, parts: [] };
    return { stem: stem, parts: parts };
  }

  // The whole job: one answer per lettered part (or one answer when there are no parts).
  // The set-up at the top gives the member; each part gives its own form.
  function route(text) {
    var body = dropCover(text), sp = splitParts(body), out = [], i, r;
    if (!sp.parts.length) {
      r = identify(text);
      r.letter = '';
      r.text = trim(body);
      return { stem: '', parts: [r] };
    }
    for (i = 0; i < sp.parts.length; i++) {
      r = identify(sp.stem, sp.parts[i][1]);
      r.letter = sp.parts[i][0];
      r.text = sp.parts[i][1];
      out.push(r);
    }
    return { stem: sp.stem, parts: out };
  }

  return { identify: identify, route: route, norm: norm, hit: hit, DATA: DATA };
});

