import { createMemo, createResource, onCleanup } from "solid-js"
import type { TuiPluginApi } from "@kilocode/plugin/tui"
import { costLabel } from "@opencode-ai/core/kilocode/accounting-label"

export function accounting(api: Pick<TuiPluginApi, "client" | "event">, session: () => string) {
  const [usage, { refetch }] = createResource(session, async (id) => {
    return api.client.kilocode.sessionModelUsage({ sessionID: id }).then(
      (result) => ({ id, data: result.data }),
      () => ({ id, data: undefined }),
    )
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void refetch()
    }, 200)
  }
  const off = [
    api.event.on("message.part.updated", (event) => {
      if (event.properties.part.type === "step-finish") refresh()
    }),
    api.event.on("session.status", (event) => {
      if (event.properties.status.type === "idle") refresh()
    }),
    api.event.on("session.deleted", refresh),
  ]
  onCleanup(() => {
    if (timer) clearTimeout(timer)
    for (const dispose of off) dispose()
  })
  const current = createMemo(() => {
    if (usage.error) return undefined
    const result = usage()
    return result?.id === session() ? result.data : undefined
  })
  return {
    label: (brief = false) => {
      const result = current()
      if (!result) return usage.loading ? "Loading cost..." : "Cost unavailable"
      return `${costLabel(result.totals, "en-US", brief)}${usage.loading ? " (updating)" : ""}`
    },
    scope: () => "Settled model steps · includes related conversations",
  }
}
