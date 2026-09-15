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

  for (const id of integrated) Effect.runSync(registry.register(id))

  export function from(registry: ProfileWriterRegistry.Registry, id: string): Admission {
    return { run: (body) => registry.runOrDie(id, body) }
  }

  export function admission(id: string): Admission {
    if (!integrated.has(id)) throw new Error(`Profile writer is not integrated: ${id}`)
    return from(registry, id)
  }

  export const storage = admission("profile.storage.json")
  export const auth = admission("profile.credentials.auth")
  export const mcp = admission("profile.credentials.mcp")
  export const uploads = admission("profile.cache.browser-uploads")
  export const output = admission("profile.data.tool-output")
  export const revertNote = admission("profile.data.revert-note")
  export const policy = admission("profile.state.sandbox-policy")
  export const preference = admission("profile.state.sandbox-preference")
  export const pluginMeta = admission("profile.state.plugin-meta")
  export const snapshot = registry.snapshot
}
