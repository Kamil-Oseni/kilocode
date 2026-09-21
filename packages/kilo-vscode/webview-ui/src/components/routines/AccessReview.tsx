import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages/extension-messages"
import { routineFailure } from "../../utils/routine-recovery"
import { normalizeRoutinePaths, type RoutinePaths } from "../../../../src/shared/routine-paths"

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
] as const
const commands = new Set(["bash", "background_process", "interactive_terminal"])
const known = new Set<string>(groups.flatMap((group) => [...group.tools]))
type Profile = "" | "brief" | "selected" | "full"

function same(left: string[] | undefined, right: string[]) {
  return !!left && left.length === right.length && left.every((item, index) => item === right[index])
}

function samePaths(left: RoutinePaths | undefined, right: RoutinePaths) {
  return JSON.stringify(left ? normalizeRoutinePaths(left) : { version: 1, grants: [] }) === JSON.stringify(right)
}

function label(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  )
}

function append(paths: RoutinePaths, path: string, dir?: string) {
  const next = normalizeRoutinePaths({ version: 1, grants: [...paths.grants, { path, access: "read" }] })
  const covered = dir
    ? normalizeRoutinePaths({
        version: 1,
        grants: [
          { path: dir, access: "write" },
          { path, access: "read" },
        ],
      }).grants.length === 1
    : false
  return covered || next.grants.length === paths.grants.length ? undefined : next
}

function FolderAccess(props: {
  dir?: string
  paths: () => RoutinePaths
  set: (value: RoutinePaths) => void
  picker: () => string
  disabled: () => boolean
  add: () => void
}) {
  return (
    <fieldset class="routines-tool-scope" disabled={props.disabled()}>
      <legend>Folder access</legend>
      <Show when={props.dir?.trim()}>
        {(folder) => (
          <p class="routines-hint">
            Primary write folder: <span title={folder()}>{label(folder())}</span>
          </p>
        )}
      </Show>
      <For each={props.paths().grants}>
        {(grant) => (
          <div class="routines-path-row">
            <span title={grant.path}>{label(grant.path)}</span>
            <select
              aria-label={`Access for ${grant.path}`}
              value={grant.access}
              onChange={(event) =>
                props.set(
                  normalizeRoutinePaths({
                    version: 1,
                    grants: props
                      .paths()
                      .grants.map((item) =>
                        item.path === grant.path
                          ? { ...item, access: event.currentTarget.value === "write" ? "write" : "read" }
                          : item,
                      ),
                  }),
                )
              }
            >
              <option value="read">Read only</option>
              <option value="write">Read and write</option>
            </select>
            <Button
              size="small"
              variant="ghost"
              aria-label={`Remove ${grant.path}`}
              onClick={() =>
                props.set({ version: 1, grants: props.paths().grants.filter((item) => item.path !== grant.path) })
              }
            >
              Remove
            </Button>
          </div>
        )}
      </For>
      <Button
        size="small"
        variant="ghost"
        disabled={!!props.picker() || props.paths().grants.length >= 16}
        onClick={props.add}
      >
        {props.picker() ? "Choosing folder" : "Add folder"}
      </Button>
      <Show when={props.paths().grants.length >= 16}>
        <p class="routines-hint">Remove a folder before adding another.</p>
      </Show>
      <Show when={props.paths().grants.length > 0}>
        <p class="routines-hint">
          Commands and workspace-wide code navigation are unavailable with additional folder limits. File tools enforce
          each saved boundary.
        </p>
      </Show>
    </fieldset>
  )
}

