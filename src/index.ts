#!/usr/bin/env node
/**
 * Unofficial MCP server for cup24.it (ex Cup Solidale): private healthcare availability and prices in Italy.
 * Read-only towards cup24.it: it searches, compares and watches for freed slots; booking stays on the website.
 * `cup24-mcp-server check` runs the saved slot alerts once, for launchd or cron.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { getAvailability, getServiceInfo, getSlotTimes, search, searchCities, SORT, type Target, WHEN } from "./cup24.js";
import { planVisits } from "./plan.js";
import { addWatch, checkWatches, listWatches, removeWatch, runCheck, WATCH_FILE } from "./watch.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const json = (data: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: data
});
const message = (text: string) => ({ content: [{ type: "text" as const, text }] });

const serviceId = z.string().regex(/^P?[0-9a-f]{6,32}$/, "Use a service id returned by cup24_search");
const city = z.string().regex(/^[a-z0-9-]{2,80}$/, "Use a slug returned by cup24_search_cities")
  .describe("City or zone slug from cup24_search_cities, e.g. 'firenze'");

function createServer(): McpServer {
  const server = new McpServer({ name: "cup24-mcp-server", version: "0.3.0" });

  server.registerTool(
    "cup24_search",
    {
      title: "Search services, clinics and doctors",
      description: `Search cup24.it by name: healthcare services (exams, visits, lab tests, check-up packages), clinics and doctors.

Search in Italian. Returns ids for the other tools:
- services[].id -> service_ids in cup24_get_availability, service_id in cup24_get_service_info.
  package=true marks check-up packages; combinable=true marks lab tests that can be booked together in one visit.
- clinics[].id -> clinic_id, doctors[].id -> doctor_id in cup24_get_availability.
Examples: "ecografia addome", "visita cardiologica", "emocromo", "check-up", "synlab", "rossi".`,
      inputSchema: z.strictObject({
        query: z.string().trim().min(2).max(100).describe("Service, clinic or doctor name, e.g. 'ecografia addome'")
      }),
      annotations: readOnly
    },
    async ({ query }, ctx) => {
      const found = await search(query, ctx.mcpReq.signal);
      if (!found.services.length && !found.clinics.length && !found.doctors.length) {
        return message(`Nothing matches '${query}'. Try a shorter or more generic Italian term.`);
      }
      return json(found);
    }
  );

  server.registerTool(
    "cup24_search_cities",
    {
      title: "Search cities and zones",
      description: `Find Italian cities, and zones inside big cities, covered by cup24.it and return their slugs.

Use the returned slug as city in cup24_get_availability. Zones narrow the search, e.g. "firenze-zona-campo-di-marte".
Examples: "firenze", "milano", "sesto fiorentino".`,
      inputSchema: z.strictObject({
        query: z.string().trim().min(2).max(100).describe("City or zone name, e.g. 'firenze'")
      }),
      annotations: readOnly
    },
    async ({ query }, ctx) => {
      const cities = await searchCities(query, ctx.mcpReq.signal);
      if (cities.length === 0) return message(`No city matches '${query}'. Check the spelling or try the nearest larger town.`);
      return json({ cities });
    }
  );

  server.registerTool(
    "cup24_get_availability",
    {
      title: "Get availability and prices",
      description: `Real-time availability and prices on cup24.it, from private clinics. Pass one of:
- service_ids + city: one service in a city; several combinable lab tests are booked together and priced as one visit
- clinic_id (optionally with one service id): what that clinic can do soonest
- doctor_id: that doctor's availability

Returns slots: one per clinic and day, with that day's free times, service, price in EUR (full_price_eur and price_note on
promotions), clinic, rating, address, coordinates, distance in km from the city centre, doctor, slot_id for
cup24_get_slot_times, and booking_url to book on the website.
Results come in chronological pages: when slots is not empty, call again with page=next_page for later dates.`,
      inputSchema: z.strictObject({
        service_ids: z.array(serviceId).min(1).max(10).optional()
          .describe("Service ids from cup24_search, e.g. ['57d1785cdb86a']; several only for combinable lab tests"),
        city: city.optional(),
        clinic_id: z.string().regex(/^[0-9a-f]{24}$/, "Use a clinic id from cup24_search or a slot").optional()
          .describe("Clinic id from cup24_search (clinics) or from a slot's clinic_id"),
        doctor_id: z.string().regex(/^[0-9a-f]{32}$/, "Use a doctor id returned by cup24_search").optional()
          .describe("Doctor id from cup24_search (doctors)"),
        sort: z.enum(["date", "price", "distance"]).default("date")
          .describe("'date' = earliest first (default), 'price' = cheapest first, 'distance' = nearest first"),
        when: z.enum(WHEN).optional()
          .describe("Only slots: oggi (today), domani (tomorrow), settimana (this week), prossima-settimana (next week), prossimo-mese (next month)"),
        page: z.number().int().min(1).max(100).default(1).describe("Page of results, 1 = first")
      }),
      annotations: readOnly
    },
    async ({ service_ids, city, clinic_id, doctor_id, sort, when, page }, ctx) => {
      let target: Target;
      if (doctor_id) target = { doctorId: doctor_id };
      else if (clinic_id && (service_ids?.length ?? 0) <= 1) target = { clinicId: clinic_id, serviceId: service_ids?.[0] };
      else if (city && service_ids && !clinic_id) target = { serviceIds: service_ids, city };
      else throw new Error("Pass service_ids with city, or clinic_id with at most one service id, or doctor_id.");

      const slots = await getAvailability(target, page, when ?? "", SORT[sort], ctx.mcpReq.signal);
      if (slots.length === 0) {
        return message(page > 1 ? "No more dates available." : "No availability here: try another city or zone, or drop the when filter.");
      }
      return json({ count: slots.length, page, next_page: page + 1, slots });
    }
  );

  server.registerTool(
    "cup24_get_slot_times",
    {
      title: "Get bookable times",
      description: `Exact bookable times for a slot from cup24_get_availability, day by day: the slot's day, then the next
available days of the same clinic and doctor, as in the website's "Scegli data e ora" picker.
For lab tests the only entry describes the walk-in window (e.g. "Esecuzione prelievi: il Martedì dalle 07:00 alle 09:00").
To book, open the slot's booking_url.`,
      inputSchema: z.strictObject({
        slot_id: z.string().regex(/^[0-9a-f]{24}$/, "Use a slot_id returned by cup24_get_availability")
          .describe("slot_id from cup24_get_availability"),
        days: z.number().int().min(1).max(7).default(3).describe("How many available days to return, from the slot's day")
      }),
      annotations: readOnly
    },
    async ({ slot_id, days }, ctx) => json({ days: await getSlotTimes(slot_id, days, ctx.mcpReq.signal) })
  );

  server.registerTool(
    "cup24_get_service_info",
    {
      title: "Get service information",
      description: `What a service is and what it costs across Italy, from its cup24.it page: FAQ (what it is for, how to
prepare, fasting, duration, contraindications), min and max price per major city, and for check-up packages the
lab tests included. Use cup24_get_availability for real-time prices and dates.`,
      inputSchema: z.strictObject({
        service_id: serviceId.describe("Service id from cup24_search, e.g. '57d1785cdb86a' or 'P4f0558e47c4f'")
      }),
      annotations: readOnly
    },
    async ({ service_id }, ctx) => json(await getServiceInfo(service_id, ctx.mcpReq.signal))
  );

  server.registerTool(
    "cup24_plan_visits",
    {
      title: "Plan several services (e.g. a prescription)",
      description: `Plan several services together, e.g. every line of a doctor's prescription ("impegnativa"): where and
when to do them all with as few trips as possible.

For a prescription photo or text: read every line, map each one with cup24_search, show the user the mapping and
let them confirm it, then call this tool. Lab tests with combinable=true go in lab_ids: they are done in one blood
draw with one combined price. Everything else goes in service_ids.

Returns up to three plans without duplicates: fewest_trips (same clinic and day for as many services as possible),
cheapest and earliest (any clinics). Each plan has total_eur, trips (clinic+day pairs), clinics, last_date and one
visit per service with date, times, price, clinic, slot_id for cup24_get_slot_times and booking_url. Lab tests are
usually done in separate lab branches, so a single trip for everything is rare when labs are included.
unavailable lists services without slots; scanned says which clinic calendars were checked day by day.`,
      inputSchema: z.strictObject({
        service_ids: z.array(serviceId).max(8).default([]).describe("Services from cup24_search, one per prescription line"),
        lab_ids: z.array(serviceId).max(10).default([]).describe("Lab tests from cup24_search with combinable=true"),
        city,
        by_date: z.iso.date().optional().describe("Latest acceptable date, YYYY-MM-DD"),
        max_km: z.number().positive().max(200).optional().describe("Maximum distance from the city (or zone) centre"),
        clinics: z.number().int().min(1).max(8).default(4)
          .describe("How many clinics offering several of the services to check day by day")
      }),
      annotations: readOnly
    },
    async ({ service_ids, lab_ids, city, by_date, max_km, clinics }, ctx) => {
      if (service_ids.length + lab_ids.length === 0) throw new Error("Pass at least one id in service_ids or lab_ids.");
      const result = await planVisits(service_ids, lab_ids, city, clinics, { byDate: by_date, maxKm: max_km }, ctx.mcpReq.signal);
      return json(result);
    }
  );

  // Watches only write a local file; openWorldHint because checks query cup24.it
  const localWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  server.registerTool(
    "cup24_watch_add",
    {
      title: "Create a slot alert",
      description: `Watch for freed slots: "tell me when a cardiology visit in Florence frees up before the 10th, under 100 €".
Saves the search locally and checks it right away. available_now lists what already matches: if it is not empty,
there is no need to wait, tell the user. Later checks (cup24_watch_check, or the periodic \`cup24-mcp-server check\`)
report only times that were not visible at the previous check, including times booked and then cancelled.
Give at least one of before, max_price, max_km. Watches are stored in ${WATCH_FILE}.`,
      inputSchema: z.strictObject({
        service_ids: z.array(serviceId).min(1).max(10)
          .describe("One service id from cup24_search, or several combinable lab tests to do together"),
        city,
        before: z.iso.date().optional().describe("Only slots on or before this date, YYYY-MM-DD"),
        max_price: z.number().positive().optional().describe("Only slots at or under this price in EUR"),
        max_km: z.number().positive().max(200).optional().describe("Only clinics within this distance from the city (or zone) centre"),
        label: z.string().trim().min(1).max(80).optional().describe("Name for the alert; defaults to service and city")
      }),
      annotations: localWrite
    },
    async ({ label, ...criteria }, ctx) => {
      if (criteria.before == null && criteria.max_price == null && criteria.max_km == null) {
        throw new Error("Give at least one of before, max_price or max_km, otherwise every new slot would trigger the alert.");
      }
      return json(await addWatch(criteria, label, ctx.mcpReq.signal));
    }
  );

  server.registerTool(
    "cup24_watch_list",
    {
      title: "List slot alerts",
      description: "The saved slot alerts with their criteria, last check and how many matching times were visible then.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => json({ watches: listWatches() })
  );

  server.registerTool(
    "cup24_watch_remove",
    {
      title: "Remove a slot alert",
      description: "Deletes a saved slot alert by its id from cup24_watch_list.",
      inputSchema: z.strictObject({ id: z.string().min(1).max(40).describe("Alert id from cup24_watch_list") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ id }) => {
      removeWatch(id);
      return message(`Alert ${id} removed.`);
    }
  );

  server.registerTool(
    "cup24_watch_check",
    {
      title: "Check slot alerts now",
      description: `Checks the saved slot alerts now (all, or the given ids) and returns, per alert, the times that were not
visible at the previous check, with clinic, date, price and booking_url. An alert that fails reports its error.`,
      inputSchema: z.strictObject({
        ids: z.array(z.string().min(1).max(40)).optional().describe("Alert ids to check; all when omitted")
      }),
      annotations: localWrite
    },
    async ({ ids }, ctx) => json({ results: await checkWatches(ids, ctx.mcpReq.signal) })
  );

  return server;
}

if (process.argv[2] === "check") {
  await runCheck();
} else {
  serveStdio(createServer);
  console.error("cup24-mcp-server running on stdio");
}
