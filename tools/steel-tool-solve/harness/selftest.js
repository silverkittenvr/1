// node harness/selftest.js -- the page's own calculator self-test (945 known-answer cases + table cross-check)
var g = require('./load')(), r = g.STEEL.runCases(g.STEEL_DATA.selftest || []), cc = g.STEEL.crossCheck(500, 20261007);
console.log('self-test ' + r.passed + '/' + r.total + ', table cells ' + cc.checked + ', table failures ' + cc.failures.length);
r.failed.forEach(function (f) { console.log('FAIL ' + f.id + ': ' + f.messages.join('; ')); });
process.exit(r.failed.length || cc.failures.length ? 1 : 0);
