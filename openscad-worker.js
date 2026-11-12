// The OpenSCAD editor's worker: the wasm reads the text as a `.scad` file -- the same
// reader the viewer and the desktop apps run -- and hosts the wasm View that draws it,
// on a canvas transferred here by the page (viewer-client.js, viewer-host.js). The
// text in, a `Scene` shown in this worker's own View; nothing crosses back but its
// triangle count and the read time, and nothing is uploaded.
//
// Page to worker: `{ kind: "render", seq, text, preview }`, `{ kind: "reframe" }` (a new file: the
// next scene always re-frames the camera, in place of the page's old `framed = false`),
// plus the bridge's `view.*` messages (viewer-client.js), all handed to the host. Worker to
// page: `{ kind: "ready", version }` once the wasm is up; after a render, `{ ok: true, kind:
// "scene", seq, triangles, ms }` (the buffers no longer cross: this worker keeps the
// `Scene` and shows it itself) -- with `preview` set, first `{ ok: true, kind: "preview", seq,
// triangles, ms }` for the quick meshes shown while the exact read runs (`render` below) -- or,
// on failure, `{ ok: false, seq, error }` -- the reader's
// own words, a syntax error's line included; the view keeps the last file that read -- or,
// if the wasm trapped (a panic, or running out of memory on a huge $fn or a large
// linear_extrude), `{ kind: "crashed", message }`, the page's cue to remake the worker and
// its canvas rather than keep using a poisoned instance. Plus the host's own `view.*`
// messages, unasked (view.ready, view.failed, view.resized, view.error, view.result,
// view.picked), which the page passes to its client's `receive` -- including a `view.error`
// this worker posts itself if showing a read scene fails (see `showScene` below), so the
// page's status line says so instead of that surfacing as an uncaught exception
// (`worker.onerror`, "the reader failed to load"). A trap from `showScene` or the scheduled
// draw is a `crashed` too, not a `view.error`: see `trapped` and its callers below.
//
// Every message before the module loads is queued, in order, and replayed once it does:
// `view.create` itself calls `View.create()` straight away, and a `render` needs the wasm's
// `open` too.
//
// `View.showScene` clones what it needs from the `Scene` it is given (an `Rc` of the
// document, for its exact surfaces): the JS `Scene` object itself is freed the moment
// `showScene` has returned and its `bounds()` been read, not kept around -- wasm linear
// memory never shrinks, and a resident `Scene` on top of the View's own copy would raise
// this tab's high-water mark for nothing. `showScene`/`viewer.remove` below call the host's
// `markDirty(id)` themselves: they change the hosted View directly, outside `view.call`,
// which the host has no other way to notice needs a draw.
import * as wasm from "./pkg/index.js";
import { createViewerHost } from "./pkg/viewer-host.js";

const VIEW_ID = 1;

// Exported for test/worker-crash.mjs, which shims `self` and drives these directly: this
// worker otherwise has nothing importable, and "run nowhere but the page" is otherwise the
// most that could be said of the trap-to-crash wiring below.
export const trapped = (e) => typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;

// A trap from the scheduled draw (viewer-host's rAF `drawFrame`) is reported the same way as
// one from a render or a direct view change, rather than left an uncaught worker error.
export function schedule(fn) {
    const draw = () => {
        try { fn(); } catch (e) {
            if (trapped(e)) self.postMessage({ kind: "crashed", message: String(e?.message ?? e) });
            else throw e;
        }
    };
    if (typeof self.requestAnimationFrame === "function") self.requestAnimationFrame(draw);
    else setTimeout(draw, 16);
}

// The camera's keep-frame rule, moved here from openscad.js: the first scene of a view (or
// one after `reframe`) always frames the camera; a later one keeps it unless the model has
// grown, shrunk or moved past the frame -- twice the size, or its centre a radius away.
let framedAt = null; // { radius, centre } once framed by a scene; null before one, or after reframe
let firstScene = true; // setGrid's axes are laid out once, on the first scene a view ever shows

