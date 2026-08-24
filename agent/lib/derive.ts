// Everything computed rather than extracted: evidence windowing, the Access
// Friction Index, peer-group outlier detection, and the snapshot differ.
//
// The split matters. Anything a model states about a state is extraction and
// must carry a citation. Anything Coverage Atlas asserts *across* states —
// friction scores, outliers, deltas — is arithmetic over those citations, and is
// reproducible from the stored snapshots without calling a model at all.

import { createHash } from "node:crypto"
import {
  FRICTION_WEIGHTS,
  PEER_OF,
  type ChangeEvent,
  type CoverageRecord,
  type CoverageStatus,
  type FrictionFlag,
  type PolicyVersion,
  type RecordGap,
} from "./types"

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32)
}

/**
 * Cut a long document down to the passages that actually mention the thing we
 * are asking about.
 *
 * This is the single largest token saving in the pipeline. A state preferred-drug
 * list is 60-120k characters of tables for hundreds of drugs; the eight passages
 * that mention semaglutide are perhaps 5k. Sending the whole document to a model
 * 51 times is how a naive scanner burns a million prompt tokens per condition.
 */
export function windowText(text: string, terms: string[], opts: { radius?: number; maxWindows?: number } = {}): string {
  const radius = opts.radius ?? 1100
  const maxWindows = opts.maxWindows ?? 8
  if (!text) return ""
  if (text.length <= radius * 2) return text

  const haystack = text.toLowerCase()
  const hits: number[] = []
  for (const term of terms) {
    const needle = term.toLowerCase().trim()
    if (needle.length < 3) continue
    let from = 0
    while (hits.length < maxWindows * 4) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      hits.push(at)
      from = at + needle.length
    }
  }
  if (hits.length === 0) return text.slice(0, radius * 2)

  // Merge overlapping windows so a dense cluster of hits reads as one passage.
  const spans: [number, number][] = []
  for (const at of hits.sort((a, b) => a - b)) {
    const start = Math.max(0, at - radius)
    const end = Math.min(text.length, at + radius)
    const last = spans[spans.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else spans.push([start, end])
  }

  return spans
    .slice(0, maxWindows)
    .map(([s, e]) => text.slice(s, e))
    .join("\n\n[...]\n\n")
}

/** Rough but stable token estimate — used only for the savings ledger, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * The Access Friction Index: 0 (walk into a pharmacy) to 100 (no pathway).
 *
 * Weights are additive and then squashed, so the first two gates move the number
 * a lot and the seventh moves it a little — which matches how access actually
 * fails. A patient stopped by prior authorization is stopped; a quantity limit
 * on top of that changes their life much less than the first barrier did.
 */
export function frictionIndex(status: CoverageStatus, flags: FrictionFlag[]): number {
  if (status === "not_covered") return 100
  if (status === "unpublished") return 92 // no published pathway is not the same as a refusal, but it is close
  const raw = [...new Set(flags)].reduce((sum, flag) => sum + (FRICTION_WEIGHTS[flag] ?? 0), 0)
  const squashed = 100 * (1 - Math.exp(-raw / 55))
  const floor = status === "limited" ? 30 : status === "conditional" ? 18 : 0
  return Math.round(Math.max(squashed, floor))
}

export function accessScore(record: Pick<CoverageRecord, "status" | "frictionIndex">): number {
  if (record.status === "not_covered" || record.status === "unpublished") return 0
  return Math.max(0, 100 - record.frictionIndex)
}

export type Outlier = {
  state: string
  stateName: string
  kind: "easiest" | "hardest" | "peer_outlier" | "recently_changed"
  headline: string
  detail: string
}

/**
 * What stands out — computed, not curated. National extremes first, then the
 * state that diverges most from its own census division, which is the finding
 * providers actually react to: neighbouring states with similar budgets and
 * similar populations landing thirty friction points apart.
 */
