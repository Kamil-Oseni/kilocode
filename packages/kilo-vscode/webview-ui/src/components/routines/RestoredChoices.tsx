import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { Select } from "@kilocode/kilo-ui/select"
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import {
  Application,
  Group,
  Outcome,
  Snapshot,
  type Application as Selection,
  type Group as Field,
} from "../../../../src/shared/restore-review"
import { confirmed, issues, project } from "../../../../src/shared/restored-choices"

const labels: Record<Field, string> = {
  config: "Global model choices",
  models: "Model choices by mode",
  history: "Model history and variants",
  client: "Picker preferences",
}

function describe(value: object): string[] {
  return Object.entries(value).flatMap(([key, value]) => {
    const label =
      (
        {
          model: "Default model",
          smallModel: "Small model",
          defaultAgent: "Default mode",
          models: "Mode bindings",
          recent: "Recent models",
          favorite: "Favorite models",
          variants: "Variants",
          recentModels: "Recent models",
          favoriteModels: "Favorite models",
          expanded: "Picker groups expanded",
        } as Record<string, string>
      )[key] ?? key
    const show = (value: unknown): string => {
      if (typeof value === "boolean") return value ? "Yes" : "No"
      if (typeof value === "string") return value
      if (!value || typeof value !== "object") return "Not set"
      const row = value as { providerID?: string; modelID?: string; agent?: string; variant?: string }
      const variant = row.variant === undefined ? "" : ` (${row.variant === "" ? "Model default" : row.variant})`
      return `${row.agent ? `Mode ${row.agent}: ` : ""}${row.providerID}/${row.modelID}${variant}`
    }
    return [
      `${label}: ${Array.isArray(value) ? (value.length ? value.map(show).join(", ") : "No entries") : show(value)}`,
    ]
  })
}

