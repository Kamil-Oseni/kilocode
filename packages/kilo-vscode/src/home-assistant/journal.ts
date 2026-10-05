import type { Memento } from "vscode"
import { createHash } from "node:crypto"
import { selection, goal, record, type Goal } from "./policy"
import { type Config } from "./config"

type Action = Readonly<{ entity: string; goal: Goal }> | Readonly<{ mode: string; action: "activate" | "stop" }>
type Debt = Readonly<{ version: 1; id: string; fingerprint: string; config: Config; action: Action }>
const key = "raya.homeAssistant.action"
export function fingerprint(config: Config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex")
}
function parse(value: unknown): Debt {
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== "action,config,fingerprint,id,version" ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.fingerprint !== "string"
  )
    throw new Error("Home Assistant action journal refused")
  const config = selection(value.config)
  if (fingerprint(config) !== value.fingerprint || !record(value.action))
    throw new Error("Home Assistant action journal refused")
  const action = value.action
  if (
    Object.keys(action).sort().join() === "entity,goal" &&
    typeof action.entity === "string" &&
    config.entities.includes(action.entity)
  )
    return Object.freeze({
      version: 1,
      id: value.id,
      fingerprint: value.fingerprint,
      config,
      action: Object.freeze({ entity: action.entity, goal: goal(action.goal) }),
    })
  if (
    Object.keys(action).sort().join() === "action,mode" &&
    typeof action.mode === "string" &&
    (action.action === "activate" || action.action === "stop") &&
    config.modes.some((mode) => mode.name === action.mode && (action.action === "activate" || mode.stop === true))
  )
    return Object.freeze({
      version: 1,
      id: value.id,
      fingerprint: value.fingerprint,
      config,
      action: Object.freeze({ mode: action.mode, action: action.action }),
    })
  throw new Error("Home Assistant action journal refused")
}
export class Journal {
  constructor(private readonly storage: Pick<Memento, "get" | "update">) {}
  pending() {
    const value = this.storage.get<unknown>(key)
    return value === undefined ? undefined : parse(value)
  }
  async begin(config: Config, action: Action, signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.pending()) throw new Error("Home Assistant prior action remains uncertain")
    const debt = parse({ version: 1, id: crypto.randomUUID(), fingerprint: fingerprint(config), config, action })
    await this.storage.update(key, debt)
    signal.throwIfAborted()
    return debt
  }
  async clear(debt: Debt, signal: AbortSignal) {
    signal.throwIfAborted()
    if (JSON.stringify(this.pending()) !== JSON.stringify(debt))
      throw new Error("Home Assistant action journal changed")
    try {
      await this.storage.update(key, undefined)
      signal.throwIfAborted()
    } catch (error) {
      await Promise.resolve()
        .then(() => this.storage.update(key, debt))
        .catch((cleanup) => {
          throw new AggregateError([error, cleanup], "Home Assistant original action debt restoration failed")
        })
      throw error
    }
  }
}
