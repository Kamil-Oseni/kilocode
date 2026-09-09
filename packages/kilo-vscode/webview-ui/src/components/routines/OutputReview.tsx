import { Button } from "@kilocode/kilo-ui/button"
import { Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { Output } from "../../../../src/shared/routine-output"
import { useVSCode } from "../../context/vscode"
import { OutputEditor } from "./OutputEditor"

export function OutputReview(props: { item: { id: string; name: string; output?: Output }; onClose: () => void }) {
  const vscode = useVSCode()
  const id = createUniqueId()
  const expected = props.item.output === undefined ? "unset" : Output.parse(props.item.output)
  const [draft, setDraft] = createSignal<Output>(
    expected === "unset"
      ? {
          destination: "conversation",
          description: "",
          criteria: [{ id: `criterion-${crypto.randomUUID()}`, description: "", verification: "" }],
        }
      : expected,
  )
  const [request, setRequest] = createSignal("")
  const [error, setError] = createSignal("")
  const [saved, setSaved] = createSignal(false)
  const valid = createMemo(() => Output.safeParse(draft()).success)
  let root: HTMLElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  onMount(() => root?.focus())
  const unsub = vscode.onMessage((msg) => {
    if (
      msg.type !== "routineOutputUpdated" ||
      msg.agentID !== props.item.id ||
      !request() ||
      msg.requestID !== request()
    )
      return
    clearTimeout(timer)
    setRequest("")
    if (msg.error) return setError(msg.error)
    const result = Output.safeParse(msg.output)
    if (!result.success || JSON.stringify(result.data) !== JSON.stringify(Output.parse(draft())))
      return setError("The saved requirements did not match your changes. Close and reload the routine.")
    setSaved(true)
    vscode.postMessage({ type: "routineList" })
  })
  onCleanup(() => {
    clearTimeout(timer)
    unsub()
  })
  const save = () => {
    if (!valid() || request() || error() || saved()) return
    const requestID = crypto.randomUUID()
    setRequest(requestID)
    timer = setTimeout(() => {
      setRequest("")
      setError("The save could not be confirmed. Close and reload the routine before trying again.")
    }, 15_000)
    vscode.postMessage({
      type: "routineOutputUpdate",
      requestID,
      agentID: props.item.id,
      output: draft(),
      expectedOutput: expected,
    })
  }
  return (
    <section
      ref={root}
      class="routines-instructions"
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          props.onClose()
        }
      }}
    >
      <h3 id={`${id}-title`}>Output requirements for {props.item.name}</h3>
      <p class="routines-hint">
        Changes apply to future runs. Existing runs keep their saved requirements. Saving does not enable the routine or
        start work.
      </p>
      <OutputEditor value={draft()} onChange={setDraft} disabled={!!request() || !!error() || saved()} />
      <Show when={error()}>
        <p role="alert" class="routines-error">
          {error()}
        </p>
      </Show>
      <Show when={saved()}>
        <p role="status">Output requirements saved. The routine list is refreshing.</p>
      </Show>
      <Button size="small" disabled={!valid() || !!request() || !!error() || saved()} onClick={save}>
        {request() ? "Saving requirements" : "Save requirements"}
      </Button>
      <Button size="small" variant="ghost" onClick={props.onClose}>
        Close output review
      </Button>
    </section>
  )
}
