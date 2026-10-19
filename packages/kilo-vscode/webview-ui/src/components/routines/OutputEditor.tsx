import { Index, Show, createSignal, onCleanup, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Final, type Output } from "../../../../src/shared/routine-output"
import { useVSCode } from "../../context/vscode"

export const OutputEditor: Component<{
  value: Output
  onChange: (value: Output) => void
  disabled?: boolean
  onPending?: (value: boolean) => void
}> = (props) => {
  const vscode = useVSCode()
  const [request, setRequest] = createSignal("")
  const [error, setError] = createSignal("")
  let baseline = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = () => {
    clearTimeout(timer)
    setRequest("")
    props.onPending?.(false)
  }
  onCleanup(
    vscode.onMessage((msg) => {
      if (msg.type === "connectionState" && request()) {
        finish()
        setError("The connection changed. Choose the file again to review it.")
        return
      }
      if (msg.type !== "routineFinalPicked" || !request() || msg.requestID !== request()) return
      finish()
      if (props.disabled || JSON.stringify(props.value) !== baseline) {
        setError("The output draft changed. Choose the file again to review it.")
        return
      }
      if (msg.error) {
        setError(msg.error)
        return
      }
      if (msg.cancelled) return
      const final = Final.safeParse(msg.final)
      if (!final.success) {
        setError("The selected file could not be verified. Choose it again.")
        return
      }
      props.onChange({ ...props.value, final: final.data })
    }),
  )
  onCleanup(finish)
  const choose = () => {
    if (props.disabled || request()) return
    const id = crypto.randomUUID()
    baseline = JSON.stringify(props.value)
    setError("")
    setRequest(id)
    props.onPending?.(true)
    timer = setTimeout(() => {
      finish()
      setError("The file choice was not confirmed. Choose it again; the draft is unchanged.")
    }, 120_000)
    vscode.postMessage({ type: "routineFinalPick", requestID: id })
  }
  let root: HTMLFieldSetElement | undefined
  const remove = (id: string) => {
    props.onChange({ ...props.value, criteria: props.value.criteria.filter((item) => item.id !== id) })
    queueMicrotask(() => {
      if (root?.isConnected) root.querySelector<HTMLButtonElement>("[data-add-criterion]")?.focus()
    })
  }
  const add = () => {
    props.onChange({
      ...props.value,
      criteria: [
        ...props.value.criteria,
        {
          id: `criterion-${crypto.randomUUID()}`,
          description: "",
          verification: "",
        },
      ],
    })
    queueMicrotask(() => {
      if (root?.isConnected) [...root.querySelectorAll("fieldset")].at(-1)?.querySelector("textarea")?.focus()
    })
  }
  const change = (id: string, patch: Partial<Output["criteria"][number]>) =>
    props.onChange({
      ...props.value,
      criteria: props.value.criteria.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })
  return (
    <fieldset ref={root} class="routines-schedule" disabled={props.disabled || !!request()}>
      <legend>Result and checks</legend>
      <p class="routines-hint">
        Results stay in this run’s conversation. Describe the deliverable and the checks it must satisfy.
      </p>
      <label class="routines-field">
        Required output
        <textarea
          required
          maxLength={4000}
          rows={3}
          value={props.value.description}
          onInput={(event) => props.onChange({ ...props.value, description: event.currentTarget.value })}
        />
      </label>
      <fieldset class="routines-schedule">
        <legend>Exact final answer (optional)</legend>
        <p class="routines-hint">
          Choose a UTF-8 file up to 8192 bytes. The final answer must match this approved revision exactly, including
          whitespace. A complete, untruncated Read is required. The routine must already have permission to read the
          source file; choosing it does not grant access. A failed check holds automatic work until you review the
          original result and choose a new manual run.
        </p>
        <Show when={props.value.final}>
          {(final) => (
            <div data-routine-final>
              <p>Source: {final().path}</p>
              <p>Bytes: {final().bytes}</p>
              <p>SHA-256: {final().sha256}</p>
              <p>
                Review this revision before saving. Changed or unavailable source files cannot satisfy this requirement.
              </p>
            </div>
          )}
        </Show>
        <Button type="button" variant="secondary" onClick={choose}>
          {request()
            ? "Choosing final-answer file"
            : props.value.final
              ? "Choose another final-answer file"
              : "Choose final-answer file"}
        </Button>
        <Show when={props.value.final}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              props.onChange({ ...props.value, final: undefined })
              setError("")
            }}
          >
            Remove exact final answer
          </Button>
        </Show>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </fieldset>
      <Index each={props.value.criteria}>
        {(item, index) => (
          <fieldset class="routines-schedule">
            <legend>Criterion {index + 1}</legend>
            <label class="routines-field">
              What must be true?
              <textarea
                required
                maxLength={4000}
                rows={2}
                value={item().description}
                onInput={(event) => change(item().id, { description: event.currentTarget.value })}
              />
            </label>
            <label class="routines-field">
              How should Raya verify it?
              <textarea
                required
                maxLength={4000}
                rows={2}
                value={item().verification}
                onInput={(event) => change(item().id, { verification: event.currentTarget.value })}
              />
            </label>
            <Button
              type="button"
              variant="secondary"
              disabled={props.disabled || props.value.criteria.length === 1}
              onClick={() => remove(item().id)}
            >
              Remove criterion {index + 1}
            </Button>
          </fieldset>
        )}
      </Index>
      <Button
        data-add-criterion
        type="button"
        variant="secondary"
        disabled={props.disabled || props.value.criteria.length >= 20}
        onClick={add}
      >
        Add criterion
      </Button>
      <p class="routines-hint">
        Use evidence such as source references or test results. If a person must judge the result, specify that review
        here.
      </p>
    </fieldset>
  )
}
