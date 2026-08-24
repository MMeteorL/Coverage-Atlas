// Snapshot store. Plain JSON on disk, one immutable file per scan.
//
// Deltas are the product, so history has to be first-class rather than a
// mutable "current" row that overwrites what it replaces. Every scan appends a
// file; the differ reads two of them. It is also the cheapest possible way to
// ship a demo that opens with complete data — the seed scan is committed.

import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises"
import path from "node:path"
import type { ChangeEvent, ConditionSpec, RunLedger, Snapshot } from "./types"

export const DATA_DIR = path.join(process.cwd(), "data")
const conditionsFile = () => path.join(DATA_DIR, "conditions.json")
const snapshotDir = (slug: string) => path.join(DATA_DIR, "snapshots", slug)
const changesFile = (slug: string) => path.join(DATA_DIR, "changes", `${slug}.json`)
const runsFile = () => path.join(DATA_DIR, "runs.jsonl")

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}

export async function listConditions(): Promise<ConditionSpec[]> {
  const all = await readJson<ConditionSpec[]>(conditionsFile(), [])
  return all.sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name))
}

export async function getCondition(slug: string): Promise<ConditionSpec | null> {
  return (await listConditions()).find((c) => c.slug === slug) ?? null
}

/** Saving is idempotent: rescanning a condition updates its spec, never duplicates it. */
export async function saveCondition(spec: ConditionSpec): Promise<ConditionSpec> {
  const all = await readJson<ConditionSpec[]>(conditionsFile(), [])
  const at = all.findIndex((c) => c.slug === spec.slug)
  if (at >= 0) all[at] = { ...all[at], ...spec, createdAt: all[at].createdAt }
  else all.push(spec)
  await writeJson(conditionsFile(), all)
  return spec
}

/** Built-in conditions are the demo's floor and cannot be removed. */
export async function deleteCondition(slug: string): Promise<boolean> {
  const all = await readJson<ConditionSpec[]>(conditionsFile(), [])
  const target = all.find((c) => c.slug === slug)
  if (!target || target.builtIn) return false
  await writeJson(conditionsFile(), all.filter((c) => c.slug !== slug))
  return true
}

/** Snapshot file names are ISO timestamps, so lexical order is chronological order. */
export async function listSnapshotStamps(slug: string): Promise<string[]> {
  try {
    const files = await readdir(snapshotDir(slug))
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort()
  } catch {
    return []
  }
}

export async function readSnapshot(slug: string, stamp?: string): Promise<Snapshot | null> {
  const stamps = await listSnapshotStamps(slug)
  if (stamps.length === 0) return null
  const pick = stamp && stamps.includes(stamp) ? stamp : stamps[stamps.length - 1]
  return readJson<Snapshot | null>(path.join(snapshotDir(slug), `${pick}.json`), null)
}

/** File-name form of an instant: `2026-08-23T18:45:12.345Z` -> `2026-08-23T18-45-12-345Z`. */
export function toStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-")
}

/**
 * The newest snapshot at or before `at` — how the "view date" control time-travels.
 *
 * `at` may be a stamp, a full ISO instant, or a bare `YYYY-MM-DD`. All three are
 * normalised into stamp space before comparing, because stamps and ISO strings
 * do not sort against each other: `-` sorts below `:`, so a raw lexical compare
 * of the two forms silently mis-orders snapshots taken on the same day.
 */
export async function readSnapshotAsOf(slug: string, at: string): Promise<Snapshot | null> {
  const stamps = await listSnapshotStamps(slug)
  if (stamps.length === 0) return null
  const cutoff = toStamp(at)
  const eligible = stamps.filter((s) => s <= cutoff)
  // Asking for a date before the first scan yields the earliest we have, so the
  // view degrades to "the oldest thing we know" rather than to an empty map.
  return readSnapshot(slug, eligible[eligible.length - 1] ?? stamps[0])
}

export async function writeSnapshot(snapshot: Snapshot): Promise<string> {
  const stamp = snapshot.scannedAt.replace(/[:.]/g, "-")
  await writeJson(path.join(snapshotDir(snapshot.conditionSlug), `${stamp}.json`), snapshot)
  return stamp
}

/**
 * Patch one record inside the newest snapshot, in place.
 *
 * Used only by "check again now". Snapshots are otherwise immutable, but a
 * live re-verification is an observation of the *current* state of the world,
 * so it belongs in the current snapshot rather than opening a new one — a
 * fifty-first snapshot containing one refreshed state would corrupt the differ.
 */
export async function patchLatestRecord(
  slug: string,
  record: import("./types").CoverageRecord,
): Promise<Snapshot | null> {
  const stamps = await listSnapshotStamps(slug)
  if (stamps.length === 0) return null
  const stamp = stamps[stamps.length - 1]
  const file = path.join(snapshotDir(slug), `${stamp}.json`)
  const snapshot = await readJson<Snapshot | null>(file, null)
  if (!snapshot) return null
  snapshot.records = snapshot.records.map((r) => (r.state === record.state ? record : r))
  await writeJson(file, snapshot)
  return snapshot
}

export async function readChanges(slug: string): Promise<ChangeEvent[]> {
  return readJson<ChangeEvent[]>(changesFile(slug), [])
}

/**
 * Merge new events into the feed, keyed on state+direction+date so a rescan that
 * re-reads the same public announcement does not produce a duplicate alert.
 */
export async function mergeChanges(slug: string, incoming: ChangeEvent[]): Promise<ChangeEvent[]> {
  const existing = await readChanges(slug)
  const byKey = new Map(existing.map((e) => [e.id, e]))
  for (const event of incoming) byKey.set(event.id, { ...byKey.get(event.id), ...event })
  const merged = [...byKey.values()].sort((a, b) =>
    (b.announcedOn ?? b.detectedAt).localeCompare(a.announcedOn ?? a.detectedAt),
  )
  await writeJson(changesFile(slug), merged)
  return merged
}

export async function appendRun(ledger: RunLedger): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await appendFile(runsFile(), JSON.stringify(ledger) + "\n", "utf8")
}

export async function readRuns(limit = 40): Promise<RunLedger[]> {
  try {
    const lines = (await readFile(runsFile(), "utf8")).trim().split("\n").filter(Boolean)
    return lines.slice(-limit).map((l) => JSON.parse(l) as RunLedger).reverse()
  } catch {
    return []
  }
}
