import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises"
import { existsSync, watch } from "node:fs"
import { run, type Launch, type Request } from "../../src/second-brain/media/transport"
import { fingerprint } from "../../src/second-brain/failed-repair"
import { sha } from "../../src/second-brain/control/frames"

const extension = path.resolve(import.meta.dir, "../..")
const python = "D:\\Raya\\Services\\Packaging\\Python\\3.12.14\\python.exe"
// These execute the reviewed native runtime; unsupported hosts cannot simulate its ownership evidence.
const native =
  process.platform === "win32" && existsSync(python) && existsSync(path.join(extension, "bin", "raya-process-host.exe"))
    ? test
    : test.skip
const id = () => randomUUID().replaceAll("-", "")

async function reference(file: string) {
  const raw = await readFile(file)
  return { path: file, bytes: raw.length, sha256: sha(raw) }
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-media-transport-"))
  const root = path.join(dir, "library")
  const source = path.join(dir, "personal")
  const project = path.join(dir, "workspace")
  const dependencies = path.join(dir, "dependencies")
  await Promise.all([root, source, project, dependencies].map((value) => mkdir(value)))
  const raw = Buffer.alloc(32044)
  raw.write("RIFF", 0)
  raw.writeUInt32LE(raw.length - 8, 4)
  raw.write("WAVEfmt ", 8)
  raw.writeUInt32LE(16, 16)
  raw.writeUInt16LE(1, 20)
  raw.writeUInt16LE(1, 22)
  raw.writeUInt32LE(16000, 24)
  raw.writeUInt32LE(32000, 28)
  raw.writeUInt16LE(2, 32)
  raw.writeUInt16LE(16, 34)
  raw.write("data", 36)
  raw.writeUInt32LE(32000, 40)
  const file = path.join(source, "approved.wav")
  await writeFile(file, raw, { flag: "wx" })
  const selection: Request["selection"] = {
    format: "raya.media.selection.v1",
    project,
    source,
    root,
    excluded: [],
    files: [{ path: file, sha256: sha(raw), bytes: raw.length, kind: "audio", title: "Approved fixture" }],
  }
  const media = path.join(extension, "script", "memory", "media")
  const cfg: Launch = {
    format: "raya.media.launch.v1",
    root,
    dependencies,
    python: await reference(python),
    sources: {
      "supervisor.py": await reference(path.join(media, "supervisor.py")),
      "worker.py": await reference(path.join(media, "worker.py")),
      "session.py": await reference(path.join(media, "session.py")),
      "library.py": await reference(path.join(media, "library.py")),
      "encoder.py": await reference(path.join(media, "encoder.py")),
      "owner.py": await reference(path.join(media, "..", "retrieval", "owner.py")),
    },
  }
  const request = (op: Request["op"]): Request => ({
    format: "raya.media.operation.v1",
    request: id(),
    epoch: id(),
    release: "a".repeat(64),
    policySHA: fingerprint(selection),
    op,
    selection,
    args: { id: sha(raw) },
    model: null,
  })
  return { dir, cfg, request, raw, file }
}

native(
  "actual contained media inspect/import/forget certifies original joins and exact durable publications",
  async () => {
    const fixture = await setup()
    for (const op of ["inspect", "import", "forget"] as const) {
      const input = fixture.request(op)
      const held: unknown[] = []
      const result = await run(
        extension,
        fixture.cfg,
        input,
        new AbortController().signal,
        async () => {},
        async (value) => {
          held.push(value)
        },
      )
      expect(held).toHaveLength(1)
      expect(result.terminal.accepted).toBe(true)
      expect(result.terminal.status).toBe("completed")
      const family = result.terminal.ownership as Record<string, unknown>
      expect(family.creation).toMatchObject({ succeeded: true, creation_time_job_list: true })
      expect(family).toMatchObject({
        job_active: 0,
        root_exit: 0,
        membership_observed: true,
        joins_observed: true,
        writer_joined: true,
        ownership_retained: false,
      })
      const receipt = JSON.parse(await readFile(result.receipt.path, "utf8"))
      expect(receipt).toMatchObject({
        originalJoined: true,
        readersJoined: true,
        writerJoined: true,
        forced: false,
        requestSettlement: false,
        replay: false,
      })
      expect(receipt.eof).toEqual({ stdout: true, stderr: true })
      expect(receipt.evidence).toHaveLength(2)
      for (const ref of receipt.evidence) expect(sha(await readFile(ref.path))).toBe(ref.sha256)
      const folder = path.join(fixture.cfg.root, "Requests", input.epoch)
      expect(JSON.parse(await readFile(path.join(folder, input.request + ".terminal.json"), "utf8"))).toEqual(
        result.terminal,
      )
      expect(await readFile(fixture.file)).toEqual(fixture.raw)
    }
  },
  60000,
)