export function findOutliers(records: CoverageRecord[], changes: ChangeEvent[]): Outlier[] {
  const usable = records.filter((r) => r.status !== "unpublished")
  if (usable.length < 4) return []

  const out: Outlier[] = []
  const byAccess = [...usable].sort((a, b) => b.accessScore - a.accessScore)
  const easiest = byAccess[0]
  const hardest = [...usable].filter((r) => r.status !== "not_covered").sort((a, b) => b.frictionIndex - a.frictionIndex)[0]

  const covering = records.filter((r) => r.status === "covered" || r.status === "conditional").length
  out.push({
    state: easiest.state,
    stateName: easiest.stateName,
    kind: "easiest",
    headline: "Lowest friction in the country",
    detail:
      `${easiest.stateName} scores ${easiest.accessScore}/100 for access` +
      (easiest.frictionFlags.length === 0
        ? " with no documented administrative gate at all."
        : ` behind only ${easiest.frictionFlags.length} documented gate${easiest.frictionFlags.length === 1 ? "" : "s"}.`) +
      ` ${covering} of ${records.length} jurisdictions have any pathway.`,
  })

  if (hardest && hardest.state !== easiest.state) {
    out.push({
      state: hardest.state,
      stateName: hardest.stateName,
      kind: "hardest",
      headline: "Covered on paper, hardest in practice",
      detail: `${hardest.stateName} reports coverage but stacks ${hardest.frictionFlags.length} gates, landing at ${hardest.frictionIndex}/100 friction — ${hardest.frictionIndex - easiest.frictionIndex} points above ${easiest.stateName}.`,
    })
  }

  // Divergence from the state's own census-division peers.
  const byPeer = new Map<string, CoverageRecord[]>()
  for (const r of usable) {
    const region = PEER_OF[r.state]
    if (!region) continue
    byPeer.set(region, [...(byPeer.get(region) ?? []), r])
  }
  let widest: { record: CoverageRecord; gap: number; region: string; peerMean: number } | null = null
  for (const [region, group] of byPeer) {
    if (group.length < 3) continue
    const mean = group.reduce((s, r) => s + r.frictionIndex, 0) / group.length
    for (const r of group) {
      const gap = Math.abs(r.frictionIndex - mean)
      if (!widest || gap > widest.gap) widest = { record: r, gap, region, peerMean: mean }
    }
  }
  if (widest && widest.gap >= 12) {
    const harder = widest.record.frictionIndex > widest.peerMean
    out.push({
      state: widest.record.state,
      stateName: widest.record.stateName,
      kind: "peer_outlier",
      headline: `Breaks from the ${widest.region}`,
      detail: `${widest.record.stateName} sits ${Math.round(widest.gap)} friction points ${harder ? "above" : "below"} its ${widest.region} peers (regional mean ${Math.round(widest.peerMean)}). Same region, same neighbours, different answer for the patient.`,
    })
  }

  const recent = changes.filter((c) => c.direction !== "stable" && c.direction !== "clarified")[0]
  if (recent) {
    out.push({
      state: recent.state,
      stateName: recent.stateName,
      kind: "recently_changed",
      headline: recent.direction === "coverage_dropped" || recent.direction === "tightened" ? "Access tightened" : "Access widened",
      detail: recent.headline,
    })
  }

  return out.slice(0, 4)
}

const STATUS_RANK: Record<CoverageStatus, number> = {
  covered: 4,
  conditional: 3,
  limited: 2,
  not_covered: 1,
  unpublished: 0,
}

/**
 * Diff two snapshots into change events.
 *
 * Medicaid publishes no change feed anywhere in the country — the delta has to be
 * computed by holding two observations of fifty independent sources side by side.
 * That is the whole reason this needs a live scanner rather than a dataset.
 *
 * Both a status move and a friction move count, because "still covered, now with
 * step therapy" is a real access event that a status-only differ reports as
 * nothing happening. A friction move under 6 points is treated as extraction
 * noise, not policy.
 */
