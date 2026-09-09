// raya_change - project-wide historical model token and cost tracker
import { costLabel } from "../../context/accounting"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import { useLanguage } from "../../context/language"
import { groupModelUsage, modelUsageName } from "../../context/model-usage"
import { useProvider } from "../../context/provider"
import { useVSCode } from "../../context/vscode"
import type { ProjectUsage } from "../../types/messages"
import { useClipboard } from "@kilocode/kilo-ui/context/clipboard"
import { report } from "./usage-report"
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
  onRefresh?: () => void
  onCopy?: () => void
  copying?: boolean
  notice?: string
}> = (props) => {
  const groups = createMemo(() => groupModelUsage(props.usage?.models ?? [], props.providers))
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
                {costLabel(data().totals, props.locale)} · {formatCompactCount(tokens(data().totals))} tokens ·{" "}
                {data().sessions} sessions
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
      <div class="usage-history__ranges">
        <button type="button" onClick={() => props.onRefresh?.()} disabled={!props.onRefresh}>
          {props.error ? "Retry" : "Refresh"}
        </button>
        <button
          type="button"
          onClick={() => props.onCopy?.()}
          disabled={!props.usage || !!props.error || props.copying || !props.onCopy}
        >
          {props.copying ? "Copying report…" : "Copy JSON report"}
        </button>
      </div>
      <Show when={props.usage}>
        {(data) => (
          <p class="usage-history__empty">
            Settled model steps ·{" "}
            {data().since === undefined ? "All recorded time" : new Date(data().since!).toISOString()} through{" "}
            {new Date(data().until).toISOString()} (UTC). Tools and media may be billed separately.
          </p>
        )}
      </Show>
      <Show when={props.notice}>
        {(notice) => (
          <p role="status" class="usage-history__empty">
            {notice()}
          </p>
        )}
      </Show>
      <Show when={props.error}>
        {(message) => (
          <div role="alert" class="usage-history__empty">
            {message()}
          </div>
        )}
      </Show>
      <Show when={!props.error && !props.usage}>
        <div role="status" class="usage-history__empty">
          Loading usage…
        </div>
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
                  <strong>{costLabel(model, props.locale)}</strong>
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
  const clipboard = useClipboard()
  const [range, setRange] = createSignal<Range>(initial)
  const [request, setRequest] = createSignal("")
  const [usage, setUsage] = createSignal<ProjectUsage>()
  const [error, setError] = createSignal<string>()
  const [refresh, setRefresh] = createSignal(0)
  const [copying, setCopying] = createSignal(false)
  const [notice, setNotice] = createSignal<string>()

  const copy = async () => {
    const data = usage()
    if (!data || error() || copying()) return
    const id = request()
    setCopying(true)
    setNotice(undefined)
    await Promise.resolve()
      .then(() => clipboard.write(report(data)))
      .then(
        () => {
          if (id === request()) setNotice("Usage summary copied as JSON.")
        },
        () => {
          if (id === request()) setNotice("Copy was not confirmed. Try again to copy this summary.")
        },
      )
    setCopying(false)
  }

  const off = vscode.onMessage((message) => {
    if (message.type !== "projectUsageLoaded" || message.requestID !== request()) return
    setUsage(message.data)
    setError(message.error)
  })
  onCleanup(off)

  createEffect(() => {
    refresh()
    const value = range()
    const id = crypto.randomUUID()
    localStorage.setItem("raya.usage.range", value)
    setRequest(id)
    setUsage(undefined)
    setError(undefined)
    setNotice(undefined)
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
      onRefresh={() => setRefresh((value) => value + 1)}
      onCopy={copy}
      copying={copying()}
      notice={notice()}
    />
  )
}
