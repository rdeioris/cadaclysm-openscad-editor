// The OpenSCAD editor's worker-side trap-to-crash wiring: `trapped(e)` -- the one-line test
// the worker uses to tell a wasm trap (`WebAssembly.RuntimeError`, the instance left
// poisoned) from an ordinary error -- and `schedule(fn)`, which wraps the scheduled draw
// (viewer-host's rAF `drawFrame`, outside any other function's own try) in that same test: a
// trap posts `{ kind: "crashed" }` instead of surfacing as an uncaught worker error, anything
// else rethrows unchanged.
//
// The worker otherwise imports browser-only modules and runs nowhere but the page; `trapped`
// and `schedule` are exported for this file alone, which shims just enough of `self` to
// import them under Node: `self.postMessage` records what was posted, and no
// `requestAnimationFrame` sends `schedule` down its `setTimeout` branch, whose callback this
// test then runs by hand.
//
// Run: node test/worker-crash.mjs   (after npm run setup)
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));

// self.postMessage records; no self.requestAnimationFrame, so schedule() falls to setTimeout,
// which is stubbed to hand the callback back instead of waiting on a real timer.
let posted = [];
let pendingTimer = null;
globalThis.self = globalThis;
self.postMessage = (m) => posted.push(m);
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => { pendingTimer = fn; return 0; };

const worker = await import(pathToFileURL(join(here, "..", "openscad-worker.js")).href);
const name = "openscad-worker";

{
    // ---- trapped: a real WebAssembly.RuntimeError, not a lookalike --------------------------
    assert.strictEqual(worker.trapped(new WebAssembly.RuntimeError("unreachable")), true, `${name}: a trap is trapped`);
    assert.strictEqual(worker.trapped(new Error("unreachable")), false, `${name}: an Error of the same words is not`);
    assert.strictEqual(worker.trapped(new TypeError("boom")), false, `${name}: no other error type is`);
    assert.strictEqual(worker.trapped(undefined), false, `${name}: a non-error thrown value is not`);

    // ---- schedule: the scheduled draw's trap becomes a `crashed` post -----------------------
    posted = [];
    pendingTimer = null;
    worker.schedule(() => { throw new WebAssembly.RuntimeError("draw trapped"); });
    assert.ok(pendingTimer, `${name}: schedule queued a callback`);
    pendingTimer();
    assert.deepStrictEqual(posted, [{ kind: "crashed", message: "draw trapped" }], `${name}: a trap in the scheduled draw is posted as crashed`);

    // An ordinary throw from the scheduled draw is not swallowed as a crash: it rethrows, so
    // it still reaches the caller (self.onerror on the real host's rAF, an uncaught exception
    // here) instead of the page being told the wasm trapped when it did not.
    posted = [];
    pendingTimer = null;
    worker.schedule(() => { throw new Error("not a trap"); });
    assert.throws(() => pendingTimer(), /not a trap/, `${name}: a non-trap throw from the scheduled draw is rethrown, not posted`);
    assert.deepStrictEqual(posted, [], `${name}: rethrown, not posted as crashed`);
}

{
    // ---- render: a fresh file's preview, then the exact read a frame later -------------------
    // A stand-in for the wasm module: each read is logged and hands back a scene with a
    // triangle count and a free(); no view exists here, so the worker keeps it as its pending
    // scene (freeing the one before), which is all showScene does without one.
    const log = [];
    const scene = (n) => ({ triangleCount: () => n, bounds: () => [0, 0, 0, 1], treeJson: () => '[{"generator":"brep","colour":[1,0,0]}]', free() {} });
    const reader = {
        cadaclysm_blacksmith_version() {},   // a kernel build, as hasKernel tells one
        preview: (bytes, format, convention) => { log.push(["preview", format, convention]); return scene(10); },
        open: (bytes, format, schema, convention) => { log.push(["open", format, convention]); return scene(20); },
    };
    const kinds = () => posted.map((m) => [m.kind, m.seq, m.triangles]);
    const drain = () => { for (let i = 0; pendingTimer && i < 4; i++) { const t = pendingTimer; pendingTimer = null; t(); } };

    // No view exists here, so the exact read waits for one: view.ready would show the preview
    // and follow it a frame later; view.failed (nothing will draw it) runs it straight after.
    posted = []; pendingTimer = null;
    worker.render(1, "cube(1);", true, reader);
    assert.deepStrictEqual(kinds(), [["preview", 1, 10]], `${name}: the preview is posted at once`);
    assert.deepStrictEqual(log, [["preview", "scad", "native"]], `${name}: the exact read waits for the view`);
    drain();
    assert.deepStrictEqual(log.length, 1, `${name}: and keeps waiting while there is none`);
    worker.post({ kind: "view.failed", id: 1, message: "no GPU" });
    drain();
    assert.deepStrictEqual(kinds(), [["preview", 1, 10], ["view.failed", undefined, undefined], ["scene", 1, 20]], `${name}: then the exact scene`);
    assert.deepStrictEqual(log.map((l) => l[0]), ["preview", "open"]);

    // A keystroke's render: no preview.
    posted = []; pendingTimer = null; log.length = 0;
    worker.render(2, "cube(2);", false, reader);
    assert.deepStrictEqual(kinds(), [["scene", 2, 20]], `${name}: an edit reads exactly, at once`);
    assert.deepStrictEqual(log.map((l) => l[0]), ["open"]);

    // A reader build (no kernel): its open already draws meshes, so no preview first.
    posted = []; pendingTimer = null; log.length = 0;
    worker.render(6, "cube(6);", true, { preview: reader.preview, open: reader.open });
    assert.deepStrictEqual(kinds(), [["scene", 6, 20]], `${name}: no kernel, no preview`);
    assert.deepStrictEqual(log.map((l) => l[0]), ["open"]);

    // A package without `preview`: exact, as before.
    posted = []; pendingTimer = null; log.length = 0;
    worker.render(3, "cube(3);", true, { open: reader.open });
    assert.deepStrictEqual(kinds(), [["scene", 3, 20]], `${name}: no preview in the package, an exact read`);

    // A preview that fails is said once, and the exact read is not tried.
    posted = []; pendingTimer = null; log.length = 0;
    worker.render(4, "cube(4;", true, { cadaclysm_blacksmith_version() {}, preview: () => { throw new Error("line 1: expected )"); }, open: reader.open });
    drain();
    assert.deepStrictEqual(posted, [{ ok: false, seq: 4, error: "line 1: expected )" }], `${name}: a failed preview is the error`);
    assert.deepStrictEqual(log, [], `${name}: and no exact read follows it`);

    // A preview that traps is a crash, and nothing more is read on the poisoned instance.
    posted = []; pendingTimer = null;
    worker.render(5, "cube(5);", true, { cadaclysm_blacksmith_version() {}, preview: () => { throw new WebAssembly.RuntimeError("unreachable"); }, open: reader.open });
    drain();
    assert.deepStrictEqual(posted, [{ kind: "crashed", message: "unreachable" }], `${name}: a trapped preview crashes`);
    assert.deepStrictEqual(log, []);
}

