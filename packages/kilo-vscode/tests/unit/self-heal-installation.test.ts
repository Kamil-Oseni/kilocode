import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import type { Readable } from "node:stream"
import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { install as runInstall } from "../../src/self-heal/install"
import { SelfHealInstallation, type Plan } from "../../src/self-heal/installation"

const require = createRequire(import.meta.url)
const writer = createRequire(require.resolve("@vscode/vsce"))("yazl") as {
  ZipFile: new () => { addBuffer(buffer: Buffer, name: string): void; end(): void; outputStream: Readable }
}
const worker = join(import.meta.dir, "../fixtures/self-heal-install-worker.ts")

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

async function wait(file: string) {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    if (await exists(file)) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

function launch(input: Record<string, string>) {
  const child = spawn(process.execPath, [worker, JSON.stringify(input)], {
    cwd: join(import.meta.dir, "../.."),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  })
  return new Promise<{ code: number | null; error: string }>((resolve) => {
    const errors: Buffer[] = []
    child.stderr.on("data", (data) => errors.push(Buffer.from(data)))
    child.on("close", (code) => resolve({ code, error: Buffer.concat(errors).toString("utf8") }))
  })
}

async function fixture() {
  const root = await mkdtemp(join(import.meta.dir, ".self-heal-install-"))
  const output = join(root, "repair.vsix")
  const binary = Buffer.from("verified kilo binary")
  const target = `${process.platform}-${process.arch}` as Plan["target"]
  const zip = new writer.ZipFile()
  zip.addBuffer(
    Buffer.from(JSON.stringify({ name: "raya", publisher: "eden", version: "1.2.3" })),
    "extension/package.json",
  )
  zip.addBuffer(
    Buffer.from(
      `<PackageManifest><Metadata><Identity Id="raya" Publisher="eden" Version="1.2.3" TargetPlatform="${target}" /></Metadata></PackageManifest>`,
    ),
    "extension.vsixmanifest",
  )
  zip.addBuffer(binary, `extension/bin/${process.platform === "win32" ? "kilo.exe" : "kilo"}`)
  const done = pipeline(zip.outputStream, createWriteStream(output))
  zip.end()
  await done
  const archive = await readFile(output)
  const plan: Plan = {
    itemID: "heal_ready",
    approvalID: "approval_ready",
    artifactID: "artifact_ready",
    source: "c".repeat(64),
    head: "deadbeef",
    extension: "1.2.3",
    target,
    output,
    artifact: { digest: createHash("sha256").update(archive).digest("hex"), size: archive.length },
    binary: { digest: createHash("sha256").update(binary).digest("hex"), size: binary.length },
    previous: "1.2.2",
  }
  return { root, output, binary, plan }
}

function item(plan: Plan, digest = plan.artifact.digest) {
  const pointer = {
    version: 1,
    itemID: plan.itemID,
    attemptID: "attempt_ready",
    sessionID: "ses_ready",
    messageID: "msg_ready",
    callID: "call_ready",
    completion: "d".repeat(64),
    at: 1,
  }
  return {
    id: plan.itemID,
    title: "Install reviewed repair",
    artifact: {
      ...pointer,
      status: "install-ready",
      artifact: {
        ...pointer,
        id: plan.artifactID,
        checks: [],
        source: plan.source,
        head: plan.head,
        target: plan.target,
        extension: plan.extension,
        cli: plan.extension,
        contract: "verified",
        status: "ready-for-review",
        output: plan.output,
        artifact: { ...plan.artifact, digest },
        binary: plan.binary,
      },
      approval: {
        ...pointer,
        id: plan.approvalID,
        artifactID: plan.artifactID,
        source: plan.source,
        head: plan.head,
        extension: plan.extension,
        artifact: { ...plan.artifact, digest },
        binary: plan.binary,
        status: "install-ready",
      },
    },
  }
}

function client(rows: unknown[], calls: Request[]) {
  return createKiloClient({
    baseUrl: "http://unused.invalid",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return Response.json(rows.shift())
    },
  })
}

