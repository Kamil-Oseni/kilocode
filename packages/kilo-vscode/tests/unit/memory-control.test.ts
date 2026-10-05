import { test, expect } from "bun:test"
import { mkdir, mkdtemp, writeFile, readFile, rename } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { decode, canonical, child, object, sha } from "../../src/second-brain/control/frames"
import { Transport, held } from "../../src/second-brain/control/transport"
import { protect } from "../../src/second-brain/control/protection"
import { observe } from "../../src/second-brain/control/identity"
import { Control, parseCatalog } from "../../src/second-brain/control/index"
import { spawn } from "../../src/util/process"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
const inspect = NativeProcess.inspect
type Owner = Transport

const file = process.env.RAYA_MEMORY_CONTROL_CATALOG
const catalog = file ? parseCatalog(JSON.parse(await readFile(file, "utf8"))) : undefined
const extension = process.env.RAYA_MEMORY_CONTROL_EXTENSION
const integration = catalog && extension ? test : test.skip
const helper = extension ? path.join(extension, "bin", "raya-process-host.exe") : ""
const records: unknown[] = []
const Owner = {
  async open(root: string, _helper: string, _digest: string) {
    if (!catalog || !extension) throw new Error("Explicit synthetic test dependencies required")
    return Control.open(root, catalog, extension)
  },
  async protocol(root: string, _helper: string, _digest: string, mode: string) {
    if (!catalog) throw new Error("Explicit synthetic test catalog required")
    const tmp = await mkdtemp(path.join(os.tmpdir(), "raya-memory-control-fault-"))
    await protect(tmp)
    const bootstrap = path.join(tmp, "bootstrap.private.json")
    await writeFile(
      bootstrap,
      JSON.stringify({
        format: "raya.memory.control.setup",
        version: 1,
        root,
        source_dir: catalog.source,
        source_sha256: catalog.source_sha256,
      }),
      { flag: "wx", mode: 0o600 },
    )
    const child = spawn(
      catalog.python,
      [
        "-I",
        "-u",
        path.join(import.meta.dir, "fixtures", "memory-control-protocol.py"),
        mode,
        root,
        bootstrap,
        catalog.bridge,
      ],
      {
        cwd: tmp,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: path.join(process.env.SystemRoot!, "System32"),
          TEMP: tmp,
          TMP: tmp,
        },
      },
    )
    const owner = new Transport(child, root)
    try {
      owner.bind(await observe(child, catalog.python, helper, catalog.python_sha256))
      return owner
    } catch (err) {
      const result = await owner.close()
      throw new AggregateError(
        [err, new Error("Actual closure code=" + result.code)],
        "Test identity and closure retained",
      )
    }
  },
}
const digest = catalog?.python_sha256 ?? ""

