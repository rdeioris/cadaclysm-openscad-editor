// Puts the cadaclysm web package's pkg/ folder -- the WebAssembly module (the readers and the
// View), its loader and the page modules that go with the View -- here, as ./pkg. Not committed: it is the
// closed-source part, fetched from the SDK's releases.
//
//     npm run setup                          # the release pinned below, from GitHub
//     npm run setup -- --zip <package.zip>   # a package zip you already have
//     npm run setup -- --pkg <folder>        # a pkg/ folder (a local build of the package)
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

// The reader package: the readers and the View, no kernel (the editor only reads). The View
// class and its page modules are in the web package from 0.14 on.
const VERSION = "0.14.0";
const ASSET = `cadaclysm-${VERSION}-web-reader.zip`;
const URL = `https://github.com/rdeioris/cadaclysm-sdk/releases/download/v${VERSION}/${ASSET}`;
// What the editor loads from the package: the module, and the page modules beside view.js
// (the View's host in the worker, its client on the page, tap-to-activate, the canvas size).
const NEEDED = ["cadaclysm.js", "cadaclysm_bg.wasm", "index.js", "view.js", "viewer-host.js", "viewer-client.js", "view-activation.js", "view-canvas.js"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "pkg");
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

// The zip's pkg/ folder (`cadaclysm-<version>-web/pkg/...`): its files by their path in it.
function pkgOfZip(bytes) {
    const found = new Map();
    for (const [name, data] of Object.entries(unzipSync(new Uint8Array(bytes)))) {
        const m = /^[^/]+\/pkg\/(.+[^/])$/.exec(name);
        if (m) found.set(m[1], data);
    }
    return found;
}

// A folder's files by their path in it.
function filesOf(folder, at = folder, found = new Map()) {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) filesOf(folder, path, found);
        else found.set(relative(folder, path).replace(/\\/g, "/"), readFileSync(path));
    }
    return found;
}

async function main() {
    let files, from;
    const folder = option("--pkg"), zip = option("--zip");
    if (folder) {
        files = filesOf(folder);
        from = folder;
    } else {
        let bytes;
        if (zip) bytes = readFileSync(zip);
        else {
            console.log(`fetching ${URL}`);
            const response = await fetch(URL);
            if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${URL}`);
            bytes = await response.arrayBuffer();
        }
        files = pkgOfZip(bytes);
        from = zip ?? ASSET;
    }
    const missing = NEEDED.filter((f) => !files.has(f));
    if (missing.length) throw new Error(`${from} has no ${missing.join(", ")}: the editor needs the web package's pkg/ (the reader and the View)`);
    // Written beside, then swapped in: a failed setup leaves the pkg/ there was.
    const next = `${out}.next`;
    rmSync(next, { recursive: true, force: true });
    for (const [name, data] of files) {
        mkdirSync(dirname(join(next, name)), { recursive: true });
        writeFileSync(join(next, name), data);
    }
    rmSync(out, { recursive: true, force: true });
    renameSync(next, out);
    console.log(`pkg/ from ${from}: ${(statSync(join(out, "cadaclysm_bg.wasm")).size / 1048576).toFixed(2)} MB of wasm`);
}

main().catch((e) => {
    console.error(`setup: ${e.message}`);
    if (!option("--pkg") && !option("--zip")) console.error("(a package you already have: npm run setup -- --zip <package.zip>, or -- --pkg <folder>)");
    process.exit(1);
});
