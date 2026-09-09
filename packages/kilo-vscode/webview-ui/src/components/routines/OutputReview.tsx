import { Button } from "@kilocode/kilo-ui/button"
import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { Output } from "../../../../src/shared/routine-output"
import { useVSCode } from "../../context/vscode"
import { OutputEditor } from "./OutputEditor"

export function OutputReview(props: { item: { id: string; name: string; output?: Output }; onClose: () => void }) {
  const vscode = useVSCode()
  const id = createUniqueId()
  const [expected, setExpected] = createSignal<Output | "unset">(
    props.item.output === undefined ? "unset" : Output.parse(props.item.output),
  )
  const [loading, setLoading] = createSignal("")
  const [current, setCurrent] = createSignal<{ output: Output | "unset" }>()
  const [draft, setDraft] = createSignal<Output>(
    expected() === "unset"
      ? {
          destination: "conversation",
          description: "",
          criteria: [{ id: `criterion-${crypto.randomUUID()}`, description: "", verification: "" }],
        }
      : (expected() as Output),
  )
  const [request, setRequest] = createSignal("")
  const [error, setError] = createSignal("")
  const [saved, setSaved] = createSignal(false)
  const valid = createMemo(() => Output.safeParse(draft()).success)
  let root: HTMLElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  onMount(() => root?.focus())
  const receive = (msg: { error?: string; agents?: unknown[] }) => {
    if (!msg.error && !Array.isArray(msg.agents)) return
    clearTimeout(timer)
    setLoading("")
    if (msg.error) return setError(msg.error)
    const item = msg.agents?.find(
      (value) => value && typeof value === "object" && Reflect.get(value, "id") === props.item.id,
    )
    if (!item || typeof item !== "object")
      return setError("This routine is no longer available. Your draft is shown below.")
    const value = Reflect.get(item, "output")
    const parsed = value === undefined ? undefined : Output.safeParse(value)
    if (parsed && !parsed.success)
      return setError("The current requirements could not be read. Your draft is unchanged.")
    setCurrent({ output: parsed?.data ?? "unset" })
  }
  const unsub = vscode.onMessage((msg) => {
    if (msg.type === "routineState" && loading() && msg.requestID === loading()) {
      return receive(msg)
    }
    if (
      msg.type !== "routineOutputUpdated" ||
      msg.agentID !== props.item.id ||
      !request() ||
      msg.requestID !== request()
    )
      return
    clearTimeout(timer)
    setRequest("")
    if (msg.error) return setError([msg.error, msg.recovery?.next].filter(Boolean).join(" "))
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
      expectedOutput: expected(),
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
        <Button
          size="small"
          disabled={!!loading()}
          onClick={() => {
            const requestID = crypto.randomUUID()
            setCurrent(undefined)
            setLoading(requestID)
            timer = setTimeout(() => {
              setLoading("")
              setError("The current requirements could not be loaded. Your draft is unchanged; try loading again.")
            }, 15_000)
            vscode.postMessage({ type: "routineList", requestID })
          }}
        >
          {loading() ? "Loading current requirements" : "Compare with current requirements"}
        </Button>
        <Show when={current()}>
          {(value) => (
            <div>
              <h4>Currently saved requirements</h4>
              {(() => {
                const saved = value().output
                if (saved === "unset") return <p>No output requirements are saved.</p>
                return (
                  <div data-routine-comparison>
                    <p>{saved.description}</p>
                    <ul>
                      <For each={saved.criteria}>
                        {(criterion) => (
                          <li>
                            <strong>{criterion.description}</strong>
                            <p>Verify: {criterion.verification}</p>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                )
              })()}
              <p>
                Your draft above is unchanged. Continuing uses this saved version as the comparison baseline; it does
                not save or start work.
              </p>
              <Button
                size="small"
                onClick={() => {
                  setExpected(value().output)
                  setCurrent(undefined)
                  setError("")
                }}
              >
                Keep my draft and continue editing
              </Button>
            </div>
          )}
        </Show>
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
