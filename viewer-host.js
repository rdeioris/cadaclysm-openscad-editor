// viewer-host.js
// Runs in a page's worker: owns wasm Viewers drawing OffscreenCanvases and answers the
// message protocol viewer-client.js speaks, one View per view id. No knowledge of solids,
// scenes or any page -- a page's worker imports this and its own concerns alongside it.
//
// The protocol, page to worker:
//   view.create {id, canvas, width, height, ratio, surfaces?, backend?, background?}
//   view.resize {id, width, height, ratio}
//   view.free   {id}
//   view.pick   {id, seq, viewport, x, y}          -> view.picked {id, seq, hit}
//   view.call   {id, seq, name, args}              -> view.result {id, seq, value}
//                                                   | view.error  {id, seq, message}
//   view.input  {id, seq, event}                   -> view.picked {id, seq, hit}, only for
//                                                     an input the View answered with a pick
//                                                   | view.tapped {id, seq, tap, viewport, double}, for
//                                                     a tap while setPickOnTap(false): the page picks
// and worker to page, unasked: view.ready, view.failed, view.resized, view.error {id, message}
// (the View's own onError), and view.frame {id, viewports}, posted after every frame the
// host draws: each viewport's rect, view and projection (column-major, 0..1 depth), eye and
// camera kind (`View.frameReport()`), so a page projects its overlay through the matrices
// the picture was drawn with. `view.call` calls any View method by name -- the names
// `View.prototype` has, less `constructor`, `free`, the `create*` statics' kin and
// wasm-bindgen's `__` internals -- so a new View method needs nothing here. `event` is
// what view.js's `normalise` makes of a DOM event, handed to `View.input` as is.
//
// A view draws only when something about it changed, or while the View says it is
// `flying` (a fly key held). Its create, every call and every resize mark the view dirty
// here (the host cannot tell what a call changed); an input does not -- the View's own
// `needsDraw` says whether it moved anything, so a hover that changed nothing draws
// nothing. Each asks `schedule` for the next frame if nothing is scheduled for the view
// yet, and that frame draws once, if the host's flag, `needsDraw` or `flying` is set,
// however many messages landed before it, or a resting frame pending (`restPending`).
// While the View is flying, the frame after a draw schedules another, so it keeps
// stepping by real time until it lands.
//
// `View.create` is async, so messages for an id can arrive before its View exists.
// Every such message is kept: a `view.resize` folds into the width/height/ratio the create
// will use (the latest one seen wins, not a replayed resize); anything else queues and
// replays, in order, once the View is installed. A `view.free` for a still-pending id
// frees the View the moment it exists and posts no `view.ready` -- a view destroyed
// before it ever answered never gets to say it was ready.
//
// The forge sizes its own on-page canvas from the CSS size and a capped device ratio
// (forge-canvas.js), because the View's own `resize` only tells it the drawing size
// it should target -- it does not touch `canvas.width`/`height` itself unless its own
// `start()` loop is running (which a worker's OffscreenCanvas never does). This host
// stands in for that: it caps the ratio the same way (`drawingRatio`), and it is the one
// that must set the transferred OffscreenCanvas's backing size (`drawingSide`) to match
// what `resize` will tell the View to draw -- both on create and on every later resize.
//
// `markDirty(id)`, on the object this returns: a worker that changes its own hosted View
// directly -- outside `view.call`, e.g. calling `showScene`/`remove`/`frame`/`setGrid`
// itself to draw a scene it read -- schedules that view's next draw the same way a
// dispatched message does, one frame, however many direct changes landed before it. A no-op
// for an id with no View yet (still pending, or never created) or no longer one (freed).
//
// `onTrap(error, id)`, optional: a worker whose Viewers share one wasm instance with
// something else (the notebook's kernel) must not go on after a trap -- a panic aborts
// without unwinding, so the wasm's borrow flags stay set. Given, a `WebAssembly.RuntimeError`
// thrown by any View call this host makes (create, resize, call, input, pick, free, a
// scheduled draw) goes to `onTrap` instead of becoming a view.error/view.failed or escaping
// `handle`. Absent, a trap is treated as any other error, as before.

import { drawingRatio, drawingSide } from "./forge-canvas.js";

// The View methods `view.call` may name: every function on `prototype` but these, the
// `create*` names and wasm-bindgen's `__` internals. Getters (`flying`, `backend`, ...) are
// not functions on the prototype and so are not callable either.
const NOT_CALLABLE = new Set([
    "constructor",
    // Only view.free frees, so the host forgets the id with it.
    "free",
    // onError(null), or any other callback, would replace the host's own relay to view.error.
    "onError",
    // view.resize applies the drawingRatio cap, sets the OffscreenCanvas's backing size and
    // answers view.resized; a bare resize would skip all three.
    "resize",
    // The host schedules the drawing; the View's own loop would be a second one.
    "start", "stop",
    // Each has its own message: view.pick (latest-wins, answered by view.picked) and
    // view.input (answered by view.picked when it picks).
    "pick", "input",
]);
// The View getters `view.call` reads, called with no arguments: `client.view.navigation()`
// answers the getter's value ("orbit" or "fly"), so a page whose View is in a worker can
// show the mode. `lighting()` answers "headlight", "studio" or "showroom". A read changes nothing, so it marks nothing dirty.
const READABLE = new Set(["navigation", "flying", "lighting"]);
function callable(prototype) {
    return new Set(Object.getOwnPropertyNames(prototype).filter((n) =>
        !NOT_CALLABLE.has(n) && !n.startsWith("__") && !n.startsWith("create")
        && typeof Object.getOwnPropertyDescriptor(prototype, n).value === "function"));
}

