import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { watch } from "../../src/kilocode/daemon/exit"

async function wait(file: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return JSON.parse(await readFile(file, "utf8"))
    await Bun.sleep(25)
  }
  throw new Error(`Family fixture deadline; retained ${file}`)
}

for (const mode of ["success", "failed-child", "failed-finalizer"])
  test(`contained source handoff ${mode} joins an actual detached native descendant before gates`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-family-"))
    for (const dir of ["home", "state", "data", "config", "cache"]) await mkdir(path.join(root, dir))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !/^(RAYA|KILO|OPENCODE|OTEL)_/.test(entry[0]) &&
          !/(TOKEN|SECRET|API_KEY)$/.test(entry[0]),
      ),
    )
    Object.assign(env, {
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      KILO_TEST_HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      RAYA_DB: path.join(root, "unused.db"),
      KILO_DB: path.join(root, "unused.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
    })
    const dirs = [
      "data/kilo",
      "config/kilo",
      "cache/kilo",
      "state/kilo",
      "state",
      "cache/kilo/bin",
      "data/kilo/log",
      "data/kilo/repos",
      "home/.kilocode",
      "home/.config/kilo",
    ]
    const roots = [
      ...dirs.map((dir) => ({ kind: "json" as const, path: path.join(root, dir) })),
      ...["source.db", "descendant.db"].map((file) => ({ kind: "sqlite" as const, path: path.join(root, file) })),
    ].sort((left, right) => {
      const first = `${left.kind}:${left.path.toLowerCase()}`
      const second = `${right.kind}:${right.path.toLowerCase()}`
      return first < second ? -1 : first > second ? 1 : 0
    })
    const digest = createHash("sha256")
      .update(await Bun.file(process.execPath).bytes())
      .digest("hex")
    const session = await launch({
      executable: process.execPath,
      digest,
      cwd: root,
      env,
      roots,
      args: [path.join(import.meta.dir, "fixtures/source-family-root.ts"), root, mode],
      timeout: 60_000,
    })
    session.child.stdout?.resume()
    session.child.stderr?.on("data", (data) => {
      process.stderr.write(data)
    })
    expect(await Bun.file(path.join(root, "source.db")).exists()).toBe(false)
    const source = await watch(session.ticket.header.pid, session.ticket.header.birth, 60_000)
    let controller: Awaited<ReturnType<typeof watch>> | undefined
    try {
      await session.start()
      const ticket = await wait(path.join(root, "prepared.json"))
      controller = await watch(ticket.controller, ticket.birth, 60_000)
      const child = await wait(path.join(root, "child-ready.json"))
      await wait(path.join(root, "held-source.json"))
      expect(await Bun.file(path.join(ticket.control, "result.json")).exists()).toBe(false)
      await Bun.write(path.join(root, "release-source"), "release")
      expect(await source.done).toMatchObject({ code: mode === "failed-finalizer" ? 1 : 0 })
      expect(() => process.kill(child.pid, 0)).not.toThrow()
      expect(await Bun.file(path.join(ticket.control, "ack.json")).exists()).toBe(true)
      if (mode !== "failed-finalizer")
        expect(await Bun.file(path.join(ticket.control, "result.json")).exists()).toBe(false)
      await Bun.write(path.join(root, "release-child"), "release")
      const result = await wait(path.join(ticket.control, "result.json"))
      expect((await controller.done).code).toBe(mode === "failed-finalizer" ? 1 : 0)
      expect((await session.exit).code).toBe(mode === "failed-finalizer" ? 1 : 0)
      expect(result.status).toBe(mode === "failed-finalizer" ? "refused" : "observed")
      expect(result.completeProfileCoverage).toBe(false)
      expect(result.portableCaptureAuthorized).toBe(false)
      expect(result.version).toBe(2)
      if (mode !== "failed-finalizer") {
        expect(result.family.familyZeroObserved).toBe(true)
        expect(typeof result.family.memberObservationsComplete).toBe("boolean")
        expect(result.family.totalProcesses).toBeGreaterThanOrEqual(2)
        expect(result.family.members.find((member: { pid: number }) => member.pid === child.pid)?.code).toBe(
          mode === "failed-child" ? 1 : 0,
        )
        expect(result.admission.roots).toHaveLength(roots.length)
      }
      if (mode === "failed-finalizer") {
        expect(result.admission).toBeUndefined()
        expect((await wait(path.join(root, "cleanup-failure.json"))).error).toContain("Actual source finalizer failed")
      }
      for (const [file, value] of [
        ["source.db", "source-final"],
        ["descendant.db", "child-final"],
      ]) {
        const db = new Database(path.join(root, file), { readonly: true })
        try {
          expect(db.query("SELECT value FROM durable ORDER BY rowid DESC LIMIT 1").get()).toEqual({ value })
        } finally {
          db.close()
        }
      }
      for (const pid of [session.ticket.header.pid, session.ticket.header.helper, child.pid, ticket.controller])
        expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await Bun.write(path.join(root, "release-source"), "release")
      await Bun.write(path.join(root, "release-child"), "release")
      await source.close()
      await controller?.close()
      await session.exit
    }
  }, 120_000)
