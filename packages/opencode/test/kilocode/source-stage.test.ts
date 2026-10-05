import { expect, test } from "bun:test"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { mkdtemp, mkdir, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { staged, type Phase } from "../../src/kilocode/migration/source-stage"
import { failure } from "../../src/kilocode/migration/source-failure"

test("fixed source phases retain causes while unknown phases cannot publish arbitrary data", () => {
  const cause = new Error("PRIVATE_PASSWORD_PATH")
  const error = staged(cause, "source-image")
  expect(error.cause).toBe(cause)
  expect(failure(error).errors[0].code).toBe("RAYA_SOURCE_IMAGE_REFUSED")
  expect(failure(staged(cause, "PRIVATE_PHASE")).errors[0].code).toBe("RAYA_SOURCE_STAGE_INVALID")
  expect(JSON.stringify(failure(error))).not.toContain("PRIVATE_PASSWORD_PATH")
  expect(JSON.stringify(failure(staged(cause, "PRIVATE_PHASE")))).not.toContain("PRIVATE_PHASE")
})

test("post-READY phase classifications preserve nested causes without publishing private data", () => {
  const phases: Phase[] = [
    "watch-exit",
    "signed-ack",
    "observation-roots",
    "state-scope",
    "historical-policy",
    "family-closure",
    "retired-policy",
    "union-roots",
    "export-callback",
    "held-admission",
    "result-publication",
  ]
  const cause = new AggregateError(
    [Object.assign(new Error("PRIVATE_SECRET_PATH"), { code: "PRIVATE_CODE", stack: "PRIVATE_STACK" })],
    "PRIVATE_BODY",
  )
  for (const phase of phases) {
    const error = staged(cause, phase)
    expect(error.cause).toBe(cause)
    const report = failure(error)
    expect(report.errors[0].code).toBe(`RAYA_SOURCE_${phase.replaceAll("-", "_").toUpperCase()}_REFUSED`)
    expect(report.errors.some((value) => value.type === "AggregateError")).toBe(true)
    expect(JSON.stringify(report)).not.toContain("PRIVATE_")
  }
  const value = {
    get phase() {
      throw new Error("PRIVATE_GETTER")
    },
  }
  expect(failure(staged(cause, value)).errors[0].code).toBe("RAYA_SOURCE_STAGE_INVALID")
})

test.skipIf(process.platform !== "win32")(
  "actual successor rejects a changed source birth with fixed binding stage and no capture",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-stage-"))
    const control = path.join(root, "control")
    const source = path.join(root, "source")
    const runtime = path.join(root, "runtime")
    await Promise.all([mkdir(control), mkdir(source), mkdir(runtime)])
    const identity = await NativeProcess.inspect(process.pid)
    if (!identity || typeof identity !== "object" || !("birth" in identity) || typeof identity.birth !== "string")
      throw new Error("Actual source birth unavailable")
    const executable = (await realpath(process.execPath)).toLowerCase()
    const digest = createHash("sha256")
      .update(Buffer.from(await Bun.file(executable).arrayBuffer()))
      .digest("hex")
    const secret = randomBytes(32).toString("hex")
    const value = {
      version: 1,
      generation: crypto.randomUUID(),
      id: crypto.randomUUID(),
      runID: "source-stage",
      source: { pid: process.pid, birth: (BigInt(identity.birth) + 1n).toString(), executable, digest },
      roots: [{ kind: "json", path: source }],
      control,
    }
    await Bun.write(
      path.join(control, "request.json"),
      JSON.stringify({
        value,
        digest: createHmac("sha256", Buffer.from(secret, "hex")).update(JSON.stringify(value)).digest("hex"),
      }),
    )
    const marker = path.join(root, "capture.txt")
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/source-stage-successor.ts"), marker],
      {
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: runtime,
          USERPROFILE: runtime,
          KILO_TEST_HOME: runtime,
          LOCALAPPDATA: path.join(runtime, "local"),
          XDG_DATA_HOME: path.join(runtime, "data"),
          XDG_CONFIG_HOME: path.join(runtime, "config"),
          XDG_CACHE_HOME: path.join(runtime, "cache"),
          XDG_STATE_HOME: path.join(runtime, "state"),
          KILO_DB: path.join(runtime, "unused.db"),
          RAYA_DB: path.join(runtime, "unused.db"),
          RAYA_AUTH_CONTENT: "{}",
          KILO_AUTH_CONTENT: "{}",
          RAYA_SOURCE_HANDOFF_CONTROL: control,
          RAYA_SOURCE_HANDOFF_CHANNEL: secret,
          KILO_DISABLE_MODELS_FETCH: "1",
          RAYA_DISABLE_MODELS_FETCH: "1",
        },
      },
    )
    const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
      await Bun.write(path.join(root, "stdout.log"), stdout)
      await Bun.write(path.join(root, "stderr.log"), stderr)
      expect(code).toBe(1)
      const result = await Bun.file(path.join(control, "result.json")).json()
      expect(result.status).toBe("refused")
      expect(result.failure.errors[0].code).toBe("RAYA_SOURCE_BINDING_REFUSED")
      expect(result.completeProfileCoverage).toBe(false)
      expect(result.portableCaptureAuthorized).toBe(false)
      expect(await Bun.file(path.join(control, "ready.json")).exists()).toBe(false)
      expect(await Bun.file(marker).exists()).toBe(false)
      expect(JSON.stringify(result) + stdout + stderr).not.toContain(secret)
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  },
  35000,
)
