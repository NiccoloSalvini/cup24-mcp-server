#!/usr/bin/env node
/**
 * Unofficial MCP server for cup24.it (ex Cup Solidale): private healthcare availability and prices in Italy.
 * Read-only: it searches and compares, booking stays on the website.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { getAvailability, searchCities, searchServices, SORT, WHEN } from "./cup24.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const json = (data: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: data
});

function createServer(): McpServer {
  const server = new McpServer({ name: "cup24-mcp-server", version: "0.1.0" });

  server.registerTool(
    "cup24_search_services",
    {
      title: "Search healthcare services",
      description: `Find cup24.it healthcare services (exams, visits, diagnostics) by name and return their ids.

Search in Italian. Use the returned id as service_id in cup24_get_availability.
Examples: "ecografia addome", "visita cardiologica", "risonanza ginocchio", "analisi sangue".`,
      inputSchema: z.strictObject({
        query: z.string().trim().min(2).max(100).describe("Service name in Italian, e.g. 'ecografia addome'")
      }),
      annotations: readOnly
    },
    async ({ query }, ctx) => {
      const services = await searchServices(query, ctx.mcpReq.signal);
      if (services.length === 0) {
        return { content: [{ type: "text", text: `No service matches '${query}'. Try a shorter or more generic Italian term.` }] };
      }
      return json({ services });
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
      if (cities.length === 0) {
        return { content: [{ type: "text", text: `No city matches '${query}'. Check the spelling or try the nearest larger town.` }] };
      }
      return json({ cities });
    }
  );

  server.registerTool(
    "cup24_get_availability",
    {
      title: "Get availability and prices",
      description: `Real-time availability and prices of one service in one city on cup24.it, from private clinics.

Returns slots: one per clinic and day, with that day's free times, price in EUR, clinic, address, coordinates,
distance in km from the city (or zone) centre, doctor when shown, and booking_url to book on the website.
Results come in chronological pages: when slots is not empty, call again with page=next_page for later dates.
Get service_id from cup24_search_services and city from cup24_search_cities.`,
      inputSchema: z.strictObject({
        service_id: z.string().regex(/^[0-9a-f]{6,32}$/, "Use an id returned by cup24_search_services")
          .describe("Service id from cup24_search_services, e.g. '57d1785cdb86a'"),
        city: z.string().regex(/^[a-z0-9-]{2,80}$/, "Use a slug returned by cup24_search_cities")
          .describe("City or zone slug from cup24_search_cities, e.g. 'firenze'"),
        sort: z.enum(["date", "price", "distance"]).default("date")
          .describe("'date' = earliest first (default), 'price' = cheapest first, 'distance' = nearest first"),
        when: z.enum(WHEN).optional()
          .describe("Only slots: oggi (today), domani (tomorrow), settimana (this week), prossima-settimana (next week), prossimo-mese (next month)"),
        page: z.number().int().min(1).max(100).default(1).describe("Page of results, 1 = first")
      }),
      annotations: readOnly
    },
    async ({ service_id, city, sort, when, page }, ctx) => {
      const result = await getAvailability(
        { serviceId: service_id, city, page, when: when ?? "", sort: SORT[sort] },
        ctx.mcpReq.signal
      );
      if (result.slots.length === 0) {
        const hint = page > 1 ? "No more dates available." : "No availability for this service here: try another city, a zone, or without the when filter.";
        return { content: [{ type: "text", text: hint }] };
      }
      return json({ ...result, city, page, next_page: page + 1, count: result.slots.length });
    }
  );

  return server;
}

serveStdio(createServer);
console.error("cup24-mcp-server running on stdio");
