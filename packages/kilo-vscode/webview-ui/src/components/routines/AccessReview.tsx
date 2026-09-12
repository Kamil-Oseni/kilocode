import { Button } from "@kilocode/kilo-ui/button"
import { Show, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"

export function AccessReview(props: {
  item: { id: string; name: string; access?: "brief" | "full"; dir?: string }
  onClose: () => void
}) {
  const vscode = useVSCode()
  const id = createUniqueId()
  const expected = props.item.access ?? "unset"
  const [choice, setChoice] = createSignal<"" | "brief" | "full">("")
  const [request, setRequest] = createSignal("")
  const [error, setError] = createSignal("")
  const [saved, setSaved] = createSignal(false)
  let root: HTMLElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  onMount(() => root?.focus())
  const unsub = vscode.onMessage((msg) => {
    if (
      msg.type !== "routineAccessUpdated" ||
      msg.agentID !== props.item.id ||
      !request() ||
      msg.requestID !== request()
    )
      return
    clearTimeout(timer)
    setRequest("")
    if (msg.error) return setError([msg.error, msg.recovery?.next].filter(Boolean).join(" "))
    if (msg.access !== choice())
      return setError("The saved access did not match your choice. Close and reload the routine.")
    setSaved(true)
    vscode.postMessage({ type: "routineList" })
  })
  onCleanup(() => {
    clearTimeout(timer)
    unsub()
  })
  const save = () => {
    const access = choice()
    if (!access || request() || saved()) return
    const requestID = crypto.randomUUID()
    setError("")
    setRequest(requestID)
    timer = setTimeout(() => {
      setRequest("")
      setError("The save could not be confirmed. Close and reload the routine before trying again.")
    }, 15_000)
    vscode.postMessage({
      type: "routineAccessUpdate",
      requestID,
      agentID: props.item.id,
      access,
      expectedAccess: expected,
    })
  }
  return (
    <section
      ref={root}
      class="routines-instructions"
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || (event.target instanceof Element && event.target.tagName === "SELECT")) return
        event.preventDefault()
        props.onClose()
      }}
    >
      <h3 id={`${id}-title`}>Tool access for {props.item.name}</h3>
      <p class="routines-hint">
        {expected === "unset"
          ? "This older routine has no saved access choice; its role previously determined tool permissions."
          : `Saved access: ${expected === "full" ? "full tool access" : "read and report"}.`}
      </p>
      <p class="routines-hint">
        Choose access for future runs. Saving does not enable this routine or start work. An existing session keeps its
        current permissions. Read and report allows workspace reading, search, questions and goal tracking. Other tool
        permissions, including shell, browser actions and delegation, are denied. Full access permits external tools and
        actions as well as editing, unless a saved tool list restricts them. Neither profile is an operating-system
        sandbox.
      </p>
      <Show when={props.item.dir?.trim()}>
        {(folder) => (
          <p class="routines-hint">
            Writable location: {folder()}. File tools write here and cannot write in parent folders. Reading can still
            use other locations. Shell is not confined.
          </p>
        )}
      </Show>
      <label for={`${id}-choice`}>Tool access</label>
      <select
        id={`${id}-choice`}
        value={choice()}
        disabled={!!request() || saved()}
        onChange={(event) => {
          const value = event.currentTarget.value
          if (value === "brief" || value === "full" || value === "") setChoice(value)
        }}
      >
        <option value="">Choose access</option>
        <option value="brief">Read and report</option>
        <option value="full">Full tool access</option>
      </select>
      <Show when={error()}>
        <p role="alert" class="routines-error">
          {error()}
        </p>
      </Show>
      <Show when={saved()}>
        <p role="status">Access saved. The routine list is refreshing.</p>
      </Show>
      <Button size="small" disabled={!choice() || !!request() || saved() || !!error()} onClick={save}>
        {request() ? "Saving access" : "Save access"}
      </Button>
      <Button size="small" variant="ghost" onClick={props.onClose}>
        Close access review
      </Button>
    </section>
  )
}
