// Table and shape look-ups from the calculator's FROZEN DATA only (shapes.js, tables.js) -- for people writing answer keys by hand.
// It never runs the reader or the page.  What a person with the Manual open would read.
//   node harness/lookup.js W12x53            every property of a shape (Ag is "A")
//   node harness/lookup.js --t414 67 50      Table 4-14: phi Fcr at KL/r = 67 for Fy = 50
//   node harness/lookup.js --t41a W10x49 14  Table 4-1a: phi Pn at KL = 14 ft (as printed, 3 significant figures: p3)
//   node harness/lookup.js --t32 60          Table 3-2 rows with Zx >= 60, lightest first (W, Zx, phiMp)
//   node harness/lookup.js --j33             Table J3.3 hole sizes;   --d31  Table D3.1 rows
var g = require('./load')(), D = g.STEEL_DATA, T = D.tables, a = process.argv.slice(2);
function norm(s) { return String(s).toUpperCase().replace(/\s+/g, ''); }
if (a[0] === '--t414') { var r = T.calc_4_14, c = r.fys.indexOf(+a[2]), row = r.rows.filter(function (x) { return x[0] === +a[1]; })[0]; console.log('Table 4-14 KL/r=' + a[1] + ' Fy=' + a[2] + ': phi Fcr = ' + (row && c >= 0 ? row[c + 1] : '(none)') + ' ksi'); }
else if (a[0] === '--t41a') { var e = T.calc_4_1a[norm(a[1])]; if (!e) console.log('(not in Table 4-1a)'); else console.log('Table 4-1a ' + norm(a[1]) + ' KL=' + a[2] + ' ft: phi Pn = ' + e.p3[+a[2]] + ' kips (unrounded ' + e.p[+a[2]] + '), rx/ry = ' + e.rx_ry + (e.flag ? ' flag ' + e.flag : '')); }
else if (a[0] === '--t32') { var t = T.calc_3_2, z = +a[1]; t.rows.filter(function (x) { return x[2] >= z; }).sort(function (x, y) { return x[1] - y[1]; }).slice(0, 12).forEach(function (x) { console.log(x[0] + '  W=' + x[1] + '  Zx=' + x[2] + '  phiMp=' + x[4] + ' kip-ft' + (x[7] ? '  (bold)' : '')); }); }
else if (a[0] === '--j33') console.log(JSON.stringify(T.J3_3.rows, null, 1));
else if (a[0] === '--d31') console.log(JSON.stringify(T.D3_1.rows.map(function (x) { return { case: x.case_no, U: x.U_text, desc: x.description, el: x.element, geom: x.geometry, n: x.min_fasteners }; }), null, 1));
else {
  var want = norm(a[0]), types = D.shapes.types, k, i, found = 0;
  for (k in types) { var cols = types[k].columns, rows = types[k].rows; for (i = 0; i < rows.length; i++) if (norm(rows[i][1]) === want) { found = 1; var o = {}; cols.forEach(function (cn, j) { o[cn] = rows[i][j]; }); console.log(JSON.stringify(o)); } }
  if (!found) console.log('(shape not found: ' + a[0] + ')');
}
