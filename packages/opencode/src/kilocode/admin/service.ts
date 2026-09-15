import { Effect } from "effect"
import type { ProfileInfo } from "@/kilocode/browser/profile-schema"
import type { Session } from "@/session/session"
import { RayaTask } from "@/kilocode/task"
import type { Info as VoiceInfo } from "@/kilocode/voice/protocol"
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

  export type Deps = {
    runtime: () => Result<State>
    sessions: Pick<Session.Interface, "list">
    tasks: Tasks
    browser?: () => Result<Browser>
    voice?: () => Result<Voice>
    clock?: () => number
  }

  export function make(deps: Deps) {
    const snapshot = async () => {
      const state = Promise.resolve().then(deps.runtime)
      const tasks = state.then((current) => {
        if (current !== "connected") return undefined
        return Promise.all([Effect.runPromise(deps.tasks.list()), Effect.runPromise(deps.tasks.histories())])
      })
      const probes: RayaAdmin.Probe[] = [
        {
          id: "runtime",
          read: async (at) => RayaAdmin.runtime(await state, at),
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
          id: "routines",
          read: async (at) => {
            const found = await tasks
            if (!found) return RayaAdmin.unavailable("routines", at, "disconnected")
            return RayaAdmin.routines(found[0], found[1], at)
          },
        },
        {
          id: "agents",
          read: async (at) => {
            const found = await tasks
            if (!found) return RayaAdmin.unavailable("agents", at, "disconnected")
            return RayaAdmin.agents(found[0], at)
          },
        },
      ]
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
      return RayaAdmin.collect(probes, deps.clock)
    }
    return { snapshot }
  }
}
