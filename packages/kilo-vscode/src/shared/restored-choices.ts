import type { Application, Group, Snapshot } from "./restore-review"

type Preferences = Snapshot["destination"]["preferences"]
type Fields = {
  config: Preferences["config"]
  models: Pick<Preferences["modelState"], "models">
  history: Pick<Preferences["modelState"], "recent" | "favorite" | "variants">
  client: Preferences["extensionState"]
}
type Projection = {
  [K in Group]: {
    group: K
    captured: boolean
    before: Fields[K]
    after: Fields[K]
    patch: Partial<Fields[K]>
    reason?: string
  }
}[Group]

type Source = Extract<Snapshot["choices"], { state: "ready" }>["sources"][number]
type Host = Extract<Source, { kind: "host" }>
type Models = Preferences["modelState"] | Host["models"]

function merge<T extends object>(before: T, patch: Partial<T>, missing: string) {
  const captured = Object.keys(patch).length > 0
  return { before, patch, after: { ...before, ...patch }, captured, ...(captured ? {} : { reason: missing }) }
}

function config(source?: Source): Fields["config"] {
  if (source?.kind === "profile") return structuredClone(source.preferences.config)
  if (source?.kind === "host" && source.models.selected) return { model: structuredClone(source.models.selected) }
  return {}
}

function history(models?: Models): Partial<Fields["history"]> {
  if (!models) return {}
  return {
    recent: structuredClone(models.recent),
    favorite: structuredClone(models.favorite),
    ...(models.variants === undefined ? {} : { variants: structuredClone(models.variants) }),
  }
}

function client(source?: Source): Partial<Fields["client"]> {
  if (source?.kind === "profile") return structuredClone(source.preferences.extensionState)
  if (source?.kind !== "host") return {}
  return {
    recentModels: structuredClone(source.models.recent),
    favoriteModels: structuredClone(source.models.favorite),
    ...(source.models.variants === undefined ? {} : { variants: structuredClone(source.models.variants) }),
    ...(source.models.expanded === undefined ? {} : { expanded: source.models.expanded }),
  }
}

function origin(snapshot: Snapshot, selection: Application["source"]) {
  const sources = snapshot.choices.state === "ready" ? snapshot.choices.sources : []
  const source = sources.find((item) =>
    selection.kind === "profile" ? item.kind === "profile" : item.kind === "host" && item.id === selection.id,
  )
  const owner =
    source?.kind === "host" && selection.kind === "host" && selection.owner
      ? source.owners.find((item) => item.id === selection.owner)
      : undefined
  const reason = !source
    ? "Choose a saved source."
    : selection.kind === "host" && selection.owner && !owner
      ? "The selected saved owner is unavailable. Reload the saved choices."
      : undefined
  const models = source?.kind === "profile" ? source.preferences.modelState : owner?.models
  return { source, models, reason }
}

/** Pure displayed/write projection. Missing optional fields never erase current choices. */
export function project(snapshot: Snapshot, selection: Application["source"], group: Group): Projection {
  const preferences = snapshot.destination.preferences
  const selected = origin(snapshot, selection)
  const missing = selected.reason ?? "This source did not capture this group."
  const valid = selected.reason ? undefined : selected.source
  if (group === "config") return { group, ...merge(structuredClone(preferences.config), config(valid), missing) }
  if (group === "client")
    return { group, ...merge(structuredClone(preferences.extensionState), client(valid), missing) }
  if (group === "history")
    return {
      group,
      ...merge(
        history(preferences.modelState) as Fields["history"],
        history(selected.reason ? undefined : selected.models),
        missing,
      ),
    }
  const patch =
    !selected.reason && selected.models
      ? { models: structuredClone("models" in selected.models ? selected.models.models : selected.models.agents) }
      : {}
  return { group, ...merge({ models: structuredClone(preferences.modelState.models) }, patch, missing) }
}

/** Validate captured fields only; retained destination values and history IDs are not active picks. */
export function issues(snapshot: Snapshot, row: Projection): string[] {
  const model = (item: { providerID: string; modelID: string }) =>
    snapshot.availability.models.find((value) => value.providerID === item.providerID && value.modelID === item.modelID)
  const missing = (item: { providerID: string; modelID: string }) =>
    `${item.providerID}/${item.modelID} is not available on this computer.`
  if (row.group === "config")
    return [
      ...[row.patch.model, row.patch.smallModel].flatMap((item) => (item && !model(item) ? [missing(item)] : [])),
      ...(row.patch.defaultAgent && !snapshot.availability.agents.includes(row.patch.defaultAgent)
        ? [`Mode ${row.patch.defaultAgent} is not available on this computer.`]
        : []),
    ]
  if (row.group === "models") {
    const rows = row.patch.models ?? []
    return [
      ...(new Set(rows.map((item) => item.agent)).size !== rows.length
        ? ["Saved mode bindings are ambiguous. This group cannot be applied."]
        : []),
      ...rows.flatMap((item) => [
        ...(!model(item) ? [missing(item)] : []),
        ...(!snapshot.availability.agents.includes(item.agent)
          ? [`Mode ${item.agent} is not available on this computer.`]
          : []),
      ]),
    ]
  }
  const variants = row.patch.variants ?? []
  return [
    ...(row.group === "history" && variants.some((item) => item.agent !== undefined)
      ? ["Mode-scoped variants cannot be applied to CLI model history. This group will stay unapplied."]
      : []),
    ...(new Set(variants.map((item) => JSON.stringify([item.agent ?? null, item.providerID, item.modelID]))).size !==
    variants.length
      ? ["Saved variant choices are ambiguous. This group cannot be applied."]
      : []),
    ...variants.flatMap((item) => {
      const value = model(item)
      return [
        ...(!value ? [missing(item)] : []),
        ...(item.agent && !snapshot.availability.agents.includes(item.agent)
          ? [`Mode ${item.agent} is not available on this computer.`]
          : []),
        ...(value && item.variant !== "" && !value.variants.includes(item.variant)
          ? [`Variant ${item.variant} for ${item.providerID}/${item.modelID} is not available on this computer.`]
          : []),
      ]
    }),
  ]
}

/** Compare captured fields; mode and variant maps are unordered, recent/favorite lists ordered. */
export function confirmed(row: Projection, preferences: Preferences): boolean {
  const value =
    row.group === "config"
      ? preferences.config
      : row.group === "models" || row.group === "history"
        ? preferences.modelState
        : preferences.extensionState
  return Object.entries(row.patch).every(([key, expected]) => {
    const actual = Reflect.get(value, key)
    const normalize = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(normalize)
      if (item && typeof item === "object")
        return Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((name) => [name, normalize(Reflect.get(item, name))]),
        )
      return item
    }
    const ordered = (item: unknown) => {
      if (!Array.isArray(item)) return item
      if (key !== "models" && key !== "variants") return item
      const identity = (row: { agent?: string; providerID?: string; modelID?: string }) =>
        JSON.stringify([row.agent ?? null, row.providerID, row.modelID])
      return [...item].sort((a, b) => (identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0))
    }
    return JSON.stringify(normalize(ordered(actual))) === JSON.stringify(normalize(ordered(expected)))
  })
}
