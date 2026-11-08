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

globalThis.setTimeout = realSetTimeout;
console.log("worker-crash: ok");
