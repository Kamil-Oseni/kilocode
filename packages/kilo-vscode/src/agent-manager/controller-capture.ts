import type { ProjectContexts } from "./project/contexts"
import type { RunController } from "./run/controller"
import type { createScriptTerminalRuntime } from "./script-terminal-runtime"
import { HostCapture, Hosts } from "../kilo-provider/host-capture"
import type { SessionTerminalManager } from "./SessionTerminalManager"
import type { TerminalRouter } from "./terminal-routing"

export async function closeTerminals(session: SessionTerminalManager, router: TerminalRouter) {
  const results = await Promise.allSettled([session.capture(), router.capture()])
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, "Agent Manager terminal retirement failed")
}

/** Retire controllers before publishing the joined project metadata snapshot. */
export function registerControllers(
  state: ProjectContexts,
  run: RunController,
  scripts: ReturnType<typeof createScriptTerminalRuntime>,
  host: HostCapture = Hosts,
  terminals?: { session: SessionTerminalManager; router: TerminalRouter },
) {
  host.contexts(state, {
    fence: (client) => {
      run.fence()
      scripts.manager.capture(client)
      terminals?.session.fence()
      terminals?.router.fence(client)
    },
    prepare: async () => () => undefined,
    close: async () => {
      const errors: unknown[] = []
      await run.dispose().catch((err: unknown) => {
        errors.push(err)
      })
      await scripts.dispose().catch((err: unknown) => {
        errors.push(err)
      })
      if (terminals) await closeTerminals(terminals.session, terminals.router).catch((err: unknown) => errors.push(err))
      if (errors.length) throw new AggregateError(errors, "Agent Manager controller retirement failed")
    },
  })
}
