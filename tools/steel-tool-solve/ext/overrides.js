/* ==== overrides.js ==== */
/* data/overrides.js -- EDITABLE. You may change anything in this file by hand; reload the page to see it.
   Seeded by make-data.js from: nothing (starts empty)
   make-data.js will NOT overwrite this file unless it is run with --seed-editable. ASCII only. */
(function (root) {
  root.STEEL_DATA = root.STEEL_DATA || {};
  // EMERGENCY CORRECTIONS. Every entry needs a source and a reason; the tool shows each one it uses as a flag in the answer.
  // Supported kinds (copy one, remove the leading // and fill it in):
  //   { kind: "shape",      shape: "W14X109", property: "A",  value: 32.1, source: "...", reason: "..." }
  //   { kind: "material",   family: "W",      Fy: 50, Fu: 65,            source: "...", reason: "..." }
  //   { kind: "table_4_14", klr: 47, fy: 50,  value: 38.3,                source: "...", reason: "..." }
  //   { kind: "table_4_1a", shape: "W14X109", kl: 24, value: 931,         source: "...", reason: "..." }
  //   { kind: "table_3_2",  shape: "W16X31",  value: 203,                 source: "...", reason: "..." }
  root.STEEL_DATA.overrides = [
  ];
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));

