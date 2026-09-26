import { Button } from "@kilocode/kilo-ui/button"
import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import { routineFailure } from "../../utils/routine-recovery"
import { ArtifactList } from "./ArtifactList"
import { validSummary, validWork } from "./OrganizationActivity"

type Work = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationActivityResponse["items"][number]

export const ArchivedWork: Component<{ id: string }> = (props) => {
  const vscode = useVSCode()
  const [items, setItems] = createSignal<Work[]>([])
  const [next, setNext] = createSignal<string>()
  const [total, setTotal] = createSignal<number>()
  const [active, setActive] = createSignal(0)
  const [pending, setPending] = createSignal<{ id: string; cursor?: string }>()
  const [error, setError] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined

  const load = (cursor?: string) => {
    if (pending()) return
    clearTimeout(timer)
    const id = crypto.randomUUID()
    setError("")
    setPending({ id, cursor })
    timer = setTimeout(() => {
      setPending()
      setError("Saved work took too long to load. Try again.")
    }, 15_000)
    vscode.postMessage({
      type: "routineOrganizationActivity",
      requestID: id,
      organizationID: props.id,
      ...(cursor ? { cursor } : {}),
    })
  }

  const unsubscribe = vscode.onMessage((msg: ExtensionMessage) => {
    if (msg.type === "workspaceDirectoryChanged") {
      clearTimeout(timer)
      setPending()
      setItems([])
      setNext()
      setTotal()
      setError("The workspace changed. Reopen this team to see its saved work.")
      return
    }
    if (msg.type !== "routineOrganizationActivity") return
    const request = pending()
    if (!request || msg.requestID !== request.id || msg.organizationID !== props.id) return
    clearTimeout(timer)
    setPending()
    if (msg.error || !Array.isArray(msg.items) || msg.items.length > 50 || !validSummary(msg.summary)) {
      setError(routineFailure(msg.error ?? "Saved work could not be verified.", msg.recovery))
      return
    }
    if (msg.items.some((item) => !validWork(item) || item.organizationID !== props.id)) {
      setError("Saved work did not match this team. Refresh before reading it.")
      return
    }
    if (
      msg.next !== undefined &&
      (typeof msg.next !== "string" || !msg.next || msg.next.length > 256 || msg.next === request.cursor)
    ) {
      setError("This work page repeated. Refresh the team before continuing.")
      return
    }
    setItems((prior) => {
      const ids = new Set(prior.map((item) => item.id))
      return request.cursor ? [...prior, ...msg.items!.filter((item) => !ids.has(item.id))] : msg.items!
    })
    setNext(msg.next)
    setTotal(msg.summary.total)
    setActive(
      Math.max(
        msg.summary.active,
        msg.items.filter((item) => ["queued", "accepted", "running", "needs_input"].includes(item.state)).length,
      ),
    )
  })
  onMount(() => load())
  onCleanup(() => {
    clearTimeout(timer)
    unsubscribe()
  })

  return (
    <section class="routines-organization-work routines-archived-work" aria-label="Saved work">
      <div class="routines-organization-work-head">
        <div>
          <h3>Saved work</h3>
          <Show when={total() !== undefined}>
            <p class="routines-archived-note">{total()} tracked requests</p>
          </Show>
        </div>
        <Button variant="ghost" size="small" disabled={!!pending()} onClick={() => load()}>
          Refresh
        </Button>
      </div>
      <Show when={active() > 0}>
        <p class="routines-organization-error" role="alert">
          Some saved work still appears active. This team cannot be assigned new work; refresh to check its final state.
        </p>
      </Show>
      <Show when={error()}>
        <p class="routines-organization-error" role="alert">
          {error()}
        </p>
        <Button variant="ghost" size="small" disabled={!!pending()} onClick={() => load()}>
          Retry
        </Button>
      </Show>
      <Show when={pending() && !items().length}>
        <p class="routines-archived-note" role="status">
          Loading saved work…
        </p>
      </Show>
      <Show when={!pending() && !error() && !items().length}>
        <p class="routines-archived-empty">No tracked work was saved for this team.</p>
      </Show>
      <Show when={items().length}>
        <ol class="routines-organization-work-list">
          <For each={items()}>
            {(item) => (
              <li>
                <div class="routines-organization-work-route">
                  <span>
                    {item.sender.name} → {item.recipient.name}
                  </span>
                  <span class="routines-organization-work-state" data-state={item.state}>
                    {item.state === "cancelled" ? "Stopped" : item.state.replace("_", " ")}
                  </span>
                </div>
                <p class="routines-organization-work-objective">{item.objective}</p>
                <ArtifactList items={item.artifacts} />
                <Show when={item.response}>
                  <p class="routines-organization-work-result">{item.response}</p>
                </Show>
                <Show when={item.reason}>
                  <p class="routines-error">{item.reason}</p>
                </Show>
                <div class="routines-organization-work-meta">Updated {new Date(item.updated).toLocaleString()}</div>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={next() && !error()}>
        <Button variant="ghost" size="small" disabled={!!pending()} onClick={() => load(next())}>
          Load earlier work
        </Button>
      </Show>
    </section>
  )
}
