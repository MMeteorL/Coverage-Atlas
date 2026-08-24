// The orchestrator.
//
// It owns the plan, the budget and the merge; it does not own any extraction.
// Its whole job is to decide how little work the scan can get away with and
// still be right, then to hand each remaining piece to a subagent that knows
// nothing except its own state.
//
// The shape of the saving, in order of size:
//
//   1. One tracker read answers most of the country. Discovery is biased toward
//      documents that address many states at once precisely so that a single
//      normalisation call settles thirty-five to forty-five jurisdictions.
//   2. Only the residue is fanned out. States the baseline answered with high
//      confidence never get a per-state call at all.
//   3. Evidence hashing makes re-scans nearly free. A state whose source document
//      has not changed since the last scan costs zero model tokens.
//   4. Windowing cuts each remaining document from ~25k tokens to ~2k before a
//      model ever sees it.
//   5. Two-tier routing: the handful of judgement calls go to the strong model,
//      the volume of mechanical transcription goes to the cheap one.
//
// The ledger at the end of every run reports what this actually saved against a
// naive whole-document-per-state loop, because a claim about efficiency that
// isn't measured is just a claim.

import { ledger, modelFor } from "./lib/llm"
import { diffSnapshots, findOutliers, frictionIndex } from "./lib/derive"
import {
  appendRun,
  getCondition,
  listConditions,
  mergeChanges,
  readSnapshot,
  saveCondition,
  writeSnapshot,
} from "./lib/store"
import {
  STATES,
  STATE_FIPS,
  STATE_NAMES,
  type ConditionSpec,
  type CoverageRecord,
  type RunLedger,
  type Snapshot,
} from "./lib/types"
import { resolveCondition } from "./phases/resolve"
import { discoverSources } from "./phases/discover"
import { buildBaseline, type BaselineRow } from "./phases/baseline"
import { runSubagent } from "./phases/subagent"
import { discoverReportedChanges } from "./phases/changes"

export type ScanEvent =
  | { type: "phase"; phase: string; note: string }
  | { type: "condition"; spec: ConditionSpec }
  | { type: "plan"; total: number; fromBaseline: number; toFanOut: number }
  | { type: "state"; record: CoverageRecord; done: number; total: number }
  | { type: "changes"; observed: number; reported: number }
  | { type: "complete"; snapshotStamp: string; ledger: RunLedger; outliers: ReturnType<typeof findOutliers> }
  | { type: "error"; message: string }

export type ScanOptions = {
  /** Free text from the user, or the slug of a saved condition. */
  condition: string
  /**
   * baseline — trackers only. Seconds, near-free, thinner criteria.
   * standard — fan out to whatever the baseline left thin. The default.
   * deep     — fan out to all 51 regardless. Slowest, best verbatim coverage.
   */
  depth?: "baseline" | "standard" | "deep"
  /** Ceiling on metered browser runs. The only rung of the ladder that costs money. */
  agentBudget?: number
  /** Concurrency. Waves of 5 matches TinyFish's plan-based limits. */
  waveSize?: number
  changeWindowDays?: number
  onEvent?: (event: ScanEvent) => void
}

const ALL_STATES = STATES.map(([, , code]) => code)

