/**
 * Client for the public cup24.it endpoints the website itself uses.
 * Reverse engineered from the site (see README "Come funziona cup24.it"); no official API exists.
 */

const SITE = "https://cup24.it";
const API = "https://api2.cup24.it/v2";
const USER_AGENT = "cup24-mcp-server (+https://github.com/NiccoloSalvini/cup24-mcp-server)";

export const WHEN = ["oggi", "domani", "settimana", "prossima-settimana", "prossimo-mese"] as const;
export const SORT = { date: "", price: "sort:price", distance: "sort:where" } as const;

async function request(url: string, signal: AbortSignal, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, ...(init.cookie ? { Cookie: init.cookie } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("cup24.it did not respond within 30 seconds. Try again in a moment.");
    }
    throw error;
  }
  if (res.status === 404) {
    throw new Error("cup24.it returned 404: unknown id or city. Get valid values from cup24_search and cup24_search_cities.");
  }
  if (!res.ok) throw new Error(`cup24.it returned HTTP ${res.status}. Try again later.`);
  return res;
}

async function suggest(path: string, term: string, signal: AbortSignal): Promise<Record<string, any>[]> {
  const res = await request(`${API}/search/${path}?term=${encodeURIComponent(term)}`, signal);
  const items: unknown = await res.json();
  if (!Array.isArray(items)) throw new Error("Unexpected response from cup24.it search; the site may have changed.");
  return items;
}

export async function search(term: string, signal: AbortSignal) {
  const items = await suggest("suggest", term, signal);
  const ofType = (type: string) => items.filter(item => item.type === type);
  return {
    services: ofType("service").map(item => {
      const category: string[] = item.category ?? [];
      return {
        id: String(item.id),
        name: String(item.text),
        category,
        // Packages (check-up) have ids starting with "P"; lab tests can be booked together in one visit, as on the site
        ...(String(item.id).startsWith("P") ? { package: true } : {}),
        ...(category.includes("laboratorio") || category.includes("prelievo") ? { combinable: true } : {})
      };
    }),
    clinics: ofType("sede").map(item => ({ id: String(item.id), name: String(item.text) })),
    doctors: ofType("doctor").map(item => ({ id: String(item.id), name: String(item.text) }))
  };
}

export async function searchCities(term: string, signal: AbortSignal) {
  const items = await suggest("suggestcity", term, signal);
  return items.map(item => ({
    slug: String(item.url),
    name: String(item.name),
    province: item.prov_sigla as string,
    region: item.regione as string
  }));
}

export type Target =
  | { serviceIds: string[]; city: string }
  | { clinicId: string; serviceId?: string }
  | { doctorId: string };

export async function getAvailability(target: Target, page: number, when: string, sort: string, signal: AbortSignal) {
  let path: string;
  let cookie: string | undefined;
  if ("doctorId" in target) path = `/medico/${target.doctorId}`;
  else if ("clinicId" in target) path = `/sede/${target.clinicId}${target.serviceId ? `/${target.serviceId}` : ""}`;
  else if (target.serviceIds.length === 1) path = `/c/${target.city}/${target.serviceIds[0]}/`;
  else {
    // Combined lab tests live under /search/ and are located by lat/lng cookies; the city page map has the coordinates
    const cityPage = await (await request(`${SITE}/c/${target.city}/`, signal)).text();
    const at = cityPage.match(/\/maps\/\?lat=([\d.]+)&(?:amp;)?lng=([\d.]+)/);
    if (!at) throw new Error(`Could not locate '${target.city}' on cup24.it; the site may have changed.`);
    path = `/search/${target.serviceIds.join(",")}/`;
    cookie = `lat=${at[1]}; lng=${at[2]}`;
  }
  // Same form POST the site sends for "Altre date", sorting and date filters
  const body = new URLSearchParams({ page: String(page), when, type: "", mode: "", sort });
  const res = await request(`${SITE}${path}`, signal, { method: "POST", body, cookie });
  return parseSlots(await res.text());
}

/** Walks the site's "Scegli data e ora" picker: the slot's day, then the next available days of the same agenda. */
export async function getSlotTimes(slotId: string, days: number, signal: AbortSignal) {
  const result = [];
  let body = new URLSearchParams({ id: slotId });
  while (result.length < days) {
    const res = await request(`${SITE}/messages/options`, signal, { method: "POST", body });
    const data = (await res.json()) as { body?: string; no_slot?: boolean };
    // no_slot marks both an expired slot and the end of the agenda
    const day = data.no_slot ? null : parseTimes(data.body ?? "");
    if (!day) break;
    result.push(day.day);
    body = new URLSearchParams({ ...day.nav, promotion: "", mode: "next" });
  }
  if (result.length === 0) {
    throw new Error("This slot is no longer available. Call cup24_get_availability again for fresh slot ids.");
  }
  return result;
}

