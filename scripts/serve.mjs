// A static server for the editor, for `npm start`: any other static server that serves .wasm
// as application/wasm does as well (`python -m http.server`, `npx serve`). Nothing is
// cached, so an edit shows on the next reload.
//
//     npm start            # http://localhost:8000/
//     npm start -- 9000    # another port
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] ?? 8000);
const TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm",
    ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".png": "image/png",
};

createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
        if ((await stat(file)).isDirectory()) file = join(file, "index.html");
        const body = await readFile(file);
        res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
        res.end(body);
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain" }).end(`not found: ${path}`);
    }
}).listen(port, () => console.log(`the OpenSCAD editor: http://localhost:${port}/`));