export async function scan(opts: ScanOptions): Promise<{ snapshot: Snapshot; ledger: RunLedger }> {
  const depth = opts.depth ?? "standard"
  const waveSize = opts.waveSize ?? 5
  const agentBudget = { remaining: opts.agentBudget ?? 6 }
  const emit = (e: ScanEvent) => opts.onEvent?.(e)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  ledger.reset()

  const run: RunLedger = {
    runId: `run_${t0.toString(36)}`,
    conditionSlug: "",
    startedAt,
    finishedAt: null,
    durationMs: 0,
    tinyfishSearches: 0,
    tinyfishFetches: 0,
    tinyfishAgentRuns: 0,
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    statesFromBaseline: 0,
    statesShortCircuited: 0,
    statesEscalated: 0,
    naivePromptTokensEstimate: 0,
    errors: [],
  }

  try {
    // Phase 0 — resolve. A saved condition skips the model call entirely.
    emit({ type: "phase", phase: "resolve", note: `Interpreting "${opts.condition}"` })
    const saved = (await getCondition(opts.condition)) ?? (await matchSaved(opts.condition))
    const spec = saved ?? (await resolveCondition(opts.condition))
    run.conditionSlug = spec.slug
    await saveCondition(spec)
    emit({ type: "condition", spec })
    emit({
      type: "phase",
      phase: "resolve",
      note: `${spec.name} · ${spec.treatmentClass} — ${spec.policyLever}`,
    })

    const previous = await readSnapshot(spec.slug)
    const prior = new Map((previous?.records ?? []).map((r) => [r.state, r]))

    // Phase 1 — discover sources.
    emit({ type: "phase", phase: "discover", note: "Searching for multi-state policy trackers" })
    const discovery = await discoverSources(spec, (n) => emit({ type: "phase", phase: "discover", note: n }))
    run.tinyfishSearches += discovery.searches

    // Phase 2 — one read, fifty answers.
    emit({ type: "phase", phase: "baseline", note: "Reading trackers" })
    const baseline = await buildBaseline(spec, discovery.sources, previous?.records ?? [], (n) =>
      emit({ type: "phase", phase: "baseline", note: n }),
    )
    run.tinyfishFetches += baseline.fetches
    run.naivePromptTokensEstimate += baseline.naiveTokens

    // Plan: which states still need their own subagent.
    const needsWork = ALL_STATES.filter((code) => {
      if (depth === "deep") return true
      if (depth === "baseline") return false
      const row = baseline.rows.get(code)
      return !row || row.confidence !== "high" || !row.criteriaVerbatim
    })
    const settled = ALL_STATES.filter((c) => !needsWork.includes(c))
    run.statesFromBaseline = settled.length
    emit({ type: "plan", total: ALL_STATES.length, fromBaseline: settled.length, toFanOut: needsWork.length })
    emit({
      type: "phase",
      phase: "plan",
      note: `${settled.length} jurisdictions settled by the shared read; ${needsWork.length} go to per-state subagents`,
    })

    const records = new Map<string, CoverageRecord>()
    let done = 0

    // States the baseline settled: promote the row straight to a record.
    for (const code of settled) {
      const row = baseline.rows.get(code)
      const record = row
        ? rowToRecord(code, row)
        : unpublishedRecord(code, spec.treatmentClass)
      records.set(code, record)
      done++
      emit({ type: "state", record, done, total: ALL_STATES.length })
    }

    // Phase 3 — fan out. Waves of `waveSize`, isolated per state, failures contained.
    emit({ type: "phase", phase: "fanout", note: `Fanning out ${needsWork.length} states in waves of ${waveSize}` })
    for (let i = 0; i < needsWork.length; i += waveSize) {
      const wave = needsWork.slice(i, i + waveSize)
      const results = await Promise.allSettled(
        wave.map((code) =>
          runSubagent({
            state: code,
            spec,
            baseline: baseline.rows.get(code),
            prior: prior.get(code),
            agentBudget,
            onProgress: (note) => emit({ type: "phase", phase: "fanout", note }),
          }),
        ),
      )
      for (let j = 0; j < results.length; j++) {
        const code = wave[j]
        const settledResult = results[j]
        let record: CoverageRecord
        if (settledResult.status === "fulfilled") {
          const out = settledResult.value
          record = out.record
          run.tinyfishSearches += out.searches
          run.tinyfishFetches += out.fetches
          run.tinyfishAgentRuns += out.agentRuns
          run.naivePromptTokensEstimate += out.naiveTokens * 1 // one whole-doc read per state
          if (out.shortCircuited) run.statesShortCircuited++
          if (out.agentRuns > 0) run.statesEscalated++
        } else {
          // One state failing must never cost us the other fifty.
          run.errors.push(`${code}: ${String(settledResult.reason).slice(0, 160)}`)
          const row = baseline.rows.get(code)
          record = row ? rowToRecord(code, row) : (prior.get(code) ?? unpublishedRecord(code, spec.treatmentClass))
        }
        records.set(code, record)
        done++
        emit({ type: "state", record, done, total: ALL_STATES.length })
      }
    }

    const allRecords = ALL_STATES.map((c) => records.get(c)!).filter(Boolean)

    // Phase 4 — the delta. Observed beats reported where both exist.
    emit({ type: "phase", phase: "changes", note: "Computing deltas and searching for dated announcements" })
    const observed = previous ? diffSnapshots(previous.records, allRecords, new Date().toISOString()) : []
    let reported: Awaited<ReturnType<typeof discoverReportedChanges>> = { events: [], searches: 0 }
    try {
      reported = await discoverReportedChanges(spec, opts.changeWindowDays ?? 180, (n) =>
        emit({ type: "phase", phase: "changes", note: n }),
      )
      run.tinyfishSearches += reported.searches
    } catch (err) {
      run.errors.push(`reported changes: ${String(err).slice(0, 160)}`)
    }
    const changes = await mergeChanges(spec.slug, [...reported.events, ...observed])
    emit({ type: "changes", observed: observed.length, reported: reported.events.length })

    // Phase 5 — write the snapshot and close the ledger.
    run.llmCalls = ledger.calls
    run.promptTokens = ledger.promptTokens
    run.completionTokens = ledger.completionTokens
    run.durationMs = Date.now() - t0
    run.finishedAt = new Date().toISOString()

    const snapshot: Snapshot = {
      conditionSlug: spec.slug,
      scannedAt: run.finishedAt,
      records: allRecords,
      sources: [...baseline.used, ...discovery.sources.filter((s) => !baseline.used.some((u) => u.url === s.url)).slice(0, 4)],
      ledger: run,
    }
    const stamp = await writeSnapshot(snapshot)
    await appendRun(run)

    emit({
      type: "complete",
      snapshotStamp: stamp,
      ledger: run,
      outliers: findOutliers(allRecords, changes),
    })
    return { snapshot, ledger: run }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    run.errors.push(message)
    run.durationMs = Date.now() - t0
    run.finishedAt = new Date().toISOString()
    await appendRun(run)
    emit({ type: "error", message })
    throw err
  }
}

