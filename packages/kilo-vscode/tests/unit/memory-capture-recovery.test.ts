import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import { readFile, writeFile, rm, readdir, cp } from "node:fs/promises"
import { BrainSettings } from "../../src/second-brain/settings"
import { BrainService } from "../../src/second-brain/service"
import { CaptureIntake } from "../../src/second-brain/capture-intake"
import { command } from "../../src/second-brain/control/command"
import { sha } from "../../src/second-brain/control/frames"
import { fingerprint } from "../../src/second-brain/failed-repair"
import { release, bridge } from "../../src/second-brain/control/catalog-capture"
import { linked } from "../../src/second-brain/managed/capture-upgrade"
import { descriptor } from "../../src/second-brain/managed/descriptor"
import { image, powershell, environment } from "../../src/second-brain/control/identity"
import { rebind } from "../../src/second-brain/committed-capture"
import { retained } from "../../src/second-brain/failed-downstream"
import { parse } from "../../src/second-brain/settings"

async function fixture(hook?: (key: string, value: unknown) => Promise<void>, full = false, cancelled = false) {
  const producer = await command(
    process.execPath,
    [
      path.resolve("tests/unit/fixtures/committed-capture-producer.ts"),
      ...(full ? ["--runtime"] : []),
      ...(cancelled ? ["--cancelled-search"] : []),
    ],
    {
      cwd: process.cwd(),
    },
  )
  const value = JSON.parse(producer.stdout) as {
    root: string
    notes: string
    file: string
    turn: { id: string }
    producer: { code: number; stdoutEOF: boolean; stderrEOF: boolean }
  }
  expect(producer.receipt.code).toBe(0)
  expect(value.producer).toMatchObject({ code: 0, stdoutEOF: true, stderrEOF: true })
  const storage = {
    get<T>(key: string) {
      return JSON.parse(readFileSync(value.file, "utf8"))[key] as T | undefined
    },
    async update(key: string, item: unknown) {
      const data = JSON.parse(await readFile(value.file, "utf8"))
      if (item === undefined) delete data[key]
      if (item !== undefined) data[key] = item
      await writeFile(value.file, JSON.stringify(data))
      await hook?.(key, item)
    },
  }
  const settings = () =>
    new BrainSettings(storage, {
      async get() {
        return "synthetic"
      },
      async store() {},
      async delete() {},
    })
  return {
    ...value,
    storage,
    settings,
    async cleanup() {
      expect(path.dirname(value.root)).toBe(path.resolve(tmpdir()))
      expect(path.basename(value.root).startsWith("raya-namespace-test-")).toBe(true)
      await rm(value.root, { recursive: true, force: true })
    },
  }
}

async function inventory(root: string) {
  const rows: Record<string, string> = {}
  async function walk(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name)
      if (item.isDirectory()) await walk(file)
      if (item.isFile()) rows[path.relative(root, file)] = sha(await readFile(file))
    }
  }
  await walk(root)
  return rows
}

