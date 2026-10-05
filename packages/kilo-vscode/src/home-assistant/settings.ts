import type { Memento, SecretStorage } from "vscode"
import { parse } from "./config"

const state = "raya.homeAssistant.settings"
function reference(raw: unknown): { config: unknown; credential: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join() !== "config,credential")
    throw new Error("Home Assistant credential reference refused")
  const value = raw as { config: unknown; credential: unknown }
  if (typeof value.credential !== "string" || !/^raya\.homeAssistant\.key\.[a-f0-9-]{36}$/.test(value.credential))
    throw new Error("Home Assistant credential reference refused")
  parse(value.config)
  return { config: value.config, credential: value.credential }
}
export class Settings {
  #tail = Promise.resolve()
  constructor(
    private readonly storage: Pick<Memento, "get" | "update">,
    private readonly secrets: Pick<SecretStorage, "get" | "store" | "delete">,
  ) {}
  async load() {
    const raw = this.storage.get<unknown>(state)
    if (raw === undefined) return undefined
    const value = reference(raw)
    const config = parse(value.config)
    const token = await this.secrets.get(value.credential)
    if (!token) return undefined
    return { config, token }
  }
  save(input: unknown, token: string) {
    const config = parse(input)
    if (!token.trim() || token.length > 8192 || /[\r\n\x00-\x20\x7f]/.test(token))
      throw new Error("Invalid Home Assistant credential")
    const job = this.#tail.then(async () => {
      const raw = this.storage.get<unknown>(state)
      const prior = raw === undefined ? undefined : reference(raw)
      const credential = "raya.homeAssistant.key." + crypto.randomUUID()
      await this.secrets.store(credential, token)
      try {
        await this.storage.update(state, { config, credential })
      } catch (error) {
        await Promise.resolve()
          .then(() => this.secrets.delete(credential))
          .catch((cleanup: unknown) => {
            throw new AggregateError([error, cleanup], "Home Assistant setup and credential cleanup failed")
          })
        throw error
      }
      if (prior) await this.secrets.delete(prior.credential)
    })
    this.#tail = job.then(
      () => undefined,
      () => undefined,
    )
    return job
  }
}
