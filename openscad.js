// The OpenSCAD editor page: the file on the left, its mesh on the right, re-read as you
// type. The text goes to a worker (openscad-worker.js) that runs the reader in the wasm and
// draws it itself, in a wasm View it hosts there (viewer-host.js) on a canvas
// transferred to it -- the bridge's own client (viewer-client.js) carries the view's
// traffic and this page's input to it; the camera is left where it was so an edit does not
// yank the view. Nothing is uploaded.
import { attachViewer } from "./viewer-client.js";
import { activationListen } from "./view-activation.js";
import { createEditor } from "./vendor/editor.js";
import { EXAMPLES } from "./openscad-script.js";

const $ = (id) => document.getElementById(id);
// A keystroke waits this long for the next before the text is read.
const SETTLE_MS = 250;

function supported() {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!(gl && window.Worker && window.WebAssembly && "transferControlToOffscreen" in HTMLCanvasElement.prototype);
}

// ---- the view -----------------------------------------------------------------------------

const view = $("view");
// Replaced by a fresh copy after a crash (`restart`): a canvas hands its drawing to a
// worker once only.
let canvas = view.querySelector("canvas");

// ---- the worker -----------------------------------------------------------------------------

let worker = null, client = null, ready = false, viewFailed = false;
// The text last sent and the last answered, by sequence: one render in flight at a time,
// the newest text waiting behind it (an older one is never sent, a keystroke having
// replaced it), and an answer for a text since replaced is dropped.
let seq = 0, inflight = null, waiting = null;
// Whether the next text sent is a fresh file's -- the first, a new example, an opened file,
// or the one sent again after a restart -- which the worker shows as a quick preview first
// (`render` in openscad-worker.js); set by `reframe`, cleared by the send.
let previewNext = true;
// Set by `restart` just before its `boot()`: the next `ready` re-frames the camera and
// re-sends the current text, rather than waiting on whatever was already queued in `waiting`.
let pendingRestart = false;

async function boot() {
    ready = false;
    viewFailed = false;
    const params = new URLSearchParams(location.search);
    // Awaited before the worker exists, not after: a worker's own early messages (`ready`,
    // or a `view.failed` from a View that fails to create) would otherwise have nowhere
    // to land in the gap between `new Worker` and `worker.onmessage` being set, if that gap
    // held an await. `client` (below) is guarded the same way, in case a message somehow
    // beat it here regardless.
    // A failed import (a missing or stale pkg/) is said on the status line, not left an
    // unhandled rejection: without view.js there is no view, and no worker is made.
    let viewJs;
    try {
        viewJs = await import("./pkg/view.js");
    } catch (e) {
        setStatus(`the view failed to load: ${e?.message ?? e}`, "error");
        return;
    }
    worker = new Worker(new URL("./openscad-worker.js", import.meta.url), { type: "module" });
    const own = worker;
    worker.onmessage = ({ data }) => {
        // A message the old worker queued before a restart terminated it (a second
        // "crashed", a late render) is not this page's any more.
        if (worker !== own) return;
        if (data.kind === "ready") {
            ready = true;
            $("versions").textContent = `cadaclysm ${data.version}`;
            setStatus("ready", "ready");
            if (pendingRestart) {
                pendingRestart = false;
                reframe();
                waiting = editor.state.doc.toString();
            }
            flush();
            return;
        }
        if (data.kind === "crashed") { restart(data.message); return; }
        if (typeof data.kind === "string" && data.kind.startsWith("view.")) { client?.receive(data); return; }
        if (data.seq !== inflight) return;   // stale: a newer text is on its way
        if (data.kind === "preview") {
            // The quick meshes are up; the exact read is still running, so the render is
            // still in flight.
            if (!viewFailed) {
                // Short: a longer line than the final one pushes the toolbar down a row.
                setStatus(`preview · refining…`, "");
            }
            $("problem").textContent = "";
            return;
        }
        inflight = null;
        if (data.ok) {
            // Not over a failed view: client.ready's own rejection already said so, and
            // that stays the status line's last word rather than a triangle count that
            // will never draw.
            if (!viewFailed) {
                setStatus(`${data.triangles.toLocaleString()} triangles · ${data.ms} ms`, "ready");
            }
            $("problem").textContent = "";
        } else {
            // The reader's own words, with the line, under the text; the view keeps the
            // last file that read.
            setStatus("not read", "error");
            $("problem").textContent = data.error;
        }
        flush();
    };
    worker.onerror = (e) => setStatus(`the reader failed to load: ${e.message}`, "error");
    client = attachViewer({
        canvas, worker, id: 1, controls: true,
        listen: activationListen({ view, baseListen: viewJs.listen }),
        surfaces: params.get("surfaces") ?? undefined,
        backend: params.get("backend") ?? undefined,
        onError: (m) => setStatus(m, "error"),
    });
    const mine = client;
    client.ready.catch((e) => {
        if (client !== mine) return;   // a view since replaced by a restart
        viewFailed = true;
        setStatus(`the view failed: ${e.message}`, "error");
    });
    // A double click frames what it hit, as it did before the View made that opt-in (through the
    // bridge's view.call, queued until the worker's View exists).
    client.view.setDoubleClickFrames(true);
}

