import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { Schema } from "effect"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"

const fixture = path.join(import.meta.dir, "pty-cleanup-recovery.fixture.ts")
const remove = async (root: string) => {
  const resolved = path.resolve(root)
  if (
    !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(resolved).startsWith("raya-pty-cleanup-recovery-")
  )
    throw new Error("Cleanup fixture directory escaped its temporary root")
  await fs.rm(resolved, { recursive: true, force: true })
}
const Report = Schema.Struct({
  ok: Schema.Boolean,
  pid: Schema.Number,
  token: Schema.optional(Schema.String),
  database: Schema.optional(Schema.String),
  manifest: Schema.optional(Schema.String),
  journal: Schema.optional(Schema.String),
  control: Schema.optional(Schema.String),
  effects: Schema.optional(Schema.String),
  active: Schema.optional(Schema.String),
  release: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  temp: Schema.optional(Schema.String),
  identity: Schema.optional(
    Schema.Struct({ pid: Schema.Number, helper: Schema.Number, birth: Schema.String, helperBirth: Schema.String }),
  ),
})
const cases = [
  { boundary: "released", outcome: "unknown" },
  { boundary: "published", outcome: "confirmed" },
  { boundary: "prepared", outcome: "confirmed" },
  { boundary: "partial", outcome: "cancelled" },
  { boundary: "actor", outcome: "confirmed" },
  { boundary: "forgotten", outcome: "unknown" },
] as const
const run = async (
  root: string,
  workspace: string,
  session: string,
  scenario: (typeof cases)[number],
  mode: "seed" | "recover" | "unrelated",
  token?: string,
) => {
  const report = path.join(root, `${randomUUID()}.json`)
  const child = spawn(
    process.execPath,
    [fixture, JSON.stringify({ workspace, report, session, token, mode, ...scenario })],
    {
      cwd: path.join(import.meta.dir, "../.."),
      windowsHide: true,
      timeout: 90_000,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        KILO_DB: path.join(root, "private.sqlite"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
      },
    },
  )
  const errors: Buffer[] = []
  let size = 0
  child.stderr.on("data", (chunk: Buffer) => {
    size += chunk.length
    if (size <= 1_048_576) errors.push(Buffer.from(chunk))
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  if (code !== 0) {
    const diagnostic = await fs.readFile(report + ".diagnostic", "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "unavailable"
      throw err
    })
    throw new Error(
      (Buffer.concat(errors).toString("utf8") || `Cleanup backend exited ${code}`) +
        "\nSynthetic fixture metadata: " +
        diagnostic,
    )
  }
  return Schema.decodeUnknownSync(Report)(JSON.parse(await fs.readFile(report, "utf8")))
}

for (const scenario of cases) {
  test.skipIf(process.platform !== "win32")(
    `fresh SQLite backend finishes ${scenario.boundary} PTY cleanup without replaying ${scenario.outcome} work`,
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-pty-cleanup-recovery-"))
      const workspace = path.join(root, "workspace")
      await fs.mkdir(workspace)
      const session = `ses_${randomUUID().replaceAll("-", "")}`
      try {
        const first = await run(root, workspace, session, scenario, "seed")
        const { token, manifest, journal, control, effects, active, release, identity } = first
        if (!token || !manifest || !journal || !control || !effects || !active || !release || !identity)
          throw new Error("Incomplete cleanup boundary report")
        expect(first.ok).toBe(true)
        expect(first.outcome).toBe(scenario.outcome)
        expect(first.database).toBe(path.join(root, "private.sqlite"))
        expect(await Bun.file(first.database!).exists()).toBe(true)
        expect(await Bun.file(active).exists()).toBe(false)
        expect(await Bun.file(release).exists()).toBe(scenario.boundary !== "forgotten")
        expect(await Bun.file(journal).exists()).toBe(
          scenario.boundary !== "released" && scenario.boundary !== "prepared",
        )
        if (first.temp) {
          expect(await Bun.file(first.temp).exists()).toBe(true)
          const saved = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Struct({ outcome: Schema.String }) }))(
            JSON.parse(await fs.readFile(first.temp, "utf8")),
          )
          expect(saved.result.outcome).toBe(scenario.outcome)
        }
        expect(await Bun.file(manifest).exists()).toBe(
          scenario.boundary !== "actor" && scenario.boundary !== "forgotten",
        )
        if (scenario.boundary === "partial") {
          expect(await Bun.file(control + ".go").exists()).toBe(false)
          expect(await Bun.file(control + ".job").exists()).toBe(false)
          expect(await Bun.file(control + ".launch").exists()).toBe(true)
        }
        for (const pid of [identity.pid, identity.helper])
          expect(await NativeProcess.inspect(pid)).toMatchObject({ status: "gone" })
        const unrelated = await run(root, workspace, session, scenario, "unrelated", token)
        if (!unrelated.active) throw new Error("Unrelated occupancy actor is missing")
        const original = await fs.readFile(unrelated.active, "utf8")
        if (scenario.boundary === "published") {
          const link = path.join(root, "journal-hardlink")
          const saved = await fs.readFile(journal, "utf8")
          const actor = await fs.readFile(manifest, "utf8")
          await fs.link(journal, link)
          try {
            await expect(run(root, workspace, session, scenario, "recover", token)).rejects.toThrow()
            expect(await fs.readFile(journal, "utf8")).toBe(saved)
            expect(await fs.readFile(link, "utf8")).toBe(saved)
            expect(await fs.readFile(manifest, "utf8")).toBe(actor)
            expect(await Bun.file(release).exists()).toBe(true)
            expect(await fs.readFile(effects, "utf8")).toBe(session + "\n")
            expect(await fs.readFile(unrelated.active, "utf8")).toBe(original)
          } finally {
            await fs.unlink(link)
          }
        }
        const second = await run(root, workspace, session, scenario, "recover", token)
        expect(second.pid).not.toBe(first.pid)
        expect(second.pid).not.toBe(unrelated.pid)
        expect(second.ok).toBe(true)
        if (scenario.boundary !== "released" && scenario.boundary !== "prepared")
          expect(second.outcome).toBe(scenario.outcome)
        expect(await Bun.file(manifest).exists()).toBe(false)
        expect(await Bun.file(journal).exists()).toBe(false)
        if (first.temp) expect(await Bun.file(first.temp).exists()).toBe(false)
        expect(await Bun.file(active).exists()).toBe(false)
        expect(await Bun.file(release).exists()).toBe(false)
        for (const suffix of ["", ".go", ".job", ".launch", ".drained", ".running", ".exited"])
          expect(await Bun.file(control + suffix).exists()).toBe(false)
        expect(await fs.readFile(effects, "utf8")).toBe(session + "\n")
        expect(await fs.readFile(unrelated.active, "utf8")).toBe(original)
        expect((await run(root, workspace, session, scenario, "recover", token)).ok).toBe(true)
        expect(await fs.readFile(effects, "utf8")).toBe(session + "\n")
        expect(await fs.readFile(unrelated.active, "utf8")).toBe(original)
        expect((await fs.readdir(path.dirname(manifest))).filter((entry) => entry.startsWith(token))).toEqual([])
        for (const pid of [identity.pid, identity.helper])
          expect(await NativeProcess.inspect(pid)).toMatchObject({ status: "gone" })
      } finally {
        await remove(root)
      }
    },
    300_000,
  )
}
