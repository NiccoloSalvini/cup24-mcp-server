/**
 * Slot alerts: saved searches checked on demand or periodically (`cup24-mcp-server check`), reporting only the
 * times that were not visible at the previous check. Watches live in a local JSON file, never on a server.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAvailability, type parseSlots, SORT } from "./cup24.js";

type Slot = ReturnType<typeof parseSlots>[number];
export interface Criteria { service_ids: string[]; city: string; before?: string; max_price?: number; max_km?: number }
export interface Watch extends Criteria { id: string; label: string; created: string; last_check: string | null; seen: string[] }

export const WATCH_FILE = process.env.CUP24_WATCH_FILE ?? join(homedir(), ".cup24-mcp", "watches.json");
// shortcut: scans the first 3 chronological pages (a few days for popular services, weeks for scarce ones); raise for wider windows
const PAGES = 3;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date());

function load(): Watch[] {
  try {
    return JSON.parse(readFileSync(WATCH_FILE, "utf8")).watches;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // Never overwrite a file we cannot read: the user would lose their watches
    throw new Error(`Cannot read the watch file ${WATCH_FILE}: ${(error as Error).message}. Fix or move it, then retry.`);
  }
}

function save(watches: Watch[]) {
  mkdirSync(dirname(WATCH_FILE), { recursive: true });
  writeFileSync(`${WATCH_FILE}.tmp`, JSON.stringify({ watches }, null, 2));
  renameSync(`${WATCH_FILE}.tmp`, WATCH_FILE);
}

/** The bookable times matching a watch, one entry per clinic, day and time. */
export function matching(watch: Criteria, slots: Slot[], day = today()) {
  const found = slots
    .filter(s => s.date != null && s.date >= day && (!watch.before || s.date <= watch.before) &&
      (watch.max_price == null || (s.price_eur != null && s.price_eur <= watch.max_price)) &&
      (watch.max_km == null || s.distance_km == null || s.distance_km <= watch.max_km))
    .flatMap(slot => (slot.times.length ? slot.times : [""]).map(time => ({ key: `${slot.clinic_id}|${slot.date}|${time}`, time, slot })));
  return [...new Map(found.map(f => [f.key, f])).values()];
}

/** Times not visible at the previous check, grouped per clinic and day. A time booked and then freed again counts as new. */
export function fresh(found: ReturnType<typeof matching>, seen: string[]) {
  const before = new Set(seen);
  const cards = new Map<string, { slot: Slot; times: string[] }>();
  for (const f of found.filter(f => !before.has(f.key))) {
    const card = cards.get(`${f.slot.clinic_id}|${f.slot.date}`) ?? { slot: f.slot, times: [] };
    if (f.time) card.times.push(f.time);
    cards.set(`${f.slot.clinic_id}|${f.slot.date}`, card);
  }
  return [...cards.values()].map(({ slot, times }) => ({
    service: slot.service,
    clinic: slot.clinic,
    date: slot.date,
    times,
    price_eur: slot.price_eur,
    distance_km: slot.distance_km,
    slot_id: slot.slot_id,
    booking_url: slot.booking_url
  }));
}

async function slotsFor(watch: Criteria, signal: AbortSignal) {
  const target = { serviceIds: watch.service_ids, city: watch.city };
  const slots: Slot[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const found = await getAvailability(target, page, "", SORT.date, signal);
    slots.push(...found);
    if (found.length === 0 || (watch.before && (found.at(-1)?.date ?? "") > watch.before)) break;
  }
  // Cheap slots can sit beyond the chronological pages
  if (watch.max_price != null) slots.push(...(await getAvailability(target, 1, "", SORT.price, signal)));
  return slots;
}

/** Checks one watch in place: returns the new times and stores what is visible now. */
async function check(watch: Watch, signal: AbortSignal) {
  const slots = await slotsFor(watch, signal);
  const found = matching(watch, slots);
  const news = fresh(found, watch.seen);
  watch.seen = found.map(f => f.key);
  watch.last_check = new Date().toISOString();
  if (!watch.label) watch.label = `${slots.find(s => s.service)?.service ?? watch.service_ids.join(" + ")} – ${watch.city}`;
  return news;
}

const summary = ({ seen, ...watch }: Watch) => ({ ...watch, matching_times_now: seen.length });

export async function addWatch(criteria: Criteria, label: string | undefined, signal: AbortSignal) {
  const watch: Watch = { id: randomUUID().slice(0, 8), label: label ?? "", ...criteria, created: new Date().toISOString(), last_check: null, seen: [] };
  const availableNow = await check(watch, signal);
  save([...load(), watch]);
  return { watch: summary(watch), available_now: availableNow };
}

export const listWatches = () => load().map(summary);

export function removeWatch(id: string) {
  const watches = load();
  const kept = watches.filter(w => w.id !== id);
  if (kept.length === watches.length) throw new Error(`No watch with id '${id}': cup24_watch_list shows the ids.`);
  save(kept);
}

/** Checks the given watches (all by default); a failing watch reports its error and does not stop the others. */
export async function checkWatches(ids: string[] | undefined, signal: AbortSignal) {
  const checked = new Map<string, Watch>();
  const results = [];
  for (const watch of load().filter(w => !ids || ids.includes(w.id))) {
    try {
      results.push({ id: watch.id, label: watch.label, new_slots: await check(watch, signal) });
    } catch (error) {
      results.push({ id: watch.id, label: watch.label, error: (error as Error).message });
    }
    checked.set(watch.id, watch);
  }
  // Reload before saving: alerts added or removed (e.g. from the MCP server) while checking must survive
  save(load().map(w => checked.get(w.id) ?? w));
  return results;
}

/** `cup24-mcp-server check`: for a scheduler like launchd or cron. Prints new times and shows a macOS notification. */
export async function runCheck() {
  const results = await checkWatches(undefined, AbortSignal.timeout(300_000));
  if (results.length === 0) console.log(`No watches in ${WATCH_FILE}: create one with cup24_watch_add.`);
  for (const r of results) {
    if ("error" in r) console.error(`${r.label}: ${r.error}`);
    if (!r.new_slots?.length) continue;
    const lines = r.new_slots.map(s => `${s.date} ${s.times.slice(0, 3).join(" ")} ${s.clinic}${s.price_eur != null ? ` ${s.price_eur}€` : ""}`);
    console.log(`${r.label}\n  ${lines.join("\n  ")}`);
    if (process.platform === "darwin") {
      const text = JSON.stringify(lines.slice(0, 3).join("; ")); // AppleScript strings accept JSON's escapes
      execFileSync("osascript", ["-e", `display notification ${text} with title ${JSON.stringify(`cup24: ${r.label}`)}`]);
    }
  }
  if (results.some(r => "error" in r)) process.exitCode = 1;
}
