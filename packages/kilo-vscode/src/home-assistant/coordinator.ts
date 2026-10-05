import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { Bridge } from "./bridge"
import { Lights } from "./client"
import { Settings } from "./settings"
import { Journal } from "./journal"
import { Failure } from "./error"
import { record, selection } from "./policy"
import type { Memento } from "vscode"
import { Moods } from "./moods"

type Connection = Pick<
  KiloConnectionService,
  "onStateChange" | "onEvent" | "getClient" | "getKnownDirectories" | "getConnectionState" | "isClientCurrent"
>
type Binding = { bridge: Bridge; job: Promise<void> }
const name = "raya_home_assistant"
function start<T>(action: () => Promise<T>) {
  try {
    return action()
  } catch (error) {
    return Promise.reject(error)
  }
}
async function join(jobs: readonly Promise<unknown>[]) {
  const results = await Promise.allSettled(jobs)
  const errors = [...new Set(results.flatMap((value) => (value.status === "rejected" ? [value.reason] : [])))]
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, "Home Assistant original lifecycle failures retained")
}
export class Coordinator {
  #lights?: Lights
  #moods?: Moods
  #ready = false
  #bindings = new Map<KiloClient, Map<string, Binding>>()
  #jobs = new Set<Promise<unknown>>()
  #failures = new Set<unknown>()
  #epoch = 0
  #closed = false
  #changing = false
  #ending?: Promise<void>
  #off: (() => void)[]
  constructor(
    private readonly connection: Connection,
    private readonly settings: Settings,
    private readonly journal: Journal,
    private readonly storage?: Pick<Memento, "get" | "update">,
  ) {
    this.#off = [
      connection.onStateChange(() => {
        this.track(start(() => this.register()))
      }),
      connection.onEvent(() => {
        this.track(start(() => this.register()))
      }),
    ]
  }
  private track<T>(job: Promise<T>) {
    this.#jobs.add(job)
    void job.then(
      () => this.#jobs.delete(job),
      (error) => {
        this.#failures.add(error)
        this.#jobs.delete(job)
      },
    )
    return job
  }
  initialize() {
    if (this.#closed || this.#changing || this.#lights) return Promise.reject(new Failure("closed_or_busy"))
    this.#changing = true
    return this.track(
      (async () => {
        const saved = await this.settings.load()
        if (saved && !this.#closed) await this.open(saved.config, saved.token)
      })().finally(() => {
        this.#changing = false
        return this.register()
      }),
    )
  }
  configure(input: unknown, token: string) {
    selection(input)
    if (this.#closed || this.#changing) return Promise.reject(new Failure("closed_or_busy"))
    this.#changing = true
    this.#epoch++
    return this.track(
      (async () => {
        await this.release()
        if (this.#closed) throw new Failure("closed")
        await this.settings.save(input, token)
        if (this.#closed) return
        const saved = await this.settings.load()
        if (!saved) throw new Failure("setup_unavailable")
        if (this.#closed) return
        await this.open(saved.config, saved.token)
      })().finally(() => {
        this.#changing = false
        return this.register()
      }),
    )
  }
  private async open(input: unknown, token: string) {
    if (this.#closed) throw new Failure("closed")
    const lights = new Lights(token, input, this.journal)
    this.#lights = lights
    await lights.prepare()
    if (this.storage && !this.#closed && this.#lights === lights) this.#moods = new Moods(lights, this.storage)
    if (!this.#closed && this.#lights === lights) this.#ready = true
  }
  private current(client: KiloClient, epoch: number) {
    return !this.#closed && !this.#changing && this.#epoch === epoch && this.connection.isClientCurrent(client)
  }
  private register() {
    if (this.#closed || this.#changing || !this.#lights || !this.#ready) return Promise.resolve()
    const jobs: Promise<unknown>[] = []
    for (const [client, rows] of this.#bindings) {
      if (this.connection.isClientCurrent(client)) continue
      this.#bindings.delete(client)
      for (const [directory, row] of rows) jobs.push(this.track(this.close(client, directory, row)))
    }
    if (this.connection.getConnectionState() !== "connected")
      return join([...jobs, this.#moods?.stop() ?? Promise.resolve()])
    const client = this.connection.getClient()
    const rows = this.#bindings.get(client) ?? new Map<string, Binding>()
    this.#bindings.set(client, rows)
    const epoch = this.#epoch
    for (const directory of this.connection.getKnownDirectories()) {
      if (!directory || rows.has(directory)) continue
      const bridge = new Bridge(this.#lights, () => this.current(client, epoch), false, this.#moods)
      const row = { bridge, job: Promise.resolve() }
      rows.set(directory, row)
      row.job = (async () => {
        const endpoint = await bridge.open()
        if (!this.current(client, epoch)) return
        const reply = await client.mcp.add(
          { directory, name, config: { type: "remote", ...endpoint, enabled: true, oauth: false, timeout: 20000 } },
          { signal: AbortSignal.timeout(25000), throwOnError: true },
        )
        if (!this.current(client, epoch)) return
        const status: unknown = reply.data
        const current = record(status) ? status[name] : undefined
        if (!record(current) || current.status !== "connected") throw new Failure("bridge_registration_failed")
      })()
      jobs.push(this.track(row.job))
    }
    return join(jobs)
  }
  private async close(client: KiloClient, directory: string, row: Binding) {
    const results = await Promise.allSettled([row.job, start(() => row.bridge.dispose())])
    // Disconnection is not physical closure proof; the owned bridge has its own original joins.
    const disconnected = await Promise.allSettled([
      start(() =>
        client.mcp.disconnect({ directory, name }, { signal: AbortSignal.timeout(5000), throwOnError: true }),
      ),
    ])
    await join(
      [...results, ...disconnected].map((value) =>
        value.status === "rejected" ? Promise.reject(value.reason) : Promise.resolve(),
      ),
    )
  }
  reconcile(confirm = false) {
    if (this.#closed || this.#changing || !this.#lights) return Promise.reject(new Failure("closed_or_busy"))
    return this.track(this.#lights.reconcile(confirm))
  }
  private release() {
    const lights = this.#lights
    const moods = this.#moods
    this.#moods = undefined
    this.#lights = undefined
    this.#ready = false
    const bindings = this.#bindings
    this.#bindings = new Map()
    const jobs: Promise<unknown>[] = lights
      ? [
          start(async () => {
            const stopped = await Promise.allSettled(moods ? [moods.dispose()] : [])
            const closed = await Promise.allSettled([lights.dispose()])
            const errors = [...stopped, ...closed].flatMap((value) =>
              value.status === "rejected" ? [value.reason] : [],
            )
            if (errors.length) throw new AggregateError(errors, "Home Assistant mood and light ownership retained")
          }),
        ]
      : []
    for (const [client, rows] of bindings)
      for (const [directory, row] of rows) jobs.push(this.close(client, directory, row))
    return join(jobs)
  }
  dispose() {
    this.#closed = true
    this.#epoch++
    const off = this.#off
    this.#off = []
    this.#ending ??= (async () => {
      const release = this.release()
      const removed = off.map((action) => Promise.resolve().then(action))
      const results = await Promise.allSettled([release, ...this.#jobs, ...removed])
      const errors = [
        ...new Set([
          ...this.#failures,
          ...results.flatMap((value) => (value.status === "rejected" ? [value.reason] : [])),
        ]),
      ]
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "Home Assistant original retirement failures retained")
    })()
    return this.#ending
  }
}