test("persists exact install intent, suppresses replay, and verifies activation", async () => {
  const run = await fixture()
  try {
    const journal = new SelfHealInstallation(join(run.root, "state"))
    let calls = 0
    const result = await journal.run(run.plan, async (path) => {
      calls++
      expect(path).toContain(join(run.root, "state", "approved."))
      expect(path).toEndWith(".vsix")
      expect(JSON.parse(await readFile(join(run.root, "state", "installation.json"), "utf8"))).toMatchObject({
        approvalID: run.plan.approvalID,
        artifact: run.plan.artifact,
        binary: run.plan.binary,
        phase: "installing",
      })
      expect(await readFile(path)).toEqual(await readFile(run.output))
    })
    expect(result).toMatchObject({ dispatched: true, record: { phase: "awaiting-reload" } })
    const duplicate = await new SelfHealInstallation(join(run.root, "state")).run(run.plan, async () => {
      calls++
    })
    expect(duplicate).toMatchObject({ dispatched: false, record: { id: result.record.id } })
    expect(calls).toBe(1)

    const active = join(run.root, "kilo.exe")
    await writeFile(active, run.binary)
    expect(await journal.activate("1.2.2", active)).toMatchObject({
      changed: false,
      record: { phase: "awaiting-reload" },
    })
    expect(await journal.activate("1.2.3", active)).toMatchObject({ changed: true, record: { phase: "active" } })
    expect(await journal.activate("1.2.3", active)).toMatchObject({ changed: false, record: { phase: "active" } })
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("concurrent callers dispatch one installer and a failed dispatch remains uncertain", async () => {
  const run = await fixture()
  try {
    const root = join(run.root, "state")
    let calls = 0
    const first = new SelfHealInstallation(root).run(run.plan, async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    const second = new SelfHealInstallation(root).run(run.plan, async () => {
      calls++
    })
    const results = await Promise.all([first, second])
    expect(results.filter((result) => result.dispatched)).toHaveLength(1)
    expect(calls).toBe(1)

    const other = await fixture()
    try {
      const uncertain = new SelfHealInstallation(join(other.root, "state"))
      await expect(
        uncertain.run(other.plan, async () => {
          throw new Error("installer acknowledgement lost")
        }),
      ).rejects.toThrow("installer acknowledgement lost")
      expect(await uncertain.inspect()).toMatchObject({ phase: "installing" })
      const retained = await uncertain.run(other.plan, async () => {
        calls++
      })
      expect(retained).toMatchObject({ dispatched: false, record: { phase: "installing" } })
    } finally {
      await rm(other.root, { recursive: true, force: true })
    }
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("changed artifact bytes fail before dispatch and retain the reason", async () => {
  const run = await fixture()
  try {
    await writeFile(run.output, "changed")
    const journal = new SelfHealInstallation(join(run.root, "state"))
    let dispatched = false
    await expect(
      journal.run(run.plan, async () => {
        dispatched = true
      }),
    ).rejects.toThrow("size does not match")
    expect(dispatched).toBe(false)
    expect(await journal.inspect()).toMatchObject({ phase: "failed", reason: expect.stringContaining("size") })
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("wrong approved CLI digest and interrupted validation fail before replay", async () => {
  const run = await fixture()
  try {
    const root = join(run.root, "state")
    const journal = new SelfHealInstallation(root)
    let dispatched = false
    await expect(
      journal.run({ ...run.plan, binary: { ...run.plan.binary, digest: "0".repeat(64) } }, async () => {
        dispatched = true
      }),
    ).rejects.toThrow("CLI binary does not match")
    expect(dispatched).toBe(false)
    expect(await journal.inspect()).toMatchObject({ phase: "failed", reason: expect.stringContaining("CLI") })

    const other = await fixture()
    try {
      const state = join(other.root, "state")
      const saved = await new SelfHealInstallation(state).run(other.plan, async () => undefined)
      await writeFile(join(state, "installation.json"), JSON.stringify({ ...saved.record, phase: "validating" }))
      expect(
        await new SelfHealInstallation(state).activate(other.plan.previous, join(other.root, "missing.exe")),
      ).toMatchObject({
        changed: true,
        record: { phase: "failed", reason: "Validation was interrupted before installation dispatch." },
      })
    } finally {
      await rm(other.root, { recursive: true, force: true })
    }
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("invalid installation journals remain available for diagnosis", async () => {
  const run = await fixture()
  try {
    const root = join(run.root, "state")
    await new SelfHealInstallation(root).run(run.plan, async () => undefined)
    await writeFile(join(root, "installation.json"), '{"malformed":true}')
    await expect(new SelfHealInstallation(root).inspect()).rejects.toThrow("invalid and was retained")
    expect(await readFile(join(root, "installation.json"), "utf8")).toBe('{"malformed":true}')
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("install UI refreshes the approval after confirmation and cancel dispatches nothing", async () => {
  const run = await fixture()
  try {
    const calls: Request[] = []
    let dispatched = 0
    const result = await runInstall({
      client: client([item(run.plan), item(run.plan)], calls),
      itemID: run.plan.itemID,
      directory: join(run.root, "backend"),
      previous: run.plan.previous,
      journal: new SelfHealInstallation(join(run.root, "state")),
      confirm: async () => true,
      dispatch: async () => {
        dispatched++
      },
    })
    expect(result).toMatchObject({ reload: true, record: { phase: "awaiting-reload" } })
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"])
    expect(dispatched).toBe(1)

    const other = await fixture()
    try {
      const canceled: Request[] = []
      const closed = await runInstall({
        client: client([item(other.plan)], canceled),
        itemID: other.plan.itemID,
        directory: join(other.root, "backend"),
        previous: other.plan.previous,
        journal: new SelfHealInstallation(join(other.root, "state")),
        confirm: async () => false,
        dispatch: async () => {
          dispatched++
        },
      })
      expect(closed.notice).toBe("Installation closed. Nothing was installed.")
      expect(canceled.map((call) => call.method)).toEqual(["GET"])
      expect(await new SelfHealInstallation(join(other.root, "state")).inspect()).toBeUndefined()
      expect(dispatched).toBe(1)
    } finally {
      await rm(other.root, { recursive: true, force: true })
    }
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("changed approval after install confirmation creates no intent", async () => {
  const run = await fixture()
  try {
    const calls: Request[] = []
    let dispatched = false
    const result = await runInstall({
      client: client([item(run.plan), item(run.plan, "e".repeat(64))], calls),
      itemID: run.plan.itemID,
      directory: join(run.root, "backend"),
      previous: run.plan.previous,
      journal: new SelfHealInstallation(join(run.root, "state")),
      confirm: async () => true,
      dispatch: async () => {
        dispatched = true
      },
    })
    expect(result.notice).toContain("approved artifact changed")
    expect(dispatched).toBe(false)
    expect(await new SelfHealInstallation(join(run.root, "state")).inspect()).toBeUndefined()
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("independent extension processes retain one installation and dispatch once", async () => {
  const run = await fixture()
  try {
    const root = join(run.root, "state")
    const plan = join(run.root, "plan.json")
    const go = join(run.root, "go")
    await writeFile(plan, JSON.stringify(run.plan))
    const inputs = ["first", "second"].map((tag) => ({
      root,
      plan,
      go,
      ready: join(run.root, `${tag}-ready`),
      result: join(run.root, `${tag}-result`),
      dispatch: join(run.root, `${tag}-dispatch`),
    }))
    const children = inputs.map(launch)
    await Promise.all(inputs.map((input) => wait(input.ready)))
    await writeFile(go, "go")
    expect(await Promise.all(children)).toEqual([
      { code: 0, error: "" },
      { code: 0, error: "" },
    ])
    const results = await Promise.all(inputs.map(async (input) => JSON.parse(await readFile(input.result, "utf8"))))
    expect(results.filter((result) => result.dispatched)).toHaveLength(1)
    expect(new Set(results.map((result) => result.id)).size).toBe(1)
    expect((await readdir(run.root)).filter((name) => name.endsWith("-dispatch"))).toHaveLength(1)
    expect(await new SelfHealInstallation(root).inspect()).toMatchObject({ phase: "awaiting-reload" })
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
}, 30_000)
