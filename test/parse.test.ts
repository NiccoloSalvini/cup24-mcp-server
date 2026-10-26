import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSlots } from "../src/cup24.js";

// Trimmed copy of a real results page (cup24.it/c/firenze/57d1785cdb86a/), doctor names replaced
const html = readFileSync(new URL("fixtures/results.html", import.meta.url), "utf8");

test("parses slot cards of a results page", () => {
  const { service, slots } = parseSlots(html, "57d1785cdb86a");
  assert.equal(service, "Ecografia Addome Completo");
  assert.equal(slots.length, 3);
  assert.deepEqual(slots[0], {
    date: "2026-10-27",
    times: ["08:20", "08:40", "09:40", "10:40", "11:40", "12:00", "12:40", "13:00", "13:20", "13:40"],
    price_eur: 87,
    clinic: "Istituto Fiorentino Di Analisi - Firenze",
    address: "Via Giuseppe Verdi, 16 Firenze",
    lat: 43.770088,
    lng: 11.261513,
    distance_km: 0.56,
    doctor: "Mario Rossi",
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
  assert.deepEqual(parseSlots("<html>Non ci sono altre date disponibili!</html>", "x").slots, []);
});
