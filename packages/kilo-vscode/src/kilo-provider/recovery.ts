import { join } from "node:path"
import { PackageVault } from "../services/package-vault"
import { Installation } from "../services/update-installation"
import { SelfHealInstallation } from "../self-heal/installation"

export function availability(input: {
  root: string
  version: string
  target: string
  binary: string
  state: { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> }
}) {
  const repair = new SelfHealInstallation(join(input.root, "self-heal-install"))
  const update = new Installation(input.state, input.root)
  return new PackageVault(join(input.root, "package-vault")).availability({
    ...input,
    installation: {
      async snapshot() {
        const [first, second] = await Promise.all([repair.snapshot(), update.snapshot()])
        const phase =
          first && ["failed", "rollback-failed"].includes(first.phase)
            ? first.phase
            : second
              ? `update:${second.phase}`
              : first?.phase
        return phase ? { phase, repair: first, update: second } : undefined
      },
    },
  })
}