test("failed downstream review binds real noncreated ASGI publications and bounded supervisor diagnostics", async () => {
  const value = await fixture(undefined, true, true)
  try {
    const entry = value.storage.get<{ managed: unknown; setup: unknown }>("raya.secondBrain.setup")!
    const cfg = descriptor(entry.managed)
    // Protect only this disposable fixture's two selected namespaces with its original root ACL.
    const script =
      `$ErrorActionPreference='Stop';$acl=Get-Acl -LiteralPath '${cfg.root.replace(/'/g, "''")}';` +
      [cfg.namespaces.memory.root, cfg.namespaces.retrieval.root]
        .map((dir) => `Set-Acl -LiteralPath '${dir.replace(/'/g, "''")}' -AclObject $acl;`)
        .join("")
    await command(
      powershell(),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, env: environment() },
    )
    const file = path.join(value.root, "downstream-cfg.json")
    await writeFile(file, JSON.stringify(cfg))
    const child = Bun.spawn(
      [
        "D:/Raya/Services/Packaging/Environments/PrimarySnapshot/Scripts/python.exe",
        "-B",
        path.resolve("script/memory/retrieval_preworker_producer.py"),
        file,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(0)
    const data = JSON.parse(stdout)
    const before = await inventory(value.notes)
    const ledger = value.storage.get("raya.secondBrain.personalCapture.turns")
    const proof = await retained(cfg, parse(entry.setup), [data.proof])
    expect(proof[0].receipt).toEqual(data.proof)
    expect(proof[0].files).toHaveLength(2)
    expect(data.diagnostic).toMatchObject({
      cause: "pool_memory_reserve",
      http_status: 503,
      settlement_authority: false,
      replay: false,
    })
    for (const change of [
      { worker_created: true },
      { inference_outcome: "completed" },
      { selected_release_sha256: "f".repeat(64) },
      { request: "e".repeat(32) },
    ])
      await expect(retained(cfg, parse(entry.setup), [{ ...data.proof, ...change }])).rejects.toThrow()
    const ref = proof[0].files[0]
    const raw = await readFile(ref.path)
    await writeFile(ref.path, JSON.stringify({ ...JSON.parse(raw.toString()), request_sha256: "f".repeat(64) }))
    await expect(retained(cfg, parse(entry.setup), [data.proof])).rejects.toThrow("publication differs")
    await writeFile(ref.path, raw)
    const extra = path.join(path.dirname(ref.path), data.proof.request + "-" + "f".repeat(32) + ".json")
    await writeFile(extra, raw)
    await expect(retained(cfg, parse(entry.setup), [data.proof])).rejects.toThrow("reservation and settlement")
    expect(await inventory(value.notes)).toEqual(before)
    expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual(ledger)
  } finally {
    await value.cleanup()
  }
}, 60000)

test("native cancelled read recovery retains original debt and updates a closed runtime across physical save loss", async () => {
  const fault = { enabled: false }
  const value = await fixture(
    async (key, item) => {
      if (
        fault.enabled &&
        key === "raya.secondBrain.setup" &&
        fingerprint((item as { setup: { source_sha256: unknown } }).setup.source_sha256) === fingerprint(release)
      ) {
        fault.enabled = false
        throw new Error("Runtime update acknowledgement loss")
      }
    },
    true,
    true,
  )
  try {
    const settings = value.settings()
    const previous = value.storage.get<{ managed: unknown; launch: { receipt: unknown } }>("raya.secondBrain.setup")!
    const debt = settings.pending()!
    const request = debt.request as { id: string; owner_epoch: string }
    const cfg = descriptor(previous.managed)
    const file = path.join(cfg.namespaces.memory.root, "Requests", request.owner_epoch, request.id + "-terminal.json")
    const held = await image(file, 65536)
    const before = await inventory(value.notes)
    const ledger = value.storage.get("raya.secondBrain.personalCapture.turns")
    const observation = path.join(value.root, "cancelled-read.json")
    const witness = {
      format: "raya.memory.cancelled-search.observation",
      version: 1,
      observed: Date.now(),
      entry_sha256: fingerprint(previous),
      debt,
      original: previous.launch.receipt,
      terminal: JSON.parse(held.raw.toString()),
      terminal_file: { path: file, bytes: held.raw.length, sha256: held.digest },
      authenticated_original_http: false,
      settlement_authority: false,
      qualification: "Real original cancelled read receipt; no HTTP settlement or replay authority",
    }
    await writeFile(observation, JSON.stringify({ ...witness, authenticated_original_http: true }))
    await expect(settings.repair(observation, async () => true)).rejects.toThrow("observation required")
    expect(settings.pending()).toEqual(debt)
    await writeFile(observation, JSON.stringify(witness))
    await settings.repair(observation, async (review) => {
      expect(review.outcome).toBe("cancelled")
      return true
    })
    const key = "raya.secondBrain.failedSearchRecovery." + request.id
    const audit = value.storage.get(key)
    expect(audit).toMatchObject({
      format: "raya.memory.cancelled-search.repair",
      previous,
      debt,
      phase: "applied",
      requestSettlement: false,
      replay: false,
      indexConfirmed: false,
    })
    expect(settings.pending()).toBeUndefined()
    fault.enabled = true
    const service = new BrainService(value.settings(), process.cwd())
    await expect(service.upgradeRuntime()).rejects.toThrow("acknowledgement loss")
    await service.dispose()
    const cold = new BrainService(value.settings(), process.cwd())
    await cold.upgradeRuntime()
    expect(value.storage.get(key)).toEqual(audit)
    expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual(ledger)
    expect(await inventory(value.notes)).toEqual(before)
    expect(
      value.storage.get<{ setup: { source_sha256: unknown } }>("raya.secondBrain.setup")?.setup.source_sha256,
    ).toEqual(release)
    expect(value.storage.get("raya.secondBrain.committedCaptureRecovery.pending")).toBeUndefined()
    await cold.dispose()
  } finally {
    await value.cleanup()
  }
}, 60000)

for (const stage of ["confirmation", "ledger"] as const)
  test(`cross-release original capture recovery preserves exact proof after ${stage} acknowledgement loss`, async () => {
    const fault = { enabled: false }
    const value = await fixture(async (key) => {
      if (
        fault.enabled &&
        key ===
          (stage === "ledger"
            ? "raya.secondBrain.personalCapture.turns"
            : `raya.secondBrain.committedCaptureRecovery.${value.turn.id}.confirmation`)
      ) {
        fault.enabled = false
        throw new Error("Cross-release physical acknowledgement loss")
      }
    }, true)
    try {
      const original = value.storage.get<{ setup: { source_sha256: Record<string, string> }; managed: unknown }>(
        "raya.secondBrain.setup",
      )!
      const cfg = descriptor(original.managed)
      const before = await inventory(value.notes)
      const consent = {
        version: 1,
        enabled: true,
        root: value.notes,
        release: value.turn.release,
        zone: "America/Toronto",
        model: "pinned-local-model",
        authorization: { source: "Original synthetic human authorization", sha256: "a".repeat(64) },
      }
      await value.storage.update("raya.secondBrain.personalCapture", consent)
      await value.storage.update("raya.secondBrain.control.catalog", {
        root: value.notes,
        catalog: {
          format: "raya.memory.control.catalog",
          version: 2,
          python: cfg.python.path,
          source: path.join(cfg.root, "source/memory"),
          bridge: path.resolve("script/memory/control.py"),
          python_sha256: cfg.python.sha256,
          bridge_sha256: bridge,
          source_sha256: original.setup.source_sha256,
        },
      })
      const settings = value.settings()
      const service = new BrainService(settings, process.cwd())
      await service.recoverCapture(value.turn, async () => true)
      const key = `raya.secondBrain.committedCaptureRecovery.${value.turn.id}`
      const audit = value.storage.get(key)
      expect(settings.upgrading()).toBe(true)
      const installed = path.join(value.root, "replacement-extension")
      const successor = path.join(value.root, "cold-extension")
      await cp(path.resolve("script/memory"), path.join(installed, "script/memory"), { recursive: true })
      await cp(path.resolve("script/memory"), path.join(successor, "script/memory"), { recursive: true })
      const replacement = new BrainService(value.settings(), installed)
      const reviewed = await replacement.upgradeCapture(value.turn)
      expect(reviewed.evidence.helper.path).toBe(path.resolve("script/memory/capture_recovery.py"))
      expect(() => rebind(JSON.parse(JSON.stringify(reviewed)), audit)).toThrow("Fresh native capture review required")
      expect(() => rebind(reviewed, { reviewSHA: "f".repeat(64), review: {} })).toThrow("review digest differs")
      const altered = { ...reviewed, policySHA: "f".repeat(64), producer: undefined }
      expect(() => rebind(reviewed, { reviewSHA: fingerprint(altered), review: altered })).toThrow("effect changed")
      expect(settings.upgrading()).toBe(false)
      expect(linked(reviewed)?.previousRelease).toBe(value.turn.release)
      expect(linked(reviewed)?.release).toBe(fingerprint(release))
      expect(linked(reviewed)?.release).not.toBe(value.turn.release)
      expect(linked(reviewed)?.indexConfirmed).toBe(false)
      expect(value.storage.get(key)).toEqual(audit)
      expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual([value.turn])
      expect(value.storage.get("raya.secondBrain.personalCapture")).toEqual({
        ...consent,
        release: fingerprint(release),
      })
      // These are confirmation-input fields, not a claim of authenticated installed index acceptance.
      const binding = {
        root: value.notes,
        release: fingerprint(release),
        owner: "synthetic-confirmation-input",
        generation: {},
        index: "synced" as const,
        digest: reviewed.policySHA,
      }
      const clone = JSON.parse(JSON.stringify(reviewed)) as typeof reviewed
      expect(linked(clone)).toBeUndefined()
      await expect(new CaptureIntake(value.storage).confirmRecovery(clone, binding, () => {})).rejects.toThrow(
        "must agree",
      )
      await expect(
        new CaptureIntake(value.storage).confirmRecovery(
          reviewed,
          { ...binding, release: value.turn.release },
          () => {},
        ),
      ).rejects.toThrow("must agree")
      fault.enabled = true
      await expect(new CaptureIntake(value.storage).confirmRecovery(reviewed, binding, () => {})).rejects.toThrow(
        "physical acknowledgement loss",
      )
      const intake = new CaptureIntake(value.storage)
      const selected = intake.recoverable().find((row) => row.id === value.turn.id)!
      expect(selected.phase).toBe(stage === "ledger" ? "published" : "uncertain")
      const proof = value.storage.get(`${key}.confirmation`)
      const helper = path.join(successor, "script/memory/capture_recovery.py")
      const bytes = await readFile(helper)
      await writeFile(helper, Buffer.concat([bytes, Buffer.from("\n# changed package helper\n")]))
      await expect(value.settings().reviewCapture(successor, selected)).rejects.toThrow("review helper differs")
      await writeFile(helper, bytes)
      const cold = await value.settings().reviewCapture(successor, selected)
      expect(linked(cold)).toEqual(linked(reviewed))
      await intake.confirmRecovery(cold, binding, () => {})
      expect(value.storage.get(`${key}.confirmation`)).toEqual(proof)
      expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual([
        { ...value.turn, phase: "published", receipt: reviewed.inputSHA },
      ])
      expect(value.storage.get(key)).toEqual(audit)
      expect(await inventory(value.notes)).toEqual(before)
      await replacement.dispose()
      await service.dispose()
    } finally {
      await value.cleanup()
    }
  }, 60000)

test("cross-release upgrade resumes its original fenced intent after the new setup physically saves", async () => {
  const fault = { enabled: false }
  const value = await fixture(async (key, item) => {
    if (
      fault.enabled &&
      key === "raya.secondBrain.setup" &&
      fingerprint((item as { setup: { source_sha256: unknown } }).setup.source_sha256) === fingerprint(release)
    ) {
      fault.enabled = false
      throw new Error("Runtime physical acknowledgement loss")
    }
  }, true)
  try {
    const before = await inventory(value.notes)
    const settings = value.settings()
    const service = new BrainService(settings, process.cwd())
    await service.recoverCapture(value.turn, async () => true)
    const key = `raya.secondBrain.committedCaptureRecovery.${value.turn.id}`
    const audit = value.storage.get(key)
    fault.enabled = true
    await expect(service.upgradeCapture(value.turn)).rejects.toThrow("Runtime physical acknowledgement loss")
    expect(value.storage.get<{ format: string }>("raya.secondBrain.committedCaptureRecovery.pending")?.format).toBe(
      "raya.memory.runtime.upgrade.pending",
    )
    const cold = value.settings()
    expect(cold.upgrading()).toBe(true)
    await expect(cold.load()).rejects.toThrow("Interrupted Memory recovery must finish")
    await service.dispose()
    const resumed = new BrainService(cold, process.cwd())
    const reviewed = await resumed.upgradeCapture(value.turn)
    expect(cold.upgrading()).toBe(false)
    expect(linked(reviewed)?.previousRelease).toBe(value.turn.release)
    expect(linked(reviewed)?.release).toBe(fingerprint(release))
    expect(value.storage.get(key)).toEqual(audit)
    expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual([value.turn])
    expect(await inventory(value.notes)).toEqual(before)
    await resumed.dispose()
  } finally {
    await value.cleanup()
  }
}, 60000)

test("reviewed committed capture restores admission with an audit and no note or ledger replay", async () => {
  const value = await fixture()
  try {
    const original = value.storage.get("raya.secondBrain.setup")
    const debt = value.settings().pending()
    const turns = value.storage.get("raya.secondBrain.personalCapture.turns")
    const before = await inventory(value.notes)
    const settings = value.settings()
    await expect(settings.load()).rejects.toThrow("pending original settlement")
    const service = new BrainService(settings, process.cwd())
    const result = await service.recoverCapture(value.turn, async () => true)
    expect(result?.requestSettlement).toBe(false)
    expect(result?.replay).toBe(false)
    expect(result?.indexConfirmed).toBe(false)
    expect(settings.pending()).toBeUndefined()
    expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual(turns)
    expect(await inventory(value.notes)).toEqual(before)
    expect((await settings.load())?.launch?.predecessor).toEqual(result?.closure.closed)
    const audit = value.storage.get<{
      phase: string
      previous: unknown
      debt: unknown
      turn: unknown
      requestSettlement: boolean
    }>(`raya.secondBrain.committedCaptureRecovery.${result?.capture}`)
    expect(audit?.phase).toBe("applied")
    expect(audit?.previous).toEqual(original)
    expect(audit?.debt).toEqual(debt)
    expect(audit?.turn).toEqual(value.turn)
    expect(audit?.requestSettlement).toBe(false)
    expect((await service.status()).status).toBe("disconnected")
    await service.dispose()
  } finally {
    await value.cleanup()
  }
}, 30000)

test("committed capture cancellation and changed reviewed ledger preserve pending records", async () => {
  const value = await fixture()
  try {
    const original = await readFile(value.file)
    const settings = value.settings()
    expect(await settings.recoverCapture(process.cwd(), value.turn, async () => false)).toBeUndefined()
    expect(await readFile(value.file)).toEqual(original)
    await expect(
      settings.recoverCapture(process.cwd(), value.turn, async () => {
        await value.storage.update("raya.secondBrain.personalCapture.turns", [])
        return true
      }),
    ).rejects.toThrow("Reviewed committed capture changed")
    expect(settings.pending()).toBeDefined()
    expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual([])
  } finally {
    await value.cleanup()
  }
}, 30000)

test("committed capture persistence failures restore original uncertainty and allow reviewed retry", async () => {
  const fault = { enabled: true }
  const value = await fixture(async (key, item) => {
    if (fault.enabled && key === "raya.secondBrain.control.uncertainty" && item === undefined) {
      fault.enabled = false
      throw new Error("Synthetic original persistence failure")
    }
  })
  try {
    const original = value.storage.get("raya.secondBrain.setup")
    const settings = value.settings()
    const debt = settings.pending()
    await expect(settings.recoverCapture(process.cwd(), value.turn, async () => true)).rejects.toThrow(
      "Synthetic original persistence failure",
    )
    expect(value.storage.get("raya.secondBrain.setup")).toEqual(original)
    expect(settings.pending()).toEqual(debt)
    const result = await settings.recoverCapture(process.cwd(), value.turn, async () => true)
    expect(result?.capture).toBe(value.turn.id)
    expect(settings.pending()).toBeUndefined()
  } finally {
    await value.cleanup()
  }
}, 30000)

for (const stage of ["state", "verified", "clear", "applied"])
  test(`cold committed capture recovery resumes the exact ${stage} interruption checkpoint`, async () => {
    const value = await fixture()
    try {
      const before = await inventory(value.notes)
      const turns = value.storage.get("raya.secondBrain.personalCapture.turns")
      const child = Bun.spawn(
        [process.execPath, path.resolve("tests/unit/fixtures/committed-capture-crash.ts"), value.file, stage],
        {
          cwd: process.cwd(),
          windowsHide: true,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, err).toBe(71)
      expect(out).toBe("")
      expect(err).toBe("")
      const prior = value.storage.get<{ phase: string }>(`raya.secondBrain.committedCaptureRecovery.${value.turn.id}`)
      expect(prior?.phase).toBe(stage === "state" ? "prepared" : stage === "applied" ? "applied" : "verified")
      const settings = value.settings()
      await expect(settings.load()).rejects.toThrow("Interrupted Memory recovery must finish")
      const installed = path.join(value.root, "replacement-extension")
      await cp(path.resolve("script/memory"), path.join(installed, "script/memory"), { recursive: true })
      const result = await settings.recoverCapture(installed, value.turn, async () => true)
      expect(result?.capture).toBe(value.turn.id)
      expect(settings.pending()).toBeUndefined()
      expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual(turns)
      expect(await inventory(value.notes)).toEqual(before)
      expect(
        value.storage.get<{ phase: string }>(`raya.secondBrain.committedCaptureRecovery.${value.turn.id}`)?.phase,
      ).toBe("applied")
    } finally {
      await value.cleanup()
    }
  }, 60000)

test("recovered capture ledger requires the applied original audit and matching current index inputs", async () => {
  const value = await fixture()
  try {
    const settings = value.settings()
    const result = (await settings.recoverCapture(process.cwd(), value.turn, async () => true))!
    const before = await inventory(value.notes)
    const audit = value.storage.get(`raya.secondBrain.committedCaptureRecovery.${value.turn.id}`)
    const turns = value.storage.get("raya.secondBrain.personalCapture.turns")
    const reviewed = await settings.reviewCapture(process.cwd(), value.turn)
    expect(reviewed.inputSHA).toBe(result.inputSHA)
    const binding = {
      root: reviewed.root,
      release: value.storage.get<Array<{ release: string }>>("raya.secondBrain.personalCapture.turns")![0].release,
      generation: {},
      owner: "synthetic-current-index-input",
      index: "synced" as const,
      digest: reviewed.policySHA,
    }
    const intake = new CaptureIntake(value.storage)
    for (const changed of [
      { ...binding, index: "approved" as const },
      { ...binding, digest: "0".repeat(64) },
      { ...binding, root: binding.root + "-other" },
      { ...binding, release: "0".repeat(64) },
    ])
      await expect(intake.confirmRecovery(reviewed, changed, () => {})).rejects.toThrow("must agree")
    await expect(
      intake.confirmRecovery(reviewed, binding, () => {
        throw new Error("Original generation changed")
      }),
    ).rejects.toThrow("generation changed")
    expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual(turns)
    await intake.confirmRecovery(reviewed, binding, () => {})
    const completed = value.storage.get<Array<{ phase: string; receipt: string }>>(
      "raya.secondBrain.personalCapture.turns",
    )!
    expect(completed[0]).toEqual({ ...value.turn, phase: "published", receipt: reviewed.inputSHA })
    expect(value.storage.get(`raya.secondBrain.committedCaptureRecovery.${value.turn.id}`)).toEqual(audit)
    expect(value.storage.get(`raya.secondBrain.committedCaptureRecovery.${value.turn.id}.confirmation`)).toMatchObject({
      original: value.turn,
      requestSettlement: false,
      replay: false,
      indexConfirmed: true,
    })
    await new CaptureIntake(value.storage).confirmRecovery(reviewed, binding, () => {})
    expect(await inventory(value.notes)).toEqual(before)
    expect(value.storage.get("raya.secondBrain.personalCapture.turns")).toEqual(completed)
  } finally {
    await value.cleanup()
  }
}, 30000)

test("recovered capture confirmation resumes after a physical ledger write fails to acknowledge", async () => {
  const fault = { enabled: false }
  const value = await fixture(async (key) => {
    if (fault.enabled && key === "raya.secondBrain.personalCapture.turns") {
      fault.enabled = false
      throw new Error("Synthetic confirmation acknowledgement failure")
    }
  })
  try {
    const result = (await value.settings().recoverCapture(process.cwd(), value.turn, async () => true))!
    const before = await inventory(value.notes)
    const binding = {
      root: result.root,
      release: value.storage.get<Array<{ release: string }>>("raya.secondBrain.personalCapture.turns")![0].release,
      generation: {},
      owner: "synthetic-current-index-input",
      index: "synced" as const,
      digest: result.policySHA,
    }
    fault.enabled = true
    await expect(new CaptureIntake(value.storage).confirmRecovery(result, binding, () => {})).rejects.toThrow(
      "acknowledgement failure",
    )
    const intake = new CaptureIntake(value.storage)
    const selected = intake.recoverable().find((row) => row.id === value.turn.id)!
    expect(selected.phase).toBe("published")
    const key = `raya.secondBrain.committedCaptureRecovery.${value.turn.id}.confirmation`
    const proof = value.storage.get<object>(key)!
    await value.storage.update(key, { ...proof, policySHA: "0".repeat(64) })
    await expect(value.settings().reviewCapture(process.cwd(), selected)).rejects.toThrow("confirmation required")
    await value.storage.update(key, proof)
    const reviewed = await value.settings().reviewCapture(process.cwd(), selected)
    await intake.confirmRecovery(reviewed, binding, () => {})
    expect(value.storage.get<Array<{ phase: string }>>("raya.secondBrain.personalCapture.turns")![0].phase).toBe(
      "published",
    )
    expect(await inventory(value.notes)).toEqual(before)
  } finally {
    await value.cleanup()
  }
}, 30000)
