// The OpenSCAD editor's Export menu, the part that runs in the worker: the text read again
// by the kernel as solids (`cadaclysm_blacksmith_open_file`), coloured as the view draws
// them, and written as one file. A kernel package only -- a reader build has no solids to
// write. Imported by openscad-worker.js and test/openscad.mjs.
//
// The kernel's `open_file` hands out each exact solid of the program, in the order the
// reader's scene lists its exact nodes (generator "brep"; a `%` background node is drawn as
// a mesh and is neither in the file nor among the solids), but without their colours: those
// are put back from the scene (`exactColours`) before the file is written. Where the two
// counts differ the colours are left off rather than put on the wrong solids.

// The menu's formats: the file's extension, its type, and how it is written.
export const FORMATS = {
    step: { label: "STEP", ext: "step", type: "model/step" },
    brep: { label: "BREP", ext: "brep", type: "text/plain" },
    stl: { label: "STL", ext: "stl", type: "model/stl" },
    glb: { label: "glTF", ext: "glb", type: "model/gltf-binary" },
};

// The kernel's NONE: `coloured` with it colours the whole solid, not one face.
const NONE = 0xFFFFFFFF;
// OpenSCAD has no unit; its lengths are millimetres by convention, as the reader reads them.
const MILLIMETRE = 1;
const NO_SOLID = "the program makes no solid to export";

// Each exact node's colour in `scene` (a reader `Scene`), in order: [r, g, b] in 0..1, or null
// for a node the program left uncoloured.
export function exactColours(scene) {
    return JSON.parse(scene.treeJson()).filter((n) => n.generator === "brep").map((n) => n.colour ?? null);
}

// `text` (an OpenSCAD program) as a file of `format` (a key of FORMATS): its bytes. `colours`
// as `exactColours` gives them, or null for none. Throws the kernel's own words where the
// program does not read or the file cannot be written. `kernel` is the wasm module.
export function exportFile(kernel, text, format, colours) {
    if (!FORMATS[format]) throw new Error(`no export to ${format}`);
    let solids;
    try {
        solids = [...kernel.cadaclysm_blacksmith_open_file(new TextEncoder().encode(text), "scad")];
    } catch (error) {
        // The kernel's own words list every format a solid can come from: here, the program.
        if (/draws no B-rep body/.test(String(error?.message ?? error))) throw new Error(NO_SOLID);
        throw error;
    }
    try {
        if (solids.length === 0) throw new Error(NO_SOLID);
        if (colours && colours.length === solids.length) {
            const plain = solids;
            const coloured = plain.map((solid, i) => (colours[i] ? kernel.cadaclysm_blacksmith_coloured(solid, NONE, ...colours[i]) : solid));
            for (let i = 0; i < plain.length; i++) if (coloured[i] !== plain[i]) kernel.cadaclysm_blacksmith_solid_free(plain[i]);
            solids = coloured;
        }
        const handles = Uint32Array.from(solids);
        switch (format) {
            case "step": return new TextEncoder().encode(kernel.cadaclysm_blacksmith_step(handles, null, MILLIMETRE));
            case "brep": return new TextEncoder().encode(kernel.cadaclysm_blacksmith_brep_text(handles));
            default: return kernel.cadaclysm_blacksmith_mesh_file(handles, format, null, null, 0);
        }
    } finally {
        for (const solid of solids) kernel.cadaclysm_blacksmith_solid_free(solid);
    }
}