export async function getServiceInfo(serviceId: string, signal: AbortSignal) {
  const html = await (await request(`${SITE}/prestazione/${serviceId}/`, signal)).text();
  const info = parseServiceInfo(html);
  if (!serviceId.startsWith("P")) return info;
  const items: unknown = await (await request(`${SITE}/what/${serviceId}/package_list`, signal)).json();
  const includes = Array.isArray(items) ? items.map(item => ({ id: String(item.what_id), name: String(item.name) })) : [];
  return { ...info, includes };
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", raquo: "»" };
const decode = (s: string) =>
  s.replace(/&(#\d+|\w+);/g, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(Number(e.slice(1))) : ENTITIES[e] ?? m)).trim();
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
const itNumber = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
const romeDate = (unix: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date(unix * 1000));

/** Parses the slot cards of a results page: one card per clinic and day, with that day's free times. */
export function parseSlots(html: string) {
  const cards = html.split(/<div class="slot-wrapper" id="slot-\d+">/).slice(1);
  return cards.flatMap(card => {
    // Every card pushes a JSON map point with the clinic's id, address, coordinates and the date
    const point = card.match(/slotAddressPoints\.push\((\{.*?\})\);/s);
    if (!point) return [];
    const p = JSON.parse(point[1]);
    const sede = card.match(/<a href="\/sede\/([0-9a-f]+)">([^<]*)<\/a>/);
    const clinicId: string = sede?.[1] ?? p._id?.$id;
    const heading = card.match(/<h2 class="heading"><a([^>]*)>([^<]*)<\/a>/);
    // Single services link their page; combined lab tests have no link
    const serviceId = heading?.[1].match(/data-href="\/(?:prestazione|sede\/[0-9a-f]+)\/(P?[0-9a-f]+)/)?.[1];
    const date = String(p.datestring ?? "").match(/^(\d{4})(\d{2})(\d{2})$/);
    // Promotions render as <div class="price promotion-price"><span>64,00€</span> <span class="promotion-base-price">80,00€</span>
    const price = card.match(/<div class="price[^"]*">(?:\s*<span>)?\s*([\d.,]+)\s*€/);
    const basePrice = card.match(/promotion-base-price">\s*([\d.,]+)\s*€/);
    const note = card.match(/<div class="promotion-note">(.*?)<\/div>/s);
    const rating = card.match(/<strong>([\d,]+)<\/strong> su (\d+) recensioni/);
    const doctor = card.match(/icon-doctor"><\/i>([^<]*)</);
    const distance = card.match(/Vedi mappa \(([\d.,]+) km\)/);
    const booking = card.match(/openBooking"[^>]*data-id="([^"]+)"/);
    return [{
      date: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
      times: card.match(/title="Orari: ([^"]*)"/)?.[1].split(/\s+/).filter(Boolean) ?? [],
      service: heading ? decode(heading[2]) : null,
      price_eur: price ? itNumber(price[1]) : null,
      ...(basePrice ? { full_price_eur: itNumber(basePrice[1]) } : {}),
      ...(note ? { price_note: text(note[1]) } : {}),
      clinic: decode(sede?.[2] ?? p.name ?? ""),
      clinic_id: clinicId,
      address: decode(p.address ?? ""),
      lat: p.loc?.coordinates?.[1],
      lng: p.loc?.coordinates?.[0],
      distance_km: distance ? itNumber(distance[1]) : null,
      ...(rating ? { rating: itNumber(rating[1]), reviews: Number(rating[2]) } : {}),
      ...(doctor && decode(doctor[1]) ? { doctor: decode(doctor[1]) } : {}),
      ...(booking ? { slot_id: booking[1] } : {}),
      booking_url: `${SITE}/sede/${clinicId}${serviceId ? `/${serviceId}` : ""}`
    }];
  });
}

/** Parses the body of a /messages/options reply: one day of the picker. */
export function parseTimes(body: string) {
  const nav = body.match(/class="row nav nav-date"([^>]*)>/);
  if (!nav) return null;
  const a = Object.fromEntries([...nav[1].matchAll(/data-(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  const box = Object.fromEntries(
    [...body.matchAll(/<div class="heading[^"]*">([^<]*)<\/div>\s*<div class="desc">([^<]*)<\/div>/g)].map(m => [m[1].trim(), decode(m[2])])
  );
  return {
    nav: { who: a.who ?? "", what: a.what ?? "", where: a.where ?? "", when: a.when ?? "" },
    day: {
      date: a.when ? romeDate(Number(a.when)) : null,
      clinic: box["Struttura"],
      service: box["Esame"],
      doctor: box["Medico"],
      // Lab tests have no fixed times: their only node describes the walk-in window
      times: [...body.matchAll(/class="[^"]*\bnode"[^>]*>(.*?)<\/div>/gs)].map(m => text(m[1]))
    }
  };
}

/** Parses a /prestazione/ page: FAQ (what it is, preparation, duration) and min/max price per city. */
export function parseServiceInfo(html: string) {
  let name: string | null = null;
  let faq: { question: string; answer: string }[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    let ld: any;
    try { ld = JSON.parse(m[1]); } catch { continue; }
    if (ld["@type"] === "Table") name = ld.about?.name ?? name;
    if (ld["@type"] === "FAQPage") {
      faq = (ld.mainEntity ?? []).map((q: any) => ({ question: text(String(q.name)), answer: text(String(q.acceptedAnswer?.text ?? "")) }));
    }
  }
  const table = html.match(/<table[^>]*>(.*?)<\/table>/s)?.[1] ?? "";
  const prices = [...table.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].flatMap(row => {
    const cells = [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(c => c[1]);
    const slug = cells[0]?.match(/href="\/c\/([a-z0-9-]+)\//);
    const min = cells[1]?.match(/([\d.,]+)/);
    const max = cells[2]?.match(/([\d.,]+)/);
    if (!min || !max) return [];
    return [{ city: text(cells[0]), ...(slug ? { city_slug: slug[1] } : {}), min_eur: itNumber(min[1]), max_eur: itNumber(max[1]) }];
  });
  return { name, prices_by_city: prices, faq };
}
