# Coverage Atlas

**Name a condition. See how all fifty states cover it, and what changed.**

CMS publishes reimbursement rules state by state. The same treatment is covered
differently in Texas than in Massachusetts, the rules move mid-year, and there is
no cross-state database and no change feed anywhere in the country. Coverage
Atlas goes and reads the sources — fifty-one independent jurisdictions — and
computes the two things nobody publishes: **the contrast between states, and the
delta over time.**

Built on TinyFish primitives, running live. Conditions are not a fixed menu:
anything a user can name, the scanner resolves, finds sources for, and sweeps.

**Documentation** · [Architecture](docs/ARCHITECTURE.md) — how it fits together
· [The collection agent](docs/AGENT.md) — phases, escalation ladder, token
economics · [Data model](docs/DATA-MODEL.md) — types, friction maths, storage
· [HTTP API](docs/API.md) — routes and SSE event shapes
· [Operations](docs/OPERATIONS.md) — setup, tuning, troubleshooting
· [Decisions](docs/DECISIONS.md) — the calls we made and what they cost

---

## The angle: coverage status is a lie

Every existing tracker answers "is it covered?" That question is close to
useless on its own. Two states can both say **covered** and be forty points apart
in what a patient actually faces — one requires prior authorization, a documented
failed trial of something cheaper, six months of a supervised program, a
specialist prescriber and reauthorization every ninety days; the other puts it on
the pharmacy shelf.

So Coverage Atlas computes an **Access Friction Index** (0–100) for every
jurisdiction, from the administrative gates the policy documents actually state:

| Gate | Weight |
|---|---|
| Prior authorization | 22 |
| Step therapy | 18 |
| Documented prior failure | 14 |
| Supervised program participation | 12 |
| Clinical threshold (BMI, A1c, fibrosis stage…) | 10 |
| Specialist prescriber only | 9 |
| Renewal under 12 months | 8 |
| Quantity limit | 7 |
| Medical benefit only (no pharmacy path) | 6 |
| Restricted diagnosis | 6 |
| Age restriction | 5 |

Weights are additive and then squashed, so the first two gates move the score a
lot and the seventh moves it a little — which matches how access actually fails.
A patient stopped by prior authorization is stopped; a quantity limit on top of
that changes their life much less than the first barrier did.

The map colours by **status** or by **friction**, and on most conditions the two
maps do not look alike. That difference is the product.

Three things follow from it, all computed rather than curated:

- **Same label, different burden.** Among states reporting the *same* status,
  how far apart are they really?
- **Peer outliers.** Each state scored against its own census division. Same
  region, similar budgets, similar populations — thirty friction points apart.
- **Δ direction.** Changes are signed and ranked by how much access moved, not
  by date. "Still covered, now with step therapy" is a real access event that a
  status-only differ reports as nothing happening.

## Where the delta comes from

Every change event says which of these it is, because they are very different
claims:

- **Observed** — our own snapshot differ. Ground truth: we held the same fifty
  sources at two points in time and compared them.
- **Historical** — two dated versions of the state's *own* policy, read during
  one scan and compared. Medicaid documents are full of dated self-reference: a
  bulletin announcing a change states the rule it replaces. This is what lets a
  **first** scan show a timeline rather than a flat snapshot.
- **Reported** — a dated public announcement, found by news search.

Snapshots are immutable files. Every scan appends one; the differ reads two. The
"view date" control resolves to the newest snapshot at or before that date, so
picking an earlier date shows what the scanner actually believed then.

---

## The collection agent

An orchestrator that owns the plan, the budget and the merge, and per-state
subagents that own nothing else. The orchestrator does no extraction; the
subagents see no context beyond their own state.

```
resolve → discover → baseline → fan-out → backfill → [infer] → changes → diff → snapshot
  smart     search      fetch     ladder    leads +    on cap    search    pure    disk
   ×1        ×4        ×1+smart   cheap×n   batched              smart×1   code
                                            fetch
```

