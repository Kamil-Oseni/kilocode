import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"

const reads = [
  "read",
  "glob",
  "grep",
  "list",
  "skill",
  "todoread",
  "todowrite",
  "get_goal",
  "update_goal",
  "update_goal_plan",
  "inspect_team",
]
const view = ["read", "glob", "grep", "list"]
const groups = [
  { name: "Read workspace", tools: view },
  { name: "Change files", tools: ["edit", "write", "apply_patch"] },
  { name: "Commands", tools: ["bash", "background_process", "interactive_terminal"] },
  { name: "Browser and web", tools: ["browser_*", "websearch", "webfetch"] },
  { name: "Delegation", tools: ["inspect_team", "task", "delegate_work"] },
  { name: "Connected services", tools: ["mcp_*"] },
] as const
const known = new Set<string>(groups.flatMap((group) => [...group.tools]))
type Profile = "" | "brief" | "selected" | "full"

function same(left: string[] | undefined, right: string[]) {
  return !!left && left.length === right.length && left.every((item, index) => item === right[index])
}

export function AccessReview(props: {
  item: { id: string; name: string; access?: "brief" | "full"; dir?: string; tools?: string[] }
  onClose: () => void
}) {
  const vscode = useVSCode()
  const id = createUniqueId()
  const expected = props.item.access ?? "unset"
  const expectedTools = props.item.tools ?? "unset"
  const initial = props.item.tools?.filter((tool) => tool !== "*") ?? view
  const [choice, setChoice] = createSignal<Profile>("")
  const [selected, setSelected] = createSignal([...initial])
  const [request, setRequest] = createSignal("")
  const [error, setError] = createSignal("")
  const [saved, setSaved] = createSignal(false)
  const extras = createMemo(() => selected().filter((tool) => !known.has(tool)))
  let root: HTMLElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  onMount(() => root?.focus())
  const tools = () => {
    if (choice() === "brief") return reads
    if (choice() === "full") return ["*"]
    return selected()
  }
  const checked = (items: readonly string[]) => items.every((item) => selected().includes(item))
  const toggle = (items: readonly string[], on: boolean) =>
    setSelected((prior) => {
      if (!on) return prior.filter((item) => !items.some((entry) => entry === item))
      return [...prior, ...items.filter((item) => !prior.includes(item))]
    })
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
    if (msg.access !== (choice() === "brief" ? "brief" : "full") || !same(msg.tools, tools()))
      return setError("The saved access did not match your choice. Close and reload the routine.")
    setSaved(true)
    vscode.postMessage({ type: "routineList" })
  })
  onCleanup(() => {
    clearTimeout(timer)
    unsub()
  })
  const save = () => {
    const profile = choice()
    if (!profile || request() || saved()) return
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
      access: profile === "brief" ? "brief" : "full",
      tools: tools(),
      expectedAccess: expected,
      expectedTools,
    })
  }
  const savedLabel = () => {
    if (expected === "unset") return "Access hasn't been reviewed."
    if (expected === "brief") return "Current access: read and report."
    if (props.item.tools === undefined || props.item.tools.includes("*")) return "Current access: all tools."
    return `Current access: ${props.item.tools.length} saved tool pattern${props.item.tools.length === 1 ? "" : "s"}.`
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
      <p class="routines-hint">{savedLabel()} Choose what future runs can use. This doesn't start the routine.</p>
      <label for={`${id}-choice`}>
        Access
        <select
          id={`${id}-choice`}
          value={choice()}
          disabled={!!request() || saved()}
          onChange={(event) => {
            const value = event.currentTarget.value
            if (value === "" || value === "brief" || value === "selected" || value === "full") setChoice(value)
          }}
        >
          <option value="">Choose access</option>
          <option value="brief">Read and report</option>
          <option value="selected">Selected tools</option>
          <option value="full">All tools</option>
        </select>
      </label>
      <Show when={choice() === "selected"}>
        <fieldset class="routines-tool-scope" disabled={!!request() || saved()}>
          <legend>Allowed tools</legend>
          <For each={groups}>
            {(group) => (
              <Checkbox checked={checked(group.tools)} onChange={(on) => toggle(group.tools, on)}>
                {group.name}
              </Checkbox>
            )}
          </For>
          <For each={extras()}>
            {(tool) => (
              <Checkbox checked onChange={(on) => toggle([tool], on)}>
                Saved tool: {tool}
              </Checkbox>
            )}
          </For>
          <Show when={selected().length === 0}>
            <p class="routines-hint">No tool groups selected. The worker can still ask questions.</p>
          </Show>
        </fieldset>
      </Show>
      <Show when={props.item.dir?.trim() && choice() !== "brief"}>
        {(folder) => (
          <p class="routines-hint">File changes stay in {folder()}. Commands aren't confined to this folder.</p>
        )}
      </Show>
      <Show when={choice() === "full"}>
        <p class="routines-hint">
          All tools can act through your connected accounts. Review requests before approving them.
        </p>
      </Show>
      <Show when={choice()}>
        <p class="routines-hint">These are Raya controls, not an operating-system sandbox.</p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="routines-error">
          {error()}
        </p>
      </Show>
      <Show when={saved()}>
        <p role="status">Access saved. The routine list is refreshing.</p>
      </Show>
      <div class="routines-review-actions">
        <Button size="small" disabled={!choice() || !!request() || saved() || !!error()} onClick={save}>
          {request() ? "Saving access" : "Save access"}
        </Button>
        <Button size="small" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      </div>
    </section>
  )
}
