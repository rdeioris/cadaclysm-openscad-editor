// The editor's OpenSCAD tokenizer (editor.js, the source of vendor/editor.js): what it
// colours a file as -- keywords, builtins, numbers, strings, special variables and both
// comment styles, a block comment carried across lines -- read from the syntax tree a
// CodeMirror state builds with the editor's own extensions.
//
// Run: node test/editor.mjs   (after npm install)
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { extensions } from "../editor.js";

// Each token of `doc` that the tokenizer names, as `[text, style]`.
function tokens(doc) {
    const state = EditorState.create({ doc, extensions: extensions() });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    assert.ok(tree, "the tokenizer finished");
    const out = [];
    tree.iterate({ enter: (node) => { if (node.name !== "Document" && node.from < node.to) out.push([state.sliceDoc(node.from, node.to), node.name]); } });
    return out;
}

const seen = tokens(`$fn = 64; // fine
module boss(r = 2.5e1) { translate([0, 0, 7]) cylinder(r = r, h = 26); }
/* a block
   over two lines */ echo("done");
`);
const style = (text) => seen.find(([t]) => t === text)?.[1];
assert.strictEqual(style("$fn"), "variableName.special");
assert.strictEqual(style("64"), "number");
assert.strictEqual(style("2.5e1"), "number");
assert.strictEqual(style("// fine"), "comment");
assert.strictEqual(style("module"), "keyword");
assert.strictEqual(style("echo"), "keyword");
assert.strictEqual(style("translate"), "variableName.function");
assert.strictEqual(style("cylinder"), "variableName.function");
assert.strictEqual(style("boss"), "variableName.function");
assert.strictEqual(style("r"), "variableName");
assert.strictEqual(style('"done"'), "string");
assert.strictEqual(style("/* a block"), "comment");
assert.strictEqual(style("   over two lines */"), "comment");
console.log(`editor: ok (${seen.length} tokens)`);
