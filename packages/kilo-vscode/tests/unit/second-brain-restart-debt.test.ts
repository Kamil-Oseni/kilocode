import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BrainSettings } from "../../src/second-brain/settings"
import { BrainService } from "../../src/second-brain/service"
import { release } from "../../src/second-brain/control/catalog-v2"

for (const op of ["sync", "search"] as const)
  test(`restarted service retains ${op} debt without HTTP, credential use or replay writes`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "raya-memory-restart-debt-"))
    const file = path.join(dir, "state.json")
    const calls: string[] = []
    const secrets: string[] = []
    const writes: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        calls.push(request.method + " " + new URL(request.url).pathname)
        return new Response("Unexpected restarted request", { status: 503 })
      },
    })
    const root = "C:\\Synthetic\\Restart café 日本語"
    const setup = {
      format: "raya.memory.setup",
      version: 2,
      protocol: "raya.memory.operation.v1",
      origin: `http://127.0.0.1:${server.port}`,
      root,
      source_sha256: release,
    }
    const debt = {
      format: "raya.memory.control.uncertainty",
      version: 2,
      protocol: setup.protocol,
      root,
      request: {
        op,
        id: "b".repeat(32),
        root,
        owner_epoch: "c".repeat(32),
        selected_release_sha256: "d".repeat(64),
        bodySHA: "e".repeat(64),
        source_sha256: release,
        ...(op === "sync" ? { expected: "f".repeat(64) } : {}),
      },
    }
    await writeFile(file, "{}")
    const original = new BrainSettings(
      {
        get<T>(key: string) {
          return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
        },
        async update(key, value) {
          const row = JSON.parse(await readFile(file, "utf8"))
          row[key] = value
          await writeFile(file, JSON.stringify(row))
        },
      },
      {
        async get() {
          return "synthetic-only"
        },
        async store() {},
        async delete() {},
      },
    )
    await original.save(setup, "synthetic-only")
    await original.record(debt)
    const before = await readFile(file)
    const reopened = new BrainSettings(
      {
        get<T>(key: string) {
          return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
        },
        async update(key) {
          writes.push(key)
          throw new Error("Restart must not publish or clear original debt")
        },
      },
      {
        async get(key) {
          secrets.push(key)
          throw new Error("Restart must not read credentials")
        },
        async store(key) {
          secrets.push(key)
          throw new Error("Restart must not store credentials")
        },
        async delete(key) {
          secrets.push(key)
          throw new Error("Restart must not delete credentials")
        },
      },
    )
    const service = new BrainService(reopened)
    try {
      expect(await service.status()).toMatchObject({
        configured: true,
        status: "unavailable",
        code: "control_uncertain",
        results: [],
      })
      for (const query of [undefined, "No restarted search"])
        await expect(
          service.run(query, () => {
            throw new Error("No restarted result delivery")
          }),
        ).rejects.toThrow("reconciliation")
      await expect(
        service.configure(() =>
          service.sync("f".repeat(64), new AbortController().signal, async () => {
            throw new Error("No restarted native close")
          }),
        ),
      ).rejects.toThrow("pending original settlement")
      expect(reopened.pending()).toEqual(debt)
      await service.dispose()
      expect(await readFile(file)).toEqual(before)
      expect(calls).toEqual([])
      expect(secrets).toEqual([])
      expect(writes).toEqual([])
    } finally {
      await service.dispose()
      await server.stop(true)
      const target = path.resolve(dir)
      if (
        path.dirname(target) !== path.resolve(tmpdir()) ||
        !path.basename(target).startsWith("raya-memory-restart-debt-")
      )
        throw new Error("Restart fixture cleanup escaped its owned temporary root")
      await rm(target, { recursive: true })
    }
  })
