import { expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DraftSchemas, type DraftContent, type DraftIdentity } from "@/kilocode/session/composer-drafts"
import type { Request } from "./composer-retention-worker"

const identity: DraftIdentity = {
  key: "pending",
  box: "prompt:default",
  workspace: "private-project",
  projectID: "private",
  pendingID: "pending",
}
const content: DraftContent = {
  text: "  exact rich draft\n",
  comments: [],
  images: [
    { id: "file", filename: "practice.txt", mime: "text/plain", dataUrl: "data:text/plain;base64,cHJhY3RpY2U=" },
  ],
  scroll: 2,
}
const destination: DraftIdentity = { ...identity, key: "session", pendingID: undefined, sessionID: "session" }

function absent(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "ESRCH"
  }
}
async function bounded<A>(work: Promise<A>, ms = 20_000) {
  const timer: { value?: ReturnType<typeof setTimeout> } = {}
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer.value = setTimeout(() => reject(new Error("Private retention process deadline")), ms)
    }),
  ]).finally(() => clearTimeout(timer.value))
}
async function group<A>(tasks: Promise<A>[]) {
  const results = await Promise.allSettled(tasks)
  return results.map((result) => {
    if (result.status === "fulfilled") return result.value
    throw result.reason
  })
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-retention-process-"))
  const dir = path.join(root, "storage")
  const file = path.join(root, "shared.sqlite")
  const jobs: Array<{ child: Bun.Subprocess; out: Promise<string>; err: Promise<string>; receipt: string }> = []
  const start = async (name: string, opts: Partial<Request>) => {
    const home = path.join(root, name)
    const temp = path.join(home, "temp")
    await mkdir(temp, { recursive: true })
    const receipt = path.join(root, `${name}-receipt.json`)
    const request = path.join(root, `${name}-request.json`)
    await Bun.write(
      request,
      JSON.stringify({ dir, file, receipt, who: identity, content, mutation: name, operation: "load", ...opts }),
    )
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE)$/i.test(key),
      ),
    )
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "composer-retention-worker.ts"), request], {
      cwd: path.resolve(import.meta.dir, "../.."),
      windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...env,
        KILO_TEST_HOME: home,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "roaming"),
        LOCALAPPDATA: path.join(home, "local"),
        TEMP: temp,
        TMP: temp,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        KILO_DB: file,
        RAYA_DB: file,
        KILO_AUTH_CONTENT: "{}",
        RAYA_AUTH_CONTENT: "{}",
        KILO_CONFIG_CONTENT: "{}",
        RAYA_CONFIG_CONTENT: "{}",
        KILO_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_PURE: "1",
      },
    })
    const job = { child, out: new Response(child.stdout).text(), err: new Response(child.stderr).text(), receipt }
    jobs.push(job)
    return job
  }
  const join = async (job: (typeof jobs)[number], killed = false) => {
    const exit = await bounded(job.child.exited)
    const [out, err] = await bounded(Promise.all([job.out, job.err]))
    if (!killed && exit !== 0) throw new Error(`Private retention worker exited ${exit}: ${err || out}`)
    expect(absent(job.child.pid)).toBe(true)
  }
  const call = async (name: string, opts: Partial<Request>) => {
    const job = await start(name, opts)
    await join(job)
    const result: { ok: boolean; code?: string; value?: unknown } = await Bun.file(job.receipt).json()
    return result
  }
  return {
    root,
    dir,
    file,
    start,
    join,
    call,
    async [Symbol.asyncDispose]() {
      await group(
        jobs.map(async (job) => {
          if (job.child.exitCode === null) job.child.kill("SIGKILL")
          await join(job, true)
        }),
      )
      if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
        throw new Error("Private retention profile escaped temp root")
      await rm(root, { recursive: true, force: true })
      console.info(
        "Private retention cleanup",
        JSON.stringify({ pids: jobs.map((job) => job.child.pid), joined: true, absent: true, removed: true }),
      )
    },
  }
}