export function AccessReview(props: {
  item: {
    id: string
    name: string
    access?: "brief" | "full"
    dir?: string
    paths?: RoutinePaths
    tools?: string[]
  }
  onClose: () => void
}) {
  const vscode = useVSCode()
  const id = createUniqueId()
  const expected = props.item.access ?? "unset"
  const expectedTools = props.item.tools ?? "unset"
  const expectedPaths = props.item.paths ?? "unset"
  const initial = props.item.tools?.filter((tool) => tool !== "*") ?? view
  const [choice, setChoice] = createSignal<Profile>("")
  const [selected, setSelected] = createSignal([...initial])
  const [paths, setPaths] = createSignal(
    normalizeRoutinePaths(props.item.paths ?? { version: 1, grants: [] as RoutinePaths["grants"] }),
  )
  const [picker, setPicker] = createSignal("")
  const [request, setRequest] = createSignal("")
  const [catalog, setCatalog] = createSignal<Array<{ name: string; tools: string[] }>>([])
  const [catalogRequest, setCatalogRequest] = createSignal("")
  const [catalogError, setCatalogError] = createSignal("")
  const [truncated, setTruncated] = createSignal(false)
  const [error, setError] = createSignal("")
  const [saved, setSaved] = createSignal(false)
  const covered = createMemo(
    () =>
      new Set(
        catalog()
          .filter((service) => service.tools.every((tool) => selected().includes(tool)))
          .flatMap((service) => service.tools),
      ),
  )
  const extras = createMemo(() => selected().filter((tool) => !known.has(tool) && !covered().has(tool)))
  let root: HTMLElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let catalogTimer: ReturnType<typeof setTimeout> | undefined
  const load = () => {
    clearTimeout(catalogTimer)
    const requestID = crypto.randomUUID()
    setCatalogRequest(requestID)
    setCatalogError("")
    setTruncated(false)
    catalogTimer = setTimeout(() => {
      if (catalogRequest() !== requestID) return
      setCatalogRequest("")
      setCatalogError("Connected services could not be confirmed. Try again.")
    }, 15_000)
    vscode.postMessage({ type: "routineAuthorityServices", requestID })
  }
  onMount(() => {
    root?.focus()
    load()
  })
  const tools = () => {
    if (choice() === "brief") return reads
    if (choice() === "full") return ["*"]
    if (paths().grants.length === 0) return selected()
    return selected().filter((tool) => !commands.has(tool))
  }
  const checked = (items: readonly string[]) => items.every((item) => selected().includes(item))
  const toggle = (items: readonly string[], on: boolean) =>
    setSelected((prior) => {
      if (!on) return prior.filter((item) => !items.some((entry) => entry === item))
      return [...prior, ...items.filter((item) => !prior.includes(item))]
    })
  const folder = (msg: ExtensionMessage) => {
    if (msg.type !== "folderPickerResult" || msg.requestId !== picker()) return false
    setPicker("")
    if (!msg.path) return true
    const next = append(paths(), msg.path, props.item.dir?.trim())
    if (!next) {
      setError("That folder is already covered by the saved access.")
      return true
    }
    setError("")
    setPaths(next)
    return true
  }
  const unsub = vscode.onMessage((msg) => {
    if (folder(msg)) return
    if (msg.type === "routineAuthorityServices" && msg.requestID === catalogRequest()) {
      clearTimeout(catalogTimer)
      setCatalogRequest("")
      if (msg.error) {
        setCatalogError(routineFailure(msg.error, msg.recovery))
        return
      }
      setCatalog(msg.services ?? [])
      setTruncated(msg.truncated === true)
      return
    }
    if (
      msg.type !== "routineAccessUpdated" ||
      msg.agentID !== props.item.id ||
      !request() ||
      msg.requestID !== request()
    )
      return
    clearTimeout(timer)
    setRequest("")
    if (msg.error) return setError(routineFailure(msg.error, msg.recovery, "Your access choices are unchanged."))
    if (
      msg.access !== (choice() === "brief" ? "brief" : "full") ||
      !same(msg.tools, tools()) ||
      !samePaths(msg.paths, paths())
    )
      return setError("The saved access did not match your choice. Close and reload the routine.")
    setSaved(true)
    vscode.postMessage({ type: "routineList" })
  })
  onCleanup(() => {
    clearTimeout(timer)
    clearTimeout(catalogTimer)
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
      paths: paths(),
      expectedAccess: expected,
      expectedTools,
      expectedPaths,
    })
  }
  const add = () => {
    if (picker() || paths().grants.length >= 16) return
    const requestId = crypto.randomUUID()
    setError("")
    setPicker(requestId)
    vscode.postMessage({ type: "requestFolderPicker", requestId })
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
      <FolderAccess
        dir={props.item.dir}
        paths={paths}
        set={setPaths}
        picker={picker}
        disabled={() => !!request() || saved()}
        add={add}
      />
      <Show when={choice() === "selected"}>
        <fieldset class="routines-tool-scope" disabled={!!request() || saved()}>
          <legend>Allowed tools</legend>
          <For each={paths().grants.length > 0 ? groups.filter((group) => group.name !== "Commands") : groups}>
            {(group) => (
              <Checkbox checked={checked(group.tools)} onChange={(on) => toggle(group.tools, on)}>
                {group.name}
              </Checkbox>
            )}
          </For>
          <p class="routines-hint">Connected services</p>
          <For each={catalog()}>
            {(service) => (
              <Checkbox checked={checked(service.tools)} onChange={(on) => toggle(service.tools, on)}>
                {service.name} ({service.tools.length} tool{service.tools.length === 1 ? "" : "s"})
              </Checkbox>
            )}
          </For>
          <Show when={catalogRequest()}>
            <p class="routines-hint">Checking connected services.</p>
          </Show>
          <Show when={!catalogRequest() && catalog().length === 0 && !catalogError()}>
            <p class="routines-hint">No connected services are available.</p>
          </Show>
          <Show when={catalogError()}>
            <div>
              <p role="alert" class="routines-error">
                {catalogError()}
              </p>
              <Button size="small" variant="ghost" disabled={!!catalogRequest()} onClick={load}>
                Retry connected services
              </Button>
            </div>
          </Show>
          <Show when={truncated()}>
            <p class="routines-hint">Some connected tools aren't shown. Only the tools listed here can be saved.</p>
          </Show>
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
      <Show when={paths().grants.length === 0 && choice() !== "brief" && props.item.dir?.trim()}>
        {(folder) => (
          <p class="routines-hint">File changes stay in {folder()}. Commands aren't confined to this folder.</p>
        )}
      </Show>
      <Show when={choice() === "full"}>
        <p class="routines-hint">
          {paths().grants.length > 0
            ? "All compatible tools can act through your connected accounts. Commands and workspace-wide code navigation stay unavailable while folder limits are active."
            : "All tools can act through your connected accounts. Review requests before approving them."}
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
