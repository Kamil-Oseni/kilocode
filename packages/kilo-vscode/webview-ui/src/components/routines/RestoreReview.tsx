import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import { Review, type Review as Summary } from "../../../../src/shared/restore-review"

export function RestoreReview() {
  const vscode = useVSCode()
  const [summary, setSummary] = createSignal<Summary>()
  const [request, setRequest] = createSignal("")
  const [error, setError] = createSignal("")
  const [folders, setFolders] = createSignal(false)
  const [credentials, setCredentials] = createSignal(false)
  const timer: { id?: ReturnType<typeof setTimeout> } = {}
  const begin = () => {
    clearTimeout(timer.id)
    const id = crypto.randomUUID()
    setRequest(id)
    setError("")
    timer.id = setTimeout(() => {
      setRequest("")
      setSummary(undefined)
      setFolders(false)
      setCredentials(false)
      setError("The profile review was not confirmed. Reload it to check its current state.")
    }, 20000)
    return id
  }
  const reload = () => {
    if (request()) return
    setFolders(false)
    setCredentials(false)
    vscode.postMessage({ type: "restoreReviewGet", requestID: begin() })
  }
  const approve = () => {
    const value = summary()
    if (!value || value.state !== "held" || !value.id || !value.revision || request() || !folders() || !credentials())
      return
    if (value.workers.some((worker) => worker.enabled)) return
    vscode.postMessage({
      type: "restoreReviewApprove",
      requestID: begin(),
      approval: {
        id: value.id,
        revision: value.revision,
        reviewed: true,
        workspacesAcknowledged: true,
        reconnectAcknowledged: true,
      },
    })
  }
  const unsubscribe = vscode.onMessage((message) => {
    if (message.type !== "restoreReviewResult" || !request() || message.requestID !== request()) return
    clearTimeout(timer.id)
    setRequest("")
    setFolders(false)
    setCredentials(false)
    if (message.error) {
      setSummary(undefined)
      setError(message.error)
      return
    }
    const parsed = Review.safeParse(message.summary)
    if (!parsed.success) {
      setSummary(undefined)
      setError("This profile's review is incomplete. Reload it before approving.")
      return
    }
    setSummary(parsed.data)
    setError("")
  })
  onMount(reload)
  onCleanup(() => {
    clearTimeout(timer.id)
    unsubscribe()
  })
  return (
    <Show when={error() || (summary() && summary()?.state !== "absent")}>
      <section class="routines-restore-review" aria-label="Transferred profile review">
        <h3>Transferred profile</h3>
        <Show when={error()}>
          <p class="routines-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={summary()?.state === "held"}>
          <p>Review the folders and paused workers on this computer. Old runs remain paused and will not replay.</p>
          <details>
            <summary>Mapped folders ({summary()?.workspaces.length ?? 0})</summary>
            <ul>
              <For each={summary()?.workspaces}>
                {(item) => (
                  <li>
                    <span>{item.source}</span>
                    <span>→ {item.destination}</span>
                  </li>
                )}
              </For>
            </ul>
          </details>
          <details>
            <summary>Transferred workers ({summary()?.workers.length ?? 0})</summary>
            <ul>
              <For each={summary()?.workers}>
                {(worker) => (
                  <li>
                    {worker.name} — {worker.enabled ? "Enabled: pause before reviewing" : "Paused"}
                  </li>
                )}
              </For>
            </ul>
          </details>
          <Checkbox checked={folders()} disabled={!!request()} onChange={setFolders}>
            I reviewed the mapped folders and paused workers.
          </Checkbox>
          <Checkbox checked={credentials()} disabled={!!request()} onChange={setCredentials}>
            I understand that credentials must be reconnected before starting workers.
          </Checkbox>
          <Button
            onClick={approve}
            disabled={
              !!request() || !folders() || !credentials() || summary()?.workers.some((worker) => worker.enabled)
            }
          >
            Review this profile
          </Button>
        </Show>
        <Show when={summary()?.state === "released"}>
          <p>This profile has been reviewed. Enable each worker when you are ready. Old runs will not replay.</p>
        </Show>
        <div class="routines-restore-actions">
          <Button variant="ghost" size="small" disabled={!!request()} onClick={reload}>
            Reload review
          </Button>
          <Show when={summary()?.state !== "absent" && summary()?.reconnectCredentials}>
            <Button
              variant="ghost"
              size="small"
              onClick={() => vscode.postMessage({ type: "openSettingsPanel", tab: "providers" })}
            >
              Reconnect credentials
            </Button>
          </Show>
        </div>
      </section>
    </Show>
  )
}
