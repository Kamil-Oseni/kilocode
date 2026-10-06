import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { useVSCode } from "../../context/vscode"
import { useServer } from "../../context/server"
import type { BrainProposal, BrainProposalCommand } from "../../../../src/shared/second-brain"
import { BrainProposalView } from "./BrainProposalView"
import { groups, project, reviewed } from "./brain-proposal-state"

export function BrainProposals(props: { configured: boolean }) {
  const vscode = useVSCode()
  const server = useServer()
  const [rows, setRows] = createSignal<readonly BrainProposal[]>([])
  const [selected, setSelected] = createSignal<BrainProposal>()
  const [pending, setPending] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let request = ""
  let scope = ""
  const send = (command: BrainProposalCommand) => {
    if (!props.configured || !server.workspaceDirectory() || pending()) return
    request = crypto.randomUUID()
    setPending(true)
    setError()
    vscode.postMessage({ type: "secondBrain", action: "proposal", id: request, command })
  }
  createEffect(() => {
    const next = `${props.configured}:${server.isConnected()}:${server.workspaceDirectory()}`
    if (next === scope) return
    scope = next
    request = ""
    setRows([])
    setSelected()
    setPending(false)
    setLoaded(false)
    setError()
  })
  const off = vscode.onMessage((message) => {
    if (message.type !== "secondBrainState" || message.id !== request) return
    setPending(false)
    const result = reviewed(message.state.proposals)
    if (!result) {
      setError("The proposal request did not finish. Inspect the original proposal before another write.")
      return
    }
    if ("proposals" in result) {
      setLoaded(true)
      setRows(result.proposals.filter((item) => project(item.project) === project(server.workspaceDirectory())))
      setSelected()
      return
    }
    if (project(result.project) !== project(server.workspaceDirectory())) {
      setError("Proposal belongs to another project. Refresh this project's proposals.")
      return
    }
    setSelected(result)
    setRows((items) => [...items.filter((item) => item.id !== result.id), result])
  })
  onCleanup(off)
  const act = (action: "apply" | "cancel") => {
    const value = selected()
    if (!value || value.status !== "pending" || project(value.project) !== project(server.workspaceDirectory())) return
    send({ action, project: value.project, id: value.id, digest: value.digest })
  }
  return (
    <Card>
      <h3>Review learned notes</h3>
      <p>Pending changes belong to the current project. Nothing is automatically applied.</p>
      <Button
        disabled={!props.configured || !server.workspaceDirectory() || pending()}
        onClick={() => send({ action: "list", project: server.workspaceDirectory() })}
      >
        {pending() ? "Checking proposals" : "Refresh proposals"}
      </Button>
      <Show when={error()}>{(value) => <p role="alert">{value()}</p>}</Show>
      <Show when={loaded() && !pending() && rows().length === 0 && !error()}>
        <p>No saved proposals for this project.</p>
      </Show>
      <For each={groups(rows())}>
        {(group) => (
          <section aria-label={group.title}>
            <h4>
              {group.title} · {group.items.length}
            </h4>
            <div class="raya-brain-actions">
              <For each={group.items}>
                {(item) => (
                  <Button
                    disabled={pending()}
                    title={item.changes.map((change) => change.path).join(", ")}
                    aria-label={`Review ${item.changes.map((change) => change.path).join(", ")}`}
                    onClick={() => send({ action: "read", project: item.project, id: item.id })}
                  >
                    {item.changes[0].path.split("/").slice(-2).join("/")}
                    {item.changes.length > 1 ? ` + ${item.changes.length - 1} more` : ""}
                  </Button>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
      <Show when={selected()}>
        {(value) => (
          <BrainProposalView
            proposal={value()}
            pending={pending()}
            uncertain={Boolean(error())}
            refresh={() => send({ action: "read", project: value().project, id: value().id })}
            apply={() => act("apply")}
            cancel={() => act("cancel")}
            edit={(changes) =>
              send({
                action: "edit",
                project: value().project,
                id: value().id,
                digest: value().digest,
                request: { changes, sources: value().sources },
              })
            }
          />
        )}
      </Show>
    </Card>
  )
}
