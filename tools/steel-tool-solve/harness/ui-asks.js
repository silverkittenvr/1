// node harness/ui-asks.js "<question>" "<answer>" ["<answer>" ...] [--tick-first]
// Unit E: the PAGE itself (ui.js, with a small fake DOM: no browser here) driven like him: types the question, presses Solve, then answers the
// asks one at a time -- a choice by the text of its button (a part of it is enough), a number by typing it and pressing "Use this number" -- and
// ticks the figure box.  Prints every ask block it saw and the WRITE THIS text at the end.  No network: fetch is refused (the AI helper is absent).
var fs = require('fs'), path = require('path'), vm = require('vm');
var args = process.argv.slice(2), text = args[0], tickFirst = args.indexOf('--tick-first') >= 0, answers = args.slice(1).filter(function (x) { return x !== '--tick-first'; });
var dir = process.env.STEEL_SRC || path.join(__dirname, '..', 'ext');

/* ---------------------------------------------------------------- a fake DOM: just what ui.js uses */
function El(tag, doc) { this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.style = {}; this.className = ''; this.listeners = {}; this.value = ''; this.checked = false; this.open = false; this.disabled = false; this.nodeType = 1; }
function Txt(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; this.childNodes = []; }
Object.defineProperty(Txt.prototype, 'textContent', { get: function () { return this.data; }, set: function (v) { this.data = String(v); } });
Object.defineProperty(El.prototype, 'firstChild', { get: function () { return this.childNodes[0] || null; } });
Object.defineProperty(El.prototype, 'lastChild', { get: function () { return this.childNodes[this.childNodes.length - 1] || null; } });
Object.defineProperty(El.prototype, 'children', { get: function () { return this.childNodes.filter(function (c) { return c.nodeType === 1; }); } });
Object.defineProperty(El.prototype, 'nextSibling', { get: function () { var p = this.parentNode; if (!p) return null; var i = p.childNodes.indexOf(this); return p.childNodes[i + 1] || null; } });
Object.defineProperty(El.prototype, 'textContent', {
  get: function () { return this.childNodes.map(function (c) { return c.textContent; }).join(''); },
  set: function (v) { this.childNodes.forEach(function (c) { c.parentNode = null; }); this.childNodes = []; if (String(v) !== '') this.appendChild(new Txt(v)); }
});
El.prototype.appendChild = function (c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; };
El.prototype.removeChild = function (c) { var i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; };
El.prototype.insertBefore = function (c, ref) { if (!ref) return this.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); var i = this.childNodes.indexOf(ref); c.parentNode = this; this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c); return c; };
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'type') this.type = String(v); };
El.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; };
El.prototype.removeAttribute = function (k) { delete this.attrs[k]; };
El.prototype.addEventListener = function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); };
El.prototype.removeEventListener = function () {};
El.prototype.fire = function (ev, extra) { var e = { type: ev, target: this, preventDefault: function () {}, stopPropagation: function () {} }, k; for (k in extra || {}) e[k] = extra[k]; (this.listeners[ev] || []).slice().forEach(function (fn) { fn(e); }); };
El.prototype.click = function () { this.fire('click'); };
El.prototype.scrollIntoView = function () {}; El.prototype.focus = function () {}; El.prototype.select = function () {}; El.prototype.blur = function () {};
El.prototype.all = function (out) { out = out || []; this.childNodes.forEach(function (c) { if (c.nodeType === 1) { out.push(c); c.all(out); } }); return out; };
El.prototype.querySelectorAll = function (sel) {
  var alts = sel.split(',').map(function (s) { return s.trim().split(/\s+/).pop(); });
  return this.all().filter(function (e) { return alts.some(function (a) { return a.charAt(0) === '.' ? (' ' + e.className + ' ').indexOf(' ' + a.slice(1) + ' ') >= 0 : e.tagName === a.toUpperCase(); }); });
};
El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
El.prototype.getBoundingClientRect = function () { return { top: 0, left: 0, width: 0, height: 0 }; };
function makeDoc() {
  var doc = { readyState: 'complete', listeners: {}, nodeType: 9 };
  doc.createElement = function (t) { return new El(t, doc); };
  doc.createTextNode = function (t) { return new Txt(t); };
  doc.body = new El('body', doc); doc.documentElement = doc.body;
  doc.getElementById = function (id) { return doc.body.all().filter(function (e) { return e.id === id; })[0] || null; };
  doc.querySelectorAll = function (s) { return doc.body.querySelectorAll(s); };
  doc.querySelector = function (s) { return doc.body.querySelector(s); };
  doc.addEventListener = function () {}; doc.execCommand = function () { return false; };
  ['app', 'kitnav', 'modelbar', 'selftest', 'fatal', 'status', 'examples', 'out', 'hist', 'histlist', 'foot', 'aifacts', 'aisum', 'defsnote', 'defssum', 'clear', 'solve', 'defsbox'].forEach(function (id) {
    var e = doc.createElement(id === 'solve' || id === 'clear' ? 'button' : (id === 'defsbox' ? 'details' : 'div')); e.setAttribute('id', id); doc.body.appendChild(e);
  });
  var q = doc.createElement('textarea'); q.setAttribute('id', 'q'); doc.body.appendChild(q);
  var d = doc.createElement('input'); d.setAttribute('id', 'defaults'); doc.body.appendChild(d);
  return doc;
}

