import { For, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import type { Part } from "../../types/messages"

const labels: Record<string, string> = {
  input: "Uncached input",
  output: "Output",
  reasoning: "Reasoning",
  cache_read: "Cached input",
  cache_write: "Cache writes",
}
const origins: Record<string, string> = { catalog: "Catalog rate", configuration: "Configured rate" }
const statuses = {
  reported: "Reported by provider",
  estimated: "Calculated estimate",
  partial: "Known portion; incomplete cost",
  unknown: "Cost unavailable",
}

export function CostDetails(props: { parts: readonly Part[]; locale: string }) {
  const [limit, set] = createSignal(20)
  const steps = createMemo(() => props.parts.filter((part) => part.type === "step-finish"))
  const shown = createMemo(() => steps().slice(-limit()))
  const money = (amount: number) =>
    amount > 0 && amount < 0.000001
      ? "< $0.000001"
      : new Intl.NumberFormat(props.locale, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(
          amount,
        )
  return (
    <Show when={steps().length}>
      <details class="task-header-usage-detail">
        <summary>How model costs were calculated</summary>
        <p>
          Showing {shown().length} of {steps().length} loaded steps in this conversation. Totals above can include
          related conversations. Separately billed tools and media may add charges.
        </p>
        <For each={shown()}>
          {(step, index) => (
            <section class="task-header-usage-provider">
              <h4>Step {steps().length - shown().length + index() + 1}</h4>
              <Show when={step.accounting} fallback={<p>Historical calculation details are unavailable.</p>}>
                {(record) => (
                  <>
                    <p>
                      {statuses[record().status]}
                      <Show when={record().currency === "USD" && record().amount !== undefined}>
                        : {money(record().amount!)}
                      </Show>
                    </p>
                    <Show when={record().source.startsWith("model-rate-snapshot:")}>
                      <p>Pricing model: {record().source.slice("model-rate-snapshot:".length)}</p>
                    </Show>
                    <For each={record().buckets.filter((bucket) => bucket.tokens > 0)}>
                      {(bucket) => (
                        <div class="task-header-usage-meta">
                          {labels[bucket.name] ?? bucket.name}: {bucket.tokens.toLocaleString(props.locale)} tokens
                          {bucket.rate === undefined
                            ? "; rate unavailable"
                            : ` × ${money(bucket.rate)} per million tokens`}
                          <Show when={bucket.rate !== undefined}>
                            {" "}
                            · {origins[bucket.source ?? ""] ?? "Rate origin unavailable"}
                          </Show>
                        </div>
                      )}
                    </For>
                    <Show when={record().buckets.some((bucket) => bucket.name === "reasoning" && bucket.tokens > 0)}>
                      <p>Reasoning uses the output rate. Input excludes the separately listed cache buckets.</p>
                    </Show>
                    <Show when={record().unit && record().quantity !== undefined}>
                      <p>
                        Provider usage: {record().quantity!.toLocaleString(props.locale)} {record().unit}. USD
                        conversion is unavailable.
                      </p>
                    </Show>
                    <Show when={record().issues.length}>
                      <p>
                        Missing or uncertain information:{" "}
                        {record()
                          .issues.map((issue) => issue.replaceAll("_", " "))
                          .join("; ")}
                        .
                      </p>
                    </Show>
                    <Show when={record().status === "reported"}>
                      <p>A provider report is not a final invoice.</p>
                    </Show>
                  </>
                )}
              </Show>
            </section>
          )}
        </For>
        <Show when={shown().length < steps().length}>
          <Button variant="ghost" size="small" onClick={() => set((count) => count + 20)}>
            Show earlier calculations
          </Button>
        </Show>
      </details>
    </Show>
  )
}
