import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseServiceInfo, parseSlots, parseTimes } from "../src/cup24.js";

// Trimmed copies of real cup24.it replies, doctor names replaced
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("parses slot cards of a results page", () => {
  const slots = parseSlots(fixture("results.html"));
  assert.equal(slots.length, 3);
  assert.deepEqual(slots[0], {
    date: "2026-10-27",
    times: ["08:20", "08:40", "09:40", "10:40", "11:40", "12:00", "12:40", "13:00", "13:20", "13:40"],
    service: "Ecografia Addome Completo",
    price_eur: 87,
    clinic: "Istituto Fiorentino Di Analisi - Firenze",
    clinic_id: "6155adc192fa0997498b4c31",
    address: "Via Giuseppe Verdi, 16 Firenze",
    lat: 43.770088,
    lng: 11.261513,
    distance_km: 0.56,
    rating: 4.6,
    reviews: 3080,
    doctor: "Mario Rossi",
    slot_id: "6adf46c35fb1b4c7380f7962",
    booking_url: "https://cup24.it/sede/6155adc192fa0997498b4c31/57d1785cdb86a"
  });
  assert.equal(slots[1].price_eur, 120);
  assert.match(slots[1].price_note ?? "", /scontata a 84,00€/);
  // Promotional price with the full price struck through
  assert.equal(slots[2].price_eur, 64);
  assert.equal(slots[2].full_price_eur, 80);
  assert.equal(slots[2].price_note, "3 prestazioni residue a questa tariffa");
  assert.equal(slots[2].date, "2026-10-28");
});

test("returns no slots for a page without cards", () => {
  assert.deepEqual(parseSlots("<html>Non ci sono altre date disponibili!</html>"), []);
});

test("parses one day of the time picker", () => {
  const { nav, day } = parseTimes(JSON.parse(fixture("options.json")).body)!;
  assert.deepEqual(nav, { who: "6554703979a237e54ea981a7", what: "57d1785cdb86a", where: "6155adc192fa0997498b4c31", when: "1793085600" });
  assert.equal(day.date, "2026-10-27");
  assert.equal(day.doctor, "Mario Rossi");
  assert.deepEqual(day.times, ["08:20", "08:40", "09:40", "10:40", "11:40", "12:00", "12:40", "13:00", "13:20", "13:40"]);
});

test("returns the walk-in window for lab tests", () => {
  const { day } = parseTimes(JSON.parse(fixture("options-lab.json")).body)!;
  assert.deepEqual(day.times, ["Esecuzione prelievi: il Martedì dalle 07:00 alle 09:00, il Sabato dalle 07:30 alle 09:30"]);
});

test("returns null for an expired slot", () => {
  assert.equal(parseTimes("Lo slot selezionato non è più raggiungibile."), null);
});

test("parses FAQ and prices by city of a service page", () => {
  const info = parseServiceInfo(fixture("service.html"));
  assert.equal(info.name, "Ecografia Addome Completo");
  assert.deepEqual(info.prices_by_city[0], { city: "Bari", city_slug: "bari", min_eur: 52, max_eur: 140 });
  assert.equal(info.prices_by_city.length, 3);
  assert.equal(info.faq.length, 2);
  assert.match(info.faq[0].question, /preparazione/);
  assert.ok(!info.faq[0].answer.includes("<"), "answers are plain text");
});
