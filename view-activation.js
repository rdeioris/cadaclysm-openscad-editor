// A view's "tap to turn it on". Not its own listener
// set on the canvas: a FILTER wrapped around view.js's own `listen` (the package's
// pkg/view.js), so pointercancel/lostpointercapture, keyup, pointer capture and bound-key
// preventDefault all still come from there -- this module only decides which normalised
// events reach the handler, and when the view turns on or off.
//
// `activationListen({ view, scope = document, baseListen })` returns a function with
// view.js `listen`'s own signature, `(canvas, sink, onRelease) -> unlisten`, so a page
// passes it straight to `attachViewer`'s `listen` option:
//
//   attachViewer({ canvas, worker, id, controls: true,
//                  listen: activationListen({ view, baseListen: viewJs.listen }) })
//
// (viewer-client.js, with `controls: true` and a `listen` option, calls
// `listen(canvas, forward)` itself.) `view` is the element that holds `canvas` and takes
// the `.active` class (the blue border and `touch-action: none` come from the page's CSS
// while active; this module sets `touch-action` on the canvas itself -- see below).
//
// The filter, over `baseListen`'s normalised events ({kind, pointerId, pointer, x, y,
// time, ...} -- pkg/view.js's `normalise`; `x`/`y` are device pixels, the
// canvas's own backing-store units):
//   - "wheel", "key" and any event with `pointer: "mouse"` always reach the handler.
//   - touch and pen: while the view is inactive, a "down" records the landing (device px
//     and the event's own timestamp) and is held back; the matching "up" activates the
//     view when it lands within tap tolerance (TAP_PX, scaled from CSS to device pixels
//     by devicePixelRatio, since these positions are device px and the gesture crate's
//     `TAP_PX` (cadaclysm_view::input) is a CSS-pixel constant; TAP_MS, plain ms) and is
//     held back either way; "cancel" clears the landing. Once a "down" DOES reach the
//     handler (the view was already active), that pointerId is remembered, and every
//     later "move"/"up"/"cancel" for it reaches
//     the handler too even if the view is deactivated meanwhile (an outside tap mid-drag),
//     so the handler never sees an unmatched "down" -- forgotten again on "up"/"cancel".
//
// Activation is `.active` on `view`, one view active at a time page-wide (a module-level
// `current`): a capture-phase `pointerdown` on `scope` outside the view deactivates it.
// `contextmenu` is already prevented by `baseListen` (view.js's `listen`).
//
// touch-action: view.js's `listen` sets it to "none" only when empty, which would leave
// an inactive view's canvas stopping the page's own scroll/pinch over it. This module sets
// `canvas.style.touchAction` itself, before calling `baseListen` and again on every
// activation change: "none" while active (the drag is the view's now), "pan-x pan-y
// pinch-zoom" while inactive (so the page scrolls normally; a touch that turns into a page
// scroll then gets a pointercancel from the browser, which clears the landing above).

export const TAP_PX = 10;
export const TAP_MS = 500;

function devicePixelTapPx() {
    return TAP_PX * (globalThis.devicePixelRatio || 1);
}

// One active view page-wide: `current` is the active instance's own `{ view, deactivate }`
// so activating another view can turn the first fully off (class and touch-action both),
// without this module reaching into a canvas it does not otherwise hold onto.
let current = null;

export function activationListen({ view, scope = document, baseListen }) {
    return function listen(canvas, sink, onRelease) {
        function isActive() {
            return view.classList.contains("active");
        }
        function syncTouchAction() {
            canvas.style.touchAction = isActive() ? "none" : "pan-x pan-y pinch-zoom";
        }
        function activate() {
            if (current && current.view !== view) current.deactivate();
            current = { view, deactivate };
            view.classList.add("active");
            syncTouchAction();
        }
        function deactivate() {
            view.classList.remove("active");
            syncTouchAction();
            if (current && current.view === view) current = null;
        }

        syncTouchAction(); // before baseListen, so its own "set only if empty" never fires

        const landed = new Map();     // pointerId -> { x, y, t }: a touch/pen not yet forwarded
        const forwarding = new Set(); // pointerId whose "down" reached the handler

        function filtered(e) {
            if (e.kind === "wheel" || e.kind === "key" || e.pointer === "mouse") {
                sink(e);
                return;
            }
            switch (e.kind) {
                case "down":
                    if (isActive()) {
                        forwarding.add(e.pointerId);
                        sink(e);
                    } else {
                        landed.set(e.pointerId, { x: e.x, y: e.y, t: e.time });
                    }
                    return;
                case "move":
                    if (forwarding.has(e.pointerId)) sink(e);
                    return;
                case "up": {
                    if (forwarding.has(e.pointerId)) {
                        forwarding.delete(e.pointerId);
                        sink(e);
                        return;
                    }
                    const at = landed.get(e.pointerId);
                    landed.delete(e.pointerId);
                    if (at && Math.hypot(e.x - at.x, e.y - at.y) <= devicePixelTapPx() && e.time - at.t <= TAP_MS) activate();
                    return;
                }
                case "cancel":
                    if (forwarding.has(e.pointerId)) {
                        forwarding.delete(e.pointerId);
                        sink(e);
                    } else {
                        landed.delete(e.pointerId);
                    }
                    return;
                default:
                    return;
            }
        }

        const unlistenBase = baseListen(canvas, filtered, onRelease);

        const onScopePointerDown = (e) => {
            if (isActive() && !view.contains(e.target)) deactivate();
        };
        scope.addEventListener("pointerdown", onScopePointerDown, true);

        return () => {
            unlistenBase();
            scope.removeEventListener("pointerdown", onScopePointerDown, true);
            // A view detached while active is no longer the page's active one: drop the
            // module's reference (not deactivate(), whose class and style writes may land on
            // a canvas already gone), so it is neither kept alive nor "deactivated" later.
            if (current && current.view === view) current = null;
        };
    };
}