export function diffSnapshots(
  before: CoverageRecord[],
  after: CoverageRecord[],
  detectedAt: string,
): ChangeEvent[] {
  const prior = new Map(before.map((r) => [r.state, r]))
  const events: ChangeEvent[] = []

  for (const now of after) {
    const was = prior.get(now.state)
    if (!was) continue
    if (was.status === now.status && Math.abs(now.frictionIndex - was.frictionIndex) < 6) continue

    const frictionDelta = now.frictionIndex - was.frictionIndex
    const statusMoved = was.status !== now.status
    const rankDelta = STATUS_RANK[now.status] - STATUS_RANK[was.status]

    let direction: ChangeEvent["direction"]
    let headline: string
    if (statusMoved && STATUS_RANK[was.status] > 1 && STATUS_RANK[now.status] <= 1) {
      direction = "coverage_dropped"
      headline = `${now.stateName} ended its coverage pathway`
    } else if (statusMoved && STATUS_RANK[was.status] <= 1 && STATUS_RANK[now.status] > 1) {
      direction = "coverage_added"
      headline = `${now.stateName} opened a coverage pathway`
    } else if (frictionDelta < 0 || rankDelta > 0) {
      direction = "loosened"
      headline = `${now.stateName} eased access by ${Math.abs(frictionDelta)} friction points`
    } else {
      direction = "tightened"
      headline = `${now.stateName} tightened access by ${frictionDelta} friction points`
    }

    const gained = now.frictionFlags.filter((f) => !was.frictionFlags.includes(f))
    const lost = was.frictionFlags.filter((f) => !now.frictionFlags.includes(f))
    const detailParts = [
      statusMoved ? `Status moved from ${was.status.replace("_", " ")} to ${now.status.replace("_", " ")}.` : null,
      gained.length ? `Added: ${gained.join(", ").replace(/_/g, " ")}.` : null,
      lost.length ? `Removed: ${lost.join(", ").replace(/_/g, " ")}.` : null,
    ].filter(Boolean)

    events.push({
      id: `${now.state}-${direction}-${detectedAt.slice(0, 10)}`,
      state: now.state,
      stateName: now.stateName,
      direction,
      headline,
      detail: detailParts.join(" ") || null,
      fromStatus: was.status,
      toStatus: now.status,
      frictionDelta,
      announcedOn: now.effectiveDate ?? detectedAt.slice(0, 10),
      effectiveOn: now.effectiveDate,
      sourceDoc: now.sourceDoc,
      sourceUrl: now.sourceUrl,
      provenance: "observed",
      detectedAt,
    })
  }

  return events.sort((a, b) => Math.abs(b.frictionDelta) - Math.abs(a.frictionDelta))
}


/* ------------------------------------------------------------------- gaps */

/**
 * What a record is still missing.
 *
 * This is the scan's to-do list and its stop condition in one function. The
 * orchestrator backfills against it and finishes early when it comes back empty
 * for every jurisdiction — at which point there is genuinely nothing left worth
 * spending a call on.
 *
 * `no_history` is deliberately not counted as a blocking gap for a state we have
 * otherwise answered well: plenty of states simply have not changed their policy,
 * and an absence of history is a legitimate finding rather than a hole.
 */
export function gapsFor(record: CoverageRecord): RecordGap[] {
  const gaps: RecordGap[] = []
  if (record.status === "unpublished") gaps.push("no_policy_found")
  if (!record.sourceUrl) gaps.push("no_source")
  if (!record.effectiveDate && !record.documentDate) gaps.push("no_timestamp")
  if (!record.criteriaVerbatim && !record.criteriaSummary) gaps.push("no_criteria")
  return gaps
}

/** Blocking gaps only — what the stop condition actually waits on. */
export function isRecordComplete(record: CoverageRecord): boolean {
  return gapsFor(record).length === 0
}

/** Worst-first, so a limited budget is spent where it changes the map most. */
export function prioritiseGaps(records: CoverageRecord[]): CoverageRecord[] {
  const weight = (r: CoverageRecord) => {
    const gaps = gapsFor(r)
    return (
      (gaps.includes("no_policy_found") ? 100 : 0) +
      (gaps.includes("no_source") ? 40 : 0) +
      (gaps.includes("no_timestamp") ? 25 : 0) +
      (gaps.includes("no_criteria") ? 15 : 0)
    )
  }
  return records.filter((r) => gapsFor(r).length > 0).sort((a, b) => weight(b) - weight(a))
}

