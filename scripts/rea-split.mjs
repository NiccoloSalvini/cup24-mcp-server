/**
 * Prepares cup24.it's JavaScript bundle for REA (reverse-engineer-anything).
 *
 * REA runs out of memory on the whole 1.2 MB minified webpack bundle: its semantic phase keeps >8 GB live.
 * Split into webpack modules, and the entry block into ~25 KB chunks, every part fits; vendor libraries
 * (jQuery, Leaflet, select2, intl-tel-input...) go to vendor/ so REA analyzes only cup24's own code in app/.
 *
 * Usage: node scripts/rea-split.mjs <bundle path or URL> <output dir> [chunk KB, default 25]
 * Then:  rea analyze-javascript-application <output dir>/app
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";

const [input, outDir, chunkKb = "25"] = process.argv.slice(2);
if (!input || !outDir) {
  console.error("Usage: node scripts/rea-split.mjs <bundle path or URL> <output dir> [chunk KB]");
  process.exit(1);
}
const src = input.startsWith("https://") ? await (await fetch(input)).text() : readFileSync(input, "utf8");

// webpack 5 layout: (()=>{ var modules = {id: factory, ...}; function require(id){...}; (entry)... })()
const iife = parse(src, { sourceType: "script" }).program.body[0]?.expression;
const body = iife?.callee?.body?.body;
if (!body) throw new Error("Not a webpack 5 bundle: the site's build may have changed.");
const text = node => src.slice(node.start, node.end);
const isApp = code => /Pi\.settings|CUP24_|cup24|\/messages\/|\/cart\//.test(code);

for (const dir of ["app", "vendor"]) mkdirSync(join(outDir, dir), { recursive: true });
const written = { app: 0, vendor: 0 };
const write = (dir, name, code) => {
  writeFileSync(join(outDir, dir, name), code);
  written[dir]++;
};

for (const stmt of body) {
  const modules = stmt.type === "VariableDeclaration" &&
    stmt.declarations.find(d => d.init?.type === "ObjectExpression" && d.init.properties.length > 5);
  if (modules) {
    for (const p of modules.init.properties) {
      const code = text(p.value);
      write(isApp(code) ? "app" : "vendor", `module-${p.key.value ?? p.key.name}.js`, `(${code});\n`);
    }
    continue;
  }
  if (stmt.type !== "ExpressionStatement") continue; // the require() runtime
  // The entry is a sequence whose largest part is an IIFE of webpack-concatenated modules sharing one scope
  const parts = stmt.expression.type === "SequenceExpression" ? stmt.expression.expressions : [stmt.expression];
  const entry = parts.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const chunks = [[]];
  let size = 0;
  for (const s of entry.callee?.body?.body ?? [entry]) {
    if (size > 0 && size + (s.end - s.start) > Number(chunkKb) * 1024) {
      chunks.push([]);
      size = 0;
    }
    chunks.at(-1).push(text(s));
    size += s.end - s.start;
  }
  // shortcut: names shared across chunks become free variables, so REA links calls only within a chunk
  chunks.forEach((c, i) => write("app", `entry-${String(i + 1).padStart(2, "0")}.js`, `(()=>{"use strict";\n${c.join("\n")}\n})();\n`));
}
console.log(`app/: ${written.app} files, vendor/: ${written.vendor} files in ${outDir}`);
