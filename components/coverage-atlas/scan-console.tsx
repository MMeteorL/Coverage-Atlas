"use client"

import { Activity, ChevronDown, Cpu, Radio, Search, Square, Zap } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { ScanState } from "./use-atlas"

/**
 * The run console.
 *
 * Two things are worth watching while a scan runs, and neither of them is a
 * spinner. The first is the plan — how many of the 51 jurisdictions the single
 * shared tracker read settled, and how many needed their own subagent — because
 * that ratio is the entire efficiency argument, visible as it happens. The
 * second is the ledger afterwards, which measures the saving against a naive
 * whole-document-per-state loop rather than asserting it.
 */
export function ScanConsole({ scan, onCancel, onClear }: { scan: ScanState; onCancel: () => void; onClear: () => void }) {
  const [open, setOpen] = useState(true)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [scan.phases.length])

  if (!scan.running && !scan.ledger && !scan.error) return null

  const pct = scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : 0
  const ledger = scan.ledger
  const saved = ledger ? ledger.naivePromptTokensEstimate - ledger.promptTokens : 0
  const ratio = ledger && ledger.promptTokens > 0 ? ledger.naivePromptTokensEstimate / ledger.promptTokens : 0

  return (
    <section className="mt-4 overflow-hidden rounded-lg border bg-card">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {scan.running ? (
            <Radio className="atlas-pulse size-4" style={{ color: "var(--scan-live)" }} />
          ) : (
            <Activity className="size-4 text-muted-foreground" />
          )}
          {scan.running ? "Scanning live" : scan.error ? "Scan failed" : "Scan complete"}
        </span>
        {scan.condition && <span className="truncate text-xs text-muted-foreground">{scan.condition}</span>}

        <div className="ml-auto flex items-center gap-2">
          {scan.running ? (
            <button onClick={onCancel} className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted">
              <Square className="size-3" />
              Stop
            </button>
          ) : (
            <button onClick={onClear} className="rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted">
              Dismiss
            </button>
          )}
          <button
            onClick={() => setOpen((o) => !o)}
            className="rounded-md p-1.5 hover:bg-muted"
            aria-expanded={open}
            aria-label={open ? "Collapse run log" : "Expand run log"}
          >
            <ChevronDown className={`size-4 transition-transform ${open ? "" : "-rotate-90"}`} />
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-4 border-b px-4 py-3 text-xs">
        <div className="min-w-40 flex-1">
          <div className="mb-1.5 flex justify-between">
            <span className="text-muted-foreground">
              {scan.done} of {scan.total} jurisdictions
            </span>
            <span className="font-semibold">{pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${pct}%`, background: "var(--scan-live)" }}
            />
          </div>
        </div>
        {scan.plan && (
          <div className="flex items-center gap-4">
            <Stat icon={<Search className="size-3.5" />} value={scan.plan.fromBaseline} label="settled by one shared read" />
            <Stat icon={<Cpu className="size-3.5" />} value={scan.plan.toFanOut} label="sent to per-state subagents" />
          </div>
        )}
      </div>

      {open && (
        <div
          ref={logRef}
          className="max-h-44 overflow-y-auto bg-muted/25 px-4 py-3 font-mono text-[11px] leading-5"
          role="log"
          aria-live="polite"
        >
          {scan.phases.map((p, i) => (
            <div key={`${p.at}-${i}`} className="flex gap-2">
              <span className="w-16 shrink-0 text-muted-foreground">[{p.phase}]</span>
              <span className="min-w-0 flex-1 break-words">{p.note}</span>
            </div>
          ))}
          {scan.phases.length === 0 && <span className="text-muted-foreground">waiting for the first event…</span>}
        </div>
      )}

      {scan.error && (
        <div className="border-t bg-destructive/5 px-4 py-3 text-xs text-destructive">{scan.error}</div>
      )}

      {ledger && (
        <div className="border-t">
          <div className="grid grid-cols-2 divide-x divide-y border-b sm:grid-cols-4 sm:divide-y-0">
            <Cell label="Run time" value={`${(ledger.durationMs / 1000).toFixed(1)}s`} />
            <Cell
              label="TinyFish calls"
              value={`${ledger.tinyfishSearches + ledger.tinyfishFetches + ledger.tinyfishAgentRuns}`}
              note={`${ledger.tinyfishSearches} search · ${ledger.tinyfishFetches} fetch · ${ledger.tinyfishAgentRuns} agent`}
            />
            <Cell
              label="Model calls"
              value={`${ledger.llmCalls}`}
              note={`${ledger.promptTokens.toLocaleString()} prompt tokens`}
            />
            <Cell
              label="Escalated to browser"
              value={`${ledger.statesEscalated}`}
              note={`${ledger.statesShortCircuited} short-circuited free`}
            />
          </div>
          {ratio > 1 && (
            <div className="flex items-start gap-2.5 px-4 py-3 text-xs">
              <Zap className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <p className="leading-5 text-muted-foreground">
                <strong className="text-foreground">{ratio.toFixed(1)}× cheaper</strong> than sending every source
                document to a model once per state — about{" "}
                <strong className="text-foreground">{saved.toLocaleString()}</strong> prompt tokens not spent. One
                shared tracker read settled {ledger.statesFromBaseline} jurisdictions; the rest were windowed down to
                the passages that name the drug before any model saw them.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      {icon}
      <strong className="text-foreground">{value}</strong>
      {label}
    </span>
  )
}

function Cell({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="p-3">
      <div className="text-base font-semibold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      {note && <div className="mt-0.5 text-[10px] text-muted-foreground">{note}</div>}
    </div>
  )
}