const errorText = (e) => e?.message ?? String(e);

export function createViewerHost({ View, post, now, schedule, onTrap }) {
    const allowed = callable(View.prototype);
    // True when `e` was a trap and went to onTrap: the caller then stops, posting nothing.
    const trapped = (e, id) => {
        if (!onTrap || typeof WebAssembly === "undefined" || !(e instanceof WebAssembly.RuntimeError)) return false;
        onTrap(e, id);
        return true;
    };
    // id -> View, for the worker's own show* calls. Only holds an id once its View
    // exists -- not while create() is still pending, and not once it has been freed.
    const views = new Map();
    // id -> { dirty, scheduled }, kept out of `views` so that map stays
    // exactly id -> View as the interface promises.
    const state = new Map();
    // id -> the OffscreenCanvas transferred at create, kept so a later resize can still
    // set its backing size.
    const canvases = new Map();
    // id -> { width, height, ratio, queue, freed } while create() has not resolved yet.
    const pendingCreates = new Map();

    function markDirty(id) {
        const s = state.get(id);
        if (!s) return;
        s.dirty = true;
        scheduleFrame(id);
    }

    function scheduleFrame(id) {
        const s = state.get(id);
        if (!s || s.scheduled) return;
        s.scheduled = true;
        schedule(() => drawFrame(id));
    }

    function drawFrame(id) {
        const s = state.get(id);
        const viewer = views.get(id);
        if (!s || !viewer) return;
        s.scheduled = false;
        const flying = !!viewer.flying;
        if (!s.dirty && !flying && !viewer.needsDraw) {
            // A resting frame coming (the "smooth" policy): keep asking for frames, drawing
            // none, until needsDraw says it is due.
            if (viewer.restPending) scheduleFrame(id);
            return;
        }
        s.dirty = false;
        try {
            viewer.draw();
        } catch (e) {
            if (trapped(e, id)) return;
            throw e;
        }
        if (typeof viewer.frameReport === "function") {
            let viewports;
            try {
                viewports = viewer.frameReport();
            } catch (e) {
                if (trapped(e, id)) return;
                throw e;
            }
            post({ kind: "view.frame", id, viewports });
        }
        if (flying || s.dirty || viewer.needsDraw || viewer.restPending) scheduleFrame(id);
    }

    // Caps `ratio` so neither side of `width` x `height` (CSS pixels) passes the View's
    // own `maxDrawingSize`, sets the transferred canvas's backing size to match exactly
    // what `resize` below will make the View draw, and applies it. Returns the
    // effective ratio applied, in device pixels a CSS pixel -- posted alongside
    // view.ready and view.resized so a page (and this client's `pick`) knows what a
    // device pixel is worth without redoing this cap itself.
    function applySize(id, viewer, width, height, ratio) {
        const maxSize = viewer.maxDrawingSize;
        const effectiveRatio = drawingRatio(ratio, width, height, maxSize);
        const canvas = canvases.get(id);
        if (canvas) {
            canvas.width = drawingSide(width, effectiveRatio, maxSize);
            canvas.height = drawingSide(height, effectiveRatio, maxSize);
        }
        viewer.resize(width, height, effectiveRatio);
        return effectiveRatio;
    }

    async function create(message) {
        const { id, canvas, width, height, ratio } = message;
        const options = {};
        if (message.surfaces !== undefined) options.surfaces = message.surfaces;
        if (message.backend !== undefined) options.backend = message.backend;
        if (message.background !== undefined) options.background = message.background;
        canvases.set(id, canvas);
        const pend = { width, height, ratio, queue: [], freed: false };
        pendingCreates.set(id, pend);
        try {
            const viewer = await View.create(canvas, options);
            pendingCreates.delete(id);
            if (pend.freed) {
                // Freed before it ever existed: make it disappear, quietly. No
                // view.ready -- nothing further should reach a view the page already
                // asked to free.
                viewer.free();
                canvases.delete(id);
                return;
            }
            const ratio = applySize(id, viewer, pend.width, pend.height, pend.ratio);
            views.set(id, viewer);
            state.set(id, { dirty: false, scheduled: false });
            viewer.onError((errorMessage) => post({ kind: "view.error", id, message: errorMessage }));
            post({ kind: "view.ready", id, backend: viewer.backend, surfaces: viewer.surfaces, maxDrawingSize: viewer.maxDrawingSize, ratio });
            markDirty(id);
            for (const queued of pend.queue) dispatch(id, viewer, queued);
        } catch (e) {
            pendingCreates.delete(id);
            canvases.delete(id);
            if (trapped(e, id)) return;
            post({ kind: "view.failed", id, message: e?.message ?? String(e) });
        }
    }

    async function pick(id, viewer, message) {
        const { seq, viewport, x, y } = message;
        let hit = null;
        try {
            hit = (await viewer.pick(viewport ?? 0, x, y)) ?? null;
        } catch (e) {
            if (trapped(e, id)) return;
            hit = null;
        }
        post({ kind: "view.picked", id, seq, hit });
    }

    // A value a call returns goes back in view.result -- when postMessage can clone it. A
    // wasm object cannot be (nor a function), so a call returning one answers with no value.
    function result(id, seq, value) {
        try {
            post({ kind: "view.result", id, seq, value });
        } catch {
            post({ kind: "view.result", id, seq, value: undefined });
        }
    }

    // Called at once, so its effect lands before any message after it (and before the
    // frame it marks dirty); a returned promise answers when it settles.
    function call(id, viewer, message) {
        const { seq, name, args } = message;
        if (READABLE.has(name)) {
            let value;
            try {
                value = viewer[name];
            } catch (e) {
                if (trapped(e, id)) return;
                post({ kind: "view.error", id, seq, message: errorText(e) });
                return;
            }
            result(id, seq, value);
            return;
        }
        if (!allowed.has(name)) {
            post({ kind: "view.error", id, seq, message: `view.call: ${name} is not a View method this bridge calls` });
            return;
        }
        let value;
        try {
            value = viewer[name](...(args ?? []));
        } catch (e) {
            if (trapped(e, id)) return;
            post({ kind: "view.error", id, seq, message: errorText(e) });
            return;
        }
        if (value && typeof value.then === "function") {
            value.then((v) => result(id, seq, v), (e) => { if (!trapped(e, id)) post({ kind: "view.error", id, seq, message: errorText(e) }); });
        } else {
            result(id, seq, value);
        }
    }

    // View.input answers a tap with a pick's promise, anything else with nothing; the
    // pick goes back as view.picked with the input's seq, a failed one as no hit. A frame is
    // asked for after the input and again once a pick settles (a double tap that frames --
    // setDoubleClickFrames(true) -- moves the view only then); either draws only if the
    // View says it needs to.
    function input(id, viewer, message) {
        const { seq, event } = message;
        let answer;
        try {
            answer = viewer.input(event);
        } catch (e) {
            if (trapped(e, id)) return;
            post({ kind: "view.error", id, seq, message: errorText(e) });
            return;
        }
        if (answer && typeof answer.then === "function") {
            answer.then((hit) => post({ kind: "view.picked", id, seq, hit: hit ?? null }),
                (e) => { if (!trapped(e, id)) post({ kind: "view.picked", id, seq, hit: null }); })
                .finally(() => scheduleFrame(id));
        } else if (answer && typeof answer === "object" && "tap" in answer) {
            post({ kind: "view.tapped", id, seq, tap: answer.tap, viewport: answer.viewport, double: answer.double });
        }
    }

    // Every message but view.create, once the View for `id` exists (called straight
    // from handle(), and again to replay a pending id's queued messages once it is
    // installed). A trap in a resize or free goes to onTrap, when given, rather than out
    // of handle().
    function dispatch(id, viewer, message) {
        try {
            dispatchOne(id, viewer, message);
        } catch (e) {
            if (!trapped(e, id)) throw e;
        }
    }
    function dispatchOne(id, viewer, message) {
        switch (message.kind) {
            case "view.resize": {
                const ratio = applySize(id, viewer, message.width, message.height, message.ratio);
                post({ kind: "view.resized", id, width: message.width, height: message.height, ratio });
                markDirty(id);
                break;
            }
            case "view.call":
                call(id, viewer, message);
                if (!READABLE.has(message.name)) markDirty(id);
                break;
            case "view.input":
                input(id, viewer, message);
                scheduleFrame(id);
                break;
            case "view.pick":
                pick(id, viewer, message);
                break;
            case "view.free":
                viewer.free();
                views.delete(id);
                state.delete(id);
                canvases.delete(id);
                break;
            default:
                break;
        }
    }

    function handle(message) {
        const { kind, id } = message;
        if (kind === "view.create") {
            create(message);
            return;
        }
        const pend = pendingCreates.get(id);
        if (pend) {
            // The View isn't made yet: a resize folds into the size create() will use
            // (the latest one wins -- there is no drawing yet to actually resize), a free
            // is remembered to run the moment the View exists, and everything else
            // waits to replay in the order it arrived.
            if (kind === "view.resize") {
                pend.width = message.width;
                pend.height = message.height;
                pend.ratio = message.ratio;
            } else if (kind === "view.free") {
                pend.freed = true;
                pend.queue.length = 0;
            } else {
                pend.queue.push(message);
            }
            return;
        }
        const viewer = views.get(id);
        if (!viewer) return; // an unknown, or freed, id: ignored.
        dispatch(id, viewer, message);
    }

    return { handle, views, markDirty };
}
