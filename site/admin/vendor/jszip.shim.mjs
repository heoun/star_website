// docx-preview's ES module build imports jszip by bare name, and jszip ships
// UMD only — no ES module build, so a browser has nothing to resolve that name
// to. The import map in the admin page points "jszip" here instead.
//
// Loading the UMD file as a module still works: its wrapper checks for `window`
// before `this`, so under ESM strict mode it takes the global branch and
// assigns globalThis.JSZip, which is what this re-exports.
//
// Keeping the shim separate leaves the two vendored files byte-identical to
// what npm publishes, so upgrading is a straight copy and the licenses beside
// them still describe exactly what is here.
import "./jszip.min.js";

export default globalThis.JSZip;