Bounded by two hard ceilings — **200 TinyFish calls** and **80 orchestrator
steps** — and it stops early, budget unspent, once every jurisdiction carries a
timestamped, cited answer.

**Phase 0 · Resolve** — one smart-model call turns free text ("Ozempic", "kids
with autism") into a condition, the treatment class states write policy about,
the brand names their formularies list, and *why states are allowed to differ at
all*. If a treatment is federally mandated there is no story; the policy lever is
what makes a fifty-state scan worth running.

**Phase 1 · Discover** — TinyFish search, four query shapes deliberately biased
toward documents that address *many* states at once, then one cheap ranking call.

**Phase 2 · Baseline** — TinyFish fetch of the top multi-state trackers, then a
single normalisation call that answers 35–45 jurisdictions at once.

**Phase 3 · Fan-out** — only the residue. Each subagent walks the escalation
ladder and stops at the first rung that answers:

| Rung | Cost | What it does |
|---|---|---|
| 0. carry-forward | free | Evidence hash unchanged since last scan → zero tokens |
| 1. search | free | Find the state's own policy document |
| 2. fetch | free | Pull it as markdown, window it to the passages naming the drug |
| 3. agent (stealth) | metered | Only when fetch 403s — many state portals do |

**Phase 3b · Backfill** — the tail. States with no policy found, no citation, no
date or no criteria language go back into the queue, worst first. Every URL the
scan did not read was banked as a lead — search results it skipped, and outbound
links from every page it fetched — and ten states' leads go out in **one** batched
fetch. Queries here ask "when did it change?" rather than "what is the rule?",
because a dated bulletin answers both.

**Phase 4 · Changes** — dated announcements via news search, plus the snapshot
diff, plus the dated versions found inside this scan's own documents.

**Phase 5 · Derive** — friction, outliers, deltas. Pure arithmetic over stored
citations, reproducible without calling a model at all.

### Why it is cheap

The efficiency is structural, not a prompt trick, and every run measures it:

1. **One tracker read answers most of the country.** Discovery is biased toward
   many-state documents precisely so a single normalisation call settles most
   jurisdictions.
2. **Only the residue fans out.** States the baseline answered confidently never
   get a per-state call.
3. **Narrow subagent context.** A subagent sees one state and roughly two
   thousand tokens — never its siblings' results, the tracker document, or the
   orchestrator's reasoning. Nothing about Ohio's job requires knowing anything
   about Nevada, and a shared conversation accumulating all fifty would cost
   quadratically for no accuracy gain.
4. **Windowing before the model.** A state preferred-drug list is 60–120k
   characters of tables for hundreds of drugs; the eight passages naming
   semaglutide are about five. Sending whole documents fifty-one times is how a
   naive scanner burns a million prompt tokens per condition.
5. **Evidence hashing makes re-scans nearly free.** Unchanged source → record
   carried forward at zero cost. This is also exactly the delta mechanism.
6. **Two-tier routing.** Three or four judgement calls to the smart model; the
   mechanical transcription volume to the cheap one.

The run ledger reports actual prompt tokens against an estimate of the naive
whole-document-per-state loop, in the UI and in the CLI. A claim about
efficiency that isn't measured is just a claim.

---

## TinyFish usage

Search and fetch are free and do the overwhelming majority of the work; the
metered browser agent is capped by a per-scan budget and only fires when the free
rungs fail.

```ts
// agent/lib/tinyfish.ts — the escalation ladder, in order
const hits = await search(`${stateName} Medicaid ${treatmentClass} prior authorization criteria`)
const docs = await fetchContents(rankPolicyUrls(hits, stateName).slice(0, 3))

// Only when the state portal refuses a plain fetcher:
const result = await runAgent({
  url: target,
  stealth: true,                       // state Medicaid sites 403 plain fetchers
  goal: `Find what this page says about ${stateName} Medicaid coverage of ...`,
  onProgress: (purpose) => emit(purpose),
})
```

`COMPLETED` only means the browser ran without crashing — every agent result is
validated on content, never on status.

---

## Running it

**Prerequisites.** Node 20+, pnpm, a [TinyFish key](https://agent.tinyfish.ai/api-keys)
and an [OpenRouter key](https://openrouter.ai/keys). Search and fetch are free;
agent runs are metered.

```bash
pnpm install
cp .env.example .env.local     # add TINYFISH_API_KEY and OPENROUTER_API_KEY
pnpm dev                       # http://localhost:3000
```

Reading the atlas needs no keys at all — route handlers for reading touch only
`data/`, so the committed snapshots load, compare and time-travel offline. Keys
are needed to scan and to re-verify.

**First run.** Name a condition in the header — "GLP-1 drugs for weight loss",
"continuous glucose monitors", "ABA therapy for autism" — and press **Run scan**.
Then:

1. Watch the **plan** event before the fan-out: how many of the 51 jurisdictions
   one shared tracker read settled, and how many need their own subagent. That
   ratio is the design working.
2. Watch the map repaint state by state as records land.
3. Read the **ledger** at the end: actual prompt tokens against the naive
   whole-document-per-state counterfactual.

Then the parts worth looking at: **switch the map from status to friction** and
watch the country redraw; **open a state** for its friction ledger, verbatim
criteria, source link and a live **Check again now**; **compare two states with
the same status** side by side; and **re-scan later** — the second snapshot is
what turns the change feed from *reported* into *observed*.

**Headless.** The same orchestrator, no browser. This is how the committed seed
data was produced.

```bash
pnpm scan "GLP-1 drugs for weight loss"
pnpm scan "continuous glucose monitors" --depth deep --agent-budget 10
pnpm scan obesity_glp_1_receptor_agonists --depth baseline   # cheap re-scan of a saved condition
pnpm agent:list                                              # saved conditions, snapshots, change counts
pnpm agent:ledger                                            # cost history
```

| Depth | Fans out | Roughly | Good for |
|---|---|---|---|
| `baseline` | nothing | seconds | Refreshing a condition whose trackers are current |
| `standard` | states the baseline left thin | 1–3 min | The normal scan |
| `deep` | all 51 | 5–10 min | Best verbatim coverage, most spend |

Ceilings are `--max-calls 200` and `--max-steps 80`. Anything still unresolved
when they bind is filled from model knowledge and marked **unverified** — never
presented as sourced.

Full setup, tuning and troubleshooting: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Layout

```
agent/
  orchestrator.ts       plan, budget, merge, ledger — no extraction
  run.ts                CLI
  lib/
    tinyfish.ts         search / fetch / agent, retries and SSE parsing
    llm.ts              OpenRouter, two-tier routing, token ledger
    derive.ts           windowing, friction index, outliers, gaps, differs
    budget.ts           the two ceilings and the stop condition
    leads.ts            scored, deduplicated pool of URLs worth reading next
    store.ts            immutable JSON snapshots on disk
    types.ts            the contract the UI and the collector share
  phases/
    resolve.ts          free text → scan target
    discover.ts         source discovery and ranking
    baseline.ts         one read, fifty answers
    subagent.ts         per-state worker, escalation ladder, dated versions
    backfill.ts         gap closing via banked leads; post-cap inference
    changes.ts          dated public announcements
app/api/                atlas · changes · conditions · scan (SSE) · verify (SSE)
components/coverage-atlas/
data/                   snapshots, change feeds, run ledger — committed
docs/                   architecture · agent · data model · API · operations · decisions
```

## Scope

Medicaid **fee-for-service** only. Managed-care plans may apply their own
criteria on top, and roughly three quarters of Medicaid enrollees are in managed
care — FFS is the published floor, not the whole picture. Records carry an
extraction confidence and a "last verified" timestamp, and any record can be
re-read live from the drawer. Verify against a state's official publication
before making a clinical or financial decision.
