import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fresh, matching } from "../src/watch.js";

const slot = (clinic: string, date: string, price: number, times: string[], distance = 2) => ({
  date, times, service: "Visita Cardiologica", price_eur: price, clinic, clinic_id: clinic, address: "", lat: 0, lng: 0,
  distance_km: distance, slot_id: `${clinic}-${date}`, booking_url: `https://cup24.it/sede/${clinic}`
});
const watch = { service_ids: ["57d1785cf2e5c"], city: "firenze", before: "2026-11-10", max_price: 100, max_km: 10 };

test("matches only future times within date, price and distance limits", () => {
  const slots = [
    slot("A", "2026-11-05", 90, ["09:00", "09:30"]),
    slot("B", "2026-11-20", 80, ["10:00"]), // after the date limit
    slot("C", "2026-11-05", 130, ["11:00"]), // too expensive
    slot("D", "2026-11-05", 70, ["12:00"], 25), // too far
    slot("E", "2026-11-01", 70, ["08:00"]) // already past
  ];
  assert.deepEqual(matching(watch, slots, "2026-11-02").map(m => m.key), ["A|2026-11-05|09:00", "A|2026-11-05|09:30"]);
});

test("reports only times not visible at the previous check, grouped per clinic and day", () => {
  const first = matching(watch, [slot("A", "2026-11-05", 90, ["09:00"])], "2026-11-02");
  const second = matching(watch, [slot("A", "2026-11-05", 90, ["09:00", "09:30"]), slot("F", "2026-11-06", 60, ["15:00"])], "2026-11-02");
  const news = fresh(second, first.map(f => f.key));
  assert.deepEqual(news.map(n => [n.clinic, n.date, n.times]), [["A", "2026-11-05", ["09:30"]], ["F", "2026-11-06", ["15:00"]]]);
});

test("a time booked and then freed again is new", () => {
  const booked = matching(watch, [slot("A", "2026-11-05", 90, ["09:30"])], "2026-11-02"); // 09:00 taken by someone
  const freed = matching(watch, [slot("A", "2026-11-05", 90, ["09:00", "09:30"])], "2026-11-02");
  assert.deepEqual(fresh(freed, booked.map(f => f.key)).map(n => n.times), [["09:00"]]);
});
