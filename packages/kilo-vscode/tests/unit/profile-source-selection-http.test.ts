import { expect, test } from "bun:test"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { SourceSelection } from "@opencode-ai/core/kilocode/source-selection-schema"
import { start } from "../../src/services/cli-backend/managed-source"
import { correlated } from "../../src/profile/correlation"
import { environment } from "../fixtures/profile-source-env"

async function drain(stream: Awaited<ReturnType<typeof start>>["session"]["child"]["stdout"]) {
  const hash = createHash("sha256")
  let bytes = 0
  let tail = Buffer.alloc(0)
  if (!stream) return { bytes, sha256: hash.digest("hex"), EOF: false, joined: true, tail: "", error: "MissingStream" }
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      bytes += chunk.length
      hash.update(chunk)
      tail = chunk.length >= 65536 ? Buffer.from(chunk.subarray(-65536)) : Buffer.concat([tail, chunk]).subarray(-65536)
    }
    return { bytes, sha256: hash.digest("hex"), EOF: true, joined: true, tail: tail.toString("utf8") }
  } catch (err) {
    return {
      bytes,
      sha256: hash.digest("hex"),
      EOF: false,
      joined: true,
      tail: tail.toString("utf8"),
      error: err instanceof Error ? err.name : "unknown",
    }
  }
}

function redact(value: string) {
  const password = "owned source selection test password"
  return value
    .replaceAll(password, "[redacted]")
    .replaceAll(Buffer.from(`owned-selection:${password}`).toString("base64"), "[redacted]")
}

test.skipIf(process.platform !== "win32")(
  "actual owned endpoint selects custom SQL and active JSON roots without exporting or relabeling its retired metadata",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-selection-http-"))
    const executable = path.join(root, "bun.exe")
    const helper = path.join(root, "raya-process-host.exe")
    const pkg = path.resolve(import.meta.dir, "../../../opencode")
    await copyFile(process.execPath, executable)
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
    await writeFile(
      path.join(root, "raya-process-host.json"),
      JSON.stringify({
        version: 1,
        exe: createHash("sha256")
          .update(await readFile(helper))
          .digest("hex"),
      }),
    )
    const database = path.join(root, "custom-selected.db")
    const source = await start({
      executable,
      helper,
      cwd: root,
      args: [
        "--conditions=browser",
        "--preload",
        path.join(pkg, "node_modules/@opentui/solid/scripts/preload.js"),
        path.join(pkg, "test/kilocode/fixtures/source-selection-http.ts"),
        root,
      ],
      env: {
        ...(await environment(root, database)),
        RAYA_SERVER_PASSWORD: "owned source selection test password",
        KILO_SERVER_PASSWORD: "owned source selection test password",
        RAYA_SERVER_USERNAME: "owned-selection",
        KILO_SERVER_USERNAME: "owned-selection",
      },
    })
    const readers = Promise.all([drain(source.session.child.stdout), drain(source.session.child.stderr)])
    let primary: unknown
    try {
      await source.session.start()
      const exited = await source.session.sourceExit
      await source.session.exit
      const streams = await readers
      const diagnostic = {
        root,
        exit: exited,
        streams: streams.map((value) => ({ ...value, tail: redact(value.tail) })),
        force: false,
      }
      await writeFile(path.join(root, "source-selection-diagnostic.json"), JSON.stringify(diagnostic))
      if (exited.code !== 0) console.error("SOURCE_SELECTION_DIAGNOSTIC", JSON.stringify(diagnostic))
      expect(exited.code).toBe(0)
      expect(streams.every((value) => value.EOF && value.joined)).toBe(true)
      const proof = Schema.decodeUnknownSync(SourceSelection)(
        JSON.parse(await readFile(path.join(root, "source-selection-proof.json"), "utf8")),
        { onExcessProperty: "error" },
      )
      const ticket = source.session.ticket.header
      expect(proof.source).toEqual({
        pid: ticket.pid,
        birth: ticket.birth,
        executable: ticket.executable,
        digest: ticket.digest,
      })
      expect(proof.profile.database.toLowerCase()).toBe(database.toLowerCase())
      expect(JSON.parse(await readFile(path.join(proof.profile.storage, "selection", "owned.json"), "utf8"))).toEqual({
        identity: "owned-selected-json",
        revision: 7,
      })
      expect(proof.completeProfileCoverage).toBe(false)
      expect(proof.portableCaptureAuthorized).toBe(false)
      expect(correlated(source, proof.source)).toBe(false)
    } catch (err) {
      primary = err
      const outcomes = await Promise.allSettled([source.session.sourceExit, source.session.exit])
      const streams = await readers
      const child = await (async () => {
        const file = Bun.file(path.join(root, "source-selection-failure.json"))
        return (await file.exists()) && file.size <= 4096 ? redact(await file.text()) : "Child diagnostic unavailable"
      })().catch((failure) => `Child diagnostic read failed: ${failure instanceof Error ? failure.name : "unknown"}`)
      const diagnostic = {
        root,
        original: err instanceof Error ? err.name : "unknown",
        child,
        outcomes: outcomes.map((value) =>
          value.status === "fulfilled"
            ? { status: value.status, exit: value.value }
            : { status: value.status, error: value.reason instanceof Error ? value.reason.name : "unknown" },
        ),
        streams: streams.map((value) => ({ ...value, tail: redact(value.tail) })),
        force: false,
      }
      await writeFile(path.join(root, "source-selection-failure-diagnostic.json"), JSON.stringify(diagnostic)).catch(
        (failure) => {
          console.error("SOURCE_SELECTION_DIAGNOSTIC_PUBLICATION", failure instanceof Error ? failure.name : "unknown")
        },
      )
      console.error("SOURCE_SELECTION_FAILURE_DIAGNOSTIC", JSON.stringify(diagnostic))
      console.error("SOURCE_SELECTION_RETAINED", root)
      throw err
    } finally {
      const failures: unknown[] = []
      await source.session.exit.catch((err) => {
        failures.push(err)
      })
      const streams = await readers
      if (streams.some((value) => !value.EOF)) failures.push(new Error("Original source stream did not reach EOF"))
      if (primary === undefined && failures.length === 0) await rm(root, { recursive: true, force: true })
      if (failures.length)
        throw new AggregateError(
          primary === undefined ? failures : [primary, ...failures],
          "Original source cleanup remained unconfirmed; owned evidence retained",
        )
    }
  },
  60_000,
)
