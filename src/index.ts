#!/usr/bin/env node
/**
 * Unofficial MCP server for cup24.it (ex Cup Solidale): private healthcare availability and prices in Italy.
 * Read-only: it searches and compares, booking stays on the website.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { getAvailability, getServiceInfo, getSlotTimes, search, searchCities, SORT, type Target, WHEN } from "./cup24.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const json = (data: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: data
});
const message = (text: string) => ({ content: [{ type: "text" as const, text }] });

const serviceId = z.string().regex(/^P?[0-9a-f]{6,32}$/, "Use a service id returned by cup24_search");

function createServer(): McpServer {
  const server = new McpServer({ name: "cup24-mcp-server", version: "0.2.0" });

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
        city: z.string().regex(/^[a-z0-9-]{2,80}$/, "Use a slug returned by cup24_search_cities").optional()
          .describe("City or zone slug from cup24_search_cities, e.g. 'firenze'"),
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

  return server;
}

serveStdio(createServer);
console.error("cup24-mcp-server running on stdio");
