import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { BrainSettings } from "../../src/second-brain/settings"
import { BrainService } from "../../src/second-brain/service"
import { BrainControl } from "../../src/second-brain/control"
import { CaptureIntake } from "../../src/second-brain/capture-intake"
import { release } from "../../src/second-brain/control/catalog-capture"
import { fingerprint } from "../../src/second-brain/failed-repair"
import { hydrate } from "../../src/second-brain/setup-health"
import { SetupFlow } from "../../src/second-brain/setup-flow"

test("cold admitted Memory hydrates actual health metadata instead of repeating notes, index and capture setup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-memory-setup-health-"))
  const file = path.join(dir, "state.json")
  const secret = path.join(dir, "synthetic-key.json")
  await Promise.all([writeFile(file, "{}"), writeFile(secret, "{}")])
  const storage = {
    get<T>(key: string): T | undefined {
      return JSON.parse(readFileSync(file, "utf8"))[key]
    },
    async update(key: string, value: unknown) {
      const state = JSON.parse(await readFile(file, "utf8"))
      if (value === undefined) delete state[key]
      if (value !== undefined) state[key] = value
      await writeFile(file, JSON.stringify(state))
    },
  }
  const secrets = {
    async get(key: string) {
      return JSON.parse(await readFile(secret, "utf8"))[key]
    },
    async store(key: string, value: string) {
      await writeFile(secret, JSON.stringify({ [key]: value }))
    },
    async delete() {
      throw new Error("Cold setup must preserve its existing credential")
    },
  }
  const requests: string[] = []
  const root = "C:/Synthetic/SecondBrain"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.method + " " + new URL(request.url).pathname)
      expect(request.headers.get("Authorization")).toBe("Bearer synthetic-only")
      return Response.json({
        ready: true,
        namespace_valid: true,
        draining: false,
        retirement_pending: false,
        retirement_unconfirmed: false,
        active: 0,
        capture_enabled: false,
        admission_required: true,
        root,
        source_sha256: release,
        owner_epoch: "a".repeat(32),
        selected_release_sha256: fingerprint(release),
        operation_protocol: "raya.memory.operation.v2",
        index: { status: "synced", digest: "b".repeat(64) },
      })
    },
  })
  const settings = new BrainSettings(storage, secrets)
  const service = new BrainService(settings)
  const control = new BrainControl(service, settings, async () => {
    throw new Error("Cold setup must not reopen source review")
  })
  const intake = new CaptureIntake(storage)
  try {
    await settings.save(
      {
        format: "raya.memory.setup",
        version: 2,
        protocol: "raya.memory.operation.v2",
        root,
        origin: server.url.origin,
        source_sha256: release,
      },
      "synthetic-only",
    )
    const cfg = {
      version: 1,
      enabled: true,
      root: (await settings.load())!.setup.root,
      release: fingerprint(release),
      model: "existing-local-model",
      zone: "America/Toronto",
      authorization: { source: "Original reviewed choice", sha256: "c".repeat(64) },
    }
    await intake.save(cfg)
    expect(control.snapshot().status).toBe("unchecked")
    expect(intake.snapshot(service.captureSnapshot()).status).toBe("unavailable")
    const signal = new AbortController().signal
    await hydrate(service, control, await service.status(), signal, () => {})
    expect(control.snapshot()).toEqual({ status: "synced", digest: "b".repeat(64) })
    expect(intake.snapshot(service.captureSnapshot()).status).toBe("ready")
    const unexpected = async () => {
      throw new Error("Cold setup must reuse the admitted configuration")
    }
    const flow = new SetupFlow({
      snapshot: async () => ({
        configured: true,
        root: (await service.status()).root,
        index: control.snapshot().status,
        capture: intake.snapshot(service.captureSnapshot()).status,
      }),
      prepared: async () => undefined,
      connect: unexpected,
      notes: unexpected,
      index: unexpected,
      capture: unexpected,
    })
    const result = await flow.run({ stage: "inspect" }, "original-conversation", "C:/Synthetic", signal, () => {})
    expect(result.status).toBe("configured")
    expect("question" in result).toBe(false)
    expect(requests).toEqual(["GET /health"])
    expect(storage.get("raya.secondBrain.personalCapture")).toEqual(cfg)
    expect(storage.get("raya.secondBrain.personalCapture.turns")).toBeUndefined()
    await hydrate(service, control, await service.status(), signal, () => {})
    expect(requests).toEqual(["GET /health"])
  } finally {
    await service.dispose()
    await server.stop(true)
    expect(path.dirname(dir)).toBe(tmpdir())
    await rm(dir, { recursive: true, force: true })
  }
})