test("catalog requires an explicit reviewed release and ordinary local paths without adopting current source hashes", async () => {
  const pins: Record<string, unknown> = JSON.parse(
    await readFile(path.join(import.meta.dir, "fixtures", "memory-control-release.json"), "utf8"),
  )
  const input = {
    ...pins,
    python: path.join(os.tmpdir(), "python.exe"),
    source: path.join(os.tmpdir(), "reviewed-source"),
    bridge: path.join(os.tmpdir(), "bridge.py"),
  }
  const result = parseCatalog(input)
  expect(Object.isFrozen(result) && Object.isFrozen(result.source_sha256)).toBe(true)
  for (const value of [
    { ...input, extra: true },
    { ...input, version: 2 },
    { ...input, python: "python.exe" },
    { ...input, source: "\\\\remote\\source" },
    { ...input, bridge: "//remote/bridge.py" },
    { ...input, python_sha256: "0".repeat(64) },
    { ...input, source_sha256: { ...result.source_sha256, "host.py": "0".repeat(64) } },
    { ...input, source_sha256: { ...result.source_sha256, "extra.py": "0".repeat(64) } },
  ])
    expect(() => parseCatalog(value)).toThrow()
})
async function root() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-memory-control-synthetic-"))
  const acl = await protect(dir)
  await mkdir(path.join(dir, "System"))
  return { dir, acl }
}
async function closed(owner: Owner) {
  const before = owner.snapshot()
  const result = await owner.close()
  expect(result.signal).toBeNull()
  expect(result.stdout && result.stderr).toBe(true)
  expect(before.identity).toBeDefined()
  const native = await inspect(before.identity!.pid, helper)
  expect(native !== null && typeof native === "object" && "status" in native && native.status === "gone").toBe(true)
  records.push({
    identity: before.identity,
    result,
    history: owner.snapshot().history,
    mutationUncertain: owner.snapshot().mutationUncertain,
    originalBirthAbsent: true,
    syntheticHumanConsent: false,
    backendWorkerRetirementClaimed: false,
  })
  return result
}
test("strict parser rejects duplicate, invalid UTF8, comments, trailing commas, nonfinite and structural overflow", () => {
  for (const raw of [
    Buffer.from('{"a":1,"a":2}\n'),
    Buffer.from('{"x":{"a":1,"a":2}}\n'),
    Buffer.from('{/*x*/"a":1}\n'),
    Buffer.from('{"a":1,}\n'),
    Buffer.from('{"a":1e999}\n'),
    Buffer.from('{"a":NaN}\n'),
    Buffer.from('{"x":' + "[".repeat(33) + "0" + "]".repeat(33) + "}\n"),
    Buffer.from('{"x":[' + Array(20001).fill(0).join(",") + "]}\n"),
    Buffer.from([255, 10]),
  ])
    expect(() => decode(raw)).toThrow()
  expect(() => decode(Buffer.from("{}\n{}\n"))).toThrow()
  expect(() => decode(Buffer.from("{}"))).toThrow()
  expect(() => decode(Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("{}\n")]))).toThrow()
  expect(() =>
    decode(
      Buffer.from(
        JSON.stringify(Object.fromEntries(Array.from({ length: 7000 }, (_, index) => [String(index), 0]))) + "\n",
      ),
    ),
  ).toThrow()
})
test("exact AST canonicalization preserves Python nanoseconds and Unicode policy bytes", () => {
  const text = '{"b":"café日本😀","a":1791030000123456789}\n'
  const parsed = decode(Buffer.from(text))
  expect(canonical(parsed.tree, text)).toBe('{"a":1791030000123456789,"b":"café日本😀"}')
  expect(canonical(parsed.tree, text, true)).toBe(
    '{"a":1791030000123456789,"b":"caf\\u00e9\\u65e5\\u672c\\ud83d\\ude00"}',
  )
  expect(child(parsed.tree, "a").value).not.toBe(1791030000123456789n)
})
integration(
  "actual pinned bridge executes all five operations only on protected synthetic sources",
  async () => {
    const fixture = await root()
    const names = ["café.md", "日本.md", "third.md"]
    for (const [index, name] of names.entries())
      await writeFile(path.join(fixture.dir, name), "Synthetic only " + index + " 😀\n", { flag: "wx" })
    const owner = await Owner.open(fixture.dir, helper, digest)
    const failures: unknown[] = []
    try {
      const state = await owner.state()
      expect(state.capture_enabled).toBe(false)
      expect(state.policy_sha256).toBeNull()
      const first = await owner.preview(names, false)
      expect(first.namespace.root.every((value) => value === null || /^\d{1,20}$/.test(value))).toBe(true)
      expect(first.namespace.system.every((value) => value === null || /^\d{1,20}$/.test(value))).toBe(true)
      expect(Object.isFrozen(first.namespace.root) && Object.isFrozen(first.namespace)).toBe(true)
      expect((await owner.discard(first.ticket)).discarded).toBe(true)
      await expect(owner.approve(first.ticket)).rejects.toThrow("Original live review")
      const next = await owner.preview(names, true)
      const accepted = await owner.approve(next.ticket)
      expect(accepted.status).toBe("policy_published")
      expect(accepted.sync_started).toBe(false)
      expect((await owner.state()).policy_sha256).toBe(accepted.policy_sha256)
      const disabling = await owner.preview(names, false)
      const context = owner.metadata(disabling.ticket)
      const paused = await owner.pause(String(accepted.policy_sha256), undefined, context)
      expect(paused.enabled).toBe(false)
      expect(paused.host_join_required).toBe(true)
      expect(paused.policy_sha256).toBe(context.prospective)
      expect(paused.revision).toBe(context.revision)
      await owner.discard(disabling.ticket)
      await expect(owner.approve(Object.freeze({ generation: 1 }))).rejects.toThrow("Original live review")
    } catch (err) {
      failures.push(err)
    }
    await closed(owner)
      .then((result) => expect(result.code).toBe(0))
      .catch((err) => failures.push(err))
    if (failures.length) throw new AggregateError(failures, "Roundtrip and closure outcomes retained")
  },
  60000,
)
integration(
  "namespace rebind refuses without repair and preserves original control failure",
  async () => {
    const fixture = await root()
    const owner = await Owner.open(fixture.dir, helper, digest)
    await rename(path.join(fixture.dir, "System"), path.join(fixture.dir, "System-original"))
    await expect(owner.state()).rejects.toThrow("Control refused")
    await expect(owner.state()).rejects.toThrow("fenced")
    expect((await closed(owner)).code).toBe(0)
    expect(await Bun.file(path.join(fixture.dir, "System", "general-admission.json")).exists()).toBe(false)
  },
  30000,
)
integration(
  "real protocol faults fence intake and retain child through ordinary pipe closure",
  async () => {
    for (const mode of ["duplicate", "oversize", "partial", "wrong", "extra", "invalid", "dead"] as const) {
      const fixture = await root()
      const owner = await Owner.protocol(fixture.dir, helper, digest, mode)
      await expect(owner.state()).rejects.toThrow()
      expect(owner.snapshot().fenced).toBe(true)
      await expect(owner.state()).rejects.toThrow("fenced")
      expect((await closed(owner)).code).toBe(mode === "dead" ? 23 : 0)
    }
  },
  120000,
)
integration(
  "actual delayed reply deadline retains one flight, rejects replacement and joins late closure",
  async () => {
    const fixture = await root()
    const owner = await Owner.protocol(fixture.dir, helper, digest, "hold")
    const operation = owner.state()
    await expect(owner.state()).rejects.toThrow("busy")
    await expect(operation).rejects.toThrow("Observation expired")
    expect(owner.snapshot().pending?.op).toBe("state")
    expect(held().some((row) => row.identity?.pid === owner.snapshot().identity?.pid)).toBe(true)
    await expect(owner.state()).rejects.toThrow("fenced")
    expect((await closed(owner)).code).toBe(0)
    expect(owner.snapshot().history).toHaveLength(1)
  },
  30000,
)
integration(
  "actual child exit cannot certify inherited pipe EOF",
  async () => {
    const fixture = await root()
    const owner = await Owner.protocol(fixture.dir, helper, digest, "pipes")
    const start = performance.now()
    await expect(owner.state()).rejects.toThrow("Child exited")
    expect((await closed(owner)).code).toBe(0)
    expect(performance.now() - start).toBeGreaterThan(2000)
  },
  30000,
)
integration(
  "genuine publication with a lost approval reply retains immutable reconciliation metadata after ordinary closure",
  async () => {
    const fixture = await root()
    await writeFile(path.join(fixture.dir, "synthetic.md"), "Only disposable synthetic review\n", { flag: "wx" })
    const owner = await Owner.protocol(fixture.dir, helper, digest, "lost")
    const initial = await owner.preview(["synthetic.md"], false)
    expect((await owner.approve(initial.ticket)).status).toBe("policy_published")
    const before = await owner.state()
    expect(typeof before.policy_sha256).toBe("string")
    const preview = await owner.preview(["synthetic.md"], true)
    const prior = object(before.policy)
    const plan = object(preview.value.preview)
    const operation = owner.approve(preview.ticket)
    await expect(operation).rejects.toThrow("Observation expired")
    const raw = await readFile(path.join(fixture.dir, "System", "general-admission.json"))
    expect(sha(raw)).toBe(String(plan.prospective_policy_sha256))
    const entry = owner.snapshot().history.at(-1)!
    expect(entry.mutation).toEqual({
      expected: before.policy_sha256 === null ? null : String(before.policy_sha256),
      prospective: String(plan.prospective_policy_sha256),
      revision: Number(prior.revision) + 1,
      enabled: true,
      namespace: preview.namespace,
    })
    expect(entry.outcome?.state).toBe("observation_expired")
    expect(owner.snapshot().mutationUncertain).toBe(true)
    await expect(owner.state()).rejects.toThrow("fenced")
    expect((await closed(owner)).code).toBe(0)
    expect(owner.snapshot().history.at(-1)!.mutation).toEqual(entry.mutation)
    expect(owner.snapshot().history.at(-1)!.verified).toBe(false)
    expect(owner.snapshot().history.at(-1)!.outcome?.state).toBe("failed")
    expect(owner.snapshot().history.filter((row) => row.op === "approve")).toHaveLength(2)
  },
  60000,
)
integration(
  "actual identity refusal preserves original cause together with nonzero held child closure",
  async () => {
    const fixture = await root()
    const err = await Owner.protocol(fixture.dir, helper, digest, "identity").then(
      () => {
        throw new Error("Expected genuine child identity refusal")
      },
      (cause: unknown) => cause,
    )
    expect(err).toBeInstanceOf(AggregateError)
    const failure = err as AggregateError
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0]).toBeInstanceOf(Error)
    expect((failure.errors[1] as Error).message).toContain("code=23")
    expect(held()).toEqual([])
  },
  30000,
)

