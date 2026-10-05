import { expect, test } from "bun:test"
import { createHash, createHmac } from "node:crypto"
import { mkdtemp, mkdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import z from "zod"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { serve } from "@opencode-ai/core/kilocode/source-pipe"
import { watch } from "../../src/kilocode/daemon/exit"

async function wait<T>(body: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const value = await body()
    if (value !== undefined) return value
    await Bun.sleep(25)
  }
  throw new Error("Source listener fixture deadline; private profile retained")
}

async function refused(body: Promise<unknown>) {
  const failure: unknown = await body.then(
    () => undefined,
    (err: unknown) => err,
  )
  if (!(failure instanceof Error)) throw new Error("Expected actual retirement refusal")
  return failure
}

for (const mode of ["accepted", "tampered"])
  test(`actual Serve private handoff ${mode} joins retirement without waiting for its own shutdown`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-listen-"))
    for (const dir of ["home", "state", "data", "config", "cache", "workspace"]) await mkdir(path.join(root, dir))
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
      RAYA_DB: path.join(root, "raya.db"),
      KILO_DB: path.join(root, "raya.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      RAYA_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
    })
    const digest = createHash("sha256")
      .update(await Bun.file(process.execPath).bytes())
      .digest("hex")
    const session = await launch({
      executable: process.execPath,
      digest,
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      roots: [{ kind: "json", path: root }],
      policy: { version: 1, directories: [root], files: [] },
      args: [
        "run",
        "--conditions=browser",
        path.resolve(import.meta.dir, "../../src/index.ts"),
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
      ],
      timeout: 60_000,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    session.child.stdout?.on("data", (data: Buffer) => stdout.push(data))
    session.child.stderr?.on("data", (data: Buffer) => stderr.push(data))
    const source = await watch(session.ticket.header.pid, session.ticket.header.birth, 60_000)
    const secret = `private-fixture-${crypto.randomUUID()}`
    const pipe = await serve(secret, session.ticket.image, 60_000)
    let controller: Awaited<ReturnType<typeof watch>> | undefined
    try {
      if (mode === "tampered") {
        const id = crypto.randomUUID()
        await session.handoff({ id, pipe: pipe.descriptor })
        const file = `${session.ticket.control}.source-handoff`
        const value = JSON.parse(await readFile(file, "utf8"))
        value.signature = "0".repeat(64)
        await Bun.write(file, JSON.stringify(value))
        await session.start()
        expect((await source.done).code).toBe(1)
        expect(await refused(session.retired())).toBeInstanceOf(Error)
        expect((await session.exit).code).toBe(1)
        expect(await Bun.file(`${session.ticket.control}.source-handoff-ready`).exists()).toBe(false)
        expect(await Bun.file(`${session.ticket.control}.source-broker-launched`).exists()).toBe(false)
        expect(Buffer.concat(stderr).toString()).toContain("Serve shutdown or handoff listener close failed")
        expect(Buffer.concat(stdout).toString() + Buffer.concat(stderr).toString()).not.toContain(secret)
        for (const pid of [session.ticket.header.pid, session.ticket.header.helper])
          expect(() => process.kill(pid, 0)).toThrow()
        expect((await refused(pipe.close())).message).toContain("Private pipe server refused")
        await Bun.write(
          path.join(root, "receipt.json"),
          JSON.stringify({ id, mode, source: session.ticket.header.pid, sourceExit: 1, encryptedCapture: false }),
        )
        return
      }
      await session.start()
      const url = await wait(
        async () =>
          Buffer.concat(stdout)
            .toString()
            .match(/kilo server listening on (http:\/\/[^\s]+)/)?.[1],
      )
      const response = await fetch(`${url}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-kilo-directory": path.join(root, "workspace") },
        body: JSON.stringify({ title: "handoff-durable-session" }),
      })
      expect(response.ok).toBe(true)
      const created = z.object({ id: z.string().min(1) }).parse(await response.json())
      expect(created.id.length).toBeGreaterThan(0)
      const id = crypto.randomUUID()
      await session.handoff({ id, pipe: pipe.descriptor })
      await session.successor(id)
      const ready = await wait(async () => {
        const file = `${session.ticket.control}.source-handoff-ready`
        return (await Bun.file(file).exists()) ? JSON.parse(await readFile(file, "utf8")) : undefined
      })
      expect(ready.value.id).toBe(id)
      expect(ready.value.source.pid).toBe(session.ticket.header.pid)
      expect(ready.signature).toBe(
        createHmac("sha256", session.ticket.token).update(JSON.stringify(ready.value)).digest("hex"),
      )
      const ticket = ready.value.successor
      controller = await watch(ticket.controller, ticket.birth, 60_000)
      expect((await source.done).code).toBe(0)
      const family = await session.retired()
      expect(family.familyZeroObserved).toBe(true)
      const result = await wait(async () => {
        const file = path.join(ticket.control, "result.json")
        return (await Bun.file(file).exists()) ? JSON.parse(await readFile(file, "utf8")) : undefined
      })
      expect((await controller.done).code).toBe(0)
      expect((await session.exit).code).toBe(0)
      expect(result).toMatchObject({
        version: 3,
        id,
        status: "observed",
        completeProfileCoverage: false,
        portableCaptureAuthorized: false,
      })
      expect(
        result.roots.roots.some(
          (item: { kind: string; path: string }) =>
            item.kind === "sqlite" && item.path.toLowerCase() === path.join(root, "raya.db").toLowerCase(),
        ),
      ).toBe(true)
      const database = new Database(path.join(root, "raya.db"), { readonly: true })
      expect(database.query("SELECT id,title FROM session WHERE id=?").get(created.id)).toEqual({
        id: created.id,
        title: "handoff-durable-session",
      })
      database.close()
      for (const file of [
        path.join(ticket.control, "request.json"),
        path.join(ticket.control, "ack.json"),
        `${session.ticket.control}.source-handoff`,
      ])
        expect(await Bun.file(file).text()).not.toContain(secret)
      expect(Buffer.concat(stdout).toString() + Buffer.concat(stderr).toString()).not.toContain(secret)
      for (const pid of [session.ticket.header.pid, session.ticket.header.helper, ticket.controller])
        expect(() => process.kill(pid, 0)).toThrow()
      // This observation-only successor does not consume a passphrase or seal an archive.
      expect((await refused(pipe.close())).message).toContain("Private pipe server refused")
      await Bun.write(
        path.join(root, "receipt.json"),
        JSON.stringify({
          id,
          result,
          family,
          source: session.ticket.header.pid,
          controller: ticket.controller,
          encryptedCapture: false,
        }),
      )
    } finally {
      await Bun.write(path.join(root, "stdout.log"), Buffer.concat(stdout))
      await Bun.write(path.join(root, "stderr.log"), Buffer.concat(stderr))
      await Promise.allSettled([source.close(), controller?.close(), pipe.close()])
    }
  }, 180_000)
