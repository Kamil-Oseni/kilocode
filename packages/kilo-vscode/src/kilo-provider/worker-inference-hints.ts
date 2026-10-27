import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import * as path from "node:path"
import { sameDirectory } from "../kilo-provider-utils"

type Job = {
  id: string
  type: string
  status: string
  revision?: string
  metadata?: { parentSessionId?: string; sessionId?: string; childMessageID?: string; background?: boolean }
}
type Scope = { parent: string | undefined; directory: string; client: KiloClient | null; generation: number }
type Route = Scope & { child: string; revision: string; message: string; target: string; expires: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const session = /^ses_[A-Za-z0-9_-]{1,252}$/
const message = /^msg_[A-Za-z0-9_-]{1,252}$/
const absolute = (value: string) => path.isAbsolute(value) || path.win32.isAbsolute(value)
const valid = (value: Session | undefined, id: string, directory: string): value is Session =>
  !!value &&
  value.id === id &&
  typeof value.directory === "string" &&
  absolute(value.directory) &&
  sameDirectory(value.directory, directory) &&
  typeof value.projectID === "string" &&
  !!value.projectID.trim()

/** Short-lived inference hints only. These routes never authorize general events or session adoption. */
export class WorkerHints {
  private readonly routes = new Map<string, Route>()
  private pending?: symbol
  private disposed = false

  clear() {
    this.pending = undefined
    this.routes.clear()
  }

  async refresh(input: {
    parent: string
    directory: string
    client: KiloClient
    generation: number
    current: () => boolean
    jobs: readonly Job[]
  }) {
    if (this.disposed) return
    const token = Symbol()
    this.pending = token
    if (!input.current() || !session.test(input.parent) || !absolute(input.directory)) {
      this.routes.clear()
      return
    }
    if (!Array.isArray(input.jobs)) {
      this.routes.clear()
      return
    }
    const jobs = input.jobs
      .flatMap((job) => {
        if (!job || typeof job !== "object") return []
        const child = job.metadata?.sessionId
        const stamp = job.revision
        const prompt = job.metadata?.childMessageID
        if (
          job.type !== "task" ||
          job.status !== "running" ||
          job.metadata?.background !== true ||
          job.metadata.parentSessionId !== input.parent ||
          child !== job.id ||
          !session.test(job.id) ||
          typeof prompt !== "string" ||
          !message.test(prompt) ||
          typeof stamp !== "string" ||
          !uuid.test(stamp)
        )
          return []
        return [{ child: job.id, revision: stamp, message: prompt }]
      })
      .slice(0, 32)
    const matches = (route: Route) =>
      route.parent === input.parent &&
      route.client === input.client &&
      route.generation === input.generation &&
      sameDirectory(route.directory, input.directory) &&
      route.expires > Date.now()
    // Remove disappeared/terminal/replaced invocations before any lookup yields.
    for (const [id, route] of this.routes) {
      if (
        !matches(route) ||
        !jobs.some((job) => job.child === id && job.revision === route.revision && job.message === route.message)
      )
        this.routes.delete(id)
    }
    const missing = jobs.filter((job) => !this.routes.has(job.child))
    if (!missing.length) return
    const current = () => !this.disposed && this.pending === token && input.current()
    const parent = await input.client.session
      .get(
        { sessionID: input.parent, directory: input.directory },
        { throwOnError: true, signal: AbortSignal.timeout(1500) },
      )
      .then(
        (result) => result.data,
        () => undefined,
      )
    if (!current() || !valid(parent, input.parent, input.directory)) return
    for (let offset = 0; offset < missing.length && current(); offset += 4) {
      await Promise.all(
        missing.slice(offset, offset + 4).map(async (job) => {
          const child = await input.client.session
            .get(
              { sessionID: job.child, directory: input.directory },
              { throwOnError: true, signal: AbortSignal.timeout(1500) },
            )
            .then(
              (result) => result.data,
              () => undefined,
            )
          // Missing/unavailable identities leave no route; polling remains available.
          if (
            !current() ||
            !child ||
            child.id !== job.child ||
            child.parentID !== parent.id ||
            child.projectID !== parent.projectID ||
            typeof child.directory !== "string" ||
            !absolute(child.directory)
          )
            return
          this.routes.set(job.child, {
            parent: input.parent,
            directory: input.directory,
            client: input.client,
            generation: input.generation,
            child: job.child,
            revision: job.revision,
            message: job.message,
            target: child.directory,
            expires: Date.now() + 15_000,
          })
        }),
      )
    }
  }

  dispose() {
    this.disposed = true
    this.clear()
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
      route.parent === scope.parent &&
      route.client === scope.client &&
      route.generation === scope.generation &&
      sameDirectory(route.directory, scope.directory) &&
      sameDirectory(route.target, directory)
    )
  }
}
