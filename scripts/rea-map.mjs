/**
 * Maps cup24.it's UI events to the HTTP endpoints they reach, from REA evidence.
 *
 * REA records listeners, functions and call sites but does not link a listener to its handler, nor
 * `Pi.method()` calls to their definitions, and its string seeds do not match literals. This script runs
 * REA once per file (one run for all files exceeds REA's per-run result budget) and joins its nodes:
 * listener -> handler function -> call sites -> endpoints, following Pi.* calls across files.
 *
 * Usage: node scripts/rea-map.mjs <app dir from rea-split.mjs> [--find <text>]
 * Writes <app dir>/rea-map.json; REA evidence is cached as <file>.rea.json.
 */
import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [appDir, flag, needle] = process.argv.slice(2);
if (!appDir || (flag && (flag !== "--find" || !needle))) {
  console.error("Usage: node scripts/rea-map.mjs <app dir> [--find <text>]");
  process.exit(1);
}

const graphs = readdirSync(appDir).filter(f => f.endsWith(".js")).sort().map(file => {
  const cache = join(appDir, `${file}.rea.json`);
  if (!existsSync(cache)) {
    const dir = mkdtempSync(join(tmpdir(), "rea-"));
    copyFileSync(join(appDir, file), join(dir, file));
    const fd = openSync(cache, "w");
    try {
      execFileSync("npx", ["-y", "rea-agents@6.4.0", "analyze-javascript-application", dir, "--max-heap-mb", "4096", "--format", "json", "--full-output"], { stdio: ["ignore", fd, "pipe"], maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      rmSync(cache);
      console.error(String(error.stderr ?? "").split("\n").slice(-5).join("\n")); // REA's own diagnosis
      throw error;
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true });
    }
  }
  const evidence = JSON.parse(readFileSync(cache, "utf8"));
  const src = readFileSync(join(appDir, file), "utf8");
  const lineStarts = [0, ...[...src.matchAll(/\n/g)].map(m => m.index + 1)];
  const at = p => lineStarts[p.line - 1] + p.column; // REA lines are 1-based, columns 0-based
  const span = n => n.identity?.source_range && [at(n.identity.source_range.start), at(n.identity.source_range.end)];
  const nodes = (evidence.data ?? evidence).normalized_result.semantic_graph?.nodes ?? [];
  const ofKind = kind => nodes.filter(n => n.kind === kind && span(n)).map(n => ({ node: n, r: span(n) }));
  return { file, src, listeners: ofKind("listener"), functions: ofKind("function"), calls: ofKind("call-site") };
});

// Pi.settings endpoints and named functions (object methods like `makeRefund:function`) across all files
const settings = Object.fromEntries(graphs.flatMap(g => [...g.src.matchAll(/(endpoint\w+):"([^"]*)"/g)].map(m => [m[1], m[2]])));
const methods = new Map();
for (const g of graphs) {
  for (const f of g.functions) {
    const name = g.src.slice(Math.max(0, f.r[0] - 60), f.r[0]).match(/(\w+)\s*[:=]\s*$/)?.[1];
    if (name) methods.set(name, [...(methods.get(name) ?? []), { ...f, g, name }]);
  }
}

// Leading string literals of a URL expression, with Pi.settings resolved; anything dynamic stays visible
function url(expr) {
  const e = expr.trim().replace(/Pi\.settings\.(endpoint\w+)/g, (m, k) => (k in settings ? JSON.stringify(settings[k]) : m));
  if (/^\{[^}]*\}\[\w+\]$/.test(e)) return [...e.matchAll(/:"([^"]*)"/g)].map(m => m[1]).join(" | "); // {a:"/x",b:"/y"}[key]
  const lead = e.match(/^"[^"]*"(?:\s*\+\s*"[^"]*")*/)?.[0];
  if (!lead) return `<${e.slice(0, 40)}>`;
  return [...lead.matchAll(/"([^"]*)"/g)].map(m => m[1]).join("") + (lead.length < e.length ? "…" : "");
}

