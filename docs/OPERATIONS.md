# Running and operating it

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Environment](#environment)
- [First run](#first-run)
- [The CLI](#the-cli)
- [Scan depths and what they cost](#scan-depths-and-what-they-cost)
- [Cost control](#cost-control)
- [Keeping the atlas fresh](#keeping-the-atlas-fresh)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| | |
|---|---|
| Node | 20+ (developed on 25.x) |
| Package manager | pnpm (a `pnpm-lock.yaml` is committed) |
| TinyFish API key | https://agent.tinyfish.ai/api-keys — search and fetch are free, agent runs are metered |
| OpenRouter API key | https://openrouter.ai/keys |

Only the two collection routes need keys. Reading the atlas, comparing states and
time-travelling through snapshots all work from the committed data with no keys
at all.

## Setup

```bash
git clone https://github.com/MMeteorL/Coverage-Atlas.git
cd Coverage-Atlas
pnpm install
cp .env.example .env.local     # then fill in the two keys
pnpm dev
```

Open http://localhost:3000.

## Environment

`.env.local` — gitignored, never committed.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TINYFISH_API_KEY` | for scanning | — | Sent as `X-API-Key`, **not** a bearer token |
| `OPENROUTER_API_KEY` | for scanning | — | |
| `OPENROUTER_MODEL_SMART` | no | `anthropic/claude-sonnet-4.5` | Resolution, tracker normalisation, change narration — 3–4 calls per scan |
| `OPENROUTER_MODEL_CHEAP` | no | `google/gemini-2.5-flash` | Source ranking and per-state extraction — all the volume |

Both model variables take any OpenRouter model slug. The cheap tier must support
structured outputs (`response_format: json_schema` with `strict: true`); a model
that ignores the schema will fail extraction on every state.

## First run

1. **Name a condition.** Type it in the header — "GLP-1 drugs for weight loss",
   "continuous glucose monitors", "ABA therapy for autism" — or pick one of the
   suggestions on the empty state.
2. **Press Run scan.** The console opens and the log starts moving.
3. **Watch the plan event.** Before the fan-out begins you will see how many of
   the 51 jurisdictions one shared tracker read settled and how many need their
   own subagent. That ratio is the design working.
4. **Watch the map fill in.** Each state repaints as its record lands.
5. **Read the ledger.** At the end, actual prompt tokens against the naive
   whole-document-per-state counterfactual.

Then the things worth actually looking at:

- **Switch the map from status to friction.** On most conditions the country
  redraws. That difference is the product.
- **Open a state.** Friction ledger, verbatim criteria, source link, which ladder
  rung produced it, and **Check again now** — a live re-read that escalates to a
  stealth browser if the state portal refuses a plain fetch.
- **Compare two states with the same status.** Verbatim criteria side by side.
- **Re-scan the condition later.** The second snapshot is what turns the change
  feed from *reported* into *observed*.

A first scan has no prior snapshot to diff against, so its change feed contains
only publicly reported events. Observed deltas appear from the second scan
onward.

## The CLI

The same orchestrator, headless. This is how the committed seed data was
produced.

```bash
pnpm scan "GLP-1 drugs for weight loss"
pnpm scan "continuous glucose monitors" --depth deep --agent-budget 10
pnpm scan obesity_glp_1_receptor_agonists --depth baseline   # cheap re-scan of a saved condition
pnpm agent:list       # saved conditions, snapshot counts, change counts
pnpm agent:ledger     # cost history across recent runs
```

| Flag | Default | Effect |
|---|---|---|
| `--depth` | `standard` | `baseline` \| `standard` \| `deep` |
| `--agent-budget` | `6` | Ceiling on metered stealth browser runs |
| `--wave` | `5` | Subagents in flight |
| `--change-window` | `180` | Days back the news search looks |

States print as coloured status marks as they land, then the outliers, then the
ledger.

## Scan depths and what they cost

| Depth | Fans out | Roughly | Good for |
|---|---|---|---|
| `baseline` | nothing | seconds, 2–3 model calls total | Refreshing a condition whose trackers are current |
| `standard` | states the baseline missed or left below high confidence / without verbatim criteria | ~1–3 minutes | The normal scan |
| `deep` | all 51 | ~5–10 minutes | Best verbatim coverage, most spend |

Times vary a lot with source quality — a condition with a good national tracker
finishes far faster than one where every state must be visited individually.

## Cost control

Search and fetch are free. The two things that actually cost money are OpenRouter
tokens and TinyFish agent runs.

- **`--agent-budget` is the only knob that meaningfully raises spend.** It caps
  metered browser runs per scan. Default 6.
- **Prefer `standard` over `deep`** unless you specifically need verbatim
  criteria for every state.
- **Re-scans are cheap by construction.** Unchanged sources short-circuit on the
  evidence hash at zero token cost, so scanning the same condition weekly costs a
  fraction of the first run.
- **Route the cheap tier at an actually cheap model.** It carries essentially all
  the volume; the smart tier is 3–4 calls.
- **Raising `--wave` past your TinyFish plan's concurrency limit** produces
  throttling, not speed.

Check what any given run actually cost with `pnpm agent:ledger`.

## Keeping the atlas fresh

Two mechanisms, aimed at different questions.

**Scheduled re-scan** — "has anything moved?" A weekly `pnpm scan <slug>` per
condition writes a new snapshot and computes observed deltas against the last
one. Cheap, because the hash short-circuit carries most states forward free.

**Check again now** — "is *this* record still true?" One state, on demand, from
the drawer. It patches the current snapshot rather than opening a new one, and
writes any disagreement to the change feed as an observed event.

Snapshots accumulate; nothing prunes them. They are small and they are the entire
history, so keep them.

## Troubleshooting

**`TINYFISH_API_KEY is not set` / `OPENROUTER_API_KEY is not set`**
The scan route checks both before opening the stream. Confirm they are in
`.env.local` at the repo root and restart `pnpm dev` — Next reads env files at
boot.

**`no snapshot yet` in the atlas**
The condition exists but has never been scanned. Press Run scan.

**A scan reports many `unpublished` states**
Usually means source discovery found no good multi-state tracker for that
condition, so nearly every state fell through to the fan-out and several found
nothing. Try `--depth deep`, or rephrase the condition toward the term policy
documents actually use — "continuous glucose monitors" rather than "diabetes
gadgets". Check the `discover` lines in the log to see what it found.

**A state's record looks wrong**
Open it and press **Check again now**. If the live re-read disagrees, the record
updates and the disagreement is written to the change feed. Check `method` in the
drawer — a record obtained by `baseline` came from a national tracker rather than
the state's own publication, and is flagged accordingly.

**Extraction fails on every state**
Almost always the cheap model. It must support OpenRouter structured outputs with
`strict: true`. Swap `OPENROUTER_MODEL_CHEAP` for a model that does.

**Scan seems stuck on `fanout`**
Waves are sequential and a stealth browser run can take 30–60s. Watch the log for
`escalating to browser` lines. Lower `--agent-budget` to cap how many can happen.

**`Rosetta 2 translation` warning from Next.js**
An x86-64 Node on Apple Silicon. Harmless but slow; reinstall Node as arm64 if
dev-server startup is painful.

**Nothing renders and the console shows a data path error**
`data/` is resolved from `process.cwd()`. Run commands from the repository root.
