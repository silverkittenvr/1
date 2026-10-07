// load.js -- loads the page's scripts (everything but ui.js) into a fresh vm context, in the page's own order, the way the page does.
// SRC defaults to ../ext (the files extracted from the delivered build); set STEEL_SRC=<dir> to load another tree.
var fs = require('fs'), path = require('path'), vm = require('vm');
function load(dir) {
  dir = dir || process.env.STEEL_SRC || path.join(__dirname, '..', 'ext');
  var order = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ext', '_order.json'), 'utf8'));
  var sb = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sb.window = sb; sb.self = sb;
  vm.createContext(sb);
  order.forEach(function (n) {
    if (n === 'ui.js') return;
    var f = path.join(dir, n); if (!fs.existsSync(f)) f = path.join(__dirname, '..', 'ext', n);
    vm.runInContext(fs.readFileSync(f, 'utf8'), sb, { filename: n });
  });
  return sb;
}
module.exports = load;
