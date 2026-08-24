# Data model

The vocabulary, the maths, and how it is stored.

Types live in `agent/lib/types.ts` and are imported by both the collector and the
UI, so the contract cannot drift. Derivations live in `agent/lib/derive.ts` as
pure functions — no I/O, no model calls — which is what makes every computed
number reproducible from `data/` alone.

- [Coverage status](#coverage-status)
- [Friction flags](#friction-flags)
- [The Access Friction Index](#the-access-friction-index)
- [CoverageRecord](#coveragerecord)
- [ChangeEvent](#changeevent)
- [ConditionSpec](#conditionspec)
- [RunLedger](#runledger)
- [Storage layout](#storage-layout)
- [The differ](#the-differ)
- [Outlier detection](#outlier-detection)
- [Windowing](#windowing)

---

## Coverage status

Five values, chosen so that each is a distinguishable real-world situation rather
than a shade of one:

| Value | Meaning |
|---|---|
| `covered` | On the formulary or benefit with no notable gate described |
| `conditional` | Covered, but prior authorization or documented criteria stand in front |
| `limited` | Covered only for a narrow slice — step therapy, a sub-population, hard caps |
| `not_covered` | Explicitly excluded for this indication |
| `unpublished` | No published fee-for-service policy could be found |

`unpublished` is a finding, not a failure. Several states genuinely publish no
FFS policy and leave the decision to their managed-care plans, and reporting that
honestly is more useful than guessing.

A record marked `covered` that also carries a `prior_authorization` flag is
incoherent. The flags are the more specific evidence, so extraction promotes such
a record to `conditional` before it is stored.

## Friction flags

The gates a policy document actually states. Only what is written down — never
inferred. An empty array is a real and common answer.

| Flag | Weight | What it looks like in a document |
|---|---:|---|
| `prior_authorization` | 22 | PA required before dispensing |
| `step_therapy` | 18 | Must try preferred agents first |
| `prior_failure_required` | 14 | Documented failed trial of something cheaper |
| `supervised_program` | 12 | Documented lifestyle or behavioural program participation |
| `clinical_threshold` | 10 | BMI ≥ 30, A1c ≥ 7, fibrosis stage, etc. |
| `specialist_prescriber` | 9 | Endocrinology / rheumatology only |
| `short_renewal` | 8 | Reauthorization more often than annually |
| `quantity_limit` | 7 | Days-supply or unit caps |
| `medical_benefit_only` | 6 | No pharmacy-counter path; billed as DME/medical |
| `diagnosis_restriction` | 6 | Only covered for an adjacent indication |
| `age_restriction` | 5 | Age bands |

## The Access Friction Index

```ts
frictionIndex(status, flags) → 0..100
```

0 is walk into a pharmacy; 100 is no pathway at all.

```
not_covered                    → 100
unpublished                    →  92
otherwise:
  raw      = Σ weight(flag)                    // deduplicated
  squashed = 100 × (1 − e^(−raw / 55))
  floor    = 30 if limited, 18 if conditional, else 0
  index    = round(max(squashed, floor))
```

**Why squash.** Weights are additive and then compressed, so the first two gates
move the number a lot and the seventh moves it a little. That matches how access
actually fails: a patient stopped by prior authorization is stopped, and a
quantity limit stacked on top changes their life much less than the first barrier
did. A purely additive score would let a state with seven mild gates outrank one
with a single disqualifying one.

**Why a floor.** A document can describe a restrictive status without enumerating
gates — "covered with limits" and then no detail. The floor keeps such a record
from scoring as frictionless purely because the source was terse.

**Why 92 for `unpublished`.** No published pathway is not the same as a refusal —
a managed-care plan may well cover it — but for a prescriber trying to work out
what they can write today, it is close to one.

`accessScore` is the inverse, `100 − frictionIndex`, floored at 0 for states with
no pathway. The UI shows friction where the question is "how hard is this" and
access score where the question is "how good is this state".

## CoverageRecord

One jurisdiction, one condition, one scan. The full field list is in
`agent/lib/types.ts`; the fields worth explaining:

| Field | Notes |
|---|---|
| `criteriaSummary` | One plain-language sentence. Paraphrase lives here. |
| `criteriaVerbatim` | Exact characters from the source, or `null`. Never paraphrase into this field — the compare view aligns two states' original wording, and a blurred quote defeats the view. |
| `sourceDoc` / `sourceUrl` | The citation. Every record carries one or explains why it does not. |
| `confidence` | `high` \| `moderate` \| `review_needed`. Baseline-only records are knocked down a notch when the state's own publication did not corroborate them. |
| `method` | Which ladder rung produced this: `baseline` \| `search` \| `fetch` \| `agent` \| `carried_forward`. Surfaced in the drawer, because how we know something is part of what we know. |
| `lastCheckedAt` | When our scanner last confirmed it. Distinct from `effectiveDate`, which is the policy's own date. |
| `evidenceHash` | sha256 (truncated) of the windowed evidence. Equal hash across scans ⇒ zero tokens. |

## ChangeEvent

| Field | Notes |
|---|---|
| `direction` | `coverage_added` \| `coverage_dropped` \| `loosened` \| `tightened` \| `clarified` \| `stable` |
| `frictionDelta` | Signed. Negative means easier to obtain. |
| `provenance` | **`observed`** — our own snapshot differ caught it. **`reported`** — a dated public source stated it. |
| `announcedOn` / `effectiveOn` | Announcement date and the date it bites. Often different, and the gap matters to a provider. |
| `id` | `state-direction-date`. Re-scans update rather than duplicate. |

`provenance` is surfaced in the UI on every event. "We watched this happen" and
"we read that this happened" are different claims and users should never have to
guess which one they are looking at.

## ConditionSpec

Produced by resolution, saved on first scan, reused thereafter.

`policyLever` is the field that carries the narrative: one sentence on why states
are permitted to differ on this treatment at all. If a treatment is federally
mandated everywhere, there is no fifty-state story — and the lever is what tells
you that before you spend a scan finding out.

`builtIn` conditions cannot be deleted through the API; they are the demo's
floor.

## RunLedger

The cost story, appended to `data/runs.jsonl` on every run and rendered in the
scan console.

| Field | Meaning |
|---|---|
| `tinyfishSearches` / `tinyfishFetches` | Free primitives |
| `tinyfishAgentRuns` | The metered rung |
| `llmCalls`, `promptTokens`, `completionTokens` | Actual model spend |
| `statesFromBaseline` | Settled by the one shared read, no per-state call |
| `statesShortCircuited` | Evidence hash unchanged — free |
| `statesEscalated` | Needed a stealth browser |
| `naivePromptTokensEstimate` | Counterfactual: every fetched document sent to a model once per state |

`naivePromptTokensEstimate ÷ promptTokens` is the savings ratio the UI reports.

## Storage layout

```
data/
  conditions.json                          ConditionSpec[]
  snapshots/<condition-slug>/<stamp>.json  Snapshot — immutable
  changes/<condition-slug>.json            ChangeEvent[] — merged, deduplicated
  runs.jsonl                               RunLedger, one JSON object per line
```

Plain JSON on disk, committed to the repository. That means the demo opens with
complete data and no infrastructure, and every derived number can be recomputed
and checked by anyone with the repo.

**Snapshots are immutable.** Deltas are the product, so history has to be
first-class rather than a mutable "current" row that overwrites what it replaces.
Every scan appends a file; the differ reads two.

**Stamps are file-name-safe instants**: `2026-08-23T18:45:12.345Z` is stored as
`2026-08-23T18-45-12-345Z.json`, so lexical order is chronological order and
`listSnapshotStamps` needs no parsing.

One consequence is worth flagging, because it is a real trap: stamps and ISO
strings **do not sort against each other** — `-` sorts below `:`, so comparing
the two forms silently mis-orders snapshots taken on the same day.
`readSnapshotAsOf` normalises its argument into stamp space before comparing, and
accepts a stamp, a full ISO instant, or a bare `YYYY-MM-DD`.

**The one exception to immutability** is `patchLatestRecord`, used only by
"check again now". A live re-verification is an observation of the *current*
state of the world, so it belongs in the current snapshot — opening a
fifty-first snapshot containing one refreshed state would corrupt the differ.

## The differ

```ts
diffSnapshots(before, after, detectedAt) → ChangeEvent[]
```

For each state present in both snapshots, an event is emitted when **either** the
status moved **or** friction moved by 6 points or more.

Including friction is the point. "Still covered, now with step therapy" is a real
access event that a status-only differ reports as nothing happening. The 6-point
threshold treats smaller movements as extraction noise rather than policy —
re-extraction of the same PDF can jitter by a flag.

Direction is inferred from a status rank (`covered` 4 → `unpublished` 0):

- rank fell to 1 or below from above → `coverage_dropped`
- rank rose above 1 from 1 or below → `coverage_added`
- otherwise friction fell or rank rose → `loosened`
- otherwise → `tightened`

The detail line names the gates gained and lost, so the event says *what*
changed and not merely that something did. Results are sorted by absolute
friction delta — how much access moved, not how recent it was.

## Outlier detection

`findOutliers` returns at most four findings, all computed:

1. **Lowest friction nationally**, with the count of jurisdictions that have any
   pathway at all.
2. **Covered on paper, hardest in practice** — the highest-friction state that
   still reports coverage, and its gap from the easiest.
3. **Peer outlier** — every state scored against the mean of its own **census
   division**, reported when the gap is ≥ 12 points. This is the finding
   providers react to: same region, similar budgets, similar populations, thirty
   friction points apart.
4. **Most recent material change**.

Census divisions are in `PEER_GROUPS`; groups smaller than three states are
skipped, since a "mean" of two is not a peer group.

The UI adds one more client-side, in `frictionSpreadWithinStatus`: among states
reporting the **same** status, the spread between the easiest and the hardest.
That is the headline the product exists to make.

## Windowing

```ts
windowText(text, terms, { radius = 1100, maxWindows = 8 }) → string
```

Finds every occurrence of every search term, takes ±`radius` characters around
each, merges overlapping spans so a dense cluster reads as one passage, and joins
the survivors with `[...]` separators.

The single largest token saving in the pipeline, and also a correctness device:
a document whose window never mentions the drug is the **wrong document**, not
evidence of non-coverage. The subagent checks for that explicitly and moves to
the next candidate URL rather than recording a `not_covered`.
