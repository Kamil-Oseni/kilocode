// raya_change - Milestone I encrypted BYOK provider storage
import type { SecretStorage } from "vscode"

const PREFIX = "raya.provider."

export interface ProviderSecrets {
  get(providerID: string): PromiseLike<string | undefined>
  set(providerID: string, key: string): PromiseLike<void>
  delete(providerID: string): PromiseLike<void>
}

export class ProviderSecretStore implements ProviderSecrets {
  constructor(private readonly storage: Pick<SecretStorage, "get" | "store" | "delete">) {}

  get(providerID: string) {
    return this.storage.get(`${PREFIX}${providerID}`)
  }

  set(providerID: string, key: string) {
    return this.storage.store(`${PREFIX}${providerID}`, key)
  }

  delete(providerID: string) {
    return this.storage.delete(`${PREFIX}${providerID}`)
  }
}
