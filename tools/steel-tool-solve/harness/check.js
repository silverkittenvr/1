// node harness/check.js [dir]  -- the browser limits of HANDOFF rule 4 on every page script: parses as ES5 (acorn ecmaVersion 5 also
// rejects arrow functions, let/const, template strings and regex lookbehind), ASCII only, and none of includes/startsWith/endsWith/Object.assign/innerHTML.
var fs = require('fs'), path = require('path'), acorn; try { acorn = require('acorn'); } catch (e) { acorn = require('/tmp/claude-0/-home-user-1/a6672620-4f5b-5cfe-8fc0-05cb48074075/scratchpad/npm/node_modules/acorn'); }
var dir = process.argv[2] || path.join(__dirname, '..', 'ext'), order = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ext', '_order.json'), 'utf8')), bad = 0;
order.forEach(function (n) {
  var f = path.join(dir, n); if (!fs.existsSync(f)) return;
  var s = fs.readFileSync(f, 'utf8'), m;
  try { acorn.parse(s, { ecmaVersion: 5, sourceType: 'script' }); } catch (e) { bad++; console.log(n + ': NOT ES5: ' + e.message); }
  if ((m = /[^\x00-\x7f]/.exec(s))) { bad++; console.log(n + ': NON-ASCII at ' + s.slice(0, m.index).split('\n').length); }
  if (/(?:<=|<!)/.test('') ) {}
  [/\.includes\(/, /\.startsWith\(/, /\.endsWith\(/, /Object\.assign/, /\.innerHTML/, /\(\?<[=!]/].forEach(function (re) {
    var lines = s.split('\n'), i; for (i = 0; i < lines.length; i++) if (re.test(lines[i]) && !/^\s*(\/\/|\/?\*)/.test(lines[i])) { bad++; console.log(n + ':' + (i + 1) + ': forbidden ' + re + ': ' + lines[i].trim().slice(0, 120)); }
  });
});
console.log(bad ? ('CHECK FAILED: ' + bad) : 'check: all page scripts ES5, ASCII, no forbidden calls');
process.exit(bad ? 1 : 0);
