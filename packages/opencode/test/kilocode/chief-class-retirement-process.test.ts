import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { launch, observe } from "@opencode-ai/core/kilocode/source-launch"

test.skipIf(process.platform !== "win32")(
  "actual Chief class refusals retire their isolated original native source",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-chief-refusal-"))
    const profile = path.join(root, "profile")
    await mkdir(profile)
    const executable = await realpath(process.execPath)
    const digest = createHash("sha256")
      .update(new Uint8Array(await Bun.file(executable).arrayBuffer()))
      .digest("hex")
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
    const job = await launch({
      executable,
      digest,
      cwd: path.resolve(import.meta.dir, "../.."),
      args: [
        "test",
        "./test/kilocode/session-handled-tool-retirement.test.ts",
        "--test-name-pattern",
        "^actual Home Assistant model class refusals publish before clean producer retirement$",
      ],
      env: {
        ...env,
        RAYA_HA_REFUSAL_SOURCE: "1",
        HOME: root,
        USERPROFILE: root,
        KILO_TEST_HOME: root,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        RAYA_DB: ":memory:",
        KILO_DB: ":memory:",
        KILO_DISABLE_MODELS_FETCH: "1",
        RAYA_DISABLE_MODELS_FETCH: "1",
      },
      roots: [{ kind: "json", path: profile }],
    })
    const collect = async (stream: Readable | null, name: string) => {
      if (!stream) throw new Error("Original source pipe missing")
      const chunks: Buffer[] = []
      const sum = createHash("sha256")
      let bytes = 0
      for await (const chunk of stream) {
        const value = Buffer.from(chunk)
        bytes += value.byteLength
        sum.update(value)
        if (bytes <= 1024 * 1024) chunks.push(value)
      }
      await Bun.write(path.join(root, name + ".log"), Buffer.concat(chunks))
      return { bytes, sha256: sum.digest("hex"), eof: true, overflow: bytes > 1024 * 1024 }
    }
    // Register all original exits and pipes immediately; no forced-close fallback can qualify this test.
    const streams = Promise.allSettled([collect(job.child.stdout, "stdout"), collect(job.child.stderr, "stderr")])
    const exits = Promise.allSettled([job.sourceExit, job.exit])
    const watcher = await Promise.allSettled([observe(job.ticket)])
    const observer = watcher[0].status === "fulfilled" ? watcher[0].value : undefined
    const started = await Promise.allSettled([
      observer ? job.start() : Promise.reject(new Error("Original observer admission refused before source Go")),
    ])
    // The original source acknowledges capture once. Parent validates that actual native receipt without republishing it.
    const retired = await Promise.allSettled([job.retired()])
    const family = await Promise.allSettled([observer?.done ?? Promise.reject(new Error("Original observer missing"))])
    const ended = await exits
    const output = await streams
    const closed = await Promise.allSettled([Promise.resolve().then(() => observer?.close())])
    await Bun.write(
      path.join(root, "receipt.json"),
      JSON.stringify(
        { ticket: job.ticket, watcher, started, retired, family, ended, output, closed, forced: false },
        null,
        2,
      ),
    )
    const receipt = `Retained actual source evidence: ${root}`
    expect(watcher[0].status, receipt).toBe("fulfilled")
    expect(started[0].status, receipt).toBe("fulfilled")
    expect(retired[0].status, receipt).toBe("fulfilled")
    expect(family[0].status, receipt).toBe("fulfilled")
    if (family[0].status === "fulfilled")
      expect(family[0].value).toMatchObject({ familyZeroObserved: true, portableCaptureAuthorized: false })
    expect(
      ended.every((row) => row.status === "fulfilled"),
      receipt,
    ).toBe(true)
    if (ended[0].status === "fulfilled")
      expect(ended[0].value).toMatchObject({ pid: job.ticket.header.pid, birth: job.ticket.header.birth, code: 0 })
    if (ended[1].status === "fulfilled") expect(ended[1].value).toMatchObject({ code: 0, signal: null })
    expect(
      output.every((row) => row.status === "fulfilled" && row.value.eof && !row.value.overflow),
      receipt,
    ).toBe(true)
    expect(closed[0].status, receipt).toBe("fulfilled")
  },
  75_000,
)