export function RestoredChoices(props: { id: string; revision: string }) {
  const vscode = useVSCode()
  const sourceLabel = createUniqueId()
  const ownerLabel = createUniqueId()
  const [snapshot, setSnapshot] = createSignal<Snapshot>()
  const [source, setSource] = createSignal("")
  const [owner, setOwner] = createSignal("")
  const [groups, setGroups] = createSignal<Field[]>([])
  const [pending, setPending] = createSignal<{ id: string; application?: Selection }>()
  const [error, setError] = createSignal("")
  const [outcome, setOutcome] = createSignal<Outcome>()
  const [uncertain, setUncertain] = createSignal(false)
  const timer: { id?: ReturnType<typeof setTimeout> } = {}
  const reset = () => {
    setSource("")
    setOwner("")
    setGroups([])
  }
  const begin = (application?: Selection) => {
    clearTimeout(timer.id)
    const id = crypto.randomUUID()
    setPending({ id, application })
    setError("")
    timer.id = setTimeout(() => {
      setPending(undefined)
      setSnapshot(undefined)
      setOutcome(undefined)
      reset()
      if (application) setUncertain(true)
      setError(
        application
          ? "Changes were not confirmed. Refresh saved choices to inspect the current state before a new action."
          : "Saved choices could not be read. Refresh to inspect the current state.",
      )
    }, 20000)
    return id
  }
  const refresh = () => {
    if (pending()) return
    reset()
    setOutcome(undefined)
    setSnapshot(undefined)
    vscode.postMessage({ type: "restoreChoicesGet", requestID: begin() })
  }
  const choices = createMemo(() => {
    const value = snapshot()?.choices
    return value?.state === "ready" ? value.sources : []
  })
  const sources = createMemo(() =>
    choices().map((item) => ({
      id: item.kind === "profile" ? "profile" : item.id,
      label:
        item.kind === "profile"
          ? "Imported profile choices"
          : `${item.role === "view" ? "Captured window" : "Captured Agent Manager"} ${item.id}`,
    })),
  )
  const selected = createMemo(() =>
    choices().find((item) => (item.kind === "profile" ? source() === "profile" : item.id === source())),
  )
  const owners = createMemo(() => {
    const value = selected()
    return value?.kind === "host" ? value.owners.map((item) => ({ id: item.id, label: `Saved owner ${item.id}` })) : []
  })
  const selection = (): Selection["source"] | undefined => {
    const value = selected()
    if (!value) return
    return value.kind === "profile"
      ? { kind: "profile" }
      : { kind: "host", id: value.id, ...(owner() ? { owner: owner() } : {}) }
  }
  const rows = createMemo(() => {
    const value = snapshot()
    const origin = selection()
    if (!value || !origin) return []
    return Group.options.map((group) => project(value, origin, group))
  })
  const unavailable = (row: ReturnType<typeof project>) => (snapshot() ? issues(snapshot()!, row) : [])
  const missing = createMemo(() => {
    const value = snapshot()
    if (!value || !selected()) return []
    const pairs = rows().flatMap((row) => {
      if (row.group === "history") return [...(row.patch.recent ?? []), ...(row.patch.favorite ?? [])]
      if (row.group === "client") return [...(row.patch.recentModels ?? []), ...(row.patch.favoriteModels ?? [])]
      return []
    })
    return [
      ...new Set(
        pairs
          .filter(
            (item) =>
              !value.availability.models.some(
                (current) => current.providerID === item.providerID && current.modelID === item.modelID,
              ),
          )
          .map((item) => `${item.providerID}/${item.modelID}`),
      ),
    ]
  })
  const apply = () => {
    const value = snapshot()
    const origin = selection()
    if (!value || value.choices.state !== "ready" || !origin || pending() || uncertain() || !groups().length) return
    if (rows().some((row) => groups().includes(row.group) && (!row.captured || unavailable(row).length))) return
    const parsed = Application.safeParse({
      id: value.id,
      revision: value.choices.revision,
      source: origin,
      expected: value.destination.revision,
      groups: groups(),
      reviewed: true,
    })
    if (!parsed.success) return
    setOutcome(undefined)
    vscode.postMessage({ type: "restoreChoicesApply", requestID: begin(parsed.data), application: parsed.data })
  }
  const settled = (original: Selection, value: Snapshot, outcome: unknown) => {
    const result = Outcome.safeParse(outcome)
    if (
      !result.success ||
      result.data.confirmed.some((group) => !original.groups.includes(group)) ||
      (result.data.state === "applied" && result.data.confirmed.length !== original.groups.length) ||
      value.choices.state !== "ready" ||
      value.choices.revision !== original.revision
    ) {
      setSnapshot(undefined)
      setUncertain(true)
      setError("The change result was not confirmed. Refresh saved choices before a new action.")
      return
    }
    const before = snapshot()
    if (
      result.data.confirmed.length > 0 &&
      (!before ||
        result.data.confirmed.some(
          (group) => !confirmed(project(before, original.source, group), value.destination.preferences),
        ))
    ) {
      setSnapshot(undefined)
      setUncertain(true)
      setError("The saved destination does not confirm the reviewed changes. Refresh before a new action.")
      return
    }
    setOutcome(result.data)
    setSnapshot(value)
    setUncertain(result.data.state !== "applied")
    setError(result.data.error ?? "")
  }
  const unsubscribe = vscode.onMessage((message) => {
    if (
      message.type === "workspaceDirectoryChanged" ||
      (message.type === "connectionState" && message.state !== "connected")
    ) {
      clearTimeout(timer.id)
      if (pending()?.application) setUncertain(true)
      setPending(undefined)
      setSnapshot(undefined)
      setOutcome(undefined)
      reset()
      setError("This view changed. Refresh saved choices before a new action.")
      return
    }
    if (message.type !== "restoreChoicesResult" || !pending() || message.requestID !== pending()?.id) return
    const request = pending()!
    clearTimeout(timer.id)
    setPending(undefined)
    reset()
    const value = Snapshot.safeParse(message.snapshot)
    if (message.error || !value.success || value.data.id !== props.id) {
      setSnapshot(undefined)
      if (request.application) setUncertain(true)
      setError(message.error || "Saved choices were not confirmed. Refresh to inspect the current state.")
      return
    }
    if (!request.application) {
      if (message.outcome) {
        setSnapshot(undefined)
        setError("The read response was unexpected. Refresh saved choices.")
        return
      }
      setSnapshot(value.data)
      setUncertain(false)
      setError("")
      return
    }
    settled(request.application, value.data, message.outcome)
  })
  createEffect(
    on(
      () => [props.id, props.revision],
      () => {
        const blocked = !!pending()?.application || uncertain()
        clearTimeout(timer.id)
        setUncertain(blocked)
        setPending(undefined)
        setSnapshot(undefined)
        setOutcome(undefined)
        reset()
        if (blocked) {
          setError("This view changed while updates were unconfirmed. Refresh saved choices before a new action.")
          return
        }
        refresh()
      },
      { defer: true },
    ),
  )
  onMount(refresh)
  onCleanup(() => {
    clearTimeout(timer.id)
    unsubscribe()
  })
  return (
    <section class="routines-restore-review" aria-label="Saved model choices">
      <h3>Saved model choices</h3>
      <p>
        Choose a saved source and review each group before replacing current choices. Applying choices does not enable
        workers or replay old work.
      </p>
      <Show when={error()}>
        <p class="routines-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={outcome()}>
        {(value) => (
          <p role="status">
            {value().state === "applied"
              ? "Selected groups were applied."
              : "Some changes remain unconfirmed. Refresh to inspect the current state."}{" "}
            Confirmed groups:{" "}
            {value()
              .confirmed.map((group) => labels[group])
              .join(", ") || "None"}
            .
          </p>
        )}
      </Show>
      <Show when={snapshot()?.choices.state === "unavailable"}>
        <p>Saved model choices are unavailable. Repair the saved evidence before applying choices.</p>
      </Show>
      <Show when={snapshot()?.choices.state === "absent"}>
        <p>No model choices were captured in this archive.</p>
      </Show>
      <Show when={snapshot()?.choices.state === "ready"}>
        <div class="routines-field">
          <span id={sourceLabel}>Saved source</span>
          <Select
            options={sources()}
            current={sources().find((item) => item.id === source())}
            value={(item) => item.id}
            label={(item) => item.label}
            placeholder="Choose a saved source"
            triggerProps={{ "aria-labelledby": sourceLabel }}
            disabled={!!pending() || uncertain()}
            onSelect={(item) => {
              setSource(item?.id ?? "")
              setOwner("")
              setGroups([])
            }}
          />
        </div>
        <Show when={selected()?.kind === "host"}>
          <div class="routines-field">
            <span id={ownerLabel}>Saved owner for mode choices and history</span>
            <Select
              options={owners()}
              current={owners().find((item) => item.id === owner())}
              value={(item) => item.id}
              label={(item) => item.label}
              placeholder="Choose a saved owner"
              triggerProps={{ "aria-labelledby": ownerLabel }}
              disabled={!!pending() || uncertain()}
              onSelect={(item) => {
                setOwner(item?.id ?? "")
                setGroups([])
              }}
            />
          </div>
        </Show>
        <Show when={missing().length}>
          <p>
            Unavailable saved history entries are retained as preferences, without selecting a replacement model:{" "}
            {missing().join(", ")}.
          </p>
        </Show>
        <For each={rows()}>
          {(row) => (
            <fieldset disabled={!!pending() || uncertain()}>
              <legend>{labels[row.group]}</legend>
              <Show when={!row.captured}>
                <p>{row.reason}</p>
              </Show>
              <div>
                <h4>Current</h4>
                <ul>
                  <For each={describe(row.before)} fallback={<li>Not set</li>}>
                    {(line) => <li>{line}</li>}
                  </For>
                </ul>
              </div>
              <div>
                <h4>After applying</h4>
                <ul>
                  <For each={describe(row.after)} fallback={<li>Not set</li>}>
                    {(line) => <li>{line}</li>}
                  </For>
                </ul>
              </div>
              <For each={unavailable(row)}>
                {(issue) => <p class="routines-error">{issue} This group will stay unapplied.</p>}
              </For>
              <Checkbox
                checked={groups().includes(row.group)}
                disabled={!row.captured || unavailable(row).length > 0 || !!pending() || uncertain()}
                onChange={(checked) =>
                  setGroups((current) =>
                    checked ? [...new Set([...current, row.group])] : current.filter((group) => group !== row.group),
                  )
                }
              >
                Apply {labels[row.group]}
              </Checkbox>
            </fieldset>
          )}
        </For>
        <p>
          Missing optional choices keep their current value. An empty saved list replaces that list only when its group
          is selected.
        </p>
        <Button disabled={!!pending() || uncertain() || !groups().length} onClick={apply}>
          Apply reviewed choices
        </Button>
      </Show>
      <Button variant="ghost" size="small" disabled={!!pending()} onClick={refresh}>
        Refresh saved choices
      </Button>
    </section>
  )
}
