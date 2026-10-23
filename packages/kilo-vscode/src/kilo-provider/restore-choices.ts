import { createHash } from "node:crypto"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { sanitize } from "@opencode-ai/core/kilocode/profile-preferences"
import { Application, Review, Snapshot, type Group, type Outcome } from "../shared/restore-review"
import { project, issues, confirmed } from "../shared/restored-choices"
import { writer } from "./model-state-writer"
import { hostPublications } from "./host-publications"

type Context = NonNullable<Parameters<typeof hostPublications>[0]>
type Input = {
  message: { type: string } & Record<string, unknown>
  client: KiloClient | null
  directory: string
  context?: Context
  current: () => boolean
  source?: () => boolean
  post: (message: unknown) => void
}
const queues = new WeakMap<KiloClient, Promise<void>>()
const requests = new WeakMap<KiloClient, Set<string>>()
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  )
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")

function extension(context: Context) {
  return {
    recentModels: context.globalState.get("recentModels"),
    favoriteModels: context.globalState.get("favoriteModels"),
    variantSelections: context.globalState.get("variantSelections"),
    modelSelectorExpanded: context.globalState.get("modelSelectorExpanded"),
  }
}

function check(input: Input) {
  if (!input.current()) throw new Error("This view changed. Reload saved choices before applying them.")
}

async function destination(input: Input, client: KiloClient, context: Context) {
  check(input)
  const owner = writer(client, input.source ?? input.current)
  const host = hostPublications(context)!
  const [config, models, state] = await Promise.all([
    client.global.config.get({ throwOnError: true }),
    owner.read(input.current),
    host.read(() => extension(context)),
  ])
  check(input)
  const preferences = sanitize(config.data, { modelState: models, extensionState: state })
  return { version: 1 as const, revision: digest(preferences), preferences }
}

async function review(input: Input, client: KiloClient) {
  check(input)
  const response = await client.kilocode.profile.restoreReview({ directory: input.directory }, { throwOnError: true })
  check(input)
  return Review.parse(response.data)
}

async function snapshot(input: Input, client: KiloClient, context: Context) {
  const [saved, target, providers, agents] = await Promise.all([
    review(input, client),
    destination(input, client, context),
    client.provider.list({ directory: input.directory }, { throwOnError: true }),
    client.app.agents({ directory: input.directory }, { throwOnError: true }),
  ])
  check(input)
  if (!saved.id || saved.state === "absent") throw new Error("No transferred profile choices are available.")
  return Snapshot.parse({
    id: saved.id,
    choices: saved.choices ?? { version: 1, state: "absent" },
    destination: target,
    availability: {
      models: providers.data.all
        .filter((provider) => providers.data.connected.includes(provider.id))
        .flatMap((provider) =>
          Object.values(provider.models).map((model) => ({
            providerID: provider.id,
            modelID: model.id,
            variants: Object.keys(model.variants ?? {}),
          })),
        ),
      agents: agents.data.filter((agent) => !agent.hidden && !agent.deprecated).map((agent) => agent.name),
    },
  })
}

function variants(rows: { providerID: string; modelID: string; variant: string; agent?: string }[]) {
  return Object.fromEntries(
    rows.map((row) => [
      row.agent === undefined
        ? `${row.providerID}/${row.modelID}`
        : `agent/${row.agent}/${row.providerID}/${row.modelID}`,
      row.variant,
    ]),
  )
}

type Projection = ReturnType<typeof project>
type Progress = { writing: boolean; target: Snapshot["destination"] }

function eligible(snapshot: Snapshot, application: Application) {
  if (
    snapshot.id !== application.id ||
    snapshot.choices.state !== "ready" ||
    snapshot.choices.revision !== application.revision
  )
    throw new Error("Saved choices changed. Reload before applying them.")
}

