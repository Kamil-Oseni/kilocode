import { expect, test } from "bun:test"
import { query, sample, terminate } from "@/kilocode/background-process/windows-tree"

test.skipIf(process.platform !== "win32")(
  "pins native process identity and refuses a different birth before terminating its own child",
  async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
    try {
      const owner = await sample(child.pid)
      expect(owner.status).toBe("owned")
      if (!owner.birth) throw new Error("Missing exact native process birth")
      const rows = await query()
      const row = rows.find((row) => row.pid === child.pid)
      expect(row).toEqual({ pid: child.pid, parent: process.pid, birth: owner.birth })
      expect(await terminate(child.pid, (BigInt(owner.birth) + 1n).toString())).toBe("foreign")
      expect(child.exitCode).toBeNull()
      expect((await sample(child.pid)).birth).toBe(owner.birth)
      expect(await terminate(child.pid, owner.birth)).toBe("confirmed")
      await child.exited
      expect((await sample(child.pid)).status).toBe("gone")
      const reject = (err: unknown) => (err instanceof Error ? err.message : "Unknown failure")
      expect(await terminate(child.pid, "not a birth").then(() => "resolved", reject)).toBe(
        "Invalid process birth identity",
      )
      expect(await sample(0).then(() => "resolved", reject)).toBe("Invalid process identity")
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  },
  60000,
)
