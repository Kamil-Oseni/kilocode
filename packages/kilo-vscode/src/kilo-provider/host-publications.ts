import { randomUUID } from "node:crypto"
import { held } from "./held-preferences"

type Store = {
  get(key: string): unknown
  update(key: string, value: unknown): PromiseLike<void>
}
type Context = { globalState: Store }
type Key = "recentModels" | "favoriteModels" | "variantSelections" | "modelUsage" | "modelSelectorExpanded"
const keys = new Set<string>([
  "recentModels",
  "favoriteModels",
  "variantSelections",
  "modelUsage",
  "modelSelectorExpanded",
])
const owners = new WeakMap<Store, HostPublications>()

/** Only these Raya publications participate. VS Code and other extension hosts remain outside this fence. */
export class HostPublications {
  readonly generation = randomUUID()
  private revision = 0
  private snapshot:
    | Promise<Readonly<{ generation: string; revision: number; preferences: ReturnType<typeof held> }>>
    | undefined
  private closed = false
  private tail: Promise<void> = Promise.resolve()
  private readonly errors: unknown[] = []
  private retirement: Promise<void> | undefined

  constructor(private readonly store: Store) {}

  write(key: Key, value: unknown): Promise<unknown> {
    const data = structuredClone(value)
    return this.mutate(key, () => data)
  }

  mutate(key: Key, body: (current: unknown) => unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Raya host preference publication is retired"))
    if (!keys.has(key)) return Promise.reject(new Error("Raya host preference key does not participate"))
    const job = this.tail.then(async () => {
      const value = body(structuredClone(this.store.get(key)))
      await this.store.update(key, structuredClone(value))
      this.revision++
      return value
    })
    this.tail = job.then(
      () => undefined,
      (err) => {
        this.errors.push(err)
      },
    )
    return job
  }

  /** Terminal for this realized controller only; never establishes cross-window or full-profile closure. */
  retire(): Promise<void> {
    if (this.retirement) return this.retirement
    this.closed = true
    this.retirement = this.tail.then(() => {
      if (this.errors.length) throw new AggregateError([...this.errors], "Raya host preference publication failed")
    })
    return this.retirement
  }

  /** Declared preferences only; no raw Memento database or native authority. */
  captureSnapshot() {
    this.snapshot ??= this.retire().then(() =>
      Object.freeze({
        generation: this.generation,
        revision: this.revision,
        preferences: held({
          extensionState: {
            recentModels: structuredClone(this.store.get("recentModels")),
            favoriteModels: structuredClone(this.store.get("favoriteModels")),
            variantSelections: structuredClone(this.store.get("variantSelections")),
            modelSelectorExpanded: structuredClone(this.store.get("modelSelectorExpanded")),
          },
        }),
      }),
    )
    return this.snapshot
  }
}

export function hostPublications(context: Context | undefined, create = true): HostPublications | undefined {
  if (!context) return
  const previous = owners.get(context.globalState)
  if (previous) return previous
  if (!create) return
  const owner = new HostPublications(context.globalState)
  owners.set(context.globalState, owner)
  return owner
}