/** Let "obesity" find a saved condition named "Obesity" without paying for a resolve call. */
async function matchSaved(input: string): Promise<ConditionSpec | null> {
  const needle = input.trim().toLowerCase()
  if (needle.length < 3) return null
  const all = await listConditions()
  return (
    all.find((c) => c.name.toLowerCase() === needle || c.userInput.trim().toLowerCase() === needle) ?? null
  )
}

function rowToRecord(code: string, row: BaselineRow): CoverageRecord {
  const flags = row.frictionFlags as CoverageRecord["frictionFlags"]
  const status = row.status === "covered" && flags.includes("prior_authorization") ? "conditional" : row.status
  const friction = frictionIndex(status, flags)
  return {
    state: code,
    stateName: STATE_NAMES[code],
    fips: STATE_FIPS[code],
    program: "medicaid_ffs",
    status,
    authorization: flags.includes("step_therapy")
      ? "step_therapy"
      : flags.includes("prior_authorization")
        ? "prior_authorization"
        : "none",
    frictionFlags: flags,
    frictionIndex: friction,
    accessScore: status === "not_covered" || status === "unpublished" ? 0 : Math.max(0, 100 - friction),
    criteriaSummary: row.criteriaSummary,
    criteriaVerbatim: row.criteriaVerbatim,
    administeringEntity: null,
    sourceDoc: row.sourceDoc,
    sourceUrl: row.sourceUrl,
    effectiveDate: row.effectiveDate,
    confidence: row.confidence,
    method: "baseline",
    lastCheckedAt: new Date().toISOString(),
    evidenceHash: null,
    notes: null,
  }
}

function unpublishedRecord(code: string, treatmentClass: string): CoverageRecord {
  return {
    state: code,
    stateName: STATE_NAMES[code],
    fips: STATE_FIPS[code],
    program: "medicaid_ffs",
    status: "unpublished",
    authorization: "none",
    frictionFlags: [],
    frictionIndex: 92,
    accessScore: 0,
    criteriaSummary: `No published fee-for-service policy for ${treatmentClass} was found in this scan.`,
    criteriaVerbatim: null,
    administeringEntity: null,
    sourceDoc: null,
    sourceUrl: null,
    effectiveDate: null,
    confidence: "review_needed",
    method: "search",
    lastCheckedAt: new Date().toISOString(),
    evidenceHash: null,
    notes: null,
  }
}

export function ledgerSummary(run: RunLedger): string {
  const saved = run.naivePromptTokensEstimate - run.promptTokens
  const ratio = run.promptTokens > 0 ? run.naivePromptTokensEstimate / run.promptTokens : 0
  return [
    `run ${run.runId} · ${(run.durationMs / 1000).toFixed(1)}s`,
    `tinyfish: ${run.tinyfishSearches} searches, ${run.tinyfishFetches} fetches, ${run.tinyfishAgentRuns} agent runs`,
    `llm: ${run.llmCalls} calls, ${run.promptTokens.toLocaleString()} prompt + ${run.completionTokens.toLocaleString()} completion tokens`,
    `  smart=${modelFor("smart")}  cheap=${modelFor("cheap")}`,
    `plan: ${run.statesFromBaseline} from baseline, ${run.statesShortCircuited} short-circuited, ${run.statesEscalated} escalated to browser`,
    `saved ~${saved.toLocaleString()} prompt tokens vs a whole-document-per-state loop (${ratio.toFixed(1)}x)`,
    run.errors.length ? `errors: ${run.errors.length}` : "no errors",
  ].join("\n")
}
