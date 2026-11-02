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
const fails = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  assert.equal(res.isError, true, `${name} should fail for ${JSON.stringify(args)}`);
};
const log = (label: string, r: any) =>
  console.error(`${label}: ${r.count} slots, first ${r.slots[0].date} ${r.slots[0].price_eur}€ at ${r.slots[0].clinic}`);

const { tools } = await client.listTools();
assert.deepEqual(tools.map(t => t.name).sort(), [
  "cup24_get_availability", "cup24_get_service_info", "cup24_get_slot_times", "cup24_plan_visits", "cup24_search", "cup24_search_cities"
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

// A thyroid prescription: two services plus three lab tests drawn together
const ecoTiroide = (await call("cup24_search", { query: "ecografia tiroidea" })).services[0];
const endo = (await call("cup24_search", { query: "visita endocrinologica" })).services[0];
const tsh = (await call("cup24_search", { query: "tsh" })).services.find((s: any) => s.combinable && !s.package);
const plan = await call("cup24_plan_visits", { service_ids: [ecoTiroide.id, endo.id], lab_ids: [tsh.id, emocromo.id], city: "firenze" });
assert.ok(plan.plans.length > 0 && plan.plans[0].visits.length === 3, "a plan covers every prescription item");
for (const p of plan.plans) console.error(`Plan ${p.plan}: ${p.total_eur}€ in ${p.trips} trips, last ${p.last_date}`);
const doctor = (await call("cup24_search", { query: "rossi" })).doctors[0];
await call("cup24_get_availability", { doctor_id: doctor.id });

// Invalid input must come back as a tool error the model can read
await fails("cup24_get_availability", { service_ids: ["../etc"], city: "firenze" });
await fails("cup24_get_availability", { service_ids: [eco.id], city: "nonesiste" });
await fails("cup24_get_availability", { service_ids: [eco.id] });
await fails("cup24_get_slot_times", { slot_id: "000000000000000000000000" });

await client.close();
console.error("Smoke test passed");