test("independent processes share one SQLite and JSON owner for CAS and promotion contention", async () => {
  await using tmp = await fixture()
  const seed = await tmp.call("seed", { operation: "save" })
  expect(seed.ok).toBe(true)
  const saved = DraftSchemas.entry.parse(seed.value)
  const writes = await group(
    ["one", "two"].map((name) =>
      tmp.call(name, { operation: "save", token: saved.token, content: { ...content, text: name } }),
    ),
  )
  expect(writes.filter((item) => item.ok)).toHaveLength(1)
  expect(writes.find((item) => !item.ok)?.code).toBe("conflict")
  const winner = DraftSchemas.entry.parse(writes.find((item) => item.ok)?.value)
  const loaded = await tmp.call("reload", {})
  expect(loaded.value).toEqual(winner)
  expect((await tmp.call("stale", { operation: "save", token: saved.token })).code).toBe("conflict")
  const race = await group([
    tmp.call("promotion", { operation: "promote", token: winner.token, target: destination }),
    tmp.call("destination", {
      operation: "save",
      who: destination,
      content: { ...content, text: "destination owns this" },
    }),
  ])
  expect(race.filter((item) => item.ok)).toHaveLength(1)
  expect(race.find((item) => !item.ok)?.code).toBe("conflict")
  const source = await tmp.call("source-after", {})
  const target = await tmp.call("target-after", { who: destination })
  if (race[0].ok) {
    expect(DraftSchemas.entry.parse(source.value).content).toBeNull()
    expect(DraftSchemas.entry.parse(target.value).content).toEqual(winner.content)
    return
  }
  expect(source.value).toEqual(winner)
  expect(DraftSchemas.entry.parse(target.value).content?.text).toBe("destination owns this")
}, 90_000)

for (const stage of ["imported", "source-retired", "verified"]) {
  test(`a killed process at ${stage} resumes exact legacy evidence without accepting stale creation`, async () => {
    await using tmp = await fixture()
    const seed = await tmp.call("legacy", { operation: "legacy" })
    const saved = DraftSchemas.entry.parse(seed.value)
    const original = await readFile(path.join(tmp.dir, "raya/composer-drafts.json"))
    const checkpoint = path.join(tmp.root, "checkpoint.txt")
    const job = await tmp.start("cutover", { checkpoint: { stage, file: checkpoint } })
    await bounded(
      (async () => {
        while (!(await Bun.file(checkpoint).exists())) {
          if (job.child.exitCode !== null)
            throw new Error("Retention worker exited before requested cutover checkpoint")
          await Bun.sleep(20)
        }
      })(),
    )
    expect(await Bun.file(checkpoint).text()).toBe(stage)
    job.child.kill("SIGKILL")
    await tmp.join(job, true)
    const database = new SQLite(tmp.file, { readonly: true })
    try {
      const evidence = database
        .query<{ source: string }, []>("SELECT source FROM raya_composer_control WHERE id = 'profile-v1'")
        .get()
      expect(evidence).not.toBeNull()
      expect(Buffer.from(evidence!.source, "utf8")).toEqual(original)
    } finally {
      database.close()
    }
    if (stage === "imported") expect(await readFile(path.join(tmp.dir, "raya/composer-drafts.json"))).toEqual(original)
    const recovered = await tmp.call("recovered", {})
    expect(recovered.ok).toBe(true)
    expect(recovered.value).toEqual(saved)
    expect((await tmp.call("undefined-cas", { operation: "save" })).code).toBe("conflict")
    const clear = await tmp.call("clear", { operation: "clear", token: saved.token })
    expect(clear.ok).toBe(true)
    const tombstone = DraftSchemas.entry.parse(clear.value)
    expect(tombstone.content).toBeNull()
    expect((await tmp.call("restart-stale", { operation: "save", token: saved.token })).code).toBe("conflict")
    expect((await tmp.call("restart-load", {})).value).toEqual(tombstone)
    expect((await Bun.file(path.join(tmp.dir, "raya/composer-drafts.json")).json()).version).toBe(2)
    expect((await Bun.file(path.join(tmp.dir, "raya/composer-drafts-initialized.json")).json()).version).toBe(2)
  }, 90_000)
}
