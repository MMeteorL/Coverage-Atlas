// Phase 3 — the per-state subagent.
//
// This is where a naive design burns its budget, so the contract is deliberately
// narrow: a subagent receives one state, the condition spec, and whatever the
// baseline already believes about that state. It never sees the other fifty
// states, the tracker document, the orchestrator's reasoning, or the results of
// its siblings. Its context is a couple of thousand tokens and it returns one
// record. Nothing about state 34's job requires knowing anything about state 12,
// and a shared conversation that accumulated all fifty would cost quadratically
// for no accuracy gain.
//
// It walks the escalation ladder and stops at the first rung that answers:
//
//   0. carry-forward — the evidence hash is unchanged since the last scan.
//      Zero model tokens, zero metered calls. On a re-scan most states land here,
//      which is exactly what makes a scheduled scanner affordable.
//   1. search  — free. Finds the state's own policy document.
//   2. fetch   — free. Pulls it as markdown, then windows it down to the passages
//      that mention the drug.
//   3. agent   — metered, stealth browser. Only when fetch came back empty or a
//      403, which is common for state Medicaid portals. Capped by a run budget
//      the orchestrator holds.

import { askJson } from "../lib/llm"
import { fetchContents, runAgent, search, unwrapAgentResult } from "../lib/tinyfish"
import { estimateTokens, frictionIndex, sha256, windowText } from "../lib/derive"
import {
  STATE_FIPS,
  STATE_NAMES,
  type ConditionSpec,
  type Confidence,
  type CoverageRecord,
  type CoverageStatus,
  type FrictionFlag,
} from "../lib/types"
import type { BaselineRow } from "./baseline"

const STATUSES = ["covered", "conditional", "limited", "not_covered", "unpublished"] as const
const FLAGS = [
  "prior_authorization", "step_therapy", "clinical_threshold", "prior_failure_required",
  "supervised_program", "specialist_prescriber", "quantity_limit", "short_renewal",
  "medical_benefit_only", "age_restriction", "diagnosis_restriction",
] as const

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "status", "frictionFlags", "criteriaSummary", "criteriaVerbatim", "administeringEntity", "effectiveDate", "confidence"],
  properties: {
    found: { type: "boolean", description: "false if the excerpt says nothing about this state and this treatment" },
    status: { type: "string", enum: STATUSES as unknown as string[] },
    frictionFlags: { type: "array", items: { type: "string", enum: FLAGS as unknown as string[] } },
    criteriaSummary: { type: ["string", "null"] },
    criteriaVerbatim: { type: ["string", "null"], description: "Exact characters from the excerpt, or null." },
    administeringEntity: { type: ["string", "null"], description: "State agency or contracted PBM named in the excerpt" },
    effectiveDate: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["high", "moderate", "review_needed"] },
  },
} as const

type Extraction = {
  found: boolean
  status: CoverageStatus
  frictionFlags: FrictionFlag[]
  criteriaSummary: string | null
  criteriaVerbatim: string | null
  administeringEntity: string | null
  effectiveDate: string | null
  confidence: Confidence
}

export type SubagentInput = {
  state: string
  spec: ConditionSpec
  baseline: BaselineRow | undefined
  prior: CoverageRecord | undefined
  /** Held by the orchestrator; decremented when a subagent takes the metered rung. */
  agentBudget: { remaining: number }
  onProgress?: (note: string) => void
}

export type SubagentOutcome = {
  record: CoverageRecord
  searches: number
  fetches: number
  agentRuns: number
  shortCircuited: boolean
  /** Prompt tokens a whole-document-per-state scanner would have spent here. */
  naiveTokens: number
}

