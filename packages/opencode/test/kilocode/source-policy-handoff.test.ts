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
  throw new Error(`Policy fixture deadline; retained ${file}`)
}

for (const mode of ["policy", "policy-escape", "policy-foreign"])
  test(`producer policy ${mode} binds historical expansion and a live callback token`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-policy-"))
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
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      RAYA_DB: path.join(root, "unused.db"),
      KILO_DB: path.join(root, "unused.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
    })
    const digest = createHash("sha256")
      .update(await Bun.file(process.execPath).bytes())
      .digest("hex")
    const foreign =
      mode === "policy-foreign"
        ? Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/source-policy-foreign.ts"), root], {
            env,
            stdout: "ignore",
            stderr: Bun.file(path.join(root, "foreign.log")),
            windowsHide: true,
          })
        : undefined
    if (foreign) await wait(path.join(root, "foreign-ready.json"))
    const session = await launch({
      executable: process.execPath,
      digest,
      cwd: root,
      env,
      roots: [{ kind: "json", path: root }],
      policy: { version: 1, directories: [root], files: [] },
      args: [path.join(import.meta.dir, "fixtures/source-family-root.ts"), root, mode],
      timeout: 60_000,
    })
    session.child.stdout?.resume()
    session.child.stderr?.on("data", (data) => process.stderr.write(data))
    const source = await watch(session.ticket.header.pid, session.ticket.header.birth, 60_000)
    let controller: Awaited<ReturnType<typeof watch>> | undefined
    let control: string | undefined
    try {
      await session.start()
      const ticket = await wait(path.join(root, "prepared.json"))
      control = ticket.control
      controller = await watch(ticket.controller, ticket.birth, 60_000)
      const child = await wait(path.join(root, "child-ready.json"))
      await wait(path.join(root, "held-source.json"))
      await Bun.write(path.join(root, "release-source"), "release")
      expect((await source.done).code).toBe(0)
      expect(await Bun.file(path.join(control!, "callback.json")).exists()).toBe(false)
      expect(() => process.kill(child.pid, 0)).not.toThrow()
      await Bun.write(path.join(root, "release-child"), "release")
      if (mode !== "policy-escape") {
        const callback = await wait(path.join(control!, "callback.json"))
        expect(callback.live).toBe(true)
        if (foreign) {
          expect(callback.members).not.toContain(foreign.pid)
          expect(() => process.kill(foreign.pid, 0)).not.toThrow()
        }
        expect(callback.seed).toHaveLength(1)
        expect(callback.roots.length).toBeGreaterThan(callback.seed.length)
        expect(
          callback.roots.some(
            (item: { kind: string; path: string }) =>
              item.kind === "sqlite" && item.path.toLowerCase() === path.join(root, "source.db").toLowerCase(),
          ),
        ).toBe(true)
        expect(await Bun.file(path.join(control!, "result.json")).exists()).toBe(false)
        await Bun.write(path.join(control!, "release-callback"), "release")
      }
      const result = await wait(path.join(control!, "result.json"))
      expect((await controller.done).code).toBe(mode === "policy" ? 0 : 1)
      expect((await session.exit).code).toBe(0)
      expect(result.version).toBe(3)
      expect(result.status).toBe(mode === "policy" ? "observed" : "refused")
      expect(result.completeProfileCoverage).toBe(false)
      expect(result.portableCaptureAuthorized).toBe(false)
      expect(await wait(path.join(control!, "expired.json"))).toEqual({ expired: true })
      if (mode === "policy") expect(result.admission.roots).toHaveLength(12)
      if (mode === "policy-escape") {
        expect(result.reason).toBe("Source handoff failed")
        expect(result.failure.format).toBe("raya.source-failure")
        expect(result.failure.truncated).toBe(false)
        expect(JSON.stringify(result.failure)).not.toContain(root)
        expect(result.admission).toBeUndefined()
        expect(await Bun.file(path.join(control!, "callback.json")).exists()).toBe(false)
        const db = new Database(path.join(path.dirname(root), `${path.basename(root)}-external.db`), { readonly: true })
        try {
          expect(db.query("SELECT value FROM durable").all()).toEqual([{ value: "source-final" }])
        } finally {
          db.close()
        }
      }
      if (foreign) {
        expect(result.admission).toBeUndefined()
        expect(result.reason).toBe("Source handoff failed")
        expect(result.failure.format).toBe("raya.source-failure")
        expect(result.failure.truncated).toBe(false)
        expect(JSON.stringify(result.failure)).not.toContain(root)
        expect(() => process.kill(foreign.pid, 0)).not.toThrow()
        await Bun.write(path.join(root, "release-foreign"), "release")
        expect(await foreign.exited).toBe(0)
        expect(() => process.kill(foreign.pid, 0)).toThrow()
      }
      for (const pid of [session.ticket.header.pid, session.ticket.header.helper, child.pid, ticket.controller])
        expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await Bun.write(path.join(root, "release-source"), "release")
      await Bun.write(path.join(root, "release-child"), "release")
      await Bun.write(path.join(root, "release-foreign"), "release")
      if (control) await Bun.write(path.join(control, "release-callback"), "release")
      await source.close()
      await controller?.close()
      await session.exit
      await foreign?.exited
    }
  }, 120_000)
