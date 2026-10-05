import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { drainDatabases } from "@opencode-ai/core/kilocode/profile-database"
import { lifecycle } from "./lifecycle"
import { observation } from "./profile-retirement"

let closing: Promise<void> | undefined
let observed: ReturnType<typeof observation> | undefined

/** Successful participating-root observation only; reading never realizes an owner. */
export function receipt() {
  return observed
}

/** Retire realized runtimes and the already loaded legacy client without opening an unused profile. */
export function retire(): Promise<void> {
  return (closing ??= Promise.resolve().then(async () => {
    // Loading the module does not realize Client. Establish its lazy facade
    // registrations before the runtime registry permanently refuses registration.
    const [database] = await Promise.allSettled([import("@/storage/db")])
    await drainDatabases(() =>
      lifecycle([
        () => {
          if (database.status === "rejected") throw database.reason
        },
        () => RuntimeRegistry.drain(),
        () => {
          if (database.status === "fulfilled") database.value.close()
        },
      ]).run(),
    )
    // Other processes may legitimately retain this profile. Global exclusion is
    // a separate explicit maintenance operation, not ordinary local retirement.
    observed = observation()
  }))
}
