import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { command } from "../../src/second-brain/control/command"
import { BrainSettings } from "../../src/second-brain/settings"
import { descriptor } from "../../src/second-brain/managed/descriptor"

const native = process.platform === "win32" ? test : test.skip

native(
  "historical capture rejects an actual oversized owned epoch directory before helper execution",
  async () => {
    const produced = await command(
      process.execPath,
      [path.resolve("tests/unit/fixtures/committed-capture-producer.ts"), "--runtime"],
      { cwd: process.cwd() },
    )
    const fixture = JSON.parse(produced.stdout) as { root: string; file: string; turn: unknown }
    expect(produced.receipt).toMatchObject({ code: 0, originalJoined: true, readersJoined: true, forced: false })
    try {
      const storage = {
        get<T>(key: string) {
          return (JSON.parse(readFileSync(fixture.file, "utf8")) as Record<string, unknown>)[key] as T | undefined
        },
        async update(key: string, value: unknown) {
          const rows = JSON.parse(await readFile(fixture.file, "utf8")) as Record<string, unknown>
          if (value === undefined) delete rows[key]
          if (value !== undefined) rows[key] = value
          await writeFile(fixture.file, JSON.stringify(rows))
        },
      }
      const settings = new BrainSettings(storage, {
        async get() {
          return "synthetic"
        },
        async store() {},
        async delete() {},
      })
      const reviewed = await settings.recoverCapture(process.cwd(), fixture.turn, async () => true)
      expect(reviewed).toBeDefined()
      const cfg = descriptor(storage.get<{ managed: unknown }>("raya.secondBrain.setup")?.managed)
      const root = path.join(cfg.namespaces.memory.root, "Requests")
      for (let offset = 0; offset < 8193; offset += 64) {
        await Promise.all(
          Array.from({ length: Math.min(64, 8193 - offset) }, (_, index) =>
            mkdir(path.join(root, (offset + index).toString(16).padStart(32, "0"))),
          ),
        )
      }
      const before = await readFile(fixture.file)
      await expect(settings.reviewCapture(process.cwd(), fixture.turn)).rejects.toThrow(
        "Capture operation directory exceeds its allocation bound",
      )
      expect(await readFile(fixture.file)).toEqual(before)
    } finally {
      if (
        path.dirname(fixture.root) !== path.resolve(tmpdir()) ||
        !path.basename(fixture.root).startsWith("raya-namespace-test-")
      )
        throw new Error("Owned capture fixture cleanup required")
      await rm(fixture.root, { recursive: true })
    }
  },
  60000,
)
