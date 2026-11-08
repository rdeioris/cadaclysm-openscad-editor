// The cadaclysm web package under Node, for the tests: the module from ./pkg (`npm run setup`)
// loaded from its bytes -- Node has no fetch for a file: URL -- as a page loads it through
// pkg/index.js.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as wasm from "../pkg/index.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "pkg");

/** The module's exports, loaded. */
export async function loadPackage() {
    await wasm.load({ wasm: readFileSync(join(pkg, "cadaclysm_bg.wasm")) });
    return wasm;
}