// The wasm trapped: the worker is gone for good, and the view's canvas with it -- a canvas
// hands its drawing to a worker once only. The client lets go (its input listeners, its size
// watch), a fresh copy of the canvas takes the old one's place, and a new worker boots with a
// new client on it; the current text is sent again once it is ready, and the camera reframed
// on it (`pendingRestart`, read by `boot`'s "ready" handler above).
function restart(message) {
    setStatus(`the reader crashed: ${message} -- restarting`, "error");
    client?.free();
    client = null;
    worker.terminate();
    worker = null;
    ready = false;
    inflight = null;
    const fresh = canvas.cloneNode(false);
    canvas.replaceWith(fresh);
    canvas = fresh;
    pendingRestart = true;
    boot();
}

// Send the waiting text, if the worker is free.
function flush() {
    if (!ready || inflight !== null || waiting === null) return;
    inflight = ++seq;
    worker.postMessage({ kind: "render", seq: inflight, text: waiting, preview: previewNext });
    previewNext = false;
    waiting = null;
    setStatus("reading…", "");
}

let settle = 0;
function schedule(text) {
    waiting = text;
    clearTimeout(settle);
    settle = setTimeout(flush, SETTLE_MS);
}

function setStatus(text, cls) {
    $("status-text").textContent = text;
    $("status").className = cls;
}

// ---- the editor and the toolbar ---------------------------------------------------------

let editor = null;
let loaded = null;   // the example the text was loaded from

function setText(text) {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
}

// A new file resets the camera's framing: the worker always re-frames its next scene. And it
// is previewed first.
function reframe() {
    previewNext = true;
    worker?.postMessage({ kind: "reframe" });
}

function loadExample(id) {
    const example = EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
    const pristine = !loaded || editor.state.doc.toString() === loaded.source;
    if (!pristine && !confirm("Replace the file with this example? The edits here will be lost.")) return false;
    loaded = example;
    setText(example.source);
    $("example").value = example.id;
    const url = new URL(location.href);
    if (example === EXAMPLES[0]) url.searchParams.delete("example"); else url.searchParams.set("example", example.id);
    history.replaceState(null, "", url);
    reframe();
    return true;
}

async function openFile(file) {
    const text = await file.text();
    loaded = null;
    setText(text);
    $("example").value = "";
    reframe();
}

function download() {
    const name = loaded ? `${loaded.id}.scad` : "model.scad";
    const url = URL.createObjectURL(new Blob([editor.state.doc.toString()], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- go ---------------------------------------------------------------------------------

if (!supported()) {
    $("unsupported").style.display = "block";
    setStatus("unsupported browser", "error");
    for (const id of ["example", "open", "download"]) $(id).disabled = true;
} else {
    for (const e of EXAMPLES) {
        const o = document.createElement("option");
        o.value = e.id;
        o.textContent = e.title;
        o.title = e.blurb;
        $("example").appendChild(o);
    }
    editor = createEditor({
        parent: $("code"),
        doc: "",
        onRun: () => { waiting = editor.state.doc.toString(); flush(); },
        onChange: schedule,
    });
    $("example").addEventListener("change", () => { if (!loadExample($("example").value)) $("example").value = loaded?.id ?? ""; });
    $("open").addEventListener("click", () => $("file").click());
    $("file").addEventListener("change", () => {
        const [file] = $("file").files;
        $("file").value = "";
        if (file) openFile(file);
    });
    $("download").addEventListener("click", download);
    const first = EXAMPLES.find((e) => e.id === new URLSearchParams(location.search).get("example")) ?? EXAMPLES[0];
    loaded = first;
    setText(first.source);
    $("example").value = first.id;
    setStatus("loading…", "");
    boot();
}
