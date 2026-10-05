import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { launch } from "../../src/kilocode/source-launch"
import { serve } from "../../src/kilocode/source-pipe"

for (const mode of ["default", "export", "tampered"] as const)
  test.skipIf(process.platform !== "win32")(
    `native source authenticates ${mode} export purpose without dispatching capture`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-purpose-"))
      const profile = path.join(root, "profile")
      await mkdir(profile)
      const module = path.resolve(import.meta.dir, "../../src/kilocode/source-launch.ts")
      const source = path.join(root, "source.ts")
      await Bun.write(
        source,
        `import {context,readHandoff} from ${JSON.stringify(module)}; const ticket=await context(); if(!ticket)throw new Error("Missing native root"); const value=await readHandoff(ticket); if(!value)throw new Error("Missing handoff"); await Bun.write(${JSON.stringify(path.join(root, "accepted.json"))},JSON.stringify(value));`,
      )
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            !/^(RAYA|KILO|OPENCODE|OTEL)_/.test(entry[0]) &&
            !/(TOKEN|SECRET|API_KEY)$/.test(entry[0]),
        ),
      )
      Object.assign(env, {
        HOME: root,
        USERPROFILE: root,
        KILO_TEST_HOME: root,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        RAYA_DB: path.join(root, "private.db"),
        KILO_DB: path.join(root, "private.db"),
        RAYA_AUTH_CONTENT: "{}",
        KILO_AUTH_CONTENT: "{}",
      })
      const session = await launch({
        executable: process.execPath,
        digest: createHash("sha256")
          .update(await readFile(process.execPath))
          .digest("hex"),
        cwd: root,
        args: [source],
        env,
        roots: [{ kind: "json", path: profile }],
        policy: { version: 1, directories: [profile], files: [] },
      })
      const output = Promise.all(
        [session.child.stdout, session.child.stderr].map(async (stream) => {
          if (!stream) throw new Error("Native fixture output required")
          const chunks: Buffer[] = []
          for await (const value of stream) {
            if (!Buffer.isBuffer(value)) throw new Error("Native fixture output type differs")
            chunks.push(value)
          }
          return Buffer.concat(chunks).toString()
        }),
      )
      const pipe = await serve("private-purpose-fixture", session.ticket.image)
      const errors: unknown[] = []
      let refused = false
      try {
        const id = randomUUID()
        await session.handoff({
          id,
          pipe: pipe.descriptor,
          ...(mode === "export" ? { purpose: "export" as const } : {}),
        })
        await assert.rejects(
          session.handoff({ id, pipe: pipe.descriptor, ...(mode !== "export" ? { purpose: "export" as const } : {}) }),
          /changed after acceptance/,
        )
        const file = `${session.ticket.control}.source-handoff`
        const envelope = await Bun.file(file).json()
        expect(Object.hasOwn(envelope.request, "purpose")).toBe(mode === "export")
        if (mode === "tampered") {
          envelope.request.purpose = "export"
          await Bun.write(file, JSON.stringify(envelope))
        }
        await session.start()
        expect((await session.sourceExit).code).toBe(mode === "tampered" ? 1 : 0)
        expect((await session.exit).code).toBe(mode === "tampered" ? 1 : 0)
        if (mode === "tampered") expect(await Bun.file(path.join(root, "accepted.json")).exists()).toBe(false)
        else
          expect((await Bun.file(path.join(root, "accepted.json")).json()).purpose).toBe(
            mode === "export" ? "export" : undefined,
          )
        expect(await Bun.file(`${session.ticket.control}.source-capture-ready`).exists()).toBe(false)
        expect(() => process.kill(session.ticket.header.pid, 0)).toThrow()
        expect(() => process.kill(session.ticket.header.helper, 0)).toThrow()
      } catch (err) {
        errors.push(err)
      } finally {
        if (session.child.exitCode === null) {
          await session.abort().catch((err) => errors.push(err))
          errors.push(new Error("Forced source cleanup"))
        }
        await pipe.close().catch((err) => {
          refused = err instanceof Error && err.message.includes("Private pipe server refused")
          if (!refused) errors.push(err)
        })
        const [stdout, stderr] = await output
        await Bun.write(path.join(root, "stdout.log"), stdout)
        await Bun.write(path.join(root, "stderr.log"), stderr)
        await Bun.write(
          path.join(root, "receipt.json"),
          JSON.stringify({
            passed: !errors.length,
            mode,
            errors: errors.map(String),
            ticket: session.ticket,
            pipeUnusedAndClosed: refused,
            portableCaptureAuthorized: false,
          }),
        )
      }
      if (errors.length) throw new AggregateError(errors, `Retained native purpose failure: ${root}`)
    },
    30000,
  )
