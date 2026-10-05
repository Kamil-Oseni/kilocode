import { AsyncLocalStorage } from "node:async_hooks"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import {
  acquireCoveredProfileRoot,
  acquireProfileRoot,
  resolveProfileRoot,
} from "@opencode-ai/core/kilocode/profile-maintenance"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { Effect } from "effect"
import { KiloShutdown } from "../cli/shutdown"
import { ProfileWriterLive } from "../migration/writer-live"

type Lease = Awaited<ReturnType<typeof acquireProfileRoot>>
type State = { selected: string; namespace: string; leases: ReadonlyMap<string, Lease> }
const local = new AsyncLocalStorage<State>()
const pending = new Set<Promise<void>>()
const failures: unknown[] = []
let closing: Promise<void> | undefined
let installed = false
let writer: ProfileWriterLive.Admission | undefined

export function install() {
  if (installed) return
  KiloShutdown.register(() => {
    if (closing) return closing
    closing = Promise.all(pending).then(() => {
      if (failures.length) throw new AggregateError(failures, "Memory writer retirement failed")
    })
    return closing
  })
  MemoryFiles.configure({ run, mutate })
  writer = ProfileWriterLive.memory()
  installed = true
}

function run<T>(root: string, body: () => Promise<T>): Promise<T> {
  if (closing) return Promise.reject(new Error("Memory writer is retired"))
  if (!writer) return Promise.reject(new Error("Memory writer admission is unavailable"))
  const work = Effect.runPromise(writer.run(Effect.promise(() => admit(root, [Global.Path.data, root], body))))
  const settled = work.then(
    () => {
      pending.delete(settled)
    },
    (err) => {
      failures.push(err)
      pending.delete(settled)
    },
  )
  pending.add(settled)
  return work
}

function mutate<T>(root: string, files: readonly string[], body: () => Promise<T>): Promise<T> {
  const state = local.getStore()
  if (!state || state.selected !== root) return Promise.reject(new Error("Memory mutation lifetime is unknown"))
  return admit(root, files, body).catch((err) => {
    failures.push(err)
    throw err
  })
}

async function admit<T>(selected: string, files: readonly string[], body: () => Promise<T>): Promise<T> {
  const prior = local.getStore()
  const namespace = await resolveProfileRoot({ kind: "json", path: selected })
  if (prior && namespace.path !== prior.namespace) throw new Error("Memory namespace binding changed")
  const paths = [...new Set(files)]
  const roots = await Promise.all(paths.map((file) => resolveProfileRoot({ kind: "json", path: file })))
  if (prior) {
    for (const root of roots) {
      const relative = path.relative(namespace.path, root.path)
      const ancestor = path.relative(root.path, namespace.path)
      const inside = (value: string) => value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value)
      if (!inside(relative) && !inside(ancestor)) throw new Error("Memory mutation is outside its admitted namespace")
    }
  }
  const scopes = [...new Map(roots.map((root) => [root.id, root])).values()]
    .filter((root) => !prior?.leases.has(root.id))
    .sort((one, two) => (one.id < two.id ? -1 : one.id > two.id ? 1 : 0))
  const leases: Lease[] = []
  const owners: string[] = []
  const errors: unknown[] = []
  async function check() {
    if ((await resolveProfileRoot({ kind: "json", path: selected })).path !== namespace.path)
      throw new Error("Memory namespace binding changed")
    const current = await Promise.all(paths.map((file) => resolveProfileRoot({ kind: "json", path: file })))
    if (current.some((root, index) => root.id !== roots[index].id)) throw new Error("Memory mutation binding changed")
  }
  const result = { value: undefined as { value: T } | undefined }
  try {
    for (const root of scopes) {
      const cover = [...(prior?.leases.values() ?? [])]
        .filter((lease) => {
          const relative = path.relative(lease.root.path, root.path)
          return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        })
        .sort((one, two) => two.root.path.length - one.root.path.length)[0]
      const lease = cover ? await acquireCoveredProfileRoot(root, cover) : await acquireProfileRoot(root)
      leases.push(lease)
      if (!cover) owners.push(root.path)
      if (lease.id !== root.id) throw new Error("Memory writer root changed during admission")
    }
    await check()
    registerProcessProfile(owners)
    const held = new Map(prior?.leases ?? [])
    for (const lease of leases) held.set(lease.id, lease)
    result.value = { value: await local.run({ selected, namespace: namespace.path, leases: held }, body) }
    await check()
  } catch (err) {
    errors.push(err)
  } finally {
    for (const lease of leases.reverse()) {
      try {
        await lease.release()
      } catch (err) {
        errors.push(err)
      }
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, "Memory writer admission failed")
  if (!result.value) throw new Error("Memory writer admission has no completed result")
  return result.value.value
}
