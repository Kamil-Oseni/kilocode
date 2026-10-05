import { Effect } from "effect"
import { ProfileWriterManifest } from "./writer-manifest"
import { ProfileWriterRegistry } from "./writer-registry"

export namespace ProfileWriterLive {
  export type Admission = {
    run<A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
  }

  const ids = ProfileWriterManifest.manifest.writers.map((writer) => writer.id)
  const registry = ProfileWriterRegistry.make(ids)
  const integrated = new Set(
    ProfileWriterManifest.manifest.writers
      .filter((writer) => writer.coverage === "integrated")
      .map((writer) => writer.id),
  )

  for (const id of integrated) if (id !== "profile.data.memory") Effect.runSync(registry.register(id))
  let installed: Admission | undefined
  let repository: Admission | undefined
  let worktree: Admission | undefined
  let cache: Admission | undefined
  let model: Admission | undefined

  export function from(registry: ProfileWriterRegistry.Registry, id: string): Admission {
    return { run: (body) => registry.runOrDie(id, body) }
  }

  export function admission(id: string): Admission {
    if (!integrated.has(id)) throw new Error(`Profile writer is not integrated: ${id}`)
    if (id === "profile.data.memory") {
      if (!installed) throw new Error("Memory writer port is not installed")
      return installed
    }
    return from(registry, id)
  }

  /** Register only when the actual memory port installs, never during manifest initialization. */
  export function memory(): Admission {
    if (installed) return installed
    const id = "profile.data.memory"
    Effect.runSync(registry.register(id))
    installed = from(registry, id)
    return installed
  }

  /** Register only from actual Snapshot realization; static manifest coverage remains separate. */
  export function snapshots(): Admission {
    if (repository) return repository
    const id = "profile.data.snapshots"
    Effect.runSync(registry.register(id))
    repository = from(registry, id)
    return repository
  }

  /** Actual Worktree realization only; historical manifest completeness remains unchanged. */
  export function worktrees(): Admission {
    if (worktree) return worktree
    const id = "profile.data.worktrees"
    Effect.runSync(registry.register(id))
    worktree = from(registry, id)
    return worktree
  }

  /** Actual repository cache producer acceptance only; no static capture-coverage change. */
  export function repos(): Admission {
    if (cache) return cache
    const id = "profile.data.repos"
    Effect.runSync(registry.register(id))
    cache = from(registry, id)
    return cache
  }

  export const storage = admission("profile.storage.json")
  export const attachments = admission("profile.tmp.attachments")
  export const auth = admission("profile.credentials.auth")
  export const mcp = admission("profile.credentials.mcp")
  /** Actual backend model publication only; other model clients remain uncovered. */
  export function models(): Admission {
    if (model) return model
    const id = "profile.state.model"
    Effect.runSync(registry.register(id))
    model = from(registry, id)
    return model
  }

  export const uploads = admission("profile.cache.browser-uploads")
  export const output = admission("profile.data.tool-output")
  export const revertNote = admission("profile.data.revert-note")
  export const policy = admission("profile.state.sandbox-policy")
  export const preference = admission("profile.state.sandbox-preference")
  export const pluginMeta = admission("profile.state.plugin-meta")
  export const diagnostics = admission("profile.log.diagnostics")
  export const snapshot = registry.snapshot
}