async function configure(
  input: Input,
  client: KiloClient,
  row: Extract<Projection, { group: "config" }>,
  progress: Progress,
) {
  const current = await client.global.config.get({ throwOnError: true })
  check(input)
  if (canonical(sanitize(current.data, {}).config) !== canonical(progress.target.preferences.config))
    throw new Error("Global model defaults changed. Reload before applying them.")
  // The endpoint merges a minimal patch; this is host-serialized, not cross-host server CAS.
  progress.writing = true
  await client.global.config.update(
    {
      config: {
        ...(row.patch.model ? { model: `${row.patch.model.providerID}/${row.patch.model.modelID}` } : {}),
        ...(row.patch.smallModel
          ? { small_model: `${row.patch.smallModel.providerID}/${row.patch.smallModel.modelID}` }
          : {}),
        ...(row.patch.defaultAgent ? { default_agent: row.patch.defaultAgent } : {}),
      },
    },
    { throwOnError: true },
  )
}

async function bindings(
  input: Input,
  client: KiloClient,
  row: Extract<Projection, { group: "models" | "history" }>,
  progress: Progress,
) {
  const previous = progress.writing
  progress.writing = true
  const result = await writer(client, input.source ?? input.current).guarded(
    input.current,
    (data) =>
      canonical(sanitize({}, { modelState: data }).modelState) === canonical(progress.target.preferences.modelState),
    (data) => ({
      ...data,
      ...(row.group === "models" && row.patch.models
        ? { model: Object.fromEntries(row.patch.models.map(({ agent, ...model }) => [agent, model])) }
        : {}),
      ...(row.group === "history"
        ? {
            ...(row.patch.recent === undefined ? {} : { recent: row.patch.recent }),
            ...(row.patch.favorite === undefined ? {} : { favorite: row.patch.favorite }),
            ...(row.patch.variants === undefined ? {} : { variant: variants(row.patch.variants) }),
          }
        : {}),
    }),
  )
  if (result.accepted) return
  progress.writing = previous
  throw new Error("Model choices changed. Reload before applying them.")
}

async function local(
  input: Input,
  context: Context,
  row: Extract<Projection, { group: "client" }>,
  progress: Progress,
) {
  const previous = progress.writing
  progress.writing = true
  const result = await hostPublications(context)!.guarded(
    input.current,
    () =>
      canonical(sanitize({}, { extensionState: extension(context) }).extensionState) ===
      canonical(progress.target.preferences.extensionState),
    {
      ...(row.patch.recentModels === undefined ? {} : { recentModels: row.patch.recentModels }),
      ...(row.patch.favoriteModels === undefined ? {} : { favoriteModels: row.patch.favoriteModels }),
      ...(row.patch.variants === undefined ? {} : { variantSelections: variants(row.patch.variants) }),
      ...(row.patch.expanded === undefined ? {} : { modelSelectorExpanded: row.patch.expanded }),
    },
  )
  if (result.accepted) return
  progress.writing = previous
  throw new Error("Client choices changed. Reload before applying them.")
}

async function write(input: Input, client: KiloClient, context: Context, row: Projection, progress: Progress) {
  if (confirmed(row, progress.target.preferences)) return
  if (row.group === "config") await configure(input, client, row, progress)
  if (row.group === "models" || row.group === "history") await bindings(input, client, row, progress)
  if (row.group === "client") await local(input, context, row, progress)
}

function publish(input: Input, group: Group, target: Snapshot["destination"]) {
  if (!input.current()) return
  if (group === "models")
    input.post({
      type: "modelSelectionsLoaded",
      selections: Object.fromEntries(target.preferences.modelState.models.map(({ agent, ...model }) => [agent, model])),
    })
  if (group !== "client") return
  const state = target.preferences.extensionState
  input.post({ type: "recentsLoaded", recents: state.recentModels })
  input.post({ type: "favoritesLoaded", favorites: state.favoriteModels })
  if (state.variants !== undefined)
    input.post({ type: "variantsLoaded", variants: variants(state.variants), replace: true })
  if (state.expanded !== undefined) input.post({ type: "modelSelectorExpandedLoaded", value: state.expanded })
}

