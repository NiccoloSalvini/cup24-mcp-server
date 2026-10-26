/**
 * Plans several services together (e.g. all lines of a prescription): where and when to do them with as few
 * trips as possible, plus the cheapest and the earliest alternative. Lab tests count as one item, since the
 * site books them in one blood draw with one combined price.
 */
import { getAvailability, type parseSlots, SORT } from "./cup24.js";

type Slot = ReturnType<typeof parseSlots>[number];
export interface Item { ids: string[]; label: string; slots: Slot[] }
export interface PlanOptions { byDate?: string; maxKm?: number }

const visit = (item: Item, s: Slot) => ({
  services: item.label,
  date: s.date,
  times: s.times.slice(0, 8),
  price_eur: s.price_eur,
  clinic: s.clinic,
  clinic_id: s.clinic_id,
  address: s.address,
  distance_km: s.distance_km,
  slot_id: s.slot_id,
  booking_url: s.booking_url,
  suggested_time: null as string | null
});
type Visit = ReturnType<typeof visit>;

// shortcut: assumes each appointment lasts 15 minutes (one cup24 slot); longer exams need a check with the clinic
const GAP_MINUTES = 15;
const minutes = (t: string) => (/^\d{2}:\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);

/** Gives visits in the same trip times at least GAP_MINUTES apart, least flexible visit first. */
function suggestTimes(visits: Visit[]) {
  const trips = new Map<string, Visit[]>();
  for (const v of visits) trips.set(`${v.clinic_id}|${v.date}`, [...(trips.get(`${v.clinic_id}|${v.date}`) ?? []), v]);
  for (const trip of trips.values()) {
    const taken: number[] = [];
    for (const v of [...trip].sort((a, b) => a.times.length - b.times.length)) {
      v.suggested_time = v.times.find(t => {
        const m = minutes(t);
        return m != null && taken.every(x => Math.abs(x - m) >= GAP_MINUTES);
      }) ?? null;
      if (v.suggested_time) taken.push(minutes(v.suggested_time)!);
    }
  }
  return visits;
}

const summary = (plan: string, visits: Visit[]) => ({
  plan,
  total_eur: Math.round(visits.reduce((sum, v) => sum + (v.price_eur ?? 0), 0) * 100) / 100,
  trips: new Set(visits.map(v => `${v.clinic_id}|${v.date}`)).size,
  clinics: new Set(visits.map(v => v.clinic_id)).size,
  last_date: visits.map(v => v.date ?? "").sort().at(-1) ?? "",
  visits: suggestTimes(visits)
});
type Plan = ReturnType<typeof summary>;

const cheapest = (slots: Slot[]) => slots.reduce((a, b) => (b.price_eur! < a.price_eur! || (b.price_eur === a.price_eur && b.date! < a.date!) ? b : a));
const earliest = (slots: Slot[]) => slots.reduce((a, b) => (b.date! < a.date! || (b.date === a.date && b.price_eur! < a.price_eur!) ? b : a));

/** Greedy set cover: repeatedly take the clinic and day covering most remaining items, earliest then cheapest. */
function fewestTrips(options: { item: Item; slots: Slot[] }[]) {
  const visits: Visit[] = [];
  const left = new Set(options.keys());
  while (left.size) {
    const trips = new Map<string, Map<number, Slot[]>>();
    for (const i of left) {
      for (const s of options[i].slots) {
        const trip = trips.get(`${s.clinic_id}|${s.date}`) ?? new Map<number, Slot[]>();
        trip.set(i, [...(trip.get(i) ?? []), s]);
        trips.set(`${s.clinic_id}|${s.date}`, trip);
      }
    }
    const cost = (t: Map<number, Slot[]>) => [...t.values()].reduce((sum, slots) => sum + cheapest(slots).price_eur!, 0);
    const day = (key: string) => key.split("|")[1];
    const [, best] = [...trips].sort(([ka, a], [kb, b]) => b.size - a.size || day(ka).localeCompare(day(kb)) || cost(a) - cost(b))[0];
    for (const [i, slots] of best) {
      visits[i] = visit(options[i].item, cheapest(slots));
      left.delete(i);
    }
  }
  return summary("fewest_trips", visits);
}

