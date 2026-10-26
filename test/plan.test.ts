import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildPlans, type Item } from "../src/plan.js";

const slot = (clinic: string, date: string, price: number, times: string[], distance = 1) => ({
  date, times, service: null, price_eur: price, clinic, clinic_id: clinic, address: "", lat: 0, lng: 0,
  distance_km: distance, slot_id: `${clinic}-${date}`, booking_url: `https://cup24.it/sede/${clinic}`
});
const item = (label: string, slots: ReturnType<typeof slot>[]): Item => ({ ids: [label], label, slots });

const eco = item("eco", [slot("X", "2026-11-03", 70, ["15:30", "15:45"]), slot("Y", "2026-10-28", 60, ["09:00"], 12)]);
const visita = item("visita", [slot("X", "2026-11-03", 70, ["15:30"]), slot("Z", "2026-10-27", 50, ["10:00"])]);

test("prefers one trip, then lists cheapest and earliest", () => {
  const { plans, unavailable } = buildPlans([eco, visita]);
  assert.deepEqual(unavailable, []);
  assert.deepEqual(plans.map(p => [p.plan, p.trips, p.total_eur]), [["fewest_trips", 1, 140], ["cheapest", 2, 110]]);
  // earliest is the same visits as cheapest here, so it is dropped as a duplicate
});

test("suggests times at least 15 minutes apart within a trip, least flexible visit first", () => {
  const [trip] = buildPlans([eco, visita]).plans;
  assert.deepEqual(trip.visits.map(v => [v.services, v.suggested_time]), [["eco", "15:45"], ["visita", "15:30"]]);
});

test("applies date and distance limits, and reports services left without slots", () => {
  const near = buildPlans([eco, visita], { maxKm: 5 });
  assert.equal(near.plans[0].visits[0].clinic, "X"); // Y is 12 km away
  const soon = buildPlans([eco, visita], { byDate: "2026-10-27" });
  assert.deepEqual(soon, { plans: [], unavailable: ["eco"] });
});
