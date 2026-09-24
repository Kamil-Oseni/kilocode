import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"
import type { DesktopRequest } from "@kilocode/sdk/v2/client"
import { createComputerUseLease } from "../../src/services/computer-use/lease-bootstrap"
import type { LeaseStorage, SensitivePolicy } from "../../src/services/computer-use/lease-store"

const policy: SensitivePolicy = {
  communications: "ask",
  financial: "ask",
  credentials: "ask",
  software: "ask",
  system: "ask",
  deletion: "ask",
  disclosure: "ask",
  legal: "ask",
  publishing: "ask",
}

const request = {
  id: "authorize_test",
  sessionID: "session_test",
  operation: "authorize",
  surface: "desktop",
  action: "pointer",
  windowID: "window_test",
  sensitive: false,
} satisfies Extract<DesktopRequest, { operation: "authorize" }>

describe("Computer Use lease bootstrap", () => {
  it("keeps desktop input unavailable when a corrupt revocation record hides saved stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raya-bootstrap-"))
    try {
      let value: unknown
      const storage: LeaseStorage = {
        get: <T>() => value as T | undefined,
        update: async (_key, next) => {
          value = structuredClone(next)
        },
      }
      const first = createComputerUseLease(storage, dir)
      expect(first.error).toBeUndefined()
      await first.lease.grant({
        sessionID: "session_test",
        level: "autonomous",
        duration: "until_stopped",
        applications: "all",
        actions: ["pointer"],
        sensitive: policy,
        cooperativeInput: false,
      })
      expect(first.lease.authorize(request).decision).toBe("allow")
      writeFileSync(join(dir, "revocations.json"), "{")
      const recovered = createComputerUseLease(storage, dir)
      expect(recovered.error).toBeDefined()
      expect(recovered.lease.current()).toBeUndefined()
      expect(recovered.lease.authorize(request).decision).toBe("deny")
      await expect(
        recovered.lease.grant({
          sessionID: "session_test",
          level: "autonomous",
          duration: "session",
          applications: "all",
          actions: ["pointer"],
          sensitive: policy,
          cooperativeInput: false,
        }),
      ).rejects.toThrow(/unavailable/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
