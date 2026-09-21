import { Effect } from "effect"
import type { ProfileInfo } from "@/kilocode/browser/profile-schema"
import type { Session } from "@/session/session"
import { RayaTask } from "@/kilocode/task"
import type { Info as VoiceInfo } from "@/kilocode/voice/protocol"
import type { RayaAdminLog } from "./log"
import type { RayaGoalHealth } from "@/kilocode/goal/health"
import type { RayaTaskHealth } from "@/kilocode/task/health"
import { RayaAdmin } from "./registry"

export namespace RayaAdminService {
  type State = "connecting" | "connected" | "disconnected" | "error"
  type Result<T> = T | Promise<T>
  type Tasks = {
    list: () => Effect.Effect<readonly Pick<RayaTask.Agent, "execution">[]>
    histories: () => Effect.Effect<RayaTask.Histories>
  }
  type Browser = Pick<typeof ProfileInfo.Type, "status"> | undefined
  type Voice = {
    available: boolean
    states: readonly { info: Pick<typeof VoiceInfo.Type, "status">; incomplete: boolean }[]
  }
  type Check = () => Result<unknown>

  export type Deps = {
    runtime: () => Result<State>
    sessions: Pick<Session.Interface, "list">
    tasks: Tasks
    goals?: () => Result<RayaGoalHealth.Summary>
    scheduler?: () => Result<RayaTaskHealth.Summary>
    organizations?: Check
    skills?: Check
    todos?: Check
    contacts?: Check
    memory?: Check
    canvas?: Check
    browser?: () => Result<Browser>
    voice?: () => Result<Voice>
    report?: (event: RayaAdminLog.Input) => Result<unknown>
    clock?: () => number
  }

  export function make(deps: Deps) {
    const snapshot = async () => {
      const report = async (event: RayaAdminLog.Input) => {
        await Promise.resolve()
          .then(() => deps.report?.(event))
          .catch(() => undefined)
      }
      const probe = (item: RayaAdmin.Probe): RayaAdmin.Probe => ({
        id: item.id,
        read: async (at) => {
          await report({ subsystem: item.id, severity: "info", code: "probe.started", fields: { source: "registry" } })
          return Promise.resolve()
            .then(() => item.read(at))
            .then(async (row) => {
              await report({
                subsystem: item.id,
                severity:
                  row.reason === "probe-failed"
                    ? "error"
                    : row.status === "healthy"
                      ? "info"
                      : row.status === "unknown"
                        ? "warning"
                        : "error",
                code: row.reason === "probe-failed" ? "probe.failed" : "probe.completed",
                fields: { state: row.status, reason: row.reason, source: "registry" },
              })
              return row
            })
            .catch(async (err) => {
              await report({
                subsystem: item.id,
                severity: "error",
                code: "probe.failed",
                fields: { reason: "probe-failed", source: "registry" },
              })
              throw err
            })
        },
      })
      const state = Promise.resolve().then(deps.runtime)
      const agents = state.then((current) => {
        if (current !== "connected") return undefined
        return Effect.runPromise(deps.tasks.list())
      })
      const histories = state.then((current) => {
        if (current !== "connected") return undefined
        return Effect.runPromise(deps.tasks.histories())
      })
      const probes: RayaAdmin.Probe[] = [
        {
          id: "runtime",
          read: async (at) => RayaAdmin.runtime(await state, at),
        },
        {
          id: "goals",
          read: async (at) => {
            const current = await state
            if (current !== "connected") return RayaAdmin.unavailable("goals", at, "disconnected")
            if (!deps.goals) return RayaAdmin.unavailable("goals", at)
            return RayaAdmin.goals(await deps.goals(), at)
          },
        },
        {
          id: "sessions",
          read: async (at) => {
            const current = await state
            if (current !== "connected") return RayaAdmin.sessions({ storage: "unknown", stream: current }, at)
            return Effect.runPromise(deps.sessions.list({ limit: 1 })).then(
              () => RayaAdmin.sessions({ storage: "readable", stream: current }, at),
              () => RayaAdmin.sessions({ storage: "unreadable", stream: current }, at),
            )
          },
        },
        {
          id: "scheduler",
          read: async (at) => {
            const current = await state
            if (current !== "connected") return RayaAdmin.unavailable("scheduler", at, "disconnected")
            if (!deps.scheduler) return RayaAdmin.unavailable("scheduler", at)
            return RayaAdmin.scheduler(await deps.scheduler(), at)
          },
        },
        {
          id: "routines",
          read: async (at) => {
            const found = await Promise.all([agents, histories])
            if (!found[0] || !found[1]) return RayaAdmin.unavailable("routines", at, "disconnected")
            return RayaAdmin.routines(found[0], found[1], at)
          },
        },
        {
          id: "agents",
          read: async (at) => {
            const found = await agents
            if (!found) return RayaAdmin.unavailable("agents", at, "disconnected")
            return RayaAdmin.agents(found, at)
          },
        },
      ]
      const check = (
        id: "organizations" | "skills" | "todos" | "contacts" | "memory" | "canvas",
        read: Check,
      ): RayaAdmin.Probe => ({
        id,
        read: async (at) => {
          const current = await state
          if (current !== "connected") return RayaAdmin.unavailable(id, at, "disconnected")
          await read()
          return RayaAdmin.ready(id, at)
        },
      })
      if (deps.organizations) probes.push(check("organizations", deps.organizations))
      if (deps.skills) probes.push(check("skills", deps.skills))
      if (deps.todos) probes.push(check("todos", deps.todos))
      if (deps.contacts) probes.push(check("contacts", deps.contacts))
      if (deps.memory) probes.push(check("memory", deps.memory))
      if (deps.canvas) probes.push(check("canvas", deps.canvas))
      const browser = deps.browser
      if (browser) probes.push({ id: "browser", read: async (at) => RayaAdmin.browser(await browser(), at) })
      const voice = deps.voice
      if (voice)
        probes.push({
          id: "voice",
          read: async (at) => {
            const signal = await voice()
            return RayaAdmin.voice(signal.available, signal.states, at)
          },
        })
      return RayaAdmin.collect(probes.map(probe), deps.clock)
    }
    return { snapshot }
  }
}
