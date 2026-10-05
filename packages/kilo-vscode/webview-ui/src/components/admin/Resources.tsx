import { Show } from "solid-js"
import { Card } from "@kilocode/kilo-ui/card"
import type { AdminResources } from "../../../../src/shared/admin"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function observed(value: unknown): AdminResources | undefined {
  if (!record(value) || !record(value.process) || !record(value.host) || !record(value.inference)) return
  const process = value.process
  const host = value.host
  const inference = value.inference
  const fields = [
    value.observedAt,
    process.pid,
    process.rss,
    process.heapUsed,
    process.heapTotal,
    host.free,
    host.total,
    inference.active,
    inference.queued,
    inference.bytes,
  ]
  if (fields.some((item) => typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) return
  if (
    Number(process.pid) < 1 ||
    Number(host.free) > Number(host.total) ||
    Number(process.heapUsed) > Number(process.heapTotal)
  )
    return
  return value as AdminResources
}

export function Resources(props: { value: unknown }) {
  const value = () => observed(props.value)
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  return (
    <Card>
      <h2>Shared resources</h2>
      <Show
        when={value()}
        fallback={<p>Resource readings are not available from this backend. Refresh after connecting.</p>}
      >
        {(sample) => (
          <>
            <p>
              Backend memory: {gib(sample().process.rss)} · Process {sample().process.pid}
            </p>
            <p>
              JavaScript heap: {gib(sample().process.heapUsed)} used of {gib(sample().process.heapTotal)}
            </p>
            <p>
              PC RAM available: {gib(sample().host.free)} of {gib(sample().host.total)}
            </p>
            <p>
              Local inference: {sample().inference.active} active · {sample().inference.queued} waiting
            </p>
            <p>Waiting request data: {(sample().inference.bytes / 1024).toFixed(1)} KiB</p>
            <p>Observed {new Date(sample().observedAt).toLocaleTimeString()}. Refresh for current readings.</p>
            <p>
              These readings are shared across tasks. Backend memory excludes separately running model and speech
              services. GPU memory is not reported here.
            </p>
          </>
        )}
      </Show>
    </Card>
  )
}
