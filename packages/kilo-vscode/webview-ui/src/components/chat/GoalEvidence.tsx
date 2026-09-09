import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import type { GoalEvidence as Evidence, GoalSource } from "../../../../src/shared/goal"
import { GoalInspection } from "./GoalInspection"

export function GoalEvidence(props: {
  sessionID: string
  evidence: Evidence
  createdAt?: number
  revisionID?: string
}) {
  const vscode = useVSCode()
  const [visible, setVisible] = createSignal(false)
  const [pending, setPending] = createSignal<string>()
  const [source, setSource] = createSignal<GoalSource>()
  const [error, setError] = createSignal<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const reset = () => {
    clearTimeout(timer)
    setPending(undefined)
  }
  const exact = () => !!(props.evidence.sessionID && props.evidence.messageID && props.evidence.partID)
  createEffect(() => {
    props.sessionID
    props.evidence
    props.createdAt
    props.revisionID
    reset()
    setVisible(false)
    setSource(undefined)
    setError(undefined)
  })
  const off = vscode.onMessage((message) => {
    if (
      message.type !== "goalEvidenceResult" ||
      message.sessionID !== props.sessionID ||
      message.requestID !== pending()
    )
      return
    reset()
    setSource(message.source)
    setError(message.error ?? (message.source ? undefined : "The source could not be confirmed."))
  })
  onCleanup(() => {
    reset()
    off()
  })
  const load = () => {
    if (!exact() || pending()) return
    const requestID = crypto.randomUUID()
    setVisible(true)
    setSource(undefined)
    setError(undefined)
    setPending(requestID)
    timer = setTimeout(() => {
      reset()
      setError("The source request timed out. Try again when the backend is available.")
    }, 15_000)
    vscode.postMessage({
      type: "goalEvidence",
      sessionID: props.sessionID,
      requestID,
      evidence: props.evidence,
      createdAt: props.createdAt,
      revisionID: props.revisionID,
    })
  }
  return (
    <div class="goal-banner__source">
      <Show when={exact()} fallback={<span>Exact source identity was not recorded.</span>}>
        <Button
          size="small"
          variant="ghost"
          aria-expanded={visible()}
          onClick={() => {
            if (!visible()) return load()
            reset()
            setVisible(false)
          }}
        >
          {visible() ? "Hide source" : "View source"}
        </Button>
        <Show when={visible()}>
          <div class="goal-banner__source-body" aria-label="Cited tool result">
            <p>Recorded result only. Opening it does not rerun verification or confirm the current file.</p>
            <div role="status" aria-live="polite">
              <Show when={pending()}>Loading cited result…</Show>
              <Show when={error()}>
                {(text) => (
                  <>
                    <p>{text()}</p>
                    <Button size="small" variant="secondary" onClick={load}>
                      Retry
                    </Button>
                  </>
                )}
              </Show>
            </div>
            <Show when={source()}>
              {(record) => (
                <>
                  <p>
                    {record().tool} · {record().status}
                  </p>
                  <p>
                    {record().receipt === "matching"
                      ? "Matches the result recorded by the accepted audit."
                      : "No accepted-audit content receipt was recorded for this result."}
                  </p>
                  <p>
                    Session: {props.evidence.sessionID}
                    <br />
                    Message: {props.evidence.messageID}
                    <br />
                    Result: {props.evidence.partID}
                  </p>
                  <GoalInspection inspection={record().inspection} />
                  <strong>Input</strong>
                  <pre tabIndex={0} aria-label="Recorded tool input">
                    {record().input}
                  </pre>
                  <strong>Output</strong>
                  <pre tabIndex={0} aria-label="Recorded tool output">
                    {record().output}
                  </pre>
                  <details>
                    <summary>Recorded metadata</summary>
                    <pre tabIndex={0} aria-label="Recorded tool metadata">
                      {record().metadata}
                    </pre>
                  </details>
                  <Show when={record().truncated}>
                    <p>This preview is truncated to 50,000 characters per field.</p>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}
