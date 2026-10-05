import { type Config } from "./config"
import { selection, goal, record, rgb, type Goal } from "./policy"
import { Journal, fingerprint } from "./journal"
import { Failure, safe } from "./error"
import { response } from "./response"

type State = Readonly<{
  entity: string
  state: "on" | "off" | "unavailable" | "unknown"
  brightness?: number
  rgb_color?: readonly [number, number, number]
  color: boolean
}>
function matches(state: State, goal: Goal) {
  return (
    state.state === goal.state &&
    (goal.brightness === undefined ||
      (state.brightness !== undefined && Math.abs(state.brightness - goal.brightness) <= 2)) &&
    (goal.rgb_color === undefined || goal.rgb_color.every((value, index) => state.rgb_color?.[index] === value))
  )
}
function wait(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(new Failure("aborted_or_expired", true))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, 200)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Extension-host credential owner. Readback is HA-reported state, never a physical-device acknowledgement. */
export class Lights {
  #token: string
  readonly config: Config
  #controller = new AbortController()
  #jobs = new Set<Promise<unknown>>()
  #failures = new Set<unknown>()
  #active = false
  #closed = false
  #uncertain = false
  constructor(
    token: string,
    input: unknown,
    private readonly journal: Journal,
  ) {
    this.config = selection(input)
    if (!token.trim() || token.length > 8192 || /[\r\n\x00-\x20\x7f]/.test(token))
      throw new Failure("invalid_credential")
    this.#token = token
    this.#uncertain = !!journal.pending()
  }
  prepare() {
    const scope = this.scope(undefined, 20000)
    return this.retain(
      (async () => {
        const states = await this.readback(this.config.entities, scope)
        if (states.some((value) => value.state === "unknown" || value.state === "unavailable"))
          throw new Failure("unavailable")
        for (const mode of this.config.modes) await this.existence(mode.entity, scope)
        scope.throwIfAborted()
      })(),
    )
  }
  private async existence(entity: string, signal: AbortSignal) {
    const value = await this.request(`states/${entity}`, signal)
    if (
      !record(value) ||
      value.entity_id !== entity ||
      typeof value.state !== "string" ||
      ["unknown", "unavailable"].includes(value.state)
    )
      throw new Failure("mode_unavailable")
    return value
  }
  reconcile(confirm = false, signal?: AbortSignal) {
    const scope = this.scope(signal, 15000)
    if (this.#active) throw new Failure("busy")
    this.#active = true
    return this.retain(
      (async () => {
        const debt = this.journal.pending()
        if (!debt) return { outcome: "no_pending_action" as const }
        if (debt.fingerprint !== fingerprint(this.config)) throw new Failure("journal_configuration_changed", true)
        if ("entity" in debt.action) {
          const state = await this.read(debt.action.entity, scope)
          if (!matches(state, debt.action.goal)) throw new Failure("readback_does_not_match", true)
          await this.journal.clear(debt, scope)
          this.#uncertain = false
          return { outcome: "reported_reconciled" as const, states: [state] }
        }
        if (!confirm) throw new Failure("native_review_required", true)
        const states = await this.readback(this.config.entities, scope)
        if (states.some((state) => ["unknown", "unavailable"].includes(state.state)))
          throw new Failure("unavailable", true)
        await this.journal.clear(debt, scope)
        this.#uncertain = false
        return { outcome: "explicitly_reviewed" as const, states }
      })().finally(() => {
        this.#active = false
      }),
    )
  }
  private entity(id: string) {
    if (!this.config.entities.includes(id)) throw new Failure("entity_not_allowed")
  }
  private scope(signal?: AbortSignal, timeout = 5000) {
    if (this.#closed) throw new Failure("closed")
    return AbortSignal.any([this.#controller.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
  }
  private retain<T>(job: Promise<T>) {
    this.#jobs.add(job)
    void job.then(
      () => this.#jobs.delete(job),
      (error: unknown) => {
        this.#failures.add(error)
        this.#jobs.delete(job)
      },
    )
    return job
  }
  private async request(path: string, signal: AbortSignal, body?: object) {
    if (signal.aborted) throw new Failure("aborted_or_expired")
    const mutation = body !== undefined
    try {
      const value = await fetch(`${this.config.origin}/api/${path}`, {
        method: mutation ? "POST" : "GET",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        ...(mutation ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: "error",
      })
      return await response(value, signal, mutation)
    } catch (error) {
      throw safe(error, mutation)
    }
  }
  private async read(id: string, signal: AbortSignal): Promise<State> {
    const value = await this.request(`states/${id}`, signal)
    if (
      !record(value) ||
      value.entity_id !== id ||
      !["on", "off", "unknown", "unavailable"].includes(String(value.state)) ||
      typeof value.state !== "string" ||
      !record(value.attributes)
    )
      throw new Failure("invalid_state")
    const brightness = value.attributes.brightness ?? undefined
    if (
      brightness !== undefined &&
      (typeof brightness !== "number" || !Number.isInteger(brightness) || brightness < 0 || brightness > 255)
    )
      throw new Failure("invalid_state")
    signal.throwIfAborted()
    const modes = value.attributes.supported_color_modes
    if (
      modes !== undefined &&
      (!Array.isArray(modes) || modes.length > 32 || modes.some((mode) => typeof mode !== "string"))
    )
      throw new Failure("invalid_state")
    const color = Array.isArray(modes) && modes.some((mode) => ["rgb", "rgbw", "rgbww", "hs", "xy"].includes(mode))
    const tuple = value.attributes.rgb_color ?? undefined
    return Object.freeze({
      entity: id,
      state: value.state as State["state"],
      ...(brightness === undefined ? {} : { brightness: brightness as number }),
      color,
      ...(tuple === undefined ? {} : { rgb_color: rgb(tuple) }),
    })
  }
  state(id: string, signal?: AbortSignal) {
    this.entity(id)
    const scope = this.scope(signal)
    return this.retain(
      this.read(id, scope).then((state) => ({ ...state, outcome: "reported" as const, uncertain: this.#uncertain })),
    )
  }
  set(id: string, input: unknown, signal?: AbortSignal) {
    this.entity(id)
    const target = goal(input)
    return this.start(
      { [id]: target },
      `services/light/turn_${target.state}`,
      {
        entity_id: id,
        ...(target.brightness === undefined ? {} : { brightness: target.brightness }),
        ...(target.rgb_color === undefined ? {} : { rgb_color: target.rgb_color }),
      },
      signal,
    )
  }
  mode(name: string, action: "activate" | "stop" = "activate", signal?: AbortSignal) {
    const mode = this.config.modes.find((mode) => mode.name === name)
    if (!mode) throw new Failure("mode_not_allowed")
    if (action !== "activate" && (action !== "stop" || mode.stop !== true)) throw new Failure("mode_action_not_allowed")
    const scope = this.scope(signal, 15000)
    if (this.#active || this.#uncertain)
      throw new Failure(this.#active ? "busy" : "prior_action_uncertain", this.#uncertain)
    this.#active = true
    return this.retain(
      this.named(mode.name, mode.entity, action, scope).finally(() => {
        this.#active = false
      }),
    )
  }
  private async named(name: string, entity: string, action: "activate" | "stop", signal: AbortSignal) {
    let sent = false
    let reserved = false
    try {
      await this.existence(entity, signal)
      const domain = entity.startsWith("scene.") ? "scene" : "script"
      if (signal.aborted) throw new Failure("aborted_or_expired")
      reserved = true
      const debt = await this.journal.begin(this.config, { mode: name, action }, signal)
      sent = true
      const receipt = await this.request(`services/${domain}/turn_${action === "stop" ? "off" : "on"}`, signal, {
        entity_id: entity,
        ...(domain === "scene" ? { transition: 3 } : {}),
      })
      if (!Array.isArray(receipt)) throw new Failure("invalid_service_receipt", true)
      const states = await this.readback(this.config.entities, signal)
      if (states.some((state) => ["unknown", "unavailable"].includes(state.state)))
        throw new Failure("unavailable_after_action", true)
      if (signal.aborted) throw new Failure("aborted_or_expired", true)
      await this.journal.clear(debt, signal)
      return {
        outcome: domain === "script" && action === "activate" ? ("started" as const) : ("accepted" as const),
        states,
      }
    } catch (error) {
      if (sent || reserved) this.#uncertain = true
      throw safe(error, sent || reserved)
    }
  }
  private async readback(ids: readonly string[], signal: AbortSignal) {
    const results = await Promise.allSettled(ids.map((id) => this.read(id, signal)))
    const errors = results.flatMap((value) => (value.status === "rejected" ? [value.reason] : []))
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Home Assistant original readbacks retained")
    return results.flatMap((value) => (value.status === "fulfilled" ? [value.value] : []))
  }
  private start(goals: Readonly<Record<string, Goal>>, path: string, body: object, signal?: AbortSignal) {
    const scope = this.scope(signal, 15000)
    if (this.#active || this.#uncertain)
      throw new Failure(this.#active ? "busy" : "prior_action_uncertain", this.#uncertain)
    if (scope.aborted) throw new Failure("aborted_or_expired")
    this.#active = true
    const job = this.mutate(goals, path, body, scope).finally(() => {
      this.#active = false
    })
    return this.retain(job)
  }
  private async mutate(goals: Readonly<Record<string, Goal>>, path: string, body: object, signal: AbortSignal) {
    let sent = false
    let reserved = false
    try {
      for (const id of Object.keys(goals)) {
        const before = await this.read(id, signal)
        if (["unknown", "unavailable"].includes(before.state)) throw new Failure("unavailable")
        if (goals[id].rgb_color !== undefined && !before.color) throw new Failure("color_not_supported")
      }
      if (signal.aborted) throw new Failure("aborted_or_expired")
      const id = Object.keys(goals)[0]
      reserved = true
      const debt = await this.journal.begin(this.config, { entity: id, goal: goals[id] }, signal)
      sent = true
      const receipt = await this.request(path, signal, body)
      if (!Array.isArray(receipt)) throw new Failure("invalid_service_receipt", true)
      for (;;) {
        const states = await this.readback(Object.keys(goals), signal)
        if (states.every((state) => matches(state, goals[state.entity]))) {
          if (signal.aborted) throw new Failure("aborted_or_expired", true)
          await this.journal.clear(debt, signal)
          return { outcome: "reported" as const, states }
        }
        if (states.some((state) => ["unknown", "unavailable"].includes(state.state)))
          throw new Failure("unavailable_after_action", true)
        await wait(signal)
      }
    } catch (error) {
      if (sent || reserved) this.#uncertain = true
      throw safe(error, sent || reserved)
    }
  }
  async dispose() {
    this.#closed = true
    this.#controller.abort()
    const results = await Promise.allSettled([...this.#jobs])
    const errors = [
      ...new Set([
        ...this.#failures,
        ...results.flatMap((value) => (value.status === "rejected" ? [value.reason] : [])),
      ]),
    ]
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Home Assistant original jobs retained")
  }
}