// The view's item id the currently-shown scene was shown as -- its own `Scene` is not kept
// (see the header comment): only enough to show-then-remove the next one (showing first
// keeps the camera: the View only re-frames when its items become empty).
let shown = null; // { item } | null

// A render that finishes before the view exists yet (`view.create` is still pending, or has
// not even arrived): its Scene is kept here -- still unfreed -- and shown, the same way,
// once view.ready posts.
let pendingScene = null;

// The exact read behind a preview, while the preview waits for the view to exist: run once
// view.ready has shown the preview (a frame later, as `afterDraw` does), or at once if the
// view failed and nothing will draw it.
let afterView = null;

// Runs `fn` once the scene just shown has had a frame to draw in: a rAF callback queued
// behind the draw's own, which hands off to a task so `fn` does not hold that frame up. With
// no view yet, after view.ready (or at once on view.failed): see `post`.
function afterDraw(fn) {
    if (!host.views.get(VIEW_ID)) { afterView = fn; return; }
    schedule(() => setTimeout(fn, 0));
}

function keeps(bounds) {
    if (!framedAt) return false;
    const [cx, cy, cz, radius] = bounds;
    const distance = Math.hypot(cx - framedAt.centre[0], cy - framedAt.centre[1], cz - framedAt.centre[2]);
    return radius < 2 * framedAt.radius && radius > framedAt.radius / 2 && distance < framedAt.radius;
}

// Shows `scene` in the view, if it exists yet; otherwise keeps it in `pendingScene` (freeing
// any scene superseded there first) for `post`'s view.ready hook below to show once it does.
//
// `scene` is freed the moment `showScene` has returned and its `bounds()` been read --
// whether that succeeded or not: a throw there (before the new item is on screen) frees the
// new scene, posts a `view.error` instead of letting the exception reach `self.onmessage`'s
// caller (which would otherwise surface to the page as `worker.onerror`), and leaves `shown`
// pointing at the previous item, still showing, untouched. A throw from `viewer.remove` of
// the previous item (the new one is already shown by then, and its own scene already freed)
// is reported the same way; `shown` is left as is there too, since this worker cannot tell
// what state the View is now in well enough to recover it itself. `frame` and `setGrid` sit
// inside the same try: on the view.ready replay path a throw there would otherwise land in
// viewer-host's own `create()` try and post `view.failed` for a View that exists and draws
// (see `post` below and its caller). A trap (not a throw) is not reported as a `view.error`:
// it is thrown on, to the crash path.
function showScene(scene) {
    const viewer = host.views.get(VIEW_ID);
    if (!viewer) {
        pendingScene?.free();
        pendingScene = scene;
        return;
    }
    let freed = false;
    const freeScene = () => { if (!freed) { freed = true; scene.free(); } };
    let item, bounds;
    try {
        item = viewer.showScene(scene);
        bounds = scene.bounds();
        freeScene();
        const previous = shown;
        if (previous) viewer.remove(previous.item);
        shown = { item };
        if (!keeps(bounds)) {
            viewer.frame();
            framedAt = { radius: bounds[3], centre: [bounds[0], bounds[1], bounds[2]] };
        }
        if (firstScene) {
            firstScene = false;
            viewer.setGrid({ axes: true });
        }
    } catch (e) {
        freeScene();
        if (trapped(e)) throw e;
        self.postMessage({ kind: "view.error", id: VIEW_ID, message: `showScene: ${e?.message ?? e}` });
        return;
    }
    // showScene, remove, frame and setGrid all changed the hosted View directly -- the
    // host only marks a view dirty for a dispatched view.create/view.resize/view.call/
    // view.input, so a direct change like this one has to ask for its own draw.
    host.markDirty(VIEW_ID);
}

