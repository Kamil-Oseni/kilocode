import type {
  KiloClient,
  KilocodeRoutineHistoriesResponse,
  KilocodeRoutineListResponse,
  KilocodeRoutineSnapshotResponse,
  Session,
} from "@kilocode/sdk/v2/client"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { sameDirectory } from "../kilo-provider-utils"

type Scope = { client: KiloClient | null; directory: string; generation: number }
type Run = KilocodeRoutineHistoriesResponse["items"][number]["runs"][number]
type Route = Scope & { signature: string; target: string; expires: number }
const session = /^ses_[A-Za-z0-9_-]{1,252}$/
const absolute = (value: string) => path.isAbsolute(value) || path.win32.isAbsolute(value)
const version = (value: number | undefined) => Number.isSafeInteger(value ?? 1) && (value ?? 1) > 0
const bounded = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

function identity(run: Run) {
  return (
    !!run &&
    bounded(run.id) &&
    bounded(run.agentID) &&
    typeof run.at === "number" &&
    Number.isFinite(run.at) &&
    typeof run.sessionID === "string" &&
    session.test(run.sessionID) &&
    version(run.scheduleVersion) &&
    version(run.revision) &&
    object(run.trigger) &&
    ["manual", "timer", "event"].includes(String(run.trigger.kind))
  )
}

function eligible(run: Run, agent: KilocodeRoutineListResponse[number]) {
  return (
    identity(run) &&
    run.status === "running" &&
    run.agentID === agent.id &&
    agent.execution?.state !== "recovery" &&
    (!agent.execution?.runID || agent.execution.runID === run.id) &&
    (!agent.execution?.sessionID || agent.execution.sessionID === run.sessionID)
  )
}

function pinned(value: KilocodeRoutineSnapshotResponse | undefined, run: Run) {
  return (
    !!value &&
    (value.version === 1 || value.version === 2) &&
    value.runID === run.id &&
    value.agentID === run.agentID &&
    value.sessionID === run.sessionID &&
    value.at === run.at &&
    object(value.definition) &&
    value.definition.id === run.agentID &&
    (value.definition.scheduleVersion ?? 1) === (run.scheduleVersion ?? 1)
  )
}

function location(value: KilocodeRoutineSnapshotResponse | undefined, child: Session) {
  const directory = value?.definition?.dir
  return (
    directory === undefined ||
    (typeof directory === "string" && absolute(directory) && sameDirectory(directory, child.directory))
  )
}

function owned(value: Session | undefined, run: Run) {
  if (!value || value.id !== run.sessionID || typeof value.directory !== "string" || !absolute(value.directory))
    return false
  const identity = value.metadata?.rayaRoutine
  return (
    object(identity) &&
    (identity.version === 1 || identity.version === 2) &&
    identity.agentID === run.agentID &&
    identity.runID === run.id &&
    identity.scheduleVersion === (run.scheduleVersion ?? 1) &&
    isDeepStrictEqual(identity.trigger, run.trigger)
  )
}

/** Independent roster-owned routes: read-only invalidations, never general session or execution authority. */
export class RoutineHints {
  private readonly routes = new Map<string, Route>()
  private pending?: symbol
  private disposed = false
  private epoch = 0

  checkpoint() {
    return this.epoch
  }

  clear() {
    this.epoch += 1
    this.pending = undefined
    this.routes.clear()
  }

  dispose() {
    this.disposed = true
    this.clear()
  }

  async refresh(input: {
    client: KiloClient
    directory: string
    generation: number
    agents: KilocodeRoutineListResponse
    histories: KilocodeRoutineHistoriesResponse
    current: () => boolean
    signal: AbortSignal
  }) {
    if (this.disposed) return
    const token = Symbol()
    this.pending = token
    if (
      !input.current() ||
      input.signal.aborted ||
      !absolute(input.directory) ||
      !Array.isArray(input.agents) ||
      !Array.isArray(input.histories?.items) ||
      !Array.isArray(input.histories.failed)
    ) {
      this.routes.clear()
      return
    }
    const candidates = input.agents.flatMap((agent) => {
      if (!agent || !bounded(agent.id) || input.histories.failed.includes(agent.id)) return []
      const histories = input.histories.items.filter((item) => item.agentID === agent.id)
      if (histories.length !== 1 || !Array.isArray(histories[0].runs)) return []
      const active = histories[0].runs.filter((run) => run?.status === "running")
      return active.length === 1 && eligible(active[0], agent) ? active : []
    })
    const runs = candidates
      .filter((run) => candidates.filter((item) => item.sessionID === run.sessionID).length === 1)
      .slice(0, 32)
    const signature = (run: Run) =>
      createHash("sha256")
        .update(
          JSON.stringify([
            run.agentID,
            run.id,
            run.at,
            run.sessionID,
            run.scheduleVersion ?? 1,
            run.revision ?? 1,
            run.trigger,
          ]),
        )
        .digest("hex")
    const matches = (route: Route) =>
      route.client === input.client &&
      route.generation === input.generation &&
      sameDirectory(route.directory, input.directory) &&
      route.expires > Date.now()
    // Prune removed/terminal/failed/replaced histories before starting any read.
    for (const [id, route] of this.routes) {
      if (!matches(route) || !runs.some((run) => run.sessionID === id && signature(run) === route.signature))
        this.routes.delete(id)
    }
    const missing = runs.filter((run) => !this.routes.has(run.sessionID))
    const current = () => !this.disposed && this.pending === token && !input.signal.aborted && input.current()
    for (let offset = 0; offset < missing.length && current(); offset += 4) {
      await Promise.all(
        missing.slice(offset, offset + 4).map(async (run) => {
          const options = {
            throwOnError: true as const,
            signal: AbortSignal.any([input.signal, AbortSignal.timeout(1500)]),
          }
          const [snapshot, child] = await Promise.all([
            input.client.kilocode.routine
              .snapshot({ agentID: run.agentID, runID: run.id, directory: input.directory }, options)
              .then(
                (result) => result.data,
                () => undefined,
              ),
            input.client.session.get({ sessionID: run.sessionID, directory: input.directory }, options).then(
              (result) => result.data,
              () => undefined,
            ),
          ])
          // Missing legacy pins and read failures leave polling as the fallback.
          if (!current() || !pinned(snapshot, run) || !owned(child, run) || !child || !location(snapshot, child)) return
          this.routes.set(run.sessionID, {
            client: input.client,
            directory: input.directory,
            generation: input.generation,
            signature: signature(run),
            target: child.directory,
            expires: Date.now() + 15_000,
          })
        }),
      )
    }
  }

  hint(id: string, directory: string, scope: Scope) {
    if (this.disposed) return false
    const route = this.routes.get(id)
    if (!route) return false
    if (route.expires <= Date.now()) {
      this.routes.delete(id)
      return false
    }
    return (
      route.client === scope.client &&
      route.generation === scope.generation &&
      sameDirectory(route.directory, scope.directory) &&
      sameDirectory(route.target, directory)
    )
  }

  invalidation(event: unknown, directory: string | undefined, scope: Scope) {
    if (
      !directory ||
      directory === "global" ||
      !object(event) ||
      event.type !== "session.inference.changed" ||
      !object(event.properties)
    )
      return
    const id = event.properties.sessionID
    if (typeof id !== "string" || !session.test(id)) return
    return this.hint(id, directory, scope) ? id : undefined
  }
}
