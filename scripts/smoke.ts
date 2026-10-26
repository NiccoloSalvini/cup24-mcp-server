/**
 * Live self-check: starts the built server over stdio and calls every tool against the real cup24.it.
 * Run with: npm run build && npm run smoke
 */
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, `${name} failed: ${JSON.stringify(res.content)}`);
  return res.structuredContent as any;
};

const { tools } = await client.listTools();
assert.deepEqual(tools.map(t => t.name).sort(), ["cup24_get_availability", "cup24_search_cities", "cup24_search_services"]);

const { services } = await call("cup24_search_services", { query: "ecografia addome completo" });
const { cities } = await call("cup24_search_cities", { query: "firenze" });
assert.ok(services.length > 0 && cities.some((c: any) => c.slug === "firenze"));

const byPrice = await call("cup24_get_availability", { service_id: services[0].id, city: "firenze", sort: "price" });
assert.ok(byPrice.slots.length > 0, "Florence should have availability for the first match");
const prices = byPrice.slots.map((s: any) => s.price_eur);
assert.ok(prices.every((p: number) => p > 0), "every slot has a price");
console.error(`${byPrice.service}: ${byPrice.count} slots, cheapest ${prices[0]}€ at ${byPrice.slots[0].clinic}`);

// Invalid input must come back as a tool error the model can read
const bad = await client.callTool({ name: "cup24_get_availability", arguments: { service_id: "../etc", city: "firenze" } });
assert.equal(bad.isError, true);
const missing = await client.callTool({ name: "cup24_get_availability", arguments: { service_id: "57d1785cdb86a", city: "nonesiste" } });
assert.equal(missing.isError, true);

await client.close();
console.error("Smoke test passed");
