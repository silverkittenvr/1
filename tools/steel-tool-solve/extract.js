// extract.js -- split the delivered single-file page back into its source files (the cloud session had only the built page).
// node extract.js steel-solve-16cede60.html  -> ext/<name> for every "/* ==== name ==== */" script block, plus ext/_head.js, ext/template.html
var fs = require('fs'), path = require('path');
var html = fs.readFileSync(process.argv[2], 'utf8');
var out = path.join(__dirname, 'ext'); if (!fs.existsSync(out)) fs.mkdirSync(out);
var re = /<script>\n([\s\S]*?)<\/script>/g, m, n = 0, order = [];
while ((m = re.exec(html))) {
  var body = m[1], h = /^\/\* ==== ([A-Za-z0-9_.-]+) ==== \*\//.exec(body);
  var name = h ? h[1] : ('_block' + n + '.js');
  fs.writeFileSync(path.join(out, name), body); order.push(name); n++;
}
fs.writeFileSync(path.join(out, '_order.json'), JSON.stringify(order, null, 1));
fs.writeFileSync(path.join(out, 'page-without-scripts.html'), html.replace(/<script>\n[\s\S]*?<\/script>/g, '<!--script-->'));
console.log(order.join('\n'));
