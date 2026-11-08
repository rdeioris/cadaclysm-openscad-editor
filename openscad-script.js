// The OpenSCAD editor's example files: what the page's menu offers, the first being what it
// opens with. Environment-free; test/openscad.mjs reads each one through the wasm.

export const EXAMPLES = [
{
    id: "plate",
    title: "A plate, a boss and a bore",
    blurb: "cube, cylinder, union and difference",
    source: `// A plate with a boss on top and a bore through both: what the reader
// draws is a mesh, exact enough to see the fillet the plate is missing.
$fn = 64;

difference() {
    union() {
        cube([120, 80, 14], center = true);
        translate([0, 0, 7]) cylinder(r = 22, h = 26);
    }
    cylinder(r = 11, h = 100, center = true);
    for (x = [-45, 45], y = [-25, 25])
        translate([x, y, 0]) cylinder(r = 5, h = 40, center = true);
}
`,
},
{
    id: "bracket",
    title: "An L-bracket with slots",
    blurb: "hull for the rounded ends, a module for the slot",
    source: `// An angle bracket: two plates hulled into rounded ends, and a slot module
// used four times.
$fn = 48;
thickness = 6;

module slot(length, r) {
    hull() {
        translate([-length / 2, 0, 0]) cylinder(r = r, h = 3 * thickness, center = true);
        translate([ length / 2, 0, 0]) cylinder(r = r, h = 3 * thickness, center = true);
    }
}

module plate(w, d) {
    hull() {
        cube([w, thickness, 1], center = false);
        translate([0, 0, d - 6]) cube([w, thickness, 1]);
        for (x = [6, w - 6]) translate([x, 0, d - 6]) rotate([-90, 0, 0]) cylinder(r = 6, h = thickness);
    }
}

difference() {
    union() {
        plate(80, 50);                                   // the upright
        rotate([90, 0, 0]) translate([0, 0, -thickness]) plate(80, 60);   // the base
    }
    for (x = [22, 58]) translate([x, thickness / 2, 32]) rotate([90, 0, 0]) slot(14, 3.2);
    for (x = [22, 58]) translate([x, -32, thickness / 2]) slot(14, 3.2);
}
`,
},
{
    id: "vase",
    title: "A vase, turned",
    blurb: "rotate_extrude over a polygon, and a lip",
    source: `// A half-section turned about Z: the vase's profile as (radius, height)
// points, the waist bowing in, then a rolled lip.
$fn = 96;

profile = [[0, 0], [30, 0], [34, 20], [26, 45], [22, 70], [30, 90], [34, 96], [0, 96]];
lip = [for (a = [0 : 15 : 360]) [32 + 3 * cos(a), 93 + 3 * sin(a)]];

difference() {
    rotate_extrude() polygon(profile);
    translate([0, 0, 4]) rotate_extrude() polygon([for (p = profile) [max(p[0] - 3, 0), p[1]]]);
}
rotate_extrude() polygon(lip);
`,
},
{
    id: "gear",
    title: "A gear, tooth by tooth",
    blurb: "a for loop of rotated teeth around a hub",
    source: `// Twenty teeth set round a hub with a keyed bore: the same tooth module,
// rotated into place by a loop.
$fn = 64;
teeth = 20;
r = 40;

module tooth() {
    translate([r - 2, 0, 0]) linear_extrude(height = 10)
        polygon([[0, -4], [7, -2], [7, 2], [0, 4]]);
}

difference() {
    union() {
        cylinder(r = r, h = 10);
        for (i = [0 : teeth - 1]) rotate([0, 0, i * 360 / teeth]) tooth();
    }
    translate([0, 0, -1]) cylinder(r = 8, h = 12);
    translate([6, -2, -1]) cube([4, 4, 12]);
}
`,
},
{
    id: "colours",
    title: "Colours, part by part",
    blurb: "color() on each top-level part; a boolean keeps one colour",
    source: `// A bearing block in three colours. Each top-level object keeps its own
// colour; a union or a difference over coloured parts comes out in one, so
// the parts that differ are drawn as objects of their own.
$fn = 72;

color("SteelBlue") difference() {
    cube([60, 60, 20], center = true);
    cylinder(r = 12, h = 40, center = true);
}
color("Gold") difference() {
    translate([0, 0, 10]) cylinder(r = 24, h = 20);
    cylinder(r = 12, h = 80, center = true);
    translate([0, 0, 30]) cube([40, 40, 40]);   // a quarter cut away
}
color("Silver") for (a = [45 : 90 : 315]) rotate([0, 0, a])
    translate([34, 0, 0]) cylinder(r = 6, h = 30, center = true);
`,
},
{
    id: "nut",
    title: "The cadaclysm nut",
    blurb: "the logo: the nut, struck by lightning; hull for the bolt",
    source: `// The cadaclysm logo: the nut -- a hexagonal prism kept only where a turned
// ring is -- struck by lightning, which knocks a faceted chunk out of it.
module nut() {
    intersection() {
        cylinder(r = 60, h = 46, $fn = 6);
        rotate_extrude($fn = 128)
            polygon([[30, 0], [45, 0], [50, 5], [70, 5],
                     [70, 41], [50, 41], [45, 46], [30, 46]]);
    }
}

// Where the bolt lands: the hexagon's corner at -60 degrees, at the top.
strike = [60 * cos(-60), 60 * sin(-60), 46];

// The nut, a faceted chunk knocked out of the struck corner.
color("#F1EFE8") difference() {
    nut();
    translate(strike) rotate([20, 30, 10]) sphere(r = 24, $fn = 6);
}

// The bolt: rods between jagged points, falling onto the corner.
module rod(a, b, r = 1.6) {
    hull() { translate(a) sphere(r, $fn = 8); translate(b) sphere(r, $fn = 8); }
}
module bolt(points, r = 1.6) {
    for (i = [0 : len(points) - 2]) rod(points[i], points[i + 1], r);
}
color("#378ADD") {
    o = strike;
    bolt([o + [-46, -8, 120], o + [-34, -4, 104], o + [-38, 4, 90], o + [-20, -2, 78],
          o + [-24, 6, 62], o + [-6, 0, 50], o + [-10, 6, 34], o + [-2, 0, 18], o], 2.6);
    bolt([o + [-38, 4, 90], o + [-56, 6, 84], o + [-60, 12, 72]], 1.8);
    bolt([o + [-20, -2, 78], o + [-4, -10, 88], o + [4, -6, 100]], 1.8);
    bolt([o + [-6, 0, 50], o + [10, 4, 58], o + [16, 0, 70]], 1.8);
}
`,
},
];

export const STARTER = EXAMPLES[0].source;
