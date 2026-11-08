// viewer-client.js
// Runs on the page: transfers a canvas to a worker's viewer-host.js, keeps its size in
// step, forwards input and turns picks into promises. No knowledge of solids, scenes or
// any page beyond the canvas it is given.
//
// The worker's messages reach a client through its own `receive(message)`: the page's
// worker.onmessage passes every view.* message meant for this id there (the page's worker
// also carries its own traffic, so the page routes by id and kind itself).
//
// `client.view` is the worker's View by proxy: `await client.view.showCurves(b, rgb)`
// posts view.call {name: "showCurves", args: [b, rgb]} and resolves with view.result's
// value (rejects with view.error's message). Arguments and results cross by structured
// clone, so a wasm object (a Solid, a Scene) cannot: build those in the worker.
// `client.input(domEvent)` hands a DOM event to the View's own gestures (View.input);
// `controls: true` does that for every event on the canvas. A tap's pick comes back to
// `onPick(hit)` -- `{item, node, face, clicks, point}` or `null`. A double tap calls it
// twice: once for its first tap (`clicks` 1), and again for the double tap itself
// (`clicks` 2), which frames what it hit only where the page opted in
// (`client.view.setDoubleClickFrames(true)`). It carries no modifiers (Shift, Ctrl).
//
// `onFrame(viewports)` is called with every view.frame the host posts (each viewport's rect,
// view, projection, eye and kind); `client.lastFrame` is the latest, `null` before one.
// `onTap(tap, viewport, double, seq)` hears a tap the View did not pick (setPickOnTap(false));
// `seq` is the one `inputEvent` returned for the up that tapped. `background` ([r, g, b]) goes
// in view.create. `onResized(ratio)` hears each view.resized, with `client.ratio` already the new
// ratio: a page that places things in device pixels re-places them there. `maxRatio` caps the
// device ratio the client asks for (a page that wants no more than 2x on a 3x screen).
//
// Only methods go through `view`: a getter read through the proxy (`client.view.flying`,
// `client.view.backend`) is a function that calls a method of that name, not the value --
// but the host answers a call of the getters `navigation` and `flying` with their value, so
// `await client.view.navigation()` is "orbit" or "fly".
// The values the page needs come with `ready` (`backend`, `surfaces`, `maxDrawingSize`).
// The host refuses, with view.error, the names it owns itself: `onError` (a callback would
// replace its relay to view.error), `resize` (view.resize caps the ratio and sizes the
// OffscreenCanvas; use `checkSize`), `start`/`stop` (the host schedules the drawing),
// `pick` and `input` (their own messages: `client.pick`, `client.input`) and `free`
// (`client.free`, so the host forgets the id with it).
//
// view.js's `normalise` and `listen` are loaded from ./pkg/view.js, beside the package's
// cadaclysm.js, unless the caller passes its own.

let pageView = null;
function loadPageView() {
    pageView ??= import("./pkg/view.js");
    return pageView;
}