function reconciled(initial: Snapshot, application: Application, fresh: Snapshot | undefined, accepted: Group[]) {
  if (
    !fresh ||
    fresh.id !== application.id ||
    fresh.choices.state !== "ready" ||
    fresh.choices.revision !== application.revision
  )
    return []
  return accepted.filter((group) => {
    const row = project(initial, application.source, group)
    return row.captured && issues(fresh, row).length === 0 && confirmed(row, fresh.destination.preferences)
  })
}

async function apply(input: Input, client: KiloClient, context: Context, initial: Snapshot, application: Application) {
  const accepted: Group[] = []
  const progress = { writing: false, target: initial.destination, latest: initial }
  try {
    eligible(initial, application)
    if (initial.destination.revision !== application.expected)
      throw new Error("Current choices changed. Reload and review the comparison.")
    const rows = application.groups.map((group) => project(initial, application.source, group))
    if (rows.some((row) => !row.captured || issues(initial, row).length))
      throw new Error(
        "A selected group is unavailable. Review available models, modes and variants before applying it.",
      )
    for (const row of rows) {
      const fresh = await snapshot(input, client, context)
      eligible(fresh, application)
      if (fresh.destination.revision !== progress.target.revision || rows.some((item) => issues(fresh, item).length))
        throw new Error("Current choices or availability changed. Reload before applying them.")
      check(input)
      await write(input, client, context, row, progress)
      check(input)
      const readback = await snapshot(input, client, context)
      eligible(readback, application)
      if (rows.some((item) => issues(readback, item).length))
        throw new Error("Applied choices are no longer available. Refresh before another action.")
      progress.target = readback.destination
      if (
        rows.some(
          (item) =>
            (item.group === row.group || accepted.includes(item.group)) &&
            !confirmed(item, progress.target.preferences),
        )
      )
        throw new Error("The saved choice update was not confirmed. Refresh before another action.")
      progress.latest = readback
      accepted.push(row.group)
      publish(input, row.group, progress.target)
    }
    return { outcome: { state: "applied", confirmed: accepted } satisfies Outcome, snapshot: progress.latest }
  } catch {
    if (!progress.writing && !accepted.length)
      return {
        error: "Choices were not applied. Reload and review the current source, destination and available models.",
      }
    const fresh = await snapshot(input, client, context).catch(() => undefined)
    const current = reconciled(initial, application, fresh, accepted)
    return {
      ...(fresh ? { snapshot: fresh } : {}),
      outcome: {
        state: current.length ? "partial" : "unknown",
        confirmed: current,
        error:
          "Some updates are not confirmed. Refresh the current choices before another action; do not resend this request.",
      } satisfies Outcome,
    }
  }
}

/** One explicit current request only; never releases the import hold or dispatches work. */
export async function restoreChoices(input: Input): Promise<boolean> {
  const message = input.message
  if (message.type !== "restoreChoicesGet" && message.type !== "restoreChoicesApply") return false
  if (typeof message.requestID !== "string" || !message.requestID || message.requestID.length > 128) return true
  const client = input.client
  if (!client || !input.context || !input.current()) return true
  const context = input.context
  if (message.type === "restoreChoicesApply") {
    const used = requests.get(client) ?? new Set<string>()
    requests.set(client, used)
    if (used.has(message.requestID)) return true
    if (used.size >= 1024) {
      input.post({
        type: "restoreChoicesResult",
        requestID: message.requestID,
        error: "This connection's restore request limit was reached. Reconnect before another application.",
      })
      return true
    }
    used.add(message.requestID)
  }
  const task = (queues.get(client) ?? Promise.resolve())
    .then(async () => {
      check(input)
      const current = await snapshot(input, client, context)
      const result =
        message.type === "restoreChoicesApply"
          ? await apply(input, client, context, current, Application.parse(message.application))
          : { snapshot: current }
      if (input.current()) input.post({ type: "restoreChoicesResult", requestID: message.requestID, ...result })
    })
    .catch(() => {
      if (input.current())
        input.post({
          type: "restoreChoicesResult",
          requestID: message.requestID,
          error: "Saved choices are unavailable. Refresh and review them before applying changes.",
        })
    })
  queues.set(client, task)
  await task
  return true
}
