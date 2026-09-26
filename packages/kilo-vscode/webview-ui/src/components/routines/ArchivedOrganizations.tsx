import { For, Show, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import { routineFailure } from "../../utils/routine-recovery"
import type { ExtensionMessage } from "../../types/messages"
import { RetainedWorkerConversation } from "./RetainedWorkerConversation"

type Organization = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationListResponse["items"][number]

export const ArchivedOrganizations: Component<{
  agents: { id: string; name: string }[]
}> = (props) => {
  const vscode = useVSCode()
  const [items, setItems] = createSignal<Organization[]>([])
  const [open, setOpen] = createSignal(false)
  const [next, setNext] = createSignal<string>()
  const [selected, setSelected] = createSignal<string>()
  const [member, setMember] = createSignal<string>()
  const [error, setError] = createSignal("")
  const [request, setRequest] = createSignal<{ id: string; cursor?: string }>()
  const current = createMemo(() => items().find((item) => item.id === selected()))
  let timer: ReturnType<typeof setTimeout> | undefined

  const read = (cursor?: string) => {
    if (request()) return
    clearTimeout(timer)
    const id = crypto.randomUUID()
    setError("")
    setRequest({ id, cursor })
    timer = setTimeout(() => {
      setRequest()
      setError("Archived teams took too long to load. Try again.")
    }, 15_000)
    vscode.postMessage({ type: "routineOrganizationArchivedList", requestID: id, ...(cursor ? { cursor } : {}) })
  }

  const toggle = () => {
    if (open()) {
      clearTimeout(timer)
      setOpen(false)
      setSelected()
      setMember()
      setRequest()
      return
    }
    setOpen(true)
    setItems([])
    setNext()
    read()
  }

  const unsubscribe = vscode.onMessage((msg: ExtensionMessage) => {
    if (msg.type === "workspaceDirectoryChanged") {
      clearTimeout(timer)
      setOpen(false)
      setItems([])
      setNext()
      setSelected()
      setMember()
      setError("")
      setRequest()
      return
    }
    if (msg.type !== "routineOrganizationArchivedList") return
    const pending = request()
    if (!pending || msg.requestID !== pending.id) return
    clearTimeout(timer)
    setRequest()
    if (msg.error || !msg.items) {
      setError(routineFailure(msg.error ?? "Archived teams could not be loaded.", msg.recovery))
      return
    }
    const page = msg.items as Organization[]
    setItems((prior) => {
      const ids = new Set(prior.map((item) => item.id))
      return pending.cursor ? [...prior, ...page.filter((item) => !ids.has(item.id))] : page
    })
    setNext(msg.next && msg.next !== pending.cursor ? msg.next : undefined)
    if (msg.next && msg.next === pending.cursor) setError("This page repeated. Refresh archived teams to continue.")
  })
  onCleanup(() => {
    clearTimeout(timer)
    unsubscribe()
  })

  return (
    <section class="routines-archived-directory" aria-label="Archived teams">
      <Button variant="ghost" size="small" icon={open() ? "chevron-down" : "chevron-right"} onClick={toggle}>
        Archived teams
      </Button>
      <Show when={open()}>
        <div class="routines-archived-content">
          <p class="routines-archived-note">
            Their workers are stopped. Saved conversations and work remain available.
          </p>
          <Show when={error()}>
            <p class="routines-organization-error" role="alert">
              {error()}
            </p>
            <Button variant="ghost" size="small" disabled={!!request()} onClick={() => read()}>
              Retry
            </Button>
          </Show>
          <Show when={!request() && !error() && items().length === 0}>
            <p class="routines-archived-empty">No archived teams yet.</p>
          </Show>
          <div class="routines-team-directory-list">
            <For each={items()}>
              {(item) => (
                <button
                  type="button"
                  aria-expanded={selected() === item.id}
                  onClick={() => {
                    setSelected(selected() === item.id ? undefined : item.id)
                    setMember()
                  }}
                >
                  <span class="routines-team-directory-name">{item.name}</span>
                  <span class="routines-team-directory-purpose">
                    {item.purpose || `${item.members.length} workers`}
                  </span>
                  <span class="routines-team-directory-count">
                    {item.members.length} workers · Archived{" "}
                    {new Date(item.archivedAt ?? item.updatedAt).toLocaleDateString()}
                  </span>
                </button>
              )}
            </For>
          </div>
          <Show when={current()} keyed>
            {(item) => (
              <div class="routines-archived-detail" aria-label={`${item.name} saved workers`}>
                <strong>{item.name}</strong>
                <p>These workers cannot run from this team. Open a conversation to review its saved work.</p>
                <ul>
                  <For each={item.members}>
                    {(member) => {
                      const worker = props.agents.find((agent) => agent.id === member.agentID)
                      return (
                        <li>
                          <span>{worker?.name ?? member.role}</span>
                          <Button variant="ghost" size="small" onClick={() => setMember(member.agentID)}>
                            Open conversation
                          </Button>
                        </li>
                      )
                    }}
                  </For>
                </ul>
                <Show when={member()} keyed>
                  {(id) => (
                    <RetainedWorkerConversation
                      agentID={id}
                      name={
                        props.agents.find((agent) => agent.id === id)?.name ??
                        item.members.find((part) => part.agentID === id)?.role ??
                        "Worker"
                      }
                      onClose={() => setMember()}
                    />
                  )}
                </Show>
              </div>
            )}
          </Show>
          <Show when={request()}>
            <p class="routines-archived-note" role="status">
              Loading archived teams…
            </p>
          </Show>
          <Show when={next()}>
            <Button variant="ghost" size="small" disabled={!!request()} onClick={() => read(next())}>
              Show more
            </Button>
          </Show>
        </div>
      </Show>
    </section>
  )
}