// `surfaces` defaults to "exact": pages draw exact surfaces wherever the worker has them (a
// WebGL2 View draws triangles by itself); a page forces triangles by passing "triangles"
// (every page maps `?surfaces=triangles` onto it).
export function attachViewer({ canvas, worker, id, surfaces = "exact", backend, background, maxRatio = Infinity, onError, onPick, onTap, onFrame, onResized, controls = false, normalise, listen }) {
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

    // One seq counter for picks, calls and input, so an answer's seq names one request.
    let seq = 0;
    // seq -> { resolve, reject } for every view.call not answered yet.
    const calls = new Map();

    // One pick in flight at a time; a pick asked while one is out replaces the queued one
    // (latest wins), and the superseded promise resolves null.
    let pending = null; // { seq, resolve }
    let queued = null; // { seq, x, y, viewport, resolve }

    // The host's own effective ratio (view.ready, then every view.resized) -- the
    // drawingRatio it actually used, capped so the drawing fits maxDrawingSize, which
    // can be lower than devicePixelRatio. `null` until view.ready arrives. `pick(x, y)`
    // takes device pixels at this ratio, same as the canvas's own backing store.
    let ratio = null;

    // The latest view.frame's viewports; null before the first.
    let lastFrame = null;

    function send(message, transfer) {
        worker.postMessage(message, transfer);
    }

    function sizeOf() {
        return {
            width: Math.round(canvas.clientWidth),
            height: Math.round(canvas.clientHeight),
            ratio: Math.min(globalThis.devicePixelRatio || 1, maxRatio),
        };
    }

    let last = sizeOf();
    const offscreen = canvas.transferControlToOffscreen();
    send({ kind: "view.create", id, canvas: offscreen, width: last.width, height: last.height, ratio: last.ratio, surfaces, backend, ...(background !== undefined ? { background } : {}) }, [offscreen]);

    function checkSize() {
        const size = sizeOf();
        if (size.width !== last.width || size.height !== last.height || size.ratio !== last.ratio) {
            last = size;
            send({ kind: "view.resize", id, width: size.width, height: size.height, ratio: size.ratio });
        }
    }

    // A ResizeObserver catches the canvas's own CSS-size changes; devicePixelRatio can
    // change with no resize (dragging the window to another monitor), so every event this
    // client forwards re-checks it too (`forward()` below), whether that is `controls:
    // true`'s own listeners or a page's `input(domEvent)` calls.
    let resizeObserver = null;
    if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => checkSize());
        resizeObserver.observe(canvas);
    }

    // A fly key's keyup can miss the page entirely -- focus (or the whole tab) leaves
    // while it is still down, so nothing ever tells the worker to let it go. Both events
    // that mean "this page stopped seeing input" call the View's clearKeys, so the camera
    // stops flying the moment either fires rather than however long the key stays stuck.
    // Guarded on globalThis.addEventListener existing at all: the Node fakes this module
    // is tested against (under Node) have no window or document.
    // Nobody awaits this one: a failed clear is not worth an unhandled rejection.
    const clearKeys = () => { call("clearKeys", []).catch(() => {}); };
    let clearKeysOnHide = null;
    if (typeof globalThis.addEventListener === "function") {
        const onVisibility = () => { if (globalThis.document?.hidden) clearKeys(); };
        globalThis.addEventListener("blur", clearKeys);
        globalThis.addEventListener("visibilitychange", onVisibility);
        clearKeysOnHide = () => {
            globalThis.removeEventListener("blur", clearKeys);
            globalThis.removeEventListener("visibilitychange", onVisibility);
        };
    }

    function call(name, args) {
        const promise = new Promise((resolve, reject) => {
            const s = ++seq;
            calls.set(s, { resolve, reject });
            // An argument postMessage cannot clone (a function, a wasm object) throws here:
            // the call rejects with that, and nothing waits for an answer.
            try { send({ kind: "view.call", id, seq: s, name, args }); } catch (e) { calls.delete(s); throw e; }
        });
        // Marked handled, so a fire-and-forget `view.orbit()` never logs an unhandled
        // rejection; a caller who awaits the promise returned still sees it reject.
        promise.catch(() => {});
        return promise;
    }

    // Any method name is a call; `then` is not (so `await client.view` is the proxy, not a
    // call), nor is a symbol (inspection, coercion).
    const view = new Proxy({}, {
        get: (_, name) => (typeof name !== "string" || name === "then") ? undefined : (...args) => call(name, args),
    });

    // Every forwarded event re-checks the canvas's size first, as a page's own `dirty()`
    // used to: devicePixelRatio can change with no resize.
    function forward(event) {
        if (!event) return;
        checkSize();
        send({ kind: "view.input", id, seq: ++seq, event });
    }

    // An event already in View.input's form (forge-input.js's viewEvent), as it is: no
    // normalise. Returns its seq, which the view.tapped it may cause carries back.
    function inputEvent(event) {
        checkSize();
        const s = ++seq;
        send({ kind: "view.input", id, seq: s, event });
        return s;
    }

    const importFailed = (e) => onError?.(`view.js: ${e?.message ?? e}`);

    // Sync with the caller's own normalise; otherwise every event waits on the one import,
    // so they still reach the worker in the order they came.
    function input(domEvent) {
        if (normalise) forward(normalise(canvas, domEvent));
        else loadPageView().then((m) => forward(m.normalise(canvas, domEvent)), importFailed);
    }

    // listen's onRelease is clearKeys too: it also catches the canvas alone losing focus
    // (to the page's editor, say), which the window-level listeners above never see.
    let unlisten = null;
    let freed = false;
    if (controls) {
        if (listen) unlisten = listen(canvas, forward, clearKeys);
        else loadPageView().then((m) => { if (!freed) unlisten = m.listen(canvas, forward, clearKeys); }, importFailed);
    }

    function sendPick(entry) {
        pending = { seq: entry.seq, resolve: entry.resolve };
        send({ kind: "view.pick", id, seq: entry.seq, viewport: entry.viewport, x: entry.x, y: entry.y });
    }

    function receive(message) {
        if (message.id !== id) return;
        switch (message.kind) {
            case "view.ready":
                ratio = message.ratio;
                resolveReady({ backend: message.backend, surfaces: message.surfaces, maxDrawingSize: message.maxDrawingSize });
                break;
            case "view.failed":
                rejectReady(new Error(message.message));
                break;
            case "view.resized":
                ratio = message.ratio;
                onResized?.(ratio);
                break;
            case "view.result": {
                const waiting = calls.get(message.seq);
                if (waiting) { calls.delete(message.seq); waiting.resolve(message.value); }
                break;
            }
            case "view.error": {
                // A call's own error rejects that call; any other (the View's onError, a
                // failed input) goes to onError.
                const waiting = message.seq !== undefined ? calls.get(message.seq) : undefined;
                if (waiting) { calls.delete(message.seq); waiting.reject(new Error(message.message)); }
                else onError?.(message.message);
                break;
            }
            case "view.picked":
                if (!pending || message.seq !== pending.seq) {
                    // Not the pick in flight: a tap's pick, answering a view.input.
                    onPick?.(message.hit ?? null);
                } else {
                    pending.resolve(message.hit ?? null);
                    pending = null;
                    if (queued) {
                        const next = queued;
                        queued = null;
                        sendPick(next);
                    }
                }
                break;
            case "view.tapped":
                onTap?.(message.tap, message.viewport, message.double, message.seq);
                break;
            case "view.frame":
                lastFrame = message.viewports;
                onFrame?.(lastFrame);
                break;
            default:
                break;
        }
    }

    return {
        ready,
        checkSize,
        // The host's latest effective ratio (view.ready's, then each view.resized's);
        // `null` before view.ready. `pick`'s x/y are device pixels at this ratio.
        get ratio() { return ratio; },
        get lastFrame() { return lastFrame; },
        view,
        input,
        inputEvent,
        pick(x, y, viewport) {
            return new Promise((resolve) => {
                const entry = { seq: ++seq, x, y, viewport, resolve };
                if (pending) {
                    if (queued) queued.resolve(null);
                    queued = entry;
                } else {
                    sendPick(entry);
                }
            });
        },
        free: () => {
            freed = true;
            unlisten?.();
            unlisten = null;
            resizeObserver?.disconnect();
            clearKeysOnHide?.();
            send({ kind: "view.free", id });
            // Nothing will answer now: every call still out rejects, and the picks resolve
            // null, as a superseded pick does.
            for (const { reject } of calls.values()) reject(new Error("the view was freed"));
            calls.clear();
            pending?.resolve(null);
            queued?.resolve(null);
            pending = null;
            queued = null;
        },
        receive,
    };
}
