import type { Memento } from "vscode"
import { createHash } from "node:crypto"
import { Lights } from "./client"
import { fingerprint } from "./journal"
import { record, rgb } from "./policy"
import { Failure } from "./error"

export type Mood = Readonly<{
  name: string
  theme: string
  sources: readonly string[]
  palette: readonly (readonly [number, number, number])[]
  seconds: number
  duration: number
  lights: readonly Readonly<{ entity: string; brightness: number; phase: number }>[]
}>

function timing(value: Record<string, unknown>) {
  const seconds = value.seconds
  const duration = value.duration
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 30 || seconds > 600)
    throw new Failure("invalid_mood_cycle")
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 60 || duration > 10800)
    throw new Failure("invalid_mood_duration")
  return { seconds, duration }
}

export function parse(value: unknown, allowed: readonly string[]): Mood {
  if (!record(value) || Object.keys(value).sort().join() !== "duration,lights,name,palette,seconds,sources,theme")
    throw new Failure("invalid_mood")
  if (typeof value.name !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(value.name))
    throw new Failure("invalid_mood_name")
  if (typeof value.theme !== "string" || !value.theme.trim() || value.theme.length > 240)
    throw new Failure("invalid_mood_theme")
  if (
    !Array.isArray(value.sources) ||
    value.sources.length > 5 ||
    value.sources.some((source) => {
      if (typeof source !== "string" || source.length > 1024) return true
      const url = URL.canParse(source) ? new URL(source) : undefined
      return !url || url.protocol !== "https:" || !!url.username || !!url.password
    })
  )
    throw new Failure("invalid_mood_sources")
  if (!Array.isArray(value.palette) || value.palette.length < 2 || value.palette.length > 6)
    throw new Failure("invalid_mood_palette")
  const limits = timing(value)
  if (!Array.isArray(value.lights) || !value.lights.length || value.lights.length > 16)
    throw new Failure("invalid_mood_lights")
  const seconds = limits.seconds
  const lights = value.lights.map((light) => {
    if (
      !record(light) ||
      Object.keys(light).sort().join() !== "brightness,entity,phase" ||
      typeof light.entity !== "string" ||
      !allowed.includes(light.entity) ||
      typeof light.brightness !== "number" ||
      !Number.isInteger(light.brightness) ||
      light.brightness < 1 ||
      light.brightness > 255 ||
      typeof light.phase !== "number" ||
      !Number.isFinite(light.phase) ||
      light.phase < 0 ||
      light.phase >= seconds
    )
      throw new Failure("invalid_mood_light")
    return Object.freeze({ entity: light.entity, brightness: light.brightness, phase: light.phase })
  })
  if (new Set(lights.map((light) => light.entity)).size !== lights.length) throw new Failure("duplicate_mood_light")
  return Object.freeze({
    name: value.name,
    theme: value.theme.trim(),
    sources: Object.freeze([...value.sources]),
    palette: Object.freeze(value.palette.map(rgb)),
    seconds,
    duration: limits.duration,
    lights: Object.freeze(lights),
  })
}

export function frame(mood: Mood, elapsed: number) {
  return mood.lights.map((light) => {
    const position = (((elapsed + light.phase) % mood.seconds) / mood.seconds) * mood.palette.length
    const index = Math.floor(position)
    const first = mood.palette[index]
    const next = mood.palette[(index + 1) % mood.palette.length]
    const blend = position - index
    return {
      entity: light.entity,
      state: "on" as const,
      brightness: light.brightness,
      rgb_color: rgb(first.map((value, channel) => Math.round(value + (next[channel] - value) * blend))),
    }
  })
}

function digest(mood: Mood) {
  return createHash("sha256").update(JSON.stringify(mood)).digest("hex")
}