integration(
  "journal failure prevents genuine policy publication",
  async () => {
    const fixture = await root()
    await writeFile(path.join(fixture.dir, "synthetic.md"), "Disposable journal test\n", { flag: "wx" })
    const owner = await Owner.open(fixture.dir, helper, digest)
    const preview = await owner.preview(["synthetic.md"], true)
    const metadata = owner.metadata(preview.ticket)
    const failures: unknown[] = []
    try {
      await expect(
        owner.approve(preview.ticket, async (request) => {
          expect(Object.isFrozen(request) && Object.isFrozen(request.mutation)).toBe(true)
          expect(request.mutation.prospective).toBe(metadata.prospective)
          throw new Error("Retained synthetic journal refusal")
        }),
      ).rejects.toThrow()
      expect(owner.snapshot().history.at(-1)?.accepted).toBe(false)
      expect(owner.snapshot().history.at(-1)?.outcome?.state).toBe("not_sent")
      expect(owner.snapshot().mutationUncertain).toBe(false)
      expect(await Bun.file(path.join(fixture.dir, "System", "general-admission.json")).exists()).toBe(false)
    } catch (err) {
      failures.push(err)
    }
    await closed(owner).catch((err) => failures.push(err))
    if (failures.length) throw new AggregateError(failures, "Journal and closure results retained")
  },
  30000,
)

