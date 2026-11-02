/**
 * Live self-check: starts the built server over stdio and calls every tool against the real cup24.it.
 * Run with: npm run build && npm run smoke
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Slot alerts go to a throwaway file, never to the user's own watches
const watchDir = mkdtempSync(join(tmpdir(), "cup24-smoke-"));
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...getDefaultEnvironment(), CUP24_WATCH_FILE: join(watchDir, "watches.json") }
}));

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, `${name} failed: ${JSON.stringify(res.content)}`);
  return res.structuredContent as any;
};
const fails = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  assert.equal(res.isError, true, `${name} should fail for ${JSON.stringify(args)}`);
};
const log = (label: string, r: any) =>
  console.error(`${label}: ${r.count} slots, first ${r.slots[0].date} ${r.slots[0].price_eur}€ at ${r.slots[0].clinic}`);

const { tools } = await client.listTools();
assert.deepEqual(tools.map(t => t.name).sort(), [
  "cup24_get_availability", "cup24_get_service_info", "cup24_get_slot_times", "cup24_search", "cup24_search_cities",
  "cup24_watch_add", "cup24_watch_check", "cup24_watch_list", "cup24_watch_remove"
]);

const { cities } = await call("cup24_search_cities", { query: "firenze" });
assert.ok(cities.some((c: any) => c.slug === "firenze"));

const eco = (await call("cup24_search", { query: "ecografia addome completo" })).services[0];
const byPrice = await call("cup24_get_availability", { service_ids: [eco.id], city: "firenze", sort: "price" });
assert.ok(byPrice.slots.every((s: any) => s.price_eur > 0 && s.slot_id), "every slot has a price and a slot_id");
log("Ecografia, by price", byPrice);

const { days } = await call("cup24_get_slot_times", { slot_id: byPrice.slots[0].slot_id, days: 2 });
assert.ok(days.length >= 1 && days[0].times.length >= 1, "the slot has bookable times");
console.error(`Times at ${days[0].clinic}: ${days.map((d: any) => `${d.date} ${d.times.slice(0, 3).join(" ")}`).join(" | ")}`);

const info = await call("cup24_get_service_info", { service_id: eco.id });
assert.ok(info.faq.length > 0 && info.prices_by_city.length > 0);

const labs = (await call("cup24_search", { query: "emocromo" })).services;
const emocromo = labs.find((s: any) => s.combinable && !s.package);
const glicemia = (await call("cup24_search", { query: "glicemia" })).services.find((s: any) => s.combinable && !s.package);
log("Emocromo + glicemia", await call("cup24_get_availability", { service_ids: [emocromo.id, glicemia.id], city: "firenze" }));

const pkg = (await call("cup24_search", { query: "check-up" })).services.find((s: any) => s.package);
log(pkg.name, await call("cup24_get_availability", { service_ids: [pkg.id], city: "firenze" }));
assert.ok((await call("cup24_get_service_info", { service_id: pkg.id })).includes.length > 0, "a package lists its tests");

log("Clinic", await call("cup24_get_availability", { clinic_id: byPrice.slots[0].clinic_id }));
const doctor = (await call("cup24_search", { query: "rossi" })).doctors[0];
await call("cup24_get_availability", { doctor_id: doctor.id });

// Invalid input must come back as a tool error the model can read
await fails("cup24_get_availability", { service_ids: ["../etc"], city: "firenze" });
await fails("cup24_get_availability", { service_ids: [eco.id], city: "nonesiste" });
await fails("cup24_get_availability", { service_ids: [eco.id] });
await fails("cup24_get_slot_times", { slot_id: "000000000000000000000000" });

// Slot alert lifecycle: create (with an immediate check), recheck, list, remove
const alert = await call("cup24_watch_add", { service_ids: [eco.id], city: "firenze", max_price: 80 });
console.error(`Alert ${alert.watch.label}: ${alert.available_now.length} matching clinic-days now`);
const recheck = await call("cup24_watch_check", {});
assert.ok(Array.isArray(recheck.results[0].new_slots), "a check returns the new slots of each alert");
assert.equal((await call("cup24_watch_list", {})).watches.length, 1);
await call("cup24_watch_remove", { id: alert.watch.id });
assert.equal((await call("cup24_watch_list", {})).watches.length, 0);
await fails("cup24_watch_add", { service_ids: [eco.id], city: "firenze" }); // no criteria

await client.close();
rmSync(watchDir, { recursive: true });
console.error("Smoke test passed");