export function buildPlans(items: Item[], { byDate, maxKm }: PlanOptions = {}) {
  const usable = (s: Slot) =>
    s.price_eur != null && s.date != null && (!byDate || s.date <= byDate) &&
    (maxKm == null || s.distance_km == null || s.distance_km <= maxKm);
  const options = items.map(item => ({ item, slots: item.slots.filter(usable) }));
  const unavailable = options.filter(o => o.slots.length === 0).map(o => o.item.label);
  if (unavailable.length) return { plans: [] as Plan[], unavailable };

  const candidates = [
    fewestTrips(options),
    summary("cheapest", options.map(o => visit(o.item, cheapest(o.slots)))),
    summary("earliest", options.map(o => visit(o.item, earliest(o.slots))))
  ];
  // The same visits can win several criteria: keep the first name
  const seen = new Set<string>();
  const plans = candidates.filter(p => {
    const id = p.visits.map(v => `${v.slot_id}|${v.date}`).join(",");
    return !seen.has(id) && seen.add(id);
  });
  return { plans, unavailable };
}

/** Runs tasks with at most `size` requests to cup24.it in flight. */
async function pool<T>(tasks: (() => Promise<T>)[], size = 6): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }));
  return results;
}

export async function planVisits(
  serviceIds: string[], labIds: string[], city: string, clinicsToCheck: number, options: PlanOptions, signal: AbortSignal
) {
  const targets = [...serviceIds.map(id => [id]), ...(labIds.length ? [labIds] : [])];
  const sorts = [SORT.date, SORT.price, SORT.distance];

  // 1. City-wide first pages (earliest, cheapest, nearest): which clinics offer what, at what price and distance
  const citywide = await pool(targets.flatMap(ids => sorts.map(sort => () => getAvailability({ serviceIds: ids, city }, 1, "", sort, signal))));
  const items: Item[] = targets.map((ids, i) => {
    const slots = citywide.slice(i * sorts.length, (i + 1) * sorts.length).flat()
      .filter((s, k, all) => all.findIndex(x => x.slot_id === s.slot_id && x.date === s.date) === k);
    return { ids, label: slots.find(s => s.service)?.service ?? ids.join(" + "), slots };
  });

  // 2. A results page covers about a day, a clinic page weeks: read the calendars of the clinics offering the most
  //    items (at least two), so trips covering several services on the same day can be found
  const offers = (clinicId: string) => items.filter(it => it.slots.some(s => s.clinic_id === clinicId));
  const minPrice = (item: Item, clinicId: string) =>
    Math.min(...item.slots.filter(s => s.clinic_id === clinicId && s.price_eur != null).map(s => s.price_eur!));
  const total = (clinicId: string) => offers(clinicId).reduce((t, it) => t + minPrice(it, clinicId), 0);
  const multi = [...new Set(items.flatMap(it => it.slots.map(s => s.clinic_id)))]
    .filter(id => offers(id).length >= 2)
    .sort((a, b) => offers(b).length - offers(a).length || total(a) - total(b));
  const checked = multi.slice(0, clinicsToCheck);
  const jobs = checked.flatMap(clinicId => offers(clinicId).map(item => ({ clinicId, item })));
  const calendars = await pool(jobs.map(({ clinicId, item }) =>
    () => getAvailability({ clinicId, serviceId: item.ids[0] }, 1, "", SORT.date, signal)));
  jobs.forEach(({ clinicId, item }, j) => {
    const known = item.slots.find(s => s.clinic_id === clinicId)!;
    const combined = minPrice(item, clinicId);
    for (const s of calendars[j]) {
      if (item.slots.some(x => x.slot_id === s.slot_id && x.date === s.date)) continue;
      // Clinic pages have no city distance and list one lab test at a time: keep the city-wide distance and combined price
      item.slots.push({
        ...s,
        distance_km: s.distance_km ?? known.distance_km,
        ...(item.ids.length > 1 ? { price_eur: Number.isFinite(combined) ? combined : null, service: item.label } : {})
      });
    }
  });

  const scanned = {
    services: items.map(i => ({ services: i.label, ids: i.ids, slots: i.slots.length, clinics: new Set(i.slots.map(s => s.clinic_id)).size })),
    clinics_offering_several: multi.length,
    calendars_checked: checked.map(id => ({ clinic: items.flatMap(i => i.slots).find(s => s.clinic_id === id)!.clinic, services: offers(id).length }))
  };
  return { ...buildPlans(items, options), scanned };
}