// Wraps the host's own `post`: forwards every message to the page unchanged, but on
// view.ready for the one view here also shows a scene left waiting for it -- the host has
// already put this view's View into `host.views` by the time it calls post() (its
// create(): views.set() runs before the view.ready post), so showScene() above can reach it --
// and then lets an exact read waiting on that preview (`afterView`) follow it a frame later;
// on view.failed that read runs at once. Exported for test/worker-crash.mjs.
export function post(message, transfer) {
    self.postMessage(message, transfer);
    if (message.kind === "view.ready" && message.id === VIEW_ID && pendingScene) {
        const scene = pendingScene;
        pendingScene = null;
        try {
            showScene(scene);
        } catch (e) {
            if (trapped(e)) self.postMessage({ kind: "crashed", message: String(e?.message ?? e) });
            else throw e;
        }
    }
    // After the preview above is shown (and its draw asked for), not before.
    if (message.id === VIEW_ID && afterView && (message.kind === "view.ready" || message.kind === "view.failed")) {
        const fn = afterView;
        afterView = null;
        if (message.kind === "view.ready") afterDraw(fn);
        else setTimeout(fn, 0);
    }
}

const host = createViewerHost({ View: wasm.View, post, now: () => performance.now(), schedule });

// A license (cadaclysm.lic: its URL or its text) for a site others use; without one the
// module runs in full, with a notice in the console on every file read.
// https://cadaclysm.blitter.studio/license
const LICENSE = null;
const ready = wasm.load(LICENSE ? { license: LICENSE } : {}).then(() => { self.postMessage({ kind: "ready", version: wasm.version() }); });
ready.catch((e) => self.postMessage({ kind: "view.failed", id: VIEW_ID, message: String(e?.message ?? e) }));

// A render with `preview` set (a fresh file: the page sets it on a new example, an opened
// file, a first read and a restart) shows the file's quick meshes first -- the reader's
// `preview`, the same solids in the same colours, faceted, in a fraction of the time -- then
// lets a frame draw them before the exact read blocks this worker; a keystroke's render goes
// straight to the exact read, which the reader's caches make quick, rather than flash from
// faceted to smooth on every edit. A package too old to have `preview` reads exactly, as
// before. A preview that fails is the file's error, said once: the exact read is not tried.
//
// `reader` is the wasm module, or test/worker-crash.mjs's stand-in for it.
export function render(seq, text, preview = false, reader = wasm) {
    const bytes = new TextEncoder().encode(text);
    if (preview && typeof reader.preview === "function") {
        // "native": the file's own axes and units, which is the space the View's Z-up
        // camera draws.
        if (!read(seq, "preview", () => reader.preview(bytes, "scad", "native"))) return;
        afterDraw(() => read(seq, "scene", () => reader.open(bytes, "scad", undefined, "native")));
        return;
    }
    read(seq, "scene", () => reader.open(bytes, "scad", undefined, "native"));
}

// One read, posted as `kind` and shown; false where it failed (and said so).
function read(seq, kind, opener) {
    const started = performance.now();
    let scene;
    try {
        scene = opener();
    } catch (error) {
        // A trap (a panic, or running out of memory on a huge $fn or a large
        // linear_extrude) leaves the wasm instance poisoned: the next draw or showScene
        // would trap too, so this is reported as a crash instead of a read error, and the
        // page remakes the worker rather than going on using it.
        if (trapped(error)) { self.postMessage({ kind: "crashed", message: String(error?.message ?? error) }); return false; }
        self.postMessage({ ok: false, seq, error: String(error && error.message ? error.message : error) });
        return false;
    }
    const triangles = scene.triangleCount();
    const ms = Math.round(performance.now() - started);
    self.postMessage({ ok: true, kind, seq, triangles, ms });
    try {
        showScene(scene);
    } catch (e) {
        if (trapped(e)) { self.postMessage({ kind: "crashed", message: String(e?.message ?? e) }); return false; }
        throw e;
    }
    return true;
}

function dispatch(data) {
    if (data.kind === "render") { render(data.seq, data.text, data.preview === true); return; }
    if (data.kind === "reframe") { framedAt = null; return; }
    host.handle(data);
}

// Every message before the module loads is queued, in order, and replayed once it does.
const queue = [];
let bootReady = false;
ready.then(() => {
    bootReady = true;
    for (const data of queue.splice(0)) dispatch(data);
}, () => {});

self.onmessage = ({ data }) => {
    if (!bootReady) { queue.push(data); return; }
    dispatch(data);
};
