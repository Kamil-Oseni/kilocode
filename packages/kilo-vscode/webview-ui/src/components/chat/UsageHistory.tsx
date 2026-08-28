// raya_change - project-wide historical model token and cost tracker
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import { useLanguage } from "../../context/language"
import { groupModelUsage, modelUsageName } from "../../context/model-usage"
import { useProvider } from "../../context/provider"
import { useVSCode } from "../../context/vscode"
import type { ProjectUsage } from "../../types/messages"
import { formatCompactCount } from "../../utils/format"

type Range = "24h" | "7d" | "30d" | "all"

const ranges: Array<{ value: Range; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
]

const saved = localStorage.getItem("raya.usage.range")
const initial: Range = saved === "24h" || saved === "7d" || saved === "30d" || saved === "all" ? saved : "7d"

export const UsageHistoryView: Component<{
  range: Range
  usage?: ProjectUsage
  error?: string
  locale: string
  providers: Parameters<typeof groupModelUsage>[1]
  onRange?: (range: Range) => void
}> = (props) => {
  const groups = createMemo(() => groupModelUsage(props.usage?.models ?? [], props.providers))
  const money = createMemo(
    () =>
      new Intl.NumberFormat(props.locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }),
  )
  const cost = (value: number) => {
    if (value > 0 && value < 0.000001) return "<$0.000001"
    return money().format(value)
  }
  const tokens = (usage: ProjectUsage["totals"]) =>
    usage.tokens.input +
    usage.tokens.output +
    usage.tokens.reasoning +
    usage.tokens.cache.read +
    usage.tokens.cache.write

  return (
    <section class="usage-history" aria-label="Model usage history">
      <header>
        <div>
          <h4>Model spend</h4>
          <Show when={props.usage}>
            {(data) => (
              <span>
                {cost(data().totals.cost)} · {formatCompactCount(tokens(data().totals))} tokens · {data().sessions}{" "}
                sessions
              </span>
            )}
          </Show>
        </div>
        <div class="usage-history__ranges" aria-label="Usage time range">
          <For each={ranges}>
            {(item) => (
              <button
                type="button"
                aria-pressed={props.range === item.value}
                data-active={props.range === item.value ? "" : undefined}
                onClick={() => props.onRange?.(item.value)}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </header>
      <Show when={props.error}>{(message) => <div class="usage-history__empty">{message()}</div>}</Show>
      <Show when={!props.error && !props.usage}>
        <div class="usage-history__empty">Loading usage…</div>
      </Show>
      <Show when={props.usage?.models.length === 0}>
        <div class="usage-history__empty">No settled model usage in this range.</div>
      </Show>
      <For each={groups()}>
        {(group) => (
          <div class="usage-history__provider">
            <h5>{group.providerName}</h5>
            <For each={group.models}>
              {(model) => (
                <div class="usage-history__model">
                  <span title={`${model.providerID}/${model.modelID}`}>{modelUsageName(model, props.providers)}</span>
                  <span>{formatCompactCount(tokens(model))} tokens</span>
                  <strong>{cost(model.cost)}</strong>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </section>
  )
}

export const UsageHistory: Component = () => {
  const vscode = useVSCode()
  const language = useLanguage()
  const provider = useProvider()
  const [range, setRange] = createSignal<Range>(initial)
  const [request, setRequest] = createSignal("")
  const [usage, setUsage] = createSignal<ProjectUsage>()
  const [error, setError] = createSignal<string>()

  const off = vscode.onMessage((message) => {
    if (message.type !== "projectUsageLoaded" || message.requestID !== request()) return
    setUsage(message.data)
    setError(message.error)
  })
  onCleanup(off)

  createEffect(() => {
    const value = range()
    const id = crypto.randomUUID()
    localStorage.setItem("raya.usage.range", value)
    setRequest(id)
    setUsage(undefined)
    setError(undefined)
    vscode.postMessage({ type: "requestProjectUsage", range: value, requestID: id })
  })

  return (
    <UsageHistoryView
      range={range()}
      usage={usage()}
      error={error()}
      locale={language.locale()}
      providers={provider.providers()}
      onRange={setRange}
    />
  )
}
