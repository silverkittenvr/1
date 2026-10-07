/* ==== materials.js ==== */
/* data/materials.js -- EDITABLE. You may change anything in this file by hand; reload the page to see it.
   Seeded by make-data.js from: steel-ARCH-232-course-folder/quiz1/wk1-intro-lecture.md lines 139-146
   make-data.js will NOT overwrite this file unless it is run with --seed-editable. ASCII only. */
(function (root) {
  root.STEEL_DATA = root.STEEL_DATA || {};
  // rows = her slide; family_to_row says which row a shape family uses (tees and double angles follow their parent family)
  root.STEEL_DATA.materials = {
    "source": "steel-ARCH-232-course-folder/quiz1/wk1-intro-lecture.md lines 139-146 (her week-1 slide, \"Most commonly used\")",
    "rows": [
      {
        "id": "L139",
        "families": [
          "W",
          "C",
          "MC"
        ],
        "slide_text": "All wide flange W, C and MC shapes",
        "spec": "ASTM A992",
        "grade": "",
        "Fy": 50,
        "Fu": 65,
        "alternate": false,
        "source": "wk1-intro-lecture.md line 139"
      },
      {
        "id": "L140",
        "families": [
          "M",
          "S",
          "HP",
          "L"
        ],
        "slide_text": "All M, S, HP & L shapes",
        "spec": "ASTM A572",
        "grade": "Grade 50",
        "Fy": 50,
        "Fu": 65,
        "alternate": false,
        "source": "wk1-intro-lecture.md line 140"
      },
      {
        "id": "L141",
        "families": [
          "PL"
        ],
        "slide_text": "All Plates",
        "spec": "ASTM A36",
        "grade": "",
        "Fy": 36,
        "Fu": 58,
        "alternate": false,
        "source": "wk1-intro-lecture.md line 141"
      },
      {
        "id": "L142",
        "families": [
          "PL"
        ],
        "slide_text": "All Plates (alternate, by thickness)",
        "spec": "ASTM A572",
        "grade": "Grade 50",
        "Fy": 50,
        "Fu": 65,
        "alternate": true,
        "source": "wk1-intro-lecture.md line 142"
      },
      {
        "id": "L143",
        "families": [
          "PIPE"
        ],
        "slide_text": "All pipes",
        "spec": "ASTM A53",
        "grade": "Grade B",
        "Fy": 35,
        "Fu": 60,
        "alternate": false,
        "source": "wk1-intro-lecture.md line 143"
      },
      {
        "id": "L144",
        "families": [
          "HSS"
        ],
        "slide_text": "All HSS sections (Rectangular or Round)",
        "spec": "ASTM A500",
        "grade": "Grade C",
        "Fy": 50,
        "Fu": 62,
        "alternate": false,
        "source": "wk1-intro-lecture.md line 144"
      }
    ],
    "family_to_row": {
      "W": "L139",
      "C": "L139",
      "MC": "L139",
      "M": "L140",
      "S": "L140",
      "HP": "L140",
      "L": "L140",
      "PL": "L141",
      "PIPE": "L143",
      "HSS": "L144",
      "WT": "L139",
      "MT": "L140",
      "ST": "L140",
      "2L": "L140"
    },
    "derived_families": {
      "WT": "W",
      "MT": "M",
      "ST": "S",
      "2L": "L"
    },
    "plate_note": "All Plates are ASTM A36 \u2192 Fy = 36 ksi Fu = 58 ksi or ASTM A572 GRADE 50 \u2192 Fy = 50 ksi Fu = 65 ksi depending on thickness.",
    "use_lowest_rule": "Sometimes you are given a range. Use the lowest number unless told specifically to do otherwise. (her words, 2026-08-26)"
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));

