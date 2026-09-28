import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { Schema } from "effect"

const fixture = path.join(import.meta.dir, "fixtures/terminal-recovery-process.ts")
const Report = Schema.Struct({
  ok: Schema.Boolean,
  pid: Schema.Number,
  entered: Schema.optional(Schema.Boolean),
  database: Schema.optional(Schema.String),
  manifest: Schema.optional(Schema.String),
  control: Schema.optional(Schema.String),
  effects: Schema.optional(Schema.String),
  active: Schema.optional(Schema.String),
  released: Schema.optional(Schema.String),
  drained: Schema.optional(Schema.String),
})
const run = async (
  root: string,
  workspace: string,
  session: string,
  token: string,
  mode: "seed" | "recover" | "unrelated" | "tombstone" | "admit",
  boundary: "drained" | "released",
) => {
  const report = path.join(root, `${randomUUID()}.json`)
  const started = performance.now()
  const child = spawn(
    process.execPath,
    [fixture, JSON.stringify({ workspace, report, session, token, mode, boundary })],
    {
      cwd: path.join(import.meta.dir, "../.."),
      windowsHide: true,
    timeout: 60000,
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
  child.stderr.on("data", (data) => errors.push(Buffer.from(data)))
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  if (code !== 0) throw new Error(Buffer.concat(errors).toString("utf8") || `Fixture exited ${code}`)
  const result = Schema.decodeUnknownSync(Report)(JSON.parse(await fs.readFile(report, "utf8")))
  console.info("terminal-recovery", mode, Math.round(performance.now() - started))
  return result
}

for (const boundary of ["drained", "released"] as const) {
  test.skipIf(process.platform !== "win32")(
    `fresh SQLite backend repairs terminal metadata after ${boundary} without replay`,
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-terminal-recovery-"))
      const workspace = path.join(root, "workspace")
      await fs.mkdir(workspace)
      const session = `ses_${randomUUID().replaceAll("-", "")}`
      const token = randomUUID()
      try {
        const first = await run(root, workspace, session, token, "seed", boundary)
        expect(first.ok).toBe(true)
        const { manifest, control, effects, active, released, drained } = first
        if (!manifest || !control || !effects || !active || !released || !drained)
          throw new Error("Incomplete native fixture")
        expect(first.database).toBe(path.join(root, "private.sqlite"))
        expect(await Bun.file(first.database!).exists()).toBe(true)
        expect(await Bun.file(active).exists()).toBe(boundary === "drained")
        expect(await Bun.file(released).exists()).toBe(boundary === "released")
        const content = await fs.readFile(manifest, "utf8")
        const proof = await fs.readFile(drained, "utf8")
        const raw = Schema.decodeUnknownSync(
          Schema.Struct({
            version: Schema.Number,
            token: Schema.String,
            sessionID: Schema.String,
            control: Schema.String,
            real: Schema.String,
            dev: Schema.String,
            ino: Schema.String,
            scope: Schema.Unknown,
            reservation: Schema.Unknown,
          }),
        )(JSON.parse(content))
        const refused = async (effect = effects) => {
          const result = await run(root, workspace, session, token, "recover", boundary)
          expect(result.pid).not.toBe(first.pid)
          expect(result.ok).toBe(false)
          expect(await Bun.file(manifest).exists()).toBe(true)
          expect(await fs.readFile(effect, "utf8")).toBe(token + "\n")
          expect(await Bun.file(control).exists()).toBe(false)
        }
        await fs.writeFile(drained, proof.replace(token, randomUUID()))
        await refused()
        await fs.writeFile(drained, "corrupt proof")
        await refused()
        await fs.writeFile(drained, proof)
        const { scope: _scope, reservation: _reservation, ...legacy } = raw
        await fs.writeFile(manifest, JSON.stringify({ ...legacy, version: 1 }))
        await refused()
        await fs.writeFile(manifest, content)
        await fs.rename(workspace, workspace + ".original")
        await fs.mkdir(workspace)
        await refused(path.join(workspace + ".original", "effects.txt"))
        await fs.rmdir(workspace)
        await fs.rename(workspace + ".original", workspace)
        const unrelated = await run(root, workspace, session, token, "unrelated", boundary)
        if (!unrelated.active) throw new Error("Unrelated actor was not persisted")
        const actor = await fs.readFile(unrelated.active, "utf8")
        expect((await run(root, workspace, session, token, "tombstone", boundary)).ok).toBe(true)
        expect(await run(root, workspace, session, token, "admit", boundary)).toMatchObject({ ok: false, entered: false })
        const second = await run(root, workspace, session, token, "recover", boundary)
        expect(second.pid).not.toBe(first.pid)
        expect(second.ok).toBe(true)
        expect(await Bun.file(manifest).exists()).toBe(false)
        expect(await Bun.file(active).exists()).toBe(false)
        expect(await Bun.file(released).exists()).toBe(false)
        expect(await fs.readFile(unrelated.active, "utf8")).toBe(actor)
        expect(await fs.readFile(effects, "utf8")).toBe(token + "\n")
        expect(await Bun.file(control).exists()).toBe(false)
        expect((await run(root, workspace, session, token, "recover", boundary)).ok).toBe(true)
        expect(await run(root, workspace, session, token, "admit", boundary)).toMatchObject({ ok: false, entered: false })
        expect(await fs.readFile(effects, "utf8")).toBe(token + "\n")
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
    300000,
  )
}
