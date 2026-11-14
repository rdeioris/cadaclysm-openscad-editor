// The OpenSCAD editor's examples, read through the wasm as the page's worker reads them:
// each draws a mesh (a syntax error would throw with the reader's own words), the colours
// example carries more than one colour, and the worker parses.
//
// Run: node test/openscad.mjs   (after npm run setup)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert";
import { EXAMPLES, STARTER } from "../openscad-script.js";
import { FORMATS, exactColours, exportFile } from "../openscad-export.js";
import { loadPackage } from "./package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const wasm = await loadPackage();

execFileSync(process.execPath, ["--check", join(here, "..", "openscad-worker.js")], { stdio: "inherit" });

assert.strictEqual(new Set(EXAMPLES.map((e) => e.id)).size, EXAMPLES.length);
assert.strictEqual(STARTER, EXAMPLES[0].source);
for (const example of EXAMPLES) {
    const scene = wasm.open(new TextEncoder().encode(example.source), "scad", undefined, "native");
    try {
        const triangles = scene.triangleCount();
        assert.ok(triangles > 100, `${example.id}: ${triangles} triangles`);
        assert.ok(scene.edges().length > 0, `${example.id}: no feature edges`);
        const bounds = scene.bounds();
        assert.ok(bounds[3] > 1, `${example.id}: radius ${bounds[3]}`);
        if (example.id === "colours") {
            const v = scene.vertices();
            const colours = new Set();
            for (let i = 6; i < v.length; i += 9) colours.add(`${v[i].toFixed(2)},${v[i + 1].toFixed(2)},${v[i + 2].toFixed(2)}`);
            assert.ok(colours.size >= 3, `colours: ${colours.size} distinct`);
        }
    } finally {
        scene.free();
    }
}

// The preview the page shows first on a fresh file (where the package has one): the same
// model, as meshes -- its bounds the exact read's, near enough for faceting.
if (typeof wasm.preview === "function") {
    for (const example of EXAMPLES) {
        const bytes = new TextEncoder().encode(example.source);
        const quick = wasm.preview(bytes, "scad", "native");
        const exact = wasm.open(bytes, "scad", undefined, "native");
        try {
            assert.ok(quick.triangleCount() > 100, `${example.id}: preview ${quick.triangleCount()} triangles`);
            const [q, e] = [quick.bounds(), exact.bounds()];
            assert.ok(Math.abs(q[3] - e[3]) < 0.05 * e[3], `${example.id}: preview radius ${q[3]} vs ${e[3]}`);
        } finally {
            quick.free();
            exact.free();
        }
    }
    assert.throws(() => wasm.preview(new TextEncoder().encode("cube(10;"), "scad", "native"), (e) => /\d/.test(String(e)));
} else {
    console.log("openscad: this package has no preview; skipped");
}

// The Export menu (a kernel package): every example in every format, coloured as drawn.
if (typeof wasm.cadaclysm_blacksmith_open_file === "function") {
    const MAGIC = { step: "ISO-10303-21", glb: "glTF" };
    for (const example of EXAMPLES) {
        const scene = wasm.open(new TextEncoder().encode(example.source), "scad", undefined, "native");
        const colours = exactColours(scene);
        scene.free();
        for (const format of Object.keys(FORMATS)) {
            const bytes = exportFile(wasm, example.source, format, colours);
            assert.ok(bytes.length > 1000, `${example.id}.${format}: ${bytes.length} bytes`);
            if (MAGIC[format]) {
                const head = new TextDecoder().decode(bytes.slice(0, 80));
                assert.ok(head.startsWith(MAGIC[format]), `${example.id}.${format}: starts ${JSON.stringify(head.slice(0, 20))}`);
            }
            if (format === "stl") {
                // Binary: an 80-byte header, the triangle count, 50 bytes a triangle.
                const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
                assert.strictEqual(bytes.length, 84 + 50 * count, `${example.id}.stl: ${count} triangles in ${bytes.length} bytes`);
            }
            if (format === "step" || format === "brep") {
                // What was written reads back: as many solids as went out -- or, from a .brep,
                // more, where a solid of separate pieces (the colours example's four pins) comes
                // back one solid a piece.
                const back = wasm.cadaclysm_blacksmith_open_file(bytes, format);
                for (const solid of back) wasm.cadaclysm_blacksmith_solid_free(solid);
                const ok = format === "step" ? back.length === colours.length : back.length >= colours.length;
                assert.ok(ok, `${example.id}.${format}: ${back.length} solids read back of ${colours.length}`);
            }
            if (format === "step" && example.id === "colours") {
                const rgb = (new TextDecoder().decode(bytes).match(/COLOUR_RGB/g) ?? []).length;
                assert.ok(rgb >= 3, `colours.step: ${rgb} colours`);
            }
        }
    }
    // A background (%) node is drawn but not exported, and does not shift the colours: the
    // second cube's red lands on the only solid.
    const program = "%translate([20, 0, 0]) cube(5); color(\"red\") cube(5);";
    const scene = wasm.open(new TextEncoder().encode(program), "scad", undefined, "native");
    const colours = exactColours(scene);
    scene.free();
    assert.deepStrictEqual(colours, [[1, 0, 0]]);
    const step = new TextDecoder().decode(exportFile(wasm, program, "step", colours));
    assert.match(step, /COLOUR_RGB\('[^']*',1\.?0*,0\.?0*,0\.?0*\)/, "the red solid's STEP is red");
    // Counts that disagree leave the colours off rather than misplace them.
    assert.doesNotMatch(new TextDecoder().decode(exportFile(wasm, program, "step", [[1, 0, 0], [0, 1, 0]])), /COLOUR_RGB/);
    assert.throws(() => exportFile(wasm, "cube(10;", "step", null));
    assert.throws(() => exportFile(wasm, "echo(1);", "step", null), /^Error: the program makes no solid to export$/);
} else {
    console.log("openscad: this package has no kernel; export skipped");
}

// A broken file is the reader's error, not a crash.
assert.throws(() => wasm.open(new TextEncoder().encode("cube(10;"), "scad", undefined, "native"), (e) => /\d/.test(String(e)));
console.log(`openscad: ok (${EXAMPLES.length} examples)`);