/** Prefer the state's own domain, then its contracted PBM, then anything else. */
function rankPolicyUrls(results: { url: string; title: string }[], stateName: string): string[] {
  const score = (u: string, t: string) => {
    const url = u.toLowerCase()
    const title = t.toLowerCase()
    let s = 0
    if (/\.gov(\/|$)/.test(url)) s += 40
    if (url.includes("medicaid")) s += 18
    if (/(pdl|preferred[-_]?drug|formulary|prior[-_]?auth|criteria|fee[-_]?schedule)/.test(url + title)) s += 22
    if (url.endsWith(".pdf")) s += 8
    if (title.includes(stateName.toLowerCase())) s += 10
    if (/(goodrx|singlecare|drugs\.com|healthline|webmd|reddit|ro\.co|hims|noom)/.test(url)) s -= 60
    return s
  }
  return results
    .map((r) => ({ ...r, s: score(r.url, r.title) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((r) => r.url)
}

function toRecord(
  state: string,
  spec: ConditionSpec,
  e: Extraction,
  meta: { method: CoverageRecord["method"]; sourceDoc: string | null; sourceUrl: string | null; evidenceHash: string | null; notes?: string | null },
): CoverageRecord {
  const flags = [...new Set(e.frictionFlags ?? [])]
  // A prior-authorization flag and a "covered with no gate" status contradict each
  // other; the flags are the more specific evidence, so they win.
  const status: CoverageStatus =
    e.status === "covered" && flags.includes("prior_authorization") ? "conditional" : e.status
  const authorization = flags.includes("step_therapy")
    ? "step_therapy"
    : flags.includes("prior_authorization")
      ? "prior_authorization"
      : "none"
  const friction = frictionIndex(status, flags)

  return {
    state,
    stateName: STATE_NAMES[state],
    fips: STATE_FIPS[state],
    program: "medicaid_ffs",
    status,
    authorization,
    frictionFlags: flags,
    frictionIndex: friction,
    accessScore: status === "not_covered" || status === "unpublished" ? 0 : Math.max(0, 100 - friction),
    criteriaSummary: e.criteriaSummary,
    criteriaVerbatim: e.criteriaVerbatim,
    administeringEntity: e.administeringEntity,
    sourceDoc: meta.sourceDoc,
    sourceUrl: meta.sourceUrl,
    effectiveDate: e.effectiveDate,
    confidence: e.confidence,
    method: meta.method,
    lastCheckedAt: new Date().toISOString(),
    evidenceHash: meta.evidenceHash,
    notes: meta.notes ?? null,
  }
}

export async function runSubagent(input: SubagentInput): Promise<SubagentOutcome> {
  const { state, spec, baseline, prior, agentBudget } = input
  const stateName = STATE_NAMES[state]
  const terms = [...spec.searchTerms, ...spec.treatments.map((t) => t.toLowerCase())]
  let searches = 0
  let fetches = 0
  let agentRuns = 0
  let naiveTokens = 0

  // Rung 1 — find the state's own policy document.
  let hits: { url: string; title: string }[] = []
  try {
    const found = await search(
      `${stateName} Medicaid ${spec.treatmentClass} prior authorization criteria preferred drug list ${spec.name}`,
    )
    searches = 1
    hits = found.map((r) => ({ url: r.url, title: r.title }))
  } catch {
    /* the ladder degrades: no search just means we lean on the baseline */
  }
  // Three candidates in one batched fetch: state portals are full of thin landing
  // pages that never name the drug, and a second and third try costs nothing.
  const urls = rankPolicyUrls(hits, stateName).slice(0, 3)

  // Rung 2 — pull the document and window it to the passages that mention the drug.
  let excerpt = ""
  let sourceUrl: string | null = null
  let sourceDoc: string | null = null
  if (urls.length > 0) {
    try {
      const docs = await fetchContents(urls, 60_000)
      fetches = 1
      for (const doc of docs) {
        const text = doc.text ?? ""
        if (text.length < 400) continue
        naiveTokens += estimateTokens(text)
        const windowed = windowText(text, terms, { radius: 900, maxWindows: 6 })
        // A page that never mentions the drug is the wrong page, not a "not covered" answer.
        if (windowed.length < 300 || !terms.some((t) => windowed.toLowerCase().includes(t))) continue
        excerpt = windowed
        sourceUrl = doc.final_url ?? doc.url
        sourceDoc = doc.title ?? null
        break
      }
    } catch {
      /* fall through to the metered rung */
    }
  }

  // Rung 0 — nothing has moved since last time. Free.
  const candidateHash = excerpt ? sha256(excerpt) : null
  if (candidateHash && prior?.evidenceHash === candidateHash) {
    input.onProgress?.(`${state}: source unchanged, carried forward`)
    return {
      record: { ...prior, lastCheckedAt: new Date().toISOString(), method: "carried_forward" },
      searches,
      fetches,
      agentRuns: 0,
      shortCircuited: true,
      naiveTokens,
    }
  }

  // Rung 3 — the state portal blocked us. Spend a metered browser run, if the
  // orchestrator's budget allows and the baseline has not already answered.
  if (!excerpt && agentBudget.remaining > 0 && (!baseline || baseline.confidence !== "high")) {
    const target = urls[0] ?? hits[0]?.url
    if (target) {
      agentBudget.remaining--
      agentRuns = 1
      try {
        input.onProgress?.(`${state}: fetch blocked, escalating to browser agent`)
        const raw = await runAgent({
          url: target,
          stealth: true,
          timeoutMs: 200_000,
          goal:
            `Find what this page says about ${stateName} Medicaid fee-for-service coverage of ${spec.treatmentClass} ` +
            `(${spec.treatments.join(", ")}) for ${spec.name}. Return STRICT JSON only:\n` +
            `{"found":boolean,"status":"covered|conditional|limited|not_covered|unpublished",` +
            `"frictionFlags":[${FLAGS.map((f) => `"${f}"`).join("|")}],"criteriaSummary":"one plain sentence",` +
            `"criteriaVerbatim":"exact wording from the page or null","administeringEntity":"state agency or PBM or null",` +
            `"effectiveDate":"YYYY-MM-DD or null","confidence":"high|moderate|review_needed"}\n` +
            `Set found=false if the page does not address this treatment. Never guess a status.`,
          onProgress: (p) => input.onProgress?.(`${state}: ${p}`),
        })
        const parsed = unwrapAgentResult(raw) as Extraction | null
        if (parsed?.found && parsed.status) {
          return {
            record: toRecord(state, spec, parsed, {
              method: "agent",
              sourceDoc: sourceDoc ?? `${stateName} Medicaid policy page`,
              sourceUrl: target,
              evidenceHash: sha256(JSON.stringify(parsed)),
              notes: "Read by a stealth browser agent — the state portal refuses plain fetchers.",
            }),
            searches, fetches, agentRuns, shortCircuited: false, naiveTokens,
          }
        }
      } catch (err) {
        input.onProgress?.(`${state}: agent run failed (${String(err).slice(0, 80)})`)
      }
    }
  }

  // Extract from whatever evidence we have. The excerpt is the state's own
  // document; the baseline row is what a national tracker said. If we have both,
  // the state's own words are authoritative and the tracker is context.
  if (excerpt) {
    try {
      const parsed = await askJson<Extraction>({
        tier: "cheap",
        schema: EXTRACT_SCHEMA,
        schemaName: "state_extraction",
        label: `extract ${state}`,
        maxTokens: 1400,
        system:
          `You are reading an excerpt of ${stateName}'s own Medicaid policy documents. Report only what this excerpt ` +
          `states about coverage of ${spec.treatmentClass} (${spec.treatments.join(", ")}) for ${spec.name}.\n\n` +
          `covered = on the benefit with no gate described. conditional = prior authorization or documented criteria ` +
          `stand in front. limited = only a narrow slice qualifies. not_covered = explicitly excluded. ` +
          `unpublished = the excerpt does not establish a policy.\n\n` +
          `frictionFlags: only gates the excerpt actually states. Do not infer. An empty array is a real answer.\n` +
          `criteriaVerbatim: exact characters from the excerpt, under 400 characters, or null.\n` +
          (baseline
            ? `A national tracker reports "${baseline.status}" for ${stateName}. Treat that as context, not evidence: ` +
              `this excerpt is the state's own document and outranks it. Contradict the tracker only if the excerpt is clear.\n`
            : "") +
          `Set found=false rather than guessing.`,
        user: excerpt.slice(0, 12_000),
      })
      if (parsed.found) {
        return {
          record: toRecord(state, spec, parsed, {
            method: "fetch",
            sourceDoc: sourceDoc,
            sourceUrl,
            evidenceHash: candidateHash,
          }),
          searches, fetches, agentRuns, shortCircuited: false, naiveTokens,
        }
      }
    } catch (err) {
      input.onProgress?.(`${state}: extraction failed (${String(err).slice(0, 80)})`)
    }
  }

  // Fall back to the baseline. Confidence drops a notch because nothing in the
  // state's own publications corroborated it.
  if (baseline) {
    return {
      record: toRecord(
        state,
        spec,
        {
          found: true,
          status: baseline.status,
          frictionFlags: baseline.frictionFlags as FrictionFlag[],
          criteriaSummary: baseline.criteriaSummary,
          criteriaVerbatim: baseline.criteriaVerbatim,
          administeringEntity: null,
          effectiveDate: baseline.effectiveDate,
          confidence: baseline.confidence === "high" ? "moderate" : "review_needed",
        },
        {
          method: "baseline",
          sourceDoc: baseline.sourceDoc,
          sourceUrl: baseline.sourceUrl,
          evidenceHash: null,
          notes: "From a multi-state tracker; the state's own publication did not corroborate it in this scan.",
        },
      ),
      searches, fetches, agentRuns, shortCircuited: false, naiveTokens,
    }
  }

  // Nothing anywhere. "No published fee-for-service policy" is a real and
  // reportable finding — several states genuinely leave this to their MCOs.
  return {
    record: toRecord(
      state,
      spec,
      {
        found: true,
        status: "unpublished",
        frictionFlags: [],
        criteriaSummary: `No published fee-for-service policy for ${spec.treatmentClass} was found for ${stateName} in this scan.`,
        criteriaVerbatim: null,
        administeringEntity: null,
        effectiveDate: null,
        confidence: "review_needed",
      },
      { method: "search", sourceDoc: null, sourceUrl: urls[0] ?? null, evidenceHash: null },
    ),
    searches, fetches, agentRuns, shortCircuited: false, naiveTokens,
  }
}
