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

// A broken file is the reader's error, not a crash.
assert.throws(() => wasm.open(new TextEncoder().encode("cube(10;"), "scad", undefined, "native"), (e) => /\d/.test(String(e)));
console.log(`openscad: ok (${EXAMPLES.length} examples)`);
