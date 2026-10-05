import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import z from "zod"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { exportSource } from "@opencode-ai/core/kilocode/source-export"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { unseal } from "../../src/kilocode/migration/profile-bundle"

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test.skipIf(process.platform !== "win32")(
  "actual Source joins accepted memory write before encrypted capture",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-memory-source-drain-"))
    for (const dir of ["home/local", "state", "data/kilo/storage", "config/kilo", "cache", "workspace"])
      await mkdir(path.join(root, dir), { recursive: true })
    await writeFile(
      path.join(root, "config/kilo/kilo.json"),
      JSON.stringify({
        $schema: "https://app.kilo.ai/config.json",
        enabled_providers: [],
        permission: "deny",
        formatter: false,
        lsp: false,
      }),
    )
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !/^(RAYA|KILO|OPENCODE|OTEL)_/.test(entry[0]) &&
          !/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(entry[0]),
      ),
    )
    const database = path.join(root, "data/kilo/raya.db")
    Object.assign(env, {
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      LOCALAPPDATA: path.join(root, "home/local"),
      KILO_TEST_HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      RAYA_DB: database,
      KILO_DB: database,
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      KILO_DISABLE_MODELS_FETCH: "1",
      RAYA_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_DEFAULT_PLUGINS: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
    })
    const executable = path.join(root, "raya-process-host.exe")
    const helper =
      process.env.RAYA_MEMORY_SOURCE_HELPER ??
      path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe")
    await copyFile(helper, executable)
    const session = await launch({
      executable: process.execPath,
      digest: hash(await readFile(process.execPath)),
      helper: { executable, digest: hash(await readFile(executable)) },
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      roots: [{ kind: "json", path: path.join(root, "data/kilo") }],
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
      timeout: 60000,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    session.child.stdout?.on("data", (bytes: Buffer) => stdout.push(bytes))
    session.child.stderr?.on("data", (bytes: Buffer) => stderr.push(bytes))
    const password = `private-memory-${randomUUID()}`
    const output = path.join(os.tmpdir(), `raya-memory-drained-${randomUUID()}.raya`)
    const evidence: { stage: string; [key: string]: unknown }[] = []
    const work: Promise<unknown>[] = []
    let forced = false
    try {
      await session.start()
      const deadline = Date.now() + 60000
      let url: string | undefined
      while (
        !(url = Buffer.concat(stdout)
          .toString()
          .match(/kilo server listening on (http:\/\/[^\s]+)/)?.[1])
      ) {
        assert(Date.now() < deadline, "Memory Source startup deadline")
        await Bun.sleep(25)
      }
      const directory = path.join(root, "workspace")
      const headers = { "content-type": "application/json", "x-kilo-directory": directory }
      expect(
        (await fetch(`${url}/session`, { method: "POST", headers, body: JSON.stringify({ title: "memory-no-model" }) }))
          .status,
      ).toBe(200)
      const namespace = MemoryPaths.root({
        ctx: { directory, worktree: directory },
        data: path.join(root, "data/kilo"),
      })
      const status = await fetch(`${url}/memory/status`, { headers })
      expect(status.status).toBe(200)
      expect(
        z
          .object({ root: z.string() })
          .parse(await status.json())
          .root.toLowerCase(),
      ).toBe(namespace.toLowerCase())
      const files = MemoryPaths.files(namespace)
      const released = Promise.withResolvers<void>()
      const ready = Promise.withResolvers<void>()
      const gate = coordinateNativeRoots([{ kind: "json", path: files.index }], async () => {
        ready.resolve()
        await released.promise
      })
      const held = gate.then(
        () => ({ ok: true }),
        (err) => ({ err }),
      )
      work.push(held)
      await Promise.race([
        ready.promise,
        held.then((result) => {
          if ("err" in result) throw result.err
          throw new Error("Memory maintenance gate ended before admission")
        }),
      ])
      const state = { saved: false, captured: false }
      const saving = fetch(`${url}/memory/enable`, { method: "POST", headers }).then(async (response) => {
        const value = await response.json()
        state.saved = true
        return { status: response.status, value }
      })
      const saved = saving.then(
        (value) => ({ value }),
        (err) => ({ err }),
      )
      work.push(saved)
      try {
        const limit = Date.now() + 15000
        while (
          !(await readFile(files.state, "utf8").then(
            (text) => JSON.parse(text).enabled === true,
            (err) => {
              if (err.code === "ENOENT") return false
              throw err
            },
          ))
        ) {
          assert(Date.now() < limit, "Accepted memory state publication deadline")
          await Bun.sleep(10)
        }
        expect(state.saved).toBe(false)
        const exporting = exportSource(session, {
          profile: { database, data: path.join(root, "data/kilo"), storage: path.join(root, "data/kilo/storage") },
          password,
          output,
        })
        const captured = exporting.then(
          (value) => {
            state.captured = true
            return { value }
          },
          (err) => ({ err }),
        )
        work.push(captured)
        await Bun.sleep(150)
        expect(state.saved).toBe(false)
        expect(state.captured).toBe(false)
        expect(session.child.exitCode).toBeNull()
        evidence.push({
          stage: "accepted-write-crosses-source",
          saved: state.saved,
          captured: state.captured,
          target: files.index,
        })
        released.resolve()
        const admission = await held
        if ("err" in admission) throw admission.err
        const written = await saved
        if ("err" in written) throw written.err
        expect(written.value.status).toBe(200)
        const result = await captured
        if ("err" in result) throw result.err
        const source = (await session.sourceExit).code
        const guardian = (await session.exit).code
        const ready = z
          .object({ value: z.object({ successor: z.object({ control: z.string() }) }) })
          .parse(JSON.parse(await readFile(`${session.ticket.control}.source-handoff-ready`, "utf8")))
        const receiver = z
          .object({ status: z.string(), failure: z.unknown().optional() })
          .parse(JSON.parse(await readFile(path.join(ready.value.successor.control, "result.json"), "utf8")))
        evidence.push({
          stage: "actual-source-outcome",
          exportStatus: result.value.result.status,
          native: result.value.code,
          source,
          guardian,
          status: receiver.status,
          failure: receiver.failure,
          familyZero: result.value.family.familyZeroObserved,
        })
        expect(result.value.result.status, root).toBe("exported")
        expect(result.value.code).toBe(0)
        expect(source).toBe(0)
        expect(guardian).toBe(0)
        expect(result.value.family.familyZeroObserved).toBe(true)
        expect(receiver.status).toBe("observed")
        expect(receiver.failure).toBeUndefined()
        const ack = z
          .object({
            value: z.object({ roots: z.object({ roots: z.array(z.object({ kind: z.string(), path: z.string() })) }) }),
          })
          .parse(JSON.parse(await readFile(path.join(ready.value.successor.control, "ack.json"), "utf8")))
        expect(
          ack.value.roots.roots.some(
            (item) => item.kind === "json" && item.path.toLowerCase() === namespace.toLowerCase(),
          ),
        ).toBe(true)
        const bundle = await unseal(await readFile(output, "utf8"), password)
        const memory = bundle.memory.find((item) => item.workspace.toLowerCase() === directory.toLowerCase())
        expect(memory).toBeDefined()
        expect(JSON.parse(memory!.state).enabled).toBe(true)
        expect(
          bundle.disposition?.files.some(
            (item) =>
              item.path.toLowerCase() === files.state.toLowerCase() && item.disposition.kind === "memory-semantic",
          ),
        ).toBe(true)
        evidence.push({
          stage: "encrypted-memory-after-drain",
          source: 0,
          guardian: 0,
          receiver: result.value.code,
          status: receiver.status,
          familyZero: true,
          archiveSHA: hash(await readFile(output)),
          memory: !!memory,
        })
      } finally {
        released.resolve()
      }
    } finally {
      if (session.child.exitCode === null) {
        forced = true
        await session.abort()
      }
      await Promise.allSettled(work)
      await Promise.all([
        writeFile(path.join(root, "stdout.log"), Buffer.concat(stdout).toString().replaceAll(password, "[redacted]")),
        writeFile(path.join(root, "stderr.log"), Buffer.concat(stderr).toString().replaceAll(password, "[redacted]")),
        writeFile(
          path.join(root, "receipt.json"),
          JSON.stringify({
            root,
            sourceQualified: true,
            helperSHA: hash(await readFile(executable)),
            forced,
            output,
            evidence,
            fullProfileCapture: false,
          }),
        ),
      ])
      expect(forced, root).toBe(false)
    }
  },
  120000,
)