native(
  "expired original media acceptance retains uncertainty and refuses a new owner when debt is unclosed",
  async () => {
    const fixture = await setup()
    const input = fixture.request("inspect")
    const failure = await run(
      extension,
      fixture.cfg,
      input,
      new AbortController().signal,
      async () => {},
      async () => {},
      1,
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(AggregateError)
    const rejected = failure as AggregateError & { receipt: { path: string }; terminal?: Record<string, unknown> }
    const receipt = JSON.parse(await readFile(rejected.receipt.path, "utf8"))
    expect(receipt.forced).toBe(false)
    expect(receipt.exit).toEqual({ code: 0, signal: null })
    expect(receipt.eof).toEqual({ stdout: true, stderr: true })
    expect(rejected.terminal?.accepted).not.toBe(true)
    const requests = path.join(fixture.cfg.root, "Requests")
    if ((await readdir(requests)).includes("active.json")) {
      const next = await run(
        extension,
        fixture.cfg,
        fixture.request("inspect"),
        new AbortController().signal,
        async () => {},
        async () => {},
      ).catch((err: unknown) => err)
      expect(next).toBeInstanceOf(AggregateError)
      expect(await readFile(path.join(requests, "active.json"))).toBeTruthy()
    }
  },
  60000,
)

native(
  "STOP after actual worker admission joins the owned family without accepting or replaying its result",
  async () => {
    const fixture = await setup()
    const input = fixture.request("inspect")
    const controller = new AbortController()
    const observations: unknown[] = []
    const errors: unknown[] = []
    const jobs: Promise<void>[] = []
    const folder = path.join(fixture.cfg.root, "Runs", input.epoch, input.request)
    let watcher: ReturnType<typeof watch> | undefined
    const failure = await run(
      extension,
      fixture.cfg,
      input,
      controller.signal,
      async () => {},
      async () => {
        watcher = watch(path.join(fixture.cfg.root, "Runs"), { recursive: true }, (_event, name) => {
          if (!name || !/\d{6}\.json$/.test(String(name))) return
          jobs.push(
            readFile(path.join(fixture.cfg.root, "Runs", String(name)), "utf8")
              .then((raw) => {
                const value = JSON.parse(raw)
                if (value.work_admitted !== true || value.phase !== "admission_sent") return
                observations.push(value)
                controller.abort()
              })
              .catch((err: unknown) => {
                // Creation notifications can precede completion of the exclusive immutable write.
                if (!(err instanceof SyntaxError)) errors.push(err)
              }),
          )
        })
      },
    ).catch((err: unknown) => err)
    watcher?.close()
    await Promise.all(jobs)
    expect(errors).toEqual([])
    expect(observations.length).toBeGreaterThan(0)
    expect(failure).toBeInstanceOf(AggregateError)
    const rejected = failure as AggregateError & { receipt: { path: string }; terminal: Record<string, unknown> }
    const receipt = JSON.parse(await readFile(rejected.receipt.path, "utf8"))
    expect(receipt).toMatchObject({
      originalJoined: true,
      readersJoined: true,
      writerJoined: true,
      forced: false,
      requestSettlement: false,
      replay: false,
    })
    expect(receipt.exit).toEqual({ code: 0, signal: null })
    expect(receipt.eof).toEqual({ stdout: true, stderr: true })
    expect(rejected.terminal).toMatchObject({ accepted: false, status: "failed", forced: false })
    expect(rejected.terminal.ownership).toMatchObject({
      job_active: 0,
      root_exit: 0,
      joins_observed: true,
      writer_joined: true,
      ownership_retained: false,
    })
    expect(receipt.evidence).toHaveLength(2)
    expect(await readdir(folder)).toContain("000001.json")
    const audit = path.join(fixture.cfg.root, "Requests", input.epoch)
    expect(JSON.parse(await readFile(path.join(audit, input.request + ".terminal.json"), "utf8"))).toEqual(
      rejected.terminal,
    )
    expect(JSON.parse(await readFile(path.join(audit, input.request + ".stop.json"), "utf8"))).toMatchObject({
      request: input.request,
      epoch: input.epoch,
    })
  },
  60000,
)

native(
  "unknown request debt refuses START and retains the original unresolved audit",
  async () => {
    const fixture = await setup()
    const folder = path.join(fixture.cfg.root, "Requests", id())
    await mkdir(folder, { recursive: true })
    const debt = path.join(folder, "unknown.json")
    await writeFile(debt, "retained unresolved original", { flag: "wx" })
    const failure = await run(
      extension,
      fixture.cfg,
      fixture.request("inspect"),
      new AbortController().signal,
      async () => {},
      async () => {},
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(AggregateError)
    const receipt = JSON.parse(await readFile((failure as { receipt: { path: string } }).receipt.path, "utf8"))
    expect(receipt.familyJoined).toBe(false)
    expect(receipt.exit.code).toBe(1)
    expect(receipt.evidence).toEqual([])
    expect(receipt.family).toBeNull()
    expect(receipt.forced).toBe(false)
    expect(await readFile(debt, "utf8")).toBe("retained unresolved original")
  },
  60000,
)

native(
  "a durable original publication changed after closure cannot be consumed",
  async () => {
    const fixture = await setup()
    const input = fixture.request("inspect")
    const pending = path.join(fixture.cfg.root, "Requests", input.epoch, input.request + ".pending.json")
    let checks = 0
    const failure = await run(
      extension,
      fixture.cfg,
      input,
      new AbortController().signal,
      async () => {
        checks += 1
        if (checks === 3) await writeFile(pending, Buffer.concat([await readFile(pending), Buffer.from(" ")]))
      },
      async () => {},
    ).catch((err: unknown) => err)
    expect(checks).toBe(3)
    expect(failure).toBeInstanceOf(AggregateError)
    const rejected = failure as AggregateError & { receipt: { path: string }; terminal: Record<string, unknown> }
    expect(rejected.terminal.accepted).toBe(true)
    const receipt = JSON.parse(await readFile(rejected.receipt.path, "utf8"))
    expect(receipt.familyJoined).toBe(true)
    expect(receipt.evidence).toHaveLength(2)
    expect(sha(await readFile(pending))).not.toBe(receipt.evidence[0].sha256)
    expect(receipt.requestSettlement).toBe(false)
    expect(receipt.replay).toBe(false)
  },
  60000,
)
