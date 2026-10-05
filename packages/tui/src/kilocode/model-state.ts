type Data = Record<string, unknown>
export type Model = { providerID: string; modelID: string }
export type Intent =
  | { kind: "pick"; agent: string; model?: Model; recent?: Model }
  | { kind: "favorite"; model: Model }
  | { kind: "variant"; key: string; value: string }

export type Port = {
  read(): Promise<Data>
  change(body: (data: Data) => Data): Promise<Data>
  observe?(job: Promise<unknown>): void
  settle(): Promise<void>
}

/** Standalone compatibility only: no native ownership or capture authority. */
export function legacy(read: () => Promise<unknown>, write: (data: Data) => Promise<void>): Port {
  let tail: Promise<unknown> = Promise.resolve()
  const errors: unknown[] = []
  const hold = <A>(job: Promise<A>) => {
    tail = job.then(
      () => undefined,
      (err: unknown) => {
        if (!errors.includes(err)) errors.push(err)
      },
    )
    return job
  }
  return {
    observe: (job) => {
      void hold(job)
    },
    read: () => hold(read().then(record)),
    change: (body) =>
      hold(
        tail.then(async () => {
          const data = body(record(await read()))
          await write(data)
          return data
        }),
      ),
    async settle() {
      await tail
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "Standalone TUI model publication failed")
    },
  }
}

function record(value: unknown): Data {
  const valid = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value)
  return valid(value) ? value : {}
}

function refs(value: unknown): Model[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is Model =>
      item !== null &&
      typeof item === "object" &&
      typeof item.providerID === "string" &&
      typeof item.modelID === "string",
  )
}

const same = (left: Model, right: Model) => left.providerID === right.providerID && left.modelID === right.modelID

export function view(data: Data) {
  const valid = (value: unknown): value is Model =>
    value !== null &&
    typeof value === "object" &&
    "providerID" in value &&
    typeof value.providerID === "string" &&
    "modelID" in value &&
    typeof value.modelID === "string"
  return {
    model: Object.fromEntries(
      Object.entries(record(data.model)).filter((entry): entry is [string, Model] => valid(entry[1])),
    ),
    variant: Object.fromEntries(
      Object.entries(record(data.variant)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    recent: refs(data.recent),
    favorite: refs(data.favorite),
  }
}

export function reduce(data: Data, intent: Intent): Data {
  if (intent.kind === "variant") return { ...data, variant: { ...record(data.variant), [intent.key]: intent.value } }
  if (intent.kind === "favorite") {
    const prior = refs(data.favorite)
    const favorite = prior.some((item) => same(item, intent.model))
      ? prior.filter((item) => !same(item, intent.model))
      : [{ ...intent.model }, ...prior]
    return { ...data, favorite }
  }
  const model = intent.model
    ? { ...record(data.model), [intent.agent]: { ...intent.model } }
    : { ...record(data.model) }
  if (!intent.model) delete model[intent.agent]
  if (!intent.recent) return { ...data, model }
  const seen = new Set<string>()
  const recent = [intent.recent, ...refs(data.recent)]
    .filter((item) => {
      const key = JSON.stringify([item.providerID, item.modelID])
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ ...item }))
  return { ...data, model, recent }
}

/** Ordered optimistic projection; publication always reduces the latest locked document. */
export function make(port: Port, render: (data: Data) => void, ready: () => void) {
  const intents = new Map<number, Intent>()
  const jobs = new Set<Promise<unknown>>()
  const errors: unknown[] = []
  let revision = 0
  let applied = 0
  let loaded = false
  let closed = false
  let value: Data = {}
  const overlay = (data: Data, after = 0) => {
    for (const [id, intent] of intents) if (id > after) data = reduce(data, intent)
    return data
  }
  const keep = (job: Promise<unknown>) => {
    port.observe?.(job)
    const held = job.then(
      () => undefined,
      (err: unknown) => {
        if (!errors.includes(err)) errors.push(err)
      },
    )
    jobs.add(held)
    void held.then(() => jobs.delete(held))
  }
  const deliver = (data: Data) => {
    try {
      render(data)
    } catch (err) {
      keep(Promise.reject(err))
      throw err
    }
  }
  const hydration = port
    .read()
    .then((data) => {
      if (closed) return
      value = overlay(data)
      render(value)
    })
    .finally(() => {
      loaded = true
      for (const id of intents.keys()) if (id <= applied) intents.delete(id)
      if (!closed) ready()
    })
  keep(hydration)
  return {
    change(input: Intent) {
      if (closed) throw new Error("TUI model delivery is retired")
      // Solid store proxies cannot be structured-cloned; capture only immutable intent primitives.
      const ref = (value: Model) => ({ providerID: value.providerID, modelID: value.modelID })
      const intent: Intent =
        input.kind === "pick"
          ? {
              kind: input.kind,
              agent: input.agent,
              model: input.model ? ref(input.model) : undefined,
              recent: input.recent ? ref(input.recent) : undefined,
            }
          : input.kind === "favorite"
            ? { kind: input.kind, model: ref(input.model) }
            : { kind: input.kind, key: input.key, value: input.value }
      const id = ++revision
      // The port reserves synchronously before optimistic UI publication or any await.
      const job = port.change((data) => reduce(data, intent))
      intents.set(id, intent)
      value = reduce(value, intent)
      keep(
        job.then((data) => {
          if (id < applied) return
          applied = id
          if (!loaded || closed) return
          value = overlay(data, id)
          render(value)
          for (const prior of intents.keys()) if (prior <= id) intents.delete(prior)
        }),
      )
      deliver(value)
    },
    close() {
      closed = true
    },
    async flush() {
      while (jobs.size) await Promise.all(jobs)
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "TUI model publication failed")
    },
  }
}
