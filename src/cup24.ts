/**
 * Client for the public cup24.it endpoints the website itself uses.
 * Reverse engineered from the site (see README "Come funziona cup24.it"); no official API exists.
 */

const SITE = "https://cup24.it";
const API = "https://api2.cup24.it/v2";
const USER_AGENT = "cup24-mcp-server (+https://github.com/NiccoloSalvini/cup24-mcp-server)";

export const WHEN = ["oggi", "domani", "settimana", "prossima-settimana", "prossimo-mese"] as const;
export const SORT = { date: "", price: "sort:price", distance: "sort:where" } as const;

async function request(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("cup24.it did not respond within 30 seconds. Try again in a moment.");
    }
    throw error;
  }
  if (res.status === 404) {
    throw new Error("cup24.it returned 404: unknown city or service. Get valid values from cup24_search_cities and cup24_search_services.");
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

export async function searchServices(term: string, signal: AbortSignal) {
  const items = await suggest("suggest", term, signal);
  // The same endpoint also returns clinics ("sede") and doctors; only services can be searched for availability
  return items
    .filter(item => item.type === "service")
    .map(item => ({ id: String(item.id), name: String(item.text), category: item.category as string[] }));
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

export interface AvailabilityQuery {
  serviceId: string;
  city: string;
  page: number;
  when: string;
  sort: string;
}

export async function getAvailability(q: AvailabilityQuery, signal: AbortSignal) {
  // Same form POST the site sends for "Altre date", sorting and date filters
  const body = new URLSearchParams({ page: String(q.page), when: q.when, type: "", mode: "", sort: q.sort });
  const res = await request(`${SITE}/c/${q.city}/${q.serviceId}/`, signal, { method: "POST", body });
  return parseSlots(await res.text(), q.serviceId);
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
const decode = (s: string) =>
  s.replace(/&(#\d+|\w+);/g, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(Number(e.slice(1))) : ENTITIES[e] ?? m)).trim();
const itNumber = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));

/** Parses the slot cards of a results page: one card per clinic and day, with that day's free times. */
export function parseSlots(html: string, serviceId: string) {
  const cards = html.split(/<div class="slot-wrapper" id="slot-\d+">/).slice(1);
  const slots = cards.flatMap(card => {
    // Every card pushes a JSON map point with the clinic's id, address, coordinates and the date
    const point = card.match(/slotAddressPoints\.push\((\{.*?\})\);/s);
    if (!point) return [];
    const p = JSON.parse(point[1]);
    const sede = card.match(/<a href="\/sede\/([0-9a-f]+)">([^<]*)<\/a>/);
    const clinicId: string = sede?.[1] ?? p._id?.$id;
    const date = String(p.datestring ?? "").match(/^(\d{4})(\d{2})(\d{2})$/);
    // Promotions render as <div class="price promotion-price"><span>64,00€</span> <span class="promotion-base-price">80,00€</span>
    const price = card.match(/<div class="price[^"]*">(?:\s*<span>)?\s*([\d.,]+)\s*€/);
    const basePrice = card.match(/promotion-base-price">\s*([\d.,]+)\s*€/);
    const note = card.match(/<div class="promotion-note">(.*?)<\/div>/s);
    const doctor = card.match(/icon-doctor"><\/i>([^<]*)</);
    const distance = card.match(/Vedi mappa \(([\d.,]+) km\)/);
    return [{
      date: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
      times: card.match(/title="Orari: ([^"]*)"/)?.[1].split(/\s+/).filter(Boolean) ?? [],
      price_eur: price ? itNumber(price[1]) : null,
      ...(basePrice ? { full_price_eur: itNumber(basePrice[1]) } : {}),
      ...(note ? { price_note: decode(note[1].replace(/<[^>]+>/g, "")) } : {}),
      clinic: decode(sede?.[2] ?? p.name ?? ""),
      address: decode(p.address ?? ""),
      lat: p.loc?.coordinates?.[1],
      lng: p.loc?.coordinates?.[0],
      distance_km: distance ? itNumber(distance[1]) : null,
      ...(doctor && decode(doctor[1]) ? { doctor: decode(doctor[1]) } : {}),
      booking_url: `${SITE}/sede/${clinicId}/${serviceId}`
    }];
  });
  const service = html.match(/<h2 class="heading"><a[^>]*>([^<]*)<\/a>/);
  return { service: service ? decode(service[1]) : null, slots };
}
