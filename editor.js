// The editor: CodeMirror 6 with an OpenSCAD tokenizer, coloured in the site's palette. The
// source of `vendor/editor.js`, which `npm run build` bundles with esbuild (git-ignored);
// the page imports the bundle, the Node test imports this file.
//
// Keys: Ctrl-Enter (Cmd-Enter) or Shift-Enter reads the text now, without waiting for typing to settle;
// Tab indents, Shift-Tab dedents.
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// OpenSCAD, as a stream tokenizer: its keywords, the builtin modules and functions the
// reader knows, numbers, strings and both comment styles. Enough to colour a file; nothing
// here parses it.
const SCAD_KEYWORDS = /^(module|function|if|else|for|let|each|true|false|undef|include|use|intersection_for|assert|echo)\b/;
const SCAD_BUILTINS = /^(cube|sphere|cylinder|polyhedron|square|circle|polygon|text|translate|rotate|scale|mirror|multmatrix|color|offset|hull|minkowski|union|difference|intersection|linear_extrude|rotate_extrude|resize|render|children|group|projection|surface|import|abs|sign|sin|cos|tan|acos|asin|atan|atan2|floor|round|ceil|ln|log|pow|sqrt|exp|rands|min|max|norm|cross|concat|lookup|str|chr|ord|search|version|version_num|len|is_undef|is_list|is_num|is_bool|is_string|is_function|reverse)\b/;
export const openscad = StreamLanguage.define({
    token(stream, state) {
        if (state.block) {
            if (stream.match(/^.*?\*\//)) state.block = false; else stream.skipToEnd();
            return "comment";
        }
        if (stream.eatSpace()) return null;
        if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
        if (stream.match("/*")) { state.block = true; if (stream.match(/^.*?\*\//)) state.block = false; else stream.skipToEnd(); return "comment"; }
        if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
        if (stream.match(/^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|^\.\d+(?:[eE][+-]?\d+)?/)) return "number";
        if (stream.match(SCAD_KEYWORDS)) return "keyword";
        if (stream.match(SCAD_BUILTINS)) return "variableName.function";
        if (stream.match(/^\$[a-zA-Z_]\w*/)) return "variableName.special";
        if (stream.match(/^[a-zA-Z_]\w*/)) return stream.peek() === "(" ? "variableName.function" : "variableName";
        stream.next();
        return null;
    },
    startState: () => ({ block: false }),
    languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } }, closeBrackets: { brackets: ["(", "[", "{", "'", '"'] } },
});

// The colours of the site's code blocks.
const palette = HighlightStyle.define([
    { tag: [t.keyword, t.bool, t.null, t.self, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--blue)" },
    { tag: [t.string, t.special(t.string), t.docString], color: "var(--core)" },
    { tag: t.number, color: "#E8C070" },
    { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: "#9CD3FF" },
    { tag: t.special(t.variableName), color: "#E8C070" },
]);

const theme = EditorView.theme({
    "&": { backgroundColor: "var(--cell)", color: "var(--fg)", fontSize: "14px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55", minHeight: "3em" },
    ".cm-content": { padding: "12px 0", caretColor: "var(--fg)" },
    ".cm-line": { padding: "0 16px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#2D4A66" },
    ".cm-matchingBracket": { backgroundColor: "rgba(55, 138, 221, 0.28)", outline: "1px solid rgba(55, 138, 221, 0.6)" },
    ".cm-nonmatchingBracket": { color: "var(--red)" },
}, { dark: true });

function indentOrSpaces(view) {
    const sel = view.state.selection.main;
    if (!sel.empty) return indentMore(view);
    const width = view.state.facet(indentUnit).length;
    const column = sel.head - view.state.doc.lineAt(sel.head).from;
    view.dispatch(view.state.replaceSelection(" ".repeat(width - (column % width))), { scrollIntoView: true, userEvent: "input" });
    return true;
}

// The editor's extensions, apart from the view: what the Node test builds a state with.
export function extensions({ onRun, onChange } = {}) {
    const indent = "  ";
    const keys = Prec.highest(keymap.of([
        { key: "Mod-Enter", run: () => { onRun?.(); return true; } },
        { key: "Shift-Enter", run: () => { onRun?.(); return true; } },
        { key: "Tab", run: indentOrSpaces, shift: indentLess },
    ]));
    return [
        keys,
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        openscad,
        indentUnit.of(indent),
        EditorState.tabSize.of(indent.length),
        syntaxHighlighting(palette),
        theme,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of({ "aria-label": "OpenSCAD file", spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
        EditorView.updateListener.of((u) => { if (u.docChanged) onChange?.(u.state.doc.toString()); }),
    ];
}

// `onRun()` on Ctrl-Enter; `onChange(text)` on every edit.
export function createEditor({ parent, doc = "", onRun, onChange }) {
    return new EditorView({ parent, state: EditorState.create({ doc, extensions: extensions({ onRun, onChange }) }) });
}