integration(
  "a host fence during the original journal prevents late stdin publication and replacement",
  async () => {
    const fixture = await root()
    await writeFile(path.join(fixture.dir, "synthetic.md"), "Only disposable fenced journal\n", { flag: "wx" })
    const owner = await Owner.open(fixture.dir, helper, digest)
    const preview = await owner.preview(["synthetic.md"], true)
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const failures: unknown[] = []
    try {
      const operation = owner.approve(preview.ticket, async () => {
        entered.resolve()
        await gate.promise
      })
      await entered.promise
      owner.fence()
      await expect(Owner.open(fixture.dir, helper, digest)).rejects.toThrow("remains owned")
      gate.resolve()
      await expect(operation).rejects.toThrow("Journal completed after intake fence")
      expect(owner.snapshot().history.at(-1)?.accepted).toBe(false)
      expect(owner.snapshot().history.at(-1)?.outcome?.state).toBe("not_sent")
      expect(await Bun.file(path.join(fixture.dir, "System", "general-admission.json")).exists()).toBe(false)
    } catch (err) {
      failures.push(err)
    }
    gate.resolve()
    await closed(owner).catch((err) => failures.push(err))
    if (failures.length) throw new AggregateError(failures, "Host fence and ordinary closure retained")
  },
  30000,
)

integration(
  "expired original journal remains held through ordinary child and pipe closure",
  async () => {
    const fixture = await root()
    await writeFile(path.join(fixture.dir, "synthetic.md"), "Disposable held journal\n", { flag: "wx" })
    const owner = await Owner.open(fixture.dir, helper, digest)
    const preview = await owner.preview(["synthetic.md"], true)
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const failures: unknown[] = []
    try {
      const operation = owner.approve(preview.ticket, async () => {
        entered.resolve()
        await gate.promise
      })
      await entered.promise
      await expect(operation).rejects.toThrow("Observation expired")
      expect(owner.snapshot().history.at(-1)?.accepted).toBe(false)
      const closing = closed(owner)
      let done = false
      void closing.then(
        () => {
          done = true
        },
        () => {
          done = true
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(done).toBe(false)
      expect(held().some((row) => row.launchPid === owner.snapshot().launchPid)).toBe(true)
      gate.resolve()
      expect((await closing).code).toBe(0)
      expect(held().some((row) => row.launchPid === owner.snapshot().launchPid)).toBe(false)
      expect(await Bun.file(path.join(fixture.dir, "System", "general-admission.json")).exists()).toBe(false)
    } catch (err) {
      failures.push(err)
    }
    gate.resolve()
    await owner.close().catch((err) => failures.push(err))
    if (failures.length) throw new AggregateError(failures, "Held journal and closure results retained")
  },
  30000,
)

integration(
  "module retirement fences synchronously and joins an accepted factory opening before ordinary closure",
  async () => {
    const fixture = await root()
    if (!catalog || !extension) throw new Error("Explicit synthetic test release required")
    const pending = Control.open(fixture.dir, catalog, extension)
    const stopping = Control.drain()
    expect(() => Control.open(fixture.dir, catalog, extension)).toThrow("remains owned")
    const owner = await pending
    await stopping
    expect(owner.snapshot().fenced).toBe(true)
    expect((await closed(owner)).code).toBe(0)
    expect(held()).toEqual([])
    expect(Control.drain()).toBe(stopping)
  },
  30000,
)

integration("owner registry is empty only after every actual child and pipe joined", async () => {
  expect(held()).toEqual([])
  const output = process.env.RAYA_MEMORY_CONTROL_TEST_RECEIPT
  if (output)
    await writeFile(
      output,
      JSON.stringify(
        {
          passed: true,
          records,
          syntheticOnly: true,
          syntheticAuthorityNotHumanConsent: true,
          fullyPausedClaimed: false,
          sourceLaunched: false,
          forced: false,
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    )
})
