import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { launch } from "../../src/kilocode/source-launch"

const digest = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex")

for (const enabled of [true, false]) {
  test(`original repeated children publish bounded diagnostic only when enabled=${enabled}`, async () => {
    const helper = process.env.RAYA_MEMBER_DIAGNOSTIC_HELPER
    if (process.platform !== "win32" || !helper) throw new Error("Reviewed Windows diagnostic helper required")
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-member-diagnostic-"))
    const profile = path.join(root, "profile")
    await mkdir(profile)
    const file = path.join(root, "source.ts")
    await Bun.write(
      file,
      `
if (process.argv[2] === "child") {
  await Bun.sleep(150)
} else {
  for (let index = 0; index < 12; index++) {
    const child = Bun.spawn([process.execPath, import.meta.path, "child"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true })
    if (await child.exited !== 0) throw new Error("Controlled original child failed")
  }
}
`,
    )
    const app = await launch({
      executable: process.execPath,
      digest: await digest(process.execPath),
      helper: { executable: helper, digest: await digest(helper) },
      cwd: root,
      args: [file],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
        ),
        RAYA_SOURCE_MEMBER_DIAGNOSTICS: enabled ? "1" : "0",
      },
      roots: [{ kind: "json", path: profile }],
      policy: { version: 1, directories: [root], files: [] },
    })
    app.child.stdout?.resume()
    app.child.stderr?.resume()
    await app.start()
    const closed = await Promise.all([app.sourceExit, app.exit])
    expect(closed.every((row) => row.code === 0)).toBe(true)
    const family = await Bun.file(app.ticket.control + ".source-family-retired").json()
    expect(family.success).toBe(true)
    expect(family.forced).toBe(false)
    expect(family.memberObservationsOverflow).toBe(false)
    expect(family.totalProcesses).toBe(25)
    expect(family.memberObservationsComplete).toBe(true)
    expect(family.rootExit).toBe(0)
    expect(family.members).toHaveLength(25)
    expect(new Set(family.members.map((row: { pid: number }) => row.pid)).size).toBe(25)
    expect(family.members.every((row: { code: number }) => row.code === 0)).toBe(true)
    const diagnostic = Bun.file(app.ticket.control + ".source-members-diagnostic")
    expect(await diagnostic.exists()).toBe(enabled)
    if (enabled) {
      const data = await diagnostic.json()
      const image = path.basename(process.execPath).toLowerCase()
      const order = (a: (string | number)[], b: (string | number)[]) => String(a).localeCompare(String(b))
      expect(data.diagnosticOnly).toBe(true)
      expect(data.retirementAuthority).toBe(false)
      expect(data.failed).toBe(false)
      expect(data.dropped).toBe(0)
      expect(data.observations).toBe(25)
      expect(data.unavailable).toBe(1)
      expect(data.groups.length).toBeLessThanOrEqual(128)
      expect(
        data.groups
          .map((row: { image: string; parentImage: string; observations: number }) => [
            row.image,
            row.parentImage,
            row.observations,
          ])
          .sort(order),
      ).toEqual(
        [
          [image, image, 12],
          [image, "unknown", 1],
          ["conhost.exe", image, 12],
        ].sort(order),
      )
      expect(
        data.groups.every(
          (row: { image: string; parentImage: string }) =>
            /^[a-z0-9._-]+$/.test(row.image) && /^[a-z0-9._-]+$/.test(row.parentImage),
        ),
      ).toBe(true)
      expect((await diagnostic.text()).includes(root)).toBe(false)
      expect(diagnostic.size).toBeLessThan(65536)
    }
    await rm(root, { recursive: true, force: true })
  }, 30000)
}