/* ---------------------------------------------------------------- history */

/** Chronological, current version last, one entry per (effective date, status). */
export function sortHistory(versions: PolicyVersion[]): PolicyVersion[] {
  const key = (v: PolicyVersion) => v.effectiveDate ?? v.documentDate ?? ""
  const seen = new Set<string>()
  return versions
    .filter((v) => {
      const id = `${key(v)}|${v.status}|${v.frictionFlags.slice().sort().join(",")}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    .sort((a, b) => key(a).localeCompare(key(b)))
}

/**
 * Change events derived from dated versions found inside a single scan.
 *
 * This is what lets a first scan say anything about change at all. Medicaid
 * publishes no change feed, but its documents are full of dated self-reference —
 * a bulletin announcing a new rule states the old one, a superseded drug list
 * carries the date it stopped applying. Walking a state's versions in order and
 * diffing adjacent pairs turns that into a timeline.
 *
 * Marked `historical` rather than `observed`: we read two dated versions of the
 * state's own policy and compared them, which is a stronger claim than a news
 * headline and a weaker one than having watched it change ourselves.
 */
export function changesFromHistory(records: CoverageRecord[], detectedAt: string): ChangeEvent[] {
  const events: ChangeEvent[] = []

  for (const record of records) {
    const history = sortHistory(record.history ?? [])
    if (history.length < 2) continue

    for (let i = 1; i < history.length; i++) {
      const was = history[i - 1]
      const now = history[i]
      const frictionDelta = now.frictionIndex - was.frictionIndex
      if (was.status === now.status && Math.abs(frictionDelta) < 6) continue

      const rankDelta = STATUS_RANK[now.status] - STATUS_RANK[was.status]
      let direction: ChangeEvent["direction"]
      let headline: string
      if (STATUS_RANK[was.status] > 1 && STATUS_RANK[now.status] <= 1) {
        direction = "coverage_dropped"
        headline = `${record.stateName} ended its coverage pathway`
      } else if (STATUS_RANK[was.status] <= 1 && STATUS_RANK[now.status] > 1) {
        direction = "coverage_added"
        headline = `${record.stateName} opened a coverage pathway`
      } else if (frictionDelta < 0 || rankDelta > 0) {
        direction = "loosened"
        headline = `${record.stateName} eased access by ${Math.abs(frictionDelta)} friction points`
      } else {
        direction = "tightened"
        headline = `${record.stateName} tightened access by ${frictionDelta} friction points`
      }

      const gained = now.frictionFlags.filter((f) => !was.frictionFlags.includes(f))
      const lost = was.frictionFlags.filter((f) => !now.frictionFlags.includes(f))
      const when = now.effectiveDate ?? now.documentDate ?? detectedAt.slice(0, 10)

      events.push({
        id: `${record.state}-${direction}-${when}`,
        state: record.state,
        stateName: record.stateName,
        direction,
        headline,
        detail: [
          was.status !== now.status
            ? `Status moved from ${was.status.replace(/_/g, " ")} to ${now.status.replace(/_/g, " ")}.`
            : null,
          gained.length ? `Added: ${gained.join(", ").replace(/_/g, " ")}.` : null,
          lost.length ? `Removed: ${lost.join(", ").replace(/_/g, " ")}.` : null,
          was.criteriaVerbatim && now.criteriaVerbatim ? `Criteria language was rewritten.` : null,
        ]
          .filter(Boolean)
          .join(" ") || null,
        fromStatus: was.status,
        toStatus: now.status,
        frictionDelta,
        announcedOn: now.documentDate ?? when,
        effectiveOn: now.effectiveDate,
        sourceDoc: now.sourceDoc,
        sourceUrl: now.sourceUrl,
        provenance: "historical",
        detectedAt,
      })
    }
  }

  return events.sort((a, b) => (b.announcedOn ?? "").localeCompare(a.announcedOn ?? ""))
}

/** The dated versions behind one state, newest first — what the compare view shows. */
export function historyFor(record: CoverageRecord | undefined): PolicyVersion[] {
  if (!record) return []
  return sortHistory(record.history ?? []).reverse()
}
