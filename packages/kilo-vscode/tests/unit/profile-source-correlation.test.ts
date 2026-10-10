import { expect, test } from "bun:test"
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { start } from "../../src/services/cli-backend/managed-source"
import { correlated } from "../../src/profile/correlation"
import { environment } from "../fixtures/profile-source-env"
import { drain } from "../fixtures/profile-source-streams"

test.skipIf(process.platform !== "win32")(
  "partial archive metadata must match an actual live owned native ticket and refuses after natural exit",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-archive-source-"))
    const executable = path.join(root, "bun.exe")
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(process.execPath, executable)
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
    await writeFile(
      path.join(root, "raya-process-host.json"),
      JSON.stringify({
        version: 1,
        exe: createHash("sha256")
          .update(Buffer.from(await Bun.file(helper).arrayBuffer()))
          .digest("hex"),
      }),
    )
    const source = await start({
      executable,
      helper,
      cwd: root,
      args: ["-e", "await Bun.sleep(2000); process.exit(0)"],
      env: await environment(root),
    })
    const readers = Promise.all([drain(source.session.child.stdout), drain(source.session.child.stderr)])
    let failure: unknown
    try {
      await source.session.start()
      const ticket = source.session.ticket.header
      const value = { pid: ticket.pid, birth: ticket.birth, executable: ticket.executable, digest: ticket.digest }
      expect(correlated(source, value)).toBe(true)
      expect(correlated(undefined, value)).toBe(false)
      expect(correlated(source, { ...value, pid: value.pid + 1 })).toBe(false)
      expect(correlated(source, { ...value, birth: "1" })).toBe(false)
      expect(correlated(source, { ...value, executable: helper })).toBe(false)
      expect(correlated(source, { ...value, digest: "0".repeat(64) })).toBe(false)
      expect((await source.session.sourceExit).code).toBe(0)
      await source.session.exit
      expect((await readers).every((value) => value.EOF && value.joined)).toBe(true)
      expect(correlated(source, value)).toBe(false)
    } catch (err) {
      failure = err
    } finally {
      const outcomes = await Promise.allSettled([source.session.sourceExit, source.session.exit])
      const streams = await readers
      const errors = outcomes.flatMap((value) => (value.status === "rejected" ? [value.reason] : []))
      if (!streams.every((value) => value.EOF && value.joined))
        errors.push(new Error("Original source streams did not reach EOF"))
      if (failure !== undefined || errors.length) {
        const diagnostic = {
          root,
          original: failure instanceof Error ? failure.name : failure === undefined ? undefined : "unknown",
          outcomes: outcomes.map((value) =>
            value.status === "fulfilled"
              ? { status: value.status, exit: value.value }
              : { status: value.status, error: value.reason instanceof Error ? value.reason.name : "unknown" },
          ),
          streams: streams.map((value) => ({
            ...value,
            tail: value.tail.replaceAll("private fixture archive password", "[redacted]"),
          })),
          force: false,
        }
        await writeFile(path.join(root, "source-retirement-failure.json"), JSON.stringify(diagnostic)).catch((err) =>
          errors.push(err),
        )
        console.error("SOURCE_RETIREMENT_DIAGNOSTIC", root)
        throw new AggregateError(
          [...(failure === undefined ? [] : [failure]), ...errors],
          "Original source fixture failed; diagnostics retained",
        )
      }
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