{
    // ---- exportShown: the Export menu writes the last exact read shown -----------------------
    // A stand-in kernel: solids are numbers, the file's bytes say what was written from what.
    const live = new Set();
    let next = 100;
    const made = () => { const h = next++; live.add(h); return h; };
    const calls = [];
    const kernel = {
        cadaclysm_blacksmith_open_file: (bytes, format) => { calls.push(["open_file", new TextDecoder().decode(bytes), format]); return Uint32Array.of(made()); },
        cadaclysm_blacksmith_coloured: (solid, face, r, g, b) => { calls.push(["coloured", face, [r, g, b]]); return made(); },
        cadaclysm_blacksmith_solid_free: (solid) => { assert.ok(live.delete(solid), `freed ${solid} once`); },
        cadaclysm_blacksmith_step: (solids, schema, unit) => { calls.push(["step", solids.length, unit]); return "ISO-10303-21;"; },
        cadaclysm_blacksmith_brep_text: () => "brep",
        cadaclysm_blacksmith_mesh_file: (solids, format) => new TextEncoder().encode(format),
        preview: () => ({ triangleCount: () => 1, bounds: () => [0, 0, 0, 1], treeJson: () => "[]", free() {} }),
        open: () => ({ triangleCount: () => 2, bounds: () => [0, 0, 0, 1], treeJson: () => '[{"generator":"csg","colour":[0,1,0]},{"generator":"brep","colour":[1,0,0]}]', free() {} }),
    };
    const drain = () => { for (let i = 0; pendingTimer && i < 4; i++) { const t = pendingTimer; pendingTimer = null; t(); } };

    // A fresh file's preview stands in for the exact read: nothing to export until it lands.
    posted = []; pendingTimer = null;
    worker.render(10, "cube(10);", true, kernel);
    worker.exportShown("step", kernel);
    assert.deepStrictEqual(posted.at(-1), { kind: "export.failed", format: "step", error: "nothing exact to export yet" }, `${name}: no export over a preview`);
    worker.post({ kind: "view.failed", id: 1, message: "no GPU" });   // no view here: the exact read follows at once
    drain();
    assert.strictEqual(posted.at(-1).kind, "scene");

    // Then the exact read's text, coloured as its exact (brep) node is, the background one skipped.
    posted = []; calls.length = 0;
    worker.exportShown("step", kernel);
    assert.deepStrictEqual(calls, [["open_file", "cube(10);", "scad"], ["coloured", 0xFFFFFFFF, [1, 0, 0]], ["step", 1, 1]], `${name}: the exact text, coloured, in millimetres`);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].kind, "exported");
    assert.strictEqual(new TextDecoder().decode(posted[0].bytes), "ISO-10303-21;");
    assert.ok(posted[0].bytes instanceof ArrayBuffer, `${name}: the bytes cross as an ArrayBuffer`);
    assert.strictEqual(live.size, 0, `${name}: every solid freed`);

    posted = [];
    worker.exportShown("glb", kernel);
    assert.strictEqual(new TextDecoder().decode(posted[0].bytes), "glb");
    assert.strictEqual(live.size, 0);

    // The kernel's refusal is an export.failed, and the solids are freed all the same.
    posted = [];
    worker.exportShown("step", { ...kernel, cadaclysm_blacksmith_step: () => { throw new Error("step: no"); } });
    assert.deepStrictEqual(posted, [{ kind: "export.failed", format: "step", error: "step: no" }], `${name}: a refused write is said`);
    assert.strictEqual(live.size, 0, `${name}: and frees its solids`);

    // A trap is a crash.
    posted = [];
    worker.exportShown("step", { ...kernel, cadaclysm_blacksmith_open_file: () => { throw new WebAssembly.RuntimeError("unreachable"); } });
    assert.deepStrictEqual(posted, [{ kind: "crashed", message: "unreachable" }], `${name}: a trapped export crashes`);

    // A package without the kernel cannot export.
    posted = [];
    worker.exportShown("step", { open: kernel.open });
    assert.strictEqual(posted[0].kind, "export.failed", `${name}: no kernel, no export`);
}

globalThis.setTimeout = realSetTimeout;
console.log("worker-crash: ok");