/** Saved metadata only. Live cycles belong to this host and are never replayed. */
export class Moods {
  #controller?: AbortController
  #job?: Promise<void>
  #starting?: Promise<unknown>
  #saving?: Promise<unknown>
  #epoch = 0
  #closed = false
  #changing = false
  #status: { name?: string; state: "idle" | "running" | "stopped" | "completed" | "failed"; code?: string } = {
    state: "idle",
  }
  readonly #key: string
  constructor(
    private readonly lights: Lights,
    private readonly storage: Pick<Memento, "get" | "update">,
  ) {
    this.#key = `raya.moods.${fingerprint(lights.config)}`
  }
  list() {
    const saved = this.storage.get<unknown>(this.#key) ?? []
    if (!Array.isArray(saved) || saved.length > 32) throw new Failure("mood_store_invalid")
    return { moods: saved.map((value) => parse(value, this.lights.config.entities)), activity: { ...this.#status } }
  }
  save(input: unknown, replace = false) {
    if (this.#closed || this.#changing) return Promise.reject(new Failure("closed_or_busy"))
    const job = this.persist(input, replace)
    this.#saving = job
    return job.finally(() => {
      if (this.#saving === job) this.#saving = undefined
    })
  }
  private async persist(input: unknown, replace: boolean) {
    const mood = parse(input, this.lights.config.entities)
    this.#changing = true
    try {
      const saved = this.list().moods
      if (saved.some((item) => item.name === mood.name) && !replace) throw new Failure("mood_exists")
      const next = [...saved.filter((item) => item.name !== mood.name), mood]
      if (next.length > 32) throw new Failure("mood_store_full")
      await this.storage.update(this.#key, next)
      const actual = this.list().moods.find((item) => item.name === mood.name)
      if (!actual || digest(actual) !== digest(mood)) throw new Failure("mood_save_unconfirmed")
      return {
        outcome: "saved" as const,
        mood: actual,
        digest: digest(actual),
        notice: "Saved locally; no lights changed.",
      }
    } finally {
      this.#changing = false
    }
  }
  start(name: string, signal: AbortSignal) {
    if (this.#closed || this.#changing) return Promise.reject(new Failure("closed_or_busy"))
    const epoch = ++this.#epoch
    const job = this.run(name, signal, epoch)
    this.#starting = job
    return job.finally(() => {
      if (this.#starting === job) this.#starting = undefined
    })
  }
  private async run(name: string, signal: AbortSignal, epoch: number) {
    const mood = this.list().moods.find((item) => item.name === name)
    if (!mood) throw new Failure("mood_not_found")
    this.#changing = true
    try {
      await this.retire()
      signal.throwIfAborted()
      if (this.#closed || epoch !== this.#epoch) throw new Failure("closed_or_revoked")
      const controller = new AbortController()
      this.#controller = controller
      const abort = () => controller.abort()
      signal.addEventListener("abort", abort, { once: true })
      const started = performance.now()
      const previous = new Map<string, Awaited<ReturnType<Lights["set"]>>["states"][number]>()
      const step = async () => {
        const targets = frame(mood, (performance.now() - started) / 1000)
        for (const target of targets) {
          controller.signal.throwIfAborted()
          const expected = previous.get(target.entity)
          if (expected) {
            const actual = await this.lights.state(target.entity, controller.signal)
            if (
              actual.state !== expected.state ||
              actual.brightness !== expected.brightness ||
              JSON.stringify(actual.rgb_color) !== JSON.stringify(expected.rgb_color)
            )
              throw new Failure("mood_external_change")
          }
          const { entity, ...goal } = target
          const result = await this.lights.set(entity, goal, controller.signal)
          for (const state of result.states) previous.set(state.entity, state)
        }
      }
      try {
        await step()
      } finally {
        signal.removeEventListener("abort", abort)
      }
      this.#status = { name, state: "running" }
      this.#job = (async () => {
        while (!controller.signal.aborted && performance.now() - started < mood.duration * 1000) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer)
              controller.signal.removeEventListener("abort", finish)
              resolve()
            }
            const timer = setTimeout(finish, 2000)
            controller.signal.addEventListener("abort", finish, { once: true })
            if (controller.signal.aborted) finish()
          })
          if (controller.signal.aborted || performance.now() - started >= mood.duration * 1000) break
          await step()
        }
        this.#status = { name, state: controller.signal.aborted ? "stopped" : "completed" }
      })().catch((error: unknown) => {
        const uncertain = error instanceof Failure && error.uncertain
        this.#status = {
          name,
          state: controller.signal.aborted && !uncertain ? "stopped" : "failed",
          ...(!controller.signal.aborted || uncertain
            ? { code: error instanceof Failure ? error.code : "mood_failed" }
            : {}),
        }
      })
      return {
        outcome: "started" as const,
        mood,
        notice:
          "First frame confirmed in Home Assistant. The host-owned cycle continues; query moods for progress. Closing Raya stops it. Expiry leaves the last colour in place.",
      }
    } catch (error) {
      this.#status = { name, state: "failed", code: error instanceof Failure ? error.code : "mood_failed" }
      throw error
    } finally {
      this.#changing = false
    }
  }
  private async retire() {
    this.#controller?.abort()
    await this.#job
    this.#job = undefined
    this.#controller = undefined
    return {
      outcome: "stopped" as const,
      activity: { ...this.#status },
      notice: "No further cycle writes; current light colour is preserved.",
    }
  }
  async stop() {
    this.#epoch++
    this.#controller?.abort()
    await Promise.allSettled(this.#starting ? [this.#starting] : [])
    return this.retire()
  }
  async dispose() {
    this.#closed = true
    const results = await Promise.allSettled([this.stop(), ...(this.#saving ? [this.#saving] : [])])
    const errors = results.flatMap((value) => (value.status === "rejected" ? [value.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Mood original retirement failures retained")
  }
}
