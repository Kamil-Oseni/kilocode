import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import z from "zod"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { exportSource } from "@opencode-ai/core/kilocode/source-export"
import { SourceSelection } from "@opencode-ai/core/kilocode/source-selection-schema"
import { start } from "../../src/services/cli-backend/managed-source"
import { archive } from "../../src/profile/archive"
import { correlated } from "../../src/profile/correlation"
import { environment } from "../fixtures/profile-source-env"
import { drain } from "../fixtures/profile-source-streams"

async function bounded(file: string) {
  const before = await lstat(file, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > 65536n ||
    (await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()
  )
    throw new Error("Diagnostic file identity or capacity refused")
  const handle = await open(file, "r")
  try {
    const held = await handle.stat({ bigint: true })
    if (held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size)
      throw new Error("Diagnostic opened identity changed")
    const bytes = Buffer.alloc(65537)
    let size = 0
    while (size < bytes.length) {
      const next = await handle.read(bytes, size, bytes.length - size, null)
      if (!next.bytesRead) break
      size += next.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (
      size > 65536 ||
      BigInt(size) !== held.size ||
      after.size !== held.size ||
      after.mtimeNs !== held.mtimeNs ||
      after.ctimeNs !== held.ctimeNs
    )
      throw new Error("Diagnostic file changed or exceeded capacity")
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as unknown
  } finally {
    await handle.close()
  }
}

const diagnostic = z
  .object({
    format: z.literal("raya.source-failure"),
    version: z.literal(1),
    truncated: z.boolean(),
    errors: z
      .array(
        z
          .object({
            type: z.enum(["Error", "AggregateError", "ZodError", "TypeError", "RangeError", "SyntaxError", "Unknown"]),
            depth: z.number().int().min(0).max(6),
            code: z
              .string()
              .max(128)
              .regex(/^(?:RAYA_[A-Z0-9_]+|SQLITE_[A-Z_]+|E[A-Z]+)$/)
              .optional(),
            stage: z.number().int().min(1).max(64).optional(),
            issues: z
              .array(
                z
                  .object({
                    code: z.enum([
                      "invalid_type",
                      "too_big",
                      "too_small",
                      "invalid_format",
                      "not_multiple_of",
                      "unrecognized_keys",
                      "invalid_union",
                      "invalid_key",
                      "invalid_element",
                      "invalid_value",
                      "custom",
                      "unknown",
                    ]),
                    path: z
                      .array(
                        z.union([
                          z.enum([
                            "quick_check",
                            "busy",
                            "sql",
                            "json",
                            "memory",
                            "schema",
                            "workspaces",
                            "artifacts",
                            "exports",
                            "host",
                            "preferences",
                            "archives",
                            "review",
                          ]),
                          z.number().int().nonnegative(),
                        ]),
                      )
                      .max(8),
                    reason: z
                      .string()
                      .max(128)
                      .regex(/^RAYA_PROFILE_[A-Z0-9_]+$/)
                      .optional(),
                  })
                  .strict(),
              )
              .max(8)
              .optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()

test.skipIf(process.platform !== "win32")(
  "actual archive admission exports and decrypts an owned paused source with original family and stream joins; no VS Code host capsule or restore qualification",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-archive-success-"))
    const broker = await mkdtemp(path.join(os.tmpdir(), "raya-archive-broker-"))
    const destination = await mkdtemp(path.join(os.tmpdir(), "raya-archive-destination-"))
    const pkg = path.resolve(import.meta.dir, "../../../opencode")
    const executable = path.join(root, "bun.exe")
    const helper = path.join(root, "raya-process-host.exe")
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
    const workspace = path.join(root, "workspace")
    await mkdir(workspace)
    const env = await environment(root, path.join(root, "data/kilo/raya.db"))
    const config = path.join(root, "config", "kilo.json")
    if (!env.RAYA_CONFIG_CONTENT) throw new Error("Owned fixture configuration is missing")
    await writeFile(config, env.RAYA_CONFIG_CONTENT, { flag: "wx" })
    delete env.RAYA_CONFIG_CONTENT
    delete env.KILO_CONFIG_CONTENT
    env.RAYA_CONFIG = config
    env.KILO_CONFIG = config
    // Native successor ownership requires scratch outside the source's protected profile policy.
    env.TEMP = broker
    env.TMP = broker
    // The offline registry is selected from LOCALAPPDATA; keep it in owned scratch, outside profile roots.
    for (const name of Object.keys(env)) if (/^(LOCALAPPDATA|APPDATA)$/i.test(name)) delete env[name]
    env.LOCALAPPDATA = path.join(broker, "local")
    env.APPDATA = path.join(broker, "roaming")
    await mkdir(env.LOCALAPPDATA)
    await mkdir(env.APPDATA)
    // Never inherit everyday credentials or send requests to a model provider.
    env.RAYA_AUTH_CONTENT = "{}"
    env.KILO_AUTH_CONTENT = "{}"
    const secret = "owned successful HTTP fixture password"
    env.RAYA_SERVER_PASSWORD = secret
    env.KILO_SERVER_PASSWORD = secret
    env.RAYA_SERVER_USERNAME = "owned-archive"
    env.KILO_SERVER_USERNAME = "owned-archive"
    env.RAYA_TEST_ARCHIVE_ROOT = root
    const password = "owned successful private archive password"
    const redact = (value: string) =>
      value
        .replaceAll(secret, "[redacted]")
        .replaceAll(password, "[redacted]")
        .replaceAll(Buffer.from(`owned-archive:${secret}`).toString("base64"), "[redacted]")
    const causes = (value: unknown, depth = 0): unknown => {
      if (depth >= 4) return { bounded: true }
      if (!(value instanceof Error)) return { name: "unknown" }
      return {
        name: value.name.slice(0, 128),
        message: redact(value.message.slice(0, 2048)),
        ...(value.cause === undefined ? {} : { cause: causes(value.cause, depth + 1) }),
        ...(value instanceof AggregateError
          ? { errors: value.errors.slice(0, 16).map((err: unknown) => causes(err, depth + 1)) }
          : {}),
      }
    }
    const source = await start({
      executable,
      helper,
      cwd: root,
      env,
      args: [
        "--conditions=browser",
        "--preload",
        path.join(pkg, "node_modules/@opentui/solid/scripts/preload.js"),
        path.join(pkg, "test/kilocode/fixtures/profile-archive-success-entry.ts"),
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
      ],
    })
    let startup = ""
    source.session.child.stdout?.on("data", (chunk: Buffer) => {
      startup = (startup + chunk.toString("utf8")).slice(-8192)
    })
    const readers = Promise.all([drain(source.session.child.stdout), drain(source.session.child.stderr)])
    await writeFile(
      path.join(root, "control-reference.json"),
      JSON.stringify({ root, broker, destination, control: source.session.ticket.control }),
    )
    const observed = Promise.allSettled([source.session.sourceExit, source.session.exit, readers]).then(
      async (values) => {
        await writeFile(
          path.join(root, "original-observation.json"),
          JSON.stringify(
            values.map((value) => {
              if (value.status === "rejected") return { status: value.status, error: causes(value.reason) }
              if (Array.isArray(value.value))
                return {
                  status: value.status,
                  streams: value.value.map((stream) => ({ ...stream, tail: redact(stream.tail) })),
                }
              return { status: value.status, exit: value.value }
            }),
          ),
        )
        return values
      },
    )
    const output = path.join(destination, "partial.raya")
    let accepted = 0
    let captured = 0
    let failure: unknown
    try {
      await source.session.start()
      const deadline = Date.now() + 60000
      while (!/kilo server listening on (http:\/\/[^\s]+)/.test(startup)) {
        if (source.exited || Date.now() >= deadline) throw new Error("Owned source startup was not confirmed")
        await Bun.sleep(25)
      }
      const url = startup.match(/kilo server listening on (http:\/\/[^\s]+)/)![1]
      const headers = { authorization: `Basic ${Buffer.from(`owned-archive:${secret}`).toString("base64")}` }
      const client = createKiloClient({ baseUrl: url, headers })
      expect((await fetch(`${url}/global/source-export-selection`)).status).toBe(401)
      const title = "OWNED_ARCHIVE_SESSION café 日本語"
      const created = await fetch(`${url}/session?directory=${encodeURIComponent(workspace)}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", "x-kilo-directory": workspace },
        body: JSON.stringify({ title }),
      })
      expect(created.status).toBe(200)
      const session = (await created.json()) as { id: string }
      expect(session.id).toBeString()
      const response = await client.global.sourceExportSelection({ throwOnError: true })
      const review = Schema.decodeUnknownSync(SourceSelection)(response.data, { onExcessProperty: "error" })
      expect(correlated(source, review.source)).toBe(true)
      const connection: Parameters<typeof archive>[0] = {
        getClient: () => client,
        isClientCurrent: (value) => value === client && !source.exited,
        matchesSource: (value) => correlated(source, value),
        exportProfile: (input) => {
          captured++
          return exportSource(source.session, input)
        },
      }
      const result = await archive(connection, review, password, output, () => {
        accepted++
      })
      await writeFile(
        path.join(root, "authenticated-return.json"),
        JSON.stringify({
          status: result.result.status,
          code: result.code,
          artifact: result.result.artifact,
          familyZeroObserved: result.family.familyZeroObserved,
          completeProfileCoverage: false,
          portableCaptureAuthorized: false,
        }),
      )
      expect(accepted).toBe(1)
      expect(captured).toBe(1)
      expect(result.result.status).toBe("exported")
      expect(result.result.completeProfileCoverage).toBe(false)
      expect(result.result.portableCaptureAuthorized).toBe(false)
      expect(result.code).toBe(0)
      expect(result.family.familyZeroObserved).toBe(true)
      const artifact = result.result.artifact!
      const bytes = await readFile(output)
      expect(artifact.output).toBe(output)
      expect(artifact.bytes).toBe(bytes.length)
      expect(artifact.digest).toBe(createHash("sha256").update(bytes).digest("hex"))
      expect(bytes.toString("utf8")).not.toContain(title)
      expect(bytes.toString("utf8")).not.toContain(password)
      const { unseal } = await import("../../../opencode/src/kilocode/migration/profile-bundle")
      const bundle = await unseal(bytes.toString("utf8"), password)
      const table = bundle.sql.find((value) => value.table === "session")!
      expect(table).toBeDefined()
      const index = table.columns.indexOf("id")
      const named = table.columns.indexOf("title")
      expect(table.rows.some((row) => row[index] === session.id && row[named] === title)).toBe(true)
      const [original, controller, streams] = await Promise.all([
        source.session.sourceExit,
        source.session.exit,
        readers,
      ])
      expect(original.code).toBe(0)
      expect(controller.code).toBe(0)
      expect(controller.signal).toBeNull()
      expect(streams.every((value) => value.EOF && value.joined && !("error" in value))).toBe(true)
      expect(correlated(source, review.source)).toBe(false)
      await writeFile(
        path.join(root, "qualified.json"),
        JSON.stringify({
          artifact,
          root,
          broker,
          destination,
          original,
          controller,
          streams: streams.map(({ tail, ...value }) => value),
          family: result.family,
          completeProfileCoverage: false,
          restoreQualified: false,
          hostCapsuleQualified: false,
        }),
      )
      await observed
    } catch (err) {
      failure = err
    }
    if (failure !== undefined) {
      // Preserve uncertainty and the original family. Never force, replay, or publish a second request.
      if (captured === 0)
        await writeFile(path.join(root, "preparation-failed"), "retire owned Serve through its actual signal handler", {
          flag: "wx",
        })
      const errors: unknown[] = [failure]
      await observed.catch((err: unknown) => {
        errors.push(err)
      })
      if (captured > 0) {
        try {
          const ready = z
            .object({ value: z.object({ successor: z.object({ control: z.string().min(1).max(4096) }) }) })
            .parse(await bounded(`${source.session.ticket.control}.source-handoff-ready`))
          const receiver = ready.value.successor.control
          const relative = path.relative(broker, receiver)
          if (
            !relative ||
            path.isAbsolute(relative) ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            (await realpath(receiver)).toLowerCase() !== path.resolve(receiver).toLowerCase()
          )
            throw new Error("Diagnostic receiver escapes owned broker")
          const result = z
            .object({ status: z.literal("refused"), failure: diagnostic })
            .parse(await bounded(path.join(receiver, "result.json")))
          await writeFile(
            path.join(root, "receiver-diagnostic.json"),
            JSON.stringify({
              freshRead: true,
              sameStateAuthority: false,
              status: result.status,
              failure: result.failure,
            }),
          )
        } catch (err) {
          errors.push(err)
          await writeFile(
            path.join(root, "receiver-diagnostic.json"),
            JSON.stringify({
              freshRead: true,
              sameStateAuthority: false,
              unavailable: true,
              error: err instanceof Error ? err.name : "unknown",
            }),
          )
        }
      }
      await writeFile(
        path.join(root, "failure.json"),
        JSON.stringify({
          error: causes(failure),
          root,
          broker,
          destination,
          accepted,
          captured,
          sourceExited: source.exited,
          force: false,
          retained: true,
        }),
      )
      throw new AggregateError(errors, `Owned archive qualification failed; retained ${root}`)
    }
  },
  180000,
)