var doc = makeDoc(), store = {};
var sb = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {}, document: doc,
  localStorage: { getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } },
  navigator: {}, isSecureContext: false, location: { href: 'file:///page.html', protocol: 'file:' },
  fetch: function () { return { then: function (ok, bad) { if (bad) bad(new Error('no network in the test')); return this; } }; },
  addEventListener: function () {}, removeEventListener: function () {}, alert: function () {}, confirm: function () { return true; } };
sb.window = sb; sb.self = sb; sb.globalThis = sb;
vm.createContext(sb);
var ownOrder = path.join(dir, '_order.json'), order = JSON.parse(fs.readFileSync(fs.existsSync(ownOrder) ? ownOrder : path.join(__dirname, '..', 'ext', '_order.json'), 'utf8'));
order.forEach(function (n) { var f = path.join(dir, n); if (!fs.existsSync(f)) f = path.join(__dirname, '..', 'ext', n); vm.runInContext(fs.readFileSync(f, 'utf8'), sb, { filename: n }); });

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function txt(e) { return String(e.textContent).replace(/\s+/g, ' ').trim(); }
function askBlocks() { return doc.body.querySelectorAll('.wanted'); }
async function main() {
  var fatal = doc.getElementById('fatal');
  doc.getElementById('q').value = text;
  doc.getElementById('solve').click();
  await wait(500);
  if (tickFirst) tick();
  await wait(500);
  for (var step = 0; step < 12; step++) {
    var blocks = askBlocks();
    if (txt(fatal)) { console.log('FATAL: ' + txt(fatal)); break; }
    if (!blocks.length) break;
    var b = blocks[0];
    console.log('ASK BLOCK: ' + txt(b).slice(0, 260));
    if (blocks.length > 1) console.log('  (and ' + (blocks.length - 1) + ' more block(s) with class wanted)');
    var a = answers.shift();
    if (a === undefined) { console.log('  (no answer given: stop)'); break; }
    var btns = b.querySelectorAll('button'), inp = b.querySelector('input'), hit = null;
    if (inp && !btns.some(function (x) { return /^In |^Side|^Zig|^Fixed|^Pinned|^Free|^It cannot|^No:|^Yes|^On a|^Built|^Some/.test(txt(x)); })) {
      inp.value = a; btns.filter(function (x) { return /Use this number/.test(txt(x)); })[0].click();
      console.log('  typed ' + a);
    } else {
      hit = btns.filter(function (x) { return txt(x).toLowerCase().indexOf(a.toLowerCase()) >= 0; })[0];
      if (!hit) { console.log('  no button with "' + a + '": ' + btns.map(txt).join(' / ')); break; }
      hit.click(); console.log('  pressed "' + txt(hit) + '"');
    }
    await wait(500);
  }
  if (!tickFirst) { tick(); await wait(700); }
  var w = doc.body.querySelectorAll('.wtext');
  console.log(w.length ? 'WRITE THIS:\n' + w.map(function (e) { return e.textContent; }).join('\n---\n') : 'no WRITE THIS block. ' + doc.body.querySelectorAll('.errbox').map(txt).join(' || ').slice(0, 400));
  if (txt(fatal)) console.log('FATAL: ' + txt(fatal));
  process.exit(0);
}
function tick() {
  var cbs = doc.body.all().filter(function (e) { return e.tagName === 'INPUT' && e.type === 'checkbox' && /^fig-/.test(e.id || ''); });
  cbs.forEach(function (cb) { cb.checked = true; cb.fire('change'); });
  console.log('ticked ' + cbs.length + ' figure box(es)');
}
main().catch(function (e) { console.log('CRASH ' + (e && e.stack || e)); process.exit(1); });