function endpoints(text) {
  let m;
  if ((m = text.match(/^[\w$.]+\.ajax\(\{([\s\S]*)/))) {
    const method = m[1].match(/(?:method|type):\s*"(\w+)"/)?.[1].toUpperCase() ?? "GET";
    const target = m[1].match(/url:\s*((?:"[^"]*"|\{[^}]*\}\[\w+\]|[^,}])+)/)?.[1];
    return target ? [`${method} ${url(target)}`] : [];
  }
  if ((m = text.match(/^fetch\(((?:"[^"]*"|[^,)])+)/))) return [`GET ${url(m[1])}`];
  if ((m = text.match(/^[\w$]+\.open\("(\w+)",\s*((?:"[^"]*"|[^,)])+)/))) return [`${m[1]} ${url(m[2])}`];
  // The site's modals load their HTML from Pi.settings.endpointModalMessage + name
  if ((m = text.match(/^[\w$]+\.popup\([^,]*,[^,]*,\s*"([\w-]+)"/))) return [`POST ${settings.endpointModalMessage ?? "/messages/"}${m[1]}`];
  return [];
}

function reach(fn, seen = new Set()) {
  if (seen.has(fn.node.node_id)) return [];
  seen.add(fn.node.node_id);
  return fn.g.calls.filter(c => c.r[0] >= fn.r[0] && c.r[1] <= fn.r[1]).flatMap(c => {
    const text = fn.g.src.slice(...c.r);
    const pi = text.match(/^Pi\.(\w+)\(/)?.[1];
    // Minified helpers like mi(...) share the entry scope across chunks; follow them only when the name is unique
    const bare = text.match(/^([A-Za-z_$][\w$]*)\(/)?.[1];
    const targets = pi ? methods.get(pi) ?? [] : bare && methods.get(bare)?.length === 1 ? methods.get(bare) : [];
    const via = targets.flatMap(m => reach(m, seen).map(x => ({ ...x, via: [pi ? `Pi.${pi}` : bare, ...x.via] })));
    return [...endpoints(text).map(endpoint => ({ endpoint, via: [] })), ...via];
  });
}

const unique = list => [...new Map(list.map(x => [`${x.endpoint} ${x.via.join(">")}`, x])).values()];
const map = graphs.flatMap(g => g.listeners.map(l => {
  // REA's listener range covers the selector argument, or the handler itself when there is no selector
  const handler = g.functions
    .filter(f => f.r[0] === l.r[0] || (f.r[0] >= l.r[1] && /^\s*,\s*\(?\s*$/.test(g.src.slice(l.r[1], f.r[0]))))
    .sort((a, b) => a.r[0] - b.r[0])[0];
  const noSelector = handler?.r[0] === l.r[0];
  return {
    event: l.node.properties.event_name,
    selector: noSelector ? null : g.src.slice(...l.r),
    ...(noSelector ? { registered_by: g.src.slice(Math.max(0, l.r[0] - 50), l.r[0]).trim() } : {}),
    file: g.file,
    listener: l.node.node_id,
    handler: handler ? { node: handler.node.node_id, range: handler.r } : null,
    endpoints: handler ? unique(reach({ ...handler, g })) : []
  };
}));
const functions = [...methods.values()].flat().map(m => ({ name: m.name, file: m.g.file, node: m.node.node_id, endpoints: unique(reach(m)) }))
  .filter(f => f.endpoints.length);
if (!map.some(l => l.endpoints.length)) {
  console.error("No listener reaches an endpoint: the site's code or REA's output format has changed.");
  process.exit(1);
}
writeFileSync(join(appDir, "rea-map.json"), JSON.stringify({ listeners: map, functions }, null, 2));

const show = e => `${e.endpoint}${e.via.length ? ` (via ${e.via.join(" > ")})` : ""}`;
const hit = e => !needle || e.endpoint.includes(needle);
for (const l of map) {
  const eps = l.endpoints.filter(hit);
  if (eps.length) console.log(`${l.event} ${l.selector ?? `(handler after …${l.registered_by.slice(-30)})`} [${l.file}]\n  ${eps.map(show).join("\n  ")}`);
}
if (needle) for (const f of functions.filter(f => f.endpoints.some(hit))) console.log(`${f.name} [${f.file}]\n  ${f.endpoints.filter(hit).map(show).join("\n  ")}`);
console.error(`${map.length} listeners, ${map.filter(l => l.endpoints.length).length} reach an endpoint; map in ${join(appDir, "rea-map.json")}`);
