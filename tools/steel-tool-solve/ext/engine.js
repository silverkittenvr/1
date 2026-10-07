/* ==== engine.js ==== */
/* engine.js -- ARCH-232 steel tool: the calculation engine (pure functions).  ASCII only.

   STEEL.run(name, args)  ->  { ok:true, name, answer, values, steps, alternatives, flags, sources, tables }
                          or  { ok:false, name, error:{ code, message, suggestions } }      (never throws)
   STEEL.list()           ->  every function with its fields (name, label, unit, type, allowed values, default)

   No DOM, no files, no network: it only reads the data files that were loaded before it (data/*.js put everything in
   STEEL_DATA).  The same file runs in the browser (classic <script>), in node (tests/run.js) and later behind an AI adapter.

   Method: AISC 360-22 (LRFD), AISC Manual 16th Ed. tables, in the order Prof. Markis teaches them.
   Layout of this file:  1 utilities  2 data access  3 shapes  4 formulas  5 function registry
                         6 Lookup  7 Loads  8 Beam (+ floor plan)  9 Column  10 Tension  11 self-test helpers
*/
(function (root) {
  'use strict';

  var E_STEEL = 29000;   // modulus of elasticity of steel, ksi

  // the page is plain ES5; these two ES6 built-ins get a fallback so an old browser still works
  var HAS_LOG10 = typeof Math.log10 === 'function';
  function log10(x) { return HAS_LOG10 ? Math.log10(x) : Math.log(x) / Math.LN10; }
  function imul(a, b) {
    if (Math.imul) return Math.imul(a, b);
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff, bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0) | 0);
  }

  // =====================================================================================================
  // 1. UTILITIES
  // =====================================================================================================

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  // number -> text with at most d decimals, trailing zeros removed ("32.50" -> "32.5"); half rounded up like a hand calculation
  function n(x, d) {
    if (x === null || x === undefined || typeof x !== 'number' || !isFinite(x)) return '?';
    if (d === undefined) d = 2;
    var m = Math.pow(10, d);
    var v = Math.round(Math.abs(x) * m + 1e-9) / m;
    var s = v.toFixed(d);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (x < 0 && v !== 0) s = '-' + s;
    return s;
  }

  // two numbers compared in one sentence ("36.41 > 36.40"): both with enough decimals (up to 4) that the printed texts differ whenever the numbers do
  function nPair(a, b, d) {
    var k = d;
    while (k < 4 && n(a, k) === n(b, k) && a !== b) k++;
    return [n(a, k), n(b, k)];
  }

  // number -> text with exactly d decimals
  function fixed(x, d) {
    if (typeof x !== 'number' || !isFinite(x)) return '?';
    var m = Math.pow(10, d);
    var v = Math.round(Math.abs(x) * m + 1e-9) / m;
    return (x < 0 && v !== 0 ? '-' : '') + v.toFixed(d);
  }

  // Round the DECIMAL TEXT of x half-up to p decimals (p may be negative = tens, hundreds).  This is how the kit's python
  // (decimal module on repr(x)) rounds the Manual's 3-significant-figure numbers, so 202.5 -> 203 and 15487.5 -> 15500.
  function roundHalfUpDec(x, p) {
    var ax = Math.abs(x);
    var s = String(ax);
    if (/e/i.test(s)) s = ax.toFixed(20);
    var parts = s.split('.');
    var ip = parts[0], fp = parts[1] || '';
    var digits = ip + fp;
    var keep = ip.length + p;
    var kept, up;
    if (keep < 0) return 0;
    if (keep >= digits.length) return x;
    up = digits.charAt(keep) >= '5';
    kept = digits.substring(0, keep);
    if (kept === '') kept = '0';
    if (up) {
      var arr = kept.split(''), i = arr.length - 1;
      while (i >= 0) {
        if (arr[i] === '9') { arr[i] = '0'; i--; } else { arr[i] = String(Number(arr[i]) + 1); break; }
      }
      kept = (i < 0 ? '1' : '') + arr.join('');
    }
    var out = Number(kept + 'e' + (-p));
    return x < 0 ? -out : out;
  }

  // 3 significant figures, halves rounded UP, exactly as the kit's calculated tables (and a printed Manual table) do
  function sig3(x) {
    if (x === 0) return 0;
    var ax = Math.abs(x);
    var e10 = Math.floor(log10(ax));
    if (!HAS_LOG10) { if (Math.pow(10, e10 + 1) <= ax) e10++; else if (Math.pow(10, e10) > ax) e10--; }
    var p = 2 - e10;
    var r9 = Number(ax.toFixed(9));
    var out = roundHalfUpDec(r9, p);
    return x < 0 ? -out : out;
  }

  // round UP to the next whole number, ignoring floating-point dust (47.0000000001 stays 47)
  function ceilTol(x) { return Math.ceil(x - 1e-9); }

  function sum(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s; }
  function minOf(arr) { var m = Infinity; for (var i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i]; return m; }
  function maxOf(arr) { var m = -Infinity; for (var i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i]; return m; }
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isBlank(v) { return v === undefined || v === null || (typeof v === 'string' && v.replace(/\s+/g, '') === ''); }
  function today() { return new Date().toISOString().slice(0, 10); }
  // true when the caller really filled a field in: 0, false, "" and an empty list all mean "nothing was entered"
  function isSet(v) { return v !== undefined && v !== null && v !== '' && v !== false && v !== 0 && !(Array.isArray(v) && v.length === 0); }

  // parse a dimension: 12, "12", "7/8", "1 1/2", "1-1/2", ".875", "1,200" ; returns NaN when it is not a number
  function parseNum(x) {
    if (typeof x === 'number') return isFinite(x) ? x : NaN;
    if (x === null || x === undefined || typeof x === 'boolean') return NaN;
    var s = String(x).trim();
    if (s === '') return NaN;
    s = s.replace(/\u2212/g, '-').replace(/\u2013/g, '-').replace(/\u2044/g, '/');
    s = s.replace(/\u00bd/g, ' 1/2').replace(/\u00bc/g, ' 1/4').replace(/\u00be/g, ' 3/4')
      .replace(/\u215b/g, ' 1/8').replace(/\u215c/g, ' 3/8').replace(/\u215d/g, ' 5/8').replace(/\u215e/g, ' 7/8').trim();
    if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    var m;
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s);
    m = /^([-+]?)(\d+)\s*\/\s*(\d+)$/.exec(s);
    if (m) { var den = Number(m[3]); return den === 0 ? NaN : (m[1] === '-' ? -1 : 1) * Number(m[2]) / den; }
    m = /^([-+]?)(\d+)\s*[- ]\s*(\d+)\s*\/\s*(\d+)$/.exec(s);
    if (m) { var d2 = Number(m[4]); return d2 === 0 ? NaN : (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3]) / d2); }
    return NaN;
  }

  // ---- errors are results: inside the engine they are thrown as EngineError and turned into { ok:false } by run()
  function EngineError(code, message, suggestions, extra) {
    this.code = code; this.message = message; this.suggestions = suggestions || []; this.extra = extra || null;
  }
  EngineError.prototype = Object.create(Error.prototype);
  function fail(code, message, suggestions, extra) { throw new EngineError(code, message, suggestions, extra); }

  function errorResult(name, code, message, suggestions, extra) {
    var err = { code: code, message: message, suggestions: suggestions || [] };
    if (extra) { for (var k in extra) { if (has(extra, k)) err[k] = extra[k]; } }
    return { ok: false, name: name, error: err };
  }

  // ---- result builder: every function fills one of these
  function Res(name) {
    this.o = { ok: true, name: name, answer: null, values: {}, steps: [], alternatives: [], flags: [], sources: [], tables: [] };
    this.given = {};   // names of the fields the caller filled in (a default is not "given")
  }
  Res.prototype.gave = function (k) { return Object.prototype.hasOwnProperty.call(this.given, k); };
  Res.prototype.src = function (s) { if (s && this.o.sources.indexOf(s) < 0) this.o.sources.push(s); return this; };
  // meta (optional): { referenceOnly: true, note: '...' } = a number printed for information that must NOT be used as the answer (the note says what to use instead)
  Res.prototype.val = function (key, value, unit, source, meta) {
    var o = { value: value, unit: unit || '', source: source || '' };
    if (meta && meta.referenceOnly) o.referenceOnly = true;
    if (meta && meta.note) o.note = meta.note;
    this.o.values[key] = o;
    if (source) this.src(source);
    return this;
  };
  Res.prototype.step = function (text, source) { this.o.steps.push({ text: text, source: source || '' }); if (source) this.src(source); return this; };
  // meta (optional): { adequacyRoute: true } = a number that may be compared with a load (column_capacity); { referenceOnly: true } = shown for reference, NEVER compared
  Res.prototype.alt = function (label, value, unit, text, meta) {
    var o = { label: label, value: value, unit: unit || '', text: text || '' };
    if (meta && meta.adequacyRoute) o.adequacyRoute = true;
    if (meta && meta.referenceOnly) o.referenceOnly = true;
    this.o.alternatives.push(o);
    return this;
  };
  Res.prototype.flag = function (text) { if (this.o.flags.indexOf(text) < 0) this.o.flags.push(text); return this; };
  // the same flag, but FIRST in the list (the A1 "NOT RELIABLE" warning is the first thing the reader meets, whatever notes came before it)
  Res.prototype.flagFirst = function (text) { var f = this.o.flags, i = f.indexOf(text); if (i >= 0) f.splice(i, 1); f.unshift(text); return this; };
  Res.prototype.answer = function (label, value, unit, text) { this.o.answer = { label: label, value: value, unit: unit || '', text: text || '' }; return this; };
  Res.prototype.table = function (title, columns, rows, note) { this.o.tables.push({ title: title, columns: columns, rows: rows, note: note || '' }); return this; };
  Res.prototype.out = function () { return this.o; };

  // ---- where the numbers come from (printed next to every step)
  var SRC = {
    shapes: 'AISC Manual Part 1 shapes tables (Shapes Database v16.0)',
    t414: 'Table 4-14 (her slides call it Table 4-22)',
    t41a: 'Table 4-1a',
    t32: 'Table 3-2 (economy table; bold = lightest)',
    t322: 'Table 3-22 (her slides call it Table 3-23)',
    d31: 'Spec Table D3.1',
    ca71: 'Spec Table C-A-7.1 (use the recommended design K)',
    j33: 'Spec Table J3.3',
    e3: 'Spec E3 (flexural buckling)',
    e7: 'Spec E7 (slender elements)',
    f2: 'Spec F2 (compact I-shapes, fully braced)',
    f3: 'Spec F3 (flange not compact)',
    g21: 'Spec G2.1 (shear)',
    d2a: 'Spec D2(a): phi Pn = 0.90 Fy Ag (yielding)',
    d2b: 'Spec D2(b): phi Pn = 0.75 Fu Ae (rupture)',
    d3: 'Spec D3: Ae = U An',
    b43: 'Spec B4.3b (hole = bolt + 1/16 + 1/16 = bolt + 1/8; s^2/4g for staggered holes)',
    d1: 'Spec D1 (L/r <= 300 is a recommendation)',
    e2: 'Spec E2 (KL/r <= 200 is a recommendation)',
    lrfd: 'LRFD load combinations, her week-1 slide (with only D and L: the larger of 1.4D and 1.2D + 1.6L; Spec B2 / ASCE 7)',
    combos: 'Her week-1 slide, page 11: the full LRFD load combination list (data/rules.js, load_combinations)',
    mat: 'Her week-1 slide (Table 2-4 defaults)',
    statics: 'Statics (equilibrium of a simple span)',
    given: 'Given in the problem'
  };

  // =====================================================================================================
  // 2. DATA ACCESS (the data files, indexed once on first use)
  // =====================================================================================================

  function DATA() { return root.STEEL_DATA || {}; }
  var IDX = null;

  function settings() {
    var s = DATA().settings || {};
    return {
      tee_rule: s.tee_rule === 'spec' ? 'spec' : 'class',
      // column CAPACITY with KxLx = KyLy (W-shape, Fy 50, row inside the table): '4-1a' = the column table (her 9/30 review: W14x109 24 ft -> 931);
      // 'round-up' = KL/r rounded up, Table 4-14, x Ag (her sheets 5-3 .. 5-17 for unequal lengths)
      capacity_headline: s.capacity_headline === 'round-up' ? 'round-up' : '4-1a',
      // column SELECTION with equal KL: '4-1a' = straight into Table 4-1 (her sheets 6-7b, 6-7c); 'round-up' = the Table 4-14 route
      select_headline: s.select_headline === 'round-up' ? 'round-up' : '4-1a',
      // equal KL that is NOT a whole number of feet (0.8 x 19 = 15.2): 'next-row' = read Table 4-1a at the next whole-foot row ("just round up", HW 6-15);
      // 'off' = such a KL uses the KL/r route (the pre-10/05 behaviour)
      fractional_KL_table: s.fractional_KL_table === 'off' ? 'off' : 'next-row'
    };
  }

  function overridesOf(kind) {
    var o = DATA().overrides || [], out = [];
    for (var i = 0; i < o.length; i++) { if (o[i] && o[i].kind === kind) out.push(o[i]); }
    return out;
  }

  function ovText(o) { return 'OVERRIDE (data/overrides.js): ' + (o.reason || 'no reason given') + ' -- source: ' + (o.source || 'none given'); }

  // type + number-token key, used to find "HSS6x6x.25" when the Manual says HSS6X6X1/4
  function normName(s) {
    s = String(s === undefined || s === null ? '' : s).trim().toUpperCase();
    s = s.replace(/\u00d7/g, 'X').replace(/\*/g, 'X');
    s = s.replace(/(\d)\s+(\d+\/\d+)/g, '$1-$2');
    return s.replace(/\s+/g, '');
  }

  function splitFamily(norm) {
    var m = /^(2L|[A-Z]+)(.*)$/.exec(norm);
    return m ? { type: m[1], rest: m[2] } : { type: '', rest: norm };
  }

  // key such as "W|14|90" or "HSS|6|6|0.25" ; null when the name does not parse
  function shapeKey(norm) {
    var f = splitFamily(norm);
    if (!f.type) return null;
    if (f.type === 'PIPE') {
      var pm = /^([\d.\/-]+)(STD|XXS|XS)$/.exec(f.rest);
      if (!pm) return null;
      var pd = parseNum(pm[1].replace(/^(\d+)-(\d+\/\d+)$/, '$1 $2'));
      return isFinite(pd) ? 'PIPE|' + Math.round(pd * 10000) / 10000 + '|' + pm[2] : null;
    }
    var toks = f.rest.split('X'), parts = [], suffix = '';
    for (var i = 0; i < toks.length; i++) {
      var tm = /^([\d.\/-]+)([A-Z]*)$/.exec(toks[i]);
      if (!tm) return null;
      var v = parseNum(tm[1].replace(/^(\d+)-(\d+\/\d+)$/, '$1 $2'));
      if (!isFinite(v)) return null;
      parts.push(Math.round(v * 10000) / 10000);
      if (tm[2]) { if (i !== toks.length - 1) return null; suffix = tm[2]; }
    }
    return f.type + '|' + parts.join('|') + (suffix ? '|' + suffix : '');
  }

  function buildIndex() {
    var S = DATA().shapes;
    var I = { byLabel: {}, byEdi: {}, byKey: {}, byType: {}, all: [], types: [], t32: {}, t32list: [], t414: null, t414cols: {}, t41a: {}, flags: {}, ovShape: {} };
    if (!S || !S.types) { IDX = I; return I; }
    var ovs = overridesOf('shape'), k, i, j;
    var order = S.typeOrder || Object.keys(S.types);
    for (k = 0; k < order.length; k++) {
      var t = order[k], T = S.types[t];
      I.types.push(t); I.byType[t] = [];
      for (i = 0; i < T.rows.length; i++) {
        var s = { type: t }, row = T.rows[i];
        for (j = 0; j < T.columns.length; j++) { if (row[j] !== null) s[T.columns[j]] = row[j]; }
        s.label = s.AISC_Manual_Label;
        s.overrides = [];
        I.byLabel[normName(s.label)] = s;
        if (s.EDI_Std_Nomenclature) I.byEdi[normName(s.EDI_Std_Nomenclature)] = s;
        var key = shapeKey(normName(s.label));
        if (key) { (I.byKey[key] = I.byKey[key] || []).push(s); }
        I.byType[t].push(s); I.all.push(s);
      }
    }
    for (i = 0; i < ovs.length; i++) {
      var o = ovs[i], target = I.byLabel[normName(o.shape)];
      if (target && o.property) { target[o.property] = o.value; target.overrides.push(o); }
    }
    var TB = DATA().tables || {};
    if (TB.calc_4_14) {
      I.t414 = TB.calc_4_14;
      for (i = 0; i < TB.calc_4_14.fys.length; i++) I.t414cols[TB.calc_4_14.fys[i]] = i + 1;
    }
    if (TB.calc_4_1a) I.t41a = TB.calc_4_1a;
    if (TB.calc_3_2) {
      var ov32 = overridesOf('table_3_2');
      for (i = 0; i < TB.calc_3_2.rows.length; i++) {
        var r = TB.calc_3_2.rows[i];
        var e = { shape: r[0], W: r[1], Zx: r[2], phiMp: r[3], phiMp3: r[4], Ix: r[5], phiVn: r[6], bold: r[7] === 1, noncompact: r[8] === 1, override: null };
        for (j = 0; j < ov32.length; j++) { if (normName(ov32[j].shape) === normName(e.shape)) { e.phiMp3 = ov32[j].value; e.override = ov32[j]; } }
        I.t32[normName(e.shape)] = e; I.t32list.push(e);
      }
    }
    if (TB.flags) {
      for (i = 0; i < TB.flags.rows.length; i++) {
        var f = TB.flags.rows[i];
        (I.flags[normName(f[0])] = I.flags[normName(f[0])] || []).push({ type: f[1], condition: f[2] });
      }
    }
    IDX = I;
    return I;
  }
  function idx() { return IDX || buildIndex(); }

  // ---- shape lookup -------------------------------------------------------------------------------
  var KEY_PROPS = {
    W: ['W', 'A', 'd', 'bf', 'tw', 'tf', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry'],
    M: ['W', 'A', 'd', 'bf', 'tw', 'tf', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry'],
    S: ['W', 'A', 'd', 'bf', 'tw', 'tf', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry'],
    HP: ['W', 'A', 'd', 'bf', 'tw', 'tf', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry'],
    C: ['W', 'A', 'd', 'bf', 'tw', 'tf', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry', 'x'],
    MC: ['W', 'A', 'd', 'bf', 'tw', 'tf', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry', 'x'],
    WT: ['W', 'A', 'd', 'bf', 'tw', 'tf', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry', 'y'],
    MT: ['W', 'A', 'd', 'bf', 'tw', 'tf', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry', 'y'],
    ST: ['W', 'A', 'd', 'bf', 'tw', 'tf', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry', 'y'],
    L: ['W', 'A', 'd', 'b', 't', 'Ix', 'Sx', 'rx', 'Iy', 'Sy', 'ry', 'rz', 'x', 'y'],
    '2L': ['W', 'A', 'd', 'b', 't', 'Ix', 'Sx', 'rx', 'Iy', 'Sy', 'ry'],
    HSS: ['W', 'A', 'Ht', 'B', 'OD', 'tnom', 'tdes', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry'],
    PIPE: ['W', 'A', 'OD', 'ID', 'tnom', 'tdes', 'Ix', 'Zx', 'Sx', 'rx', 'Iy', 'Zy', 'Sy', 'ry']
  };

  var PROP_INFO = {
    W: ['weight per foot', 'lb/ft'], A: ['gross area Ag', 'in^2'], d: ['overall depth d', 'in'], ddet: ['detailing depth', 'in'],
    Ht: ['overall height H', 'in'], h: ['flat depth h', 'in'], OD: ['outside diameter OD', 'in'], ID: ['inside diameter ID', 'in'],
    bf: ['flange width bf', 'in'], bfdet: ['detailing flange width', 'in'], B: ['overall width B', 'in'], b: ['flat width b', 'in'],
    tw: ['web thickness tw', 'in'], twdet: ['detailing web thickness', 'in'], 'twdet/2': ['half detailing web thickness', 'in'],
    tf: ['flange thickness tf', 'in'], tfdet: ['detailing flange thickness', 'in'], t: ['leg thickness t', 'in'],
    tnom: ['nominal wall thickness', 'in'], tdes: ['design wall thickness', 'in'], kdes: ['k distance (design)', 'in'], kdet: ['k distance (detailing)', 'in'],
    k1: ['k1 distance', 'in'], x: ['centroid x-bar', 'in'], y: ['centroid y-bar', 'in'], eo: ['shear center eo', 'in'], xp: ['plastic neutral axis xp', 'in'],
    yp: ['plastic neutral axis yp', 'in'], 'bf/2tf': ['flange slenderness bf/2tf', ''], 'b/t': ['slenderness b/t', ''], 'b/tdes': ['slenderness b/tdes', ''],
    'h/tw': ['web slenderness h/tw', ''], 'h/tdes': ['slenderness h/tdes', ''], 'D/t': ['slenderness D/t', ''],
    Ix: ['moment of inertia Ix', 'in^4'], Zx: ['plastic section modulus Zx', 'in^3'], Sx: ['elastic section modulus Sx', 'in^3'], rx: ['radius of gyration rx', 'in'],
    Iy: ['moment of inertia Iy', 'in^4'], Zy: ['plastic section modulus Zy', 'in^3'], Sy: ['elastic section modulus Sy', 'in^3'], ry: ['radius of gyration ry', 'in'],
    Iz: ['moment of inertia Iz (principal axis)', 'in^4'], rz: ['radius of gyration rz (minimum)', 'in'], Sz: ['section modulus Sz', 'in^3'],
    J: ['torsional constant J', 'in^4'], Cw: ['warping constant Cw', 'in^6'], C: ['HSS torsional constant C', 'in^3'], rts: ['rts', 'in'], ho: ['distance between flange centroids ho', 'in'],
    H: ['flexural constant H', ''], ro: ['polar radius of gyration ro', 'in'], T: ['T (clear web distance)', 'in']
  };
  var PROP_ALIASES = {
    weight: 'W', area: 'A', 'gross area': 'A', ag: 'A', depth: 'd', 'flange width': 'bf', 'web thickness': 'tw', 'flange thickness': 'tf',
    'moment of inertia': 'Ix', 'section modulus': 'Sx', 'plastic section modulus': 'Zx', 'radius of gyration': 'ry', thickness: 't'
  };

  function propInfo(name) { return PROP_INFO[name] || ['database column ' + name, '']; }
  // R2-9 + P7-3: the legs of a SINGLE angle are named by COMPARING the database's d and b (L5X3-1/2X1/2 has d = 3.5, b = 5: the long leg is the 5), never by assuming which name is which;
  // for a double angle d is the depth of the pair (the leg dimension back to back) and b the outstanding leg.
  function propInfoFor(sh, name) {
    if (sh && sh.type === 'L' && (name === 'd' || name === 'b') && isNum(sh.d) && isNum(sh.b)) {
      // decided by COMPARING the two numbers, never by assuming which name the database gives to which leg
      if (Math.abs(sh.d - sh.b) < 1e-9) return ['equal legs: d = b = ' + n(sh.d, 4) + ' in (AISC database naming)', 'in'];
      var bLong = sh.b > sh.d;
      return ['long leg ' + (bLong ? 'b' : 'd') + ' = ' + n(Math.max(sh.d, sh.b), 4) + ' in, short leg ' + (bLong ? 'd' : 'b') + ' = ' + n(Math.min(sh.d, sh.b), 4) + ' in (AISC database naming)', 'in'];
    }
    if (sh && sh.type === '2L' && (name === 'd' || name === 'b')) return ['AISC database naming for a double angle: d = ' + (isNum(sh.d) ? n(sh.d, 4) : '?') + ' in is the depth of the pair (the leg dimension back to back), b = ' + (isNum(sh.b) ? n(sh.b, 4) : '?') + ' in', 'in'];
    return propInfo(name);
  }

  // resolve what the user typed ("tw", "TW", "web thickness") to a column the shape really has
  function resolveProp(shape, text) {
    var raw = String(text).trim(), k;
    if (has(shape, raw) && raw !== 'type' && raw !== 'label' && raw !== 'overrides') return raw;
    for (k in shape) { if (has(shape, k) && k.toLowerCase() === raw.toLowerCase() && k !== 'type' && k !== 'label' && k !== 'overrides') return k; }
    var al = PROP_ALIASES[raw.toLowerCase()];
    if (al && has(shape, al)) return al;
    return null;
  }

  function numericProps(shape) {
    var out = [], k;
    for (k in shape) {
      if (!has(shape, k)) continue;
      if (k === 'type' || k === 'label' || k === 'overrides' || k === 'AISC_Manual_Label' || k === 'EDI_Std_Nomenclature' || k === 'T_F') continue;
      if (typeof shape[k] === 'number') out.push(k);
    }
    return out;
  }

  // nominal depth from the name (W16X31 -> 16)
  function nominalDepth(label) {
    var m = /^(?:[A-Z]+)(\d+(?:\.\d+)?)X/.exec(String(label).toUpperCase());
    return m ? Number(m[1]) : NaN;
  }

  // closest real shapes for a name that is not in the database.  Order: same family AND same weight first
  // (M8X3.7 -> M6X3.7), then the same numbers in another family (W6X17.5 typed for WT6X17.5), then the nearest in the family.
  function suggestShapes(norm) {
    var I = idx(), f = splitFamily(norm), out = [], seen = {};
    function add(s) { if (s && !seen[s.label] && out.length < 8) { seen[s.label] = true; out.push(s.label); } }
    var key = shapeKey(norm), toks = [];
    if (key) { toks = key.split('|').slice(1).map(Number); }
    var sameFam = I.byType[f.type] || [];
    var weightFirst = { W: 1, M: 1, S: 1, HP: 1, C: 1, MC: 1, WT: 1, MT: 1, ST: 1 };
    var scored = [], i, j;
    for (i = 0; i < sameFam.length; i++) {
      var k2 = shapeKey(normName(sameFam[i].label));
      if (!k2) continue;
      var t2 = k2.split('|').slice(1).map(Number);
      var eq = 0, dist = 0;
      for (j = 0; j < Math.max(toks.length, t2.length); j++) {
        if (toks[j] === t2[j]) eq++;
        dist += Math.abs((toks[j] || 0) - (t2[j] || 0)) / (Math.abs(toks[j] || 0) + 1);
      }
      var last = (toks.length && t2.length && toks[toks.length - 1] === t2[t2.length - 1]) ? 1 : 0;
      scored.push({ s: sameFam[i], last: last, eq: eq, dist: dist });
    }
    var byProx = function (a, b) { return b.eq - a.eq || a.dist - b.dist; };
    if (weightFirst[f.type]) {
      scored.filter(function (x) { return x.last; }).sort(byProx).forEach(function (x) { add(x.s); });
    }
    if (key) {
      var rest = key.split('|').slice(1).join('|');
      for (i = 0; i < I.all.length; i++) {
        var kk = shapeKey(normName(I.all[i].label));
        if (kk && kk.split('|').slice(1).join('|') === rest && I.all[i].type !== f.type) add(I.all[i]);
      }
    }
    scored.sort(byProx);
    for (i = 0; i < scored.length && out.length < 6; i++) add(scored[i].s);
    return out;
  }

  // two labelled groups for a name that is not a shape (P5): "same depth, nearest weights" and "same weight, other depths" (shapes named TYPE depth x weight)
  function groupedSuggestions(norm) {
    var f = splitFamily(norm), I = idx(), list = I.byType[f.type], nums = (f.rest || '').match(/[0-9]+(?:\.[0-9]+)?/g), out = [];
    if (!list || !nums || nums.length < 2 || !/^(W|M|S|HP|C|MC|WT|MT|ST)$/.test(f.type)) return out;
    var depth = Number(nums[0]), wt = Number(nums[nums.length - 1]);
    function nomD(sh) { var m = /^[A-Z]+([0-9]+)/.exec(sh.label); return m ? Number(m[1]) : null; }
    var sameDepth = list.filter(function (sh) { return nomD(sh) === depth && isNum(sh.W); }).sort(function (p, q) { return Math.abs(p.W - wt) - Math.abs(q.W - wt) || p.W - q.W; }).slice(0, 4);
    var sameWeight = list.filter(function (sh) { return nomD(sh) !== depth && isNum(sh.W) && Math.abs(sh.W - wt) < 0.25; }).sort(function (p, q) { return Math.abs(nomD(p) - depth) - Math.abs(nomD(q) - depth) || nomD(p) - nomD(q); }).slice(0, 4);
    if (sameDepth.length) out.push({ label: 'same depth, nearest weights', items: sameDepth.map(function (sh) { return sh.label; }) });
    if (sameWeight.length) out.push({ label: 'same weight, other depths', items: sameWeight.map(function (sh) { return sh.label; }) });
    return out;
  }

  // find a shape by whatever the user typed; throws NOT_FOUND (with suggestions) or AMBIGUOUS
  function findShape(name) {
    var I = idx();
    if (isBlank(name)) fail('MISSING', 'Enter a shape name such as W14x90.', []);
    var norm = normName(name);
    var s = I.byLabel[norm] || I.byEdi[norm];
    if (s) return s;
    var key = shapeKey(norm);
    if (key && I.byKey[key]) {
      if (I.byKey[key].length === 1) return I.byKey[key][0];
      fail('AMBIGUOUS', '"' + name + '" matches more than one shape: ' + I.byKey[key].map(function (x) { return x.label; }).join(', ') + '.', I.byKey[key].map(function (x) { return x.label; }));
    }
    // double angles: "2L8x4x1/2" has several back-to-back variants in the Manual
    var f = splitFamily(norm);
    if (key && f.type === '2L') {
      var cands = [], k;
      for (k in I.byKey) { if (has(I.byKey, k) && k.indexOf(key + '|') === 0) cands = cands.concat(I.byKey[k]); }
      if (cands.length === 1) return cands[0];
      if (cands.length > 1) fail('AMBIGUOUS', '"' + name + '" is a double angle with several back-to-back variants (LLBB = long legs back to back, SLBB = short legs back to back, then the gap): ' + cands.map(function (x) { return x.label; }).join(', ') + '. For tension use the single angle (L8X4X1/2) and set "angles" to 2.', cands.map(function (x) { return x.label; }));
    }
    var sug = suggestShapes(norm);
    // a real shape name followed by plate words ("W10x39 with 1/2x10 cover plates"): it is a built-up section, not a shape name
    var pm = /^(\S+)\s+(?:with|plus|and|\+|w\/)\s+.*\b(?:pl|plates?|cover)\b/i.exec(String(name).trim());
    if (pm) {
      var base = I.byLabel[normName(pm[1])];
      if (base) fail('NOT_FOUND', '"' + String(name).trim() + '" is not a shape name: this looks like ' + base.label + ' plus plates. Use Lookup > Section properties (the shape ' + base.label + ' and the plate thickness t and width b), then Column > Capacity with the same boxes.', [base.label]);
    }
    var grp = groupedSuggestions(norm);
    var ex = grp.length ? { suggestion_groups: grp } : undefined;
    fail('NOT_FOUND', '"' + String(name).trim() + '" is not a real shape in the Manual (Shapes Database v16.0).' + (sug.length ? ' Closest real shapes: ' + sug.slice(0, 5).join(', ') + '.' : '') + (grp.length ? ' ' + grp.map(function (g) { return g.label + ': ' + g.items.join(', '); }).join('; ') + '.' : ''), sug, ex);
  }

  function useShape(res, s) {
    for (var i = 0; i < s.overrides.length; i++) res.flag('WARNING: ' + ovText(s.overrides[i]) + ' (shape ' + s.label + ', ' + s.overrides[i].property + ' = ' + s.overrides[i].value + ').');
    return s;
  }

  function shapesInFamily(fam, res) {
    var I = idx();
    var norm = normName(fam);
    var f = splitFamily(norm);
    var list = I.byType[f.type];
    if (!list) fail('NOT_FOUND', '"' + fam + '" is not a shape family. Families: ' + I.types.join(', ') + '.', I.types);
    if (!f.rest) return list.slice();
    var prefix = f.type + f.rest + (f.type === 'PIPE' ? '' : 'X');
    var out = [];
    for (var i = 0; i < list.length; i++) { if (normName(list[i].label).indexOf(prefix) === 0) out.push(list[i]); }
    if (!out.length) fail('NOT_FOUND', 'No shape starts with ' + prefix + '. Try a family such as ' + f.type + ' or ' + f.type + ' plus a nominal size.', I.types);
    return out;
  }

  function sortByWeight(list) {
    return list.slice().sort(function (a, b) {
      return (a.W - b.W) || ((b.Zx || 0) - (a.Zx || 0)) || (a.label < b.label ? -1 : 1);
    });
  }

  // =====================================================================================================
  // 3. MATERIALS
  // =====================================================================================================

  function materialFor(familyType) {
    var M = DATA().materials;
    if (!M) return null;
    var ids = M.family_to_row || {};
    var rowId = ids[familyType];
    var ov = overridesOf('material'), i, row = null;
    for (i = 0; i < M.rows.length; i++) { if (M.rows[i].id === rowId) row = M.rows[i]; }
    if (!row) return null;
    var out = { Fy: row.Fy, Fu: row.Fu, spec: row.spec + (row.grade ? ' ' + row.grade : ''), source: row.source, derived: !!(M.derived_families && M.derived_families[familyType]), row: row, override: null };
    for (i = 0; i < ov.length; i++) { if (ov[i].family === familyType) { out.Fy = ov[i].Fy; out.Fu = ov[i].Fu; out.override = ov[i]; } }
    return out;
  }

  function plateMaterial() {
    var m = materialFor('PL');
    return m || { Fy: 36, Fu: 58, spec: 'ASTM A36', source: 'default', derived: false, row: null, override: null };
  }

  // P7-R3: her week-1 slide gives ONE steel for every HSS (A500 Gr C, Fy 50 / Fu 62).  AISC A500 Gr C ROUND is Fy 46 / Fu 62 (rectangular 50 / 62).  Nothing changes; the page says so.
  function isRoundHSS(s) { return !!s && s.type === 'HSS' && isNum(s.OD); }
  function roundHssNote(res, s, fy) {
    if (!isRoundHSS(s) || !isNum(fy) || Math.abs(fy - 50) > 1e-9) return;
    res.flag('NOTE: ' + s.label + ' is a ROUND HSS. Her slide uses Fy = 50 ksi for ALL HSS (A500 Gr C) and so does this tool; AISC A500 Gr C ROUND is Fy = 46 ksi / Fu = 62 ksi (rectangular 50 / 62). Type Fy 46 if the problem says A500 Gr C round.');
  }
  // P7-R3: AISC Table J3.3: the standard hole is bolt + 1/16 below 1 in and bolt + 1/8 from 1 in up; Spec B4.3b adds 1/16 for the damage.  So the AISC net-area hole is bolt + 1/8 (under 1 in)
  // or bolt + 3/16 (1 in and over).  Her rule is bolt + 1/8 for every size and stays the answer.
  function boltOverOne(bolt) { return isNum(bolt) && bolt >= 1 - 1e-9; }
  function boltOverOneNote(bolt, herHole) {
    return 'NOTE: for a bolt of 1 in or more (this one is ' + n(bolt, 4) + ' in) AISC Table J3.3 makes the STANDARD hole bolt + 1/8 (bolt + 1/16 below 1 in), so Spec B4.3b takes the NET-AREA hole as bolt + 1/8 + 1/16 = bolt + 3/16 = ' + n(bolt + 0.1875, 4) + ' in. Her rule is bolt + 1/8 for every size (' + n(herHole, 4) + ' in) and the answer follows her rule; the AISC value is shown as an alternative.';
  }

  // =====================================================================================================
  // 4. FORMULAS
  // =====================================================================================================

  // Critical stress, Spec E3. slend = KL/r.  Same arithmetic order as the kit's python so the numbers agree digit for digit.
  function fcrE3(slend, fy) {
    if (slend <= 0) return fy;
    var fe = Math.PI * Math.PI * E_STEEL / (slend * slend);
    if (slend <= 4.71 * Math.sqrt(E_STEEL / fy)) return Math.pow(0.658, fy / fe) * fy;
    return 0.877 * fe;
  }
  function feEuler(slend) { return Math.PI * Math.PI * E_STEEL / (slend * slend); }
  function limit471(fy) { return 4.71 * Math.sqrt(E_STEEL / fy); }

  // Table 4-14 value at a whole-number KL/r.  { value, printed:true|false }
  function table414(klr, fy) {
    var I = idx();
    var col = I.t414cols[fy];
    if (I.t414 && col && klr >= 1 && klr <= 200 && klr === Math.floor(klr)) {
      var ov = overridesOf('table_4_14');
      for (var i = 0; i < ov.length; i++) { if (ov[i].klr === klr && ov[i].fy === fy) return { value: ov[i].value, printed: true, override: ov[i] }; }
      return { value: I.t414.rows[klr - 1][col], printed: true, override: null };
    }
    return { value: sig3(0.9 * fcrE3(klr, fy)), printed: false, override: null };
  }

  // Slender elements in compression (Spec Table B4.1a), by shape family.  Returns [{ key, element, lam, limit }].
  // key ties an element to its Spec E7.1 result in columnStrength(): 'flange', 'web', 'narrow' / 'wide' (rectangular HSS walls), 'wall', 'stem', 'leg'.
  function slenderElements(s, fy) {
    var r = Math.sqrt(E_STEEL / fy), out = [], t = s.type;
    function chk(key, el, lam, lim) { if (isNum(lam) && lam > lim) out.push({ key: key, element: el, lam: lam, limit: lim }); }
    if (t === 'W' || t === 'M' || t === 'S' || t === 'HP') { chk('flange', 'flange (bf/2tf)', s['bf/2tf'], 0.56 * r); chk('web', 'web (h/tw)', s['h/tw'], 1.49 * r); }
    else if (t === 'C' || t === 'MC') { chk('flange', 'flange (b/t)', s['b/t'], 0.56 * r); chk('web', 'web (h/tw)', s['h/tw'], 1.49 * r); }
    else if (t === 'WT' || t === 'MT' || t === 'ST') { chk('flange', 'flange (bf/2tf)', s['bf/2tf'], 0.56 * r); chk('stem', 'stem (D/t)', s['D/t'], 0.75 * r); }
    else if (t === 'L' || t === '2L') { chk('leg', 'leg (b/t)', s['b/t'], 0.45 * r); }
    else if (t === 'HSS') {
      if (isNum(s.OD)) chk('wall', 'wall (D/t)', s['D/t'], 0.11 * E_STEEL / fy);
      else { chk('narrow', 'wall (b/tdes)', s['b/tdes'], 1.40 * r); chk('wide', 'wall (h/tdes)', s['h/tdes'], 1.40 * r); }
    } else if (t === 'PIPE') { chk('wall', 'wall (D/t)', s['D/t'], 0.11 * E_STEEL / fy); }
    return out;
  }

  // A rectangular HSS (not round, not pipe) with the design wall thickness and the flat-width ratios the Spec E7.1 check needs.
  function isRectHSS(s) { return s.type === 'HSS' && !isNum(s.OD) && isNum(s.tdes) && isNum(s['b/tdes']) && isNum(s['h/tdes']); }

  // Spec E7.1 for ONE element.  Fn = the UNFACTORED nominal stress (E3 on the gross section, no phi).
  //   lambda <= lambda_r sqrt(Fy/Fn):  be = b                                  (E7-2, no reduction)
  //   lambda >  lambda_r sqrt(Fy/Fn):  be = b (1 - c1 sqrt(Fel/Fn)) sqrt(Fel/Fn),  Fel = (c2 lambda_r / lambda)^2 Fy   (E7-3, E7-5)
  // be never exceeds b.  Being "slender" by Table B4.1a (lambda > lambda_r) is NOT enough: at Fn below Fy the element can still be fully effective.
  function effectiveWidth(b, lam, lamR, c1, c2, fy, fn) {
    var limit = lamR * Math.sqrt(fy / fn), fel = null, be = b;
    if (lam > limit) {
      fel = Math.pow(c2 * lamR / lam, 2) * fy;
      be = Math.min(b, b * (1 - c1 * Math.sqrt(fel / fn)) * Math.sqrt(fel / fn));
    }
    return { b: b, be: be, lam: lam, lamR: lamR, limit: limit, fel: fel, c1: c1, c2: c2, reduced: be < b - 1e-12 };
  }

  // Axial strength at a given KL/r: E3 for Fn (= Fcr), then Spec E7.1 (effective area Ae) for the slender elements of a W-shape
  // (web: c1 0.18, c2 1.31; flanges: c1 0.22, c2 1.49) or the walls of a RECTANGULAR HSS (Table E7.1 case b: c1 0.20, c2 1.38, lambda_r = 1.40 sqrt(E/Fy),
  // wall by wall with the design thickness and the flat widths b = (b/tdes) tdes, h = (h/tdes) tdes).  Every other family: E3 on the gross area only
  // (round HSS, pipe, channels, angles and tees are flagged, not reduced).  e7 is true only when the area REALLY shrinks (Ae < Ag).
  // This is the kit's python phi_pn() with Fy as a parameter.
  function columnStrength(s, slend, fy) {
    var lamRFl = 0.56 * Math.sqrt(E_STEEL / fy), lamRWeb = 1.49 * Math.sqrt(E_STEEL / fy), lamRWall = 1.40 * Math.sqrt(E_STEEL / fy);
    var fcr = fcrE3(slend, fy), ae = s.A, elems = [], t;
    function take(key, name, count, b, lam, lamR, c1, c2, thick) {
      if (!isNum(b) || !isNum(lam) || !isNum(thick)) return;   // the database has no such ratio for this shape: nothing to reduce
      var ew2 = effectiveWidth(b, lam, lamR, c1, c2, fy, fcr);
      ew2.key = key; ew2.name = name; ew2.count = count; ew2.t = thick;
      if (ew2.reduced) ae -= count * (ew2.b - ew2.be) * thick;
      elems.push(ew2);
    }
    if (s.type === 'W') {
      take('web', 'web (h/tw)', 1, s['h/tw'] * s.tw, s['h/tw'], lamRWeb, 0.18, 1.31, s.tw);
      take('flange', 'flanges (bf/2tf)', 4, s.bf / 2.0, s['bf/2tf'], lamRFl, 0.22, 1.49, s.tf);
    } else if (isRectHSS(s)) {
      t = s.tdes;
      take('narrow', 'narrow walls (b/t)', 2, s['b/tdes'] * t, s['b/tdes'], lamRWall, 0.20, 1.38, t);
      take('wide', 'wide walls (h/t)', 2, s['h/tdes'] * t, s['h/tdes'], lamRWall, 0.20, 1.38, t);
    }
    return { fcr: fcr, ae: ae, phiPn: 0.9 * fcr * ae, e7: ae < s.A - 1e-9, elems: elems };
  }

  // Design flexural strength phi Mn (kip-ft) of a W-shape, compression flange fully braced: F2 (plastic) or F3 (flange not compact).
  // Same arithmetic order as the kit's python.
  function beamStrength(s, fy) {
    var lamP = 0.38 * Math.sqrt(E_STEEL / fy), lamR = 1.00 * Math.sqrt(E_STEEL / fy), shearLim = 2.24 * Math.sqrt(E_STEEL / fy);
    var mp = fy * s.Zx, mn = mp, lam = s['bf/2tf'];
    var nonCompact = isNum(lam) && lam > lamP;
    if (nonCompact) mn = mp - (mp - 0.7 * fy * s.Sx) * (lam - lamP) / (lamR - lamP);
    var phiV = (isNum(s['h/tw']) && s['h/tw'] <= shearLim) ? 1.0 : 0.9;
    return { mp: mp, mn: mn, phiMn: 0.9 * mn / 12.0, phiMp: 0.9 * mp / 12.0, nonCompact: nonCompact, lam: lam, lamP: lamP, lamR: lamR,
      phiVn: phiV * 0.6 * fy * s.d * s.tw };
  }

  // =====================================================================================================
  // 5. FUNCTION REGISTRY AND ARGUMENT HANDLING
  // =====================================================================================================

  var FUNCS = {};
  var ORDER = [];

  function def(name, section, label, description, fields, fn) {
    FUNCS[name] = { name: name, section: section, label: label, description: description, fields: fields, fn: fn };
    ORDER.push(name);
  }

  var TRUE_WORDS = { 'true': 1, yes: 1, y: 1, on: 1, '1': 1, ticked: 1 };
  var FALSE_WORDS = { 'false': 1, no: 1, n: 1, off: 1, '0': 1, '': 1 };

  function optionValue(o) { return typeof o === 'object' ? o.value : o; }
  function optionLabel(o) { return typeof o === 'object' ? (o.label || o.value) : o; }

  // S1: a plausibility check on a typed bolt or hole size (a typed 7 is a dropped fraction bar: 7/8).  Not a limit of the physics, a typo guard.
  var BOLT_CANDIDATES = { 3: ['3/8', '3/4'], 5: ['5/8'], 7: ['7/8'] };
  function plausibleBolt(label, v, raw) {
    if (v >= 0.375 - 1e-9 && v <= 1.5 + 1e-9) return;
    var key = Math.round(v), cand = (Math.abs(v - key) < 1e-9 && has(BOLT_CANDIDATES, key)) ? BOLT_CANDIDATES[key] : null;
    fail('OUT_OF_RANGE', label + ' must be between 3/8 and 1-1/2 in (a structural bolt; a plausibility check). You typed: ' + String(raw) + '.' + (cand ? ' Did you mean ' + cand.join(' or ') + '? (a fraction bar was dropped: type ' + cand.join(' or ') + ')' : ' Fractions such as 7/8 or 1 1/8 are fine.'), cand || []);
  }
  function plausibleHole(label, v, raw) {
    if (v >= 0.4375 - 1e-9 && v <= 2 + 1e-9) return;
    fail('OUT_OF_RANGE', label + ' must be between 7/16 and 2 in (a bolt hole; a plausibility check). You typed: ' + String(raw) + '.');
  }

  function normField(spec, raw, where) {
    var label = (where ? where + ': ' : '') + (spec.label || spec.name);
    var v, i, m;
    switch (spec.type) {
      case 'number': case 'dimension': case 'integer':
        v = parseNum(raw);
        if (!isFinite(v)) fail('INVALID', label + ' must be a number (fractions such as 7/8 or 1 1/2 are fine; type just the number, the unit is ' + (spec.unit || 'shown beside the box') + '). You typed: ' + String(raw) + '.');
        if (spec.type === 'integer' && Math.floor(v) !== v) fail('INVALID', label + ' must be a whole number. You typed: ' + String(raw) + '.');
        if (spec.min !== undefined && (spec.minExclusive ? v <= spec.min : v < spec.min)) fail('OUT_OF_RANGE', label + ' must be ' + (spec.minExclusive ? 'greater than ' : 'at least ') + spec.min + (spec.unit ? ' ' + spec.unit : '') + '. You typed: ' + v + '.');
        if (spec.max !== undefined && v > spec.max) fail('OUT_OF_RANGE', label + ' must be at most ' + spec.max + (spec.unit ? ' ' + spec.unit : '') + '. You typed: ' + v + '.');
        if (spec.plausible === 'bolt') plausibleBolt(label, v, raw);
        if (spec.plausible === 'hole') plausibleHole(label, v, raw);
        return v;
      case 'boolean':
        if (typeof raw === 'boolean') return raw;
        v = String(raw).trim().toLowerCase();
        if (has(TRUE_WORDS, v)) return true;
        if (has(FALSE_WORDS, v)) return false;
        fail('INVALID', label + ' must be yes or no (true / false).');
        break;
      case 'select':
        v = String(raw).trim().toLowerCase().replace(/[\s_]+/g, '-');
        for (i = 0; i < spec.values.length; i++) {
          var ov = optionValue(spec.values[i]), ol = optionLabel(spec.values[i]);
          if (String(ov).toLowerCase().replace(/[\s_]+/g, '-') === v || String(ol).toLowerCase().replace(/[\s_]+/g, '-') === v) return ov;
        }
        fail('INVALID', label + ' must be one of: ' + spec.values.map(optionValue).join(', ') + '. You gave: ' + String(raw) + '.', spec.values.map(optionValue));
        break;
      case 'shape': case 'text':
        if (typeof raw === 'number' && !isFinite(raw)) fail('INVALID', label + ' must be text.');
        return String(raw).trim();
      case 'endcond':
        return endConditionId(raw);
      case 'numlist':
        if (typeof raw === 'string') {
          // Commas / semicolons and spaces separate the numbers ("8 16 24", "6, 12 18", "8 16,").  A whole number followed by a fraction
          // that stands ALONE between commas ("10, 20 1/2") is ONE mixed number.  Next to other numbers in the same piece ("10 20 1/2")
          // it could be one mixed number or two numbers: refused, with the comma advice.
          var pieces = raw.split(/[,;]/), flat = [], pc, toks, q;
          for (pc = 0; pc < pieces.length; pc++) {
            toks = pieces[pc].split(/\s+/).filter(function (x) { return x !== ''; });
            if (toks.length === 2 && /^[0-9]+$/.test(toks[0]) && /^[0-9]+\/[0-9]+$/.test(toks[1])) { flat.push(toks[0] + ' ' + toks[1]); continue; }
            for (q = 1; q < toks.length; q++) {
              if (/^[0-9]+\/[0-9]+$/.test(toks[q]) && /^[0-9]+$/.test(toks[q - 1])) fail('AMBIGUOUS', label + ': "' + toks.join(' ') + '" could be one mixed number (' + toks[q - 1] + ' ' + toks[q] + ') or separate numbers (' + toks[q - 1] + ' and ' + toks[q] + '). Separate the numbers with commas, for example "10, 20 1/2".');
            }
            for (q = 0; q < toks.length; q++) flat.push(toks[q]);
          }
          raw = flat;
        }
        if (!Array.isArray(raw)) fail('INVALID', label + ' must be a list of numbers.');
        return raw.map(function (x) {
          var q = parseNum(x);
          if (!isFinite(q)) fail('INVALID', label + ': "' + String(x) + '" is not a number.');
          return q;
        });
      case 'strlist':
        if (typeof raw === 'string') raw = raw.split(/[\s,;]+/).filter(function (x) { return x !== ''; });
        if (!Array.isArray(raw)) fail('INVALID', label + ' must be a list of names.');
        return raw.map(function (x) { return String(x).trim(); }).filter(function (x) { return x !== ''; });
      case 'list':
        if (!Array.isArray(raw)) fail('INVALID', label + ' must be a list.');
        return raw.map(function (item, k) {
          if (!item || typeof item !== 'object') fail('INVALID', label + ' item ' + (k + 1) + ' must be an object.');
          var o = {}, j;
          // an entry the list does not have would be dropped silently: refuse it, and say what the list does have
          var inames = spec.item.map(function (x) { return x.name; }), badKeys = [], key;
          for (key in item) { if (has(item, key) && inames.indexOf(key) < 0 && !isBlank(item[key])) badKeys.push(key); }
          if (badKeys.length) {
            var nearKeys = [];
            badKeys.forEach(function (u) { nearNames(u, inames).forEach(function (nm) { if (nearKeys.indexOf(nm) < 0) nearKeys.push(nm); }); });
            fail('INVALID', label + ' item ' + (k + 1) + ': ' + badKeys.map(function (u) { return '"' + u + '"'; }).join(', ') + (badKeys.length > 1 ? ' are not fields' : ' is not a field') + ' of this list, so ' + (badKeys.length > 1 ? 'they' : 'it') + ' would have been ignored.' + (nearKeys.length ? ' Did you mean: ' + nearKeys.join(', ') + '?' : '') + ' The fields are: ' + inames.join(', ') + '.', nearKeys);
          }
          for (j = 0; j < spec.item.length; j++) {
            var fs = spec.item[j];
            if (isBlank(item[fs.name])) {
              if (fs.required) fail('MISSING', label + ' item ' + (k + 1) + ': ' + (fs.label || fs.name) + ' is missing.');
              if (fs.default !== undefined) o[fs.name] = fs.default;
              continue;
            }
            o[fs.name] = normField(fs, item[fs.name], label + ' item ' + (k + 1));
          }
          return o;
        });
      case 'object':
        if (typeof raw !== 'object') fail('INVALID', label + ' must be an object.');
        return raw;
      default:
        return raw;
    }
    return raw;
  }

  // number of single-character edits between two words (small, for "did you mean")
  function editDistance(p, q) {
    var prev = [], cur, i, j;
    for (j = 0; j <= q.length; j++) prev.push(j);
    for (i = 1; i <= p.length; i++) {
      cur = [i];
      for (j = 1; j <= q.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (p.charAt(i - 1) === q.charAt(j - 1) ? 0 : 1)));
      prev = cur;
    }
    return prev[q.length];
  }

  // the field names closest to a misspelt one (at most 3)
  function nearNames(word, names) {
    var w = String(word).toLowerCase(), scored = [];
    names.forEach(function (nm) {
      var l = nm.toLowerCase(), d = editDistance(w, l);
      if (d <= Math.max(2, Math.floor(l.length / 3)) || (w.length > 2 && l.indexOf(w) >= 0) || (l.length > 2 && w.indexOf(l) >= 0)) scored.push({ n: nm, d: d });
    });
    scored.sort(function (p, q) { return p.d - q.d; });
    return scored.slice(0, 3).map(function (x) { return x.n; });
  }

  // fills in the defaults and checks every field.  An entry whose name is not a field of the function is REFUSED: it would be dropped silently.
  function normalizeArgs(f, args, given) {
    var a = {}, i, spec, k;
    if (args === null || args === undefined) args = {};
    if (typeof args !== 'object') fail('INVALID', 'Arguments must be an object of field values.');
    var names = f.fields.map(function (x) { return x.name; }), unknown = [], near = [];
    for (k in args) { if (has(args, k) && names.indexOf(k) < 0 && !isBlank(args[k])) unknown.push(k); }
    if (unknown.length) {
      unknown.forEach(function (u) { nearNames(u, names).forEach(function (nm) { if (near.indexOf(nm) < 0) near.push(nm); }); });
      fail('INVALID', unknown.map(function (u) { return '"' + u + '"'; }).join(', ') + (unknown.length > 1 ? ' are not fields' : ' is not a field') + ' of ' + f.name + ', so ' + (unknown.length > 1 ? 'they' : 'it') + ' would have been ignored.' + (near.length ? ' Did you mean: ' + near.join(', ') + '?' : '') + ' (STEEL.list() shows every field.)', near);
    }
    for (i = 0; i < f.fields.length; i++) {
      spec = f.fields[i];
      var raw = args[spec.name];
      var isListType = spec.type === 'list' || spec.type === 'numlist' || spec.type === 'strlist';
      if (isBlank(raw) || (Array.isArray(raw) && raw.length === 0 && !isListType)) {
        if (spec.default !== undefined && spec.default !== null && spec.default !== '') a[spec.name] = spec.default;
        // P9-5: a box that is required UNLESS another quantity is typed (the slab thickness when the dead load is given directly in psf): blank = 0.
        // Checked here, at the box's own position, so the order in which several missing boxes are reported does not change.  "Typed" = a number above 0
        // (the page pre-fills the dead-load boxes with 0, and a typed 0 is not a load).
        else if (spec.required && spec.requiredUnless && spec.requiredUnless.some(function (k) { var q = parseNum(args[k]); return isFinite(q) && q > 0; })) a[spec.name] = 0;
        else if (spec.required) fail('MISSING', 'Missing: ' + (spec.label || spec.name) + (spec.unit ? ' (' + spec.unit + ')' : '') + '.' + (spec.requiredUnless && spec.missingHint ? ' ' + spec.missingHint : ''), []);
        continue;
      }
      if (given) given[spec.name] = true;
      if (Array.isArray(raw) && raw.length === 0) { a[spec.name] = []; continue; }
      a[spec.name] = normField(spec, raw);
    }
    return a;
  }

  // P5: 123.19999999999999 is 123.2.  Rounded to 10 significant digits ONLY here, at the return boundary, on the numbers the caller reads (the headline,
  // every value, every alternative); no intermediate is ever rounded.
  function sig10(x) { return (typeof x === 'number' && isFinite(x) && x !== 0) ? Number(x.toPrecision(10)) : x; }
  function roundOut(o) {
    if (!o || o.ok !== true) return o;
    var k, i;
    if (o.answer && typeof o.answer.value === 'number') o.answer.value = sig10(o.answer.value);
    if (o.values) { for (k in o.values) { if (has(o.values, k) && o.values[k] && typeof o.values[k].value === 'number') o.values[k].value = sig10(o.values[k].value); } }
    if (o.alternatives) { for (i = 0; i < o.alternatives.length; i++) { if (typeof o.alternatives[i].value === 'number') o.alternatives[i].value = sig10(o.alternatives[i].value); } }
    if (o.stages) { for (i = 0; i < o.stages.length; i++) roundOut(o.stages[i]); }
    return o;
  }

  // P5: "key numbers" under the headline: the numbers a problem may ask for, labelled.  Read from the values the function already returns.
  var KEY_SPECS = {
    tension_capacity: [['Ag', 'Gross area Ag'], ['An', 'Net area An'], ['U', 'Shear lag factor U'], ['Ae', 'Effective net area Ae'], ['yielding', 'phi Pn, yielding (0.90 Fy Ag)'], ['rupture', 'phi Pn, rupture (0.75 Fu Ae)'], ['capacity', 'Design strength phi Pn (the smaller)'], ['governs', 'Governs'], ['L_over_r', 'L/r']],
    tension_net_area: [['Ag', 'Gross area Ag'], ['hole', 'Hole size used'], ['An', 'Net area An']],
    tension_select: [['selected_shape', 'Selected shape'], ['Ag_required', 'Ag required'], ['Ag', 'Ag'], ['An', 'An'], ['U', 'U'], ['Ae', 'Ae'], ['yielding', 'phi Pn, yielding'], ['rupture', 'phi Pn, rupture'], ['capacity', 'Design strength phi Pn'], ['Pu', 'Pu']],
    column_capacity: [['governing_axis', 'Governing axis'], ['KL_over_r', 'KL/r of the governing axis'], ['KL_over_r_rounded', 'KL/r rounded up'], ['phiFcr', 'phi Fcr (KL/r route, Table 4-14)'], ['phiPn', 'phi Pn (headline)'], ['Pu', 'Pu'], ['adequate', 'Adequate: phi Pn >= Pu? (headline)']],
    column_select: [['selected_shape', 'Selected shape'], ['KL_over_r', 'KL/r'], ['phiPn', 'phi Pn'], ['Pu', 'Pu']],
    column_euler: [['KL_over_r', 'KL/r'], ['Fe', 'Euler stress Fe'], ['Pcr', 'Pcr'], ['applicable', 'Euler applies?']],
    beam_select: [['Mu', 'Mu'], ['selected_shape', 'Selected shape'], ['phiMp_printed', 'phi Mp (printed)'], ['Mu_with_self_weight', 'Mu with its own weight'], ['weight', 'Weight']],
    beam_analysis: [['Mu', 'Mu'], ['Vu', 'Vu'], ['RA', 'RA'], ['RB', 'RB'], ['R_wall', 'Wall reaction'], ['w_total', 'Total uniform load wu']],
    beam_capacity: [['phiMp_printed', 'phi Mp (printed)'], ['phiMp', 'phi Mp (exact)'], ['phiVn', 'phi Vn']],
    floor_plan: [['step1_factored_psf', 'Factored floor load'], ['step2_wu', 'Beam line load wu'], ['step2_Mu', 'Beam Mu'], ['step2_beam_shape', 'Beam'], ['step2_beam_reaction', 'Beam reaction'], ['step3_Mu', 'Girder Mu'], ['step3_girder_shape', 'Girder'], ['step4_Pu', 'Column Pu'], ['step4_selected_shape', 'Column']],
    loads_takedown: [['Pu_bottom', 'Pu at the lowest level']],
    loads_floor: [['factored_psf', 'Factored floor load']],
    loads_max_service: [['phiRn', 'Design strength phi Rn'], ['U_combination_1', 'Combination 1: 1.4 D'], ['L_max', 'Maximum service live load L']],
    section_properties: [['A', 'A'], ['Ix', 'Ix'], ['Iy', 'Iy'], ['rx', 'rx'], ['ry', 'ry'], ['r_min', 'r_min'], ['S', 'Elastic section modulus S'], ['Z', 'Plastic section modulus Z'], ['shape_factor', 'Shape factor Z / S']]
  };
  function addKeyValues(name, o) {
    if (!o || o.ok !== true) return o;
    var spec = KEY_SPECS[name], out = [], i, v;
    if (spec && o.values) {
      for (i = 0; i < spec.length; i++) { v = o.values[spec[i][0]]; if (v && v.value !== undefined && v.value !== null && typeof v.value !== 'object') out.push({ label: spec[i][1], value: v.value, unit: v.unit || '' }); }
    }
    // A1: a tee / angle column number is flexural buckling only: the key-numbers table says so on the phi Pn line
    if (o.values && o.values.reference_phiPn_flexural_only) out.forEach(function (k) { if (/^phi Pn/.test(k.label)) k.label += ' -- NOT RELIABLE for this shape (E4/E5 not applied)'; });
    // R2-6: with a Table 4-1a headline the phi Fcr above is the KL/r ROUTE's (26.5 x 11.5 = 304.75, not the 306 of the table): say so, and show that route's phi Pn beside it
    if (name === 'column_capacity' && o.values && o.values.phiPn_table_4_1a && o.answer && /^Table 4-1a \(her method\)/.test(o.answer.text || '')) {
      var kk = [];
      out.forEach(function (k) {
        if (k.label === 'phi Pn (headline)') k.label = 'phi Pn from Table 4-1a (her method) (headline)';
        kk.push(k);
        if (/^phi Fcr \(KL\/r route/.test(k.label) && o.values.phiPn_round_up) kk.push({ label: 'phi Pn, KL/r route (phi Fcr x Ag)', value: o.values.phiPn_round_up.value, unit: 'kips' });
      });
      out = kk;
    }
    // P7-3: a custom / built-up section is NOT FULLY CHECKED: the phi Pn line says so
    if (o.values && o.values.not_fully_checked) out.forEach(function (k) { if (/^phi Pn/.test(k.label)) k.label += ' -- NOT FULLY CHECKED (plate slenderness / connectors)'; });
    // P7-2: the fenced comparisons (a flexural-buckling-only comparison, or NOT ACCEPTABLE for KL/r above 200): the label is the words themselves, never a generic "adequate"
    ['flexural_only_comparison', 'not_acceptable_KL_over_r'].forEach(function (k) { var v = o.values && o.values[k]; if (v && v.value !== undefined && v.value !== null) out.push({ label: v.source, value: v.value, unit: v.unit || '' }); });
    // P8-1: the beam's key numbers name the combination that governs each effect
    if (name === 'beam_analysis' && o.values && o.values.governing_combination) {
      var KEYC = { 'Mu': 'governing_combination', 'Vu': 'Vu_governing_combination', 'RA': 'RA_governing_combination', 'RB': 'RB_governing_combination', 'Wall reaction': 'R_wall_governing_combination', 'Total uniform load wu': 'governing_combination' };
      out.forEach(function (k) { var g = KEYC[k.label] && o.values[KEYC[k.label]]; if (g && g.value) k.label += ' (' + g.value + ')'; });
    }
    // R2-2: the verdict is shown as words
    out.forEach(function (k) { if (/^Adequate/.test(k.label) && typeof k.value === 'boolean') k.value = k.value ? 'YES' : 'NO'; });
    o.key_values = out;
    return o;
  }

  function run(name, args) {
    try {
      var f = FUNCS[name];
      if (!f) {
        var near = ORDER.filter(function (k) { return k.indexOf(String(name).toLowerCase()) >= 0 || String(name).toLowerCase().indexOf(k) >= 0; });
        return errorResult(name, 'NOT_FOUND', 'No such function: ' + name + '. See STEEL.list().', near.length ? near : ORDER.slice());
      }
      var res = new Res(name);
      var a = normalizeArgs(f, args, res.given);
      var out = f.fn(a, res), o = out instanceof Res ? out.out() : out;
      return addKeyValues(name, roundOut(o));
    } catch (e) {
      if (e instanceof EngineError) return errorResult(name, e.code, e.message, e.suggestions, e.extra);
      return errorResult(name, 'INVALID', 'Internal error: ' + (e && e.message ? e.message : String(e)), []);
    }
  }

  function list() {
    return ORDER.map(function (k) {
      var f = FUNCS[k];
      return { name: f.name, section: f.section, label: f.label, description: f.description, fields: clone(f.fields) };
    });
  }

  // small builders for field specs
  function F(name, type, label, unit, extra) {
    var o = { name: name, type: type, label: label, unit: unit || '' };
    if (extra) { for (var k in extra) { if (has(extra, k)) o[k] = extra[k]; } }
    return o;
  }

  // =====================================================================================================
  // 6. LOOKUP  (one value read from a table, no calculation)
  // =====================================================================================================

  // ---- K from end conditions (Spec Table C-A-7.1, recommended design values) ----
  var END_CONDITIONS = [
    { id: 'pinned-pinned', letter: 'c', label: 'pinned at both ends (braced frame, no sidesway)' },
    { id: 'fixed-fixed', letter: 'a', label: 'fixed at both ends (braced frame, no sidesway)' },
    { id: 'fixed-pinned', letter: 'b', label: 'one end fixed, the other pinned (braced frame, no sidesway)' },
    { id: 'fixed-sway', letter: 'd', label: 'fixed with sway -- top fixed against rotation but free to move sideways (sway / unbraced frame)' },
    { id: 'flagpole', letter: 'e', label: 'fixed-free "flagpole" -- fixed base, free top (sway / unbraced frame)' },
    { id: 'pinned-sway', letter: 'f', label: 'pinned with sway -- pinned base, top fixed against rotation but free to move sideways (sway / unbraced frame)' }
  ];
  var END_IDS = END_CONDITIONS.map(function (e) { return e.id; });

  // accept her words and common spellings
  function endConditionId(text) {
    var t = String(text).trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/--+/g, '-');
    var i;
    for (i = 0; i < END_IDS.length; i++) { if (END_IDS[i] === t) return END_IDS[i]; }
    if (/flag|free|cantilever/.test(t)) return 'flagpole';
    if (/pin/.test(t) && /sway/.test(t)) return 'pinned-sway';
    if (/fix/.test(t) && /sway/.test(t)) return 'fixed-sway';
    if (/(fixed|fix).*(fixed|fix)/.test(t) || /both-?ends?-?fixed/.test(t)) return 'fixed-fixed';
    if (/fix/.test(t) && /pin/.test(t)) return 'fixed-pinned';
    if (/pin/.test(t) || /simple|hinge/.test(t)) return 'pinned-pinned';
    fail('INVALID', 'End condition "' + text + '" is not one of: ' + END_IDS.join(', ') + '.', END_IDS);
  }

  function kFor(id) {
    var rows = (DATA().tables && DATA().tables.C_A_7_1) ? DATA().tables.C_A_7_1.rows : [];
    var e = null, i;
    for (i = 0; i < END_CONDITIONS.length; i++) { if (END_CONDITIONS[i].id === id) e = END_CONDITIONS[i]; }
    for (i = 0; i < rows.length; i++) {
      if (rows[i].id === e.letter) return { K: rows[i].K_design, Ktheory: rows[i].K_theory, letter: e.letter, label: e.label };
    }
    fail('INVALID', 'Table C-A-7.1 data is missing for case ' + e.letter + '.');
  }

  // ---- U (Spec Table D3.1) ----
  function d31(id) {
    var T = DATA().tables && DATA().tables.D3_1 ? DATA().tables.D3_1.rows : [];
    for (var i = 0; i < T.length; i++) {
      if (T[i].id === id) {
        var ov = overridesOf('table_D3_1');
        for (var j = 0; j < ov.length; j++) { if (ov[j].id === id) return { U: ov[j].U, override: ov[j], row: T[i] }; }
        return { U: T[i].U, override: null, row: T[i] };
      }
    }
    fail('INVALID', 'Table D3.1 row ' + id + ' is missing from the data.');
  }

  function teeParent(s) {
    var map = { WT: 'W', MT: 'M', ST: 'S' };
    var m = /^(WT|MT|ST)([\d.]+)X([\d.]+)$/.exec(normName(s.label));
    if (!m) return { label: null, d: 2 * s.d, found: false };
    var lab = map[m[1]] + Number((2 * Number(m[2])).toFixed(4)) + 'X' + Number((2 * Number(m[3])).toFixed(4));
    var p = idx().byLabel[normName(lab)];
    return p ? { label: p.label, d: p.d, found: true } : { label: lab, d: 2 * s.d, found: false };
  }

  // the tee (WT / MT / ST) cut from a W / M / S shape: half the depth and half the weight.  It is used only when it really is the half of THIS shape (the same flange and
  // stem thickness, half the depth and weight within the rounding of the tables); otherwise null.  (All 289 W shapes map; checked against the whole database.)
  function halfTee(sh) {
    var map = { W: 'WT', M: 'MT', S: 'ST' }, m = /^(W|M|S)([\d.]+)X([\d.]+)$/.exec(normName(sh.label));
    if (!m) return null;
    var lab = map[m[1]] + Number((Number(m[2]) / 2).toFixed(4)) + 'X' + Number((Number(m[3]) / 2).toFixed(4));
    var t = idx().byLabel[normName(lab)];
    if (!t || !isNum(t.y) || !isNum(t.bf) || !isNum(t.tf) || !isNum(t.tw) || !isNum(t.d) || !isNum(t.W)) return null;
    if (Math.abs(t.bf - sh.bf) > 0.011 || Math.abs(t.tf - sh.tf) > 0.0051 || Math.abs(t.tw - sh.tw) > 0.0051 || Math.abs(2 * t.d - sh.d) > 0.16 || Math.abs(2 * t.W - sh.W) > 0.15) return null;
    return t;
  }

  // G6: the Case 2 value shown beside Case 7 (display only; the headline never changes).  Returns null when it was not asked for (not through the flanges, or neither the
  // bolt spacing nor l typed); { why } when it was asked for and cannot be made; { computed: true, U2, xbar, l, larger, ... } otherwise.
  function case2Beside(a, sh, conn, perLine, uf, res) {
    var u7her = uf.U, u7aisc = isNum(uf.u7spec) ? uf.u7spec : uf.U;
    var typed = ['pitch_in', 'l_in', 'xbar_in'].filter(function (k) { return res.gave(k) && isSet(a[k]); });
    var gaveP = typed.indexOf('pitch_in') >= 0, gaveL = typed.indexOf('l_in') >= 0, gaveX = typed.indexOf('xbar_in') >= 0;
    if (conn !== 'flanges' || !(gaveP || gaveL)) return null;
    var out = { why: null, typed: typed, computed: false }, ty = sh ? sh.type : null, tee = null;
    if (ty !== 'W' && ty !== 'WT') out.why = 'the comparison is made for a W-shape or a WT connected through the flanges only' + (sh ? ' (' + sh.label + ' is not one)' : '');
    else if (!(perLine >= 3)) out.why = 'Case 7 needs 3 or more fasteners per line (' + perLine + ' given)';
    if (out.why) return out;
    if (gaveL) { out.l = a.l_in; out.lText = 'l = ' + fixed(a.l_in, 3) + ' in (typed)'; out.pitchUnused = gaveP; }
    else { out.l = (perLine - 1) * a.pitch_in; out.lText = 'l = (' + perLine + ' - 1) x ' + n(a.pitch_in, 4) + ' = ' + n(out.l, 4) + ' in'; }
    if (gaveX) { out.xbar = a.xbar_in; out.xText = 'x-bar = ' + fixed(a.xbar_in, 3) + ' in (typed)'; }
    else if (ty === 'WT') { out.xbar = sh.y; out.xText = 'x-bar = y of ' + sh.label + ' = ' + fixed(sh.y, 3) + ' in (its own y, Manual Table 1-8)'; }
    else {
      tee = halfTee(sh);
      if (!tee) { out.why = 'the tee cut from ' + sh.label + ' is not in the database (or does not match it), so x-bar is not known: type x-bar'; return out; }
      out.xbar = tee.y; out.xText = 'x-bar = y of ' + tee.label + ' (the tee cut from ' + sh.label + ', Manual Table 1-8) = ' + fixed(tee.y, 3) + ' in';
    }
    if (!isNum(out.xbar) || !(out.xbar >= 0)) { out.why = 'x-bar is not available for ' + sh.label + ': type x-bar'; return out; }
    if (!(out.l > 0)) { out.why = 'the connection length l = ' + n(out.l, 4) + ' in is not positive'; return out; }
    out.U2 = 1 - out.xbar / out.l;
    if (!(out.U2 > 0) || out.U2 > 1) { out.why = 'U = 1 - x-bar / l = 1 - ' + fixed(out.xbar, 3) + ' / ' + n(out.l, 4) + ' = ' + fixed(out.U2, 3) + ' is outside 0 to 1 (check x-bar and l); it was not used'; return out; }
    out.computed = true; out.u7her = u7her; out.u7aisc = u7aisc; out.larger = out.U2 > u7aisc + 1e-9; out.uAISC = Math.max(u7aisc, out.U2);
    return out;
  }

  // U for a described connection.  Returns { U, text, alts:[{label,U}], disagree, usedRule, info:[...], flag }
  //   tees:   default = HER rule (the tee's own depth, HW 4-3 and the WT7x19 class example); the Specification value (depth of the W
  //           the tee was cut from) is always shown beside it
  //   angles: default = HER reading (she counts ALL the fasteners in the connection: HW 3-26, 2 lines of 3 bolts = 6 -> 0.80); the AISC
  //           per-line value (Case 8: 3 per line -> 0.60) and the Case 2 value (if x-bar and l are given) are always shown beside it
  function uFactor(conn, perLine, shape, teeRule, xbar, len, res, lines) {
    var out = { U: null, text: '', alts: [], disagree: false, usedRule: null, info: [], flag: null };
    var r;
    if (conn === 'all') {
      r = d31('1');
      out.U = 1.0; out.text = 'Case 1: the load is delivered directly to every part of the cross-section (flanges and web, or a plain plate) -> U = 1.0';
      return out;
    }
    if (conn === 'welded') {
      out.U = null; out.text = 'No holes (welded): no rupture check, so no U is needed -- only yielding (0.90 Fy Ag) is checked.';
      return out;
    }
    var needCase2 = false, why = '';
    if (conn === 'flanges') {
      if (!shape) fail('MISSING', 'U for a flange connection needs the shape (the test is bf >= 2/3 d).');
      var t = shape.type;
      if (['W', 'M', 'S', 'HP', 'WT', 'MT', 'ST'].indexOf(t) < 0) { needCase2 = true; why = 'Case 7 is for W, M, S, HP shapes and tees cut from them; ' + shape.label + ' is not one of those.'; }
      else if (perLine < 3) { needCase2 = true; why = 'Case 7 needs at least 3 fasteners per line in the direction of the load (you have ' + perLine + ').'; }
      else {
        var isTee = (t === 'WT' || t === 'MT' || t === 'ST');
        var wide = d31('7-flange-wide'), narrow = d31('7-flange-narrow');
        var dClass = shape.d, parent = null, dSpec = shape.d;
        if (isTee) { parent = teeParent(shape); dSpec = parent.d; }
        var uClass = shape.bf >= 2.0 / 3.0 * dClass ? wide.U : narrow.U;
        var uSpec = shape.bf >= 2.0 / 3.0 * dSpec ? wide.U : narrow.U;
        var primaryRule = isTee ? (teeRule || settings().tee_rule) : 'class';
        out.U = primaryRule === 'spec' ? uSpec : uClass;
        out.usedRule = primaryRule;
        var dUsed = primaryRule === 'spec' ? dSpec : dClass;
        out.text = 'Case 7, connected through the flanges (' + perLine + ' per line, 3 or more): bf = ' + n(shape.bf, 3) + ' in, ' +
          (isTee ? (primaryRule === 'spec' ? 'd of the parent ' + (parent.label || '?') + ' = ' : 'd of the tee itself = ') : 'd = ') + n(dUsed, 3) + ' in, 2/3 d = ' + n(2.0 / 3.0 * dUsed, 3) + ' in -> bf ' +
          (shape.bf >= 2.0 / 3.0 * dUsed ? '>=' : '<') + ' 2/3 d -> U = ' + fixed(out.U, 2);
        if (isTee) {
          out.alts.push({ label: 'her rule (d of the tee itself = ' + n(dClass, 3) + ' in)', U: uClass });
          out.alts.push({ label: 'Specification rule (d of the W it was cut from' + (parent.label ? ', ' + parent.label : '') + ' = ' + n(dSpec, 3) + ' in)', U: uSpec });
          out.disagree = uClass !== uSpec;
          out.info.push('Table D3.1 note: for tees, d is the depth of the section the tee was cut from. In her homework solutions (HW 4-3: WT6x17.5 and WT6x20) and in class (WT7x19) she uses the depth of the tee itself.');
          if (!parent.found) out.info.push('Parent W shape ' + (parent.label || '?') + ' not found in the database; used 2 x the tee depth.');
          if (out.disagree) {
            out.flag = 'WARNING: TEE -- the two depth rules give DIFFERENT U here: her rule (tee\'s own depth ' + n(dClass, 3) + ' in) gives ' + fixed(uClass, 2) + ', the Specification (' + (parent.label || 'parent W') + ', d = ' + n(dSpec, 3) + ' in) gives ' + fixed(uSpec, 2) + '. The tool used ' + (primaryRule === 'spec' ? 'the Specification value, as you selected' : 'HER rule (her homework solutions use the tee\'s own depth)') + '.';
          } else {
            out.flag = 'NOTE: tee -- both depth rules give the same U (' + fixed(uClass, 2) + '), so the choice does not matter here.';
          }
        }
        out.wide = uClass === wide.U;
        out.u7spec = uSpec;   // AISC's own Case 7 (G6 compares the Specification value with Case 2; for a W it is the same number)
        return out;
      }
    } else if (conn === 'web') {
      if (!shape) fail('MISSING', 'U for a web connection needs the shape.');
      var tw = shape.type;
      if (['W', 'M', 'S', 'HP', 'WT', 'MT', 'ST'].indexOf(tw) < 0) { needCase2 = true; why = 'Case 7 is for W, M, S, HP shapes and tees cut from them; ' + shape.label + ' is not one of those.'; }
      else if (perLine < 4) { needCase2 = true; why = 'Case 7 (web) needs at least 4 fasteners per line (you have ' + perLine + ').'; }
      else {
        r = d31('7-web'); out.U = r.U;
        out.text = 'Case 7, connected through the web only, ' + perLine + ' fasteners per line (4 or more) -> U = ' + fixed(r.U, 2);
        return out;
      }
    } else if (conn === 'angle') {
      var nLines = isNum(lines) && lines >= 1 ? lines : 1, total = perLine * nLines;
      var u8 = function (count) { return count >= 4 ? d31('8-four').U : (count === 3 ? d31('8-three').U : null); };
      var uHer = u8(total), uAisc = u8(perLine);
      var u2 = (isNum(xbar) && isNum(len) && len > 0) ? 1 - xbar / len : null;
      if (uHer !== null) {
        out.U = uHer;
        out.text = 'Case 8, angle: ' + (nLines > 1 ? 'she counts ALL the fasteners in the connection (' + perLine + ' per line x ' + nLines + ' lines = ' + total + ')' : perLine + ' fasteners in the line') + ', ' + (total >= 4 ? '4 or more' : '3') + ' -> U = ' + fixed(uHer, 2);
        out.usedRule = 'her';
        if (uAisc !== uHer) {
          out.alts.push({ label: 'AISC Table D3.1 Case 8 counted PER LINE (' + perLine + ' per line)', U: uAisc === null ? null : uAisc, text: uAisc === null ? 'fewer than 3 per line: Case 2 only' : 'U = ' + fixed(uAisc, 2) });
          out.disagree = true;
        }
        if (u2 !== null) {
          out.alts.push({ label: 'Case 2 (1 - x-bar/l = 1 - ' + n(xbar, 3) + '/' + n(len, 3) + '), allowed if larger', U: u2 });
          if (u2 > uHer) out.disagree = true;
        }
        if (out.disagree) {
          out.flag = 'WARNING: ANGLE -- she counts ALL the fasteners in the connection (HW 3-26: two lines of 3 bolts = 6, so U = 0.80), but AISC Table D3.1 counts fasteners PER LINE in the direction of the load' +
            (uAisc === null ? ' (' + perLine + ' per line is fewer than 3: Case 2 only)' : ' (' + perLine + ' per line gives ' + fixed(uAisc, 2) + ')') +
            (u2 !== null ? '; Case 2 gives ' + fixed(u2, 3) : '; Case 2, U = 1 - x-bar/l, is also allowed and is usually larger (enter x-bar and l to see it)') + '. The tool used HER reading (' + fixed(uHer, 2) + '); the AISC value is shown beside it.';
        } else {
          out.flag = 'NOTE: AISC also allows Case 2 (U = 1 - x-bar/l) when it is larger than Case 8' + (u2 !== null ? ' (here ' + fixed(u2, 3) + ')' : ' -- enter x-bar and l to see it') + '. She uses the Case 8 value.';
        }
        return out;
      }
      needCase2 = true; why = 'Case 8 needs 3 or more fasteners (you have ' + total + '); she said "we never use 2 and certainly not one".';
    } else if (conn === 'case2') {
      needCase2 = true; why = 'Case 2 chosen.';
    }
    if (needCase2) {
      if (!isNum(xbar) && shape) {
        var guess = shape.type === 'C' || shape.type === 'MC' ? shape.x : (shape.type === 'L' ? shape.x : (shape.type === 'WT' || shape.type === 'MT' || shape.type === 'ST' ? shape.y : null));
        if (isNum(guess)) { xbar = guess; out.info.push('x-bar taken from the database (' + n(guess, 3) + ' in) -- check it is the distance from the connection plane to the centroid.'); }
      }
      if (!isNum(xbar) || !isNum(len)) fail('MISSING', why + ' The table has no fixed U here: use Case 2, U = 1 - x-bar / l. Enter x-bar (in, eccentricity of the connection) and l (in, length of the connection).', []);
      if (len <= 0) fail('OUT_OF_RANGE', 'Connection length l must be greater than zero.');
      var uc2 = 1 - xbar / len;
      if (uc2 < 0 || uc2 > 1) fail('OUT_OF_RANGE', 'U = 1 - x-bar/l = ' + n(uc2, 3) + ' is outside 0..1; check x-bar (' + xbar + ') and l (' + len + ').');
      out.U = uc2;
      out.text = 'Case 2 (not a table value): U = 1 - x-bar/l = 1 - ' + n(xbar, 3) + '/' + n(len, 3) + ' = ' + fixed(uc2, 3) + '. ' + why;
      return out;
    }
    fail('INVALID', 'Unknown connection type: ' + conn);
  }

  // true when a U result came from Case 2 or was compared with it (so x-bar and l mattered)
  function usedCase2(u) {
    var i;
    if (/Case 2/.test(u.text)) return true;
    for (i = 0; i < u.alts.length; i++) { if (/Case 2/.test(u.alts[i].label)) return true; }
    return false;
  }

  // ---- field lists reused by several functions ----
  var CONNECTION_VALUES = [
    { value: 'all', label: 'all parts of the cross-section connected (flanges and web, or a plain plate)' },
    { value: 'flanges', label: 'bolted through the FLANGES only (W, M, S, HP or tee)' },
    { value: 'web', label: 'bolted through the WEB only (W, M, S, HP)' },
    { value: 'angle', label: 'angle bolted through ONE LEG' },
    { value: 'welded', label: 'welded / no holes (yielding only)' },
    { value: 'case2', label: 'other (Case 2: U = 1 - x-bar/l)' }
  ];

  var TEE_RULE_VALUES = [
    { value: 'class', label: 'depth of the tee itself (HER rule, the default)' },
    { value: 'spec', label: 'depth of the W it was cut from (Specification)' }
  ];

  // ---- lookup_shape ----
  def('lookup_shape', 'Lookup', 'Look up a shape property', 'Read a property of a named shape from the Manual / Shapes Database. A name that is not a real shape returns NOT_FOUND with the closest real shapes.', [
    F('shape', 'shape', 'Shape name (any case, e.g. W14x90, HSS5x2x3/8, WT7x45)', '', { required: true }),
    F('property', 'text', 'Property: A, d, bf, tw, tf, Ix, Iy, Sx, Zx, rx, ry ... or "all"', '', { default: 'all' })
  ], function (a, res) {
    var s, prop;
    var wantAll = isBlank(a.property) || /^all$/i.test(a.property);
    try {
      s = findShape(a.shape);
    } catch (e) {
      if (e instanceof EngineError && e.code === 'NOT_FOUND' && !wantAll) {
        var preview = [];
        for (var q = 0; q < e.suggestions.length && preview.length < 4; q++) {
          var cand = idx().byLabel[normName(e.suggestions[q])];
          var pk = cand ? resolveProp(cand, a.property) : null;
          if (cand && pk) preview.push({ shape: cand.label, property: pk, value: cand[pk], unit: propInfo(pk)[1] });
        }
        if (preview.length) {
          e.message += ' (' + preview.map(function (p) { return p.shape + ': ' + p.property + ' = ' + n(p.value, 4) + (p.unit ? ' ' + p.unit : ''); }).join('; ') + ')';
          e.extra = e.extra || {};
          e.extra.preview = preview;
        }
      }
      throw e;
    }
    useShape(res, s);
    res.step('Open the Manual shapes tables (Part 1) and find ' + s.label + '.', SRC.shapes);
    if (wantAll) {
      var keys = KEY_PROPS[s.type] || ['W', 'A'], parts = [], i;
      numericProps(s).forEach(function (k) { res.val(k, s[k], propInfo(k)[1], SRC.shapes); });
      for (i = 0; i < keys.length; i++) {
        if (isNum(s[keys[i]])) parts.push(keys[i] + ' = ' + n(s[keys[i]], 4) + (propInfo(keys[i])[1] ? ' ' + propInfo(keys[i])[1] : ''));
      }
      res.step('Read the properties you need (decimal values, never the fractions printed beside them).', SRC.shapes);
      res.answer(s.label, null, '', s.label + ': ' + parts.join(', '));
      return res;
    }
    prop = resolveProp(s, a.property);
    if (!prop) {
      var avail = numericProps(s);
      fail('NOT_FOUND', s.label + ' has no property "' + a.property + '". It has: ' + avail.join(', ') + '.', avail);
    }
    var info = propInfoFor(s, prop), v = s[prop];
    res.step('Read ' + prop + ' (' + info[0] + ') = ' + n(v, 4) + (info[1] ? ' ' + info[1] : '') + ' -- the decimal value, not the fraction.', SRC.shapes);
    res.val(prop, v, info[1], SRC.shapes);
    res.answer(prop + ' of ' + s.label, v, info[1], prop + ' = ' + n(v, 4) + (info[1] ? ' ' + info[1] : '') + '  (' + s.label + ', ' + info[0] + ')');
    return res;
  });

  // ---- lookup_by_property ----
  def('lookup_by_property', 'Lookup', 'Lightest shape with a property at least ...', 'Lightest shape whose property (Ix, Zx, A, ry ...) is at least a minimum, from a family or nominal depths. Returns the lightest plus the next ones by weight.', [
    F('property', 'text', 'Property that must be at least the minimum (Ix, Iy, Zx, Sx, A, rx, ry, d ...)', '', { required: true }),
    F('minimum', 'number', 'Minimum value', '', { required: true }),
    F('family', 'text', 'Allowed shapes: W (all W), or a family such as W12, C10, WT6, L4', '', { default: 'W' }),
    F('nominal_depths', 'numlist', 'Only these nominal depths (for W: 12 14 16 ...); empty = all', 'in'),
    F('show', 'integer', 'How many to list (the lightest plus the next ones)', '', { default: 5, min: 1, max: 20 })
  ], function (a, res) {
    var fam = shapesInFamily(a.family, res);
    if (a.nominal_depths && a.nominal_depths.length) {
      fam = fam.filter(function (s) { return a.nominal_depths.indexOf(nominalDepth(s.label)) >= 0; });
      if (!fam.length) fail('NOT_FOUND', 'No ' + a.family + ' shape has nominal depth ' + a.nominal_depths.join(' or ') + '.', []);
    }
    var key = null, i;
    for (i = 0; i < fam.length && !key; i++) key = resolveProp(fam[i], a.property);
    if (!key) fail('NOT_FOUND', 'The shapes in ' + a.family + ' have no property "' + a.property + '". Try one of: ' + numericProps(fam[0]).join(', ') + '.', numericProps(fam[0]));
    var unit = propInfo(key)[1], pass = [], failing = [];
    for (i = 0; i < fam.length; i++) {
      if (isNum(fam[i][key]) && fam[i][key] >= a.minimum - 1e-9) pass.push(fam[i]); else if (isNum(fam[i][key])) failing.push(fam[i]);
    }
    if (!pass.length) {
      var best = fam.slice().sort(function (x, y) { return (y[key] || 0) - (x[key] || 0); })[0];
      fail('OUT_OF_RANGE', 'No ' + a.family + ' shape has ' + key + ' >= ' + a.minimum + (unit ? ' ' + unit : '') + '. The largest is ' + best.label + ' (' + n(best[key], 4) + ').', [best.label]);
    }
    pass.sort(function (x, y) { return (x.W - y.W) || (y[key] - x[key]) || (x.label < y.label ? -1 : 1); });
    var win = pass[0];
    useShape(res, win);
    res.step('Open the shapes tables for ' + a.family + (a.nominal_depths && a.nominal_depths.length ? ' (nominal depths ' + a.nominal_depths.join(', ') + ')' : '') + ' and look down the ' + key + ' column for ' + key + ' >= ' + n(a.minimum, 4) + (unit ? ' ' + unit : '') + '.', SRC.shapes);
    res.step('"We are not looking for the one that is closest. We are looking for the lightest." Of the ' + pass.length + ' shapes that qualify, the lightest is ' + win.label + ' (' + n(win.W, 4) + ' lb/ft) with ' + key + ' = ' + n(win[key], 4) + (unit ? ' ' + unit : '') + '.', SRC.shapes);
    var lighter = failing.filter(function (s) { return s.W < win.W; }).sort(function (x, y) { return y[key] - x[key]; }).slice(0, 2);
    if (lighter.length) res.step('Check: the nearest lighter shapes fail -- ' + lighter.map(function (s) { return s.label + ' (' + key + ' = ' + n(s[key], 4) + ')'; }).join(', ') + '.', SRC.shapes);
    res.val('selected_shape', win.label, '', SRC.shapes);
    res.val(key, win[key], unit, SRC.shapes);
    res.val('weight', win.W, 'lb/ft', SRC.shapes);
    res.answer('Lightest ' + a.family + ' with ' + key + ' >= ' + n(a.minimum, 4), win[key], unit, win.label + ' (' + n(win.W, 4) + ' lb/ft), ' + key + ' = ' + n(win[key], 4) + (unit ? ' ' + unit : ''));
    var rows = [];
    for (i = 0; i < Math.min(a.show, pass.length); i++) {
      rows.push([pass[i].label, pass[i].W, pass[i][key], 'yes']);
      if (i > 0) res.alt(pass[i].label, pass[i][key], unit, n(pass[i].W, 4) + ' lb/ft; ' + key + ' = ' + n(pass[i][key], 4) + (unit ? ' ' + unit : ''));
    }
    lighter.forEach(function (s) { rows.push([s.label, s.W, s[key], 'no -- lighter but too small']); });
    res.table('Shapes by weight', ['Shape', 'Weight lb/ft', key + (unit ? ' ' + unit : ''), 'Meets the minimum?'], rows);
    if (win.type === 'W' && nominalDepth(win.label) > 0) res.flag('NOTE: the lightest is not always the shallowest -- check the depth limit in the problem.');
    return res;
  });

  // ---- lookup_material ----
  // S2: "A36", "ASTM A992", "A572 Grade 50", "a572 gr 50", "A53 Grade B", "A500 Grade C", "A36/A36M" -> the rows of her six-row slide that carry that grade.
  // Existing rows only.  A grade of a known specification that her slide does not list (A500 Grade B) is refused and her rows are listed.
  // the FIRST ASTM number of a spec text: "ASTM A36/A36M" -> 36 (never the digits of both numbers glued together)
  function specNumber(text) { var m = /a\s*(\d{2,4})/i.exec(String(text).replace(/astm/ig, ' ')); return m ? m[1] : null; }

  function gradeRowsFor(text) {
    var M = DATA().materials;
    if (!M || !M.rows) return null;
    var w = String(text).toLowerCase().replace(/astm/g, ' ').replace(/[\/,.]/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''), m = /^a ?(\d{2,4})(?: a ?(\d{2,4}))?m?(?: (.*))?$/.exec(w), i, num, gradeTxt;
    if (!m) return null;
    if (m[2] !== undefined && m[2] !== m[1]) return null;   // "A36/A53" are two different specs, not one grade: not taken as the first
    num = m[1]; gradeTxt = (m[3] || '').replace(/\b(grade|gr|m)\b/g, ' ').replace(/\s+/g, '').replace(/^\s+|\s+$/g, '');
    var rowsOfSpec = M.rows.filter(function (r) { return specNumber(r.spec) === num; });
    if (!rowsOfSpec.length) return null;
    var rows = rowsOfSpec.filter(function (r) { return !gradeTxt || String(r.grade || '').toLowerCase().replace(/grade/, '').replace(/\s+/g, '') === gradeTxt; });
    if (!rows.length) {
      var names = [];
      M.rows.forEach(function (r) { var nm = r.spec + (r.grade ? ' ' + r.grade : ''); if (names.indexOf(nm) < 0) names.push(nm); });
      fail('NOT_FOUND', '"' + String(text).trim() + '" is not a row of her week-1 slide: she lists ' + names.join(', ') + '. (Her slide has no new data added: only these rows.)', names.map(function (nm) { return nm.replace(/^ASTM /, ''); }));
    }
    // several rows that differ in (grade, Fy, Fu): never take the first one
    var distinct = [];
    rows.forEach(function (r) { var k = String(r.grade || '') + '|' + r.Fy + '|' + r.Fu; if (distinct.indexOf(k) < 0) distinct.push(k); });
    if (distinct.length > 1) {
      var listed = rows.map(function (r) { return r.spec + (r.grade ? ' ' + r.grade : '') + ': Fy ' + r.Fy + ', Fu ' + r.Fu + ' (' + r.slide_text + ')'; });
      fail('AMBIGUOUS', '"' + String(text).trim() + '" matches ' + rows.length + ' rows of her week-1 slide with different grades or strengths: ' + listed.join('; ') + '. Type the grade (for example "' + rows[0].spec.replace(/^ASTM /, '') + (rows[0].grade ? ' ' + rows[0].grade : '') + '"). Nothing was guessed.', rows.map(function (r) { return (r.spec + (r.grade ? ' ' + r.grade : '')).replace(/^ASTM /, ''); }));
    }
    return { rows: rows };
  }

  def('lookup_material', 'Lookup', 'Fy and Fu for a shape or grade', 'Steel grade, Fy and Fu from her week-1 slide for a shape (W14x90) or a word (plate, pipe, HSS, angle, channel).', [
    F('what', 'text', 'Shape name (W14x90) or type word (plate, pipe, HSS, angle, channel, wide flange)', '', { required: true })
  ], function (a, res) {
    var gr = gradeRowsFor(a.what);
    if (gr) {
      var g0 = gr.rows[0];
      res.step('Open her week-1 slide / Table 2-4: ' + gr.rows.map(function (r) { return r.spec + (r.grade ? ' ' + r.grade : '') + ' is on the row "' + r.slide_text + '"'; }).join('; and ') + '.', SRC.mat);
      res.step(g0.spec + (g0.grade ? ' ' + g0.grade : '') + ': Fy = ' + g0.Fy + ' ksi, Fu = ' + g0.Fu + ' ksi.', SRC.mat);
      res.val('Fy', g0.Fy, 'ksi', SRC.mat).val('Fu', g0.Fu, 'ksi', SRC.mat).val('used_for', gr.rows.map(function (r) { return r.slide_text; }).join(' | '), '');
      res.answer('Steel ' + g0.spec + (g0.grade ? ' ' + g0.grade : ''), g0.Fy, 'ksi', g0.spec + (g0.grade ? ' ' + g0.grade : '') + ': Fy = ' + g0.Fy + ' ksi, Fu = ' + g0.Fu + ' ksi  (her slide: ' + gr.rows.map(function (r) { return r.slide_text; }).join('; ') + ')');
      res.flag('NOTE: matched by the NAME of a row of her slide (no new data). Use these unless the problem gives other values (e.g. renovation of an old building = A36: Fy 36, Fu 58).');
      return res;
    }
    var t = null, s = null, label = a.what;
    try { s = findShape(a.what); t = s.type; label = s.label; useShape(res, s); } catch (e) {
      var w = a.what.trim().toLowerCase();
      if (/^(pl|plate|plates|bar|flat)/.test(w)) t = 'PL';
      else if (/pipe/.test(w)) t = 'PIPE';
      else if (/^hss|tube/.test(w)) t = 'HSS';
      else if (/angle/.test(w)) t = 'L';
      else if (/^mc|misc/.test(w)) t = 'MC';
      else if (/channel/.test(w)) t = 'C';
      else if (/wide|^w$|beam|column/.test(w)) t = 'W';
      else if (/tee/.test(w)) t = 'WT';
      else if (/^(a?992|a?36|a?572|a?53|a?500)/.test(w)) t = null;
      else throw e;
    }
    if (!t) fail('NOT_FOUND', 'Enter a shape or a type word. Grades available: ' + (DATA().materials ? DATA().materials.rows.map(function (r) { return r.spec + (r.grade ? ' ' + r.grade : ''); }).join(', ') : '') + '.', []);
    var m = materialFor(t);
    if (!m) fail('NOT_FOUND', 'No material row for ' + t + '.', []);
    if (m.override) res.flag('WARNING: ' + ovText(m.override));
    roundHssNote(res, s, m.Fy);
    res.step('Open her week-1 slide / Table 2-4: ' + label + ' falls under "' + m.row.slide_text + '".', SRC.mat);
    res.step(m.spec + ': Fy = ' + m.Fy + ' ksi, Fu = ' + m.Fu + ' ksi.', SRC.mat);
    res.val('Fy', m.Fy, 'ksi', SRC.mat).val('Fu', m.Fu, 'ksi', SRC.mat);
    res.answer('Steel for ' + label, m.Fy, 'ksi', m.spec + ': Fy = ' + m.Fy + ' ksi, Fu = ' + m.Fu + ' ksi');
    if (t === 'PL') {
      var alt = null;
      DATA().materials.rows.forEach(function (r) { if (r.alternate && r.families.indexOf('PL') >= 0) alt = r; });
      if (alt) res.alt(alt.spec + ' ' + alt.grade + ' (alternate, by thickness)', alt.Fy, 'ksi', 'Fy = ' + alt.Fy + ' ksi, Fu = ' + alt.Fu + ' ksi');
      res.flag('NOTE: ' + DATA().materials.use_lowest_rule);
    }
    if (m.derived) res.flag('NOTE: ' + t + ' is cut from / made of ' + (DATA().materials.derived_families[t]) + ' shapes; the tool gives it the same steel as its parent family (her slide does not list it separately).');
    res.flag('NOTE: use these unless the problem gives other values (e.g. renovation of an old building = A36: Fy 36, Fu 58).');
    return res;
  });

  // ---- lookup_U ----
  def('lookup_U', 'Lookup', 'Shear lag factor U (Table D3.1)', 'U for a described connection: all parts connected 1.0; flanges 0.90 / 0.85; web 0.70; angle 0.80 / 0.60. For tees both depth rules are shown.', [
    F('connection', 'select', 'Where are the bolts / what is connected?', '', { required: true, values: CONNECTION_VALUES }),
    F('fasteners_per_line', 'integer', 'Fasteners per line in the direction of the load (bolts in a row along the force)', '', { min: 1 }),
    F('fastener_lines', 'integer', 'Angles: number of lines of fasteners (she counts ALL the fasteners; AISC counts per line)', '', { default: 1, min: 1 }),
    F('shape', 'shape', 'Shape (needed for flanges: the test is bf >= 2/3 d)', ''),
    F('tee_rule', 'select', 'For TEES: which depth for the 2/3 d test', '', { values: TEE_RULE_VALUES }),
    F('xbar_in', 'number', 'Case 2 only: x-bar, in (eccentricity of the connection)', 'in', { min: 0 }),
    F('l_in', 'number', 'Case 2 only: l, in (length of the connection)', 'in', { min: 0, minExclusive: true })
  ], function (a, res) {
    var s = a.shape ? useShape(res, findShape(a.shape)) : null;
    var perLine = isNum(a.fasteners_per_line) ? a.fasteners_per_line : (a.connection === 'all' || a.connection === 'welded' || a.connection === 'case2' ? 0 : null);
    if (perLine === null) fail('MISSING', 'Missing: fasteners per line (count the bolts in one row along the direction of the force).');
    var u = uFactor(a.connection, perLine, s, a.tee_rule, a.xbar_in, a.l_in, res, a.fastener_lines);
    if (a.connection === 'all' || a.connection === 'welded' || a.connection === 'case2') noteUnused(res, a, ['fasteners_per_line'], 'this connection needs no fastener count');
    if (a.connection !== 'angle' && a.fastener_lines > 1) noteUnused(res, a, ['fastener_lines'], 'the connection is not an angle');
    // an angle's shape IS used when U falls to Case 2 and x-bar is read from the database
    var shapeUsedForXbar = u.info.some(function (t) { return /x-bar taken from the database/.test(t); });
    if (a.connection === 'all' || a.connection === 'welded' || (a.connection === 'angle' && !shapeUsedForXbar)) noteUnused(res, a, ['shape'], 'this connection does not depend on the shape');
    if (!(a.connection === 'flanges' && s && /^(WT|MT|ST)$/.test(s.type))) noteUnused(res, a, ['tee_rule'], 'the tee depth rule only applies to a tee connected through its flange');
    if (!usedCase2(u)) noteUnused(res, a, ['xbar_in', 'l_in'], 'the result does not come from Case 2 and no Case 2 comparison could be made');
    res.step('Describe the connection: ' + (CONNECTION_VALUES.filter(function (c) { return c.value === a.connection; })[0].label) + (perLine ? '; ' + perLine + ' fasteners per line' + (a.connection === 'angle' && a.fastener_lines > 1 ? ', ' + a.fastener_lines + ' lines.' : '.') : '.'), SRC.d31);
    res.step(u.text, SRC.d31);
    u.info.forEach(function (t) { res.flag('NOTE: ' + t); });
    if (u.U === null) {
      res.answer('Shear lag factor U', null, '', u.text);
      return res;
    }
    res.val('U', u.U, '', SRC.d31);
    // the case number comes from the text of the result (an angle with too few fasteners, or a channel, ends up in Case 2)
    var caseNo = /^Case ([0-9]+)/.exec(u.text);
    var caseLabel = caseNo ? 'case ' + caseNo[1] : (a.connection === 'all' ? 'case 1' : (a.connection === 'angle' ? 'case 8' : (a.connection === 'case2' ? 'case 2' : 'case 7')));
    res.answer('Shear lag factor U', u.U, '', 'U = ' + fixed(u.U, u.U === Math.round(u.U * 100) / 100 ? 2 : 3) + '  (Table D3.1 ' + caseLabel + ')');
    u.alts.forEach(function (x) { res.alt('U by ' + x.label, x.U, '', x.text || (x.U === null ? '' : 'U = ' + fixed(x.U, 2))); });
    if (u.flag) res.flag(u.flag);
    return res;
  });

  // ---- lookup_K ----
  def('lookup_K', 'Lookup', 'Effective length factor K', 'K from the end conditions in words (Table C-A-7.1, recommended design values).', [
    F('end_condition', 'endcond', 'End conditions', '', { required: true, values: END_CONDITIONS.map(function (e) { return { value: e.id, label: e.label }; }) })
  ], function (a, res) {
    var k = kFor(a.end_condition);
    res.step('Open Table C-A-7.1 and pick the figure: ' + k.label + ' (case ' + k.letter + ').', SRC.ca71);
    res.step('Use the recommended DESIGN value: K = ' + n(k.K, 2) + ' (theoretical value ' + n(k.Ktheory, 2) + ').', SRC.ca71);
    res.val('K', k.K, '', SRC.ca71).val('K_theoretical', k.Ktheory, '', SRC.ca71);
    res.answer('Effective length factor K', k.K, '', 'K = ' + n(k.K, 2) + '  (' + k.label + ')');
    res.alt('theoretical K', k.Ktheory, '', 'K = ' + n(k.Ktheory, 2) + ' (theory; not for design)');
    res.flag('NOTE: K may differ per axis, and per braced segment of the same column.');
    return res;
  });

  // ---- lookup_critical_stress ----
  def('lookup_critical_stress', 'Lookup', 'Design critical stress from KL/r (Table 4-14)', 'phi*Fcr in ksi for a KL/r and a yield stress. KL/r is rounded UP to a whole number first (her advice); the exact value is shown as an alternative.', [
    F('KL_over_r', 'number', 'Slenderness KL/r', '', { required: true, min: 0 }),
    F('Fy', 'number', 'Yield stress Fy, ksi (column of the table: 35, 36, 46, 50, 65, 70)', 'ksi', { default: 50, min: 1, minExclusive: true }),
    F('round_up', 'boolean', 'Round KL/r UP to the next whole number first', '', { default: true })
  ], function (a, res) {
    if (a.KL_over_r > 200) fail('OUT_OF_RANGE', 'KL/r = ' + n(a.KL_over_r, 1) + ' is above 200: Table 4-14 stops at 200 and the member is too slender (the limit is KL/r <= 200). Exact E3 would give ' + n(0.9 * fcrE3(a.KL_over_r, a.Fy), 1) + ' ksi.', []);
    var klr = a.round_up ? Math.max(ceilTol(a.KL_over_r), a.KL_over_r > 0 ? 1 : 0) : Math.round(a.KL_over_r);
    if (klr === 0) {
      res.step('KL/r = 0: no buckling, Fcr = Fy, phi Fcr = 0.90 x ' + a.Fy + ' = ' + n(0.9 * a.Fy, 1) + ' ksi.', SRC.e3);
      res.answer('Design critical stress phi Fcr', 0.9 * a.Fy, 'ksi', 'phi Fcr = ' + n(0.9 * a.Fy, 1) + ' ksi');
      return res;
    }
    var t = table414(klr, a.Fy);
    var exact = 0.9 * fcrE3(a.KL_over_r, a.Fy);
    res.step('KL/r = ' + n(a.KL_over_r, 2) + (a.round_up && klr !== a.KL_over_r ? ' -> round UP to ' + klr : '') + '.', 'Her rule: round KL/r up before reading the table');
    res.step('Table 4-14, row KL/r = ' + klr + ', column Fy = ' + a.Fy + ' ksi: phi Fcr = ' + n(t.value, 1) + ' ksi' + (t.printed ? '.' : ' (Fy ' + a.Fy + ' is not a printed column -- computed from E3 and rounded to 3 figures like the book).'), SRC.t414);
    if (!t.printed) res.flag('NOTE: Fy = ' + a.Fy + ' is not a column of Table 4-14 (35, 36, 46, 50, 65, 70); the value was computed from E3.');
    if (t.override) res.flag('WARNING: ' + ovText(t.override));
    var type = a.KL_over_r <= limit471(a.Fy) ? 'inelastic buckling (KL/r <= 4.71 sqrt(E/Fy) = ' + n(limit471(a.Fy), 1) + '): Fcr = 0.658^(Fy/Fe) Fy' : 'elastic buckling (KL/r > ' + n(limit471(a.Fy), 1) + '): Fcr = 0.877 Fe';
    res.step('The table already includes phi = 0.90 and uses ' + type + '.', SRC.e3);
    res.val('KL_over_r_used', klr, '', 'Her rule: round KL/r up').val('phiFcr', t.value, 'ksi', SRC.t414);
    res.answer('Design critical stress phi Fcr', t.value, 'ksi', 'phi Fcr = ' + n(t.value, 1) + ' ksi  (KL/r = ' + klr + ', Fy = ' + a.Fy + ' ksi)');
    var lo = Math.floor(a.KL_over_r), hi = ceilTol(a.KL_over_r);
    if (lo >= 1 && hi !== lo && hi <= 200) {
      var tlo = table414(lo, a.Fy).value, thi = table414(hi, a.Fy).value, ipv = tlo + (thi - tlo) * (a.KL_over_r - lo);
      res.alt('linear interpolation between the two rows (' + lo + ' and ' + hi + ')', ipv, 'ksi', 'phi Fcr = ' + n(tlo, 1) + ' + (' + n(thi, 1) + ' - ' + n(tlo, 1) + ') x ' + n(a.KL_over_r - lo, 3) + ' = ' + n(ipv, 2) + ' ksi (she "averages" at 61.5 in HW 5-17)');
    }
    res.alt('exact E3 at KL/r = ' + n(a.KL_over_r, 2), exact, 'ksi', 'phi Fcr = ' + n(exact, 2) + ' ksi (not rounded)');
    if (lo >= 1 && hi !== lo && hi <= 200) res.alt('table value at KL/r = ' + lo + ' (rounded down)', table414(lo, a.Fy).value, 'ksi', 'she sometimes reads the nearest row in class; rounding DOWN is unconservative');
    if (a.KL_over_r > 150) res.flag('NOTE: KL/r is large; the limit is 200.');
    return res;
  });

  // ---- lookup_hole ----
  def('lookup_hole', 'Lookup', 'Hole size for a bolt', 'Hole used for NET AREA = bolt diameter + 1/8 in (her rule). The real standard hole of Table J3.3 is shown for reference.', [
    F('bolt_dia_in', 'dimension', 'Bolt diameter', 'in', { required: true, min: 0, minExclusive: true, plausible: 'bolt' })
  ], function (a, res) {
    var d = a.bolt_dia_in, hole = d + 0.125;
    res.step('Hole for net area = bolt + 1/8 in = ' + n(d, 4) + ' + 0.125 = ' + n(hole, 4) + ' in. (1/16 in oversize hole + 1/16 in for damage from making it.)', 'Her rule; ' + SRC.b43);
    res.val('hole', hole, 'in', SRC.b43);
    res.answer('Hole size for net area', hole, 'in', 'hole = ' + n(hole, 4) + ' in  (bolt ' + n(d, 4) + ' in + 1/8)');
    var rows = (DATA().tables && DATA().tables.J3_3) ? DATA().tables.J3_3.rows : [], std = null, ovs = null, i;
    for (i = 0; i < rows.length; i++) { if (rows[i].bolt_in !== null && Math.abs(rows[i].bolt_in - d) < 1e-9) { std = rows[i].standard_in; ovs = rows[i].oversize_in; } }
    if (std === null && d >= 1.125) { std = d + 0.125; ovs = d + 0.3125; }
    if (std !== null) {
      var stdTxt = Math.abs(std - d - 0.0625) < 1e-9 ? 'bolt + 1/16' : (Math.abs(std - d - 0.125) < 1e-9 ? 'bolt + 1/8' : 'bolt + ' + n(std - d, 4));
      res.alt('Table J3.3 standard hole (the physical hole)', std, 'in', stdTxt + ' = ' + n(std, 4) + ' in; oversize ' + n(ovs, 4) + ' in');
      if (boltOverOne(d)) res.step('Table J3.3 lists the standard hole itself as ' + n(std, 4) + ' in (' + stdTxt + '); Spec B4.3b adds 1/16 for the damage, so the AISC net-area hole is bolt + 3/16 = ' + n(d + 0.1875, 4) + ' in. Her rule is bolt + 1/8 for every size, which is the answer above.', SRC.j33);
      else res.step('Table J3.3 lists the standard hole itself as ' + n(std, 4) + ' in (' + stdTxt + '); for the NET AREA she adds another 1/16 for damage.', SRC.j33);
    } else res.flag('NOTE: ' + n(d, 4) + ' in is not a standard bolt diameter in Table J3.3.');
    if (boltOverOne(d)) { res.alt('AISC net-area hole (bolt + 3/16, Spec B4.3b)', d + 0.1875, 'in', 'hole = ' + n(d + 0.1875, 4) + ' in against her ' + n(hole, 4) + ' in (her value stays the answer)'); res.flag(boltOverOneNote(d, hole)); }
    res.flag('NOTE: the area lost is a RECTANGLE (hole x thickness), not a circle.');
    return res;
  });

  // ---- units ----
  var CONVERSIONS = [
    { value: 'kipin_to_kipft', label: 'kip-in to kip-ft (divide by 12)' },
    { value: 'kipft_to_kipin', label: 'kip-ft to kip-in (multiply by 12)' },
    { value: 'psf_to_klf', label: 'psf x tributary width (ft) to k/ft' },
    { value: 'plf_to_klf', label: 'lb/ft (plf) to k/ft' },
    { value: 'klf_to_plf', label: 'k/ft to lb/ft (plf)' },
    { value: 'slab_in_to_psf', label: 'slab thickness (in) of concrete to psf (thickness/12 x 150 pcf)' },
    { value: 'in_to_ft', label: 'inches to feet' },
    { value: 'ft_to_in', label: 'feet to inches' },
    { value: 'lb_to_kip', label: 'pounds to kips' },
    { value: 'kip_to_lb', label: 'kips to pounds' }
  ];
  def('units', 'Lookup', 'Units helper', 'kip-in <-> kip-ft, psf x ft -> k/ft, plf <-> k/ft, slab thickness -> psf, in <-> ft.', [
    F('conversion', 'select', 'Conversion', '', { required: true, values: CONVERSIONS }),
    F('value', 'number', 'Value to convert', '', { required: true }),
    F('width_ft', 'number', 'psf to k/ft only: tributary width, ft', 'ft', { min: 0 }),
    F('pcf', 'number', 'Slab only: concrete unit weight, pcf', 'pcf', { default: 150, min: 0 })
  ], function (a, res) {
    var v = a.value, out, unit, text, step;
    if (a.conversion !== 'psf_to_klf') noteUnused(res, a, ['width_ft'], 'only the psf-to-k/ft conversion uses a width');
    if (a.conversion !== 'slab_in_to_psf') noteUnused(res, a, ['pcf'], 'only the slab conversion uses a unit weight');
    switch (a.conversion) {
      case 'kipin_to_kipft': out = v / 12; unit = 'kip-ft'; step = n(v, 4) + ' kip-in / 12 = ' + n(out, 4) + ' kip-ft'; break;
      case 'kipft_to_kipin': out = v * 12; unit = 'kip-in'; step = n(v, 4) + ' kip-ft x 12 = ' + n(out, 4) + ' kip-in'; break;
      case 'psf_to_klf':
        if (!isNum(a.width_ft)) fail('MISSING', 'Missing: tributary width, ft (psf x ft = plf, then / 1000 = k/ft).');
        out = v * a.width_ft / 1000; unit = 'k/ft'; step = n(v, 4) + ' psf x ' + n(a.width_ft, 4) + ' ft = ' + n(v * a.width_ft, 3) + ' plf; / 1000 = ' + n(out, 4) + ' k/ft'; break;
      case 'plf_to_klf': out = v / 1000; unit = 'k/ft'; step = n(v, 4) + ' plf / 1000 = ' + n(out, 5) + ' k/ft'; break;
      case 'klf_to_plf': out = v * 1000; unit = 'plf'; step = n(v, 5) + ' k/ft x 1000 = ' + n(out, 3) + ' plf'; break;
      case 'slab_in_to_psf': out = v / 12 * a.pcf; unit = 'psf'; step = n(v, 4) + ' in / 12 x ' + n(a.pcf, 2) + ' pcf = ' + n(out, 3) + ' psf'; break;
      case 'in_to_ft': out = v / 12; unit = 'ft'; step = n(v, 4) + ' in / 12 = ' + n(out, 4) + ' ft'; break;
      case 'ft_to_in': out = v * 12; unit = 'in'; step = n(v, 4) + ' ft x 12 = ' + n(out, 4) + ' in'; break;
      case 'lb_to_kip': out = v / 1000; unit = 'kips'; step = n(v, 4) + ' lb / 1000 = ' + n(out, 5) + ' kips'; break;
      default: out = v * 1000; unit = 'lb'; step = n(v, 5) + ' kips x 1000 = ' + n(out, 3) + ' lb';
    }
    text = n(out, 5) + ' ' + unit;
    res.step(step, 'Unit conversion');
    res.val('result', out, unit, 'Unit conversion');
    res.answer('Converted value', out, unit, text);
    return res;
  });

  // ---- lookup_definition: the STRICT matcher (G1, 10/05) ----
  // A question about a word must never come back with a confident answer about the WRONG concept ("resistance factor" -> the overload factor,
  // "section modulus" -> the plastic modulus, "office" -> a fire rating).  So, in this order, and only against the entry NAMES (the term and the
  // synonyms of data/glossary.js; the body text and the quotes are NEVER matched):
  //   1. the exact term (then the term without its trailing parenthesis), 2. an exact synonym,
  //   3. the same again after the question words are dropped ("what does phi mean" = "phi"),
  //   4. containment, ONLY when the query has >= 2 content words and one entry is clearly the most specific:
  //        a name inside the query ("what is the value of E for steel" holds the synonym "e for steel"), the query inside a name, or every content
  //        word of the query inside ONE name;
  //   5. otherwise AMBIGUOUS (the tied terms) or NOT_FOUND (the closest terms as "did you mean").  A suggestion never answers by itself.
  // "not" (a list of concepts an entry must not answer for) is only a safety net on the containment steps.  Twins (a class entry and its
  // "(her slide)" / "(AISC glossary)" / "(AISC symbols)" / "(Table 2-4)" twin) that tie are resolved to the older entry; any other tie is AMBIGUOUS.
  var DEF_STOP = {};
  'the a an of for and or to in on is are what which that this with from by as it its at be do does how why when who whom list define definition meaning mean tell me give about explain steel'.split(' ').forEach(function (w) { DEF_STOP[w] = true; });
  var DEF_QWORDS = {};
  'what is are the a an why how does do define explain tell me about give list which who when meaning mean definition'.split(' ').forEach(function (w) { DEF_QWORDS[w] = true; });
  var DEF_TWIN = /\((?:[^)]*her slide|AISC glossary|AISC symbols|Table 2-4)[^)]*\)\s*$/i;
  var DEF_CURLY = new RegExp('[' + String.fromCharCode(8216, 8217, 8242) + ']', 'g');

  // lower case, no trailing punctuation, no apostrophes, a hyphen between letters / digits is a space, one space between words
  function defNorm(s) {
    s = String(s === undefined || s === null ? '' : s).toLowerCase().replace(DEF_CURLY, "'");
    s = s.replace(/^\s+|\s+$/g, '').replace(/[?!.;:,]+$/, '');
    s = s.split("'s").join('s').split("'").join('');
    s = s.replace(/([a-z0-9])-([a-z0-9])/g, '$1 $2').replace(/\s+/g, ' ');
    return s;
  }
  function defTokens(s) { return s.match(/[a-z0-9]+(?:[.,^\/][a-z0-9]+)*/g) || []; }
  // singular / plural: a word of 4+ letters loses one trailing s (not ss); both sides of a comparison go through the same function
  function defStem(s) { return defTokens(s).map(function (w) { return w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w; }).join(' '); }
  // the length of a name without its leading question words ("what is the modulus of elasticity" counts as "modulus of elasticity")
  function defCoreLen(s) {
    var t = s.split(' '), i = 0;
    while (i < t.length - 1 && DEF_QWORDS[t[i]]) i++;
    return t.slice(i).join(' ').length;
  }
  function defContent(tokens) { return tokens.filter(function (w) { return !DEF_STOP[w]; }); }
  // needle inside hay as whole words (never as a piece of a longer word, so a synonym "e" or "s" is safe)
  function defHas(hay, needle) {
    if (!needle) return false;
    var from = 0, i, a, b;
    for (;;) {
      i = hay.indexOf(needle, from);
      if (i < 0) return false;
      a = i === 0 ? '' : hay.charAt(i - 1);
      b = hay.charAt(i + needle.length);
      if (!/[a-z0-9]/.test(a) && !/[a-z0-9]/.test(b)) return true;
      from = i + 1;
    }
  }
  function defTrigrams(s) {
    var p = '  ' + s + ' ', out = {}, i, k = 0;
    for (i = 0; i + 3 <= p.length; i++) { if (!has(out, p.substr(i, 3))) { out[p.substr(i, 3)] = true; k++; } }
    return { set: out, n: k };
  }
  function defDice(a, b) {
    var common = 0, k;
    for (k in a.set) { if (has(a.set, k) && has(b.set, k)) common++; }
    return a.n + b.n === 0 ? 0 : 2 * common / (a.n + b.n);
  }

  var GIDX = null;
  // the names of every entry, normalized once: term, term without its trailing parenthesis, synonyms; the content words of each name; the "not" phrases
  function gidx() {
    if (GIDX) return GIDX;
    var G = DATA().glossary || [], out = [], i, j, e, c, nm, ct;
    function addName(c2, nm2, isSyn) {
      if (!nm2) return;
      if (!has(c2.set, nm2)) { c2.set[nm2] = true; c2.names.push(nm2); c2.ctoks.push(defContent(defTokens(nm2))); c2.stems[defStem(nm2)] = true; }
      if (isSyn) c2.syn[nm2] = true;
    }
    for (i = 0; i < G.length; i++) {
      e = G[i];
      c = { e: e, t: defNorm(e.term), base: defNorm(String(e.term).replace(/\s*\([^)]*\)\s*$/, '')), names: [], set: {}, ctoks: [], stems: {}, syn: {}, nots: [], twin: DEF_TWIN.test(String(e.term)), union: {} };
      addName(c, c.t, false);
      addName(c, c.base, false);
      for (j = 0; j < (e.synonyms || []).length; j++) addName(c, defNorm(e.synonyms[j]), true);
      for (j = 0; j < (e.not || []).length; j++) { nm = defNorm(e.not[j]); if (nm) c.nots.push(nm); }
      for (j = 0; j < c.ctoks.length; j++) { for (ct = 0; ct < c.ctoks[j].length; ct++) c.union[c.ctoks[j][ct]] = true; }
      out.push(c);
    }
    GIDX = out;
    return out;
  }

  // the entries whose exact name equals q: the term, then the term without its parenthesis, then a synonym.  null when none.
  function defExact(I, q) {
    var hits = [], i, tier = ['t', 'base', 'syn'], k;
    for (k = 0; k < tier.length; k++) {
      hits = [];
      for (i = 0; i < I.length; i++) {
        if (tier[k] === 'syn' ? has(I[i].syn, q) : I[i][tier[k]] === q) hits.push(I[i]);
      }
      if (hits.length) return { by: k === 0 ? 'exact_term' : (k === 1 ? 'exact_term_base' : 'exact_synonym'), hits: hits };
    }
    return null;
  }

  // the entries with a name that equals q apart from singular / plural ("advantage of steel" = "advantages of steel").  null when none.
  function defExactStem(I, q) {
    var st = defStem(q), hits = [], i;
    if (!st) return null;
    for (i = 0; i < I.length; i++) { if (has(I[i].stems, st)) hits.push(I[i]); }
    return hits.length ? { by: 'singular_plural', hits: hits } : null;
  }

  // Several entries at the same level: ties resolve to the OLDEST entry only when every other one is its twin ("(her slide)", "(AISC glossary)" ...);
  // anything else is a real ambiguity.  Returns { entry, others } or { tied }.
  function defTie(hits) {
    var s = hits.slice().sort(function (x, y) { return x.e.n - y.e.n; }), i;
    for (i = 1; i < s.length; i++) { if (!s[i].twin) return { tied: s }; }
    return { entry: s[0], others: s.slice(1) };
  }

  // how many content words of the query occur among the words of the entry's names
  function defCover(c, cw) {
    var k = 0, i;
    for (i = 0; i < cw.length; i++) { if (has(c.union, cw[i])) k++; }
    return k;
  }

  // the containment step.  Returns the candidate entries of the strongest evidence level, each { c, tier, phrase, size, cover }.
  //   tier 3: a name of the entry is inside the query (size = its length: the longest name is the most specific)
  //   tier 2: the query is inside a name of the entry (size = how much longer the name is: the closest name is the most specific)
  //   tier 1: every content word of the query is a content word of ONE name of the entry (size = the extra words of that name)
  function defContain(I, q, cw) {
    var out = [], gone = [], i, k, c, nm, phrase, plen, extra, ev, nt, all, j, excl, matched, ph;
    if (cw.length < 2) return { all: out, excluded: gone };
    for (i = 0; i < I.length; i++) {
      c = I[i];
      if (c.nots.indexOf(q) >= 0) continue;                                     // the query IS something this entry must not answer for
      ev = null; phrase = ''; plen = 0;
      for (k = 0; k < c.names.length; k++) {
        nm = c.names[k];
        if ((nm.length >= 3 || /\d/.test(nm)) && c.ctoks[k].length >= 1 && defCoreLen(nm) > plen && defHas(q, nm)) { phrase = nm; plen = defCoreLen(nm); }
      }
      if (plen) ev = { tier: 3, phrase: phrase, size: plen };
      if (!ev && q.length >= 4) {
        extra = -1; ph = '';
        for (k = 0; k < c.names.length; k++) {
          nm = c.names[k];
          if (defHas(nm, q) && (extra < 0 || nm.length - q.length < extra)) { extra = nm.length - q.length; ph = nm; }
        }
        if (extra >= 0) ev = { tier: 2, phrase: ph, size: extra };
      }
      if (!ev) {
        extra = -1; ph = '';
        for (k = 0; k < c.names.length; k++) {
          nt = c.ctoks[k]; all = true;
          for (j = 0; j < cw.length && all; j++) { if (nt.indexOf(cw[j]) < 0) all = false; }
          if (all && (extra < 0 || nt.length - cw.length < extra)) { extra = nt.length - cw.length; ph = c.names[k]; }
        }
        // the weakest evidence: needs three or more content words, all inside one name
        if (extra >= 0 && cw.length >= 3) ev = { tier: 1, phrase: ph, size: extra };
      }
      if (!ev) continue;
      matched = ev.tier === 3 ? ev.size : 0;
      excl = '';
      for (k = 0; k < c.nots.length; k++) { if (defHas(q, c.nots[k]) && c.nots[k].length >= matched) excl = c.nots[k]; }   // "not" is a safety net: a longer concept name in the query wins
      if (excl) { gone.push({ c: c, not: excl, tier: ev.tier, size: ev.size }); continue; }
      out.push({ c: c, tier: ev.tier, phrase: ev.phrase, size: ev.size, cover: defCover(c, cw) });
    }
    return { all: out, excluded: gone };
  }
  // the candidates of the strongest evidence level
  function defTopTier(list) {
    var top = 0, i;
    for (i = 0; i < list.length; i++) { if (list[i].tier > top) top = list[i].tier; }
    return list.filter(function (x) { return x.tier === top; });
  }

  // the leaders among the containment candidates: the most specific one, plus every candidate that is not clearly less specific.
  // A more specific ENTRY wins over its generic parent: "live load for a gym" holds "live load" (the parent) and "gym" (the entry
  // "Live load: Gymnasiums ..." whose term contains "live load"), so the gym entry leads.
  function defLeaders(cands) {
    var tier = cands[0].tier, best = cands[0], i, j, lead = [], x, y, kids;
    for (i = 1; i < cands.length; i++) {
      x = cands[i];
      if (tier === 3 ? x.size > best.size : x.size < best.size) best = x;
    }
    for (i = 0; i < cands.length; i++) {
      x = cands[i];
      if (tier === 3) {
        if (x.size < best.size && (best.size - x.size >= 3 || defHas(best.phrase, x.phrase))) continue;      // a shorter name, or one that is part of the longer one
      } else if (x.size - best.size >= 2) continue;
      lead.push(x);
    }
    if (tier === 3) {
      kids = [];
      for (i = 0; i < cands.length; i++) {
        y = cands[i];
        for (j = 0; j < lead.length; j++) {
          if (lead[j] !== y && lead[j].phrase !== y.phrase && defHas(y.c.t, lead[j].phrase) && y.c.t !== lead[j].phrase && kids.indexOf(y) < 0) kids.push(y);
        }
      }
      if (kids.length) lead = kids;
    }
    return lead;
  }

  // up to five terms of entries that look like the query (for "did you mean"): the query's own words (comparison words dropped) shared with a
  // name, or a similar spelling.  A suggestion is only a suggestion: it never answers.
  function defClosest(I, q, cw, max) {
    var cwc = cw.filter(function (w) { return !DEF_COMPARE[w]; }), qc = cwc.join(' ') || q, tq = defTrigrams(qc), res = [], i, k, c, s, sc, d, shared, w;
    for (i = 0; i < I.length; i++) {
      c = I[i]; s = 0;
      for (k = 0; k < c.names.length; k++) {
        if (!c.tri) c.tri = [];
        if (!c.tri[k]) c.tri[k] = defTrigrams(c.names[k]);
        d = defDice(tq, c.tri[k]);
        shared = 0;
        for (w = 0; w < cwc.length; w++) { if (c.ctoks[k].indexOf(cwc[w]) >= 0) shared++; }
        if (d >= 0.35 || (cwc.length && shared === cwc.length)) {
          sc = d + (cwc.length ? 0.5 * shared / cwc.length : 0);
          if (sc > s) s = sc;
        }
      }
      if (s >= 0.6) res.push({ c: c, s: s });
    }
    res.sort(function (x, y) { return (y.s - x.s) || (x.c.e.n - y.c.e.n); });
    return res.slice(0, max).map(function (r) { return r.c; });
  }

  var DEF_COMPARE = { difference: true, differences: true, between: true, versus: true, vs: true, compare: true, compared: true, comparison: true };
  var DEF_BY = { 3: 'name_in_query', 2: 'query_in_name', 1: 'all_words' };
  var DEF_CONTAIN = { 3: 'your words contain its name "%"', 2: 'your words are part of its name "%"', 1: 'every content word of your words is in its name "%"' };
  var DEF_HOW = { exact_term: 'your words are its exact name', exact_term_base: 'your words are its name without the parenthesis', exact_synonym: 'your words are one of its exact synonyms', singular_plural: 'your words are one of its names apart from singular / plural' };

  // the whole decision.  Returns { entry, others, also, by, how, as, cw } (an answer), { tied } (AMBIGUOUS) or { close } (NOT_FOUND).
  function defMatch(raw) {
    var I = gidx(), q = defNorm(raw), tk = defTokens(q), cw = defContent(tk), r, t, qs, i, cands, lead, pick;
    r = defExact(I, q) || defExactStem(I, q);
    qs = cw.join(' ');
    if (r) r.dropped = false;
    if (!r && qs && qs !== q) { r = defExact(I, qs) || defExactStem(I, qs); if (r) r.dropped = true; }
    if (r) {
      t = defTie(r.hits);
      if (t.tied) return { tied: t.tied };
      return { entry: t.entry, others: t.others, by: r.by, how: DEF_HOW[r.by] + (r.dropped ? ' (after the question words are dropped)' : ''), as: r.dropped ? qs : q, cw: cw };
    }
    var cc = defContain(I, q, cw), mixed = [];
    cands = defTopTier(cc.all);
    // a query that names TWO concepts ("difference between LRFD and ASD", "plastic modulus vs elastic modulus"): the "not" list of one entry removed
    // it because the query also names the other one.  That is not an answer for the other one alone: both are listed.
    if (cc.excluded.length && cands.length) {
      var ref = defLeaders(cands), refSizes = ref.map(function (x) { return x.size; });
      cc.excluded.forEach(function (ex) {
        // only an entry that could have competed with the leaders (as strong, as specific) makes the query a two-concept question
        var competes = ex.tier > ref[0].tier || (ex.tier === ref[0].tier && (ex.tier === 3 ? ex.size >= Math.max.apply(null, refSizes) - 2 : ex.size <= Math.min.apply(null, refSizes) + 1));
        if (!competes) return;
        cc.all.forEach(function (y) { if (y.c.set[ex.not] && mixed.indexOf(y.c) < 0) mixed.push(y.c); });
        if (mixed.length && mixed.indexOf(ex.c) < 0) mixed.push(ex.c);
      });
    }
    if (mixed.length > 1) return { tied: mixed.sort(function (x, y) { return x.e.n - y.e.n; }) };
    if (cands.length && cands[0].tier === 1 && cands.length > 1) return { tied: cands.map(function (x) { return x.c; }) };   // the weakest evidence must be unique
    if (cands.length) {
      lead = defLeaders(cands);
      var samePhrase = lead.every(function (x) { return x.phrase === lead[0].phrase; });
      if (lead.length === 1) pick = { entry: lead[0].c, others: [], by: DEF_BY[lead[0].tier], how: DEF_CONTAIN[lead[0].tier].replace('%', lead[0].phrase), as: lead[0].phrase, cw: cw };
      else if (!samePhrase) return { tied: lead.map(function (x) { return x.c; }) };          // two different names of two different entries: a real ambiguity
      else {
        t = defTie(lead.map(function (x) { return x.c; }));
        if (t.entry) pick = { entry: t.entry, others: t.others, by: DEF_BY[lead[0].tier], how: DEF_CONTAIN[lead[0].tier].replace('%', lead[0].phrase), as: lead[0].phrase, cw: cw };
        else {
          // the same name in several entries that are not twins ("Brittle (carbon)" / "Brittle (vs ductile)"): the entry whose names cover MORE
          // of the query's words is clearly the more specific one; equal cover is a real ambiguity
          lead.sort(function (x, y) { return (y.cover - x.cover) || (x.c.e.n - y.c.e.n); });
          if (lead[0].cover > lead[1].cover) pick = { entry: lead[0].c, others: [], by: DEF_BY[lead[0].tier], how: DEF_CONTAIN[lead[0].tier].replace('%', lead[0].phrase) + ', and more of your words are in its names than in any other entry', as: lead[0].phrase, cw: cw };
          else return { tied: lead.map(function (x) { return x.c; }) };
        }
      }
      if (cands.length > 1 && pick) {
        pick.also = cands.filter(function (x) { return x.c !== pick.entry && pick.others.indexOf(x.c) < 0; }).sort(function (x, y) { return (y.size - x.size) || (x.c.e.n - y.c.e.n); }).slice(0, 3).map(function (x) { return x.c; });
      }
      if (pick) {
        // a question that COMPARES two things ("difference between braced and moment frame") is never answered from ONE entry: the closest are listed
        for (i = 0; i < tk.length; i++) {
          if (DEF_COMPARE[tk[i]]) {
            var cl2 = defClosest(I, q, cw, 5);
            if (cl2.indexOf(pick.entry) < 0) cl2.unshift(pick.entry);
            return { close: cl2.slice(0, 5), compare: true };
          }
        }
        return pick;
      }
    }
    // nothing answers: a single generic word that several entries use is AMBIGUOUS (the entries are listed); anything else is NOT_FOUND
    if (cw.length === 1) {
      var word = cw[0], used = [];
      for (i = 0; i < I.length; i++) { if (I[i].union[word]) used.push(I[i]); }
      if (used.length >= 2 && used.length <= 12) return { tied: used.sort(function (x, y) { return x.e.n - y.e.n; }), generic: word };
    }
    return { close: defClosest(I, q, cw, 5) };
  }

  // best quote of the matched entry for the query words (ties keep the stored order, where her own words come first)
  function defBestQuote(e, cw) {
    var best = 0, bestSc = -1, j, k, sc, ql;
    for (j = 0; j < e.definitions.length; j++) {
      ql = defNorm(e.definitions[j].quote); sc = 0;
      for (k = 0; k < cw.length; k++) { if (defHas(ql, cw[k])) sc++; }
      if (sc > bestSc) { bestSc = sc; best = j; }
    }
    return best;
  }
  function defQuoteLine(d, e) { return '"' + d.quote + '"  (' + (d.date || 'undated') + '; ' + (d.src || e.source || 'her vocabulary') + ')'; }
  function defValueText(e) { return (e.value === undefined || e.value === null || e.value === '' ? '' : String(e.value)) + (e.unit ? ' ' + e.unit : ''); }

  // ---- lookup_definition ----
  def('lookup_definition', 'Lookup', 'Find her definition', 'Search her vocabulary (CART transcript quotes, slides, the Specification glossary and the Quiz 1 key, verbatim). Answers are her wording, never composed. Only the entry NAMES are matched, never the text of a quote: a word that fits several entries is AMBIGUOUS and a word that fits none is NOT_FOUND, each with "did you mean" suggestions that never answer by themselves.', [
    F('query', 'text', 'Word or phrase to look for (e.g. yield strength, elastic range, bolt hole)', '', { required: true })
  ], function (a, res) {
    var q = a.query.trim().toLowerCase();
    // a table number in either name (her slides say Table 4-22 / 3-23; the 16th edition says 4-14 / 3-22)
    var tabs = (DATA().rules && DATA().rules.tables) || [], qn = q.replace(/^table\s*/, '').replace(/\s+/g, ''), ti;
    for (ti = 0; ti < tabs.length; ti++) {
      var ids = [String(tabs[ti].id).toLowerCase()].concat((tabs[ti].aliases || []).map(function (x) { return String(x).toLowerCase(); }));
      if (qn && ids.indexOf(qn) >= 0) {
        var tb = tabs[ti], al = (tb.aliases || []).join(', ');
        res.step('"' + a.query.trim() + '" is Table ' + tb.id + (al ? ' (her slides call it Table ' + al + ')' : '') + ' in the 16th edition Manual.', 'Her rules page: table-number aliases');
        res.val('table', tb.id, '', 'Her rules page').val('aliases', al, '', 'Her rules page');
        res.answer('Table ' + tb.id, null, '', 'Table ' + tb.id + (al ? ' (her slides: Table ' + al + ')' : '') + ' -- ' + tb.title + '. Used for: ' + tb.use + '.');
        return res;
      }
    }
    var m = defMatch(a.query), i, termsOf = function (list) { return list.map(function (c) { return c.e.term; }); };
    if (m.tied) {
      var tt = termsOf(m.tied).slice(0, 8);
      fail('AMBIGUOUS', (m.generic ? '"' + a.query.trim() + '" is one word that several of her entries use' : '"' + a.query.trim() + '" fits more than one of her entries equally well') + ': ' + tt.join('; ') + '. Nothing was guessed: pick one of them (click it), or type more of its name.', tt);
    }
    if (m.close) {
      var cl = termsOf(m.close);
      fail('NOT_FOUND', (m.compare ? '"' + a.query.trim() + '" compares things, and she defines each one on its own, so nothing was answered.' : 'No definition matches "' + a.query.trim() + '" (only the names of her entries are searched, and nothing was guessed).') + (cl.length ? ' Did you mean: ' + cl.join('; ') + '? Click one to look it up.' : ' Try a key word from her vocabulary, for example: yield strength, resistance factor, safety factor, bolt hole, advantages of steel.'), cl);
    }
    var e = m.entry.e, kind = e.kind || 'definition', defs = e.definitions || [], pi = kind === 'list' ? 0 : defBestQuote(e, m.cw), d0 = defs[pi] || { quote: '', date: null }, text, items, valText = defValueText(e);
    res.step('Open the Definitions list and search for "' + a.query.trim() + '".', 'Her vocabulary (class transcripts, her slides, the Specification glossary and the Quiz 1 key)');
    res.step('Matched the entry "' + e.term + '": ' + m.how + '. Only the names of her entries are searched, never the text of a quote.', 'Her vocabulary');
    if (kind === 'list') {
      items = e.items && e.items.length ? e.items : defs.map(function (d) { return d.quote; });
      res.step(e.term + ' -- her list (' + items.length + ' items, in her order): ' + items.map(function (x, k) { return (k + 1) + ') ' + x; }).join('  '), d0.src || e.source);
      text = e.term + ': ' + items.join('; ') + '  (' + (d0.date || 'undated') + '; ' + (d0.src || e.source || 'her vocabulary') + ')';
    } else if (kind === 'constant') {
      res.step(e.term + ': ' + valText + '  --  her words (' + (d0.date || 'undated') + '): ' + defQuoteLine(d0, e), d0.src || e.source);
      text = e.term + ': ' + valText + '  --  ' + defQuoteLine(d0, e);
    } else if (kind === 'table_row') {
      res.step(e.term + ' -- the row as printed: ' + defQuoteLine(d0, e) + (e.row ? '  row: ' + JSON.stringify(e.row) : ''), d0.src || e.source);
      text = e.term + ': ' + defQuoteLine(d0, e) + (valText ? '  [value: ' + valText + ']' : '');
    } else {
      res.step(e.term + ' -- her words (' + (d0.date || 'undated') + '): "' + d0.quote + '"', d0.src || e.source);
      text = e.term + ': ' + defQuoteLine(d0, e);
    }
    for (i = 0; i < defs.length && kind !== 'list'; i++) {
      if (i !== pi) res.step('Also in this entry (' + (defs[i].date || 'undated') + '): ' + defQuoteLine(defs[i], e), defs[i].src || e.source);
    }
    res.val('term', e.term, '', e.source).val('definition', kind === 'list' ? (items || []).join('; ') : d0.quote, '', e.source).val('date', d0.date, '', e.source);
    res.val('kind', kind, '').val('matched_by', m.by, '').val('matched_name', m.as, '');
    if (e.value !== undefined && e.value !== null && e.value !== '') res.val('value', e.value, e.unit || '', e.source);
    if (e.row) res.val('row', e.row, '', e.source);
    res.answer('Her definition: ' + e.term, kind === 'constant' && typeof e.value === 'number' ? e.value : null, kind === 'constant' ? (e.unit || '') : '', text);
    (m.others || []).slice(0, 4).forEach(function (o) {
      var od = (o.e.definitions || [])[0] || { quote: '', date: null };
      res.alt(o.e.term, null, '', 'the slide / Specification wording of the same idea: ' + defQuoteLine(od, o.e));
    });
    (m.also || []).forEach(function (o) {
      var od = (o.e.definitions || [])[0] || { quote: '', date: null };
      res.alt(o.e.term, null, '', 'another entry whose name is also in your words (not the answer given): ' + defQuoteLine(od, o.e));
    });
    (e.notes || []).forEach(function (nt) { res.flag('NOTE: ' + nt); });
    if (/CART/.test(e.source || '')) res.flag('NOTE: class quotes come from CART captions; the wording is rough (garbled words are noted in the Definitions page).');
    return res;
  });

  // ---- custom sections (P2): a solid round bar, a solid rectangle / plate, a W with two cover plates (on the flange faces, or at the flange tips boxing the section) ----
  // ONE helper, sectionFromArgs(), used by section_properties, column_capacity and column_euler, so the numbers cannot differ between them.
  //   round bar, diameter d:   A = pi d^2 / 4,  I = pi d^4 / 64 (both axes),  r = d / 4
  //   rectangle / plate, b (width, parallel to the x axis) x t (thickness):  A = b t,  Ix = b t^3 / 12,  Iy = t b^3 / 12,  rx = t / sqrt(12),  ry = b / sqrt(12),  r_min = min(b, t) / sqrt(12)
  //   W + two plates ON THE FLANGE FACES (flat, width b, thickness t):   A + 2 b t;   Ix + 2 [ b t^3/12 + b t (d/2 + t/2)^2 ];   Iy + 2 (t b^3 / 12)
  //   W + two plates AT THE FLANGE TIPS (vertical, height h, thickness t, centred on the depth):   A + 2 h t;   Ix + 2 (t h^3 / 12);   Iy + 2 [ h t^3/12 + h t (bf/2 + t/2)^2 ]
  // A "PL t x b" has the THICKNESS first: "PL 1/2 x 10" is t = 1/2 and b = 10 (the steps echo it back).
  var SECTION_FIELDS = [
    F('bar_dia_in', 'number', 'SOLID ROUND BAR: diameter', 'in', { min: 0, minExclusive: true }),
    F('rect_b_in', 'number', 'SOLID RECTANGLE or PLATE: width b (the SECOND number of "PL t x b": "PL 1/2 x 10" is t = 1/2 and b = 10)', 'in', { min: 0, minExclusive: true }),
    F('rect_t_in', 'number', 'SOLID RECTANGLE or PLATE: thickness t (the FIRST number of "PL t x b")', 'in', { min: 0, minExclusive: true }),
    F('plate_t_in', 'number', 'TWO COVER PLATES on the W (the shape box): thickness t (the FIRST number of "PL t x b")', 'in', { min: 0, minExclusive: true }),
    F('plate_b_in', 'number', 'Cover plates ON THE FLANGE FACES (flat, horizontal): width b (the SECOND number of "PL t x b")', 'in', { min: 0, minExclusive: true }),
    F('plate_h_in', 'number', 'Plates AT THE FLANGE TIPS, boxing the section (vertical, centred on the depth): height h', 'in', { min: 0, minExclusive: true }),
    F('plate_Fy', 'number', 'Plate Fy -- only if it differs from the shape (ONE Fy is used for the whole section: the LOWER of the two)', 'ksi', { min: 1, minExclusive: true })
  ];
  var SECTION_NAMES = ['bar_dia_in', 'rect_b_in', 'rect_t_in', 'plate_t_in', 'plate_b_in', 'plate_h_in'];

  function frac8(x) {      // 0.5 -> "1/2", 0.25 -> "1/4", 0.375 -> "3/8", otherwise the decimal
    var i, d = [2, 4, 8, 16], k;
    for (i = 0; i < d.length; i++) { k = x * d[i]; if (Math.abs(k - Math.round(k)) < 1e-9 && x < 1) return Math.round(k) + '/' + d[i]; }
    return n(x, 4);
  }

  // Returns null when no section field was typed; otherwise { kind, label, s (a column-ready record), A, Ix, Iy, rx, ry, rmin, steps, plateFy }.
  // base = the shape record typed in `shape` (or null).  Throws MISSING / AMBIGUOUS / INVALID, naming what is wrong.
  function sectionFromArgs(a, res, base) {
    var bar = isSet(a.bar_dia_in), rect = isSet(a.rect_b_in) || isSet(a.rect_t_in), pl = isSet(a.plate_t_in) || isSet(a.plate_b_in) || isSet(a.plate_h_in);
    if (!bar && !rect && !pl) {
      if (isSet(a.plate_Fy) && res.gave('plate_Fy')) res.flag('NOTE: a plate Fy was typed but there are no cover plates, so it was NOT used.');
      return null;
    }
    var kinds = [];
    if (bar) kinds.push('a round bar (bar_dia_in)');
    if (rect) kinds.push('a rectangle / plate (rect_b_in, rect_t_in)');
    if (pl) kinds.push('cover plates on a shape (plate_t_in, plate_b_in or plate_h_in)');
    if (kinds.length > 1) fail('AMBIGUOUS', 'You entered ' + kinds.join(' AND ') + '. A section is ONE of: a solid round bar, a solid rectangle or plate, or a W with cover plates.');
    if (base && !pl) fail('AMBIGUOUS', 'You gave a shape (' + base.label + ') AND a ' + (bar ? 'round bar' : 'rectangle / plate') + '. Use one: the shape, or the bar / rectangle fields.');
    var out = { steps: [], plateFy: null }, A, Ix, Iy, t, b, h, d, bf, k, line;
    if (bar) {
      d = a.bar_dia_in;
      A = Math.PI * d * d / 4; Ix = Math.PI * Math.pow(d, 4) / 64; Iy = Ix;
      out.kind = 'bar'; out.label = 'solid round bar d = ' + n(d, 4) + ' in';
      out.steps.push('Solid round bar, d = ' + n(d, 4) + ' in:  A = pi d^2 / 4 = ' + n(A, 4) + ' in^2;  I = pi d^4 / 64 = ' + n(Ix, 5) + ' in^4 (the same about both axes);  r = sqrt(I / A) = d / 4 = ' + n(d / 4, 4) + ' in.');
      out.rx = d / 4; out.ry = d / 4;
    } else if (rect) {
      if (!isSet(a.rect_b_in) || !isSet(a.rect_t_in)) fail('MISSING', 'A rectangle or plate needs BOTH the width b (rect_b_in) and the thickness t (rect_t_in). "PL t x b" has the THICKNESS first: "PL 1/2 x 10" is t = 1/2, b = 10.');
      b = a.rect_b_in; t = a.rect_t_in;
      A = b * t; Ix = b * Math.pow(t, 3) / 12; Iy = t * Math.pow(b, 3) / 12;
      out.kind = 'rect'; out.label = 'PL ' + frac8(t) + ' x ' + n(b, 4);
      out.steps.push('PL ' + frac8(t) + ' x ' + n(b, 4) + ' means thickness t = ' + n(t, 4) + ' in (the first number) and width b = ' + n(b, 4) + ' in (the second number).');
      out.steps.push('Solid rectangle b x t = ' + n(b, 4) + ' x ' + n(t, 4) + ':  A = b t = ' + n(A, 4) + ' in^2;  Ix = b t^3 / 12 = ' + n(Ix, 5) + ' in^4 (about the axis parallel to b);  Iy = t b^3 / 12 = ' + n(Iy, 4) + ' in^4;  rx = t / sqrt(12) = ' + n(t / Math.sqrt(12), 4) + ' in;  ry = b / sqrt(12) = ' + n(b / Math.sqrt(12), 4) + ' in;  r_min = ' + n(Math.min(b, t) / Math.sqrt(12), 4) + ' in.');
      out.rx = t / Math.sqrt(12); out.ry = b / Math.sqrt(12);
    } else {
      if (!base) fail('MISSING', 'Cover plates go on a W-shape: enter the shape (for example W10X39) as well as the plate size.');
      if (!/^(W|M|S|HP)$/.test(base.type) || !isNum(base.d) || !isNum(base.bf) || !isNum(base.Ix) || !isNum(base.Iy)) fail('INVALID', base.label + ' is not an I-shape with a depth and a flange width in the database: cover plates are done for W, M, S and HP shapes only.');
      if (!isSet(a.plate_t_in)) fail('MISSING', 'Enter the plate thickness t (plate_t_in): "PL t x b" has the THICKNESS first, "PL 1/2 x 10" is t = 1/2, b = 10.');
      if (isSet(a.plate_b_in) && isSet(a.plate_h_in)) fail('AMBIGUOUS', 'You gave the plate width b (plates ON THE FLANGE FACES) AND the plate height h (plates AT THE FLANGE TIPS). Use one.');
      if (!isSet(a.plate_b_in) && !isSet(a.plate_h_in)) fail('MISSING', 'Where are the plates? Enter the width b (plate_b_in) for plates ON THE FLANGE FACES, or the height h (plate_h_in) for plates AT THE FLANGE TIPS (boxing the section).');
      t = a.plate_t_in; d = base.d; bf = base.bf;
      A = base.A; Ix = base.Ix; Iy = base.Iy;
      if (isSet(a.plate_b_in)) {
        b = a.plate_b_in;
        out.kind = 'faces'; out.label = base.label + ' + 2 PL ' + frac8(t) + ' x ' + n(b, 4) + ' (on the flange faces)';
        out.steps.push('Two cover plates PL ' + frac8(t) + ' x ' + n(b, 4) + ': thickness t = ' + n(t, 4) + ' in (the first number), width b = ' + n(b, 4) + ' in (the second number), flat on the OUTSIDE face of each flange.');
        out.steps.push(base.label + ' from the Manual: A = ' + n(A, 4) + ' in^2, d = ' + n(d, 3) + ' in, bf = ' + n(bf, 3) + ' in, Ix = ' + n(Ix, 4) + ' in^4, Iy = ' + n(Iy, 4) + ' in^4.');
        k = 2 * b * t; out.steps.push('Area: A = ' + n(A, 4) + ' + 2 b t = ' + n(A, 4) + ' + 2 (' + n(b, 4) + ') (' + n(t, 4) + ') = ' + n(A + k, 4) + ' in^2.');
        var ixSelf = 2 * b * Math.pow(t, 3) / 12, ixAd = 2 * b * t * Math.pow(d / 2 + t / 2, 2);
        out.steps.push('Ix = Ix(W) + 2 [ b t^3 / 12 ] + 2 [ b t (d/2 + t/2)^2 ] = ' + n(Ix, 4) + ' + ' + n(ixSelf, 4) + ' + ' + n(ixAd, 4) + ' = ' + n(Ix + ixSelf + ixAd, 4) + ' in^4   (the plate centroid is d/2 + t/2 = ' + n(d / 2 + t / 2, 4) + ' in from the x axis).');
        var iySelf = 2 * t * Math.pow(b, 3) / 12;
        out.steps.push('Iy = Iy(W) + 2 [ t b^3 / 12 ] = ' + n(Iy, 4) + ' + ' + n(iySelf, 4) + ' = ' + n(Iy + iySelf, 4) + ' in^4   (the plates are centred on the flange, so no A d^2 term about the y axis).');
        A += k; Ix += ixSelf + ixAd; Iy += iySelf;
        if (b > bf + 1e-9) res.flag('NOTE: the plates (b = ' + n(b, 3) + ' in) are wider than the flange (bf = ' + n(bf, 3) + ' in). Check the problem: the numbers above use b as typed.');
      } else {
        h = a.plate_h_in;
        out.kind = 'tips'; out.label = base.label + ' + 2 PL ' + frac8(t) + ' x ' + n(h, 4) + ' (at the flange tips, boxed)';
        out.steps.push('Two plates AT THE FLANGE TIPS, boxing the section: thickness t = ' + n(t, 4) + ' in (the first number), height h = ' + n(h, 4) + ' in (vertical, centred on the depth).');
        out.steps.push(base.label + ' from the Manual: A = ' + n(A, 4) + ' in^2, d = ' + n(d, 3) + ' in, bf = ' + n(bf, 3) + ' in, Ix = ' + n(Ix, 4) + ' in^4, Iy = ' + n(Iy, 4) + ' in^4.');
        k = 2 * h * t; out.steps.push('Area: A = ' + n(A, 4) + ' + 2 h t = ' + n(A, 4) + ' + 2 (' + n(h, 4) + ') (' + n(t, 4) + ') = ' + n(A + k, 4) + ' in^2.');
        var ix2 = 2 * t * Math.pow(h, 3) / 12;
        out.steps.push('Ix = Ix(W) + 2 [ t h^3 / 12 ] = ' + n(Ix, 4) + ' + ' + n(ix2, 4) + ' = ' + n(Ix + ix2, 4) + ' in^4   (the plates are centred on the depth, so no A d^2 term about the x axis).');
        var iyS = 2 * h * Math.pow(t, 3) / 12, iyAd = 2 * h * t * Math.pow(bf / 2 + t / 2, 2);
        out.steps.push('Iy = Iy(W) + 2 [ h t^3 / 12 ] + 2 [ h t (bf/2 + t/2)^2 ] = ' + n(Iy, 4) + ' + ' + n(iyS, 4) + ' + ' + n(iyAd, 4) + ' = ' + n(Iy + iyS + iyAd, 4) + ' in^4   (the plate centroid is bf/2 + t/2 = ' + n(bf / 2 + t / 2, 4) + ' in from the y axis).');
        A += k; Ix += ix2; Iy += iyS + iyAd;
      }
      out.plateFy = isSet(a.plate_Fy) ? a.plate_Fy : null;
      out.rx = Math.sqrt(Ix / A); out.ry = Math.sqrt(Iy / A);
      out.steps.push('Radii of gyration: rx = sqrt(Ix / A) = sqrt(' + n(Ix, 4) + ' / ' + n(A, 4) + ') = ' + n(out.rx, 4) + ' in;  ry = sqrt(Iy / A) = sqrt(' + n(Iy, 4) + ' / ' + n(A, 4) + ') = ' + n(out.ry, 4) + ' in.');
    }
    if (isSet(a.plate_Fy) && !pl) res.flag('NOTE: a plate Fy was typed but there are no cover plates, so it was NOT used.');
    out.A = A; out.Ix = Ix; out.Iy = Iy; out.rmin = Math.min(out.rx, out.ry); out.base = base;
    // a column-ready record (type BUILTUP: no E7, no Table 4-1a, KL/r route)
    out.s = { label: out.label, type: 'BUILTUP', A: A, Ix: Ix, Iy: Iy, rx: out.rx, ry: out.ry, W: undefined };
    return out;
  }

  def('section_properties', 'Lookup', 'Section properties of a bar, a plate or a W with cover plates', 'A, Ix, Iy, rx, ry and r_min of a solid round bar, a solid rectangle / plate, or a W-shape with two cover plates (on the flange faces, or at the flange tips boxing the section). Every I + A d^2 term is its own step. "PL t x b" has the THICKNESS first. A solid round bar or rectangle also gets the elastic section modulus S, the plastic section modulus Z and the shape factor Z / S (her Steel 5 p.3).', [
    F('shape', 'shape', 'The W-shape (only for cover plates)', '')
  ].concat(SECTION_FIELDS), function (a, res) {
    var base = isBlank(a.shape) ? null : useShape(res, findShape(a.shape));
    var sec = sectionFromArgs(a, res, base);
    if (!sec) fail('MISSING', 'Enter a section: a solid round bar (bar_dia_in), a solid rectangle or plate (rect_b_in and rect_t_in), or a W-shape with cover plates (shape + plate_t_in + plate_b_in for the flange faces, or plate_h_in for the flange tips).');
    sec.steps.forEach(function (st) { res.step(st, 'Section properties (mechanics: A, I = I_own + A d^2, r = sqrt(I/A))'); });
    res.val('A', sec.A, 'in^2').val('Ix', sec.Ix, 'in^4').val('Iy', sec.Iy, 'in^4').val('rx', sec.rx, 'in').val('ry', sec.ry, 'in').val('r_min', sec.rmin, 'in');
    res.val('governing_axis', sec.rx <= sec.ry ? 'x' : 'y', '');
    // P9-4 (her Steel 5 p.3): the elastic and plastic section moduli and the shape factor of a solid rectangle or round bar.  Added HERE, not in sectionFromArgs,
    // so column_capacity and column_euler (which share that helper) print exactly what they printed before.
    var SRCM = 'Section moduli (mechanics: S = I / c, Z = twice the first moment of the half area; her Steel 5 p.3)', modTxt = '';
    if (sec.kind === 'bar') {
      var db = a.bar_dia_in, Sb = Math.PI * Math.pow(db, 3) / 32, Zb = Math.pow(db, 3) / 6, sfb = Zb / Sb;
      res.step('Elastic section modulus: S = I / c = (pi d^4 / 64) / (d / 2) = pi d^3 / 32 = pi (' + n(db, 4) + ')^3 / 32 = ' + n(Sb, 4) + ' in^3.', SRCM);
      res.step('Plastic section modulus: Z = d^3 / 6 = (' + n(db, 4) + ')^3 / 6 = ' + n(Zb, 4) + ' in^3.', SRCM);
      res.step('Shape factor = Mp / My = Z / S = (d^3 / 6) / (pi d^3 / 32) = 16 / (3 pi) = ' + n(sfb, 3) + ' for a solid round bar (1.5 for a rectangle).', SRCM);
      res.val('S', Sb, 'in^3', SRCM).val('Z', Zb, 'in^3', SRCM).val('shape_factor', sfb, '', SRCM);
      modTxt = ';  S = ' + n(Sb, 4) + ' in^3;  Z = ' + n(Zb, 4) + ' in^3;  shape factor Z / S = ' + n(sfb, 3);
    } else if (sec.kind === 'rect') {
      var rb = a.rect_b_in, rt = a.rect_t_in, Sx = rb * rt * rt / 6, Zx = rb * rt * rt / 4, sfr = Zx / Sx, Sy = rt * rb * rb / 6, Zy = rt * rb * rb / 4;
      res.step('Elastic section modulus about the x axis (the axis parallel to b; the depth in the direction of bending is d = t = ' + n(rt, 4) + ' in): S = I / c = b d^2 / 6 = ' + n(rb, 4) + ' x ' + n(rt, 4) + '^2 / 6 = ' + n(Sx, 4) + ' in^3  (her Steel 5 p.3: Sx = bd^2/6).  About the y axis (depth b = ' + n(rb, 4) + ' in): Sy = t b^2 / 6 = ' + n(Sy, 4) + ' in^3.', SRCM);
      res.step('Plastic section modulus about the x axis: Z = b d^2 / 4 = ' + n(rb, 4) + ' x ' + n(rt, 4) + '^2 / 4 = ' + n(Zx, 4) + ' in^3  (her Steel 5 p.3: Z = bd^2/4).  About the y axis: Zy = t b^2 / 4 = ' + n(Zy, 4) + ' in^3.', SRCM);
      res.step('Shape factor = Mp / My = Z / S = (b d^2 / 4) / (b d^2 / 6) = ' + n(Zx, 4) + ' / ' + n(Sx, 4) + ' = ' + n(sfr, 3) + ' for a rectangle (her Steel 5 p.3), the same about either axis.', SRCM);
      res.val('S', Sx, 'in^3', SRCM).val('Z', Zx, 'in^3', SRCM).val('Sy', Sy, 'in^3', SRCM).val('Zy', Zy, 'in^3', SRCM).val('shape_factor', sfr, '', SRCM);
      modTxt = ';  S = ' + n(Sx, 4) + ' in^3;  Z = ' + n(Zx, 4) + ' in^3 (about the x axis, depth t);  shape factor Z / S = ' + n(sfr, 3);
    }
    res.answer('Section properties: ' + sec.label, sec.A, 'in^2', 'A = ' + n(sec.A, 4) + ' in^2;  Ix = ' + n(sec.Ix, 4) + ';  Iy = ' + n(sec.Iy, 4) + ' in^4;  rx = ' + n(sec.rx, 4) + ';  ry = ' + n(sec.ry, 4) + ' in;  r_min = ' + n(sec.rmin, 4) + ' in (about the ' + (sec.rx <= sec.ry ? 'x' : 'y') + ' axis)' + modTxt);
    if (sec.kind === 'faces' || sec.kind === 'tips') res.flag('NOTE: built-up section: the plate slender-element check, the plate-to-flange connector spacing and the local buckling of the plates are NOT done (the book\'s solution does not do them).');
    if (isSet(a.plate_Fy)) res.flag('NOTE: the plate Fy matters for a column (Column > Capacity); it does not change the section properties.');
    return res;
  });

  // =====================================================================================================
  // 7. LOADS
  // =====================================================================================================

  var LOAD_FIELDS = function (unit) {
    return [
      F('D', 'number', 'Dead load D (service)', unit, { min: 0 }),
      F('L', 'number', 'Live load L (service)', unit, { min: 0 }),
      F('already_factored', 'boolean', 'The problem says the load is ALREADY FACTORED (then D and L are not used)', '', { default: false }),
      F('Pu', 'number', 'Factored load Pu -- only if the problem says factored; otherwise enter D and L', unit, { min: 0 })
    ];
  };

  // P7-1: ASCE 7, her week-1 slide (combinations 1 and 2 with only D and L): the factored load is the LARGER of 1.4D and 1.2D + 1.6L.  ONE helper for EVERY site that factors a
  // service dead / live load (a member load, a floor psf, a takedown level, a beam load case).  1.4D governs when L < D/8 (then 1.2D + 1.6L is up to 14% too low).
  function factorDL(D, L) {
    var u14 = 1.4 * D, u12 = 1.2 * D + 1.6 * L, g14 = u14 > u12 + 1e-9 * Math.max(1, Math.abs(u12));
    return { U: g14 ? u14 : u12, u14: u14, u12: u12, g14: g14, gov: g14 ? '1.4D' : '1.2D + 1.6L', fD: g14 ? 1.4 : 1.2, fL: g14 ? 0 : 1.6 };
  }
  // the two lines and the verdict, in her order (d = decimals, unit = text after each number)
  function factorLines(f, D, L, unit, d) {
    var u = unit ? ' ' + unit : '';
    return '1.2 D + 1.6 L = 1.2 (' + n(D, d) + ') + 1.6 (' + n(L, d) + ') = ' + n(f.u12, d) + u + ';  1.4 D = 1.4 (' + n(D, d) + ') = ' + n(f.u14, d) + u + ';  ' +
      (f.g14 ? '1.4D = ' + n(f.u14, d) + u + ' governs (L is less than D/8)' : '1.2D + 1.6L governs');
  }

  // Pu from D and L (service loads: the LARGER of 1.4D and 1.2D + 1.6L) or from a load the problem says is already factored.
  // Writes the step.  Returns null when no load was given at all.
  function loadFromArgs(a, res, unit) {
    unit = unit || 'kips';
    var hasD = isNum(a.D), hasL = isNum(a.L), hasP = isNum(a.Pu);
    if (a.already_factored) {
      if (!hasP) fail('MISSING', 'You ticked "already factored" but did not enter the factored load Pu.');
      if (hasD || hasL) res.flag('WARNING: D and L were ignored because "already factored" is ticked -- Pu is used exactly as given and is NOT factored again.');
      res.step('The problem says the load is already factored: Pu = ' + n(a.Pu, 3) + ' ' + unit + ' (used as given, NOT factored again).', SRC.lrfd);
      return { Pu: a.Pu, factored: true, D: null, L: null };
    }
    if (hasP && (hasD || hasL)) fail('AMBIGUOUS', 'You gave a factored load Pu AND service loads D / L. Tick "already factored" to use Pu, or clear Pu to factor D and L.');
    if (hasP) {
      res.flag('NOTE: only Pu was entered, so it is used as the FACTORED load (tick "already factored" to say so).');
      res.step('Factored load Pu = ' + n(a.Pu, 3) + ' ' + unit + ' (given; not factored again).', SRC.lrfd);
      return { Pu: a.Pu, factored: true, D: null, L: null };
    }
    if (!hasD && !hasL) return null;
    var D = hasD ? a.D : 0, L = hasL ? a.L : 0, f = factorDL(D, L);
    res.step('Loads are SERVICE loads unless the problem says factored. Factor them (ASCE 7, her slide: the LARGER of 1.2D + 1.6L and 1.4D): ' + factorLines(f, D, L, unit, 3) + '.  Pu = ' + n(f.U, 3) + ' ' + unit + '.', SRC.lrfd);
    res.val('governing_combination', f.gov, '', SRC.combos);
    return { Pu: f.U, factored: false, D: D, L: L, combo: f };
  }

  // ---- loads_factored ----
  def('loads_factored', 'Loads', 'Factored load: the larger of 1.2D + 1.6L and 1.4D', 'Service loads to factored load: the LARGER of 1.2D + 1.6L and 1.4D (ASCE 7; her week-1 slide combinations 1 and 2 with only D and L). A self-weight row is dead load and is added once. If the problem says the load is already factored, tick the box and nothing is factored.', [
    F('D', 'number', 'Dead load D (service)', '', { min: 0 }),
    F('L', 'number', 'Live load L (service)', '', { min: 0 }),
    F('self_weight', 'number', 'Self-weight (its own row; DEAD load, same unit as D; add it here ONCE)', '', { min: 0 }),
    F('already_factored', 'boolean', 'The problem says the load is ALREADY FACTORED', '', { default: false }),
    F('factored_value', 'number', 'The factored value given in the problem (only if the box above is ticked)', '', { min: 0 }),
    F('unit', 'text', 'Unit label to print (kips, k/ft, psf ...)', '', { default: 'kips' })
  ], function (a, res) {
    var u = a.unit, sw = isNum(a.self_weight) ? a.self_weight : 0, total, dPart, lPart;
    if (!a.already_factored && isNum(a.factored_value)) fail('AMBIGUOUS', 'A factored value (' + n(a.factored_value, 4) + ') was entered but "already factored" is not ticked. Tick the box to use it as given (nothing is multiplied by 1.2 / 1.6), or clear it and enter D and L.');
    if (a.already_factored) {
      if (!isNum(a.factored_value)) fail('MISSING', 'You ticked "already factored" but did not enter the factored value.');
      if (isNum(a.D) || isNum(a.L)) res.flag('WARNING: D and L were ignored because "already factored" is ticked.');
      res.step('The problem says the load is already factored: use ' + n(a.factored_value, 4) + ' ' + u + ' as given -- do NOT apply 1.2 / 1.6 again.', SRC.lrfd);
      total = a.factored_value;
      if (sw > 0) {
        res.step('Self-weight is its own row and is dead load: 1.2 x ' + n(sw, 4) + ' = ' + n(1.2 * sw, 4) + ' ' + u + '.', 'Her rule: self-weight is dead load');
        total += 1.2 * sw;
        res.step('Total factored = ' + n(a.factored_value, 4) + ' + ' + n(1.2 * sw, 4) + ' = ' + n(total, 4) + ' ' + u + '.', SRC.lrfd);
      }
      res.val('factored_total', total, u, SRC.lrfd);
      res.answer('Factored load', total, u, n(total, 4) + ' ' + u + ' (already factored in the problem)');
      return res;
    }
    var D = isNum(a.D) ? a.D : 0, L = isNum(a.L) ? a.L : 0;
    if (!isNum(a.D) && !isNum(a.L) && sw === 0) fail('MISSING', 'Enter the dead load D and/or live load L (or tick "already factored").');
    var Dt = D + sw, fq = factorDL(Dt, L);
    dPart = fq.fD * Dt; lPart = fq.fL * L; total = fq.U;
    res.step('Loads are SERVICE loads unless the problem says "factored". (She: "If they say nothing, it means it is unfactored.")', SRC.lrfd);
    if (sw > 0) res.step('Self-weight is dead load: D total = D + self-weight = ' + n(D, 4) + ' + ' + n(sw, 4) + ' = ' + n(D + sw, 4) + ' ' + u + '.', 'Her rule: self-weight is dead load');
    res.step('Factored = the LARGER of 1.2D + 1.6L and 1.4D (ASCE 7): ' + factorLines(fq, Dt, L, u, 4) + '.  Factored = ' + n(total, 4) + ' ' + u + '.', SRC.lrfd);
    res.val('D', D, u).val('L', L, u).val('self_weight', sw, u).val('dead_part', dPart, u).val('live_part', lPart, u).val('factored_total', total, u, SRC.lrfd);
    res.val('U_1_4D', fq.u14, u, SRC.combos).val('U_1_2D_1_6L', fq.u12, u, SRC.combos).val('governing_combination', fq.gov, '', SRC.combos);
    res.answer('Factored load', total, u, n(total, 4) + ' ' + u + '  (' + (fq.g14 ? '1.4D governs: L is less than D/8' : '1.2D + 1.6L') + ')');
    res.flag('NOTE: if the wording says "factored", "ultimate" or gives Pu, the load is already factored -- tick the box instead.');
    return res;
  });

  // ---- loads_floor ----
  var POSITION_VALUES = [
    { value: 'interior', label: 'interior member (tributary width = spacing)' },
    { value: 'edge', label: 'edge member (tributary width = spacing / 2)' },
    { value: 'custom', label: 'custom tributary width' }
  ];

  function tributaryWidth(a, prefix, res, spacingAlsoUsed) {
    var pos = a.position || 'interior';
    if (pos === 'custom') {
      if (!isNum(a.tributary_ft)) fail('MISSING', 'Missing: custom tributary width, ft.');
      if (res && isNum(a.spacing_ft) && !spacingAlsoUsed) res.flag('NOTE: the member spacing was entered but is NOT used: the custom tributary width was taken.');
      return { w: a.tributary_ft, text: 'custom tributary width = ' + n(a.tributary_ft, 3) + ' ft' };
    }
    if (res && isNum(a.tributary_ft)) res.flag('NOTE: a custom tributary width was entered but is NOT used: the member is "' + pos + '", so the width comes from the spacing.');
    if (!isNum(a.spacing_ft)) return null;
    if (pos === 'edge') return { w: a.spacing_ft / 2, text: 'EDGE member: tributary width = spacing / 2 = ' + n(a.spacing_ft, 3) + ' / 2 = ' + n(a.spacing_ft / 2, 3) + ' ft' };
    return { w: a.spacing_ft, text: 'INTERIOR member: tributary width = spacing = ' + n(a.spacing_ft, 3) + ' ft' };
  }

  // floor load core: used by loads_floor, floor_plan and beam_max_live_load
  function floorLoadCore(a, res) {
    var pcf = isNum(a.concrete_pcf) ? a.concrete_pcf : 150;
    var slab = a.slab_thickness_in / 12 * pcf;
    var sdl = isNum(a.superimposed_dead_psf) ? a.superimposed_dead_psf : 0;
    var frm = isNum(a.framing_psf) ? a.framing_psf : 0;
    var dead = slab + sdl + frm;
    var live = isNum(a.live_psf) ? a.live_psf : 0;
    if (isNum(a.live2_psf)) {
      if (a.live2_psf > live) { res && res.flag('NOTE: two live loads were given; she takes the LARGER one (' + n(a.live2_psf, 3) + ' psf, not the ' + n(live, 3) + ' psf). They are not added.'); live = a.live2_psf; }
      else res && res.flag('NOTE: two live loads were given; she takes the LARGER one (' + n(live, 3) + ' psf). They are not added.');
    }
    var fl = factorDL(dead, live);   // P7-1: the LARGER of 1.4D and 1.2D + 1.6L, per square foot
    return { pcf: pcf, slab: slab, sdl: sdl, frm: frm, dead: dead, live: live, factored: fl.U, fact: fl };
  }

  var FLOOR_FIELDS = [
    // P9-5: required UNLESS the dead load is typed directly in psf (her Steel 5 p13: DL 85 psf including the steel): then a blank slab is NO slab
    F('slab_thickness_in', 'dimension', 'Concrete slab thickness', 'in',
      { required: true, requiredUnless: ['superimposed_dead_psf', 'framing_psf'], missingHint: 'Type the slab thickness (0 if there is no slab), or leave it blank and type the dead load in psf in the superimposed dead load box (or the steel framing box).', min: 0 }),
    F('concrete_pcf', 'number', 'Concrete unit weight', 'pcf', { default: 150, min: 0 }),
    F('superimposed_dead_psf', 'number', 'Superimposed dead load: ceiling, mechanical, flooring, FIXED partitions given as a dead load', 'psf', { default: 0, min: 0 }),
    F('framing_psf', 'number', 'Steel framing weight -- only if the problem GIVES it as psf (otherwise 0: the beam weight is added after you choose it)', 'psf', { default: 0, min: 0 }),
    F('live_psf', 'number', 'Live load', 'psf', { required: true, min: 0 }),
    F('live2_psf', 'number', 'MOVABLE partitions or a second live load -- she takes the LARGER of the two live loads (not the sum)', 'psf', { min: 0 })
  ];

  def('loads_floor', 'Loads', 'Floor load to line load on a beam', 'Slab thickness -> dead psf, live psf, factored psf, and the factored line load (k/ft) on an interior or edge member. Floor loads are SERVICE loads. The slab box may be left blank when the problem gives the dead load directly in psf (type it in the superimposed dead load box): blank = no slab.', FLOOR_FIELDS.concat([
    F('position', 'select', 'Member position', '', { default: 'interior', values: POSITION_VALUES }),
    F('spacing_ft', 'number', 'Spacing of the members (beam spacing)', 'ft', { min: 0, minExclusive: true }),
    F('tributary_ft', 'number', 'Custom tributary width', 'ft', { min: 0, minExclusive: true })
  ]), function (a, res) {
    var c = floorLoadCore(a, res), noSlab = !res.gave('slab_thickness_in');   // P9-5: a blank slab box (the dead load typed directly in psf) is NO slab
    if (noSlab) {
      res.step('No slab: the slab box was left blank because the dead load is typed directly in psf, so the slab adds 0 psf.', SRC.given);
      res.flag('WARNING: the slab thickness was left BLANK and a dead load in psf was typed, so NO slab was added (slab = 0 psf). If the problem has a concrete slab, type its thickness.');
    } else res.step('Slab dead load = thickness / 12 x unit weight = ' + n(a.slab_thickness_in, 3) + ' / 12 x ' + n(c.pcf, 2) + ' = ' + n(c.slab, 3) + ' psf.', 'Her conversion (150 pcf concrete)');
    res.step('Dead load D = slab + superimposed + steel framing = ' + n(c.slab, 3) + ' + ' + n(c.sdl, 3) + ' + ' + n(c.frm, 3) + ' = ' + n(c.dead, 3) + ' psf.', SRC.given);
    res.step('Live load L = ' + n(c.live, 3) + ' psf (service).', SRC.given);
    res.step('Factored floor load = the LARGER of 1.2D + 1.6L and 1.4D (ASCE 7): ' + factorLines(c.fact, c.dead, c.live, 'psf', 3) + '.  Factored floor load = ' + n(c.factored, 3) + ' psf.', SRC.lrfd);
    res.val('slab_psf', c.slab, 'psf').val('dead_psf', c.dead, 'psf').val('live_psf', c.live, 'psf').val('factored_psf', c.factored, 'psf', SRC.lrfd).val('governing_combination', c.fact.gov, '', SRC.combos);
    var tw = tributaryWidth(a, '', res);
    if (c.frm === 0) res.flag('NOTE: no steel-framing weight was entered. If the problem gives one (psf) enter it above; otherwise add the beam\'s own weight after choosing it (Beam section, self-weight recheck).');
    else res.flag('NOTE: the steel-framing weight is already inside the dead load -- do NOT add the beam self-weight again.');
    if (!tw) {
      res.answer('Factored floor load', c.factored, 'psf', n(c.factored, 3) + ' psf  (dead ' + n(c.dead, 3) + ', live ' + n(c.live, 3) + ')');
      res.flag('NOTE: enter the beam spacing to get the line load in k/ft.');
      return res;
    }
    var wu = c.factored * tw.w / 1000, wd = c.dead * tw.w / 1000, wl = c.live * tw.w / 1000;
    res.step(tw.text + '.', 'Tributary width (load path: slab -> beam)');
    res.step('Line load: psf x ft = plf, / 1000 = k/ft.  wu = ' + n(c.factored, 3) + ' x ' + n(tw.w, 3) + ' / 1000 = ' + n(wu, 4) + ' k/ft  (service: wD = ' + n(wd, 4) + ', wL = ' + n(wl, 4) + ' k/ft).', SRC.lrfd);
    res.val('tributary_ft', tw.w, 'ft').val('wD', wd, 'k/ft').val('wL', wl, 'k/ft').val('wu', wu, 'k/ft', SRC.lrfd);
    res.answer('Factored line load wu', wu, 'k/ft', 'wu = ' + n(wu, 4) + ' k/ft  (factored floor load ' + n(c.factored, 3) + ' psf x ' + n(tw.w, 3) + ' ft)');
    return res;
  });

  // ---- loads_takedown ----
  def('loads_takedown', 'Loads', 'Column load takedown', 'Factored column load at every level: each column segment is factored on the loads it actually carries (the running sums of D and L from the roof down, then the LARGER of 1.2D + 1.6L and 1.4D). Slab dead load = thickness / 12 x 150 pcf, plus the other dead load in psf. Two live loads on one floor (e.g. 75 + MOVABLE partitions 15): she takes the LARGER; FIXED partitions given as a dead load go in the dead load. Roof live is factored 1.6 like floor live.', [
    F('tributary_area_sf', 'number', 'Tributary area of the column (or enter the two bay dimensions below)', 'sq ft', { min: 0, minExclusive: true }),
    F('bay_x_ft', 'number', 'Bay dimension 1 (tributary area = bay 1 x bay 2)', 'ft', { min: 0, minExclusive: true }),
    F('bay_y_ft', 'number', 'Bay dimension 2', 'ft', { min: 0, minExclusive: true }),
    F('concrete_pcf', 'number', 'Concrete unit weight', 'pcf', { default: 150, min: 0 }),
    F('roof_slab_in', 'dimension', 'Roof slab thickness (0 if none)', 'in', { default: 0, min: 0 }),
    F('roof_D_psf', 'number', 'Roof dead load OTHER than the slab (roofing, ceiling, framing)', 'psf', { default: 0, min: 0 }),
    F('roof_L_psf', 'number', 'Roof live load -- leave ALL the roof boxes empty for NO roof (the column then carries the floors only)', 'psf', { min: 0 }),
    F('roof_L2_psf', 'number', 'Roof second live load -- the LARGER of the two is used', 'psf', { min: 0 }),
    F('floor_slab_in', 'dimension', 'Floor slab thickness (0 if none)', 'in', { default: 0, min: 0 }),
    F('floor_D_psf', 'number', 'Floor dead load OTHER than the slab (superimposed dead: ceiling, mechanical, flooring, FIXED partitions given as a dead load, framing)', 'psf', { default: 0, min: 0 }),
    F('floor_L_psf', 'number', 'Floor live load', 'psf', { default: 0, min: 0 }),
    F('floor_L2_psf', 'number', 'Floor second live load: MOVABLE partitions or a second live load -- the LARGER of the two live loads is used (not the sum)', 'psf', { min: 0 }),
    F('floors', 'integer', 'Number of FLOORS below the roof that the column carries', '', { default: 0, min: 0, max: 100 })
  ], function (a, res) {
    var A = a.tributary_area_sf;
    if (isNum(A) && isNum(a.bay_x_ft) && isNum(a.bay_y_ft) && Math.abs(a.bay_x_ft * a.bay_y_ft - A) > 1e-6 * Math.max(1, A)) fail('AMBIGUOUS', 'The tributary area was given twice and the two disagree: ' + n(A, 3) + ' sq ft, but the bays ' + n(a.bay_x_ft, 3) + ' x ' + n(a.bay_y_ft, 3) + ' = ' + n(a.bay_x_ft * a.bay_y_ft, 3) + ' sq ft. Give the area OR the two bay dimensions.');
    if (isNum(A) && (isNum(a.bay_x_ft) !== isNum(a.bay_y_ft))) res.flag('NOTE: the tributary area was given, so the single bay dimension you entered was NOT used.');
    if (!isNum(A)) {
      if (!isNum(a.bay_x_ft) || !isNum(a.bay_y_ft)) fail('MISSING', 'Enter the tributary area, or both bay dimensions.');
      A = a.bay_x_ft * a.bay_y_ft;
      res.step('Tributary area = ' + n(a.bay_x_ft, 3) + ' x ' + n(a.bay_y_ft, 3) + ' = ' + n(A, 3) + ' sq ft.', 'Tributary area (it does not care how the beams are framed)');
    } else res.step('Tributary area = ' + n(A, 3) + ' sq ft.', SRC.given);
    var pcf = isNum(a.concrete_pcf) ? a.concrete_pcf : 150;
    var roofSlab = (a.roof_slab_in || 0) / 12 * pcf, floorSlab = (a.floor_slab_in || 0) / 12 * pcf;
    var roofD = roofSlab + (a.roof_D_psf || 0), floorD = floorSlab + (a.floor_D_psf || 0);
    // P6: a roof exists only when some roof box holds a NON-ZERO value; every roof box blank or 0 is NO roof (a zero typed in a roof box never asks for a roof live load)
    var roofTyped = ['roof_slab_in', 'roof_D_psf', 'roof_L_psf', 'roof_L2_psf'].filter(function (k) { return res.gave(k) && isSet(a[k]); }), noRoof = !roofTyped.length;
    if (!noRoof && !isNum(a.roof_L_psf)) fail('MISSING', 'The roof has entries (' + roofTyped.join(', ') + ') but no roof LIVE load: enter it (0 if none), or clear the roof boxes (or leave them 0) for no roof.');
    if (noRoof) res.step('No roof was entered (every roof box blank or 0): the roof carries no load, so the column load comes from the ' + (a.floors > 0 ? a.floors + ' floor' + (a.floors > 1 ? 's' : '') : 'floors (none given)') + ' only.', SRC.given);
    var roofL = noRoof ? 0 : a.roof_L_psf, floorL = isNum(a.floor_L_psf) ? a.floor_L_psf : 0;
    if (!noRoof && isNum(a.roof_L2_psf)) { res.step('Roof: two live loads (' + n(roofL, 3) + ' and ' + n(a.roof_L2_psf, 3) + ' psf): "choose the larger one" -> ' + n(Math.max(roofL, a.roof_L2_psf), 3) + ' psf (not added).', 'Her rule (HW 6-17: the textbook treats partitions and LL both as live loads)'); roofL = Math.max(roofL, a.roof_L2_psf); }
    if (isNum(a.floor_L2_psf)) { res.step('Floor: two live loads (' + n(floorL, 3) + ' and ' + n(a.floor_L2_psf, 3) + ' psf): "choose the larger one" -> ' + n(Math.max(floorL, a.floor_L2_psf), 3) + ' psf (not added).', 'Her rule (HW 6-17: the textbook treats partitions and LL both as live loads)'); floorL = Math.max(floorL, a.floor_L2_psf); }
    if (roofSlab > 0) res.step('Roof dead load = slab ' + n(a.roof_slab_in, 3) + ' / 12 x ' + n(pcf, 2) + ' = ' + n(roofSlab, 3) + ' psf + other ' + n(a.roof_D_psf || 0, 3) + ' = ' + n(roofD, 3) + ' psf.', 'Her conversion (150 pcf concrete)');
    if (floorSlab > 0) res.step('Floor dead load = slab ' + n(a.floor_slab_in, 3) + ' / 12 x ' + n(pcf, 2) + ' = ' + n(floorSlab, 3) + ' psf + other ' + n(a.floor_D_psf || 0, 3) + ' = ' + n(floorD, 3) + ' psf.', 'Her conversion (150 pcf concrete)');
    // P7-R2: ASCE 7 applies the combination to the loads the column segment ACTUALLY CARRIES. For every segment: the running sums of D and L from the roof down to it, then
    // Pu = the LARGER of 1.2 (sum D) + 1.6 (sum L) and 1.4 (sum D).  (The larger per LEVEL, summed, would lift a dead-dominant level on its own and over-state the column.)
    var fRoof = factorDL(roofD, roofL), fFloor = factorDL(floorD, floorL);   // ONE level taken alone: information only (Pu_roof, Pu_one_floor_alone_reference)
    var floorPsf = fFloor.U;
    var dRoofK = roofD * A / 1000, lRoofK = roofL * A / 1000, dFloorK = floorD * A / 1000, lFloorK = floorL * A / 1000;
    function segmentAt(k) { var Ds = dRoofK + k * dFloorK, Ls = lRoofK + k * lFloorK, f = factorDL(Ds, Ls); return { k: k, D: Ds, L: Ls, f: f, Pu: f.U }; }
    var floorP = floorPsf * A / 1000, segs = [], k;
    for (k = 0; k <= a.floors; k++) segs.push(segmentAt(k));
    var roofP = segs[0].Pu;
    function segLabel(sg) { return sg.k === 0 ? (noRoof ? 'no roof' : 'below the roof (roof only)') : (noRoof ? '' : 'roof + ') + sg.k + ' floor' + (sg.k > 1 ? 's' : ''); }
    var floorGiven = ['floor_slab_in', 'floor_D_psf', 'floor_L_psf', 'floor_L2_psf'].filter(function (k) { return res.gave(k) && isSet(a[k]); });
    if (!(a.floors > 0) && floorGiven.length) res.flag('CHECK: floor loads were entered (' + floorGiven.join(', ') + ') but the number of floors is 0, so the column carries the roof only and they were NOT used.');
    if (a.floors > 0 && !(floorPsf > 0)) res.flag('CHECK: the column carries ' + a.floors + ' floor' + (a.floors > 1 ? 's' : '') + ' but no floor load was entered, so each floor adds 0 kips.');
    res.step('Service load of each level (kips = psf x A / 1000): ' + (noRoof ? '' : 'roof D = ' + n(roofD, 3) + ' x ' + n(A, 3) + ' / 1000 = ' + n(dRoofK, 3) + ', L = ' + n(roofL, 3) + ' x ' + n(A, 3) + ' / 1000 = ' + n(lRoofK, 3) + (a.floors > 0 ? ';  ' : '')) + (a.floors > 0 ? 'each floor D = ' + n(floorD, 3) + ' x ' + n(A, 3) + ' / 1000 = ' + n(dFloorK, 3) + ', L = ' + n(floorL, 3) + ' x ' + n(A, 3) + ' / 1000 = ' + n(lFloorK, 3) : '') + '.', SRC.given);
    res.step('Each column segment is factored on the loads it ACTUALLY carries: the running sums of D and L from the roof down to it, then Pu = the LARGER of 1.2 sum D + 1.6 sum L and 1.4 sum D (ASCE 7; her week-1 slide).', SRC.lrfd);
    var shown = segs.length <= 13 ? segs : [segs[0], segs[1], segs[segs.length - 1]];
    shown.forEach(function (sg) {
      if (noRoof && sg.k === 0) return;
      res.step('Segment ' + segLabel(sg) + ': sum D = ' + n(sg.D, 3) + ' kips, sum L = ' + n(sg.L, 3) + ' kips.  ' + factorLines(sg.f, sg.D, sg.L, 'kips', 3) + '.  Pu = ' + n(sg.Pu, 2) + ' kips.', SRC.lrfd);
    });
    if (shown.length < segs.length) res.step('(The other ' + (segs.length - shown.length) + ' segments are in the table below.)', SRC.lrfd);
    var rows = segs.map(function (sg) { return [segLabel(sg), sg.k, sg.Pu, sg.D, sg.L, sg.f.u12, sg.f.u14, sg.Pu > 0 ? sg.f.gov : '']; }), i;
    res.val('Pu_roof', roofP, 'kips', SRC.lrfd).val('Pu_one_floor_alone_reference', floorP, 'kips', SRC.lrfd, { referenceOnly: true, note: 'REFERENCE ONLY: ONE floor factored on its own (the larger of 1.2D + 1.6L and 1.4D of that floor alone). Never multiply it or add it up to get a column load: the column load at each level is Pu_level_k, each segment factored on its running sums of D and L.' }).val('Pu_level_0', roofP, 'kips', SRC.lrfd);
    res.val('roof_dead_psf', roofD, 'psf').val('floor_dead_psf', floorD, 'psf').val('roof_live_psf', roofL, 'psf').val('floor_live_psf', floorL, 'psf').val('tributary_area', A, 'sq ft');
    for (i = 1; i <= a.floors; i++) {
      res.val('Pu_level_' + i, segs[i].Pu, 'kips', SRC.lrfd);
      if (i < a.floors) res.alt('Pu below ' + (i === 1 ? '1 floor' : i + ' floors') + ' of floor load', segs[i].Pu, 'kips', (noRoof ? '' : 'roof + ') + i + ' floor' + (i > 1 ? 's' : ''));
    }
    res.step('Running total down the column: ' + segs.map(function (sg) { return n(sg.Pu, 2); }).join(' -> ') + ' kips (every segment factored on its own running sums of D and L).', 'Column load takedown (summed down the building)');
    res.table('Column load at each level', ['Carries', 'Floors', 'Pu, kips', 'sum D, kips', 'sum L, kips', '1.2D + 1.6L, kips', '1.4D, kips', 'governs'], rows.map(function (r) { return [r[0], r[1], Math.round(r[2] * 100) / 100, Math.round(r[3] * 100) / 100, Math.round(r[4] * 100) / 100, Math.round(r[5] * 100) / 100, Math.round(r[6] * 100) / 100, r[7]]; }));
    var bot = segs[segs.length - 1], cum = bot.Pu;
    res.val('Pu_bottom', cum, 'kips', SRC.lrfd).val('governing_combination', bot.f.gov, '', SRC.combos);
    res.answer('Factored column load at the lowest level', cum, 'kips', 'Pu = ' + n(cum, 2) + ' kips  (' + (noRoof ? (a.floors === 0 ? 'no roof and no floors' : a.floors + ' floor' + (a.floors > 1 ? 's' : '') + ', no roof') : (a.floors === 0 ? 'roof only' : 'roof + ' + a.floors + ' floor' + (a.floors > 1 ? 's' : ''))) + (bot.f.g14 ? '; 1.4D governs: L is less than D/8' : '') + ')');
    res.flag('NOTE: member self-weight and live-load reduction are not included (her HW 6-17 has neither). Design each lift for the load at its own level (story lifts; a splice above B means BC and CD share one section).');
    return res;
  });

  // ---- loads_combinations (P1) ----
  // All 7 LRFD combinations of her week-1 slide (data/rules.js: load_combinations; line 3 is printed as 3a with L* and 3b with 0.5W).
  // A NEW standalone function: no other function's D / L handling is touched.  The student copies the governing value into a member
  // function with "already factored" ticked.
  //   (Lr or S or R) = the LARGEST of the three, and the step names which one.   Combinations 3, 4 and 6 use the TOWARD value of W / E.
  //   Combinations 5 and 7 SUBTRACT the reverse value when one is given, otherwise they add the toward value.  Every load is typed positive.
  def('loads_combinations', 'Loads', 'All 7 LRFD load combinations', 'Her week-1 slide lists seven LRFD combinations. This computes all of them (line 3 as 3a and 3b), names the one that governs, and shows the smallest total (net uplift). One unit for every load; type every number POSITIVE. Wind and earthquake: the value that pushes the member (toward) and, if there is one, the reverse (uplift / tension) value.', [
    F('D', 'number', 'Dead load D', '', { min: 0 }),
    F('L', 'number', 'Live load L (occupancy)', '', { min: 0 }),
    F('Lr', 'number', 'Roof live load Lr', '', { min: 0 }),
    F('S', 'number', 'Snow load S', '', { min: 0 }),
    F('R', 'number', 'Rain load R', '', { min: 0 }),
    F('W', 'number', 'Wind W, TOWARD -- the value that pushes the member (compression), typed as a positive number', '', {}),
    F('W_reverse', 'number', 'Wind W, REVERSE -- the uplift / tension value, typed as a POSITIVE number; leave empty if there is none', '', {}),
    F('E', 'number', 'Earthquake E, TOWARD -- the value that pushes the member (compression), typed as a positive number', '', {}),
    F('E_reverse', 'number', 'Earthquake E, REVERSE -- the uplift / tension value, typed as a POSITIVE number; leave empty if there is none', '', {}),
    F('L_star', 'number', 'L* -- 0.5 or 1.0 times L. 0.5 L is allowed when the occupancy live load is less than or equal to 100 psf, except garages and places of public assembly (those use 1.0 L). Both totals are always printed', '', { default: 0.5 }),
    F('unit', 'text', 'Unit to print -- kips, psf, k/ft ...', '', { default: 'kips' })
  ], function (a, res) {
    var data = DATA().rules && DATA().rules.load_combinations;
    if (!data || !data.lines || !data.lines.length) fail('INVALID', 'The load combinations are missing from data/rules.js (load_combinations).');
    var u = a.unit, ls = a.L_star, lsOther = Math.abs(ls - 0.5) < 1e-9 ? 1 : 0.5, WHAT = { W: 'Wind W, toward', W_reverse: 'Wind W, reverse', E: 'Earthquake E, toward', E_reverse: 'Earthquake E, reverse' };
    if (!(Math.abs(ls - 0.5) < 1e-9 || Math.abs(ls - 1) < 1e-9)) fail('INVALID', 'L* must be 0.5 L or 1.0 L (type 0.5 or 1). You typed: ' + ls + '.');
    ['W', 'W_reverse', 'E', 'E_reverse'].forEach(function (k) {
      if (isNum(a[k]) && a[k] < 0) fail('OUT_OF_RANGE', WHAT[k] + ' was typed NEGATIVE (' + n(a[k], 4) + '). Type every load as a POSITIVE number: the value that pushes the member goes in the toward box (W, E), the uplift / tension value goes in the reverse box (W_reverse, E_reverse), also positive. The tool applies the sign.');
    });
    var v = { D: a.D || 0, L: a.L || 0, Lr: a.Lr || 0, S: a.S || 0, R: a.R || 0, W: a.W || 0, E: a.E || 0 };
    var wRev = isNum(a.W_reverse) ? a.W_reverse : null, eRev = isNum(a.E_reverse) ? a.E_reverse : null;
    if (!(v.D || v.L || v.Lr || v.S || v.R || v.W || v.E || wRev || eRev)) fail('MISSING', 'Enter at least one load (D, L, Lr, S, R, W, E).');
    // (Lr or S or R) = the largest of the three; the step names which one
    var roofVal = Math.max(v.Lr, v.S, v.R), roofNames = [];
    ['Lr', 'S', 'R'].forEach(function (k) { if (roofVal > 0 && Math.abs(v[k] - roofVal) < 1e-12) roofNames.push(k); });
    var roofName = roofVal > 0 ? roofNames.join(' = ') : 'none';
    var given = ['D', 'L', 'Lr', 'S', 'R', 'W', 'E'].filter(function (k) { return v[k] > 0; }).map(function (k) { return k + ' = ' + n(v[k], 4); });
    if (wRev !== null) given.push('W reverse = ' + n(wRev, 4));
    if (eRev !== null) given.push('E reverse = ' + n(eRev, 4));
    res.step('Loads (service, in ' + u + '): ' + given.join(', ') + '.', SRC.given);
    res.step('(Lr or S or R) is the LARGEST of the three: Lr = ' + n(v.Lr, 4) + ', S = ' + n(v.S, 4) + ', R = ' + n(v.R, 4) + ' -> ' + (roofVal > 0 ? roofName + ' = ' + n(roofVal, 4) + ' is used in combinations 2, 3 and 4' : 'all zero, so that term is 0') + '. (The 0.2S in combination 6 is the snow load itself: ' + n(v.S, 4) + '.)', SRC.combos);
    res.step('L* = ' + fixed(ls, 1) + ' L = ' + fixed(ls, 1) + ' x ' + n(v.L, 4) + ' = ' + n(ls * v.L, 4) + ' ' + u + ' (the choice made). With L* = ' + fixed(lsOther, 1) + ' L it would be ' + n(lsOther * v.L, 4) + '. 0.5 L is allowed when the occupancy live load is less than or equal to 100 psf, except garages and places of public assembly.', SRC.combos);
    res.step('Wind: ' + (v.W > 0 || wRev !== null ? 'the TOWARD value W = ' + n(v.W, 4) + ' (pushes the member: compression) is added in combinations 3b and 4. ' + (wRev !== null ? 'A REVERSE value W = ' + n(wRev, 4) + ' (uplift / tension) was given, so combination 5 SUBTRACTS it: 0.9D + 1.0(-' + n(wRev, 4) + ').' : 'No reverse wind value was given, so combination 5 ADDS the toward value: 0.9D + 1.0(+' + n(v.W, 4) + '). If the wind can also pull the member (uplift), type the reverse value.') : 'no wind load was given.'), SRC.combos);
    res.step('Earthquake: ' + (v.E > 0 || eRev !== null ? 'the TOWARD value E = ' + n(v.E, 4) + ' is added in combination 6. ' + (eRev !== null ? 'A REVERSE value E = ' + n(eRev, 4) + ' was given, so combination 7 SUBTRACTS it: 0.9D + 1.0(-' + n(eRev, 4) + ').' : 'No reverse earthquake value was given, so combination 7 ADDS the toward value: 0.9D + 1.0(+' + n(v.E, 4) + ').') : 'no earthquake load was given.'), SRC.combos);
    function termValue(kind, lstar) {
      switch (kind) {
        case 'D': case 'L': case 'S': case 'W': case 'E': return v[kind];
        case 'ROOF': return roofVal;
        case 'LSTAR': return lstar * v.L;
        case 'W_OPP': return wRev !== null ? -wRev : v.W;
        case 'E_OPP': return eRev !== null ? -eRev : v.E;
      }
      fail('INVALID', 'Unknown load "' + kind + '" in the load combinations of data/rules.js.');
    }
    function evaluate(line, lstar) {
      var total = 0, parts = [], usesL = false;
      line.terms.forEach(function (tm) {
        var val = termValue(tm[0], lstar), k = tm[1];
        total += k * val;
        if (tm[0] === 'LSTAR') { usesL = true; parts.push(n(k * val, 4) + ' [L* = ' + n(lstar, 1) + ' x ' + n(v.L, 4) + ']'); }
        else parts.push(fixed(k, 1) + '(' + n(val, 4) + ')');
      });
      return { total: total, expr: parts.join(' + '), usesL: usesL };
    }
    var lines = data.lines.map(function (ln) {
      var main = evaluate(ln, ls), alt = evaluate(ln, lsOther);
      return { id: ln.id, text: ln.text, total: main.total, expr: main.expr, usesL: main.usesL, alt: alt.total, altExpr: alt.expr };
    });
    lines.forEach(function (ln) {
      res.step('Combination ' + ln.id + ':  U = ' + ln.text + '  =  ' + ln.expr + '  =  ' + n(ln.total, 4) + ' ' + u + (ln.usesL && v.L > 0 ? '   (with L* = ' + fixed(lsOther, 1) + ' L: ' + n(ln.alt, 4) + ')' : '') + '.', SRC.combos);
      res.val('U_' + ln.id, ln.total, u, SRC.combos);
      if (ln.usesL) res.val('U_' + ln.id + '_alt', ln.alt, u, SRC.combos);
    });
    function extreme(key, pickMax) {
      var best = null, ids = [];
      lines.forEach(function (ln) { if (best === null || (pickMax ? ln[key] > best : ln[key] < best)) best = ln[key]; });
      lines.forEach(function (ln) { if (Math.abs(ln[key] - best) < 1e-9) ids.push(ln.id); });
      return { value: best, ids: ids };
    }
    var hi = extreme('total', true), lo = extreme('total', false), hiAlt = extreme('alt', true);
    function lineText(id) { for (var i = 0; i < lines.length; i++) { if (lines[i].id === id) return lines[i].text; } return ''; }
    var hiTxt = 'combination ' + hi.ids.join(' and ') + ': ' + hi.ids.map(lineText).join('  /  ');
    var altTxt = v.L > 0 ? 'with L* = ' + fixed(lsOther, 1) + ' L: ' + n(hiAlt.value, 4) + ' ' + u + ' (combination ' + hiAlt.ids.join(' and ') + ')' : '';
    res.step('LARGEST total: ' + n(hi.value, 4) + ' ' + u + ' -- ' + hiTxt + ' (L* = ' + fixed(ls, 1) + ' L).' + (altTxt ? '  ' + altTxt + '.' : ''), SRC.combos);
    res.step('SMALLEST total: ' + n(lo.value, 4) + ' ' + u + ' -- combination ' + lo.ids.join(' and ') + ': ' + lo.ids.map(lineText).join('  /  ') + (lo.value < 0 ? '.  It is NEGATIVE: net uplift / tension reversal.' : '.  Not negative: no net uplift.'), SRC.combos);
    res.val('U_max', hi.value, u, SRC.combos).val('U_max_combination', hi.ids.join(' and '), '', SRC.combos).val('U_max_alt', hiAlt.value, u, SRC.combos).val('U_max_alt_combination', hiAlt.ids.join(' and '), '', SRC.combos);
    res.val('U_min', lo.value, u, SRC.combos).val('U_min_combination', lo.ids.join(' and '), '', SRC.combos).val('L_star', ls, '', SRC.combos).val('roof_term_used', roofName, '', SRC.combos).val('roof_term_value', roofVal, u, SRC.combos);
    res.table('All the combinations (her week-1 slide)', ['No.', 'Combination', 'With your numbers', 'Total, ' + u, 'Total with L* = ' + fixed(lsOther, 1) + ' L'],
      lines.map(function (ln) { return [ln.id, ln.text, ln.expr, Math.round(ln.total * 1e6) / 1e6, ln.usesL && v.L > 0 ? Math.round(ln.alt * 1e6) / 1e6 : '']; }));
    res.answer('Largest factored load U', hi.value, u, n(hi.value, 4) + ' ' + u + ' -- ' + hiTxt + ', L* = ' + fixed(ls, 1) + ' L' + (altTxt ? ';  ' + altTxt : '') + ';  smallest: ' + n(lo.value, 4) + ' ' + u + ' (combination ' + lo.ids.join(' and ') + ')' + (lo.value < 0 ? ', NET UPLIFT / TENSION REVERSAL' : ''));
    if (v.L > 0) res.alt('with L* = ' + fixed(lsOther, 1) + ' L', hiAlt.value, u, 'largest total ' + n(hiAlt.value, 4) + ' ' + u + ' (combination ' + hiAlt.ids.join(' and ') + ')');
    res.alt('smallest total (uplift check)', lo.value, u, n(lo.value, 4) + ' ' + u + ' (combination ' + lo.ids.join(' and ') + ')');
    if (lo.value < 0) res.flag('WARNING: the smallest total is NEGATIVE (' + n(lo.value, 4) + ' ' + u + ', combination ' + lo.ids.join(' and ') + '): net uplift / tension reversal. Check the member and its connection for tension.');
    if (v.L > 0) res.flag('NOTE: L* = ' + fixed(ls, 1) + ' L was used. 0.5 L is allowed when the occupancy live load is less than or equal to 100 psf, except garages and places of public assembly (those use 1.0 L). The other total is printed beside it.');
    if (v.W === 0 && wRev !== null) res.flag('NOTE: only a REVERSE wind value was given; the toward value is 0, so combinations 3b and 4 have no wind.');
    if (v.E === 0 && eRev !== null) res.flag('NOTE: only a REVERSE earthquake value was given; the toward value is 0, so combination 6 has no earthquake.');
    res.flag('NOTE: to design a member for this load, type the governing value (' + n(hi.value, 4) + ') as the load in the member section and tick "already factored". Nothing is factored again.');
    return res;
  });

  // ---- loads_max_service (G4): the reverse of 1.2D + 1.6L ----
  // A member's DESIGN strength phi Rn (typed from any capacity result) and the service dead load D give the largest service live load L.  With only D and L two of her
  // combinations count: 1)  U = 1.4D  and  2)  U = 1.2D + 1.6L, so the member must pass BOTH.  Solving 2) alone, L = (phi Rn - 1.2 D) / 1.6, is wrong when 1.2 D <= phi Rn < 1.4 D (a
  // POSITIVE L that the dead load alone has already used up); that case, and Lmax < 0, print "dead load alone exceeds the strength" and return NO live load.
  // Nothing about a beam span is computed here (in this function L is the live load, never a span).
  def('loads_max_service', 'Loads', 'Maximum service live load a member can carry', 'The reverse of the load combination: from a member\'s DESIGN strength phi Rn (phi already in it, typed from any capacity result) and the SERVICE dead load D, the largest service live load L. It solves 1.2D + 1.6L <= phi Rn for L and also checks 1.4D <= phi Rn: if the dead load alone is too much it says so and gives NO live load. One unit for all three (kips, or kip-ft for a moment). Only D and L are in it.', [
    F('phiRn', 'number', 'Design strength phi Rn (phi included: phi Pn in kips, phi Mn in kip-ft ...)', '', { required: true, min: 0, minExclusive: true }),
    F('D', 'number', 'Service dead load D (same unit as phi Rn; type 0 if none)', '', { required: true, min: 0 }),
    F('unit', 'text', 'Unit to print -- kips, kip-ft ...', '', { default: 'kips' })
  ], function (a, res) {
    var phi = a.phiRn, D = a.D, u = a.unit, c1 = 1.4 * D, c2d = 1.2 * D, tol = 1e-9 * Math.max(1, Math.abs(phi));
    res.step('Given: design strength phi Rn = ' + n(phi, 5) + ' ' + u + ' (phi is already in it) and service dead load D = ' + n(D, 5) + ' ' + u + '. The unknown is the live load L, as a SERVICE (unfactored) load.', SRC.given);
    res.step('With only D and L, two of her load combinations count:  1)  U = 1.4D   and   2)  U = 1.2D + 1.6L.  The member must pass BOTH:  1.4D <= phi Rn  and  1.2D + 1.6L <= phi Rn.', SRC.combos);
    if (c1 > phi + tol || c2d > phi + tol) {
      fail('OUT_OF_RANGE', 'No live load can be carried: the dead load alone exceeds the strength. ' + (c1 > phi + tol ? 'Combination 1 (dead load alone): 1.4 D = 1.4 (' + n(D, 5) + ') = ' + n(c1, 5) + ' ' + u + ' is MORE than phi Rn = ' + n(phi, 5) + ' ' + u + '.' : '') + (c2d > phi + tol ? ' Even with L = 0, combination 2 gives 1.2 D = ' + n(c2d, 5) + ' ' + u + ', more than phi Rn = ' + n(phi, 5) + ' ' + u + '.' : '') + ' So there is no allowed value of L, and no live load is given. Check phi Rn (a DESIGN strength, phi included) and D (service dead load, same unit): the member is too small for the dead load, or a number was mistyped.', [], { dead_load_alone_exceeds: true, phiRn: phi, D: D, combination_1_1_4D: c1 });
    }
    res.step('Combination 1, the dead load alone:  1.4 D = 1.4 (' + n(D, 5) + ') = ' + n(c1, 5) + ' ' + u + ' <= phi Rn = ' + n(phi, 5) + ' ' + u + ':  ok.', SRC.combos);
    var Lmax = (phi - 1.2 * D) / 1.6, back = c2d + 1.6 * Lmax;
    res.step('Combination 2 solved for L:  1.2D + 1.6L <= phi Rn   ->   L <= (phi Rn - 1.2 D) / 1.6 = (' + n(phi, 5) + ' - 1.2 (' + n(D, 5) + ')) / 1.6 = (' + n(phi, 5) + ' - ' + n(c2d, 5) + ') / 1.6 = ' + n(phi - c2d, 5) + ' / 1.6 = ' + n(Lmax, 5) + ' ' + u + '.', SRC.lrfd);
    res.step('Check:  1.2 (' + n(D, 5) + ') + 1.6 (' + n(Lmax, 5) + ') = ' + n(back, 5) + ' ' + u + ' = phi Rn (the member is exactly full), and 1.4 D = ' + n(c1, 5) + ' <= ' + n(phi, 5) + ' ok.', SRC.lrfd);
    res.val('phiRn', phi, u, SRC.given).val('D', D, u, SRC.given).val('L_max', Lmax, u, SRC.lrfd).val('U_combination_1', c1, u, SRC.combos).val('U_combination_2_at_L_max', back, u, SRC.lrfd);
    res.answer('Maximum service live load L', Lmax, u, 'L = (phi Rn - 1.2 D) / 1.6 = ' + n(Lmax, 5) + ' ' + u + '  (service, unfactored; 1.4 D = ' + n(c1, 5) + ' <= ' + n(phi, 5) + ' ' + u + ' ok)');
    res.flag('NOTE: only D and L are in this calculation (combinations 1 and 2, with the roof / snow / rain term 0). If the problem also has roof live, snow, rain, wind or earthquake load, the answer can be smaller: use Load combinations.');
    res.flag('NOTE: the answer is a SERVICE live load in the unit you typed. The member\'s own weight is dead load: put it in D if the problem includes it.');
    if (/(kip|k)[- ]?(ft|in)|(ft|in)[- ]?(kip|k)/i.test(String(u))) res.flag('NOTE: a moment: phi Rn is phi Mn and D must be the MOMENT the service dead load causes, in the same unit; the answer is a live-load MOMENT. For a simple span with a uniform load over the whole span, the uniform live load is w = 8 M / span^2 (M in kip-ft and the span in ft give k/ft; a moment in kip-in: divide by 12 first).');
    return res;
  });

  // =====================================================================================================
  // 8. BEAM  (compression flange fully braced, simple span)
  // =====================================================================================================

  // statics of a simple span: uniform w (k/ft) over the whole span + point loads [{ x ft, P kips }]
  function analyzeSimple(L, w, loads) {
    var P = loads.slice().sort(function (p, q) { return p.x - q.x; });
    var i, totalP = 0, mom = 0;
    for (i = 0; i < P.length; i++) { totalP += P[i].P; mom += P[i].P * P[i].x; }
    var Rb = (w * L * L / 2 + mom) / L;
    var Ra = w * L + totalP - Rb;
    function M(x) {
      var m = Ra * x - w * x * x / 2;
      for (var k = 0; k < P.length; k++) { if (P[k].x < x) m -= P[k].P * (x - P[k].x); }
      return m;
    }
    function Vr(x) { var v = Ra - w * x; for (var k = 0; k < P.length; k++) { if (P[k].x <= x + 1e-12) v -= P[k].P; } return v; }
    function Vl(x) { var v = Ra - w * x; for (var k = 0; k < P.length; k++) { if (P[k].x < x - 1e-12) v -= P[k].P; } return v; }
    var ev = [0], seen = { '0': true };
    for (i = 0; i < P.length; i++) { if (!seen[P[i].x] && P[i].x > 0 && P[i].x < L) { seen[P[i].x] = true; ev.push(P[i].x); } }
    ev.push(L);
    ev.sort(function (p, q) { return p - q; });
    var cands = ev.slice(), zero = [];
    if (w > 0) {
      for (i = 0; i < ev.length - 1; i++) {
        var va = Vr(ev[i]);
        if (va > 0) {
          var xz = Math.round((ev[i] + va / w) * 1e9) / 1e9;   // 1e-9 ft is far below anything that matters; it removes floating-point dust (12.000000000000034)
          if (xz > ev[i] + 1e-12 && xz < ev[i + 1] - 1e-12) { cands.push(xz); zero.push(xz); }
        }
      }
    }
    var best = -Infinity, xbest = 0, pts = [];
    for (i = 0; i < cands.length; i++) {
      var mm = M(cands[i]);
      pts.push({ x: cands[i], M: mm, Vleft: Vl(cands[i]), Vright: Vr(cands[i]), zero: zero.indexOf(cands[i]) >= 0 });
      if (mm > best + 1e-12) { best = mm; xbest = cands[i]; }
    }
    pts.sort(function (p, q) { return p.x - q.x; });
    var vmax = Math.max(Math.abs(Vr(0)), Math.abs(Vl(L)));
    for (i = 0; i < pts.length; i++) vmax = Math.max(vmax, Math.abs(pts[i].Vleft), Math.abs(pts[i].Vright));
    return { Ra: Ra, Rb: Rb, Mmax: best, xM: xbest, Vmax: vmax, points: pts, totalP: totalP, wL: w * L };
  }

  // statics of a CANTILEVER (P3): FIXED at the wall (x = 0), free at x = L.  A uniform w (k/ft) over the full length + point loads [{ x ft FROM THE WALL, P kips }].
  //   Mfix = w L^2 / 2 + sum P x   (hogging at the wall: tension on top; the design value is the absolute value),   Vfix = w L + sum P
  // M(x) and V(x) at a section x from the wall are carried by the part between x and the free end.
  function analyzeCantilever(L, w, loads) {
    var P = loads.slice().sort(function (p, q) { return p.x - q.x; }), i, k, totalP = 0, mom = 0;
    for (i = 0; i < P.length; i++) { totalP += P[i].P; mom += P[i].P * P[i].x; }
    var Mfix = w * L * L / 2 + mom, Vfix = w * L + totalP;
    function M(x) { var m = w * (L - x) * (L - x) / 2; for (k = 0; k < P.length; k++) { if (P[k].x > x + 1e-12) m += P[k].P * (P[k].x - x); } return m; }
    function Vwall(x) { var v = w * (L - x); for (k = 0; k < P.length; k++) { if (P[k].x >= x - 1e-12) v += P[k].P; } return v; }   // just on the wall side of x (includes a load at x)
    function Vfree(x) { var v = w * (L - x); for (k = 0; k < P.length; k++) { if (P[k].x > x + 1e-12) v += P[k].P; } return v; }      // just on the free-end side of x
    var ev = [0], seen = { '0': true };
    for (i = 0; i < P.length; i++) { if (!seen[P[i].x] && P[i].x > 0 && P[i].x < L) { seen[P[i].x] = true; ev.push(P[i].x); } }
    if (L > 0) ev.push(L);
    ev.sort(function (p, q) { return p - q; });
    var pts = ev.map(function (x) { return { x: x, M: M(x), Vwall: Vwall(x), Vfree: Vfree(x) }; });
    return { Mfix: Mfix, Mmax: Mfix, xM: 0, Vfix: Vfix, Vmax: Vfix, points: pts, totalP: totalP, wL: w * L };
  }

  // which Table 3-22 case is this?  (only the ones she uses: 1 uniform, 7 load at the center, 9 two equal symmetric loads)
  function matchCase(L, w, loads) {
    var P = loads.filter(function (p) { return p.P > 0; }).sort(function (p, q) { return p.x - q.x; });
    var tol = 1e-9 * Math.max(1, L);
    if (P.length === 0 && w > 0) return { id: 1, name: 'case 1, uniform load', formula: 'Mmax = w L^2 / 8' };
    if (P.length === 1 && w === 0 && Math.abs(P[0].x - L / 2) < tol) return { id: 7, name: 'case 7, load at the center', formula: 'Mmax = P L / 4' };
    if (P.length === 2 && w === 0 && Math.abs(P[0].P - P[1].P) < 1e-9 && Math.abs(P[0].x + P[1].x - L) < tol) return { id: 9, name: 'case 9, two equal loads placed symmetrically', formula: 'Mmax = P a' };
    if (P.length === 1 && w > 0 && Math.abs(P[0].x - L / 2) < tol) return { id: 'combo', name: 'case 1 + case 7 (superposition)', formula: 'Mmax = w L^2 / 8 + P L / 4 (both maxima are at mid-span)' };
    if (P.length === 2 && w > 0 && Math.abs(P[0].P - P[1].P) < 1e-9 && Math.abs(P[0].x + P[1].x - L) < tol) return { id: 'combo', name: 'case 1 + case 9 (superposition)', formula: 'Mmax = w L^2 / 8 + P a (both maxima are at mid-span)' };
    return null;
  }

  // loads from the arguments of beam_analysis -> factored model.  Writes the factoring steps.
  // P7-1: service loads are factored under BOTH combinations (1.4D, and 1.2D + 1.6L) and the WHOLE loading is analysed under each (never a factor per load).  The case with the larger
  // |Mu| governs the moment; P8-1: every other effect (RA, RB, Vu) is the larger of its two values and names its OWN combination (beamEnvelope).
  // ONE rule for factored, service and zero loads (S4, P7-R1, P8-3, P8-5):
  //   1. a typed ZERO in w_u or in a point Pu is ABSENT: never refused, never "a factored load", never a reason to drop the 1.4D case (a zero service value is absent too);
  //   2. the "already factored" box TICKED: a NONZERO service field (wD, wL, a point PD or PL) is AMBIGUOUS; with no nonzero factored load it is MISSING when nothing else was typed
  //      and AMBIGUOUS when a self-weight row was (the row is a dead load: x 1.2 alone would drop its 1.4D case);
  //   3. the box UNTICKED and a nonzero factored load (w_u, or a point row with Pu) together with service loads: COMPUTED as ONE case -- the factored loads as given, the service
  //      loads by 1.2D + 1.6L only (a 1.4D case that kept the factored loads and multiplied only the service ones by 1.4 would MIX combinations), the self-weight row x 1.2 -- and
  //      a NOTE names the mix (her class 9/23 example, factored points + a self-weight row, is this: 375.52).  ONE ROW with both a nonzero Pu and a nonzero PD / PL stays AMBIGUOUS;
  //   4. every load a service load: BOTH cases.
  // P8-6: on a cantilever the positions may be typed FROM THE FREE END (positions_from = free_end): converted here (x from the wall = L - x from the free end) and shown in a step.
  // Returns m: m.w / m.swF / m.loads are the case that governs Mu; m.combo carries both cases (null when ONE case was formed: nothing is compared); m.evalAt(W) is Mu with an extra
  // beam weight W (lb/ft, dead) under every case formed.
  function beamModel(a, res, cant) {
    var L = a.span_ft, fact = !!a.already_factored, i, pl = a.point_loads || [], fromFree = a.positions_from === 'free_end';
    if (fromFree && !cant) fail('AMBIGUOUS', 'Positions FROM THE FREE END (positions_from = free_end) are for a CANTILEVER, but the support is a simple span, which has no free end (its positions are measured from the LEFT support). Choose the cantilever support, or measure from the left support and leave positions_from empty. (Nothing was guessed.)');
    var wd = isNum(a.wD) ? a.wD : 0, wl = isNum(a.wL) ? a.wL : 0, wuReal = isNum(a.w_u) && a.w_u > 0, wuZero = isNum(a.w_u) && !wuReal, wu = wuReal ? a.w_u : 0;
    var svcUTyped = isNum(a.wD) || isNum(a.wL), svcUReal = wd > 0 || wl > 0;
    function puReal(q) { return isNum(q.Pu) && q.Pu > 0; }
    function svcReal(q) { return (isNum(q.D) && q.D > 0) || (isNum(q.L) && q.L > 0); }
    var puRows = [], svcRows = [];
    for (i = 0; i < pl.length; i++) { if (puReal(pl[i])) puRows.push(i + 1); else if (svcReal(pl[i])) svcRows.push(i + 1); }
    // P7-R1 + P8-5: only a REAL (nonzero) factored load makes it ONE case; neither the ticked box alone nor a typed 0 does.  The 1.4D case exists only when EVERY load is a service load.
    var anyFactored = wuReal || puRows.length > 0;
    var c12 = { id: '1.2D + 1.6L', fD: 1.2, w: 0, swF: 0, loads: [], steps: [] }, c14 = { id: '1.4D', fD: 1.4, w: 0, swF: 0, loads: [], steps: [] }, service = false;
    function both(text, src) { c12.steps.push([text, src]); c14.steps.push([text, src]); }
    if (wuZero) res.flag('NOTE: w_u = 0 is not a load (a typed zero counts as absent): it was not used, and it is not treated as a factored load.');
    if (fact) {
      // S4: a typed load is never dropped.  "already factored" with a NONZERO wD / wL typed is a contradiction, so it is refused (not flagged and ignored)
      if (svcUReal) fail('AMBIGUOUS', 'The box says factored, but service boxes are filled: you ticked "already factored" but also typed SERVICE loads wD / wL. A FACTORED uniform load goes in w_u; or untick "already factored" and type the service loads. (Nothing was dropped silently.)');
      c12.w = c14.w = wu;
      if (wuReal) both('Uniform load is already factored: wu = ' + n(wu, 4) + ' k/ft (NOT factored again).', SRC.lrfd);
    } else if (wuReal && svcUReal) {
      // rule 3: a factored uniform load beside service uniform loads: both are on the beam; ONE case
      c12.w = c14.w = wu + 1.2 * wd + 1.6 * wl;
      both('Uniform load wu = ' + n(wu, 4) + ' k/ft (given as factored).', SRC.lrfd);
      both('Service uniform loads beside it, factored by 1.2D + 1.6L only (a factored load is present, so there is no 1.4D case): 1.2 wD + 1.6 wL = 1.2 (' + n(wd, 4) + ') + 1.6 (' + n(wl, 4) + ') = ' + n(1.2 * wd + 1.6 * wl, 4) + ' k/ft.  Uniform load in all: ' + n(wu, 4) + ' + ' + n(1.2 * wd + 1.6 * wl, 4) + ' = ' + n(c12.w, 4) + ' k/ft.', SRC.lrfd);
    } else if (wuReal) {
      res.flag('NOTE: only wu was given, so it is used as the FACTORED uniform load.');
      c12.w = c14.w = wu;
      both('Uniform load wu = ' + n(wu, 4) + ' k/ft (given as factored).', SRC.lrfd);
    } else {
      c12.w = 1.2 * wd + 1.6 * wl; c14.w = 1.4 * wd;
      if (svcUTyped) {
        service = true;
        c12.steps.push(['Service loads -> factored: wu = 1.2 wD + 1.6 wL = 1.2 (' + n(wd, 4) + ') + 1.6 (' + n(wl, 4) + ') = ' + n(c12.w, 4) + ' k/ft.', SRC.lrfd]);
        c14.steps.push(['Service loads -> factored (the 1.4D combination): wu = 1.4 wD = 1.4 (' + n(wd, 4) + ') = ' + n(c14.w, 4) + ' k/ft (the live load is not in this combination).', SRC.lrfd]);
      }
    }
    var swPlf = isNum(a.self_weight_plf) ? a.self_weight_plf : 0;
    if (swPlf > 0) {
      if (a.w_includes_self_weight) {
        res.flag('WARNING: a self-weight of ' + n(swPlf, 3) + ' lb/ft was entered but you also said the uniform load ALREADY includes the beam weight -- the self-weight row was NOT added (it would count twice).');
        swPlf = 0;
      } else if (anyFactored) {
        // P7-R1: some load is already factored: ONE case, the self-weight row x 1.2 (untouched, as before P7)
        c12.swF = c14.swF = 1.2 * swPlf / 1000;
        both('Self-weight is its own row and is DEAD load: 1.2 x ' + n(swPlf, 3) + ' lb/ft / 1000 = ' + n(c12.swF, 5) + ' k/ft.', 'Her rule: self-weight is dead load');
      } else {
        service = true;
        c12.swF = 1.2 * swPlf / 1000; c14.swF = 1.4 * swPlf / 1000;
        c12.steps.push(['Self-weight is its own row and is DEAD load: 1.2 x ' + n(swPlf, 3) + ' lb/ft / 1000 = ' + n(c12.swF, 5) + ' k/ft.', 'Her rule: self-weight is dead load']);
        c14.steps.push(['Self-weight is its own row and is DEAD load: 1.4 x ' + n(swPlf, 3) + ' lb/ft / 1000 = ' + n(c14.swF, 5) + ' k/ft (the 1.4D combination).', 'Her rule: self-weight is dead load']);
      }
    }
    var conv = [];
    for (i = 0; i < pl.length; i++) {
      var p = pl[i], x = p.x, P12, P14, hasPu = puReal(p), puZero = isNum(p.Pu) && !hasPu, svcTyped = isNum(p.D) || isNum(p.L), hasSvc = svcReal(p);
      // rule 1: a row whose only load entry is Pu = 0 is ABSENT: skipped, never refused, never "factored" (its position is not checked either)
      if (puZero && (fact ? !hasSvc : !svcTyped)) { res.flag('NOTE: point load ' + (i + 1) + ' has Pu = 0: a typed zero is not a load, so the row was skipped (it is never treated as a factored load).'); continue; }
      if (cant) {
        if (fromFree) {
          if (x > L + 1e-9) fail('OUT_OF_RANGE', 'Point load ' + (i + 1) + ' is ' + n(x, 3) + ' ft FROM THE FREE END, which is past the WALL of the ' + n(L, 3) + ' ft cantilever (a position FROM THE FREE END is between 0 and ' + n(L, 3) + ' ft).');
          x = Math.max(0, Math.round((L - p.x) * 1e9) / 1e9);   // 1e-9 ft removes floating-point dust (12.3 - 3.1 = 9.200000000000001)
          conv.push('point load ' + (i + 1) + ': ' + n(p.x, 3) + ' ft FROM THE FREE END = ' + n(x, 3) + ' ft FROM THE WALL (' + n(L, 3) + ' - ' + n(p.x, 3) + ')');
        } else if (x > L + 1e-9) fail('OUT_OF_RANGE', 'Point load ' + (i + 1) + ' is ' + n(p.x, 3) + ' ft FROM THE WALL, which is past the free end of the ' + n(L, 3) + ' ft cantilever (a position is the distance FROM THE WALL, between 0 and ' + n(L, 3) + ' ft). If the problem measures from the FREE end, use L - distance.');
        if (x <= 1e-9) res.flag('CHECK: point load ' + (i + 1) + ' is at x = 0, AT THE WALL: it goes straight into the wall, no moment. Check the position (every position is measured FROM THE WALL).');
      } else {
        if (p.x > L + 1e-9) fail('OUT_OF_RANGE', 'Point load ' + (i + 1) + ' is at x = ' + n(p.x, 3) + ' ft, which is past the end of the ' + n(L, 3) + ' ft span (a position must be between 0 and the span).');
        if (p.x <= 1e-9 || p.x >= L - 1e-9) res.flag('CHECK: point load ' + (i + 1) + ' is at x = ' + n(p.x, 3) + ' ft, exactly over a support: it goes straight into the support, no moment in the beam. Check the position.');
      }
      if (fact) {
        if (hasSvc) fail('AMBIGUOUS', 'The box says factored, but service boxes are filled: point load ' + (i + 1) + ' has service PD / PL typed but "already factored" is ticked. Enter the factored load in Pu, or untick "already factored" and type PD / PL. (Nothing was dropped silently.)');
        if (!hasPu) fail('MISSING', 'Point load ' + (i + 1) + ': enter the factored load Pu (the "already factored" box is ticked).');
        P12 = P14 = p.Pu;
      } else {
        if (hasPu && hasSvc) fail('AMBIGUOUS', 'Point load ' + (i + 1) + ' has a factored Pu AND service PD / PL in the SAME row: one load cannot be both. Clear PD / PL to use Pu as given, or clear Pu to factor PD and PL; two different loads at the same position go in two rows.');
        if (hasPu) { P12 = P14 = p.Pu; res.flag('NOTE: point load ' + (i + 1) + ' has only Pu, used as FACTORED.'); }
        else if (!svcTyped) fail('MISSING', 'Point load ' + (i + 1) + ': enter PD and/or PL (service), or tick "already factored" and enter Pu.');
        else {
          if (puZero) res.flag('NOTE: point load ' + (i + 1) + ': Pu = 0 is not a load (a typed zero counts as absent); the service PD / PL were used.');
          service = true;
          P12 = 1.2 * (p.D || 0) + 1.6 * (p.L || 0); P14 = 1.4 * (p.D || 0);
          c12.steps.push(['Point load ' + (i + 1) + ' at x = ' + n(x, 3) + ' ft' + (cant ? ' FROM THE WALL' : '') + ': Pu = 1.2 (' + n(p.D || 0, 3) + ') + 1.6 (' + n(p.L || 0, 3) + ') = ' + n(P12, 3) + ' kips.', SRC.lrfd]);
          c14.steps.push(['Point load ' + (i + 1) + ' at x = ' + n(x, 3) + ' ft' + (cant ? ' FROM THE WALL' : '') + ': Pu = 1.4 (' + n(p.D || 0, 3) + ') = ' + n(P14, 3) + ' kips (the 1.4D combination).', SRC.lrfd]);
        }
      }
      c12.loads.push({ x: x, P: P12, row: i + 1 }); c14.loads.push({ x: x, P: P14, row: i + 1 });
    }
    if (conv.length) res.step('The point-load positions were typed FROM THE FREE END. Converted to distances FROM THE WALL (the fixed end): position from the wall = L - position from the free end.  ' + conv.join(';  ') + '.', SRC.statics);
    if (anyFactored) {
      // rule 3: a factored load is present, so ONE case (1.2D + 1.6L).  When service loads are mixed in, the NOTE names which loads were which
      if (!fact) {
        var facParts = [], svcParts = [];
        if (wuReal) facParts.push('the uniform load wu');
        if (puRows.length) facParts.push('point load' + (puRows.length > 1 ? 's ' : ' ') + puRows.join(', ') + ' (Pu)');
        if (svcUReal) svcParts.push('the uniform wD / wL');
        if (svcRows.length) svcParts.push('point load' + (svcRows.length > 1 ? 's ' : ' ') + svcRows.join(', ') + ' (PD / PL)');
        if (swPlf > 0) svcParts.push('the beam self-weight row');
        if (svcParts.length) res.flag('NOTE: this loading MIXES loads typed already FACTORED (' + facParts.join(' and ') + ') with SERVICE loads (' + svcParts.join(', ') + '): ONE combination was formed -- the factored loads as given, the service loads x 1.2 (dead) and x 1.6 (live), the beam self-weight x 1.2. There is no 1.4D case: the 1.4D comparison needs every load as a SERVICE load.');
      }
      service = false;
    }
    if (c12.w === 0 && c12.swF === 0 && c12.loads.length === 0) fail('MISSING', fact ? 'No loads: "already factored" is ticked, so the FACTORED uniform load goes in w_u (k/ft) and each factored point load in Pu. The boxes wD / wL are for SERVICE loads (untick "already factored" to use them).' : 'No loads: enter a uniform load and/or at least one point load.');
    // rule 2: "already factored" is a CLAIM that a factored load was typed.  With none, all that is left here is a self-weight row: a dead load the tool factors itself.  Factoring it
    // x 1.2 under the box would silently drop its 1.4D case, so it is refused
    if (fact && !anyFactored) fail('AMBIGUOUS', 'The box says factored, but no factored load was entered: "already factored" is ticked and the only load is the beam self-weight row, which is a DEAD load the tool factors itself. Enter the factored uniform load w_u (k/ft) and / or a factored point load Pu (kips), or untick "already factored" (the self-weight alone is then checked under 1.4D and 1.2D + 1.6L). (Nothing was guessed.)');
    // the whole loading under each case; the larger |Mu| governs (1.2D + 1.6L wins a tie: it is the usual one)
    function analyse(c, extra) { return cant ? analyzeCantilever(L, c.w + c.swF + (extra || 0), c.loads) : analyzeSimple(L, c.w + c.swF + (extra || 0), c.loads); }
    var gov = c12, combo = null, r12 = null, r14 = null;
    if (service) {
      r12 = analyse(c12); r14 = analyse(c14);
      var g14 = r14.Mmax > r12.Mmax + 1e-9 * Math.max(1, r12.Mmax);
      gov = g14 ? c14 : c12;
      combo = { g14: g14, gov: gov.id, Mu14: r14.Mmax, Mu12: r12.Mmax, r14: r14, r12: r12, other: g14 ? c12 : c14, rOther: g14 ? r12 : r14, rGov: g14 ? r14 : r12,
        text: 'Load combinations (ASCE 7; her slide: 1.4D and 1.2D + 1.6L): the WHOLE loading is analysed under each, never mixing factors per load.  1.4D gives Mu = ' + n(r14.Mmax, 4) + ' kip-ft;  1.2D + 1.6L gives Mu = ' + n(r12.Mmax, 4) + ' kip-ft  ->  ' + (g14 ? '1.4D governs (the live load is small next to the dead load)' : '1.2D + 1.6L governs') + '.  The steps above are for that case.' };
    }
    gov.steps.forEach(function (st) { res.step(st[0], st[1]); });
    var cases = service ? [c12, c14] : [c12];
    function evalAt(W) {
      var best = null;
      cases.forEach(function (c) { var r = analyse(c, c.fD * W / 1000); if (!best || r.Mmax > best.M + 1e-12) best = { M: r.Mmax, c: c, r: r }; });
      return best;
    }
    return { L: L, w: gov.w, swF: gov.swF, swPlf: swPlf, loads: gov.loads, fact: fact, combo: combo, cases: cases, gov: gov, evalAt: evalAt, fromFree: fromFree };
  }

  // P8-1: every EFFECT of a beam is the ENVELOPE over the cases formed.  A beam whose dead load sits near one support and whose live load sits elsewhere has its moment, its left
  // reaction, its right reaction and its shear governed by DIFFERENT combinations (a total L >= D/8 does not make 1.2D + 1.6L govern them all), so each effect is the larger of its
  // value under 1.4D and under 1.2D + 1.6L and names its OWN combination.  A tie (the two values equal within 1e-9, the tolerance of the Mu comparison in beamModel) names the
  // combination that governs Mu, so a reaction is said to come from "the other combination" only when that combination really gives MORE; Mu itself names 1.2D + 1.6L on a tie.
  // null when only ONE case was formed (a factored load is present): nothing is compared and nothing changes.
  function beamEnvelope(m, cant) {
    if (!m.combo) return null;
    var r12 = m.combo.r12, r14 = m.combo.r14, govId = m.combo.gov;
    function pick(v14, v12, onTie) {
      var id = v14 > v12 + 1e-9 * Math.max(1, Math.abs(v12)) ? '1.4D' : (v12 > v14 + 1e-9 * Math.max(1, Math.abs(v14)) ? '1.2D + 1.6L' : onTie);
      return { v: Math.max(v14, v12), id: id, v14: v14, v12: v12 };
    }
    var eff = { Mu: pick(r14.Mmax, r12.Mmax, '1.2D + 1.6L'), Vu: pick(r14.Vmax, r12.Vmax, govId) };
    if (!cant) { eff.RA = pick(r14.Ra, r12.Ra, govId); eff.RB = pick(r14.Rb, r12.Rb, govId); }
    eff.mixed = ['Vu', 'RA', 'RB'].some(function (q) { return eff[q] && eff[q].id !== govId; });   // then the numbers are an envelope and NOT one free-body diagram: said in the headline and in a CHECK
    return eff;
  }

  // the rows of the envelope: [key, label, unit, decimals]
  function beamEffectRows(cant) {
    return cant ? [['Mu', 'Mu at the wall', 'kip-ft', 2], ['Vu', 'Vu = the wall reaction', 'kips', 3]] : [['Mu', 'Mu', 'kip-ft', 2], ['RA', 'RA', 'kips', 3], ['RB', 'RB', 'kips', 3], ['Vu', 'Vu', 'kips', 3]];
  }

  // P8-1: the statics of the combination that does NOT govern Mu, written out when it governs a reaction or the shear (so the number in the headline can be shown on paper)
  function beamOtherCaseText(L, c, r, cant, names) {
    var w = c.w + c.swF, parts = [], terms = [];
    var pts = c.loads.filter(function (q) { return q.P > 0; });
    if (w > 0) { parts.push('uniform wu = ' + n(w, 4) + ' k/ft'); terms.push('wu L^2/2 = ' + n(w * L * L / 2, 3)); }
    if (pts.length) parts.push('point load' + (pts.length > 1 ? 's ' : ' ') + pts.map(function (q) { return n(q.P, 3) + ' kips at ' + n(q.x, 3) + ' ft' + (cant ? ' FROM THE WALL' : ''); }).join(', '));
    pts.forEach(function (q) { terms.push(n(q.P, 3) + ' x ' + n(q.x, 3)); });
    var head = 'The OTHER combination, ' + c.id + ', governs ' + names.join(' and ') + '.  Its factored loads (' + (c.fD === 1.4 ? 'every dead load x 1.4, no live load' : 'dead x 1.2, live x 1.6') + '): ' + (parts.length ? parts.join('; ') : 'none') + '.  ';
    if (cant) return head + 'Vu at the wall = wu L + sum Pu = ' + n(w * L, 3) + ' + ' + n(r.totalP, 3) + ' = ' + n(r.Vfix, 3) + ' kips.';
    return head + 'RB = (' + (terms.length ? terms.join(' + ') : '0') + ') / ' + n(L, 3) + ' = ' + n(r.Rb, 3) + ' kips;   RA = total load - RB = ' + n(w * L + r.totalP, 3) + ' - ' + n(r.Rb, 3) + ' = ' + n(r.Ra, 3) + ' kips.';
  }

  // P8-1: the values, the steps and the CHECK of a beam that formed both cases (shared by the simple span and the cantilever).  RA, RB, Vu (and R_wall) are the ENVELOPE values;
  // the values of the combination that governs Mu (the statics steps) keep explicit names (..._at_Mu_combination).
  function beamEnvelopeOut(res, m, cant, eff) {
    if (!eff) return;
    var cb = m.combo, rg = cb.rGov, rows = beamEffectRows(cant);
    res.val('Mu_1_4D', cb.Mu14, 'kip-ft', SRC.combos).val('Mu_1_2D_1_6L', cb.Mu12, 'kip-ft', SRC.combos).val('governing_combination', cb.gov, '', SRC.combos);
    res.val('Vu_at_Mu_combination', rg.Vmax, 'kips', SRC.statics);
    if (cant) res.val('R_wall_at_Mu_combination', rg.Vfix, 'kips', SRC.statics);
    else res.val('RA_at_Mu_combination', rg.Ra, 'kips', SRC.statics).val('RB_at_Mu_combination', rg.Rb, 'kips', SRC.statics);
    res.val('Vu_governing_combination', eff.Vu.id, '', SRC.combos);
    if (cant) res.val('R_wall_governing_combination', eff.Vu.id, '', SRC.combos);
    else res.val('RA_governing_combination', eff.RA.id, '', SRC.combos).val('RB_governing_combination', eff.RB.id, '', SRC.combos);
    // the names of P7: the same numbers as Vu / RA / RB now
    res.val('Vu_max_both_combinations', eff.Vu.v, 'kips', SRC.combos);
    if (!cant) res.val('RA_max_both_combinations', eff.RA.v, 'kips', SRC.combos).val('RB_max_both_combinations', eff.RB.v, 'kips', SRC.combos);
    var diff = rows.filter(function (o) { return o[0] !== 'Mu' && eff[o[0]].id !== cb.gov; });
    if (diff.length) res.step(beamOtherCaseText(m.L, cb.other, cb.rOther, cant, diff.map(function (o) { return o[1]; })), SRC.statics);
    res.step('ENVELOPE over the two combinations -- each effect is the LARGER of its two values and names its own combination:  ' + rows.map(function (o) { var e = eff[o[0]]; return o[1] + ' = max(1.4D ' + n(e.v14, o[3]) + ', 1.2D + 1.6L ' + n(e.v12, o[3]) + ') = ' + n(e.v, o[3]) + ' ' + o[2] + ' (' + e.id + ')'; }).join(';  ') + '.', SRC.combos);
    if (diff.length) res.flag('CHECK: ENVELOPE -- NOT one free-body diagram. ' + diff.map(function (o) { var e = eff[o[0]]; return o[1] + ' = ' + n(e.v, 3) + ' kips comes from ' + e.id + ' (' + cb.gov + ' gives ' + n(e.id === '1.4D' ? e.v12 : e.v14, 3) + ' kips)'; }).join('; ') + '; Mu comes from ' + cb.gov + '. Each number is the largest value of that effect over the two combinations' + (cant ? '' : ' (RA + RB is not the total load of either combination)') + ': use them for the shear and for a reaction that loads another member. The values of ' + cb.gov + ' ALONE are in the statics steps and under "Every quantity used" (' + (cant ? 'R_wall_at_Mu_combination' : 'RA_at_Mu_combination, RB_at_Mu_combination') + ', Vu_at_Mu_combination).');
  }

  // the table of the envelope (added after the critical-points table, which stays the first table)
  function beamEnvelopeTable(res, cant, eff) {
    if (!eff) return;
    res.table('Envelope over the two combinations', ['Effect', '1.4D', '1.2D + 1.6L', 'Envelope (the larger)', 'Governing combination'],
      beamEffectRows(cant).map(function (o) { var e = eff[o[0]]; return [o[1] + ', ' + o[2], Math.round(e.v14 * 1000) / 1000, Math.round(e.v12 * 1000) / 1000, Math.round(e.v * 1000) / 1000, e.id]; }));
  }

  var PRESETS = [
    { value: 'midspan', label: 'one load at mid-span' },
    { value: 'thirds', label: 'two equal loads at the third points' },
    { value: 'symmetric', label: 'two equal loads, each a distance a from its support' }
  ];
  function presetPositions(preset, L, a) {
    if (preset === 'midspan') return [L / 2];
    if (preset === 'thirds') return [L / 3, 2 * L / 3];
    if (preset === 'symmetric') return [a, L - a];
    return [];
  }

  // the CANTILEVER path of beam_analysis (P3).  Every position is the distance FROM THE WALL; the steps echo it.  P8-6: positions typed FROM THE FREE END (positions_from = free_end)
  // are converted in beamModel, which shows the conversion; everything after it is FROM THE WALL.
  function cantileverAnalysis(a, res) {
    var fromFree = a.positions_from === 'free_end';
    res.step('CANTILEVER: fixed (built in) at the WALL, x = 0, and free at x = ' + n(a.span_ft, 3) + ' ft. ' + (fromFree ? 'The point-load positions were typed FROM THE FREE END: they are converted first, and EVERY position below is measured FROM THE WALL.' : 'EVERY position below is measured FROM THE WALL.'), SRC.statics);
    var m = beamModel(a, res, true), L = m.L, wTot = m.w + m.swF, r = analyzeCantilever(L, wTot, m.loads), i;
    if (wTot > 0) res.step('Uniform load wu = ' + n(wTot, 4) + ' k/ft over the full ' + n(L, 3) + ' ft' + (m.swF > 0 ? ' (the self-weight row included)' : '') + ': its resultant wu L = ' + n(wTot * L, 3) + ' kips acts L/2 = ' + n(L / 2, 3) + ' ft from the wall.', SRC.statics);
    m.loads.forEach(function (p, k) { res.step('Point load ' + (p.row || k + 1) + ': Pu = ' + n(p.P, 3) + ' kips at ' + n(p.x, 3) + ' ft FROM THE WALL (= ' + n(L - p.x, 3) + ' ft from the free end).', SRC.statics); });
    var sym = [], num = [];
    if (wTot > 0) { sym.push('wu (' + n(L, 3) + ')^2 / 2'); num.push(n(wTot * L * L / 2, 3)); }
    m.loads.forEach(function (p) { sym.push(n(p.P, 3) + ' (' + n(p.x, 3) + ')'); num.push(n(p.P * p.x, 3)); });
    res.step('The maximum moment is at the WALL (hogging, tension on top): Mu = wu L^2/2 + sum Pu x = ' + (wTot > 0 ? n(wTot, 4) + ' ' : '') + sym.join(' + ').replace(/^wu /, wTot > 0 ? '' : 'wu ') + ' = ' + num.join(' + ') + ' = ' + n(r.Mfix, 2) + ' kip-ft.  The design value is the absolute value; the moment is NEGATIVE: M = -' + n(r.Mfix, 2) + ' kip-ft.', SRC.statics);
    res.step('Vu at the wall = wu L + sum Pu = ' + n(wTot * L, 3) + ' + ' + n(r.totalP, 3) + ' = ' + n(r.Vfix, 3) + ' kips (the wall reaction' + (m.combo ? ' for ' + m.combo.gov + ', the combination that governs Mu' : '') + ').', SRC.statics);
    if (m.combo) res.step(m.combo.text, SRC.combos);
    var eff = beamEnvelope(m, true), VuE = eff ? eff.Vu.v : r.Vfix;   // P8-1: Vu and the wall reaction are the ENVELOPE over the cases formed
    res.val('Mu', r.Mfix, 'kip-ft', SRC.statics).val('Mu_signed', -r.Mfix, 'kip-ft', SRC.statics).val('x_Mu', 0, 'ft FROM THE WALL', SRC.statics).val('Vu', VuE, 'kips', SRC.statics).val('R_wall', VuE, 'kips', SRC.statics).val('M_wall_reaction', r.Mfix, 'kip-ft', SRC.statics);
    res.val('span', L, 'ft').val('self_weight_factored', m.swF, 'k/ft').val('support', 'cantilever', '');
    if (fromFree) res.val('positions_from', 'FROM THE FREE END (converted to FROM THE WALL)', '', SRC.given);
    beamEnvelopeOut(res, m, true, eff);
    if (wTot > 0) res.val('w_total', wTot, 'k/ft', SRC.lrfd);
    res.answer('Maximum factored moment Mu (cantilever, at the wall)', r.Mfix, 'kip-ft', eff
      ? 'Mu = ' + n(r.Mfix, 2) + ' kip-ft (' + eff.Mu.id + ') at the WALL (hogging: M = -' + n(r.Mfix, 2) + ', design on the absolute value); Vu = ' + n(eff.Vu.v, 3) + ' (' + eff.Vu.id + ') -- shear in kips' + (eff.mixed ? '; an ENVELOPE, each from its own combination (NOT one free-body diagram)' : '')
      : 'Mu = ' + n(r.Mfix, 2) + ' kip-ft at the WALL (hogging: M = -' + n(r.Mfix, 2) + ', design on the absolute value);  Vu = ' + n(r.Vfix, 3) + ' kips');
    res.table('Shear and moment from the WALL' + (eff ? ' -- ' + m.combo.gov + ' (the combination that governs Mu)' : ''), ['x from the wall, ft', 'V wall side, kips', 'V free-end side, kips', '|M|, kip-ft', 'note'],
      r.points.map(function (p) { return [Math.round(p.x * 1000) / 1000, Math.round(p.Vwall * 1000) / 1000, Math.round(p.Vfree * 1000) / 1000, Math.round(p.M * 1000) / 1000, p.x === 0 ? 'WALL (fixed end): maximum' : (p.x === L ? 'free end' : 'point load')]; }));
    beamEnvelopeTable(res, true, eff);
    if (fromFree) res.flag('NOTE: CANTILEVER: the point-load positions were typed FROM THE FREE END and converted to distances FROM THE WALL (the fixed end): position from the wall = ' + n(L, 3) + ' - the distance from the free end. Check that the problem really measures from the free end.');
    else res.flag('NOTE: CANTILEVER: every position was taken as the distance FROM THE WALL (the fixed end), as typed. If the problem measures from the FREE end, convert first: position from the wall = ' + n(L, 3) + ' - the distance from the free end. Or choose positions FROM THE FREE END (positions_from = free_end) and the tool converts them.');
    res.flag('NOTE: Table 3-2 is in kip-ft. If a problem gives kip-in, divide by 12 (Lookup > Units).');
    if (m.fact) res.flag('NOTE: loads were taken as already factored; nothing was multiplied by 1.2 / 1.6 except the self-weight row.');
    return res;
  }

  def('beam_analysis', 'Beam', 'Simple span or cantilever: reactions and maximum moment', 'Any uniform load plus any number of point loads on a simple span (default) or on a CANTILEVER (support = cantilever: fixed at the wall, free at the other end, EVERY position measured FROM THE WALL unless positions_from says FROM THE FREE END). Simple span: reactions by statics, Mmax from the moment at every point load and at the zero-shear point. Cantilever: Mu = wu L^2/2 + sum Pu x at the wall (hogging; the absolute value is designed) and Vu = wu L + sum Pu. Loads are SERVICE loads unless the box says factored. With service loads the WHOLE loading is analysed under 1.4D and under 1.2D + 1.6L and EVERY effect (Mu, RA, RB, Vu) is the larger of its two values, each naming its own governing combination (an ENVELOPE, not one free-body diagram); a factored load (w_u or a point Pu, not 0) in the loading gives ONE case, 1.2D + 1.6L: the service loads x 1.2 / 1.6, the beam weight x 1.2. A typed 0 is not a load.', [
    F('span_ft', 'dimension', 'Span L (a cantilever: the length from the WALL to the free end)', 'ft', { required: true, min: 0, minExclusive: true }),
    F('support', 'select', 'Support: a simple span (pin at x = 0, roller at x = L) or a CANTILEVER (FIXED at the WALL, x = 0, free at x = L; EVERY position below is then measured FROM THE WALL)', '', { default: 'simple', values: [{ value: 'simple', label: 'simple span' }, { value: 'cantilever', label: 'cantilever (fixed at the wall)' }] }),
    F('positions_from', 'select', 'CANTILEVER only -- the point-load positions are measured FROM THE WALL (the fixed end; the default) or FROM THE FREE END (the tool converts: position from the wall = L - position from the free end, and shows it)', '', { default: 'wall', values: [{ value: 'wall', label: 'FROM THE WALL (the fixed end)' }, { value: 'free_end', label: 'FROM THE FREE END' }] }),
    F('already_factored', 'boolean', 'The loads below are ALREADY FACTORED (the problem says factored)', '', { default: false }),
    F('wD', 'number', 'Uniform DEAD load wD (service)', 'k/ft', { min: 0 }),
    F('wL', 'number', 'Uniform LIVE load wL (service)', 'k/ft', { min: 0 }),
    F('w_u', 'number', 'Uniform load that is already factored, wu', 'k/ft', { min: 0 }),
    F('self_weight_plf', 'number', 'Beam self-weight (its own row; DEAD load: x 1.2, or x 1.4 when the 1.4D combination governs)', 'lb/ft', { min: 0 }),
    F('w_includes_self_weight', 'boolean', 'The uniform load above ALREADY includes the beam weight (never add it twice)', '', { default: false }),
    F('point_loads', 'list', 'Point loads', '', {
      item: [F('x', 'number', 'position: from the LEFT support (simple span), or FROM THE WALL = the fixed end (cantilever; FROM THE FREE END when positions_from says so)', 'ft', { required: true, min: 0 }), F('D', 'number', 'dead PD (service)', 'kips', { min: 0 }),
        F('L', 'number', 'live PL (service)', 'kips', { min: 0 }), F('Pu', 'number', 'factored Pu', 'kips', { min: 0 })]
    })
  ], function (a, res) {
    if (a.support === 'cantilever') return cantileverAnalysis(a, res);
    var m = beamModel(a, res), L = m.L, wTot = m.w + m.swF, r = analyzeSimple(L, wTot, m.loads), i;
    if (wTot > 0) res.val('w_total', wTot, 'k/ft', SRC.lrfd);
    res.step('Reactions by statics' + (m.combo ? ' for ' + m.combo.gov + ' (the combination that governs Mu)' : '') + ' (sum of moments about each support):', SRC.statics);
    var rbTerms = [];
    if (wTot > 0) rbTerms.push('wu L^2/2 = ' + n(wTot * L * L / 2, 3));
    m.loads.forEach(function (p) { rbTerms.push(n(p.P, 3) + ' x ' + n(p.x, 3)); });
    res.step('  RB = (' + rbTerms.join(' + ') + ') / ' + n(L, 3) + ' = ' + n(r.Rb, 3) + ' kips;   RA = total load - RB = ' + n(wTot * L + r.totalP, 3) + ' - ' + n(r.Rb, 3) + ' = ' + n(r.Ra, 3) + ' kips.', SRC.statics);
    var mc = matchCase(L, wTot, m.loads), pos = m.loads.filter(function (p) { return p.P > 0; });   // matchCase() looks at the loads that are not zero: so must the formula text
    if (mc) {
      var calc;
      if (mc.id === 1) calc = n(wTot, 4) + ' x ' + n(L, 3) + '^2 / 8';
      else if (mc.id === 7) calc = n(pos[0].P, 3) + ' x ' + n(L, 3) + ' / 4';
      else if (mc.id === 9) calc = n(pos[0].P, 3) + ' x ' + n(Math.min(pos[0].x, pos[1].x), 3);
      else {
        var big = pos.length === 1 ? n(pos[0].P, 3) + ' x ' + n(L, 3) + ' / 4' : n(pos[0].P, 3) + ' x ' + n(Math.min(pos[0].x, pos[1].x), 3);
        calc = n(wTot, 4) + ' x ' + n(L, 3) + '^2 / 8 + ' + big;
      }
      res.step('This is Table 3-22 ' + mc.name + ': ' + mc.formula + ' = ' + calc + ' = ' + n(r.Mmax, 2) + ' kip-ft, at x = ' + n(r.xM, 3) + ' ft.', SRC.t322);
    } else {
      res.step('General loading (not a single Table 3-22 case): the maximum moment is at a point load or where the shear is zero. Check the moment at each.', SRC.statics);
      for (i = 0; i < r.points.length; i++) {
        if (r.points[i].x > 0 && r.points[i].x < L) res.step('  M at x = ' + n(r.points[i].x, 3) + ' ft' + (r.points[i].zero ? ' (shear = 0)' : '') + ' = ' + n(r.points[i].M, 3) + ' kip-ft.', SRC.statics);
      }
      res.step('Largest: Mu = ' + n(r.Mmax, 2) + ' kip-ft at x = ' + n(r.xM, 3) + ' ft.', SRC.statics);
    }
    res.step('Maximum shear Vu = ' + n(r.Vmax, 3) + ' kips (at a support' + (m.combo ? ', ' + m.combo.gov : '') + ').', SRC.statics);
    if (m.combo) res.step(m.combo.text, SRC.combos);
    var eff = beamEnvelope(m, false);   // P8-1: RA, RB and Vu are the ENVELOPE over the cases formed, each naming its own governing combination
    res.val('Mu', r.Mmax, 'kip-ft', SRC.statics).val('x_Mu', r.xM, 'ft', SRC.statics).val('RA', eff ? eff.RA.v : r.Ra, 'kips', SRC.statics).val('RB', eff ? eff.RB.v : r.Rb, 'kips', SRC.statics).val('Vu', eff ? eff.Vu.v : r.Vmax, 'kips', SRC.statics);
    res.val('span', L, 'ft').val('self_weight_factored', m.swF, 'k/ft');
    beamEnvelopeOut(res, m, false, eff);
    res.answer('Maximum factored moment Mu', r.Mmax, 'kip-ft', eff
      ? 'Mu = ' + n(r.Mmax, 2) + ' kip-ft (' + eff.Mu.id + ') at x = ' + n(r.xM, 3) + ' ft; reactions RA = ' + n(eff.RA.v, 3) + ' (' + eff.RA.id + '), RB = ' + n(eff.RB.v, 3) + ' (' + eff.RB.id + '); Vu = ' + n(eff.Vu.v, 3) + ' (' + eff.Vu.id + ') -- reactions and shear in kips' + (eff.mixed ? '; an ENVELOPE, each from its own combination (NOT one free-body diagram)' : '')
      : 'Mu = ' + n(r.Mmax, 2) + ' kip-ft at x = ' + n(r.xM, 3) + ' ft;  reactions RA = ' + n(r.Ra, 3) + ', RB = ' + n(r.Rb, 3) + ' kips');
    res.table('Moment at the critical points' + (eff ? ' -- ' + m.combo.gov + ' (the combination that governs Mu)' : ''), ['x, ft', 'V left, kips', 'V right, kips', 'M, kip-ft', 'note'],
      r.points.map(function (p) { return [Math.round(p.x * 1000) / 1000, Math.round(p.Vleft * 1000) / 1000, Math.round(p.Vright * 1000) / 1000, Math.round(p.M * 1000) / 1000, p.zero ? 'zero shear' : (p.x === 0 ? 'left support' : (p.x === L ? 'right support' : 'point load'))]; }));
    beamEnvelopeTable(res, false, eff);
    if (mc && mc.id === 9) res.val('a', Math.min(pos[0].x, pos[1].x), 'ft');
    res.flag('NOTE: Table 3-2 is in kip-ft. If a problem gives kip-in, divide by 12 (Lookup > Units).');
    if (m.fact) res.flag('NOTE: loads were taken as already factored; nothing was multiplied by 1.2 / 1.6 except the self-weight row.');
    return res;
  });

  // ---- beam capacity / selection ----
  function t32entry(label) { return idx().t32[normName(label)] || null; }

  // P9-2: why a shape is NOT bold in Table 3-2: some shape with the same or a larger Zx weighs LESS (the book prints a shape in bold when none does).
  // Returns the lightest such shape (the one with the nearest Zx among equal weights), or null.
  function lighterStrongerShape(e) {
    var best = null;
    idx().t32list.forEach(function (t) {
      if (t === e || t.Zx < e.Zx - 1e-9 || !(t.W < e.W - 1e-9)) return;
      if (!best || t.W < best.W - 1e-9 || (Math.abs(t.W - best.W) < 1e-9 && t.Zx < best.Zx)) best = t;
    });
    return best;
  }

  function wShapesFiltered(allowedDepths, maxDepth) {
    var list = idx().t32list.slice(), I = idx();
    return list.filter(function (e) {
      var s = I.byLabel[normName(e.shape)];
      if (!s) return false;
      if (allowedDepths && allowedDepths.length && allowedDepths.indexOf(nominalDepth(e.shape)) < 0) return false;
      if (isNum(maxDepth) && s.d > maxDepth + 1e-9) return false;
      return true;
    });
  }

  // P9-1: among shapes of the SAME weight the one with the SMALLER printed phi Mp comes first.  She reads Table 3-2 "enter at Mu, go UP to the first
  // BOLD row": of the equal lightest weights that is the one with the smallest phi Mp that still covers Mu (Steel 5 p13 / Steel 6 p15: W16x40, not W18x40;
  // W21x55, not W24X55).  Inside every one of the 57 equal-weight groups of Table 3-2 the order by phi Mp is the order by Zx, i.e. the printed order.
  function sortByCheapest(list) {
    return list.sort(function (p, q) { return (p.W - q.W) || (p.phiMp3 - q.phiMp3) || (p.shape < q.shape ? -1 : 1); });
  }

  // Lightest W shape whose PRINTED phi Mp (Table 3-2, 3 figures) covers Mu.  opts.recheck(W) -> Mu with that shape's own weight (or null).
  // Returns also `tied` (P9-1): the OTHER shapes of the winner's weight that cover Mu (and pass the recheck too), smallest phi Mp first, whatever nNext is.
  function selectBeamCore(Mu, allowedDepths, maxDepth, recheck, nNext) {
    var cands = sortByCheapest(wShapesFiltered(allowedDepths, maxDepth)), i, trials = [], first = null, winner = null, winIdx = -1;
    if (!cands.length) fail('NOT_FOUND', 'No W shape satisfies the depth limits you set.', []);
    for (i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (c.phiMp3 + 1e-9 < Mu) continue;
      if (!first) first = c;
      var muSw = recheck ? recheck(c.W) : null;
      var ok = recheck ? (c.phiMp3 + 1e-9 >= muSw) : true;
      trials.push({ e: c, muSw: muSw, ok: ok });
      if (ok) { winner = c; winIdx = i; break; }
    }
    if (!winner) {
      var top = cands.slice().sort(function (p, q) { return q.phiMp3 - p.phiMp3; })[0];
      fail('OUT_OF_RANGE', 'No W shape in the allowed set has a printed phi Mp of at least ' + n(Mu, 2) + ' kip-ft (largest allowed: ' + top.shape + ' = ' + n(top.phiMp3, 0) + ' kip-ft). Relax the depth limits, or check the units (kip-ft, not kip-in).', [top.shape]);
    }
    var next = [], lighter = [];
    for (i = winIdx + 1; i < cands.length && next.length < (nNext || 5); i++) {
      if (cands[i].phiMp3 + 1e-9 >= Mu) {
        var mu2 = recheck ? recheck(cands[i].W) : null;
        if (!recheck || cands[i].phiMp3 + 1e-9 >= mu2) next.push({ e: cands[i], muSw: mu2 });
      }
    }
    // "lighter" means STRICTLY lighter (P9-1: a same-weight smaller sibling that failed now sorts before the winner and must not be called lighter)
    var below = cands.slice(0, winIdx).filter(function (e) { return e.W < winner.W - 1e-9 && (e.phiMp3 + 1e-9 < Mu || (recheck && trials.some(function (t) { return t.e === e && !t.ok; }))); });
    below.sort(function (p, q) { return q.phiMp3 - p.phiMp3; });
    lighter = below.slice(0, 3);
    var tied = [];
    for (i = winIdx + 1; i < cands.length && Math.abs(cands[i].W - winner.W) < 1e-9; i++) {
      if (cands[i].phiMp3 + 1e-9 >= Mu && (!recheck || cands[i].phiMp3 + 1e-9 >= recheck(cands[i].W))) tied.push(cands[i]);
    }
    return { winner: winner, first: first, trials: trials, next: next, lighter: lighter, tied: tied, count: cands.length };
  }

  // P9-1: one clause that says a tie exists, put right after the shape name in every answer text.
  //   normal:  "W16X40 (same weight as W18X40, which has more capacity; Table 3-2's first bold row above Mu is W16X40)"
  //   moved:   the flat-ceiling fallback used another tied shape than the first bold row (see floor_plan): says which and why.
  function joinNames(list) { return list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]; }
  function tieClause(chosen, sel, moved) {
    var others = [sel.winner].concat(sel.tied || []).filter(function (x) { return x !== chosen; });
    if (!others.length) return '';
    var names = others.map(function (x) { return x.shape; });
    if (moved) return ' (same weight as ' + joinNames(names) + '; Table 3-2\'s first bold row above Mu is ' + sel.winner.shape + ', but with the flat ceiling no girder of that depth carries the load, so the equal-weight ' + chosen.shape + ' is used)';
    var more = others.every(function (x) { return x.phiMp3 > chosen.phiMp3 + 1e-9; });
    return ' (same weight as ' + joinNames(names) + ', which ' + (others.length > 1 ? 'have' : 'has') + (more ? ' more capacity' : ' the same or more capacity') + '; Table 3-2\'s first bold row above Mu is ' + chosen.shape + ')';
  }
  // the worked-step line for the same tie (beam_select and the floor-plan beam / girder)
  function tieStep(chosen, sel) {
    if (!(sel.tied || []).length) return null;
    var all = [chosen].concat(sel.tied).map(function (x) { return x.shape + ' (phi Mp = ' + n(x.phiMp3, 0) + ')'; }), both = all.length === 2 ? 'both' : 'all';
    return 'Equal-weight tie: ' + joinNames(all) + ' ' + both + ' weigh ' + n(chosen.W, 4) + ' lb/ft and ' + both + ' carry the moment. Her rule: enter Table 3-2 at Mu and go UP to the first BOLD row -- that is ' + chosen.shape + ', the one with the smallest phi Mp that still works.';
  }

  function bendingFlags(res, e) {
    if (e.noncompact) {
      var s = idx().byLabel[normName(e.shape)];
      var b = s ? beamStrength(s, 50) : null;
      res.flag('WARNING: ' + e.shape + ' has a flange that is NOT compact' + (b ? ' (bf/2tf = ' + n(b.lam, 2) + ' > ' + n(b.lamP, 2) + ')' : '') + ': the Manual value is LOWER than 0.9 Fy Zx' + (b ? ' = ' + n(b.phiMp, 1) + ' kip-ft; the book (Spec F3) gives ' + n(b.phiMn, 1) + ' kip-ft' : '') + '. Use the printed value -- check the book.');
    }
    if (e.override) res.flag('WARNING: ' + ovText(e.override));
  }

  def('beam_capacity', 'Beam', 'Design moment of a given beam', 'phi Mp = 0.90 Fy Zx for a W-shape with the compression flange fully braced; the PRINTED Table 3-2 value (3 figures) is the answer, the exact value an alternative. Flange-not-compact shapes are flagged.', [
    F('shape', 'shape', 'Beam shape (W-shape)', '', { required: true }),
    F('Fy', 'number', 'Fy (Table 3-2 is for Fy = 50 ksi)', 'ksi', { default: 50, min: 1, minExclusive: true }),
    F('Mu', 'number', 'Factored moment Mu to compare with (optional)', 'kip-ft', { min: 0 })
  ], function (a, res) {
    var s = useShape(res, findShape(a.shape)), fy = a.Fy, printed = null, answerVal, exactTxt;
    if (!isNum(s.Zx)) fail('INVALID', s.label + ' has no plastic section modulus Zx in the database.');
    var e = (s.type === 'W' && fy === 50) ? t32entry(s.label) : null;
    var b = s.type === 'W' ? beamStrength(s, fy) : null;
    var exact = b ? b.phiMn : 0.9 * fy * s.Zx / 12;
    res.step('Properties from the Manual: ' + s.label + ', Zx = ' + n(s.Zx, 4) + ' in^3' + (isNum(s.Sx) ? ', Sx = ' + n(s.Sx, 4) + ' in^3' : '') + '.', SRC.shapes);
    res.step('Compression flange fully braced (unbraced length 0): phi Mp = 0.90 Fy Zx = 0.90 x ' + n(fy, 3) + ' x ' + n(s.Zx, 4) + ' / 12 = ' + n(0.9 * fy * s.Zx / 12, 2) + ' kip-ft.', SRC.f2);
    roundHssNote(res, s, fy);
    if (e) {
      printed = e.phiMp3;
      res.step('Table 3-2 prints phi Mp = ' + n(printed, 0) + ' kip-ft for ' + s.label + ' (3 significant figures) -- this is the number to use.', SRC.t32);
      if (e.noncompact) res.step('Flange is not compact: the table value includes the Spec F3 reduction, ' + n(exact, 2) + ' kip-ft before rounding.', SRC.f3);
      res.val('phiMp_printed', printed, 'kip-ft', SRC.t32);
      answerVal = printed;
      res.alt('exact value, not rounded', exact, 'kip-ft', 'phi Mp = ' + n(exact, 2) + ' kip-ft');
      bendingFlags(res, e);
    } else {
      answerVal = exact;
      if (s.type !== 'W') res.flag('NOTE: ' + s.label + ' is not a W-shape, so it is not in Table 3-2; phi Mp = 0.90 Fy Zx was computed (compact-flange check not made -- check the book).');
      else res.flag('NOTE: Table 3-2 is printed for Fy = 50 ksi; for Fy = ' + n(fy, 3) + ' ksi the value was computed (F2 / F3), not read from a table.');
      if (b && b.nonCompact) res.flag('WARNING: flange is NOT compact (bf/2tf = ' + n(b.lam, 2) + ' > ' + n(b.lamP, 2) + '); F3 reduction applied.');
    }
    res.val('phiMp', answerVal, 'kip-ft', SRC.t32);
    res.val('Zx', s.Zx, 'in^3', SRC.shapes);
    // shear strength: a later topic, shown because the table has it
    var vn = e ? e.phiVn : (b ? b.phiVn : null);
    if (isNum(vn)) {
      res.val('phiVn', vn, 'kips', 'Table 3-2 phi Vn column (calculated, Spec G2.1) -- later topic');
      res.step('Shear strength -- later topic, from the table: phi Vn = ' + n(vn, 1) + ' kips (not on the midterm; not checked in the answer).', 'Table 3-2 phi Vn column (Spec G2.1)');
    }
    var txt = 'phi Mp = ' + n(answerVal, e ? 0 : 2) + ' kip-ft  (' + s.label + ', fully braced)';
    if (isNum(a.Mu)) {
      var okM = answerVal + 1e-9 >= a.Mu;
      res.step('Compare: Mu = ' + n(a.Mu, 3) + ' kip-ft ' + (okM ? '<=' : '>') + ' phi Mp = ' + n(answerVal, 3) + ' kip-ft -> ' + (okM ? 'OK' : 'NOT ADEQUATE') + '.', SRC.lrfd);
      txt += okM ? '; adequate for Mu = ' + n(a.Mu, 3) : '; NOT adequate for Mu = ' + n(a.Mu, 3);
      res.val('adequate', okM, '');
      if (!okM) res.flag('WARNING: Mu exceeds phi Mp -- the beam is NOT adequate.');
    }
    res.answer('Design moment phi Mp', answerVal, 'kip-ft', txt);
    if (isNum(vn)) res.alt('shear strength -- later topic, from the table', vn, 'kips', 'phi Vn = ' + n(vn, 1) + ' kips (Table 3-2 column; not on the midterm)');
    if (e && e.bold === false) {
      var lt = lighterStrongerShape(e);
      res.flag('NOTE: ' + s.label + ' is not the bold shape in Table 3-2 (a shape is bold when no shape with the same or a larger Zx weighs less)' + (lt ? ': ' + lt.shape + ' weighs ' + n(lt.W, 4) + ' lb/ft against ' + n(e.W, 4) + ' and has ' + (lt.Zx > e.Zx + 1e-9 ? 'a larger' : 'the same') + ' Zx, so ' + s.label + ' is not the most economical choice' : '') + '.');
    }
    return res;
  });

  def('beam_required_zx', 'Beam', 'Required plastic section modulus Zx', 'Zx required = Mu / (0.90 Fy), with Mu in kip-ft converted to kip-in.', [
    F('Mu', 'number', 'Factored moment Mu', 'kip-ft', { required: true, min: 0, minExclusive: true }),
    F('Fy', 'number', 'Fy', 'ksi', { default: 50, min: 1, minExclusive: true })
  ], function (a, res) {
    var z = a.Mu * 12 / (0.9 * a.Fy);
    res.step('Mu = ' + n(a.Mu, 3) + ' kip-ft x 12 = ' + n(a.Mu * 12, 3) + ' kip-in.', 'Unit conversion');
    res.step('Zx required = Mu / (0.90 Fy) = ' + n(a.Mu * 12, 3) + ' / (0.90 x ' + n(a.Fy, 3) + ') = ' + n(z, 3) + ' in^3.', SRC.f2);
    res.val('Zx_required', z, 'in^3', SRC.f2);
    res.answer('Required Zx', z, 'in^3', 'Zx >= ' + n(z, 3) + ' in^3');
    res.flag('NOTE: for selection use Beam > Select; it compares with the printed Table 3-2 values and picks the lightest.');
    return res;
  });

  def('beam_select', 'Beam', 'Select the most economical beam', 'Lightest W-shape whose PRINTED phi Mp (Table 3-2) is at least Mu. Optional depth limits and a self-weight recheck. Give Mu directly, or the full loading as "analysis".', [
    F('Mu', 'number', 'Factored moment Mu (leave empty if you give the loading in "analysis")', 'kip-ft', { min: 0, minExclusive: true }),
    F('analysis', 'object', 'Loading as for beam_analysis (the moment is computed from it and the self-weight recheck is exact)', ''),
    F('allowed_depths', 'numlist', 'Only these nominal depths (e.g. 16 for "W16 only"); empty = all W', 'in'),
    F('max_depth_in', 'number', 'Maximum actual depth', 'in', { min: 0, minExclusive: true }),
    F('self_weight_recheck', 'boolean', 'Add the beam\'s own weight (dead load: x 1.2; x 1.4 when the loading is given in "analysis" and 1.4D governs) and recheck -- ONLY if the problem gives no steel-framing weight and Mu does not already include it', '', { default: false }),
    F('span_ft', 'number', 'Span (needed for the recheck when you give Mu directly)', 'ft', { min: 0, minExclusive: true }),
    F('support', 'select', 'Support, only for the self-weight recheck when you give Mu directly: simple span (w L^2/8) or CANTILEVER (w L^2/2 at the wall). With a loading in "analysis" its own support is used', '', { default: 'simple', values: [{ value: 'simple', label: 'simple span' }, { value: 'cantilever', label: 'cantilever' }] }),
    F('show', 'integer', 'How many following options to list', '', { default: 5, min: 0, max: 15 })
  ], function (a, res) {
    var Mu = a.Mu, recheck = null, model = null, an = null, aa = null, cant = false;
    if (a.analysis && typeof a.analysis === 'object' && isNum(Mu)) fail('AMBIGUOUS', 'You gave both Mu (' + n(Mu, 2) + ' kip-ft) and the loading (analysis). Give one: Mu directly, or the loading, and the moment is computed from it.');
    if (a.analysis && typeof a.analysis === 'object' && !isNum(Mu)) {
      aa = normalizeArgs(FUNCS.beam_analysis, a.analysis);
      cant = aa.support === 'cantilever';
      model = beamModel(aa, res, cant);
      an = cant ? analyzeCantilever(model.L, model.w + model.swF, model.loads) : analyzeSimple(model.L, model.w + model.swF, model.loads);
      Mu = an.Mmax;
      res.step((cant ? 'Mu from the loading (CANTILEVER, ' + (model.fromFree ? 'positions typed FROM THE FREE END and converted to FROM THE WALL' : 'every position FROM THE WALL') + '): ' + n(Mu, 2) + ' kip-ft at the wall (hogging; the absolute value is designed).' : 'Mu from the loading: ' + n(Mu, 2) + ' kip-ft at x = ' + n(an.xM, 3) + ' ft.') + (model.combo ? '  ' + model.combo.text : ''), SRC.statics);
      if (res.gave('support') && isSet(a.support)) res.flag('NOTE: the loading in "analysis" has its own support (' + (cant ? 'cantilever' : 'simple span') + '); the support box of this function was NOT used.');
    }
    if (!isNum(Mu)) fail('MISSING', 'Enter Mu (kip-ft), or give the loading in "analysis".');
    var span = model ? model.L : a.span_ft;
    if (model && isNum(a.span_ft) && Math.abs(a.span_ft - model.L) > 1e-9) fail('AMBIGUOUS', 'span_ft = ' + n(a.span_ft, 3) + ' ft, but the loading has a span of ' + n(model.L, 3) + ' ft. Give the span once.');
    if (!model && isNum(a.span_ft) && !a.self_weight_recheck) res.flag('NOTE: the span was entered, but it is only used by the self-weight recheck, which is switched off, so it was NOT used.');
    if (a.self_weight_recheck) {
      if (model) {
        if (aa.w_includes_self_weight) {
          res.flag('NOTE: the loading says the uniform load already includes the beam weight, so the self-weight recheck was skipped (it would count twice).');
        } else {
          if (model.swPlf > 0) res.flag('WARNING: the loading already has a self-weight row (' + n(model.swPlf, 2) + ' lb/ft). The recheck does not replace it -- it ADDS the chosen beam\'s own weight on top. Remove one of them.');
          recheck = function (W) { return model.evalAt(W).M; };   // P7-1: the beam's own weight is dead in every case (x 1.4 for 1.4D, x 1.2 for 1.2D + 1.6L): the larger Mu governs
        }
      } else {
        if (!isNum(span)) fail('MISSING', 'The self-weight recheck needs the span (ft): the beam\'s own weight adds 1.2 x W/1000 x L^2/8 to the moment.');
        if (a.support === 'cantilever') {
          recheck = function (W) { return Mu + 1.2 * W / 1000 * span * span / 2; };
          res.flag('NOTE: CANTILEVER: the recheck adds the self-weight moment w L^2/2 at the wall (exact for any loads, the maximum moment is always at the wall).');
        } else {
          recheck = function (W) { return Mu + 1.2 * W / 1000 * span * span / 8; };
          res.flag('NOTE: the recheck adds the self-weight moment w L^2/8, which is exact only if the maximum moment is at mid-span (uniform, mid-span or symmetric loads). Otherwise give the loading in "analysis".');
        }
      }
    }
    var sel = selectBeamCore(Mu, a.allowed_depths, a.max_depth_in, recheck, a.show);
    var w = sel.winner, s = idx().byLabel[normName(w.shape)];
    var limTxt = (a.allowed_depths && a.allowed_depths.length ? ' among W' + a.allowed_depths.join(', W') : ' among all W-shapes') + (isNum(a.max_depth_in) ? ' with d <= ' + n(a.max_depth_in, 2) + ' in' : '');
    res.step('Enter Table 3-2 (the economy table) with Mu = ' + n(Mu, 2) + ' kip-ft' + limTxt + '. Compare Mu with the PRINTED phi Mp.', SRC.t32);
    res.step('"We are not looking for the one that is closest. We are looking for the lightest." The lightest shape with phi Mp >= Mu is ' + sel.first.shape + ' (phi Mp = ' + n(sel.first.phiMp3, 0) + ' kip-ft, ' + n(sel.first.W, 4) + ' lb/ft)' + (sel.first.bold ? ' -- bold in the table.' : '.'), SRC.t32);
    if (recheck) {
      sel.trials.forEach(function (t) {
        var evS = model && model.combo ? model.evalAt(t.e.W) : null, ftS = evS ? evS.c.fD : 1.2;
        res.step('Self-weight recheck, ' + t.e.shape + ': wu self wt = ' + ftS + ' (' + n(t.e.W / 1000, 4) + ') = ' + n(ftS * t.e.W / 1000, 4) + ' k/ft;  Mu final = ' + n(t.muSw, 2) + ' kip-ft' + (evS && evS.c !== model.gov ? ' (with the beam weight in, ' + evS.c.id + ' now governs)' : '') + ' ' + (t.ok ? '< phi Mp = ' + n(t.e.phiMp3, 0) + ' kip-ft still ok.' : '> phi Mp = ' + n(t.e.phiMp3, 0) + ' kip-ft NG: go up one size.'), 'Her rule: self-weight is dead load');
      });
    }
    var tieTxt = tieClause(w, sel, false), tieLine = tieStep(w, sel);   // P9-1
    if (tieLine) res.step(tieLine, SRC.t32);
    res.val('selected_shape', w.shape, '', SRC.t32).val('phiMp_printed', w.phiMp3, 'kip-ft', SRC.t32).val('Mu', Mu, 'kip-ft').val('weight', w.W, 'lb/ft', SRC.shapes);
    if (model && model.combo) res.val('Mu_1_4D', model.combo.Mu14, 'kip-ft', SRC.combos).val('Mu_1_2D_1_6L', model.combo.Mu12, 'kip-ft', SRC.combos).val('governing_combination', model.combo.gov, '', SRC.combos);
    if (model && model.combo && recheck) {
      var evW = model.evalAt(w.W);
      res.val('governing_combination_with_self_weight', evW.c.id, '', SRC.combos);
      if (evW.c !== model.gov) res.flag('NOTE: with the beam weight in, ' + evW.c.id + ' governs (the loading alone is governed by ' + model.gov.id + '): Mu with its own weight = ' + n(evW.M, 2) + ' kip-ft.');
    }
    res.val('depth', s.d, 'in', SRC.shapes);
    if (recheck) { var tt = sel.trials[sel.trials.length - 1]; res.val('Mu_with_self_weight', tt.muSw, 'kip-ft'); }
    res.answer('Most economical beam', w.phiMp3, 'kip-ft', w.shape + tieTxt + '  (' + n(w.W, 4) + ' lb/ft, d = ' + n(s.d, 2) + ' in)  phi Mp = ' + n(w.phiMp3, 0) + ' kip-ft >= Mu = ' + n(recheck ? sel.trials[sel.trials.length - 1].muSw : Mu, 2));
    if (w.phiMp3 + 1e-9 >= Mu && w.phiMp < Mu - 1e-9) res.flag('NOTE: the exact phi Mp (' + n(w.phiMp, 2) + ') is slightly below Mu; the shape passes only on the printed 3-figure value, as in the book.');
    bendingFlags(res, w);
    // P9-1: the other tied shapes (same weight, more capacity) are listed FIRST among the alternatives
    function altNext(x, isTie) {
      var sx = idx().byLabel[normName(x.shape)];
      res.alt('next option: ' + x.shape, x.phiMp3, 'kip-ft', n(x.W, 4) + ' lb/ft (' + n(x.W - w.W, 4) + ' heavier), d = ' + n(sx.d, 2) + ' in' + (isTie ? ' -- same weight, more capacity' : '') + (x.noncompact ? ' -- flange not compact' : ''));
      if (x.noncompact) res.flag('WARNING: next option ' + x.shape + ' has a flange that is not compact.');
    }
    sel.tied.forEach(function (x) { altNext(x, true); });
    res.alt('exact phi Mp of ' + w.shape, w.phiMp, 'kip-ft', 'not rounded to 3 figures');
    sel.next.forEach(function (x) { if (sel.tied.indexOf(x.e) < 0) altNext(x.e, false); });
    sel.lighter.forEach(function (x) {
      res.alt('lighter, does NOT pass: ' + x.shape, x.phiMp3, 'kip-ft', n(x.W, 4) + ' lb/ft; phi Mp ' + n(x.phiMp3, 0) + (x.phiMp3 + 1e-9 < Mu ? ' < Mu ' + n(Mu, 2) : ' passes Mu but fails with its own weight'));
    });
    var rows = [];
    sel.lighter.slice().reverse().forEach(function (x) { rows.push([x.shape, x.W, x.phiMp3, 'lighter -- fails']); });
    rows.push([w.shape, w.W, w.phiMp3, 'SELECTED']);
    sel.next.forEach(function (x) { rows.push([x.e.shape, x.e.W, x.e.phiMp3, 'next option']); });
    res.table('Shapes around the answer (Table 3-2)', ['Shape', 'Weight lb/ft', 'phi Mp kip-ft', ''], rows);
    if (isNum(a.max_depth_in) || (a.allowed_depths && a.allowed_depths.length)) res.flag('NOTE: depth limits applied -- a shallower beam must be heavier. Without the limit the lightest might be a different shape.');
    return res;
  });

  // ---- beam_max_live_load ----
  function maxLiveLoadCore(s, span, trib, deadPsf, includeSw, fy) {
    var e = (s.type === 'W' && fy === 50) ? t32entry(s.label) : null;
    var b = s.type === 'W' ? beamStrength(s, fy) : null;
    var exactCap = b ? b.phiMn : 0.9 * fy * s.Zx / 12;
    var cap = e ? e.phiMp3 : exactCap;
    var wD = deadPsf * trib / 1000 + (includeSw ? s.W / 1000 : 0);
    function solve(capacity) {
      var wuMax = 8 * capacity / (span * span);
      // P7-1: combination 1 (1.4D alone) must fit too: when 1.4 wD > wuMax NO live load is possible, however positive (wuMax - 1.2 wD) / 1.6 looks
      var deadAlone = 1.4 * wD > wuMax + 1e-9 * Math.max(1, wuMax);
      var wL = deadAlone ? -1 : (wuMax - 1.2 * wD) / 1.6;
      return { wuMax: wuMax, wL: wL, psf: wL / trib * 1000, deadAlone: deadAlone };
    }
    return { cap: cap, exactCap: exactCap, printed: !!e, entry: e, wD: wD, main: solve(cap), exact: solve(exactCap) };
  }

  def('beam_max_live_load', 'Beam', 'Largest live load a beam can carry', 'The reverse problem: given the beam, span and dead loads, solve phi Mp >= (1.2 wD + 1.6 wL) L^2/8 for the service live load, in psf (the dead load alone must also fit: 1.4 wD <= 8 phi Mp / L^2, else no live load is possible). phi Mp is the PRINTED Table 3-2 value; the exact value is an alternative.', [
    F('shape', 'shape', 'Beam shape (W-shape)', '', { required: true }),
    F('span_ft', 'dimension', 'Span L', 'ft', { required: true, min: 0, minExclusive: true }),
    F('position', 'select', 'Member position', '', { default: 'interior', values: POSITION_VALUES }),
    F('spacing_ft', 'number', 'Spacing of the members (slab span on each side)', 'ft', { min: 0, minExclusive: true }),
    F('tributary_ft', 'number', 'Custom tributary width', 'ft', { min: 0, minExclusive: true }),
    F('slab_thickness_in', 'dimension', 'Concrete slab thickness (dead load = thickness/12 x 150)', 'in', { default: 0, min: 0 }),
    F('concrete_pcf', 'number', 'Concrete unit weight', 'pcf', { default: 150, min: 0 }),
    F('superimposed_dead_psf', 'number', 'Superimposed dead load: ceiling, mechanical, flooring, FIXED partitions given as a dead load', 'psf', { default: 0, min: 0 }),
    F('framing_psf', 'number', 'Steel framing weight if the problem gives it', 'psf', { default: 0, min: 0 }),
    F('include_self_weight', 'boolean', 'Include the beam\'s own weight as dead load (leave off if the problem says to ignore it or gives a framing allowance)', '', { default: false }),
    F('Fy', 'number', 'Fy (Table 3-2 is for 50 ksi)', 'ksi', { default: 50, min: 1, minExclusive: true })
  ], function (a, res) {
    var s = useShape(res, findShape(a.shape));
    if (!isNum(s.Zx)) fail('INVALID', s.label + ' has no Zx in the database.');
    var tw = tributaryWidth(a, '', res);
    if (!tw) fail('MISSING', 'Missing: the member spacing (or a custom tributary width), ft.');
    var pcf = isNum(a.concrete_pcf) ? a.concrete_pcf : 150;
    var slab = a.slab_thickness_in / 12 * pcf, sdl = a.superimposed_dead_psf || 0, frm = a.framing_psf || 0, deadPsf = slab + sdl + frm;
    if (a.include_self_weight && frm > 0) res.flag('WARNING: you included the beam self-weight AND a steel-framing allowance -- the steel weight is counted twice.');
    var r = maxLiveLoadCore(s, a.span_ft, tw.w, deadPsf, !!a.include_self_weight, a.Fy);
    if (r.main.wL <= 0 || r.main.deadAlone) fail('OUT_OF_RANGE', s.label + ' (phi Mp = ' + n(r.cap, 1) + ' kip-ft) cannot even carry the factored dead load: the dead load alone exceeds the strength (combination 1.4D: 1.4 wD = ' + n(1.4 * r.wD, 3) + ' k/ft needs M = ' + n(1.4 * r.wD * a.span_ft * a.span_ft / 8, 1) + ' kip-ft, more than phi Mp). No live load is possible.');
    res.step('Design moment of the beam: phi Mp = ' + n(r.cap, r.printed ? 0 : 2) + ' kip-ft' + (r.printed ? ' (printed in Table 3-2; exact ' + n(r.exactCap, 2) + ')' : ' (computed)') + '.', r.printed ? SRC.t32 : SRC.f2);
    res.step(tw.text + '.', 'Tributary width');
    res.step('Dead load D = slab + superimposed + framing = ' + n(a.slab_thickness_in, 3) + '/12 x ' + n(pcf, 2) + ' + ' + n(sdl, 3) + ' + ' + n(frm, 3) + ' = ' + n(deadPsf, 3) + ' psf.', SRC.given);
    res.step('Dead line load wD = ' + n(deadPsf, 3) + ' x ' + n(tw.w, 3) + ' / 1000' + (a.include_self_weight ? ' + beam weight ' + n(s.W, 3) + '/1000' : '') + ' = ' + n(r.wD, 4) + ' k/ft' + (a.include_self_weight ? '' : ' (beam self-weight ignored)') + '.', SRC.lrfd);
    res.step('The beam is full when phi Mp = (1.2 wD + 1.6 wL) L^2 / 8, so 1.2 wD + 1.6 wL = 8 phi Mp / L^2 = 8 (' + n(r.cap, 3) + ') / ' + n(a.span_ft, 3) + '^2 = ' + n(r.main.wuMax, 4) + ' k/ft.', SRC.lrfd);
    res.step('Live line load: wL = (' + n(r.main.wuMax, 4) + ' - 1.2 x ' + n(r.wD, 4) + ') / 1.6 = ' + n(r.main.wL, 4) + ' k/ft.  Combination 1 check: 1.4 wD = 1.4 (' + n(r.wD, 4) + ') = ' + n(1.4 * r.wD, 4) + ' k/ft <= ' + n(r.main.wuMax, 4) + ' k/ft: ok.', SRC.lrfd);
    res.step('Live load in psf (SERVICE): wL / tributary width x 1000 = ' + n(r.main.wL, 4) + ' / ' + n(tw.w, 3) + ' x 1000 = ' + n(r.main.psf, 2) + ' psf.', SRC.lrfd);
    res.val('phiMp', r.cap, 'kip-ft', r.printed ? SRC.t32 : SRC.f2).val('wD', r.wD, 'k/ft').val('wL', r.main.wL, 'k/ft').val('live_psf', r.main.psf, 'psf', SRC.lrfd).val('tributary_ft', tw.w, 'ft');
    res.answer('Largest service live load', r.main.psf, 'psf', n(r.main.psf, 1) + ' psf  (' + s.label + ', L = ' + n(a.span_ft, 3) + ' ft, tributary ' + n(tw.w, 3) + ' ft, phi Mp ' + n(r.cap, r.printed ? 0 : 2) + ' kip-ft)');
    if (r.printed && !r.exact.deadAlone) res.alt('with the exact phi Mp (' + n(r.exactCap, 2) + ' kip-ft, not rounded)', r.exact.psf, 'psf', n(r.exact.psf, 2) + ' psf');
    if (r.entry) bendingFlags(res, r.entry);
    res.flag('NOTE: bending only -- shear and deflection are not checked (later topics).');
    if (!a.include_self_weight && frm === 0) res.flag('NOTE: the beam\'s own weight (' + n(s.W, 3) + ' lb/ft) was NOT included, as in a problem that says to ignore it. Tick "include self-weight" to count it.');
    return res;
  });

  // =====================================================================================================
  // 8b. FLOOR PLAN worksheet engine: floor load -> beam -> girder -> column (each stage is a full result)
  // =====================================================================================================

  var COLUMN_POSITIONS = [
    { value: 'interior', label: 'interior column (full bay)' },
    { value: 'edge', label: 'edge column (half the bay)' },
    { value: 'corner', label: 'corner column (quarter of the bay)' },
    { value: 'custom', label: 'custom tributary area' }
  ];

  def('floor_plan', 'Floor plan', 'Floor plan: beam, girder, column', 'The whole worksheet in one call: (1) floor load, (2) beam, (3) girder, (4) optional column. Each stage is returned as a full result in "stages". Use through_step to stop early. The slab box may be left blank when the problem gives the dead load directly in psf: blank = no slab.', FLOOR_FIELDS.concat([
    F('beam_span_ft', 'dimension', 'Beam span (the beams run between the girders)', 'ft', { min: 0, minExclusive: true }),
    F('beam_spacing_ft', 'number', 'Beam spacing', 'ft', { min: 0, minExclusive: true }),
    F('beam_position', 'select', 'Beam position', '', { default: 'interior', values: POSITION_VALUES }),
    F('beam_tributary_ft', 'number', 'Custom tributary width of the beam', 'ft', { min: 0, minExclusive: true }),
    F('beam_shape', 'shape', 'Beam size, ONLY if the problem gives it (otherwise it is selected)', ''),
    F('beam_allowed_depths', 'numlist', 'Beam: only these nominal depths (empty = any W)', 'in'),
    F('beam_max_depth_in', 'number', 'Beam: maximum depth', 'in', { min: 0, minExclusive: true }),
    F('self_weight_recheck', 'boolean', 'Add the beam / girder own weight and recheck (default: ON when no steel-framing psf is given, OFF when it is)', ''),
    F('girder_span_ft', 'dimension', 'Girder span', 'ft', { min: 0, minExclusive: true }),
    F('girder_beam_sides', 'select', 'Beams frame into the girder from', '', { default: 'both', values: [{ value: 'both', label: 'both sides (point load = 2 x beam reaction)' }, { value: 'one', label: 'one side (point load = 1 x beam reaction)' }] }),
    F('girder_beam_positions', 'numlist', 'Positions of the beams along the girder, ft from the left (empty = every beam spacing, not at the ends)', 'ft'),
    F('girder_shape', 'shape', 'Girder size, ONLY if the problem gives it', ''),
    F('girder_same_depth_as_beam', 'boolean', 'Girder the same nominal depth as the beams ("you want the ceiling to be flat")', '', { default: false }),
    F('girder_allowed_depths', 'numlist', 'Girder: only these nominal depths (empty = any W)', 'in'),
    F('girder_max_depth_in', 'number', 'Girder: maximum depth', 'in', { min: 0, minExclusive: true }),
    F('include_column', 'boolean', 'Also size a column', '', { default: false }),
    F('column_floors', 'integer', 'Number of floors the column carries', '', { default: 1, min: 1, max: 100 }),
    F('column_position', 'select', 'Column position', '', { default: 'interior', values: COLUMN_POSITIONS }),
    F('column_tributary_sf', 'number', 'Custom tributary area of the column', 'sq ft', { min: 0, minExclusive: true }),
    F('column_KL_ft', 'number', 'Column effective length KL (same both axes)', 'ft', { min: 0 }),
    F('column_families', 'strlist', 'Column families to try (W8 W10 W12 W14)', '', { default: ['W8', 'W10', 'W12', 'W14'] }),
    F('through_step', 'integer', 'Stop after this step (1 = floor load, 2 = beam, 3 = girder, 4 = column)', '', { min: 1, max: 4 })
  ]), function (a, res) {
    // S5: with the flat-ceiling choice the girder must match the beam's depth.  When the lightest beam is an equal-weight TIE across depths (W16X26 / W14X26) and
    // the girder cannot be found at the first beam's depth, each tied depth is tried before refusing (the beams weigh the same, so the girder load is the same).
    var tie = 0, fails = [], attempt;
    for (;;) {
      attempt = new Res('floor_plan');
      attempt.given = res.given;
      try {
        floorPlanCore(a, attempt, tie, fails);
        res.o = attempt.o;
        return res;
      } catch (e) {
        if (e instanceof EngineError && e.code === 'OUT_OF_RANGE' && a.girder_same_depth_as_beam && attempt.tieCount > tie + 1) { fails.push(e); tie++; continue; }
        if (e instanceof EngineError && e.code === 'OUT_OF_RANGE' && fails.length) fail('OUT_OF_RANGE', fails[0].message + '  The equal-weight beam of another depth was tried too and fails the same way: ' + e.message, e.suggestions);
        throw e;
      }
    }
  });

  function floorPlanCore(a, res, tieIndex, fails) {
    if (a.through_step === 4 && res.gave('include_column') && !a.include_column) fail('AMBIGUOUS', 'through_step = 4 asks for the column step, but "include column" is switched off. Switch it on, or stop at step 3.');
    var wantColumn = !!a.include_column || a.through_step === 4;
    var through = isNum(a.through_step) ? a.through_step : (wantColumn ? 4 : 3);
    var stages = [], i;
    var all = res.o;
    // nothing the caller typed is dropped silently: entries that belong to a step that is not run are named
    var LATER = { 2: ['beam_span_ft', 'beam_spacing_ft', 'beam_tributary_ft', 'beam_shape', 'beam_allowed_depths', 'beam_max_depth_in'],
      3: ['girder_span_ft', 'girder_beam_positions', 'girder_shape', 'girder_same_depth_as_beam', 'girder_allowed_depths', 'girder_max_depth_in'],
      4: ['column_tributary_sf', 'column_KL_ft'] };
    var notRun = [];
    [2, 3, 4].forEach(function (st) {
      if (st > through || (st === 4 && !wantColumn)) LATER[st].forEach(function (k) { if (isSet(a[k])) notRun.push(k); });
    });
    if (!(wantColumn && through >= 4)) {
      if (res.gave('column_floors') && a.column_floors !== 1) notRun.push('column_floors');
      if (res.gave('column_position') && a.column_position !== 'interior') notRun.push('column_position');
      if (res.gave('column_families')) notRun.push('column_families');
    }
    if (through < 3 && res.gave('girder_beam_sides') && a.girder_beam_sides !== 'both') notRun.push('girder_beam_sides');
    if (through < 2 && res.gave('self_weight_recheck')) notRun.push('self_weight_recheck');
    if (through < 2 && a.beam_position && a.beam_position !== 'interior') notRun.push('beam_position');
    if (notRun.length) res.flag('NOTE: these entries belong to a step that was NOT run (' + (through < 4 ? 'through_step = ' + through : 'no column requested') + ') and were not used: ' + notRun.join(', ') + '.');
    if (a.include_column && through < 4) res.flag('NOTE: include_column was ignored because through_step = ' + through + ' stops before the column step.');
    if (isSet(a.beam_shape) && (isSet(a.beam_allowed_depths) || isSet(a.beam_max_depth_in))) res.flag('NOTE: a beam size was given, so the beam depth limits were not used (nothing is selected).');
    if (isSet(a.girder_shape) && (isSet(a.girder_allowed_depths) || isSet(a.girder_max_depth_in) || a.girder_same_depth_as_beam)) res.flag('NOTE: a girder size was given, so the girder depth limits / flat-ceiling choice were not used (nothing is selected).');
    if (a.girder_same_depth_as_beam && isSet(a.girder_allowed_depths)) res.flag('NOTE: "flat ceiling" is ticked, so the girder depths you listed were not used (the beam\'s nominal depth is used).');
    var recheckOn = typeof a.self_weight_recheck === 'boolean' ? a.self_weight_recheck : !(isNum(a.framing_psf) && a.framing_psf > 0);

    // ---------- step 1: floor load
    var r1 = new Res('floor_plan.step1');
    var tw = tributaryWidth({ position: a.beam_position, spacing_ft: a.beam_spacing_ft, tributary_ft: a.beam_tributary_ft }, '', r1, true);
    var c = floorLoadCore(a, r1);
    if (!res.gave('slab_thickness_in')) {   // P9-5: blank slab box = no slab (the dead load is typed directly in psf)
      r1.step('STEP 1 -- floor load.  No slab: the slab box was left blank because the dead load is typed directly in psf, so the slab adds 0 psf.', SRC.given);
      r1.flag('WARNING: the slab thickness was left BLANK and a dead load in psf was typed, so NO slab was added (slab = 0 psf). If the problem has a concrete slab, type its thickness.');
    } else r1.step('STEP 1 -- floor load.  Slab = ' + n(a.slab_thickness_in, 3) + ' / 12 x ' + n(c.pcf, 2) + ' = ' + n(c.slab, 3) + ' psf.', 'Her conversion (150 pcf concrete)');
    r1.step('Dead D = ' + n(c.slab, 3) + ' (slab) + ' + n(c.sdl, 3) + ' (superimposed) + ' + n(c.frm, 3) + ' (steel framing) = ' + n(c.dead, 3) + ' psf;  live L = ' + n(c.live, 3) + ' psf.', SRC.given);
    r1.step('Factored floor load = the LARGER of 1.2D + 1.6L and 1.4D (ASCE 7): ' + factorLines(c.fact, c.dead, c.live, 'psf', 3) + '.  Factored floor load = ' + n(c.factored, 3) + ' psf.', SRC.lrfd);
    r1.val('dead_psf', c.dead, 'psf').val('live_psf', c.live, 'psf').val('factored_psf', c.factored, 'psf', SRC.lrfd).val('governing_combination', c.fact.gov, '', SRC.combos);
    r1.answer('Factored floor load', c.factored, 'psf', n(c.factored, 3) + ' psf  (dead ' + n(c.dead, 3) + ', live ' + n(c.live, 3) + ')');
    if (c.frm > 0) r1.flag('NOTE: a steel-framing weight is in the dead load, so the beam and girder self-weight is NOT added again' + (recheckOn ? ' -- BUT the self-weight recheck is switched ON, which counts the steel twice. Switch it off.' : '.'));
    else r1.flag('NOTE: no steel-framing weight given, so the self-weight of each member is added after it is chosen (recheck is ' + (recheckOn ? 'ON' : 'OFF') + ').');
    if (c.frm > 0 && recheckOn && typeof a.self_weight_recheck === 'boolean') all.flags.push('WARNING: steel framing psf AND the self-weight recheck are both on: the steel weight is counted twice.');
    stages.push(r1.out());
    if (through < 2) return finishFloor(res, stages, 'Floor load: ' + n(c.factored, 3) + ' psf factored');

    // ---------- step 2: beam
    if (!isNum(a.beam_span_ft)) fail('MISSING', 'Step 2 needs the beam span (ft).');
    if (!tw) fail('MISSING', 'Step 2 needs the beam spacing (ft), or a custom tributary width.');
    var r2 = new Res('floor_plan.step2');
    var Lb = a.beam_span_ft, wu = c.factored * tw.w / 1000;
    r2.step('STEP 2 -- beam.  ' + tw.text + '.', 'Tributary width (load path: slab -> beam)');
    r2.step('Line load wu = ' + n(c.factored, 3) + ' psf x ' + n(tw.w, 3) + ' ft / 1000 = ' + n(wu, 4) + ' k/ft.', SRC.lrfd);
    var Mu0 = wu * Lb * Lb / 8;
    r2.step('Mu = wu L^2 / 8 = ' + n(wu, 4) + ' x ' + n(Lb, 3) + '^2 / 8 = ' + n(Mu0, 2) + ' kip-ft  (Table 3-22 case 1).', SRC.t322);
    var beam, beamW, MuB = Mu0, rb, beamTie = '';
    // P7-1: the beam's own weight is DEAD load in both combinations (x 1.4 for 1.4D, x 1.2 for 1.2D + 1.6L); the larger total governs.  With 1.2D + 1.6L governing this is exactly (wu + 1.2 W / 1000).
    var wu14 = 1.4 * c.dead * tw.w / 1000, wu12 = (1.2 * c.dead + 1.6 * c.live) * tw.w / 1000, fBase = c.fact.fD;
    function uB(W) { var q14 = wu14 + 1.4 * W / 1000, q12 = wu12 + 1.2 * W / 1000; return q14 > q12 + 1e-12 ? { w: q14, f: 1.4 } : { w: q12, f: 1.2 }; }
    var recheckB = recheckOn ? function (W) { return uB(W).w * Lb * Lb / 8; } : null;
    if (!isBlank(a.beam_shape)) {
      var bs = useShape(r2, findShape(a.beam_shape)), be = t32entry(bs.label);
      if (!be) fail('INVALID', bs.label + ' is not a W-shape in Table 3-2.');
      beam = be; beamW = bs.W;
      MuB = recheckB ? recheckB(be.W) : Mu0;
      r2.step('Beam size given: ' + be.shape + ' (' + n(be.W, 4) + ' lb/ft): phi Mp = ' + n(be.phiMp3, 0) + ' kip-ft' + (recheckB ? '; Mu with its own weight = ' + n(MuB, 2) + ' kip-ft' : '') + ' -> ' + (be.phiMp3 + 1e-9 >= MuB ? 'OK.' : 'NOT ADEQUATE.'), SRC.t32);
      if (be.phiMp3 + 1e-9 < MuB) r2.flag('WARNING: the beam you entered is NOT adequate (Mu ' + n(MuB, 2) + ' > phi Mp ' + n(be.phiMp3, 0) + ').');
      bendingFlags(r2, be);
    } else {
      var selB = selectBeamCore(Mu0, a.beam_allowed_depths, a.beam_max_depth_in, recheckB, 3);
      beam = selB.winner;
      var tiedB = [selB.winner].concat(selB.tied);   // P9-1: ONE list of the equal-weight shapes that work (it used to be read back out of `next`; the same shapes, the same order)
      res.tieCount = tiedB.length;
      if (tieIndex > 0 && tieIndex < tiedB.length) {
        beam = tiedB[tieIndex];
        r2.step('Flat ceiling and an EQUAL-WEIGHT tie: ' + tiedB.map(function (x) { return x.shape; }).join(' and ') + ' weigh the same (' + n(selB.winner.W, 4) + ' lb/ft). The girder must be the beam\'s depth, and for ' + tiedB[0].shape + ' it fails: ' + (fails && fails[0] ? fails[0].message : 'no girder of that depth works') + '  So the beam is ' + beam.shape + ' (same weight, nominal depth W' + nominalDepth(beam.shape) + ').', 'Her 9/30 review (flat ceiling); equal weights are a tie');
        r2.flag('NOTE: the lightest beam is an equal-weight tie across depths (' + tiedB.map(function (x) { return x.shape; }).join(' / ') + '); with the flat ceiling the tool used ' + beam.shape + ' because no girder of the depth of ' + tiedB[0].shape + ' carries the load.');
      }
      r2.step('Select from Table 3-2: the lightest W with phi Mp >= ' + n(Mu0, 2) + ' kip-ft is ' + selB.first.shape + ' (phi Mp = ' + n(selB.first.phiMp3, 0) + ').' + (selB.lighter.filter(function (x) { return x.phiMp3 + 1e-9 < Mu0; }).length ? '  Next lighter, ' + selB.lighter.filter(function (x) { return x.phiMp3 + 1e-9 < Mu0; })[0].shape + ': phi Mp = ' + n(selB.lighter.filter(function (x) { return x.phiMp3 + 1e-9 < Mu0; })[0].phiMp3, 0) + ' < Mu ' + n(Mu0, 2) + ' NG.' : ''), SRC.t32);
      if (recheckB) selB.trials.forEach(function (t) {
        var ftB = uB(t.e.W).f;
        r2.step('Self-weight recheck, ' + t.e.shape + ': wu self wt = ' + ftB + ' (' + n(t.e.W / 1000, 4) + ') = ' + n(ftB * t.e.W / 1000, 4) + ' k/ft;  Mu final = ' + (ftB === fBase ? n(Mu0, 2) + ' + ' + n(ftB * t.e.W / 1000, 4) + ' (' + n(Lb, 3) + ')^2 / 8 = ' : '(the ' + (ftB === 1.4 ? '1.4D' : '1.2D + 1.6L') + ' combination now governs, with the beam weight in) ') + n(t.muSw, 2) + ' kip-ft ' + (t.ok ? '< ' + n(t.e.phiMp3, 0) + ' still ok.' : '> ' + n(t.e.phiMp3, 0) + ' NG, go up.'), 'Her rule: self-weight is dead load');
      });
      // P9-1: an equal-weight tie is said once in the steps and once in the answer text (the flat-ceiling fallback has its own step above)
      var movedB = beam !== selB.winner, tieLineB = movedB ? null : tieStep(beam, selB);
      if (tieLineB) r2.step(tieLineB, SRC.t32);
      beamTie = tieClause(beam, selB, movedB);
      MuB = recheckB ? selB.trials[selB.trials.length - 1].muSw : Mu0;
      beamW = beam.W;
      bendingFlags(r2, beam);
      selB.next.slice(0, 2).forEach(function (x) { r2.alt('next option: ' + x.e.shape, x.e.phiMp3, 'kip-ft', n(x.e.W, 4) + ' lb/ft' + (!movedB && selB.tied.indexOf(x.e) >= 0 ? ' -- same weight, more capacity' : '')); });
    }
    var fB = recheckB ? uB(beamW).f : fBase;   // the combination that governs the beam WITH its own weight: the girder is analysed under the same one
    var wReact = recheckB ? uB(beamW).w : wu;
    rb = wReact * Lb / 2;
    r2.step('Beam reaction R = (wu' + (recheckB && fB !== fBase ? ' of the ' + (fB === 1.4 ? '1.4D' : '1.2D + 1.6L') + ' combination = ' + n(fB === 1.4 ? wu14 : wu12, 4) : '') + (recheckB ? ' + ' + fB + ' x ' + n(beamW, 3) + '/1000' : '') + ') L / 2 = ' + n(wReact, 4) + ' x ' + n(Lb, 3) + ' / 2 = ' + n(rb, 3) + ' kips -- this is the point load the beam puts on the girder.', SRC.statics);
    r2.val('wu', wu, 'k/ft', SRC.lrfd).val('Mu', Mu0, 'kip-ft', SRC.t322).val('beam_shape', beam.shape, '', SRC.t32).val('beam_phiMp', beam.phiMp3, 'kip-ft', SRC.t32).val('beam_weight', beamW, 'lb/ft', SRC.shapes);
    r2.val('Mu_with_self_weight', MuB, 'kip-ft').val('beam_reaction', rb, 'kips', SRC.statics).val('self_weight_wu', recheckB ? fB * beamW / 1000 : 0, 'k/ft', 'Her rule: self-weight is dead load');
    r2.answer('Beam', rb, 'kips', beam.shape + beamTie + ' (phi Mp ' + n(beam.phiMp3, 0) + ' kip-ft >= Mu ' + n(MuB, 2) + ');  reaction R = ' + n(rb, 3) + ' kips');
    var mll = maxLiveLoadCore(idx().byLabel[normName(beam.shape)], Lb, tw.w, c.dead, recheckB ? true : false, 50);
    if (mll.main.wL > 0) r2.alt('largest service live load this beam could carry', mll.main.psf, 'psf', n(mll.main.psf, 1) + ' psf (same span, spacing and dead load; Beam > Largest live load)');
    stages.push(r2.out());
    if (through < 3) return finishFloor(res, stages, 'Beam ' + beam.shape + beamTie + ', reaction ' + n(rb, 3) + ' kips');

    // ---------- step 3: girder
    if (!isNum(a.girder_span_ft)) fail('MISSING', 'Step 3 needs the girder span (ft).');
    var r3 = new Res('floor_plan.step3');
    var Lg = a.girder_span_ft, positions = [];
    if (a.girder_beam_positions && a.girder_beam_positions.length) {
      positions = a.girder_beam_positions.slice();
      positions.forEach(function (x) {
        if (!(x > 1e-9 && x < Lg - 1e-9)) fail('OUT_OF_RANGE', 'Beam position ' + n(x, 3) + ' ft is not inside the ' + n(Lg, 3) + ' ft girder. A position must be greater than 0 and less than the span (a beam at either end sits on the column, not on the girder). Check the beam positions along the girder (feet from the left support; field girder_beam_positions).');
      });
      var sortedPos = positions.slice().sort(function (p, q) { return p - q; });
      for (i = 1; i < sortedPos.length; i++) { if (sortedPos[i] - sortedPos[i - 1] < 1e-9) r3.flag('CHECK: two beams are at the same position (' + n(sortedPos[i], 3) + ' ft): both loads were applied there. Check the positions.'); }
    } else {
      var sp = a.beam_spacing_ft;
      if (!isNum(sp)) fail('MISSING', 'Step 3 needs the beam positions along the girder (or the beam spacing to compute them).');
      for (i = 1; i * sp < Lg - 1e-9; i++) positions.push(Math.round(i * sp * 1e6) / 1e6);
      if (Math.abs(Lg / sp - Math.round(Lg / sp)) > 1e-6) r3.flag('CHECK: the girder span (' + n(Lg, 3) + ' ft) is not a whole number of beam spacings (' + n(sp, 3) + ' ft): the beam positions were taken at every spacing from the left support -- read the real positions off the plan and type them.');
    }
    if (!positions.length) fail('INVALID', 'No beams frame into the girder at this span and spacing; type the beam positions.');
    var mult = a.girder_beam_sides === 'one' ? 1 : 2;
    var P = mult * rb;
    r3.step('STEP 3 -- girder.  Each beam delivers its reaction R = ' + n(rb, 3) + ' kips; ' + (mult === 2 ? 'beams frame in from BOTH sides, so each point load is 2 x ' + n(rb, 3) : 'beams frame in from ONE side, so each point load is 1 x ' + n(rb, 3)) + ' = ' + n(P, 3) + ' kips.', 'Point load = beam reaction(s) (her 9/23 and 9/30 examples)');
    r3.step('Beams at x = ' + positions.map(function (x) { return n(x, 3); }).join(', ') + ' ft along the ' + n(Lg, 3) + ' ft girder.', SRC.given);
    var gl = positions.map(function (x) { return { x: x, P: P }; });
    var an0 = analyzeSimple(Lg, 0, gl);
    var mc = matchCase(Lg, 0, gl);
    r3.step('Mu = ' + (mc ? mc.formula + ' = ' : '') + n(an0.Mmax, 2) + ' kip-ft' + (mc ? ' (Table 3-22 ' + mc.name + ')' : ' (statics: moment at every load)') + '.', SRC.t322);
    // P7: the girder is checked under EACH combination: the beam reactions of that combination (its beams carry their own weight in it) and the girder's own weight in it (x 1.4 or x 1.2);
    // the larger Mu governs.  The steps show the combination that governs the BEAMS (almost always the girder's too); the other can win only when the two are within a fraction of a percent.
    var gCases = recheckOn ? [[wu14, 1.4], [wu12, 1.2]].map(function (pr) {
      var Pc = mult * (pr[0] + (recheckB ? pr[1] * beamW / 1000 : 0)) * Lb / 2;
      return { f: pr[1], P: Pc, gl: positions.map(function (x) { return { x: x, P: Pc }; }) };
    }) : null;
    function girderBest(W) {
      var best = null;
      gCases.forEach(function (gc) {
        var m = analyzeSimple(Lg, gc.f * W / 1000, gc.gl).Mmax;
        if (!best || m > best.M + 1e-12 || (Math.abs(m - best.M) <= 1e-12 && gc.f === fB)) best = { M: m, gc: gc };
      });
      return best;
    }
    var recheckG = recheckOn ? function (W) { return girderBest(W).M; } : null;
    var depths = a.girder_allowed_depths;
    if (a.girder_same_depth_as_beam) { depths = [nominalDepth(beam.shape)]; r3.step('Flat ceiling: the girder must be the same nominal depth as the beams -> W' + depths[0] + ' only.', 'Her 9/30 review ("you want the ceiling to be flat")'); }
    var gird, gW, MuG = an0.Mmax, girdTie = '';
    if (!isBlank(a.girder_shape)) {
      var gs = useShape(r3, findShape(a.girder_shape)), ge = t32entry(gs.label);
      if (!ge) fail('INVALID', gs.label + ' is not a W-shape in Table 3-2.');
      gird = ge; gW = gs.W; MuG = recheckG ? recheckG(ge.W) : an0.Mmax;
      r3.step('Girder size given: ' + ge.shape + ': phi Mp = ' + n(ge.phiMp3, 0) + ' kip-ft' + (recheckG ? '; Mu with its own weight = ' + n(MuG, 2) : '') + ' -> ' + (ge.phiMp3 + 1e-9 >= MuG ? 'OK.' : 'NOT ADEQUATE.'), SRC.t32);
      if (ge.phiMp3 + 1e-9 < MuG) r3.flag('WARNING: the girder you entered is NOT adequate.');
      bendingFlags(r3, ge);
    } else {
      var selG = selectBeamCore(an0.Mmax, depths, a.girder_max_depth_in, recheckG, 3);
      gird = selG.winner;
      r3.step('Select from Table 3-2: the lightest' + (depths && depths.length ? ' W' + depths.join('/W') : ' W') + ' with phi Mp >= ' + n(an0.Mmax, 2) + ' kip-ft is ' + selG.first.shape + ' (phi Mp = ' + n(selG.first.phiMp3, 0) + ').' + (selG.lighter.filter(function (x) { return x.phiMp3 + 1e-9 < an0.Mmax; }).length ? '  Next lighter, ' + selG.lighter.filter(function (x) { return x.phiMp3 + 1e-9 < an0.Mmax; })[0].shape + ': phi Mp = ' + n(selG.lighter.filter(function (x) { return x.phiMp3 + 1e-9 < an0.Mmax; })[0].phiMp3, 0) + ' < Mu ' + n(an0.Mmax, 2) + ' NG (the next lighter shape, which fails; the book value is flange-reduced where marked).' : ''), SRC.t32);
      if (recheckG) selG.trials.forEach(function (t) {
        var fG = girderBest(t.e.W).gc.f, gcT = girderBest(t.e.W).gc;
        var supM = an0.Mmax + fB * t.e.W / 1000 * Lg * Lg / 8, formulaTxt = Math.abs(supM - t.muSw) < 0.005 ? n(an0.Mmax, 2) + ' + ' + n(fB * t.e.W / 1000, 4) + ' (' + n(Lg, 3) + ')^2 / 8 = ' + n(t.muSw, 2) : n(t.muSw, 2), statNote = Math.abs(supM - t.muSw) < 0.005 ? '' : ' (by statics: for these beam positions the maximum moment is not at mid-span)';
        if (fG === fB) r3.step('Self-weight recheck, ' + t.e.shape + ': wu self wt = ' + fB + ' (' + n(t.e.W / 1000, 4) + ') = ' + n(fB * t.e.W / 1000, 4) + ' k/ft over ' + n(Lg, 3) + ' ft;  Mu final = ' + formulaTxt + ' kip-ft' + statNote + ' ' + (t.ok ? '< ' + n(t.e.phiMp3, 0) + ' still ok.' : '> ' + n(t.e.phiMp3, 0) + ' NG, go up.'), 'Her rule: self-weight is dead load');
        else r3.step('Self-weight recheck, ' + t.e.shape + ': with its own weight in, the girder is governed by the OTHER combination (' + (fG === 1.4 ? '1.4D' : '1.2D + 1.6L') + ': each beam reaction ' + n(gcT.P / mult, 3) + ' kips, point load ' + n(gcT.P, 3) + ' kips): wu self wt = ' + fG + ' (' + n(t.e.W / 1000, 4) + ') = ' + n(fG * t.e.W / 1000, 4) + ' k/ft over ' + n(Lg, 3) + ' ft;  Mu final = ' + n(t.muSw, 2) + ' kip-ft ' + (t.ok ? '< ' + n(t.e.phiMp3, 0) + ' still ok.' : '> ' + n(t.e.phiMp3, 0) + ' NG, go up.'), 'Her rule: self-weight is dead load');
      });
      var tieLineG = tieStep(gird, selG);   // P9-1
      if (tieLineG) r3.step(tieLineG, SRC.t32);
      girdTie = tieClause(gird, selG, false);
      MuG = recheckG ? selG.trials[selG.trials.length - 1].muSw : an0.Mmax;
      gW = gird.W;
      bendingFlags(r3, gird);
      selG.next.slice(0, 2).forEach(function (x) { r3.alt('next option: ' + x.e.shape, x.e.phiMp3, 'kip-ft', n(x.e.W, 4) + ' lb/ft' + (selG.tied.indexOf(x.e) >= 0 ? ' -- same weight, more capacity' : '')); });
    }
    var gFin = recheckG ? girderBest(gW) : null;
    var gAsym = false;
    function endMax(rr) { if (Math.abs(rr.Ra - rr.Rb) > 1e-9 * Math.max(1, rr.Ra)) gAsym = true; return Math.max(rr.Ra, rr.Rb); }   // the LARGER end: the beams need not sit symmetrically
    var gRx = recheckG ? Math.max.apply(null, gCases.map(function (gc) { return endMax(analyzeSimple(Lg, gc.f * gW / 1000, gc.gl)); })) : endMax(an0);
    if (gFin && gFin.gc.f !== fB) r3.flag('NOTE: with its own weight in, the girder is governed by the other load combination (' + (gFin.gc.f === 1.4 ? '1.4D' : '1.2D + 1.6L') + ', its beam reactions and its own weight x ' + gFin.gc.f + '): Mu with its own weight = ' + n(gFin.M, 2) + ' kip-ft (each combination is checked on the whole girder).');
    r3.val('self_weight_wu', recheckG ? gFin.gc.f * gW / 1000 : 0, 'k/ft', 'Her rule: self-weight is dead load').val('point_load', P, 'kips', SRC.statics).val('Mu', an0.Mmax, 'kip-ft', SRC.t322).val('Mu_with_self_weight', MuG, 'kip-ft').val('girder_shape', gird.shape, '', SRC.t32).val('girder_phiMp', gird.phiMp3, 'kip-ft', SRC.t32).val('girder_weight', gW, 'lb/ft', SRC.shapes).val('girder_reaction', gRx, 'kips', SRC.statics);
    r3.answer('Girder', gird.phiMp3, 'kip-ft', gird.shape + girdTie + ' (phi Mp ' + n(gird.phiMp3, 0) + ' kip-ft >= Mu ' + n(MuG, 2) + ');  girder reaction ' + n(gRx, 2) + ' kips' + (gAsym ? ' (the larger end)' : ''));
    stages.push(r3.out());
    if (through < 4 || !wantColumn) return finishFloor(res, stages, 'Beam ' + beam.shape + beamTie + ', girder ' + gird.shape + girdTie);

    // ---------- step 4: column
    if (!isNum(a.column_KL_ft)) fail('MISSING', 'Step 4 needs the column effective length KL (ft).');
    var r4 = new Res('floor_plan.step4');
    var bay = (isNum(a.beam_span_ft) ? a.beam_span_ft : 0) * Lg, area, areaTxt;
    if (a.column_position === 'custom') {
      if (!isNum(a.column_tributary_sf)) fail('MISSING', 'Step 4: enter the custom tributary area of the column.');
      area = a.column_tributary_sf; areaTxt = 'custom tributary area = ' + n(area, 2) + ' sq ft';
    } else {
      var fac = a.column_position === 'edge' ? 0.5 : (a.column_position === 'corner' ? 0.25 : 1);
      noteUnused(res, a, ['column_tributary_sf'], 'the column position is "' + (a.column_position || 'interior') + '" (a custom area only applies to the position "custom")');
      area = bay * fac;
      areaTxt = (a.column_position || 'interior') + ' column: tributary area = ' + (fac === 1 ? '' : fac + ' x ') + n(Lb, 3) + ' x ' + n(Lg, 3) + ' = ' + n(area, 2) + ' sq ft';
    }
    var perLevel = c.factored * area / 1000, PuC = perLevel * a.column_floors;
    r4.step('STEP 4 -- column.  ' + areaTxt + '.', 'Tributary area (it does not care how the beams are framed)');
    r4.step('Load per floor = ' + n(c.factored, 3) + ' psf x ' + n(area, 2) + ' sq ft / 1000 = ' + n(perLevel, 2) + ' kips;  x ' + a.column_floors + ' floor' + (a.column_floors > 1 ? 's' : '') + ' = Pu ' + n(PuC, 2) + ' kips.', SRC.lrfd);
    r4.flag('NOTE: member self-weight is not added to the column load (her class example: 4 x 31 = 124 kips per level is just the factored floor load x the bay).');
    var colSel = selectColumnCore({ families: a.column_families, Pu: PuC, KLx: a.column_KL_ft, KLy: a.column_KL_ft, Fy: null }, r4);
    // P8-2: when EVERY family asked for is a tee / angle family (only reachable through the engine: the page offers W families here) the sentence does not say "Table 4-1a" or "carries"
    var colAllU = colSel.perFamily.length > 0 && colSel.perFamily.every(function (pf) { return pf.trials.length > 0 && pf.trials.every(function (t) { return unreliableColumnShape(t.shape); }); });
    if (colAllU) r4.step('Same KL both ways = ' + n(a.column_KL_ft, 3) + ' ft: a tee / angle family is not in Table 4-1a; the KL/r route gives a flexural-buckling-only phi Pn, and each family is searched for the lightest shape whose phi Pn reaches ' + n(PuC, 1) + ' kips (NOT an adequacy verdict: Spec E4 / E5 are not checked).', SRC.t414);
    else r4.step('Same KL both ways = ' + n(a.column_KL_ft, 3) + ' ft: look the load up in Table 4-1a and go down the family to the lightest that carries ' + n(PuC, 1) + ' kips.', SRC.t41a);
    describeColumnSelection(r4, colSel, PuC);
    stages.push(r4.out());
    var floorText = 'Beam ' + beam.shape + beamTie + ', girder ' + gird.shape + girdTie + ', column ' + (colSel.overall ? colSel.overall.shape.label : '(none)');
    if (colSel.overall && unreliableColumnShape(colSel.overall.shape)) {
      // A1: a tee / angle column (only reachable through the API: the page offers W families here): the headline says so and the warning is the first flag
      var fo = finishFloor(res, stages, UNRELIABLE + '  (the COLUMN ' + colSel.overall.shape.label + ' is a tee or an angle: its phi Pn is flexural buckling only, too high.)  ' + floorText);
      var wf = fo.o.flags.filter(function (f) { return f.indexOf('WARNING: ' + UNRELIABLE) === 0; })[0];
      if (wf) fo.flagFirst(wf);
      return fo;
    }
    return finishFloor(res, stages, floorText);
  }

  function finishFloor(res, stages, text) {
    var o = res.o, i, k;
    o.stages = stages;
    for (i = 0; i < stages.length; i++) {
      var st = stages[i];
      st.steps.forEach(function (s) { o.steps.push({ text: s.text, source: s.source }); if (s.source) res.src(s.source); });
      st.flags.forEach(function (f) { res.flag(f); });
      st.sources.forEach(function (s) { res.src(s); });
      for (k in st.values) { if (has(st.values, k)) o.values['step' + (i + 1) + '_' + k] = st.values[k]; }
      st.alternatives.forEach(function (al) { o.alternatives.push({ label: 'step ' + (i + 1) + ': ' + al.label, value: al.value, unit: al.unit, text: al.text }); });
      st.tables.forEach(function (t) { o.tables.push(t); });
    }
    var last = stages[stages.length - 1];
    o.answer = { label: 'Floor plan result (through step ' + stages.length + ')', value: last.answer ? last.answer.value : null, unit: last.answer ? last.answer.unit : '', text: text };
    return res;
  }

  // =====================================================================================================
  // 9. COLUMN
  // =====================================================================================================

  function ceilKLr(x) { return x <= 0 ? 0 : Math.max(1, ceilTol(x)); }

  // KxLx and KyLy are "the same both ways" when they agree to 1e-6 ft, and a KL within 1e-6 ft of a whole number of feet IS that whole number
  // (0.8 x 30 must not fall into the 25-ft row because of floating-point noise).
  var EQ_KL = 1e-6;
  function sameKL(a, b) { return Math.abs(a - b) < EQ_KL; }

  function defaultFy(s) {
    var m = materialFor(s.type);
    return m ? m.Fy : 50;
  }

  // Everything about one shape under KLx, KLy (ft) and Fy.   purpose = 'capacity' or 'select'.
  //   HER capacity method (HW 5-3 .. 5-17, the 9/30 review): KL/r about both axes, the larger governs, ROUND UP, Table 4-14, x Ag.
  //   Always also worked out: the straight-line interpolation between the two Table 4-14 rows, the exact E3 value, and for W-shapes at
  //   Fy 50 the Table 4-1a lookups (same KL both ways; or the strong-axis KL converted with rx/ry, her HW 6-15 way).
  //   HER method with the same KL both ways (HW 6-7b, 6-7c, the 9/30 review W14x109 24 ft -> 931): straight into Table 4-1a, and a KL that is
  //   not a whole number is read at the NEXT whole-foot row ("just round up"; HW 6-15 17.14 ft -> 18 ft).  The Table 4-1a headline needs ALL of:
  //   KxLx = KyLy, a W-shape, Fy 50, a row inside the printed table.  f2 = true lets the headline use that rule for a KL that is not a whole
  //   number (column_capacity always; column_select only when every family in the list is W, because a mixed list would compare a rounded-up
  //   table row with the KL/r route of the other shapes).  A slender W-shape or rectangular HSS has Spec E7.1 applied to its effective area.
  function columnCore(s, KLx, KLy, fy, purpose, f2) {
    if (!isNum(s.rx) || !isNum(s.ry) || !isNum(s.A)) fail('INVALID', s.label + ' has no A, rx, ry in the database; it cannot be used as a column here.');
    var st = settings();
    var o = { shape: s, fy: fy, KLx: KLx, KLy: KLy, A: s.A, rx: s.rx, ry: s.ry, purpose: purpose || 'capacity' };
    o.lx = 12 * KLx / s.rx; o.ly = 12 * KLy / s.ry;
    // A SINGLE angle buckles about its minor principal axis z, which is neither x nor y: r_min = min(rx, ry, rz) (the Manual lists rz).
    // The length about z is the longer of the two KL's (safe when they differ).  A double angle (2L) is a symmetric built-up section: unchanged.
    o.rmin = null; o.lz = null;
    if (s.type === 'L' && isNum(s.rz)) { o.rmin = Math.min(s.rx, s.ry, s.rz); o.lz = 12 * Math.max(KLx, KLy) / o.rmin; }
    o.lam = Math.max(o.lx, o.ly, o.lz === null ? 0 : o.lz);
    o.gov = (o.lz !== null && o.lz >= Math.max(o.lx, o.ly) - 1e-12) ? 'z' : (o.ly >= o.lx ? 'y' : 'x');
    o.tooSlender = o.lam > 200 + 1e-9;
    o.klrUp = ceilKLr(o.lam);
    o.slender = slenderElements(s, fy);
    o.exact = columnStrength(s, o.lam, fy);
    o.phiFcrTab = null; o.phiPnTab = null; o.tab = null; o.phiPnTabE7 = null; o.e7Tab = null; o.interp = null;
    if (!o.tooSlender) {
      if (o.klrUp === 0) { o.phiFcrTab = 0.9 * fy; }
      else { o.tab = table414(o.klrUp, fy); o.phiFcrTab = o.tab.value; }
      o.phiPnTab = o.phiFcrTab * s.A;
      // Spec E7.1 at the rounded-up KL/r (the table route).  An element is reduced only when lambda > lambda_r sqrt(Fy/Fn) with the UNFACTORED Fn;
      // phiPnTabE7 is set only when the area really shrinks, so a shape that is "slender" by Table B4.1a but not reduced at this stress keeps the plain value.
      if (o.slender.length && (s.type === 'W' || isRectHSS(s))) {
        o.e7Tab = columnStrength(s, o.klrUp, fy);
        if (o.e7Tab.e7) o.phiPnTabE7 = o.e7Tab.phiPn;
      }
      // straight-line interpolation between the two table rows either side of KL/r (she "averages" at 61.5 in HW 5-17)
      var lo = Math.floor(o.lam + 1e-9), hi = ceilTol(o.lam);
      if (o.lam <= 0 || hi === lo) {
        o.interp = { lo: lo, hi: hi, frac: 0, phiFcr: o.phiFcrTab, phiPn: o.phiPnTab, same: true };
      } else {
        var tlo = lo < 1 ? 0.9 * fy : table414(lo, fy).value, thi = table414(hi, fy).value, fr = (o.lam - lo) / (hi - lo);
        var pf = tlo + (thi - tlo) * fr;
        o.interp = { lo: lo, hi: hi, tlo: tlo, thi: thi, frac: fr, phiFcr: pf, phiPn: pf * s.A, same: false };
      }
    }
    o.t41a = null; o.t41aUp = null; o.t41aEq = null;
    if (s.type === 'W' && fy === 50) {
      var rec = idx().t41a[s.label];
      if (rec) {
        if (sameKL(KLx, KLy)) {
          // the same KL both ways: Table 4-1a at that whole-foot row, or at the NEXT row for a KL that is not a whole number of feet
          var KLm = Math.max(KLx, KLy), klw = Math.round(KLm), whole = Math.abs(KLm - klw) < EQ_KL, row0 = whole ? klw : Math.ceil(KLm - EQ_KL);
          if (row0 >= 0 && row0 < rec.p3.length) {
            var ov = overridesOf('table_4_1a'), val = rec.p3[row0], over = null;
            for (var i = 0; i < ov.length; i++) { if (normName(ov[i].shape) === normName(s.label) && ov[i].kl === row0) { val = ov[i].value; over = ov[i]; } }
            var rowRec = { kl: row0, KL: KLm, value: val, exact: rec.p[row0], flag: rec.flag, override: over, rounded: !whole };
            if (whole || (f2 && st.fractional_KL_table === 'next-row')) o.t41a = rowRec;   // the row IS the table answer
            else o.t41aUp = rowRec;                                                      // otherwise only a conservative lookup shown beside the KL/r answer
          }
        } else if (rec.rx_ry) {
          // unequal lengths: convert the strong-axis KL to an equivalent weak-axis length with rx/ry (her HW 6-15) and enter Table 4-1 there
          var eq = KLx / rec.rx_ry, gov = Math.max(KLy, eq), row = Math.ceil(gov - 1e-9);
          if (row >= 0 && row < rec.p3.length) o.t41aEq = { eq: eq, kl: row, value: rec.p3[row], rxry: rec.rx_ry, xGoverns: eq > KLy };
        }
      }
    }
    o.table41a = o.t41a ? o.t41a.value : (o.t41aEq ? o.t41aEq.value : null);
    // the round-up route (Table 4-14 x Ag, or x the E7 effective area when a slender element really is reduced)
    o.roundUp = null; o.roundUpBasis = null;
    if (o.phiPnTab !== null) {
      o.roundUp = o.phiPnTab; o.roundUpBasis = '4-14';
      if (o.phiPnTabE7 !== null && o.phiPnTabE7 < o.phiPnTab) { o.roundUp = o.phiPnTabE7; o.roundUpBasis = '4-14+E7'; }
    }
    // the headline
    var useTable = false;
    if (o.t41a) useTable = (o.purpose === 'select') ? st.select_headline === '4-1a' : st.capacity_headline === '4-1a';
    if (useTable && !o.tooSlender) { o.headline = o.t41a.value; o.basis = '4-1a'; }
    else if (o.roundUp !== null) { o.headline = o.roundUp; o.basis = o.roundUpBasis; }
    else { o.headline = o.exact.phiPn; o.basis = 'exact'; }
    return o;
  }

  // A1: tees, single angles and double angles buckle in a flexural-torsional mode that Spec E4 / E5 cover and this tool does NOT, so the flexural-buckling number is too high.
  var UNRELIABLE = 'NOT RELIABLE for this shape (Spec E4/E5 not applied) -- check the book.';
  // P6: a custom or built-up section (bar, rectangle / plate, W with cover plates) is a flexural-buckling number only: the headline text says so, and it is the first flag
  var CUSTOM_WORDS = 'Flexural-buckling capacity only -- plate slenderness and connector spacing NOT checked (the book\'s solution does not check them either).';
  function markCustomSection(res) {
    var an = res.o.answer;
    if (an) { an.label = 'Column flexural-buckling capacity phi Pn -- NOT FULLY CHECKED (plate slenderness / connectors)'; an.text = CUSTOM_WORDS + '  ' + an.text; }
    res.val('not_fully_checked', 'plate slenderness / connectors', '', 'plate slenderness (Spec E7) and the connector spacing are not checked here (the book\'s solution does not check them either)');
    res.flagFirst('NOTE: ' + CUSTOM_WORDS);
  }
  function unreliableColumnShape(s) { var t = s && s.type; return t === 'WT' || t === 'MT' || t === 'ST' || t === 'L' || t === '2L'; }

  // The element of a columnStrength() result that matches a slenderElements() entry (same key), or null.
  function e7Element(cs, key) {
    if (!cs) return null;
    for (var k = 0; k < cs.elems.length; k++) { if (cs.elems[k].key === key) return cs.elems[k]; }
    return null;
  }

  // One flag per element that is slender by Table B4.1a at Fy.  What it says depends on what the headline did:
  //   a W-shape or rectangular HSS on the Table 4-14 / exact route: Spec E7.1 is applied element by element and an element is reduced only when
  //     lambda > lambda_r sqrt(Fy/Fn) with the UNFACTORED Fn, so the flag says which case happened (reduced and used, or not reduced);
  //   a Table 4-1a headline: the printed value already contains the Manual's E7 reduction;
  //   round HSS, pipe, channels, angles, tees: flagged, not reduced.
  function slenderFlags(res, c, noUnreliable) {
    var s = c.shape, t = s.type, e7able = t === 'W' || isRectHSS(s), ev = c.e7Tab || c.exact, warns = [], notes = [];
    var square = isRectHSS(s) && s['b/tdes'] === s['h/tdes'];   // a square tube: the four walls are one element
    if (!noUnreliable && unreliableColumnShape(s)) res.flagFirst('WARNING: ' + UNRELIABLE + ' ' + (t === 'L' ? 'A single angle' : (t === '2L' ? 'A double angle' : 'A tee')) + ' can also fail by torsional / flexural-torsional buckling (Spec E4' + (t === 'L' ? ', E5' : (t === '2L' ? ', E6' : '')) + ')' + ((t === 'WT' || t === 'MT' || t === 'ST') && c.slender.some(function (x) { return x.key === 'stem'; }) ? ' and its slender stem needs the E7 reduction' : '') + ', which is NOT checked here, so the number below is too high for the real member.');
    c.slender.forEach(function (x) {
      if (square && x.key === 'wide') return;                      // reported with the narrow walls
      var what = square ? 'walls (b/tdes = h/tdes)' : x.element;
      var head = s.label + ' has a SLENDER ' + what + ' in compression (' + n(x.lam, 2) + ' > ' + n(x.limit, 2) + ' at Fy ' + c.fy + ')';
      var el = e7able ? e7Element(ev, x.key) : null;
      if (!e7able) {
        warns.push('WARNING: ' + head + ': the plain "stress x gross area" is too high and the tool does not reduce it (Spec E7 is applied to W-shapes and rectangular HSS only). CHECK THE BOOK.');
      } else if (c.basis === '4-1a') {
        notes.push('NOTE: ' + head + '. Table 4-1a, which is the answer here, already contains the Manual\'s E7 reduction for this shape (the Manual marks it with a footnote).');
      } else if (el && el.reduced) {
        var used = c.basis === '4-14+E7' || c.basis === 'exact';
        warns.push('WARNING: ' + head + ': the plain "stress x gross area" is too high. At Fn = ' + n(ev.fcr, 2) + ' ksi Spec E7.1 cuts the ' + (square ? 'walls' : el.name) + ' to an effective width of ' + n(el.be, 3) + ' in (of ' + n(el.b, 3) + ' in), so the effective area is ' + n(ev.ae, 3) + ' in^2 (from ' + n(c.A, 3) + ')' + (used ? ' and the tool used it.' : ', but that is smaller than the 3-figure rounding of Table 4-14, so the table value stands.') + ' CHECK THE BOOK (the Manual marks these shapes with a footnote).');
      } else if (el) {
        notes.push('NOTE: ' + head + ', but at this KL/r the nominal stress Fn = ' + n(ev.fcr, 2) + ' ksi is low enough that Spec E7.1 does not reduce it (lambda ' + n(el.lam, 2) + ' <= lambda_r sqrt(Fy/Fn) = ' + n(el.limit, 2) + '), so Ae = Ag and the plain value stands. The Manual still marks this shape with a footnote -- check the book.');
      } else {
        notes.push('NOTE: ' + head + ', but the database has no ratio to apply Spec E7.1 to, so the plain value stands -- check the book.');
      }
    });
    warns.concat(notes).forEach(function (f) { res.flag(f); });   // a reduction that was applied is the first thing to read
    if (isRectHSS(s)) res.flag('NOTE: rectangular HSS are done by E3 on the gross area (as she does), then Spec E7.1 reduces any slender wall (checked wall by wall with the design thickness).' + (c.slender.length ? '' : ' No wall is slender here.'));
    else if (t === 'HSS' || t === 'PIPE') res.flag('NOTE: round HSS and pipe are done by E3 on the gross area (as she does); wall slenderness is only flagged (the Spec E7.2 reduction is not built) -- check the book if thin-walled.');
  }

  // where Table 4-1a was read: "KL = 24 ft", or "KL = 15.2 ft read at the 16-ft row" for a KL that is not a whole number of feet
  function t41aWhere(t) { return 'KL = ' + n(t.KL, 3) + ' ft' + (t.rounded ? ' read at the ' + t.kl + '-ft row' : ''); }

  // The worked text of Spec E7.1 for one columnStrength() result (a W-shape or a rectangular HSS), in the order the Design Examples (E.1E, E.10) print it.
  function e7WorkText(s, cs, klr, fy) {
    var els = cs.elems, parts = [], loss = [], k, e;
    if (isRectHSS(s) && els.length === 2 && els[0].lam === els[1].lam) {   // a square tube: all four walls are the same
      e = els[0];
      els = [{ name: 'all four walls (b/t = h/t)', lam: e.lam, limit: e.limit, lamR: e.lamR, c2: e.c2, fel: e.fel, b: e.b, be: e.be, count: 4, t: e.t, reduced: e.reduced }];
    }
    for (k = 0; k < els.length; k++) {
      e = els[k];
      if (e.reduced) {
        parts.push(e.name + ': lambda ' + n(e.lam, 1) + ' > ' + n(e.limit, 1) + ', so Fel = (' + n(e.c2, 2) + ' x ' + n(e.lamR, 2) + ' / ' + n(e.lam, 1) + ')^2 (' + n(fy, 3) + ') = ' + n(e.fel, 2) + ' ksi and the effective width is ' + n(e.be, 3) + ' in (of ' + n(e.b, 3) + ' in)');
        loss.push(e.count + ' (' + n(e.b, 3) + ' - ' + n(e.be, 3) + ') (' + n(e.t, 3) + ')');
      } else parts.push(e.name + ': lambda ' + n(e.lam, 1) + ' <= ' + n(e.limit, 1) + ', full width');
    }
    return 'Slender elements, Spec E7.1 at KL/r ' + klr + ': the nominal stress is Fn = ' + n(cs.fcr, 2) + ' ksi (E3, no phi) and an element is reduced only if lambda > lambda_r sqrt(Fy/Fn) -- ' + parts.join('; ') + '.  Ae = ' + n(s.A, 4) + ' - ' + loss.join(' - ') + ' = ' + n(cs.ae, 3) + ' in^2.  phi Pn = 0.90 (' + n(cs.fcr, 2) + ') (' + n(cs.ae, 3) + ') = ' + n(cs.phiPn, 1) + ' kips.';
  }

  // KL (ft) for one axis from the many ways of giving it
  function axisKL(label, end, L, KLdirect, segments, res) {
    var strong = label === 'Strong axis', nmEnd = (strong ? 'x' : 'y') + '_end_condition', nmL = (strong ? 'Lx' : 'Ly') + '_ft', nmKL = (strong ? 'KLx' : 'KLy') + '_ft';
    var hasSeg = !!(segments && segments.length), hasKL = isNum(KLdirect), hasEnd = !isBlank(end), hasL = isNum(L);
    // the same axis given two ways is refused (or the unused part is named), never resolved silently
    if (hasSeg && (hasKL || hasEnd || hasL)) fail('AMBIGUOUS', label + ' was given more than one way: braced in segments AND ' + (hasKL ? 'KL typed directly (' + nmKL + ')' : 'an end condition / length (' + nmEnd + ', ' + nmL + ')') + '. Use one: each segment already has its own length and end condition.');
    if (hasKL && hasEnd && hasL) {
      var kk0 = kFor(end);
      if (Math.abs(kk0.K * L - KLdirect) > 1e-6 * Math.max(1, KLdirect)) fail('AMBIGUOUS', label + ': the effective length was given two ways that disagree. KL typed directly (' + nmKL + ') = ' + n(KLdirect, 3) + ' ft, but the end condition (K = ' + n(kk0.K, 2) + ') x the member length (' + nmL + ' = ' + n(L, 3) + ' ft) = ' + n(kk0.K * L, 3) + ' ft. Use one.');
    } else if (hasKL && (hasEnd || hasL)) res.flag('NOTE: ' + label + ': KL was typed directly (' + nmKL + '), so the ' + (hasEnd ? 'end condition (' + nmEnd + ')' : 'member length (' + nmL + ')') + ' was NOT used.');
    if (!hasSeg && !hasKL && hasEnd !== hasL) fail('MISSING', hasEnd ? 'Missing: the ' + label.toLowerCase() + ' member length (' + nmL + '). You gave its end condition, which only gives K; the effective length is K x L. (Or type KL directly in ' + nmKL + '.)' : 'Missing: the ' + label.toLowerCase() + ' end condition (' + nmEnd + '), which gives K. You gave the member length (' + nmL + ') only. (Or type KL directly in ' + nmKL + '.)');
    if (segments && segments.length) {
      var best = -1, rows = [], i;
      for (i = 0; i < segments.length; i++) {
        var seg = segments[i], k = kFor(endConditionId(seg.end_condition || 'pinned-pinned')), kl = k.K * seg.length_ft;
        rows.push('segment ' + (i + 1) + ': K ' + n(k.K, 2) + ' x ' + n(seg.length_ft, 3) + ' ft = ' + n(kl, 3) + ' ft');
        if (kl > best) best = kl;
      }
      res.step(label + ' braced in ' + segments.length + ' segments -- ' + rows.join('; ') + '. The longest KL governs: KL' + label.charAt(0).toLowerCase() + ' = ' + n(best, 3) + ' ft.', SRC.ca71);
      return best;
    }
    if (isNum(KLdirect)) { res.step(label + ': KL = ' + n(KLdirect, 3) + ' ft (given).', SRC.given); return KLdirect; }
    if (end && isNum(L)) {
      var kk = kFor(end);
      res.step(label + ': ' + kk.label + ' -> K = ' + n(kk.K, 2) + '; KL = ' + n(kk.K, 2) + ' x ' + n(L, 3) + ' = ' + n(kk.K * L, 3) + ' ft.', SRC.ca71);
      return kk.K * L;
    }
    return null;
  }

  // The weak axis.  With an end condition but NO Ly (and no KLy, no segments) there are no intermediate braces: the full member length Lx is
  // used with the weak-axis end condition (so the weak-axis K is not lost), and the note says so.
  function weakAxisKL(a, res) {
    var L = a.Ly_ft, usedLx = false;
    // only when the strong axis itself is given as end condition + Lx (if KLx was typed directly, Lx is not used for the strong axis)
    if (!isNum(L) && !isNum(a.KLy_ft) && !(a.y_segments && a.y_segments.length) && !isBlank(a.y_end_condition) && isNum(a.Lx_ft) && !isBlank(a.x_end_condition) && !isNum(a.KLx_ft)) { L = a.Lx_ft; usedLx = true; }
    var kl = axisKL('Weak axis', a.y_end_condition, L, a.KLy_ft, a.y_segments, res);
    if (usedLx) res.flag('NOTE: no weak-axis length Ly was given, so the full member length Lx = ' + n(a.Lx_ft, 3) + ' ft was used (no intermediate braces) with the weak-axis end condition.');
    return kl;
  }

  var AXIS_FIELDS = [
    F('x_end_condition', 'endcond', 'Strong axis (x): end conditions (gives K)', '', { values: END_CONDITIONS.map(function (e) { return { value: e.id, label: e.label }; }) }),
    F('Lx_ft', 'number', 'Strong-axis member length Lx (a problem may print it as Lc) -- the tool multiplies it by K', 'ft', { min: 0 }),
    F('KLx_ft', 'number', 'OR the effective length KxLx directly', 'ft', { min: 0 }),
    F('y_end_condition', 'endcond', 'Weak axis (y): end conditions (gives K)', '', { values: END_CONDITIONS.map(function (e) { return { value: e.id, label: e.label }; }) }),
    F('Ly_ft', 'number', 'Weak-axis unbraced length Ly -- braces perpendicular to the weak axis shorten only this one; the tool multiplies it by K', 'ft', { min: 0 }),
    F('KLy_ft', 'number', 'OR the effective length KyLy directly', 'ft', { min: 0 }),
    F('y_segments', 'list', 'OR the weak axis braced in segments (each with its own length and end conditions)', '', {
      item: [F('length_ft', 'number', 'segment length', 'ft', { required: true, min: 0, minExclusive: true }), F('end_condition', 'endcond', 'segment end conditions', '', { default: 'pinned-pinned' })]
    })
  ];

  def('column_euler', 'Column', 'Euler buckling load', 'Pcr = pi^2 E I / (KL)^2, i.e. Fe = pi^2 E / (KL/r)^2 and Pcr = Fe x A. Valid only in the elastic range KL/r > 4.71 sqrt(E/Fy); the AISC design strength is shown for comparison ("what is missing in Euler?"). Give a shape, or A and r, or a custom section (solid round bar, rectangle / plate, W with cover plates). With the PROPORTIONAL LIMIT typed (the book way) Euler applies only if Fe <= that limit and KL/r <= 200: otherwise the answer IS the verdict "does not apply", and the formula number is shown only as what it "would give".', [
    F('shape', 'shape', 'Shape (gives A and the weak-axis r), or enter A and r below, or a custom section', ''),
    F('A', 'number', 'Area A (if no shape)', 'in^2', { min: 0, minExclusive: true }),
    F('r', 'number', 'Radius of gyration r of the buckling axis (if no shape)', 'in', { min: 0, minExclusive: true }),
    F('K', 'number', 'K (pinned-pinned = 1.0)', '', { default: 1, min: 0, minExclusive: true }),
    F('L_ft', 'number', 'Length L', 'ft', { required: true, min: 0, minExclusive: true }),
    F('Fy', 'number', 'Fy (only for the validity check and the AISC comparison)', 'ksi', { default: 50, min: 1, minExclusive: true })
  ].concat(SECTION_FIELDS).concat([
    F('proportional_limit_ksi', 'number', 'Proportional limit -- the BOOK way ("Proportional limit = 36,000 psi"): Euler applies only if Fe <= this and KL/r <= 200. Blank = the AISC 4.71 sqrt(E/Fy) check only', 'ksi', { min: 1, minExclusive: true })
  ]), function (a, res) {
    var A = a.A, r = a.r, label = 'the member', s = null;
    var base = isBlank(a.shape) ? null : useShape(res, findShape(a.shape));
    var sec = sectionFromArgs(a, res, base);
    if (sec) {
      noteUnused(res, a, ['A', 'r'], 'a custom section was given (its own A and r come from the section steps)');
      sec.steps.forEach(function (st) { res.step(st, 'Section properties (mechanics: A, I = I_own + A d^2, r = sqrt(I/A))'); });
      A = sec.A; r = sec.rmin; label = sec.label;
      res.step('Buckling about the weak axis: r = r_min = ' + n(r, 4) + ' in (the smaller of rx = ' + n(sec.rx, 4) + ' and ry = ' + n(sec.ry, 4) + ').  A = ' + n(A, 4) + ' in^2.', 'Section properties');
    } else if (base) {
      s = base;
      noteUnused(res, a, ['A', 'r'], 'a shape was given (its own A and r come from the Manual)');
      A = s.A; r = Math.min(s.rx, s.ry); label = s.label;
      var angleZ = s.type === 'L' && isNum(s.rz);
      if (angleZ) r = Math.min(r, s.rz);
      res.step('Properties from the Manual: ' + s.label + ': A = ' + n(A, 4) + ' in^2; r = ' + n(r, 4) + ' in (the smaller of rx = ' + n(s.rx, 3) + ' and ry = ' + n(s.ry, 3) + (angleZ ? ' and, for a single angle, rz = ' + n(s.rz, 3) + ' -- the minor principal axis' : '') + ' -- the weak axis buckles first).', SRC.shapes);
    } else {
      if (!isNum(A) || !isNum(r)) fail('MISSING', 'Enter a shape, or both A and r, or a custom section (a solid round bar, a rectangle / plate, or a W with cover plates).');
      res.step('Given: A = ' + n(A, 4) + ' in^2, r = ' + n(r, 4) + ' in.', SRC.given);
    }
    var KL = a.K * a.L_ft, lam = 12 * KL / r;
    res.step('Effective length KL = ' + n(a.K, 3) + ' x ' + n(a.L_ft, 3) + ' = ' + n(KL, 3) + ' ft;  KL/r = 12 x ' + n(KL, 3) + ' / ' + n(r, 4) + ' = ' + n(lam, 2) + '.', SRC.ca71);
    var fe = feEuler(lam), pcr = fe * A;
    res.step('Euler stress Fe = pi^2 E / (KL/r)^2 = pi^2 (29000) / ' + n(lam, 2) + '^2 = ' + n(fe, 3) + ' ksi.', 'Euler (Spec E3 elastic buckling)');
    res.step('Pcr = Fe x A = ' + n(fe, 3) + ' x ' + n(A, 4) + ' = ' + n(pcr, 2) + ' kips.  (No phi, no safety factor, no material strength.)', 'Euler');
    // the book check (proportional limit typed): the VERDICT is the headline.  The AISC 4.71 sqrt(E/Fy) line is a second check and the design-strength alternative uses the same Fy.
    // The proportional limit is NOT a yield stress: with it typed and no Fy, the section's own default Fy is used when there is one, and the Fy that IS used is always SAID (fyWhy).
    var fpl = isNum(a.proportional_limit_ksi) ? a.proportional_limit_ksi : null, no = null, fyChk, fyWhy;
    if (res.gave('Fy')) { fyChk = a.Fy; fyWhy = 'Fy = ' + n(fyChk, 3) + ' ksi (typed)'; }
    else if (fpl !== null) {
      var fyDef = null, fyDefWhat = '';
      if (base) { fyDef = defaultFy(base); fyDefWhat = 'the default of ' + base.label + ', ' + (((materialFor(base.type) || {}).spec) || 'default') + ', her slide'; }
      else if (sec) { fyDef = plateMaterial().Fy; fyDefWhat = 'a bar or plate is A36 by her slide'; }
      if (sec && sec.plateFy !== null && fyDef !== null && sec.plateFy < fyDef) { fyDef = sec.plateFy; fyDefWhat = 'the LOWER of the shape and the plates (the plate Fy typed)'; }
      if (fyDef !== null) { fyChk = fyDef; fyWhy = 'Fy = ' + n(fyChk, 3) + ' ksi (' + fyDefWhat + '; no Fy was typed; type Fy to change)'; }
      else { fyChk = null; fyWhy = 'the AISC check is NOT made: no section default exists and no Fy was typed, and the proportional limit is not a yield stress -- type Fy for the AISC comparison'; }
    } else { fyChk = a.Fy; fyWhy = 'Fy = ' + n(fyChk, 3) + ' ksi (the default; no Fy was typed; type Fy to change)'; }
    var lim = fyChk === null ? null : limit471(fyChk), valid = fyChk === null ? null : lam > lim;
    if (fpl !== null) {
      if (lam > 200 + 1e-9) no = 'KL/r = ' + n(lam, 1) + ' exceeds the recommended limit KL/r = 200 -- the book treats Euler / AISC as not applicable';
      else if (fe > fpl + 1e-9) no = 'the Euler stress Fe = ' + n(fe, 2) + ' ksi is ABOVE the proportional limit ' + n(fpl, 2) + ' ksi (the column is no longer elastic when it buckles)';
      res.step('The BOOK check: Euler applies only if Fe <= the proportional limit (' + n(fpl, 2) + ' ksi) and KL/r <= 200.  Fe = ' + n(fe, 2) + ' ksi, KL/r = ' + n(lam, 2) + ' -> ' + (no ? 'Euler is NOT applicable.' : 'Euler applies.'), 'Book: Euler needs Fe <= the proportional limit and KL/r <= 200');
    }
    if (fyChk === null) res.step('Second check (AISC): ' + fyWhy + '.', SRC.e3);
    else if (fpl !== null) res.step('Second check (AISC): AISC check with ' + fyWhy + '. By the AISC boundary 4.71 sqrt(E/Fy) = ' + n(lim, 1) + ', KL/r = ' + n(lam, 2) + ' is in the ' + (valid ? 'elastic' : 'inelastic') + ' range. This is a second check only: the problem\'s own test (proportional limit) is the one answered above.', SRC.e3);
    else res.step('Second check (AISC): AISC check with ' + fyWhy + '. Euler is valid only if KL/r > 4.71 sqrt(E/Fy) = ' + n(lim, 1) + '. KL/r = ' + n(lam, 2) + ' -> ' + (valid ? 'elastic: Euler is valid.' : 'NOT valid.'), SRC.e3);
    res.val('KL_over_r', lam, '').val('Fe', fe, 'ksi');
    if (fyChk !== null) res.val('limit', lim, '', SRC.e3).val('Fy_AISC_check', fyChk, 'ksi', fyWhy);
    if (fpl !== null) res.val('proportional_limit', fpl, 'ksi').val('applicable', !no, '');
    if (no) res.val('Pcr_would_give', pcr, 'kips'); else res.val('Pcr', pcr, 'kips');
    var fcr = fyChk === null ? null : fcrE3(lam, fyChk), design = fyChk === null ? null : 0.9 * fcr * A;
    if (no) {
      res.answer('Euler verdict', null, '', 'Euler does NOT apply: ' + no + '.  (The formula would give Pcr = ' + n(pcr, 2) + ' kips, but that number is not an answer here.)');
      res.alt('what the Euler formula would give (NOT valid here)', pcr, 'kips', 'Pcr = Fe x A = ' + n(fe, 3) + ' x ' + n(A, 4) + ' = ' + n(pcr, 2) + ' kips -- do not write this as the answer');
    } else {
      res.answer('Euler critical load Pcr', pcr, 'kips', 'Pcr = ' + n(pcr, 2) + ' kips  (Fe = ' + n(fe, 3) + ' ksi, KL/r = ' + n(lam, 2) + ')' + (fpl !== null ? '  -- Euler applies (Fe <= the proportional limit ' + n(fpl, 2) + ' ksi, KL/r <= 200)' : (valid ? '' : '  -- NOT VALID here')));
    }
    if (fyChk !== null) res.alt('AISC design strength phi Pn (E3, what the tables use)' + (s && unreliableColumnShape(s) ? ' -- NOT RELIABLE for this shape (E4/E5 not applied)' : ''), design, 'kips', 'AISC check with ' + fyWhy + ': phi Pn = 0.90 x Fcr x A = 0.90 x ' + n(fcr, 3) + ' x ' + n(A, 4) + ' = ' + n(design, 2) + ' kips (inelastic buckling and the safety factor are what Euler leaves out)');
    if (s) {
      var Imin = Math.min(s.Ix, s.Iy);
      if (s.type === 'L' && isNum(s.Iz)) Imin = Math.min(Imin, s.Iz);   // a single angle: the minor principal axis z
      var pI = Math.PI * Math.PI * E_STEEL * Imin / Math.pow(12 * KL, 2);
      res.alt('pi^2 E I / (KL)^2 with the tabulated I', pI, 'kips', 'differs slightly because the tabulated r is rounded');
    }
    if (s && fyChk !== null && !res.gave('Fy')) roundHssNote(res, s, fyChk);
    if (fpl !== null && !res.gave('Fy')) res.flag(fyChk === null ? 'NOTE: the AISC check (4.71 sqrt(E/Fy)) and the AISC design-strength alternative were NOT made: no Fy was typed and the proportional limit is not a yield stress. Type Fy for the AISC comparison.' : 'NOTE: AISC check with ' + fyWhy + '.');
    if (no) res.flag('WARNING: ' + no.charAt(0).toUpperCase() + no.slice(1) + '. The answer is the verdict; the formula number is only what it "would give".');
    // P8-7: the headline is the BOOK verdict (Euler applies): the AISC boundary is a secondary NOTE and never contradicts it
    else if (fpl !== null && valid === false) res.flag('NOTE: By the AISC boundary 4.71 sqrt(E/Fy) (Fy = ' + n(fyChk, 3) + ' ksi), this slenderness is in the inelastic range; the problem\'s own test (proportional limit) is the one answered above. (AISC boundary = ' + n(lim, 1) + ', KL/r = ' + n(lam, 2) + '. The AISC design strength is shown as an alternative; a question that asks for the AISC column capacity is Column > Capacity.)');
    else if (valid === false) res.flag('WARNING: KL/r = ' + n(lam, 2) + ' is below ' + n(lim, 1) + ': the column crushes / buckles inelastically BEFORE the Euler load. Euler is unconservative here -- use Column > Capacity.');
    else res.flag('NOTE: Euler is elastic only. What is missing from it: the material strength, inelastic buckling at low KL/r, and phi.');
    if (lam > 200 && !no) res.flag('WARNING: KL/r above 200: it exceeds the recommended limit KL/r = 200 (Spec E2 user note); the book treats Euler / AISC as not applicable.');
    if (sec && (sec.kind === 'faces' || sec.kind === 'tips')) res.flag('NOTE: built-up section: the plate slender-element check and the connector spacing are not done (the book\'s solution does not do them).');
    return res;
  });

  // R2-2 + P7-2: the optional load of a column capacity.  ORDINARY shapes: "adequate: phi Pn >= Pu?" for the headline AND for every ROUTE beside it.  A route is an alternative
  // that the code marked adequacyRoute: true (it is never found by its label); an alternative marked referenceOnly (the plain table x Ag of a slender shape, a row read DOWN) gets NO
  // YES / NO anywhere.  The routes can disagree (Table 4-1a 499 kips against the exact E3 520 at Pu 507): each one is answered, the headline is her method.  FENCED (a NOT RELIABLE
  // tee / angle, or a custom / built-up section): ONE flexural-buckling-only comparison of the headline number, "NOT an adequacy verdict", never a generic "adequate".
  // The capacity itself is never touched.  Returns { text } (it goes on the headline).
  function columnAdequacy(res, ld, headlineLabel, headline, fence) {
    var Pu = ld.Pu, alts = res.o.alternatives, routes = [{ label: headlineLabel + ' (the headline)', value: headline }], rows = [], parts = [], differ = [], i, okHead = headline + 1e-9 >= Pu;
    if (fence) {
      var dq = 1;
      while (dq < 6 && Math.abs(headline - Pu) > 1e-12 && n(headline, dq) === n(Pu, dq)) dq++;   // never "47.8 < 47.8"
      if (Math.abs(headline - Pu) < 0.05 && dq < 3) dq = 3;
      var qText = 'Flexural-buckling-only comparison: ' + (fence.reference ? 'reference phi Pn ' : 'phi Pn ') + n(headline, dq) + ' >= Pu ' + n(Pu, dq) + '? (NOT an adequacy verdict -- ' + fence.why + ')';
      var rel = n(headline, dq) + (okHead ? ' >= ' : ' < ') + n(Pu, dq);
      res.step(qText + '.  The relation is ' + rel + ' kips.', SRC.lrfd);
      res.val('Pu', Pu, 'kips', SRC.lrfd).val('flexural_only_comparison', rel, 'kips', 'Flexural-buckling-only comparison: ' + (fence.reference ? 'reference phi Pn' : 'phi Pn') + ' >= Pu? (NOT an adequacy verdict -- ' + fence.why + ')');
      return { text: qText };
    }
    for (i = 0; i < alts.length; i++) { if (alts[i].adequacyRoute === true && alts[i].unit === 'kips' && typeof alts[i].value === 'number') routes.push({ label: alts[i].label, value: alts[i].value, alt: alts[i] }); }
    // a reference-only alternative (marked by the code, never found by its label) is NOT compared with Pu: it says so and carries no YES / NO
    for (i = 0; i < alts.length; i++) { if (alts[i].referenceOnly === true) alts[i].text = (alts[i].text ? alts[i].text + ' ' : '') + '[shown for reference only -- not compared with Pu]'; }
    routes.forEach(function (r) {
      var ok = r.value + 1e-9 >= Pu;
      rows.push([r.label, Math.round(r.value * 100) / 100, Math.round(Pu * 100) / 100, ok ? 'YES' : 'NO']);
      parts.push(r.label + ': ' + n(r.value, 4) + (ok ? ' >= ' : ' < ') + n(Pu, 4) + ' -> ' + (ok ? 'YES' : 'NO'));
      if (r.alt) r.alt.text = (r.alt.text ? r.alt.text + ' -- ' : '') + 'adequate: phi Pn >= Pu? ' + (ok ? 'YES' : 'NO') + ' (' + n(r.value, 4) + (ok ? ' >= ' : ' < ') + n(Pu, 4) + ')';
      if (ok !== okHead) differ.push(r.label + ' ' + (ok ? 'YES' : 'NO'));
    });
    res.step('Adequate: phi Pn >= Pu?  Pu = ' + n(Pu, 4) + ' kips.  ' + parts.join(';  ') + '.', SRC.lrfd);
    res.table('Adequate: phi Pn >= Pu?', ['Route', 'phi Pn, kips', 'Pu, kips', 'phi Pn >= Pu?'], rows);
    res.val('Pu', Pu, 'kips', SRC.lrfd).val('adequate', okHead, '');
    if (!okHead) res.flag('WARNING: the column is NOT adequate: ' + headlineLabel + ' phi Pn = ' + n(headline, 4) + ' kips < Pu = ' + n(Pu, 4) + ' kips.');
    if (differ.length) res.flag('CHECK: the routes disagree about adequacy at Pu = ' + n(Pu, 4) + ' kips: the headline (' + headlineLabel + ') says ' + (okHead ? 'YES' : 'NO') + ', but ' + differ.join('; ') + '. The headline is her method; read the table above before you write the verdict.');
    return { text: 'adequate: phi Pn >= Pu? ' + (okHead ? 'YES' : 'NO') + ' (' + n(headline, 4) + (okHead ? ' >= ' : ' < ') + n(Pu, 4) + ' kips)' + (differ.length ? ' -- the other routes disagree: see the table' : '') };
  }

  def('column_capacity', 'Column', 'Capacity of a given column', 'phi Pn of a shape, or of a CUSTOM section (a solid round bar, a rectangle / plate, a W with two cover plates on the flange faces or at the flange tips; ONE Fy, the lower of the two when a plate Fy differs). Same KL both ways on a W-shape at Fy 50: Table 4-1a is the headline (her 9/30 review), a KL that is not a whole number of feet read at the next whole-foot row. Otherwise (different lengths, other shapes or Fy): KL/r about both axes, the larger governs, ROUND IT UP, phi Fcr from Table 4-14 for Fy, times the gross area (her way); a slender W-shape or rectangular HSS uses the Spec E7.1 effective area. The other routes (KL/r, interpolation, exact E3) are always shown beside the headline.', [
    F('shape', 'shape', 'Column shape (for a W with cover plates: the W under the plates)', ''),
    F('Fy', 'number', 'Fy (blank = from the shape family: W 50, HSS 50, pipe 35 ...)', 'ksi', { min: 1, minExclusive: true })
  ].concat(SECTION_FIELDS).concat(AXIS_FIELDS).concat(LOAD_FIELDS('kips')), function (a, res) {
    var base = isBlank(a.shape) ? null : useShape(res, findShape(a.shape));
    var sec = sectionFromArgs(a, res, base);
    if (!base && !sec) fail('MISSING', 'Enter a column shape (for example W14x90), or a custom section: a solid round bar (bar_dia_in), a solid rectangle or plate (rect_b_in and rect_t_in), or a W with cover plates (shape + plate_t_in + plate_b_in for the flange faces, or plate_h_in for the flange tips).');
    var s = sec ? sec.s : base;
    // ONE Fy for the whole section: the typed Fy, else the shape's (a bar or plate: A36 by her slide); a plate Fy that differs gives the LOWER of the two
    var fy = isNum(a.Fy) ? a.Fy : (base ? defaultFy(base) : plateMaterial().Fy), fyNote = '';
    if (sec) {
      sec.steps.forEach(function (st) { res.step(st, 'Section properties (mechanics: A, I = I_own + A d^2, r = sqrt(I/A))'); });
      if (sec.plateFy !== null && Math.abs(sec.plateFy - fy) > 1e-9) {
        fyNote = 'ONE Fy is used for the whole built-up section: the LOWER of the shape (' + n(fy, 3) + ' ksi) and the plates (' + n(sec.plateFy, 3) + ' ksi) = ' + n(Math.min(fy, sec.plateFy), 3) + ' ksi (conservative: the stronger steel gets no credit).';
        fy = Math.min(fy, sec.plateFy);
        res.flag('NOTE: ' + fyNote);
      }
      if (!base && !isNum(a.Fy)) res.flag('NOTE: a bar or plate is A36 by her slide (Fy 36); type Fy for another grade.');
    }
    res.step('Given: ' + s.label + ', Fy = ' + n(fy, 3) + ' ksi' + (fyNote ? ' (' + fyNote + ')' : (isNum(a.Fy) ? ' (given).' : (sec && !base ? ' (A36 bar / plate, her slide).' : ' (' + ((materialFor((base || s).type) || {}).spec || 'default') + ', her slide).'))) + '  ' + (sec ? 'From the section above: ' : 'From the Manual: ') + 'Ag = ' + n(s.A, 4) + ' in^2, rx = ' + n(s.rx, 3) + ' in, ry = ' + n(s.ry, 3) + ' in' + (s.type === 'L' && isNum(s.rz) ? ', rz = ' + n(s.rz, 3) + ' in' : '') + '.', sec ? 'Section properties' : SRC.shapes);
    if (sec && (sec.kind === 'faces' || sec.kind === 'tips')) res.flag('NOTE: built-up section: the plate slender-element check and the connector spacing are not done (the book\'s solution does not do them).');
    var klx = axisKL('Strong axis', a.x_end_condition, a.Lx_ft, a.KLx_ft, null, res);
    var kly = weakAxisKL(a, res);
    if (klx === null && kly === null) fail('MISSING', 'Enter the effective length: KxLx and KyLy (or K from the end conditions and the member length L).');
    if (klx === null) { klx = kly; res.flag('NOTE: no strong-axis length was given; the weak-axis KL was used for both axes.'); }
    if (kly === null) { kly = klx; res.flag('NOTE: no weak-axis length was given; the strong-axis KL was used for both axes (no braces).'); }
    var c = columnCore(s, klx, kly, fy, 'capacity', true);
    res.step('KL/r about each axis:  x: 12 (' + n(klx, 3) + ') / ' + n(s.rx, 3) + ' = ' + n(c.lx, 2) + ';   y: 12 (' + n(kly, 3) + ') / ' + n(s.ry, 3) + ' = ' + n(c.ly, 2) + (c.lz !== null ? ';   z (the minor principal axis of a single angle, r = rz = ' + n(c.rmin, 3) + '): 12 (' + n(Math.max(klx, kly), 3) + ') / ' + n(c.rmin, 3) + ' = ' + n(c.lz, 2) : '') + '.   KL/r |max = ' + n(c.lam, 2) + ' (' + c.gov + '-axis governs).', 'Her strategy: calculate all possible slenderness ratios; the maximum gives the capacity');
    res.val('Ag', s.A, 'in^2', SRC.shapes).val('rx', s.rx, 'in', SRC.shapes).val('ry', s.ry, 'in', SRC.shapes).val('Fy', fy, 'ksi', SRC.mat);
    res.val('KLx', klx, 'ft').val('KLy', kly, 'ft').val('KL_over_r_x', c.lx, '').val('KL_over_r_y', c.ly, '');
    if (c.lz !== null) res.val('rz', c.rmin, 'in', SRC.shapes).val('KL_over_r_z', c.lz, '');
    res.val('KL_over_r', c.lam, '').val('governing_axis', c.gov, '');
    var plateAxes = !!(sec && sec.kind === 'rect' && Math.abs(a.rect_b_in - a.rect_t_in) > 1e-9);
    if (plateAxes) {
      // the boxes are named for a W-shape; for a plate they are the THIN and the WIDE direction, and which is which depends on the two dimensions typed
      var thinX = s.rx <= s.ry, dThin = Math.min(a.rect_b_in, a.rect_t_in), dWide = Math.max(a.rect_b_in, a.rect_t_in), difKL = !sameKL(klx, kly), thinGov = (c.gov === 'x') === thinX;
      res.flag((difKL ? 'CHECK' : 'NOTE') + ': PLATE / RECTANGLE: ' + (thinX
        ? 'the x axis is the THIN direction (it buckles through the thickness t = ' + n(dThin, 4) + ' in: r = t / sqrt(12) = ' + n(dThin / Math.sqrt(12), 4) + ' in) and the y axis the WIDE direction (r = b / sqrt(12) = ' + n(dWide / Math.sqrt(12), 4) + ' in)'
        : 'the y axis is the THIN direction (the typed width b = ' + n(dThin, 4) + ' in is the smaller dimension: r = b / sqrt(12) = ' + n(dThin / Math.sqrt(12), 4) + ' in) and the x axis the WIDE direction (r = t / sqrt(12) = ' + n(dWide / Math.sqrt(12), 4) + ' in)') +
        '. The boxes are named for a W-shape: for this plate the "' + (thinX ? 'strong axis (x)' : 'weak axis (y)') + '" boxes are the THIN direction (' + (thinX ? 'KxLx' : 'KyLy') + ' = ' + n(thinX ? klx : kly, 3) + ' ft was used with it) and the "' + (thinX ? 'weak axis (y)' : 'strong axis (x)') + '" boxes the WIDE direction (' + (thinX ? 'KyLy' : 'KxLx') + ' = ' + n(thinX ? kly : klx, 3) + ' ft). The ' + (thinGov ? 'THIN' : 'WIDE') + ' direction governs (KL/r: x ' + n(c.lx, 1) + ', y ' + n(c.ly, 1) + ').' + (difKL ? ' You typed DIFFERENT lengths for the two axes: check that the length of the thin direction is in the right boxes.' : ''));
    }
    if (c.t41a && c.basis !== '4-1a') {
      res.flag('CHECK: KL is the same both ways, so the Manual\'s column table (Table 4-1a) gives ' + n(c.t41a.value, 0) + ' kips for ' + s.label + ' at ' + t41aWhere(c.t41a) + '. The KL/r route below gives ' + n(c.roundUp !== null ? c.roundUp : c.phiPnTab, 1) + ' (KL/r is rounded up first). If the question says to look it up in the column tables, write ' + n(c.t41a.value, 0) + '.');
    }
    slenderFlags(res, c);
    roundHssNote(res, s, fy);
    if (c.lz !== null) res.flag('NOTE: single angle: the minor principal axis z governs the slenderness (r = rz = ' + n(c.rmin, 3) + ' in, the smallest radius of gyration the Manual lists), not rx / ry. The Spec E5 rules for single-angle struts (end eccentricity, truss web members) are NOT applied -- check the book.');
    if (c.tooSlender) {
      res.flag('WARNING: KL/r = ' + n(c.lam, 2) + ' is above 200, the limit for compression members (Spec E2 user note). Table 4-14 stops at 200. The exact E3 value is given for reference only.');
      if (unreliableColumnShape(s)) res.val('reference_phiPn_flexural_only', c.exact.phiPn, 'kips', 'E3 flexural buckling only (reference)');
      res.answer(unreliableColumnShape(s) ? 'Column capacity phi Pn -- NOT RELIABLE (E4/E5 not applied)' : 'Column capacity phi Pn', c.exact.phiPn, 'kips', (unreliableColumnShape(s) ? UNRELIABLE + '  Reference value: ' : '') + 'phi Pn = ' + n(c.exact.phiPn, 1) + ' kips (exact E3) -- KL/r ' + n(c.lam, 1) + ' EXCEEDS 200');
      var ldS = loadFromArgs(a, res);
      if (ldS) {
        var naText = 'NOT ACCEPTABLE: KL/r = ' + n(c.lam, 2) + ' exceeds 200 (a strength comparison does not apply)';
        res.step(naText + '.  (The exact E3 value ' + n(c.exact.phiPn, 4) + ' kips is for reference only; Pu = ' + n(ldS.Pu, 4) + ' kips.)', SRC.e2);
        res.val('Pu', ldS.Pu, 'kips', SRC.lrfd).val('not_acceptable_KL_over_r', 'NOT ACCEPTABLE', '', naText);
        res.o.answer.text += '  --  ' + naText;
        res.flag('WARNING: ' + naText + '.');
      }
      if (sec) markCustomSection(res);
      return res;
    }
    res.step('KL/r = ' + n(c.lam, 2) + ' < 200 ok.', SRC.e2);
    var fcrExact = c.exact.fcr * 0.9;
    var s414 = 'Round KL/r UP: ' + n(c.lam, 2) + ' -> ' + c.klrUp + ' (her advice: "just round up").  Table 4-14, KL/r = ' + c.klrUp + ', Fy = ' + n(fy, 3) + ': phi Fcr = ' + n(c.phiFcrTab, 2) + ' ksi.  phi Pn = phi Fcr Ag = ' + n(c.phiFcrTab, 2) + ' (' + n(s.A, 4) + ') = ' + n(c.phiPnTab, 1) + ' kips (gross area, never the net area).';
    if (c.tab && c.tab.override) res.flag('WARNING: ' + ovText(c.tab.override));
    var headline, answerText;
    if (c.basis === '4-1a') {
      // KxLx = KyLy on a W-shape at Fy 50, row inside the table: HER method is Table 4-1a, a KL that is not a whole number read at the next whole-foot row
      res.step('KL is the same both ways (' + n(c.t41a.KL, 3) + ' ft).  Table 4-1a (her method): ' + t41aWhere(c.t41a) + ', ' + s.label + ': phi Pn = ' + n(c.t41a.value, 0) + ' kips.' + (c.t41a.rounded ? '  A KL that is not a whole number of feet is read at the NEXT whole-foot row ("just round up"; HW 6-15 rounds 17.14 ft up to 18 ft).' : ''), SRC.t41a);
      res.step('The KL/r route, for comparison: ' + s414, SRC.t414);
      if (c.roundUpBasis === '4-14+E7') res.step(e7WorkText(s, c.e7Tab, c.klrUp, fy), SRC.e7);
      headline = c.t41a.value;
      answerText = 'Table 4-1a (her method): ' + t41aWhere(c.t41a) + ', phi Pn = ' + n(headline, 0) + ' kips  (KL/r route ' + n(c.roundUp, 1) + '; exact E3 ' + n(c.exact.phiPn, 1) + ')';
      res.val('phiPn', headline, 'kips', SRC.t41a);
    } else {
      res.step(s414, SRC.t414);
      if (c.basis === '4-14+E7') res.step(e7WorkText(s, c.e7Tab, c.klrUp, fy) + '  Use this one (the plain table value x Ag is too high for a slender shape).', SRC.e7);
      headline = c.headline;
      if (c.basis === '4-14+E7') answerText = 'phi Pn = ' + n(headline, 1) + ' kips  (slender element, Spec E7.1: KL/r ' + n(c.lam, 1) + ' rounded up to ' + c.klrUp + ', Fn ' + n(c.e7Tab.fcr, 2) + ' ksi, 0.90 x Fn x effective area Ae ' + n(c.e7Tab.ae, 3) + ' in^2)';
      else answerText = 'phi Pn = ' + n(headline, 1) + ' kips  (table method: KL/r ' + n(c.lam, 1) + ' rounded up to ' + c.klrUp + ', phi Fcr ' + n(c.phiFcrTab, 2) + ' ksi x Ag ' + n(s.A, 3) + ' in^2)';
      if (c.t41a) answerText += '; Table 4-1a lookup: ' + n(c.t41a.value, 0) + ' kips';
      res.val('phiPn', headline, 'kips', SRC.t414);
    }
    if (c.e7Tab && c.e7Tab.e7) res.val('Ae', c.e7Tab.ae, 'in^2', SRC.e7).val('Fn', c.e7Tab.fcr, 'ksi', SRC.e7);
    res.val('phiFcr', c.phiFcrTab, 'ksi', SRC.t414).val('KL_over_r_rounded', c.klrUp, '', 'Her rule: round KL/r up').val('phiPn_round_up', c.phiPnTab, 'kips', SRC.t414);
    // ---- always shown beside the headline: the KL/r route (when Table 4-1a is the headline), interpolation and exact
    if (c.basis === '4-1a') res.alt('KL/r route (Table 4-14, KL/r ' + n(c.lam, 1) + ' rounded up to ' + c.klrUp + ')', c.roundUp, 'kips', c.roundUpBasis === '4-14+E7' ? '0.90 x Fn ' + n(c.e7Tab.fcr, 2) + ' ksi x Ae ' + n(c.e7Tab.ae, 3) + ' in^2 (Spec E7.1)' : 'phi Fcr ' + n(c.phiFcrTab, 2) + ' ksi x Ag ' + n(s.A, 3) + ' in^2', { adequacyRoute: true });
    var ip = c.interp;
    if (ip && !ip.same) {
      res.step('Straight-line interpolation between the two rows (she "averages" at 61.5 in HW 5-17): phi Fcr = ' + n(ip.tlo, 1) + ' + (' + n(ip.thi, 1) + ' - ' + n(ip.tlo, 1) + ') x ' + n(ip.frac, 3) + ' = ' + n(ip.phiFcr, 2) + ' ksi (rows ' + ip.lo + ' and ' + ip.hi + ');  phi Pn = ' + n(ip.phiPn, 1) + ' kips.', SRC.t414);
      var ipSlender = !!((c.exact && c.exact.e7) || (c.e7Tab && c.e7Tab.e7));   // gross area x interpolated stress: too high where Spec E7.1 shrinks the area
      res.alt('linear interpolation between the two table rows (' + ip.lo + ' and ' + ip.hi + ')', ip.phiPn, 'kips', 'phi Fcr = ' + n(ip.phiFcr, 2) + ' ksi x ' + n(s.A, 3) + ' in^2 = ' + n(ip.phiPn, 1) + ' kips' + (ipSlender ? ' -- gross area: it ignores the Spec E7.1 reduction of this slender shape (too high)' : ''), ipSlender ? { referenceOnly: true } : { adequacyRoute: true });
      res.val('phiFcr_interpolated', ip.phiFcr, 'ksi', SRC.t414).val('phiPn_interpolated', ip.phiPn, 'kips', SRC.t414);
    } else if (ip) {
      res.val('phiPn_interpolated', ip.phiPn, 'kips', SRC.t414);
    }
    res.step('Exact E3 for comparison: Fe = ' + n(feEuler(c.lam), 2) + ' ksi, Fcr = ' + n(c.exact.fcr, 2) + ' ksi (' + (c.lam <= limit471(fy) ? 'inelastic, 0.658^(Fy/Fe) Fy' : 'elastic, 0.877 Fe') + '), phi Pn = ' + n(c.exact.phiPn, 1) + ' kips.  ' + (c.basis === '4-1a' ? 'The routes differ only by the table rounding (a whole-foot KL row, a whole KL/r row); her Table 4-1a reading is the answer to write.' : 'The routes differ only by the table rounding (a whole KL/r row); her table method (rounded-up KL/r) is the answer to write.'), SRC.e3);
    res.alt('exact E3 (not rounded)', c.exact.phiPn, 'kips', 'phi Fcr = ' + n(fcrExact, 2) + ' ksi at KL/r = ' + n(c.lam, 2) + '; x ' + n(c.exact.ae, 3) + ' in^2' + (c.exact.e7 ? ' (effective area, Spec E7.1)' : ''), { adequacyRoute: true });
    res.val('phiPn_exact', c.exact.phiPn, 'kips', SRC.e3);
    if (c.basis === '4-14+E7') res.alt('plain Table 4-14 x Ag (her table method -- NOT valid for a slender shape: too high)', c.phiPnTab, 'kips', 'ignores Spec E7.1; the effective area Ae ' + n(c.e7Tab.ae, 3) + ' in^2 is smaller than Ag ' + n(s.A, 3) + ' in^2', { referenceOnly: true });
    if (c.basis !== '4-1a' && c.t41a) {
      res.step('Table 4-1a (same KL both ways), ' + s.label + ', ' + t41aWhere(c.t41a) + ': phi Pn = ' + n(c.t41a.value, 0) + ' kips.', SRC.t41a);
      res.alt('Table 4-1a lookup, ' + t41aWhere(c.t41a) + ' (the Manual column table)', c.t41a.value, 'kips', 'printed value; ' + (c.t41a.flag ? 'the Manual marks ' + s.label + ' as slender (E7 already included)' : 'no slender-element reduction'), { adequacyRoute: true });
      if (c.t41a.override) res.flag('WARNING: ' + ovText(c.t41a.override));
    }
    if (c.basis === '4-1a' && c.t41a.override) res.flag('WARNING: ' + ovText(c.t41a.override));
    if (c.t41a) res.val('phiPn_table_4_1a', c.t41a.value, 'kips', SRC.t41a);
    if (c.t41aUp) res.alt('Table 4-1a at KL = ' + c.t41aUp.kl + ' ft (KL rounded up; same KL both ways)', c.t41aUp.value, 'kips', 'conservative lookup for a KL that is not a whole number of feet', { adequacyRoute: true });
    if (c.t41aEq) {
      res.step('Table 4-1 with the equivalent weak-axis length (her HW 6-15 way): KLx / (rx/ry) = ' + n(klx, 3) + ' / ' + n(c.t41aEq.rxry, 2) + ' = ' + n(c.t41aEq.eq, 2) + ' ft ' + (c.t41aEq.xGoverns ? '> KLy = ' + n(kly, 3) + ' (x governs)' : '<= KLy = ' + n(kly, 3) + ' (y governs)') + ' -> next whole foot ' + c.t41aEq.kl + ' ft: phi Pn = ' + n(c.t41aEq.value, 0) + ' kips.', SRC.t41a);
      res.alt('Table 4-1a at the equivalent weak-axis length ' + n(c.t41aEq.eq, 2) + ' ft -> row ' + c.t41aEq.kl + ' ft', c.t41aEq.value, 'kips', 'KLx / (rx/ry) rounded up to the next whole foot', { adequacyRoute: true });
      res.val('phiPn_table_4_1a', c.t41aEq.value, 'kips', SRC.t41a).val('equivalent_KL', c.t41aEq.eq, 'ft', SRC.t41a);
    }
    if (ip && !ip.same && ip.lo >= 1) res.alt('table value at KL/r = ' + ip.lo + ' (rounded DOWN -- unconservative)', ip.tlo * s.A, 'kips', 'she sometimes reads the nearest row in class (HW 5-5 used the 95 row for 95.05)', { referenceOnly: true });
    var ldC = loadFromArgs(a, res);
    if (ldC) {
      var fenceC = unreliableColumnShape(s) ? { reference: true, why: 'E4/E5 not checked' } : (sec ? { reference: false, why: 'plate slenderness / connectors not checked' } : null);
      var adq = columnAdequacy(res, ldC, c.basis === '4-1a' ? 'Table 4-1a (her method)' : (c.basis === '4-14+E7' ? 'KL/r route with Spec E7.1' : 'KL/r route, Table 4-14'), headline, fenceC);
      answerText += '  --  ' + adq.text;
    }
    if (unreliableColumnShape(s)) {
      res.val('reference_phiPn_flexural_only', headline, 'kips', 'E3 flexural buckling only (reference: too high, E4 / E5 not applied)');
      res.answer('Column capacity phi Pn -- NOT RELIABLE (E4/E5 not applied)', headline, 'kips', UNRELIABLE + '  Reference value (flexural buckling only, too high for this shape): ' + answerText);
    } else res.answer('Column capacity phi Pn', headline, 'kips', answerText);
    var cmp = c.basis === '4-1a' ? c.t41a.value : c.headline;
    // (a KL read at the NEXT whole-foot row is conservative by design, up to several percent, so that case is not an error signal)
    if (!(c.basis === '4-1a' && c.t41a.rounded) && Math.abs(c.exact.phiPn - cmp) / c.exact.phiPn > 0.03) res.flag('CHECK: the table answer and the exact E3 value differ by more than 3%.');
    // P8-8: which axis is "strong" is read from the ACTUAL radii (a plate has its own note above; a tee, a double angle or a built-up section can have rx <= ry)
    if (c.gov === 'x' && c.ly > 0 && !plateAxes) {
      if (s.rx > s.ry * (1 + 1e-9)) res.flag('NOTE: the STRONG axis governs here (x: ' + n(c.lx, 1) + ' > y: ' + n(c.ly, 1) + ') because the weak axis is braced.');
      else res.flag('NOTE: the x axis governs here (x: ' + n(c.lx, 1) + ' > y: ' + n(c.ly, 1) + '). For this section rx = ' + n(s.rx, 3) + ' in is ' + (Math.abs(s.rx - s.ry) <= 1e-9 * s.ry ? 'equal to' : 'smaller than') + ' ry = ' + n(s.ry, 3) + ' in, so x is NOT a strong axis here (the boxes are named for a W-shape): the axis with the larger KL/r governs.');
    }
    if (c.basis === '4-14' && s.type === 'W' && fy === 50 && !sameKL(klx, kly)) res.flag('NOTE: KxLx and KyLy differ, so Table 4-1a (same KL both ways) is not entered directly; the equivalent-length lookup is shown as an alternative.');
    if (sec) markCustomSection(res);
    return res;
  });

  // ---- column selection
  // True when EVERY shape of EVERY family in the list is a W-shape.  Table 4-1a is a table of W-shapes: the equal-KL Table 4-1a headline for a KL that
  // is not a whole number (read at the next whole-foot row) is used only for such a list.  A mixed list (W with HSS, tees ...) would compare a
  // rounded-up table row of the W-shapes with the KL/r route of the others, so it keeps the per-shape routes of before (the table at a whole-number KL only).
  function allWFamilies(fams, res) {
    for (var i = 0; i < fams.length; i++) {
      var list = shapesInFamily(fams[i], res);
      for (var j = 0; j < list.length; j++) { if (list[j].type !== 'W') return false; }
    }
    return true;
  }

  // Lightest shape in each family.  For every trial both routes are worked out (Table 4-14 round-up and, where it applies, Table 4-1a);
  // the one named in the settings picks the winner (her sheets: Table 4-1 for the same KL both ways), and a disagreement is reported.
  function selectColumnCore(opts, res) {
    var fams = opts.families && opts.families.length ? opts.families : ['W8', 'W10', 'W12', 'W14'];
    var perFamily = [], overall = null, i, j, f2 = allWFamilies(fams, res);
    for (i = 0; i < fams.length; i++) {
      var list = sortByWeight(shapesInFamily(fams[i], res)), trials = [], winner = null, other = null;
      for (j = 0; j < list.length; j++) {
        var s = list[j], fy = isNum(opts.Fy) ? opts.Fy : defaultFy(s);
        if (!isNum(s.rx) || !isNum(s.ry) || !isNum(s.A)) continue;
        var c = columnCore(s, opts.KLx, opts.KLy, fy, 'select', f2);
        var cap = c.tooSlender ? null : c.headline;
        var ok = cap !== null && cap + 1e-9 >= opts.Pu;
        // the other route, for the cross-check
        var capOther = null, okOther = false;
        if (c.t41a) {
          capOther = c.basis === '4-1a' ? c.roundUp : c.t41a.value;
          okOther = capOther !== null && !c.tooSlender && capOther + 1e-9 >= opts.Pu;
        }
        trials.push({ shape: s, core: c, cap: cap, ok: ok, capOther: capOther, okOther: okOther });
        if (ok && !winner) winner = trials[trials.length - 1];
        if (c.t41a && okOther && !other) other = trials[trials.length - 1];
        if (winner && (other || !c.t41a)) break;
      }
      // keep only the trials up to the winner in the log (the other route may have gone one or two shapes further)
      var cut = winner ? trials.indexOf(winner) + 1 : trials.length;
      var log = trials.slice(0, Math.max(cut, other ? trials.indexOf(other) + 1 : 0));
      perFamily.push({ family: fams[i], trials: log, winner: winner, other: other });
      if (winner && (!overall || winner.shape.W < overall.shape.W || (winner.shape.W === overall.shape.W && winner.cap > overall.cap))) overall = winner;
    }
    return { perFamily: perFamily, overall: overall, Pu: opts.Pu, KLx: opts.KLx, KLy: opts.KLy, f2: f2 };
  }

  // a number for the trial-log table: one decimal, or two when it is within 0.05 of the load it is compared with (so a 36.41 > 36.40 pass does not read 36.4 > 36.4)
  function logNum(x, y) { var d = Math.abs(x - y) < 0.05 ? 100 : 10; return Math.round(x * d) / d; }

  function describeColumnSelection(res, sel, Pu) {
    var missed = [];   // families where the headline route found nothing but the other route would have
    // P6: a mixed list at a whole-foot equal KL: the W shapes were read from Table 4-1a and the other shapes by the KL/r route
    var anyT41a = false, otherTypes = [];
    sel.perFamily.forEach(function (pf) { pf.trials.forEach(function (t) { if (t.shape.type === 'W') { if (t.core.basis === '4-1a') anyT41a = true; } else if (otherTypes.indexOf(t.shape.type) < 0) otherTypes.push(t.shape.type); }); });
    if (anyT41a && otherTypes.length) res.flag('NOTE: mixed list: W shapes read from Table 4-1a, ' + otherTypes.join('/') + ' shapes by the KL/r route; a near-tie across families can depend on the route.');
    // A1: the lightest shape is a tee or an angle: the number is flexural buckling only (too high); said ONCE, first
    if (sel.overall && unreliableColumnShape(sel.overall.shape)) {
      var us = sel.overall.shape;
      res.flagFirst('WARNING: ' + UNRELIABLE + ' ' + us.label + ' is a ' + (us.type === 'L' ? 'single angle' : (us.type === '2L' ? 'double angle' : 'tee')) + ' and can also fail by torsional / flexural-torsional buckling (Spec E4' + (us.type === 'L' ? ', E5' : (us.type === '2L' ? ', E6' : '')) + ')' + (sel.overall.core.slender.some(function (x) { return x.key === 'stem'; }) ? ' and its slender stem needs the E7 reduction' : '') + ', which is NOT checked here, so the selection and its phi Pn are too optimistic.');
    }
    sel.perFamily.forEach(function (pf) {
      var tableHead = pf.trials.some(function (t) { return t.core.basis === '4-1a'; });
      var famU = pf.trials.some(function (t) { return unreliableColumnShape(t.shape); });   // P8-2: a tee / angle family: flexural buckling only, never "ok" / "NG" / "Works"
      if (!pf.winner) {
        var hv = pf.trials.length ? pf.trials[pf.trials.length - 1] : null, why = '';
        if (pf.other) {
          why = '  By ' + (tableHead ? 'Table 4-1a (her method)' : 'the headline route') + ' nothing in ' + pf.family + ' works' + (hv && hv.cap !== null ? ' (the heaviest, ' + hv.shape.label + ', has ' + n(hv.cap, 1) + ' kips' + (hv.core.basis === '4-1a' ? ' at the ' + hv.core.t41a.kl + '-ft row' : '') + ')' : '') + '; the other route would select ' + pf.other.shape.label + ' (' + n(pf.other.capOther, 1) + ' kips).';
          missed.push(pf.family + ': the other route would select ' + pf.other.shape.label + ' at ' + n(pf.other.capOther, 1) + ' kips');
        }
        res.step(pf.family + ': no shape in the family ' + (famU ? 'reaches ' + n(Pu, 1) + ' kips by the flexural-only comparison (not an adequacy verdict)' : 'carries ' + n(Pu, 1) + ' kips') + ' at this KL.' + why, SRC.t41a);
        return;
      }
      var w = pf.winner, c = w.core, ix = pf.trials.indexOf(w), prev = ix > 0 ? pf.trials[ix - 1] : null;
      var pp = prev && prev.cap !== null ? nPair(prev.cap, Pu, 1) : null, wp = nPair(w.cap, Pu, c.basis === '4-1a' ? 0 : 1);
      var prevText = prev ? prev.shape.label + ' ' + (prev.cap === null ? 'cannot be used (KL/r > 200)' : 'phi Pn = ' + pp[0] + ' kips < ' + pp[1] + (famU ? ', below Pu by the flexural-only comparison' : ' NG')) + '.  ' : '';
      res.step(pf.family + ': ' + prevText + 'Choose ' + w.shape.label + ' (' + n(w.shape.W, 4) + ' lb/ft): phi Pn = ' + wp[0] + ' kips > ' + wp[1] + (unreliableColumnShape(w.shape) ? ' (flexural-buckling-only comparison, NOT an adequacy verdict -- E4/E5 not checked)' : ' ok') + (c.basis === '4-1a' ? ' (Table 4-1a, her method: ' + t41aWhere(c.t41a) + ')' : (c.basis === '4-14+E7' ? ' (KL/r ' + n(c.lam, 1) + ' -> ' + c.klrUp + ', slender: Spec E7.1 Fn ' + n(c.e7Tab.fcr, 2) + ' ksi, effective area Ae ' + n(c.e7Tab.ae, 3) + ' in^2)' : ' (KL/r ' + n(c.lam, 1) + ' -> ' + c.klrUp + ', phi Fcr ' + n(c.phiFcrTab, 2) + ' ksi, Ag ' + n(c.A, 3) + ')')) + '.', c.basis === '4-1a' ? SRC.t41a : SRC.t414);
      if (c.basis === '4-14+E7') res.step(w.shape.label + ' is slender: ' + e7WorkText(w.shape, c.e7Tab, c.klrUp, c.fy), SRC.e7);
      if (pf.other && pf.other.shape !== w.shape) {
        // the two routes pick different shapes: name both picks, and show the lighter pick's number on each route
        var o2 = pf.other, ta = c.basis === '4-1a', lp = o2.shape.W < w.shape.W ? o2 : w, lc = lp.core;
        res.flag('WARNING: ' + pf.family + ': the two routes disagree -- ' + (ta ? 'Table 4-1a selects ' + w.shape.label + '; the KL/r route would select ' + o2.shape.label : 'the KL/r round-up route selects ' + w.shape.label + '; Table 4-1a would select ' + o2.shape.label) + '.  (' + lp.shape.label + ': ' + (lc.t41a ? 'Table 4-1a ' + n(lc.t41a.value, 0) + ' kips' + (lc.t41a.rounded ? ' at the ' + lc.t41a.kl + '-ft row' : '') + ', ' : '') + 'KL/r route ' + (lc.roundUp !== null ? n(lc.roundUp, 1) : '?') + ' kips, load ' + n(Pu, 1) + ' kips.)  ' + (ta ? 'Table 4-1a is her method, so ' + w.shape.label + ' is the answer to write' : 'Use the one the problem asks for') + '; the trial log shows both.');
      }
      pf.trials.forEach(function (t) { slenderFlagsLight(res, t); });
      roundHssNote(res, w.shape, c.fy);
      res.table(pf.family + ' trial log (lightest first)', ['Shape', 'Weight lb/ft', 'Ag in^2', 'KL/r', 'phi Pn kips', 'Method', 'Table 4-1', 'KL/r route', 'Pu needed', famU ? 'flexural-only phi Pn >= Pu? (not adequacy)' : 'Works?'],
        pf.trials.map(function (t) {
          return [t.shape.label, t.shape.W, t.shape.A, Math.round(t.core.lam * 10) / 10, t.cap === null ? null : logNum(t.cap, Pu), t.core.basis,
            t.core.table41a === null ? null : t.core.table41a, t.core.roundUp === null ? null : logNum(t.core.roundUp, Pu), t.cap === null ? Math.round(Pu * 10) / 10 : logNum(Pu, t.cap),
            famU ? (t.cap === null ? 'KL/r>200' : (t.ok ? (t === w ? '>= Pu (chosen)' : '>= Pu') : '< Pu')) : (t.ok ? (t === w ? 'YES' : 'ok') : (t.cap === null ? 'KL/r>200' : 'NG'))];
        }), '"Table 4-1" = the printed Table 4-1a value of the shape: with the SAME KL both ways it is read at the row of that KL (a KL that is not a whole number at the NEXT whole foot, W-shape lists only); with DIFFERENT lengths at the equivalent length KxLx / (rx/ry) (or KyLy if that is larger), rounded up to the next whole foot (her HW 6-15). "KL/r route" = KL/r of the governing axis ROUNDED UP, phi Fcr from Table 4-14, x Ag. "Method" says which one decided the row (4-1a, 4-14, 4-14+E7 = with the Spec E7 effective area).' + (famU ? ' For a tee or an angle the last column compares the FLEXURAL-BUCKLING-ONLY phi Pn with Pu: it is NOT an adequacy verdict (Spec E4 / E5 are not checked), and a ">= Pu" row can still be inadequate.' : ''));
      res.val('lightest_' + pf.family, w.shape.label, '', c.basis === '4-1a' ? SRC.t41a : SRC.t414);
      if (sel.overall && w !== sel.overall) res.alt('lightest ' + pf.family + (unreliableColumnShape(w.shape) ? ' -- NOT RELIABLE (E4/E5 not applied)' : ''), w.cap, 'kips', w.shape.label + ' (' + n(w.shape.W, 4) + ' lb/ft)' + (unreliableColumnShape(w.shape) ? ': a tee or angle, flexural buckling only, too high -- check the book' : ''));
    });
    var allU = sel.perFamily.length > 0 && sel.perFamily.every(function (pf) { return pf.trials.length > 0 && pf.trials.every(function (t) { return unreliableColumnShape(t.shape); }); });
    if (!sel.overall) fail('OUT_OF_RANGE', 'No shape in ' + sel.perFamily.map(function (p) { return p.family; }).join(', ') + (allU ? ' reaches' : ' carries') + ' Pu = ' + n(Pu, 1) + ' kips' + (allU ? ' by the flexural-only comparison (not an adequacy verdict)' : '') + ' at this KL. Try a bigger family, or shorten the unbraced length.' + (missed.length ? ' (' + missed.join('; ') + ' -- not her method: she reads Table 4-1a.)' : ''), []);
    var o = sel.overall, oc = o.core, op = nPair(o.cap, Pu, oc.basis === '4-1a' ? 0 : 1);
    res.val('selected_shape', o.shape.label, '', oc.basis === '4-1a' ? SRC.t41a : SRC.t414).val('phiPn', o.cap, 'kips').val('Pu', Pu, 'kips', SRC.lrfd).val('weight', o.shape.W, 'lb/ft', SRC.shapes);
    if (oc.roundUp !== null) res.val('phiPn_round_up', oc.roundUp, 'kips', SRC.t414);
    if (oc.table41a !== null) res.val('phiPn_table_4_1a', oc.table41a, 'kips', SRC.t41a);
    res.val('KL_over_r', oc.lam, '').val('KLx', oc.KLx, 'ft').val('KLy', oc.KLy, 'ft');
    if (unreliableColumnShape(o.shape)) res.val('reference_phiPn_flexural_only', o.cap, 'kips', 'E3 flexural buckling only (reference)');
    res.answer(unreliableColumnShape(o.shape) ? 'Lightest column -- NOT RELIABLE (E4/E5 not applied)' : 'Lightest column', o.cap, 'kips', (unreliableColumnShape(o.shape) ? UNRELIABLE + '  ' : '') + o.shape.label + ' (' + n(o.shape.W, 4) + ' lb/ft)  phi Pn = ' + op[0] + ' kips > Pu = ' + op[1] + ' kips' + (unreliableColumnShape(o.shape) ? ' (flexural-buckling-only comparison, NOT an adequacy verdict -- E4/E5 not checked)' : ' ok') + (oc.basis === '4-1a' ? '  (Table 4-1a, her method: ' + t41aWhere(oc.t41a) + (oc.roundUp !== null ? '; KL/r route ' + n(oc.roundUp, 1) : '') + ')' : (oc.table41a !== null ? '  (Table 4-1a: ' + n(oc.table41a, 0) + ')' : '')));
    if (sel.perFamily.length > 1) res.flag('NOTE: lightest overall is ' + o.shape.label + '; but the family that fits the building detail (a W10 vs a W12) is your call -- the lightest in each family is listed.');
  }

  function slenderFlagsLight(res, t) {
    if (t.ok && t.core.slender.length) slenderFlags(res, t.core, true);
  }

  var COLUMN_SELECT_FIELDS = [
    F('families', 'strlist', 'Families to try (W8 W10 W12 W14 ... or HSS6X6 ...)', '', { default: ['W8', 'W10', 'W12', 'W14'] })
  ].concat(LOAD_FIELDS('kips')).concat(AXIS_FIELDS).concat([
    F('Fy', 'number', 'Fy (blank = from the shape family)', 'ksi', { min: 1, minExclusive: true })
  ]);

  def('column_select', 'Column', 'Select the lightest column', 'Lightest column in each family (W8, W10, W12, W14 ...) and overall, by trial from the lightest up. Same KL both ways with only W-shape families: straight into Table 4-1a (her sheets 6-7b, 6-7c; a KL that is not a whole number of feet is read at the next whole-foot row); different lengths or other shapes: KL/r rounded up and Table 4-14 (a slender W or rectangular HSS uses the Spec E7.1 effective area). Both routes are shown and a disagreement is a WARNING naming both picks. Loads are SERVICE loads unless the box says factored.', COLUMN_SELECT_FIELDS, function (a, res) {
    var ld = loadFromArgs(a, res);
    if (!ld) fail('MISSING', 'Enter the loads D and L (service), or tick "already factored" and enter Pu.');
    var klx = axisKL('Strong axis', a.x_end_condition, a.Lx_ft, a.KLx_ft, null, res);
    var kly = weakAxisKL(a, res);
    if (klx === null && kly === null) fail('MISSING', 'Enter the effective length: KxLx and KyLy (or K from the end conditions and the member length L). A problem may print the member length as "Lc"; the tool multiplies it by K.');
    if (klx === null) { klx = kly; res.flag('NOTE: no strong-axis length was given; the weak-axis KL was used for both axes.'); }
    if (kly === null) { kly = klx; res.flag('NOTE: no weak-axis length was given; the same effective length was used for both axes (no braces).'); }
    // which route the equal-KL case takes depends on the family list (all W-shapes?) and the KL (a whole number of feet, or not)
    var eqKL = sameKL(klx, kly), fams = a.families && a.families.length ? a.families : ['W8', 'W10', 'W12', 'W14'], onlyW = eqKL && allWFamilies(fams, res);
    var klm = Math.max(klx, kly), wholeKL = Math.abs(klm - Math.round(klm)) < EQ_KL, rowKL = wholeKL ? Math.round(klm) : Math.ceil(klm - EQ_KL), frac = settings().fractional_KL_table === 'next-row';
    var eqText;
    if (!eqKL) eqText = ' (different: KL/r method, trial and error from the lightest).';
    else if (wholeKL) eqText = ' (equal: she goes straight into Table 4-1' + (onlyW ? '' : ' for the W-shapes; the other shapes in the list use the KL/r route') + ').';
    else if (onlyW && frac) eqText = ' (equal: she goes straight into Table 4-1a; a KL that is not a whole number of feet is read at the NEXT whole-foot row, ' + n(klm, 3) + ' ft -> the ' + rowKL + '-ft row).';
    else eqText = ' (equal, but ' + (onlyW ? 'the settings say a KL that is not a whole number uses the KL/r route' : 'the families are not all W-shapes, and Table 4-1a is a table of W-shapes') + ': the KL/r route (Table 4-14, KL/r rounded up) is used for a KL that is not a whole number of feet).';
    res.step('Effective lengths: KxLx = ' + n(klx, 3) + ' ft, KyLy = ' + n(kly, 3) + ' ft' + eqText, SRC.given);
    var sel = selectColumnCore({ families: a.families, Pu: ld.Pu, KLx: klx, KLy: kly, Fy: a.Fy }, res);
    describeColumnSelection(res, sel, ld.Pu);
    if (!eqKL) res.flag('NOTE: unequal lengths -- she does this by trial and error (or converts KxLx with rx/ry); the log shows every trial. Check the winner against both axes.');
    return res;
  });

  // =====================================================================================================
  // 10. TENSION
  // =====================================================================================================

  var MEMBER_VALUES = [
    { value: 'plate', label: 'plate' },
    { value: 'shape', label: 'rolled shape (W, M, S, HP, C, MC, WT, HSS ...)' },
    { value: 'angle', label: 'angle (one, or two with "angles" = 2)' }
  ];

  // every failure path through a pattern of holes.  holes = [{ along, across }] (inches; across measured from one edge).
  // A path is any set of holes with strictly increasing "across", taken in that order; each diagonal adds s^2/4g.
  function holePaths(holes, hole) {
    var N = holes.length, i, k, paths = [];
    if (N > 14) fail('INVALID', 'Too many holes (' + N + '); the tool enumerates paths for up to 14.');
    var order = holes.map(function (h, ix) { return { h: h, ix: ix }; }).sort(function (p, q) { return (p.h.across - q.h.across) || (p.h.along - q.h.along); });
    var letter = function (ix) { return String.fromCharCode(65 + ix); };
    for (var mask = 1; mask < (1 << N); mask++) {
      var chain = [];
      for (i = 0; i < N; i++) { if (mask & (1 << i)) chain.push(order[i]); }
      var okChain = true, add = 0, terms = [];
      for (k = 0; k + 1 < chain.length; k++) {
        var g = chain[k + 1].h.across - chain[k].h.across, s = chain[k + 1].h.along - chain[k].h.along;
        if (g <= 1e-9) { okChain = false; break; }
        var t = s * s / (4 * g);
        add += t; terms.push({ s: Math.abs(s), g: g, t: t });
      }
      if (!okChain) continue;
      paths.push({ label: chain.map(function (c) { return letter(c.ix); }).join('-'), n: chain.length, add: add, terms: terms, reduction: chain.length * hole - add });
    }
    return paths;
  }

  function nFlangesOf(s) { return (s.type === 'WT' || s.type === 'MT' || s.type === 'ST') ? 1 : 2; }

  function rMinOf(s, nAng) {
    if (s.type === 'L') return nAng === 1 && isNum(s.rz) ? s.rz : Math.min(s.rx, s.ry);
    return Math.min(s.rx, s.ry);
  }

  // ---- tension: an entry the engine cannot use as given is REFUSED or named in a flag -- never dropped silently
  var FLANGED_TYPES = ['W', 'M', 'S', 'HP', 'C', 'MC', 'WT', 'MT', 'ST'];
  function isFlangedType(t) { return FLANGED_TYPES.indexOf(t) >= 0; }

  // what to type when the hole count is missing, in the words of the page's boxes (the field name in brackets)
  function holeHelp(kind, flanged, selectMode) {
    var weld = ' Or tick WELDED if there are no bolt holes.';
    if (flanged) return 'Enter the holes in EACH flange (holes_per_flange) and/or in the web (web_holes; the stem of a tee).' + weld;
    if (kind === 'angle') return 'Enter the number of holes in the critical section of the connected leg (holes_across)' + (selectMode ? '' : ', or the staggered holes list') + '.' + weld;
    if (kind === 'plate') return 'Enter the number of holes in the critical section (holes_across), or the staggered holes list.' + weld;
    return 'Enter the number of holes in the critical section (holes_across).' + weld;
  }

  // NOTE for entries that were typed but cannot matter here.  names = field names; the caller builds the list for the case.
  function noteUnused(res, a, names, why) {
    var list = names.filter(function (k) { return res.gave(k) && isSet(a[k]); });
    if (list.length) res.flag('NOTE: ' + why + ', so ' + (list.length > 1 ? 'these entries were' : 'this entry was') + ' NOT used: ' + list.join(', ') + '.');
  }

  // kind = 'plate' | 'angle' | 'shape' (what the member is), shape = its record (or null; the first shape of the family in tension_select),
  // welded = no bolt holes.  Throws MISSING / AMBIGUOUS / INVALID; names the entries that cannot be used in a NOTE.
  function checkTensionInputs(a, res, kind, shape, welded, selectMode) {
    var flanged = kind === 'shape' && !!shape && isFlangedType(shape.type);
    var stag = isSet(a.holes), across = isSet(a.holes_across), perFl = isSet(a.holes_per_flange), webH = isSet(a.web_holes);
    var plateDims = isSet(a.width_in) || isSet(a.thickness_in), shapeTyped = !isBlank(a.shape);
    var what = kind === 'plate' ? 'a plate' : (kind === 'angle' ? 'an angle' : (shape ? (/^(HSS|M|S|HP|MC)$/.test(shape.type) ? 'an ' : 'a ') + shape.type + '-shape' : 'a shape'));
    // an angle typed under "rolled shape": the hole area would be worked out for ONE angle even for a pair
    if (kind === 'shape' && shape && (shape.type === 'L' || shape.type === '2L')) fail('INVALID', shape.label + ' is an angle. Choose the member "angle" (a pair of angles: the 2L name, or number of angles = 2).');
    // a plate and a shape at the same time: say which one is the member
    if (kind !== 'plate' && plateDims && !res.gave('member')) fail('AMBIGUOUS', 'A plate (width and thickness) and a shape (' + a.shape + ') were both entered. Which is the member? Clear the one that does not apply, or choose the member type.');
    if (kind === 'plate' && shapeTyped) noteUnused(res, a, ['shape'], 'the member is a plate');
    if (kind !== 'plate' && plateDims) noteUnused(res, a, ['width_in', 'thickness_in'], 'the member is ' + what);
    if (kind !== 'angle' && res.gave('angles') && a.angles > 1) noteUnused(res, a, ['angles'], 'the member is not an angle');
    if (welded) return;
    if (stag && across) fail('AMBIGUOUS', 'The holes were entered twice: as a count (holes_across = ' + a.holes_across + ') and as a staggered list of ' + a.holes.length + ' holes. Use one of them: the list already has every hole in it.');
    if (stag && kind === 'shape') fail('INVALID', flanged ? 'Staggered paths are supported for plates and angle legs; for a W/C/WT give holes per flange and in the web (holes_per_flange, web_holes).' : 'Staggered paths are supported for plates and angle legs; for ' + what + ' give the number of holes in the critical section (holes_across).');
    if (across && flanged) fail('AMBIGUOUS', 'The number of holes in the critical section (holes_across) does not say WHERE the holes are in ' + what + ': the flanges and the web have different thicknesses, so the area lost depends on which part the holes are in. Enter the holes in EACH flange (holes_per_flange; a tee has one flange) and/or in the web (web_holes; the stem of a tee).');
    if ((perFl || webH) && !flanged) fail('INVALID', 'The holes in each flange / in the web (holes_per_flange, web_holes) are for rolled I-shapes, channels and tees. For ' + what + ' enter the number of holes in the critical section (holes_across)' + (kind === 'plate' || (kind === 'angle' && !selectMode) ? ', or the staggered holes list' : '') + '.');
    // the connection and the holes must describe the same bolts: U comes from the connection, the net area from the holes
    var conn = a.connection;
    if (conn && !isSet(a.U)) {
      if (conn === 'angle' && kind !== 'angle') fail('INVALID', 'The connection "angle bolted through ONE LEG" is for an angle, and this member is ' + what + '. Choose where it is connected: all parts, the flanges, the web, or other (Case 2).');
      if (flanged && conn === 'flanges' && webH && !perFl) fail('AMBIGUOUS', 'The connection says the bolts go through the FLANGES only, but the holes were entered only in the web (web_holes). U comes from the connection and the net area from the holes, so they must describe the same bolts: enter the holes in each flange (holes_per_flange), or change the connection to the web / all parts.');
      if (flanged && conn === 'web' && perFl && !webH) fail('AMBIGUOUS', 'The connection says the bolts go through the WEB only, but the holes were entered only in the flanges (holes_per_flange). U comes from the connection and the net area from the holes, so they must describe the same bolts: enter the holes in the web (web_holes), or change the connection to the flanges / all parts.');
      if (flanged && (conn === 'flanges' || conn === 'web') && perFl && webH) res.flag('CHECK: the connection is "through the ' + (conn === 'flanges' ? 'FLANGES' : 'WEB') + ' only" but holes were entered in BOTH the flanges and the web. U comes from the connection (Case 7); the net area counts all the holes. Check that this matches the problem.');
      if (kind === 'angle' && conn === 'all') res.flag('CHECK: "all parts connected" (U = 1.0) is unusual for an angle: an angle bolted through one leg is Case 8 or Case 2 (connection "angle bolted through ONE LEG"). Check the problem.');
      // "all parts connected" means bolts through the flanges AND the web: holes in only one part describe a flanges-only / web-only connection
      if (flanged && conn === 'all' && ((perFl && !webH) || (webH && !perFl))) res.flag('CHECK: the connection is "all parts connected" (U = 1.0), but holes were entered only in the ' + (perFl ? 'FLANGES' : 'WEB / stem') + '. A connection through the ' + (perFl ? 'flanges' : 'web') + ' only is Case 7 (U = ' + (perFl ? '0.90 or 0.85' : '0.70') + ', or Case 2 for a channel). Check which one the problem describes.');
    }
    // bolts are implied (a connection, fasteners per line, a bolt or hole size, a given U) but nobody said how many holes cross the section
    if (!across && !stag && !perFl && !webH) {
      var why = [];
      if (conn && conn !== 'all' && conn !== 'welded') why.push('the connection (' + conn + ')');
      if (isSet(a.fasteners_per_line)) why.push('the fasteners per line');
      if (isSet(a.bolt_dia_in)) why.push('a bolt diameter');
      if (isSet(a.hole_dia_in)) why.push('a hole diameter');
      if (isSet(a.U)) why.push('U');
      if (why.length) fail('MISSING', 'Missing: how many holes cross the section (per flange / in the web / per leg)? You gave ' + (why.length > 1 ? why.slice(0, -1).join(', ') + ' and ' + why[why.length - 1] : why[0]) + ', so the member is bolted, but not how many holes cross the critical section. ' + holeHelp(kind, flanged, selectMode));
    }
  }

  var TENSION_MEMBER_FIELDS = [
    F('member', 'select', 'Member', '', { values: MEMBER_VALUES }),
    F('shape', 'shape', 'Shape (for a rolled shape or an angle; a double angle = the single angle with angles = 2)', ''),
    F('angles', 'integer', 'Number of angles (1 or 2)', '', { default: 1, min: 1, max: 2 }),
    F('width_in', 'dimension', 'Plate width', 'in', { min: 0, minExclusive: true }),
    F('thickness_in', 'dimension', 'Plate thickness', 'in', { min: 0, minExclusive: true }),
    F('bolt_dia_in', 'dimension', 'Bolt diameter (hole = bolt + 1/8)', 'in', { min: 0, minExclusive: true, plausible: 'bolt' }),
    F('hole_dia_in', 'dimension', 'OR the hole diameter to use directly', 'in', { min: 0, minExclusive: true, plausible: 'hole' }),
    F('holes_across', 'integer', 'Plate / angle / HSS: number of holes in the critical section (no stagger)', '', { default: 0, min: 0 }),
    F('holes', 'list', 'Plate / angle: positions of ALL the holes when they are staggered (every path is checked)', '', {
      item: [F('along', 'number', 'along the load (stagger direction)', 'in', { required: true }),
        F('across', 'number', 'across the width, from one edge (plate)', 'in'),
        F('leg', 'integer', 'angle only: which leg (1 = long leg, 2 = short leg)', '', { min: 1, max: 2 }),
        F('gage', 'number', 'angle only: distance from the back (heel) of that leg', 'in', { min: 0 })]
    }),
    F('holes_per_flange', 'integer', 'Shape: holes across each flange at the critical section', '', { default: 0, min: 0 }),
    F('web_holes', 'integer', 'Shape: holes in the web (stem of a tee) at the critical section', '', { default: 0, min: 0 })
  ];

  // Gross and net area, then the two sanity checks: a net area of zero or less is not a section (refused), and holes that take more than
  // half of the gross area are flagged.
  function netAreaCore(a, res) {
    var out = netAreaCore0(a, res);
    if (!(out.An > 1e-9)) fail('OUT_OF_RANGE', 'The holes remove the WHOLE section: Ag = ' + n(out.Ag, 4) + ' in^2 and the holes take ' + n(out.Ag - out.An, 4) + ' in^2, so An = ' + n(out.An, 4) + ' in^2. A net area of zero or less is not a section: check the number of holes and the bolt diameter (hole = bolt + 1/8).');
    if (out.Ag - out.An > 0.5 * out.Ag + 1e-9) res.flag('CHECK: the holes remove ' + n(100 * (out.Ag - out.An) / out.Ag, 1) + '% of the gross area (An = ' + n(out.An, 4) + ' of Ag = ' + n(out.Ag, 4) + ' in^2) -- more than half. Check the number of holes and the bolt diameter.');
    // P7-R3: a bolt of 1 in or more: the AISC net area (hole = bolt + 3/16) beside her answer.  An extra only: nothing in it can change or refuse the result above.
    if (!isNum(a.hole_dia_in) && boltOverOne(a.bolt_dia_in) && out.hole !== null && out.An < out.Ag - 1e-12) {
      try {
        var a2 = {}, k2;
        for (k2 in a) { if (has(a, k2)) a2[k2] = a[k2]; }
        a2.hole_dia_in = a.bolt_dia_in + 0.1875; a2.bolt_dia_in = undefined;
        var o2 = netAreaCore0(a2, new Res('aisc-hole'));
        if (isNum(o2.An)) { out.aisc = { hole: a2.hole_dia_in, An: o2.An }; res.flag(boltOverOneNote(a.bolt_dia_in, out.hole)); }
      } catch (eAisc) { out.aisc = null; }
    }
    return out;
  }

  // Gross and net area from the member description.  Returns the numbers and writes the steps.
  function netAreaCore0(a, res) {
    var shape = isBlank(a.shape) ? null : useShape(res, findShape(a.shape));
    var kind = a.member || (shape ? ((shape.type === 'L' || shape.type === '2L') ? 'angle' : 'shape') : 'plate');
    checkTensionInputs(a, res, kind, shape, !!a.welded);
    var out = { kind: kind, shape: shape, nAng: 1, Ag: null, t: null, hole: null, An: null, paths: null, label: '', best: null, widthRef: null };
    var bolt = a.bolt_dia_in, hole = isNum(a.hole_dia_in) ? a.hole_dia_in : (isNum(bolt) ? bolt + 0.125 : null);
    if (isNum(a.hole_dia_in) && isNum(a.bolt_dia_in) && a.hole_dia_in < a.bolt_dia_in - 1e-9) fail('INVALID', 'The hole diameter (' + n(a.hole_dia_in, 4) + ' in) is SMALLER than the bolt (' + n(a.bolt_dia_in, 4) + ' in): a hole is at least the bolt size (the net-area hole is bolt + 1/8).');
    if (isNum(a.hole_dia_in) && isNum(a.bolt_dia_in)) res.flag('NOTE: both a bolt diameter and a hole diameter were entered; the hole diameter (' + n(a.hole_dia_in, 4) + ' in) was used and the bolt diameter (hole = bolt + 1/8) was NOT used.');
    var holeCount = (a.holes && a.holes.length) ? a.holes.length : (a.holes_across || 0);
    var perFlange = a.holes_per_flange || 0, webH = a.web_holes || 0;
    var anyHoles = holeCount > 0 || perFlange > 0 || webH > 0;
    if (anyHoles && hole === null) fail('MISSING', 'Missing: bolt diameter (the hole is bolt + 1/8 in).');
    out.hole = hole;
    if (hole !== null) {
      res.step('Hole for the net area = bolt + 1/8 in' + (isNum(a.hole_dia_in) ? ' (hole given: ' + n(hole, 4) + ' in).' : ' = ' + n(bolt, 4) + ' + 0.125 = ' + n(hole, 4) + ' in.') + ' The area lost is a rectangle: hole x thickness.', 'Her rule; ' + SRC.b43);
    }
    var i;
    if (kind === 'plate') {
      if (!isNum(a.width_in) || !isNum(a.thickness_in)) fail('MISSING', 'A plate needs its width and thickness (inches).');
      out.t = a.thickness_in; out.Ag = a.width_in * a.thickness_in; out.widthRef = a.width_in; out.label = n(a.width_in, 4) + ' x ' + n(a.thickness_in, 4) + ' plate';
      res.step('Gross area Ag = width x thickness = ' + n(a.width_in, 4) + ' x ' + n(a.thickness_in, 4) + ' = ' + n(out.Ag, 4) + ' in^2.', SRC.given);
    } else if (kind === 'angle') {
      if (!shape || (shape.type !== 'L' && shape.type !== '2L')) fail('MISSING', 'An angle needs an L-shape name such as L8X4X1/2.');
      out.nAng = shape.type === '2L' ? 2 : (a.angles || 1);
      var one = shape.type === '2L' ? shape.A / 2 : shape.A;
      out.Ag = one * out.nAng; out.t = shape.t; out.AgOne = one; out.widthRef = one / shape.t;
      out.label = (out.nAng === 2 ? '2 x ' : '') + (shape.type === '2L' ? shape.label : shape.label);
      res.step('Gross area from the Manual: ' + (out.nAng === 2 ? 'one angle ' + n(one, 4) + ' in^2; two angles Ag = 2 x ' + n(one, 4) + ' = ' + n(out.Ag, 4) + ' in^2.' : 'Ag = ' + n(out.Ag, 4) + ' in^2.') + ' Thickness t = ' + n(shape.t, 4) + ' in.', SRC.shapes);
      if (out.nAng === 2 && shape.type === 'L') res.flag('NOTE: double angle = 2 x one angle (area and net area); both angles have the same holes.');
    } else {
      if (!shape) fail('MISSING', 'A rolled shape needs a name such as W14x90.');
      out.Ag = shape.A; out.label = shape.label;
      res.step('Gross area from the Manual: ' + shape.label + ': Ag = ' + n(shape.A, 4) + ' in^2' + (isNum(shape.tf) ? ', tf = ' + n(shape.tf, 4) + ' in' : '') + (isNum(shape.tw) ? ', tw = ' + n(shape.tw, 4) + ' in' : '') + '.', SRC.shapes);
    }
    // ---- net area
    if (!anyHoles) {
      out.An = out.Ag;
      res.step('No holes: An = Ag = ' + n(out.Ag, 4) + ' in^2 (and only yielding needs checking).', SRC.b43);
      return out;
    }
    if (kind === 'shape' && (perFlange > 0 || webH > 0) && isNum(shape.tf)) {
      var nF = nFlangesOf(shape), tw = isNum(shape.tw) ? shape.tw : 0;
      var lossF = hole * perFlange * nF * shape.tf, lossW = hole * webH * tw;
      out.An = out.Ag - lossF - lossW;
      var parts = [];
      if (perFlange > 0) parts.push(perFlange * nF + ' flange hole' + (perFlange * nF > 1 ? 's' : '') + ' (' + perFlange + ' per flange x ' + nF + ' flange' + (nF > 1 ? 's' : '') + ') x ' + n(hole, 4) + ' x tf ' + n(shape.tf, 4) + ' = ' + n(lossF, 4));
      if (webH > 0) parts.push(webH + ' web hole' + (webH > 1 ? 's' : '') + ' x ' + n(hole, 4) + ' x tw ' + n(tw, 4) + ' = ' + n(lossW, 4));
      res.step('Net area An = Ag - holes x hole x thickness = ' + n(out.Ag, 4) + ' - ' + parts.join(' - ') + ' = ' + n(out.An, 4) + ' in^2.', SRC.b43);
      if (nF === 1) res.flag('NOTE: for a tee "per flange" means the one flange; "web holes" are in the stem.');
      return out;
    }
    if (a.holes && a.holes.length) {
      var hs = a.holes.map(function (h, ix) {
        var across, hname = String.fromCharCode(65 + ix);
        if (kind === 'angle' && isNum(h.gage) && isNum(h.leg)) {
          var L1 = shape.d, tt = shape.t;
          across = h.leg === 1 ? L1 - h.gage : L1 - tt + h.gage;
          if (isNum(h.across)) res.flag('NOTE: hole ' + hname + ': leg and gage were used, so "across" was NOT used.');
        } else if (isNum(h.across)) {
          across = h.across;
          if (isNum(h.gage) || isNum(h.leg)) res.flag('NOTE: hole ' + hname + ': "across" was used, so ' + (kind === 'angle' ? 'the incomplete leg / gage pair' : 'leg / gage (they apply to an angle)') + ' was NOT used.');
        } else fail('MISSING', 'Hole ' + String.fromCharCode(65 + ix) + ': give "across" (plate) or leg + gage (angle).');
        return { along: h.along, across: across };
      });
      for (i = 0; i < hs.length; i++) {
        for (var j = i + 1; j < hs.length; j++) { if (Math.abs(hs[i].along - hs[j].along) < 1e-9 && Math.abs(hs[i].across - hs[j].across) < 1e-9) res.flag('WARNING: holes ' + String.fromCharCode(65 + i) + ' and ' + String.fromCharCode(65 + j) + ' are at the same position.'); }
      }
      if (kind === 'angle') res.step('The angle is unfolded flat: the gage across the corner = ga + gb - t (the two gages measured from the back of the angle, minus the thickness).', SRC.b43);
      var paths = holePaths(hs, hole);
      paths.sort(function (p, q) { return q.reduction - p.reduction; });
      var best = paths[0];
      out.paths = paths; out.best = best;
      var t = out.t, ref = out.widthRef;
      var rows = paths.map(function (p) {
        var nw = ref - p.reduction;
        return [p.label, p.n, Math.round(p.add * 10000) / 10000, Math.round(nw * 10000) / 10000, Math.round((out.Ag - out.nAng * t * p.reduction) * 10000) / 10000];
      });
      res.table('Every failure path (smallest net width governs)', ['Path', 'holes', 'sum of s^2/4g added back', 'net width, in', 'An, in^2'], rows);
      var distinct = [];
      rows.forEach(function (r) { var v = Math.round(r[3] * 1000) / 1000; if (distinct.indexOf(v) < 0) distinct.push(v); });
      distinct.sort(function (p, q) { return p - q; });
      out.distinct = distinct;
      res.step('Staggered holes: each failure path goes through some holes, net width = ' + (kind === 'plate' ? 'width' : 'unfolded width') + ' - (holes on the path) x hole + sum of s^2/4g for each diagonal.  ' + paths.length + ' paths, ' + distinct.length + ' different values: ' + distinct.join(' / ') + ' in.', SRC.b43);
      var terms = best.terms.filter(function (q) { return Math.abs(q.s) > 1e-12; }).map(function (q) { return n(q.s, 3) + '^2/(4 x ' + n(q.g, 3) + ')'; }).join(' + ');   // R2-8: a straight path (s = 0) adds nothing
      res.step('Smallest net width: path ' + best.label + ': ' + n(ref, 4) + ' - ' + best.n + ' (' + n(hole, 4) + ')' + (terms ? ' + ' + terms : '') + ' = ' + n(ref - best.reduction, 4) + ' in.', SRC.b43);
      out.An = out.Ag - out.nAng * t * best.reduction;
      res.step('An = ' + (kind === 'plate' ? 'net width x thickness = ' + n(ref - best.reduction, 4) + ' x ' + n(t, 4) : 'Ag - ' + (out.nAng > 1 ? out.nAng + ' x ' : '') + 't x (reduction) = ' + n(out.Ag, 4) + ' - ' + (out.nAng > 1 ? out.nAng + ' x ' : '') + n(t, 4) + ' x ' + n(best.reduction, 4)) + ' = ' + n(out.An, 4) + ' in^2.', SRC.b43);
      return out;
    }
    // simple count of holes in the critical section
    var cnt = a.holes_across || 0;
    var th = out.t !== null ? out.t : (isNum(shape.tdes) ? shape.tdes : (isNum(shape.t) ? shape.t : null));
    if (th === null) fail('MISSING', 'Cannot find the thickness of ' + (shape ? shape.label : 'the member') + ' for the hole area; use holes_per_flange / web_holes for rolled shapes.');
    out.t = th;
    out.An = out.Ag - out.nAng * cnt * hole * th;
    res.step('Net area An = Ag - ' + (out.nAng > 1 ? out.nAng + ' angles x ' : '') + cnt + ' hole' + (cnt > 1 ? 's' : '') + ' x ' + n(hole, 4) + ' x t ' + n(th, 4) + ' = ' + n(out.Ag, 4) + ' - ' + n(out.nAng * cnt * hole * th, 4) + ' = ' + n(out.An, 4) + ' in^2.', SRC.b43);
    return out;
  }

  def('tension_net_area', 'Tension', 'Net area (with staggered holes)', 'Ag, hole = bolt + 1/8, and An. Staggered holes: every path through the holes is checked (net width = width - n x hole + sum of s^2/4g), the smallest governs.', TENSION_MEMBER_FIELDS, function (a, res) {
    var r = netAreaCore(a, res);
    res.val('Ag', r.Ag, 'in^2', SRC.shapes).val('An', r.An, 'in^2', SRC.b43);
    if (r.hole !== null) res.val('hole', r.hole, 'in', SRC.b43);
    if (r.distinct) res.val('distinct_path_widths', r.distinct, 'in', SRC.b43).val('path_count', r.paths.length, '').val('min_net_width', r.widthRef - r.best.reduction, 'in', SRC.b43);
    res.answer('Net area An', r.An, 'in^2', 'An = ' + n(r.An, 4) + ' in^2  (Ag = ' + n(r.Ag, 4) + ' in^2, ' + r.label + ')');
    if (r.aisc) res.alt('AISC net area An (hole = bolt + 3/16 = ' + n(r.aisc.hole, 4) + ' in)', r.aisc.An, 'in^2', 'An = ' + n(r.aisc.An, 4) + ' in^2 with the AISC hole instead of her ' + n(r.hole, 4) + ' in (her An = ' + n(r.An, 4) + ' in^2 stays the answer)');
    res.flag('NOTE: this is An. For Ae, run Tension > Capacity: it prints U and Ae in its key numbers.');
    return res;
  });

  // ===================================================================================================================
  // STEEL FOR A TENSION MEMBER (P4).  ONE helper decides Fy and Fu for tension_capacity, tension_select and tension_required_area.
  //   both typed                    -> used.  Fu must be greater than Fy, and a pair that is not a grade of her table is flagged.
  //   neither typed                 -> the member's default grade (her week-1 slide).
  //   Fu alone                      -> used only if it is the default grade's own Fu (Fy would be a guess otherwise): else MISSING with bolt holes.
  //   Fy 36 alone, A36 plausible    -> A36 -> Fu 58: the step "Fy 36 -> A36 -> Fu 58" and a NOTE (the commonest alternate steel in her course).
  //   Fy alone = the default Fy     -> the default grade's Fu (65, or 62 for HSS, 60 for pipe, 58 for an A36 plate), with a NOTE.
  //   Fy 50 alone on a plate        -> her alternate plate steel, A572 Gr 50 -> Fu 65 (the plate default is A36).
  //   any other Fy alone            -> with bolt holes MISSING, listing the candidate grades so Fu can be typed; without holes Fu is not used.
  // ===================================================================================================================
  var A36_FAMILIES = ['W', 'C', 'MC', 'M', 'S', 'HP', 'L', 'WT', 'MT', 'ST', '2L', 'PL'];   // where A36 is plausible (PL = a plate)
  // Fy values that do not identify ONE grade, with the candidates (shown when a lone Fy is refused)
  var FY_CANDIDATES = {
    46: 'A500 Gr B rect 58 / Gr C round 62',
    42: 'A500 Gr B round 58',
    35: 'A53 Gr B 60'
  };

  // the Fy / Fu pairs of her table (data/materials.js), without repeats, as text such as "A992 50/65"
  function knownGradePairs() {
    var M = DATA().materials, out = [], seen = {}, i, r, name, key;
    if (!M || !M.rows) return out;
    for (i = 0; i < M.rows.length; i++) {
      r = M.rows[i]; name = r.spec.replace(/^ASTM /, '') + (r.grade ? ' ' + r.grade.replace(/^Grade /, 'Gr ') : ''); key = r.Fy + '/' + r.Fu;
      if (!seen[key]) { seen[key] = true; out.push({ Fy: r.Fy, Fu: r.Fu, text: key, names: [name] }); } else { for (var j = 0; j < out.length; j++) { if (out[j].text === key && out[j].names.indexOf(name) < 0) out[j].names.push(name); } }
    }
    return out;
  }

  // Both Fy and Fu were typed (or are the form's pre-filled values): Fu must be larger than Fy (swapped boxes are refused), and a pair that is
  // not one of the grades of her table is flagged so a typo (Fy 36 with Fu 65) cannot pass unseen.
  function checkSteelPair(res, fy, fu) {
    if (!(fu > fy)) fail('INVALID', 'Fu (' + n(fu, 3) + ' ksi) must be greater than Fy (' + n(fy, 3) + ' ksi): the two boxes look swapped. Check the problem: A36 is Fy 36 / Fu 58, A992 is Fy 50 / Fu 65.');
    var known = knownGradePairs(), i, found = false;
    for (i = 0; i < known.length; i++) { if (Math.abs(known[i].Fy - fy) < 1e-9 && Math.abs(known[i].Fu - fu) < 1e-9) found = true; }
    if (!found && known.length) res.flag('CHECK: Fy ' + n(fy, 3) + ' / Fu ' + n(fu, 3) + ' is not one of the grades in her table (' + known.map(function (k) { return k.names.join(' = ') + ' ' + k.text; }).join('; ') + '). If the problem gives these numbers, ignore this flag; if one of them is a typo, fix it.');
  }

  // her table row with this spec (for the A36 Fu), or null
  function materialRowBySpec(spec) {
    var M = DATA().materials, i;
    if (!M || !M.rows) return null;
    for (i = 0; i < M.rows.length; i++) { if (M.rows[i].spec === spec) return M.rows[i]; }
    return null;
  }

  // her table row with this Fy that applies to the family (a plate: the alternate A572 Gr 50 row), or null.  Tees follow the W / M / S they
  // are cut from and a double angle follows the angle (derived_families).
  function materialRowByFy(fy, famType) {
    var M = DATA().materials, i, r, parent = (M && M.derived_families && M.derived_families[famType]) || famType;
    if (!M || !M.rows) return null;
    for (i = 0; i < M.rows.length; i++) {
      r = M.rows[i];
      if (Math.abs(r.Fy - fy) < 1e-9 && (r.families.indexOf(famType) >= 0 || r.families.indexOf(parent) >= 0)) return r;
    }
    return null;
  }

  function gradeName(row) { return row.spec.replace(/^ASTM /, '') + (row.grade ? ' ' + row.grade.replace(/^Grade /, 'Gr ') : ''); }

  // Fu alone with bolt holes: Fy would be a guess.
  function fyFuPairMissing(gaveFy, defFy, defFu) {
    fail('MISSING', 'Missing: ' + (gaveFy ? 'Fu' : 'Fy') + '. You gave ' + (gaveFy ? 'Fy' : 'Fu') + ' only, but rupture (bolt holes) needs the PAIR, and the other one would silently come from the default grade. Usual pairs: A36 Fy 36 / Fu 58; A992 and A572 Gr 50 Fy 50 / Fu 65; A53 Gr B pipe Fy 35 / Fu 60; A500 Gr C HSS Fy 50 / Fu 62. Enter both, or clear it to use this member\'s default (Fy ' + n(defFy, 3) + ', Fu ' + n(defFu, 3) + ').');
  }

  // The text listing the candidate grades for a lone Fy that does not identify one grade.
  function fyCandidatesText(fy) {
    var known = knownGradePairs();
    if (FY_CANDIDATES[fy]) return 'Fy ' + n(fy, 3) + ' could be ' + FY_CANDIDATES[fy] + ' (Fu in ksi).';
    return 'Fy ' + n(fy, 3) + ' is not the Fy of one grade in her table (' + known.map(function (k) { return k.names.join(' = ') + ' ' + k.text; }).join('; ') + ').';
  }

  // famType: the shape type of the member ('W', 'L', 'WT', 'HSS', 'PIPE' ...) or 'PL' for a plate;  base: the member's default grade
  // { Fy, Fu, spec };  bolted: bolt holes are in the section, so rupture (Fu) matters;  Returns { Fy, Fu, special } where `special` is the
  // step to print when Fu was inferred from the typed Fy (null otherwise: the caller prints its usual steel step).
  function tensionSteel(res, a, famType, bolted, base) {
    var gaveFy = isNum(a.Fy), gaveFu = isNum(a.Fu), out = { Fy: base.Fy, Fu: base.Fu, special: null }, row;
    if (gaveFy && gaveFu) { checkSteelPair(res, a.Fy, a.Fu); out.Fy = a.Fy; out.Fu = a.Fu; return out; }
    if (!gaveFy && !gaveFu) return out;
    if (gaveFu) {      // Fu alone
      out.Fu = a.Fu;
      if (bolted) {
        if (Math.abs(a.Fu - base.Fu) < 1e-9) res.flag('NOTE: only Fu (' + n(a.Fu, 3) + ' ksi) was entered; it equals the default grade of this member, so Fy was taken from that grade (Fy ' + n(base.Fy, 3) + ' / Fu ' + n(base.Fu, 3) + ').');
        else fyFuPairMissing(false, base.Fy, base.Fu);
      }
      return out;
    }
    // Fy alone
    out.Fy = a.Fy;
    if (Math.abs(a.Fy - 36) < 1e-9 && A36_FAMILIES.indexOf(famType) >= 0) {          // A36
      row = materialRowBySpec('ASTM A36');
      out.Fu = row ? row.Fu : 58;
      out.special = 'Fy 36 -> A36 -> Fu ' + n(out.Fu, 3) + '  (only Fy = 36 ksi was typed; her week-1 slide: ASTM A36 is Fy 36 / Fu ' + n(out.Fu, 3) + ').';
      res.flag('NOTE: only Fy 36 was typed. Fy 36 is ASTM A36 (her week-1 slide: Fy 36 / Fu ' + n(out.Fu, 3) + '), so Fu = ' + n(out.Fu, 3) + ' ksi was used' + (bolted ? ' in the rupture check' : '') + '. If the steel is not A36, type Fu.');
      return out;
    }
    if (Math.abs(a.Fy - base.Fy) < 1e-9) {                                           // the member's own default grade
      out.Fu = base.Fu;
      if (!bolted) return out;      // no bolt holes: Fu is not used, the answer is as it always was
      out.special = 'Fy ' + n(a.Fy, 3) + ' -> ' + base.spec + ' -> Fu ' + n(base.Fu, 3) + '  (only Fy was typed; it is the default grade of this member, her week-1 slide).';
      res.flag('NOTE: only Fy (' + n(a.Fy, 3) + ' ksi) was entered; it equals the default grade of this member, so the other value was taken from that grade (Fy ' + n(base.Fy, 3) + ' / Fu ' + n(base.Fu, 3) + ').');
      return out;
    }
    row = materialRowByFy(a.Fy, famType);                                              // e.g. a plate with Fy 50 -> A572 Gr 50
    if (row) {
      out.Fu = row.Fu;
      out.special = 'Fy ' + n(a.Fy, 3) + ' -> ' + gradeName(row) + (row.alternate ? ' (her alternate steel for this member)' : '') + ' -> Fu ' + n(row.Fu, 3) + '.';
      res.flag('NOTE: only Fy (' + n(a.Fy, 3) + ' ksi) was entered; in her table that is ' + gradeName(row) + ' (Fu ' + n(row.Fu, 3) + '), so Fu = ' + n(row.Fu, 3) + ' ksi was used. If the steel is another grade, type Fu.');
      return out;
    }
    if (bolted) fail('MISSING', 'Missing: Fu. ' + fyCandidatesText(a.Fy) + ' Fy alone does not identify one grade, and rupture (bolt holes) needs Fu: type it. Filled in automatically: Fy 36 -> A36 -> Fu 58, and the Fy of this member\'s own default grade (Fy ' + n(base.Fy, 3) + ' / Fu ' + n(base.Fu, 3) + ').');
    return out;      // no bolt holes: Fu is not used
  }

  // material for a tension member (tension_capacity)
  function tensionMaterial(a, shape, kind, res, bolted) {
    var base;
    if (kind === 'plate') base = plateMaterial();
    else base = materialFor(shape.type) || { Fy: 50, Fu: 65, spec: 'default', derived: false, override: null };
    var st = tensionSteel(res, a, kind === 'plate' ? 'PL' : shape.type, bolted, base), fy = st.Fy, fu = st.Fu;
    if (kind !== 'plate') roundHssNote(res, shape, fy);
    if (base.override && !isNum(a.Fy)) res.flag('WARNING: ' + ovText(base.override));
    if (kind === 'plate' && !isNum(a.Fy)) res.flag('NOTE: plate defaults to A36 (Fy 36, Fu 58) from her slide ("use the lowest unless told"); if the problem says A572 Gr 50 enter Fy 50, Fu 65.');
    if (st.special) res.step(st.special, SRC.mat);
    else if (!isNum(a.Fy) && !isNum(a.Fu)) { res.step('Steel: ' + base.spec + ' -> Fy = ' + n(fy, 3) + ' ksi, Fu = ' + n(fu, 3) + ' ksi (her week-1 slide).', SRC.mat); }
    else res.step('Steel given: Fy = ' + n(fy, 3) + ' ksi, Fu = ' + n(fu, 3) + ' ksi.', SRC.given);
    return { Fy: fy, Fu: fu };
  }

  var CAPACITY_FIELDS = TENSION_MEMBER_FIELDS.concat([
    F('welded', 'boolean', 'Welded / no bolt holes: check yielding ONLY', '', { default: false }),
    F('connection', 'select', 'Where is the member connected? (for U)', '', { values: CONNECTION_VALUES }),
    F('fasteners_per_line', 'integer', 'Fasteners per line in the direction of the load', '', { min: 1 }),
    F('fastener_lines', 'integer', 'Angles: number of lines of fasteners (she counts ALL the fasteners; AISC counts per line)', '', { default: 1, min: 1 }),
    F('tee_rule', 'select', 'Tees: depth for the 2/3 d test', '', { values: TEE_RULE_VALUES }),
    F('xbar_in', 'number', 'Case 2 only: x-bar', 'in', { min: 0 }),
    F('l_in', 'number', 'Case 2 only: connection length l', 'in', { min: 0, minExclusive: true }),
    F('pitch_in', 'number', 'W or tee through the FLANGES: bolt spacing along the force (pitch), shows the AISC Case 2 value beside Case 7: l = (fasteners per line - 1) x pitch', 'in', { min: 0, minExclusive: true }),
    F('U', 'number', 'OR the shear lag factor U given in the problem', '', { min: 0, minExclusive: true, max: 1 }),
    F('Fy', 'number', 'Fy (blank = from the shape / plate)', 'ksi', { min: 1, minExclusive: true }),
    F('Fu', 'number', 'Fu (blank = from the shape / plate)', 'ksi', { min: 1, minExclusive: true }),
    F('length_ft', 'number', 'Member length (only to check L/r <= 300)', 'ft', { min: 0 })
  ]).concat(LOAD_FIELDS('kips'));

  // the double-angle L/r note (tension_capacity and tension_select): one angle's radius is used for the pair, and that errs on the safe side
  function doubleAngleNote(lr, r) {
    return 'NOTE: double angle: L/r = ' + n(lr, 1) + ' was checked with the radius of ONE angle, min(rx, ry) = ' + n(r, 3) + ' in. That is conservative: the pair\'s own smaller radius of gyration is at least that (checked on all 639 double-angle rows of the database; the only exceptions are six 2L2-1/2X1-1/2 rows, 0.5% lower). For the pair\'s own r use the 2L shape (for example 2L4X4X1/2; in Select the family 2L4).';
  }

  function slendernessTension(res, s, nAng, kind, t, lengthFt) {
    if (!isNum(lengthFt)) return null;
    var r, txt;
    if (kind === 'plate') { r = t / Math.sqrt(12); txt = 'plate r = t / sqrt(12) = ' + n(r, 4); }
    else { r = rMinOf(s, nAng); txt = 'smallest radius of gyration r = ' + n(r, 4) + ' in'; }
    var lr = 12 * lengthFt / r;
    if (kind === 'angle' && nAng === 2 && s.type === 'L') res.flag(doubleAngleNote(lr, r));
    res.step('Slenderness: L/r = 12 x ' + n(lengthFt, 3) + ' / ' + n(r, 4) + ' = ' + n(lr, 1) + ' (' + txt + ')  ' + (lr <= 300 ? '<= 300 OK.' : '> 300: TOO SLENDER.'), SRC.d1);
    if (lr > 300) res.flag('WARNING: L/r = ' + n(lr, 1) + ' exceeds 300.');
    res.val('L_over_r', lr, '', SRC.d1);
    return lr;
  }

  function tensionStrengths(core, mat, u, welded) {
    var y = 0.9 * mat.Fy * core.Ag;
    if (welded) return { yield: y, rupture: null, cap: y, governs: 'yielding' };
    var ae = u * core.An, rup = 0.75 * mat.Fu * ae;
    return { yield: y, rupture: rup, ae: ae, cap: Math.min(y, rup), governs: y <= rup ? 'yielding' : 'rupture' };
  }

  def('tension_capacity', 'Tension', 'Tension capacity of a given member', 'phi Pn = the smaller of yielding 0.90 Fy Ag and rupture 0.75 Fu Ae (Ae = U An): the "first failure load". Welded / no holes: yielding only. Optional check against a load.', CAPACITY_FIELDS, function (a, res) {
    var core0 = null;
    var shape = isBlank(a.shape) ? null : findShape(a.shape);
    var kind = a.member || (shape ? ((shape.type === 'L' || shape.type === '2L') ? 'angle' : 'shape') : 'plate');
    if (kind !== 'plate' && !shape) fail('MISSING', 'Enter the shape (a rolled shape such as W14X90, or an angle such as L4X4X1/2) -- or choose "plate" and enter its width and thickness.');
    var welded = !!a.welded || a.connection === 'welded';
    var boltedHoles = !welded && (a.holes_across > 0 || (a.holes && a.holes.length > 0) || a.holes_per_flange > 0 || a.web_holes > 0);
    var mat = tensionMaterial(a, shape, kind, res, boltedHoles);
    if (welded && (a.holes_across > 0 || (a.holes && a.holes.length) || a.holes_per_flange > 0 || a.web_holes > 0)) res.flag('WARNING: the member is welded (' + (a.welded ? '"welded" is ticked' : 'connection = welded') + '), but holes were also entered; the holes were ignored and only yielding is checked. If the member is bolted, untick "welded" / change the connection.');
    if (welded) {
      var weldUnused = ['bolt_dia_in', 'hole_dia_in', 'fasteners_per_line', 'U', 'tee_rule', 'xbar_in', 'l_in', 'pitch_in'];
      if (a.connection && a.connection !== 'welded') weldUnused.push('connection');
      if (a.fastener_lines > 1) weldUnused.push('fastener_lines');
      noteUnused(res, a, weldUnused, 'the member is welded (only yielding is checked)');
    }
    var args2 = {};
    for (var k in a) { if (has(a, k)) args2[k] = a[k]; }
    if (welded) { args2.welded = true; args2.holes = []; args2.holes_across = 0; args2.holes_per_flange = 0; args2.web_holes = 0; args2.bolt_dia_in = undefined; args2.hole_dia_in = undefined; args2.connection = undefined; args2.fasteners_per_line = undefined; args2.U = undefined; }
    core0 = netAreaCore(args2, res);
    var u = null, uText = '', g6 = null;
    var hasHoles = !welded && (args2.holes_across > 0 || (args2.holes && args2.holes.length > 0) || args2.holes_per_flange > 0 || args2.web_holes > 0);
    if (!welded && !hasHoles) res.flag('NOTE: no holes were entered and "welded" is not ticked, so the member is treated as having no holes (yielding only). If it is bolted, enter the holes.');
    if (!hasHoles) noteUnused(res, a, welded ? ['Fu'] : ['Fu', 'pitch_in', 'xbar_in', 'l_in', 'tee_rule', 'fastener_lines'], 'there are no bolt holes, so only yielding (Fy) is checked');
    if (hasHoles) {
      if (isNum(a.U)) {
        u = a.U; uText = 'U = ' + fixed(u, 2) + ' (given in the problem).';
        var uUnused = ['connection', 'fasteners_per_line', 'tee_rule', 'xbar_in', 'l_in', 'pitch_in'];
        if (a.fastener_lines > 1) uUnused.push('fastener_lines');
        noteUnused(res, a, uUnused, 'U was given (' + fixed(u, 2) + ')');
      } else {
        var conn = a.connection || (kind === 'plate' ? 'all' : (kind === 'angle' ? 'angle' : null));
        if (!conn) fail('MISSING', 'Where is the member connected? Choose the connection (flanges / web / all parts) so U can be found.');
        var perLine = isNum(a.fasteners_per_line) ? a.fasteners_per_line : (conn === 'all' || conn === 'case2' ? 0 : null);
        if (perLine === null) fail('MISSING', 'Missing: fasteners per line (needed for U).');
        if (conn === 'all') noteUnused(res, a, ['fasteners_per_line'], 'every part of the section is connected (Case 1, U = 1.0)');
        if (conn !== 'angle' && a.fastener_lines > 1) noteUnused(res, a, ['fastener_lines'], 'the connection is not an angle');
        if (!(conn === 'flanges' && core0.shape && /^(WT|MT|ST)$/.test(core0.shape.type))) noteUnused(res, a, ['tee_rule'], 'the tee depth rule only applies to a tee connected through its flange');
        var uf = uFactor(conn, perLine, core0.shape && kind !== 'plate' ? core0.shape : null, a.tee_rule, a.xbar_in, a.l_in, res, a.fastener_lines);
        u = uf.U; uText = uf.text;
        uf.info.forEach(function (t) { res.flag('NOTE: ' + t); });
        g6 = usedCase2(uf) ? null : case2Beside(a, core0.shape && kind !== 'plate' ? core0.shape : null, conn, perLine, uf, res);
        if (g6 && g6.why) res.flag('NOTE: the AISC Case 2 comparison was NOT made: ' + g6.why + '. Her Case 7 value stands, and ' + (g6.typed.length > 1 ? 'these entries were' : 'this entry was') + ' NOT used: ' + g6.typed.join(', ') + '.');
        else {
          if (!usedCase2(uf) && !(g6 && g6.computed)) noteUnused(res, a, ['xbar_in', 'l_in'], 'the shear lag factor did not come from Case 2 and no Case 2 comparison could be made');
          if (!(g6 && g6.computed)) noteUnused(res, a, ['pitch_in'], 'the Case 2 comparison is made only for a W-shape or tee connected through the FLANGES with 3 or more fasteners per line');
          if (g6 && g6.pitchUnused) res.flag('NOTE: l was typed (' + fixed(a.l_in, 3) + ' in), so the bolt spacing was NOT used: pitch_in.');
        }
        uf.alts.forEach(function (x) { res.alt('U by ' + x.label, x.U, '', x.text || (x.U === null ? '' : 'U = ' + fixed(x.U, 2))); });
        if (uf.flag) res.flag(uf.flag);
      }
      res.step(uText, SRC.d31);
    }
    var st = tensionStrengths(core0, mat, u, welded || u === null);
    var yTxt = '0.90 x ' + n(mat.Fy, 3) + ' x ' + n(core0.Ag, 4) + ' = ' + n(st.yield, 2) + ' kips';
    res.step('Yielding of the gross section: phi Pn = 0.90 Fy Ag = ' + yTxt + '.', SRC.d2a);
    if (st.rupture !== null) {
      res.step('Effective net area Ae = U An = ' + fixed(u, 2) + ' x ' + n(core0.An, 4) + ' = ' + n(st.ae, 4) + ' in^2.', SRC.d3);
      res.step('Rupture of the net section: phi Pn = 0.75 Fu Ae = 0.75 x ' + n(mat.Fu, 3) + ' x ' + n(st.ae, 4) + ' = ' + n(st.rupture, 2) + ' kips.', SRC.d2b);
    } else res.step('No bolt holes: rupture is not checked -- "we only check yielding".', 'Her rule (9/30 review)');
    res.step('First failure load = the SMALLER: ' + n(st.cap, 2) + ' kips (' + st.governs + ' governs).', 'Her rule: first failure load');
    var g6cap = null, g6diff = false;
    if (g6 && g6.computed && st.rupture !== null) {
      g6cap = Math.min(st.yield, 0.75 * mat.Fu * g6.uAISC * core0.An);
      g6diff = Math.abs(g6.uAISC - g6.u7her) > 1e-9;   // the U AISC would use is not the U of the headline: Case 2 is larger, or a tee whose Specification Case 7 differs from her rule
      var g6head = 'AISC Table D3.1 also allows Case 2, and permits the LARGER of Case 7 and Case 2 (the Design Examples do this; she uses Case 7 only). Case 2: ' + g6.xText + '; ' + g6.lText + '; U = 1 - x-bar / l = 1 - ' + fixed(g6.xbar, 3) + ' / ' + n(g6.l, 4) + ' = ' + fixed(g6.U2, 3) + '. ';
      var tee7 = Math.abs(g6.u7aisc - g6.u7her) > 1e-9;   // a tee: the Specification's Case 7 (the depth of the W it was cut from) differs from her rule (the tee's own depth)
      var c7txt = tee7 ? 'Case 7 by the Specification (d of the W the tee was cut from) U = ' + fixed(g6.u7aisc, 3) + ' (her rule, the tee\'s own depth, gave ' + fixed(g6.u7her, 3) + ')' : 'Case 7 (U = ' + fixed(g6.u7aisc, 3) + ')';
      var g6lead = g6.larger ? 'That is larger than ' + c7txt + ': ' : 'That is not larger than ' + c7txt + ', so AISC uses the Specification Case 7 (U = ' + fixed(g6.u7aisc, 3) + '): ';
      var g6rup = 0.75 * mat.Fu * g6.uAISC * core0.An;
      if (!g6diff) res.step(g6head + (g6.larger ? 'That is larger than ' + c7txt + ' and equals the U of the headline, so nothing changes.' : 'That is not larger than ' + c7txt + ', so the larger is Case 7 and nothing changes.'), SRC.d31);
      else if (Math.abs(g6cap - st.cap) <= 1e-9) res.step(g6head + g6lead.replace(/: $/, '') + ', but phi Pn does not change (yielding governs).', SRC.d31);
      else res.step(g6head + g6lead + 'Ae = ' + n(g6.uAISC, 5) + ' x ' + n(core0.An, 4) + ' = ' + n(g6.uAISC * core0.An, 5) + ' in^2; rupture phi Pn = 0.75 x ' + n(mat.Fu, 3) + ' x ' + n(g6.uAISC * core0.An, 5) + ' = ' + n(g6rup, 2) + ' kips; phi Pn = the smaller of yielding ' + n(st.yield, 2) + ' and rupture = ' + n(g6cap, 2) + ' kips. ' + (g6cap > st.cap ? 'Her Case 7 value (' + n(st.cap, 2) + ' kips) stays the headline.' : 'That is LOWER than her headline (' + n(st.cap, 2) + ' kips), because her tee rule takes the tee\'s own depth (U = ' + fixed(g6.u7her, 3) + '); her value stays the headline.'), SRC.d31);
      res.val('U_case2', g6.U2, '', SRC.d31).val('xbar_case2', g6.xbar, 'in', SRC.d31).val('l_case2', g6.l, 'in', SRC.d31);
    }
    res.val('Ag', core0.Ag, 'in^2', SRC.shapes).val('An', core0.An, 'in^2', SRC.b43).val('Fy', mat.Fy, 'ksi', SRC.mat).val('Fu', mat.Fu, 'ksi', SRC.mat);
    if (core0.hole !== null) res.val('hole', core0.hole, 'in', SRC.b43);
    if (u !== null && st.rupture !== null) res.val('U', u, '', SRC.d31).val('Ae', st.ae, 'in^2', SRC.d3).val('rupture', st.rupture, 'kips', SRC.d2b);
    res.val('yielding', st.yield, 'kips', SRC.d2a).val('capacity', st.cap, 'kips').val('governs', st.governs, '');
    if (core0.distinct) res.val('distinct_path_widths', core0.distinct, 'in', SRC.b43);
    var txt = 'phi Pn = ' + n(st.cap, 1) + ' kips -- ' + st.governs + ' governs' + (st.rupture !== null ? ' (yielding ' + n(st.yield, 1) + ', rupture ' + n(st.rupture, 1) + ')' : ' (no holes)');
    var ld = loadFromArgs(a, res);
    if (ld) {
      var okL = st.cap + 1e-9 >= ld.Pu;
      res.step('Compare: phi Pn = ' + n(st.cap, 2) + ' kips ' + (okL ? '>' : '<') + ' Pu = ' + n(ld.Pu, 2) + ' kips ' + (okL ? 'ok' : 'NG') + '.', SRC.lrfd);
      res.val('Pu', ld.Pu, 'kips', SRC.lrfd).val('adequate', okL, '');
      txt += okL ? '; adequate for Pu = ' + n(ld.Pu, 1) : '; NOT adequate for Pu = ' + n(ld.Pu, 1);
      if (!okL) res.flag('WARNING: the member is NOT adequate for Pu = ' + n(ld.Pu, 2) + ' kips.');
    }
    slendernessTension(res, core0.shape, core0.nAng, kind, core0.t, a.length_ft);
    res.answer('Tension capacity (first failure load)', st.cap, 'kips', txt);
    if (st.rupture !== null) res.alt('yielding alone', st.yield, 'kips', 'phi Pn = 0.90 Fy Ag');
    if (st.rupture !== null) res.alt('rupture alone', st.rupture, 'kips', 'phi Pn = 0.75 Fu Ae');
    if (core0.aisc) {
      var anA = core0.aisc.An;
      res.alt('AISC net area An (hole = bolt + 3/16 = ' + n(core0.aisc.hole, 4) + ' in)', anA, 'in^2', 'An = ' + n(anA, 4) + ' in^2 with the AISC hole instead of her ' + n(core0.hole, 4) + ' in (her An = ' + n(core0.An, 4) + ' in^2 stays the answer)');
      if (st.rupture !== null) {
        var aeA = u * anA, rupA = 0.75 * mat.Fu * aeA, capA = Math.min(st.yield, rupA);
        res.alt('AISC effective net area Ae = U An', aeA, 'in^2', 'Ae = ' + fixed(u, 2) + ' x ' + n(anA, 4) + ' = ' + n(aeA, 4) + ' in^2; rupture phi Pn = 0.75 x ' + n(mat.Fu, 3) + ' x ' + n(aeA, 4) + ' = ' + n(rupA, 2) + ' kips; phi Pn = the smaller of yielding ' + n(st.yield, 2) + ' and rupture = ' + n(capA, 2) + ' kips (her ' + n(st.cap, 2) + ' kips stays the headline)');
        if (Math.abs(capA - st.cap) > 1e-9) res.flag('CHECK: with the AISC net-area hole (bolt + 3/16) phi Pn = ' + n(capA, 2) + ' kips, ' + (capA < st.cap ? 'LOWER' : 'higher') + ' than her ' + n(st.cap, 2) + ' kips (rupture ' + n(rupA, 2) + ' kips). Her rule is the course answer; AISC is the code. It is shown as an alternative.');
      }
    }
    if (g6cap !== null && g6diff && Math.abs(g6cap - st.cap) > 1e-9) {
      var g6low = g6cap < st.cap;
      res.alt('AISC: the LARGER of Case 7 and Case 2 (U = ' + fixed(g6.uAISC, 3) + ' instead of ' + (g6low ? 'her ' : '') + fixed(g6.u7her, 3) + (g6low ? '; LOWER than her headline' : '') + ')', g6cap, 'kips', g6.xText + '; ' + g6.lText + '; Ae = ' + n(g6.uAISC * core0.An, 5) + ' in^2; phi Pn = the smaller of yielding ' + n(st.yield, 2) + ' and rupture ' + n(0.75 * mat.Fu * g6.uAISC * core0.An, 2));
      res.val('phiPn_AISC_larger_U', g6cap, 'kips', SRC.d31);
      res.flag(g6low ? 'NOTE: TEE: by the Specification (Case 7 U = ' + fixed(g6.u7aisc, 3) + ', Case 2 U = ' + fixed(g6.U2, 3) + (g6.larger ? ', the larger is used' : ', which is not larger, so Case 7 is used') + ') phi Pn = ' + n(g6cap, 4) + ' kips, LOWER than her headline ' + n(st.cap, 4) + ' kips, which takes the tee\'s own depth for Case 7 (U = ' + fixed(g6.u7her, 3) + '). Her value stays the headline; the Specification answer is shown as an alternative.' : 'NOTE: AISC Table D3.1 permits the LARGER of Case 7 (U = ' + fixed(g6.u7aisc, 3) + ') and Case 2 (U = ' + fixed(g6.U2, 3) + '): phi Pn = ' + n(g6cap, 4) + ' kips instead of ' + n(st.cap, 4) + ' (shown as an alternative). Her Case 7 value is the headline; the Design Examples use the larger U.');
    }
    res.flag('NOTE: block shear is not checked (every homework says to neglect it); bolt shear and bearing are connection topics.');
    return res;
  });

  def('tension_required_area', 'Tension', 'Required area from a load', 'Ag >= Pu / (0.90 Fy) (yielding); for bolted members Ae >= Pu / (0.75 Fu) is the rupture counterpart. Loads are SERVICE loads unless the box says factored.', LOAD_FIELDS('kips').concat([
    F('Fy', 'number', 'Fy', 'ksi', { default: 50, min: 1, minExclusive: true }),
    F('Fu', 'number', 'Fu', 'ksi', { default: 65, min: 1, minExclusive: true })
  ]), function (a, res) {
    var ld = loadFromArgs(a, res);
    if (!ld) fail('MISSING', 'Enter D and L (service), or tick "already factored" and enter Pu.');
    // Fy / Fu: the same helper as the member functions.  The engine's own defaults are 50 / 65 (A992); a lone Fy 36 gives A36 / Fu 58.
    // This is only a first guess (no member yet), so a lone Fy that identifies no grade is a WARNING, not a refusal.
    var Fy = a.Fy, Fu = a.Fu;
    if (res.gave('Fy') || res.gave('Fu')) {
      var stR = tensionSteel(res, { Fy: res.gave('Fy') ? a.Fy : undefined, Fu: res.gave('Fu') ? a.Fu : undefined }, 'W', false, { Fy: 50, Fu: 65, spec: 'ASTM A992' });
      Fy = stR.Fy; Fu = stR.Fu;
      if (res.gave('Fu') && !res.gave('Fy')) checkSteelPair(res, Fy, Fu);      // Fu alone: Fy is the default 50
      if (stR.special) res.step(stR.special, SRC.mat);
      else if (res.gave('Fy') && !res.gave('Fu') && Math.abs(Fy - 50) > 1e-9) res.flag('WARNING: ' + fyCandidatesText(Fy) + ' Fy alone does not identify one grade: Fu = 65 (the default) was used for the rupture line. Type Fu.');
    }
    var ag = ld.Pu / (0.9 * Fy), ae = ld.Pu / (0.75 * Fu);
    res.step('Yielding: Ag >= Pu / (0.90 Fy) = ' + n(ld.Pu, 3) + ' / (0.90 x ' + n(Fy, 3) + ') = ' + n(ag, 3) + ' in^2.', SRC.d2a);
    res.step('Rupture: Ae >= Pu / (0.75 Fu) = ' + n(ld.Pu, 3) + ' / (0.75 x ' + n(Fu, 3) + ') = ' + n(ae, 3) + ' in^2 (only if there are bolt holes).', SRC.d2b);
    res.val('Pu', ld.Pu, 'kips', SRC.lrfd).val('Ag_required', ag, 'in^2', SRC.d2a).val('Ae_required', ae, 'in^2', SRC.d2b);
    res.answer('Required gross area', ag, 'in^2', 'Ag >= ' + n(ag, 3) + ' in^2  (Pu = ' + n(ld.Pu, 2) + ' kips)');
    res.alt('required effective net area (rupture)', ae, 'in^2', 'Ae >= ' + n(ae, 3) + ' in^2');
    res.flag('NOTE: this is only the first guess; with holes you must check rupture with the real Ae of the trial shape.');
    return res;
  });

  def('tension_select', 'Tension', 'Select the lightest tension member', 'Lightest shape in a family (W8, C10, WT6, L4 ...) that passes yielding, rupture (with its own net area and U) and L/r <= 300, by trial from the lightest up. Loads are SERVICE loads unless the box says factored.', [
    F('family', 'text', 'Family to choose from (W8, C10, WT6, L4, HSS6X6 ...)', '', { required: true }),
    F('welded', 'boolean', 'Welded / no bolt holes: yielding only', '', { default: false }),
    F('angles', 'integer', 'Angles: number of angles (1 or 2)', '', { default: 1, min: 1, max: 2 }),
    F('bolt_dia_in', 'dimension', 'Bolt diameter (hole = bolt + 1/8)', 'in', { min: 0, minExclusive: true, plausible: 'bolt' }),
    F('holes_per_flange', 'integer', 'Holes across each flange (rolled shapes; one flange for a tee)', '', { default: 0, min: 0 }),
    F('web_holes', 'integer', 'Holes in the web / stem', '', { default: 0, min: 0 }),
    F('holes_across', 'integer', 'Angles / other: holes in the critical section', '', { default: 0, min: 0 }),
    F('connection', 'select', 'Where is the member connected? (for U)', '', { values: CONNECTION_VALUES }),
    F('fasteners_per_line', 'integer', 'Fasteners per line in the direction of the load', '', { min: 1 }),
    F('fastener_lines', 'integer', 'Angles: number of lines of fasteners (she counts ALL the fasteners; AISC counts per line)', '', { default: 1, min: 1 }),
    F('tee_rule', 'select', 'Tees: depth for the 2/3 d test', '', { values: TEE_RULE_VALUES }),
    F('length_ft', 'number', 'Member length (L/r <= 300 check)', 'ft', { min: 0 }),
    F('Fy', 'number', 'Fy (blank = from the shape family)', 'ksi', { min: 1, minExclusive: true }),
    F('Fu', 'number', 'Fu (blank = from the shape family)', 'ksi', { min: 1, minExclusive: true })
  ].concat(LOAD_FIELDS('kips')), function (a, res) {
    var ld = loadFromArgs(a, res);
    if (!ld) fail('MISSING', 'Enter D and L (service), or tick "already factored" and enter Pu.');
    var list = sortByWeight(shapesInFamily(a.family, res)), welded = !!a.welded || a.connection === 'welded', nAng = a.angles || 1, i;
    var first = list[0];
    var isAngleFam = first.type === 'L' || first.type === '2L';
    checkTensionInputs(a, res, isAngleFam ? 'angle' : 'shape', first, welded, true);
    if (welded && ((a.holes_per_flange || 0) > 0 || (a.web_holes || 0) > 0 || (a.holes_across || 0) > 0)) res.flag('WARNING: the member is welded (' + (a.welded ? '"welded" is ticked' : 'connection = welded') + '), but holes were also entered; the holes were ignored and only yielding is checked. If the member is bolted, untick "welded" / change the connection.');
    if (welded) {
      var weldUnusedS = ['bolt_dia_in', 'fasteners_per_line', 'tee_rule'];
      if (a.connection && a.connection !== 'welded') weldUnusedS.push('connection');
      if (a.fastener_lines > 1) weldUnusedS.push('fastener_lines');
      noteUnused(res, a, weldUnusedS, 'the member is welded (only yielding is checked)');
    } else {
      if (a.connection === 'all') noteUnused(res, a, ['fasteners_per_line'], 'every part of the section is connected (Case 1, U = 1.0)');
      if (a.connection !== 'angle' && !isAngleFam && a.fastener_lines > 1) noteUnused(res, a, ['fastener_lines'], 'the member is not an angle');
      if (!(a.connection === 'flanges' && /^(WT|MT|ST)$/.test(first.type))) noteUnused(res, a, ['tee_rule'], 'the tee depth rule only applies to a tee connected through its flange');
    }
    var matBase = materialFor(first.type) || { Fy: 50, Fu: 65, spec: 'default' };
    var anyHoles = !welded && ((a.holes_per_flange || 0) > 0 || (a.web_holes || 0) > 0 || (a.holes_across || 0) > 0);
    var steel = tensionSteel(res, a, first.type, anyHoles, matBase), fy = steel.Fy, fu = steel.Fu;
    if (steel.special) res.step(steel.special, SRC.mat);
    else res.step('Steel: ' + matBase.spec + ' -> Fy = ' + n(fy, 3) + ' ksi, Fu = ' + n(fu, 3) + ' ksi' + (isNum(a.Fy) ? ' (Fy given)' : '') + '.', SRC.mat);
    var agReq = ld.Pu / (0.9 * fy);
    res.step('First guess from yielding: Ag >= Pu / (0.90 Fy) = ' + n(ld.Pu, 3) + ' / (0.90 x ' + n(fy, 3) + ') = ' + n(agReq, 3) + ' in^2' + (nAng > 1 ? ' (= ' + n(agReq / nAng, 3) + ' in^2 per angle).' : '.'), SRC.d2a);
    var hole = isNum(a.bolt_dia_in) ? a.bolt_dia_in + 0.125 : null;
    if (!anyHoles) noteUnused(res, a, ['Fu'], 'there are no bolt holes, so only yielding (Fy) is checked');
    if (!welded && !anyHoles) res.flag('NOTE: no holes were entered and "welded" is not ticked; treating the member as having no holes (yielding only).');
    if (anyHoles && hole === null) fail('MISSING', 'Missing: bolt diameter.');
    if (hole !== null && anyHoles) res.step('Hole = bolt + 1/8 = ' + n(a.bolt_dia_in, 4) + ' + 0.125 = ' + n(hole, 4) + ' in.', 'Her rule; ' + SRC.b43);
    var trials = [], winner = null, skipped = 0, rows = [], voidCount = 0;
    // the area the holes take out of ONE trial shape (h = the hole): the same arithmetic for her hole and for the AISC hole of P7-R3
    function lossAt(sh, sAngN, h) {
      if (isAngleFam) return sAngN * (a.holes_across || 0) * h * sh.t;
      if ((a.holes_per_flange || 0) > 0 || (a.web_holes || 0) > 0) return h * ((a.holes_per_flange || 0) * nFlangesOf(sh) * (isNum(sh.tf) ? sh.tf : 0) + (a.web_holes || 0) * (isNum(sh.tw) ? sh.tw : 0));
      return (a.holes_across || 0) * h * (isNum(sh.tdes) ? sh.tdes : (isNum(sh.tw) ? sh.tw : 0));
    }
    for (i = 0; i < list.length; i++) {
      var s = list[i];
      var sAng = s.type === '2L' ? 2 : nAng, agOne = s.type === '2L' ? s.A / 2 : s.A, Ag = agOne * sAng;
      if (Ag + 1e-9 < agReq) { skipped++; continue; }
      var An = Ag, uStr = '-', U = null, uText = '', loss = 0, ufl = null;
      if (anyHoles) {
        loss = lossAt(s, sAng, hole);
        An = Ag - loss;
        var conn = a.connection || (isAngleFam ? 'angle' : null);
        if (!conn) fail('MISSING', 'Where is the member connected? Choose the connection so U can be found.');
        var perLine = isNum(a.fasteners_per_line) ? a.fasteners_per_line : (conn === 'all' || conn === 'case2' ? 0 : null);
        if (perLine === null) fail('MISSING', 'Missing: fasteners per line (needed for U).');
        var dummy = new Res('tmp'), uf;
        try { uf = uFactor(conn, perLine, s, a.tee_rule, null, null, dummy, a.fastener_lines); }
        catch (eU) {
          // Case 2 needs x-bar and l, which depend on the trial shape: this form has no boxes for them, the Capacity form has
          if (eU instanceof EngineError && eU.code === 'MISSING' && /Case 2/.test(eU.message)) fail('MISSING', eU.message + ' (' + s.label + ' was the trial. Tension > Select cannot do Case 2: x-bar depends on each trial shape. Pick a shape and use Tension > Capacity, which has the x-bar, l and U boxes.)', eU.suggestions);
          throw eU;
        }
        U = uf.U; uStr = fixed(U, 2); uText = uf.text; ufl = uf;
      }
      var mat = { Fy: fy, Fu: fu };
      var st = tensionStrengths({ Ag: Ag, An: An }, mat, U, welded || !anyHoles);
      var lr = null, lrOk = true;
      if (isNum(a.length_ft)) { lr = 12 * a.length_ft / rMinOf(s, sAng); lrOk = lr <= 300; }
      var voidSec = anyHoles && !(An > 1e-9);   // the holes take the whole section: nothing is left to carry the load
      if (voidSec) voidCount++;
      var pass = !voidSec && st.cap + 1e-9 >= ld.Pu && lrOk;
      trials.push({ s: s, Ag: Ag, An: An, U: U, st: st, lr: lr, pass: pass, loss: loss, uText: uText, uf: ufl, sAng: sAng, voidSec: voidSec });
      rows.push([s.label, s.W * sAng, Math.round(Ag * 1000) / 1000, Math.round(An * 1000) / 1000, uStr, Math.round(st.yield * 10) / 10, st.rupture === null || voidSec ? '-' : Math.round(st.rupture * 10) / 10, voidSec ? '-' : Math.round(st.cap * 10) / 10, lr === null ? '-' : Math.round(lr * 10) / 10, pass ? 'YES' : (voidSec ? 'no -- the holes remove the whole section' : (st.cap + 1e-9 < ld.Pu ? 'no -- ' + st.governs + ' ' + n(st.cap, 1) + ' < ' + n(ld.Pu, 1) : 'no -- L/r > 300'))]);
      if (pass) { winner = trials[trials.length - 1]; break; }
    }
    if (skipped) res.step(skipped + ' lighter shape' + (skipped > 1 ? 's' : '') + ' in ' + a.family + (skipped > 1 ? ' have' : ' has') + ' Ag below ' + n(agReq, 3) + ' in^2 and ' + (skipped > 1 ? 'are' : 'is') + ' skipped (yielding fails).', SRC.d2a);
    if (!winner && trials.length && voidCount === trials.length) fail('OUT_OF_RANGE', 'In every ' + a.family + ' shape that was tried the holes remove the WHOLE section (An <= 0): ' + trials.length + ' shape' + (trials.length > 1 ? 's' : '') + ', the heaviest ' + trials[trials.length - 1].s.label + ' with Ag = ' + n(trials[trials.length - 1].Ag, 3) + ' in^2 and ' + n(trials[trials.length - 1].loss, 3) + ' in^2 of holes. Check the number of holes and the bolt diameter.', []);
    if (!winner) fail('OUT_OF_RANGE', 'No ' + a.family + ' shape carries Pu = ' + n(ld.Pu, 2) + ' kips with this connection' + (isNum(a.length_ft) ? ' and L/r <= 300' : '') + (voidCount ? ' (' + voidCount + ' shape' + (voidCount > 1 ? 's lose' : ' loses') + ' the whole section to the holes)' : '') + '. Try a bigger family.', []);
    res.table('Trials, lightest first', ['Shape', 'Weight lb/ft', 'Ag in^2', 'An in^2', 'U', 'yield kips', 'rupture kips', 'phi Pn kips', 'L/r', 'Works?'], rows);
    trials.forEach(function (t, k) {
      var line = 'Try ' + t.s.label + ' (' + n(t.s.W * (t.s.type === 'L' ? t.sAng : 1), 4) + ' lb/ft):  Ag = ' + n(t.Ag, 3) + ' in^2';
      if (anyHoles) {
        line += (isNum(t.s.tf) ? ', tf = ' + n(t.s.tf, 3) : '') + (isNum(t.s.bf) ? ', bf = ' + n(t.s.bf, 3) : '') + (isNum(t.s.d) ? ', d = ' + n(t.s.d, 3) : '') + '.  ' + t.uText + '.  An = ' + n(t.Ag, 3) + ' - ' + n(t.loss, 3) + ' = ' + n(t.An, 3) + ' in^2;  Ae = U An = ' + fixed(t.U, 2) + ' (' + n(t.An, 3) + ') = ' + n(t.st.ae, 3) + ' in^2;  phi Pn = 0.75 Fu Ae = 0.75 (' + n(fu, 3) + ') (' + n(t.st.ae, 3) + ') = ' + n(t.st.rupture, 1) + ' kips';
        if (t.st.rupture > t.st.yield) line += ' (yielding 0.9 Fy Ag = ' + n(t.st.yield, 1) + ' governs)';
      } else line += ';  phi Pn = 0.90 Fy Ag = 0.90 (' + n(fy, 3) + ') (' + n(t.Ag, 3) + ') = ' + n(t.st.yield, 1) + ' kips';
      line += t.pass ? ' > Pu = ' + n(ld.Pu, 1) + ' ok.' : (t.voidSec ? '  The holes take the WHOLE section (An <= 0) NG: go up a size.' : (t.st.cap + 1e-9 < ld.Pu ? ' < Pu = ' + n(ld.Pu, 1) + ' NG: go up a size.' : '.  L/r = ' + n(t.lr, 1) + ' > 300 NG.'));
      res.step(line, SRC.d2b);
    });
    var w = winner;
    res.val('selected_shape', w.s.label, '', SRC.shapes).val('Ag_required', agReq, 'in^2', SRC.d2a).val('Ag', w.Ag, 'in^2', SRC.shapes).val('An', w.An, 'in^2', SRC.b43);
    if (w.U !== null) res.val('U', w.U, '', SRC.d31).val('Ae', w.st.ae, 'in^2', SRC.d3).val('rupture', w.st.rupture, 'kips', SRC.d2b);
    res.val('yielding', w.st.yield, 'kips', SRC.d2a).val('capacity', w.st.cap, 'kips').val('Pu', ld.Pu, 'kips', SRC.lrfd).val('weight', w.s.W * (w.s.type === 'L' ? nAng : 1), 'lb/ft', SRC.shapes);
    if (w.lr !== null) res.val('L_over_r', w.lr, '', SRC.d1);
    if (!isNum(a.length_ft)) res.flag('NOTE: no member length was given, so L/r <= 300 was NOT checked (r >= L/300 needed).');
    else if (w.s.type === 'L' && nAng === 2) res.flag(doubleAngleNote(w.lr, rMinOf(w.s, 2)));
    if (anyHoles && boltOverOne(a.bolt_dia_in) && w.U !== null) {
      var holeA = a.bolt_dia_in + 0.1875, anA = w.Ag - lossAt(w.s, w.sAng, holeA), aeA = w.U * anA, rupA = 0.75 * fu * aeA, capA = Math.min(w.st.yield, rupA);
      res.flag(boltOverOneNote(a.bolt_dia_in, hole) + ' With the AISC hole ' + w.s.label + ' has An = ' + n(anA, 4) + ' in^2, Ae = ' + n(aeA, 4) + ' in^2 and phi Pn = ' + n(capA, 2) + ' kips, ' + (capA + 1e-9 >= ld.Pu ? 'still >= Pu = ' + n(ld.Pu, 2) + ' kips.' : 'LESS than Pu = ' + n(ld.Pu, 2) + ' kips: by AISC this shape would NOT work.'));
      res.alt('AISC net area An of ' + w.s.label + ' (hole = bolt + 3/16 = ' + n(holeA, 4) + ' in)', anA, 'in^2', 'An = ' + n(anA, 4) + ' in^2, Ae = ' + n(aeA, 4) + ' in^2, rupture phi Pn = ' + n(rupA, 2) + ' kips, phi Pn = ' + n(capA, 2) + ' kips (her An = ' + n(w.An, 4) + ' in^2 stays the answer)');
    }
    roundHssNote(res, w.s, fy);
    if (anyHoles && w.loss > 0.5 * w.Ag + 1e-9) res.flag('CHECK: in ' + w.s.label + ' the holes remove ' + n(100 * w.loss / w.Ag, 1) + '% of the gross area (An = ' + n(w.An, 3) + ' of Ag = ' + n(w.Ag, 3) + ' in^2) -- more than half. Check the number of holes and the bolt diameter.');
    res.answer('Lightest tension member', w.st.cap, 'kips', w.s.label + (nAng === 2 && w.s.type === 'L' ? ' (two angles)' : '') + '  (' + n(w.s.W * (w.s.type === 'L' ? nAng : 1), 4) + ' lb/ft)  phi Pn = ' + n(w.st.cap, 1) + ' kips (' + w.st.governs + ') >= Pu = ' + n(ld.Pu, 2) + ' kips');
    if (w.uf && w.uf.flag) res.flag(w.uf.flag.replace(/^(WARNING|NOTE): /, '$1: ' + w.s.label + ': '));
    if (first.type === 'WT' || first.type === 'MT' || first.type === 'ST') {
      if (anyHoles && a.connection === 'flanges') {
        var otherRule = (a.tee_rule || settings().tee_rule) === 'spec' ? 'class' : 'spec';
        var uo = uFactor('flanges', a.fasteners_per_line, w.s, otherRule, null, null, new Res('tmp2'));
        var okOther = tensionStrengths({ Ag: w.Ag, An: w.An }, { Fy: fy, Fu: fu }, uo.U, false).cap + 1e-9 >= ld.Pu;
        res.alt('the same shape with the ' + (otherRule === 'spec' ? 'Specification' : 'her') + ' tee-depth rule: U = ' + fixed(uo.U, 2), uo.U, '', okOther ? w.s.label + ' still works' : w.s.label + ' would NOT work (rupture ' + n(tensionStrengths({ Ag: w.Ag, An: w.An }, { Fy: fy, Fu: fu }, uo.U, false).rupture, 1) + ' kips)');
      }
    }
    res.flag('NOTE: block shear is not checked (every homework says to neglect it).');
    return res;
  });

  // =====================================================================================================
  // 11. SELF-TEST HELPERS (used by tests/run.js and by the banner of the page)
  // =====================================================================================================

  // value at a path such as "answer.value", "steps[0].text", "alternatives[label~=exact].value"
  // every number a result reports: the headline, every numeric value, every numeric alternative.  The authority suite uses it ("reported") to say
  // that a PUBLISHED number may be matched by any reported value, whichever of them is the headline today.
  function reportedNumbers(obj) {
    var out = [], k, i;
    if (obj && obj.answer && typeof obj.answer.value === 'number') out.push(obj.answer.value);
    if (obj && obj.values) { for (k in obj.values) { if (has(obj.values, k) && obj.values[k] && typeof obj.values[k].value === 'number') out.push(obj.values[k].value); } }
    if (obj && obj.alternatives) { for (i = 0; i < obj.alternatives.length; i++) { if (typeof obj.alternatives[i].value === 'number') out.push(obj.alternatives[i].value); } }
    return out;
  }

  function getPath(obj, path) {
    if (path === 'reported') return reportedNumbers(obj);
    var re = /([^.\[\]]+)|\[([^\]]+)\]/g, m, cur = obj;
    while ((m = re.exec(path))) {
      if (cur === undefined || cur === null) return undefined;
      if (m[1] !== undefined) cur = cur[m[1]];
      else {
        var sel = m[2];
        if (/^\d+$/.test(sel)) cur = cur[Number(sel)];
        else {
          var mm = /^([^=~]+)(~?=)(.*)$/.exec(sel);
          if (!mm || !Array.isArray(cur)) return undefined;
          var found;
          for (var i = 0; i < cur.length; i++) {
            var v = cur[i] ? cur[i][mm[1]] : undefined;
            if (mm[2] === '=' ? String(v) === mm[3] : String(v).toLowerCase().indexOf(mm[3].toLowerCase()) >= 0) { found = cur[i]; break; }
          }
          cur = found;
        }
      }
    }
    return cur;
  }

  function js(v) { return v === undefined ? 'undefined' : JSON.stringify(v); }

  // returns null when the expectation holds, otherwise a message
  function checkExpect(actual, exp) {
    var tol = exp.tol !== undefined ? exp.tol : 1e-9, i;
    if (has(exp, 'equals')) return JSON.stringify(actual) === JSON.stringify(exp.equals) ? null : 'expected ' + js(exp.equals) + ' got ' + js(actual);
    if (has(exp, 'approx')) {
      if (typeof actual !== 'number') return 'expected about ' + exp.approx + ' got ' + js(actual);
      var lim = exp.rel !== undefined ? exp.rel * Math.abs(exp.approx) : tol;
      return Math.abs(actual - exp.approx) <= lim ? null : 'expected ' + exp.approx + ' +/- ' + lim + ' got ' + actual;
    }
    if (has(exp, 'anyApprox')) {
      if (!Array.isArray(actual)) return 'expected a list of numbers, got ' + js(actual);
      var lim2 = exp.rel !== undefined ? exp.rel * Math.abs(exp.anyApprox) : tol;
      for (i = 0; i < actual.length; i++) { if (typeof actual[i] === 'number' && Math.abs(actual[i] - exp.anyApprox) <= lim2) return null; }
      return 'no reported value is within ' + lim2 + ' of ' + exp.anyApprox + ' (reported: ' + js(actual.slice(0, 14)) + ')';
    }
    if (has(exp, 'approxList')) {
      if (!Array.isArray(actual) || actual.length !== exp.approxList.length) return 'expected list ' + js(exp.approxList) + ' got ' + js(actual);
      for (i = 0; i < actual.length; i++) { if (Math.abs(actual[i] - exp.approxList[i]) > tol) return 'expected list ' + js(exp.approxList) + ' +/- ' + tol + ' got ' + js(actual); }
      return null;
    }
    if (has(exp, 'contains')) {
      if (typeof actual === 'string') return actual.indexOf(exp.contains) >= 0 ? null : 'expected text containing ' + js(exp.contains) + ' got ' + js(actual);
      if (Array.isArray(actual)) return actual.indexOf(exp.contains) >= 0 ? null : 'expected list containing ' + js(exp.contains) + ' got ' + js(actual);
      return 'cannot search ' + js(actual);
    }
    if (has(exp, 'anyContains')) {
      if (!Array.isArray(actual)) return 'expected a list of texts, got ' + js(actual);
      for (i = 0; i < actual.length; i++) { if (String(actual[i]).toLowerCase().indexOf(String(exp.anyContains).toLowerCase()) >= 0) return null; }
      return 'no entry contains ' + js(exp.anyContains) + ' in ' + js(actual);
    }
    if (has(exp, 'noneContains')) {
      if (!Array.isArray(actual)) return 'expected a list of texts, got ' + js(actual);
      for (i = 0; i < actual.length; i++) { if (String(actual[i]).toLowerCase().indexOf(String(exp.noneContains).toLowerCase()) >= 0) return 'an entry contains ' + js(exp.noneContains) + ': ' + js(actual[i]); }
      return null;
    }
    if (has(exp, 'containsText')) return (typeof actual === 'string' && actual.toLowerCase().indexOf(String(exp.containsText).toLowerCase()) >= 0) ? null : 'expected text containing ' + js(exp.containsText) + ' got ' + js(actual);
    if (has(exp, 'oneOf')) return exp.oneOf.indexOf(actual) >= 0 ? null : 'expected one of ' + js(exp.oneOf) + ' got ' + js(actual);
    if (has(exp, 'exists')) return ((actual !== undefined && actual !== null) === exp.exists) ? null : 'expected exists=' + exp.exists + ' got ' + js(actual);
    if (has(exp, 'gte')) return (typeof actual === 'number' && actual >= exp.gte) ? null : 'expected >= ' + exp.gte + ' got ' + js(actual);
    if (has(exp, 'lte')) return (typeof actual === 'number' && actual <= exp.lte) ? null : 'expected <= ' + exp.lte + ' got ' + js(actual);
    if (has(exp, 'matches')) return (typeof actual === 'string' && new RegExp(exp.matches).test(actual)) ? null : 'expected text matching ' + exp.matches + ' got ' + js(actual);
    if (has(exp, 'length')) return (actual && actual.length === exp.length) ? null : 'expected length ' + exp.length + ' got ' + (actual ? actual.length : js(actual));
    return 'unknown check: ' + js(exp);
  }

  // cases = [{ id, group, source, fn, args, expect:[{ path, equals|approx|... }] }]
  function runCases(cases) {
    var failed = [], i, j, total = 0;
    for (i = 0; i < cases.length; i++) {
      var c = cases[i], res = run(c.fn, c.args), msgs = [];
      total++;
      for (j = 0; j < (c.expect || []).length; j++) {
        var e = c.expect[j], got = getPath(res, e.path), m = checkExpect(got, e);
        if (m) msgs.push(e.path + ': ' + m);
      }
      if (!(c.expect && c.expect.length)) msgs.push('case has no expectations');
      if (msgs.length) failed.push({ id: c.id, group: c.group, source: c.source, messages: msgs, result: res });
    }
    return { total: total, passed: total - failed.length, failed: failed };
  }

  // deterministic sample of the generated tables recomputed with the formulas (the page runs it with the embedded tables;
  // tests/run.js runs the full comparison against the original CSV files)
  function crossCheck(count, seed) {
    var T = DATA().tables || {}, I = idx(), fails = [], checked = 0, i;
    var s = (seed || 12345) >>> 0;
    function rnd() { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = imul(t ^ (t >>> 15), t | 1); t ^= t + imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    function pick(n2) { return Math.floor(rnd() * n2); }
    var per = Math.max(1, Math.floor(count / 3)), perLast = Math.max(1, count - 2 * per);
    if (T.calc_4_14) {
      var fys = T.calc_4_14.fys;
      for (i = 0; i < per; i++) {
        var k = 1 + pick(200), f = pick(fys.length), want = T.calc_4_14.rows[k - 1][f + 1], got = sig3(0.9 * fcrE3(k, fys[f]));
        checked++; if (got !== want) fails.push('Table 4-14 KL/r ' + k + ' Fy ' + fys[f] + ': table ' + want + ' formula ' + got);
      }
    }
    if (T.calc_4_1a) {
      var names = Object.keys(T.calc_4_1a);
      for (i = 0; i < per; i++) {
        var nm = names[pick(names.length)], rec = T.calc_4_1a[nm], kl = pick(rec.p.length), sh = I.byLabel[normName(nm)];
        if (!sh) { fails.push('Table 4-1a shape ' + nm + ' not in the shapes data'); continue; }
        var cs = columnStrength(sh, 12.0 * kl / sh.ry, 50);
        checked++;
        if (sig3(cs.phiPn) !== rec.p3[kl] || Math.abs(cs.phiPn - rec.p[kl]) > 0.0500001) fails.push('Table 4-1a ' + nm + ' KL ' + kl + ': table ' + rec.p[kl] + '/' + rec.p3[kl] + ' formula ' + cs.phiPn);
      }
    }
    if (T.calc_3_2) {
      for (i = 0; i < perLast; i++) {
        var row = T.calc_3_2.rows[pick(T.calc_3_2.rows.length)], sh2 = I.byLabel[normName(row[0])];
        if (!sh2) { fails.push('Table 3-2 shape ' + row[0] + ' not in the shapes data'); continue; }
        var b = beamStrength(sh2, 50);
        checked++;
        if (sig3(b.phiMn) !== row[4] || Math.abs(b.phiMn - row[3]) > 0.0500001 || Math.abs(b.phiVn - row[6]) > 0.0500001) fails.push('Table 3-2 ' + row[0] + ': table ' + row[3] + '/' + row[4] + '/' + row[6] + ' formula ' + b.phiMn + '/' + b.phiVn);
      }
    }
    return { checked: checked, failures: fails };
  }

  function info() {
    var M = DATA().meta || {}, S = DATA().shapes || {};
    return {
      shapes: S.count || 0, database: S.database || M.shapes_database || '', specification: M.specification || '', manual: M.manual || '',
      generated: M.generated || '', build: root.STEEL_BUILD || null, cases: (DATA().selftest || []).length,
      overrides: (DATA().overrides || []).length
    };
  }

  function shapeLabels() { return idx().all.map(function (s) { return s.label; }); }

  /* @@APPEND-HERE@@ */

  // =====================================================================================================
  // PUBLIC OBJECT
  // =====================================================================================================
  var STEEL = {
    run: run,
    list: list,
    parseNum: parseNum,
    fmt: n,
    sig3: sig3,
    calc: {   // the raw formulas, exposed for the cross-checks in tests/run.js and the page self-test
      fcrE3: fcrE3, table414: table414, columnStrength: columnStrength, beamStrength: beamStrength, sig3: sig3,
      findShape: findShape, ceilTol: ceilTol, normName: normName, shapeKey: shapeKey, analyzeSimple: analyzeSimple
    },
    runCases: runCases,
    crossCheck: crossCheck,
    info: info,
    shapeLabels: shapeLabels,
    presetPositions: presetPositions,
    presets: PRESETS,
    endConditions: END_CONDITIONS,
    reload: function () { IDX = null; GIDX = null; }
  };
  root.STEEL = STEEL;
  if (typeof module !== 'undefined' && module.exports) module.exports = STEEL;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));

