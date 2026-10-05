import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import z from "zod"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { exportSource } from "@opencode-ai/core/kilocode/source-export"

const sum = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const proof = (value: Awaited<ReturnType<typeof exportSource>>) => ({
  result: value.result,
  receiverCode: value.code,
  familyZeroObserved: value.family.familyZeroObserved,
  members: value.family.members,
  memberObservationsComplete: value.family.memberObservationsComplete,
  forced: false,
})
if (process.env.RAYA_TEST_GOAL_STOP_SEED === "1") {
  const { Effect } = await import("effect")
  const { AppRuntime } = await import("../../../src/effect/app-runtime")
  const { InstanceStore } = await import("../../../src/project/instance-store")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { Storage } = await import("../../../src/storage/storage")
  const { Session } = await import("../../../src/session/session")
  const { RayaTaskRunner } = await import("../../../src/kilocode/task/runner")
  const { RayaTaskExecution } = await import("../../../src/kilocode/task/execution")
  const { RayaGoal } = await import("../../../src/kilocode/goal")
  const { Server } = await import("../../../src/server/server")
  const dir = process.env.RAYA_TEST_WORKSPACE!
  const app = Server.Default().app
  const headers = { "content-type": "application/json", "x-kilo-directory": dir }
  assert.equal((await app.request("/config", { headers })).status, 200)
  const seeded = await AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: dir },
        Effect.gen(function* () {
          const database = yield* Database.Service
          const storage = yield* Storage.Service
          const sessions = yield* Session.Service
          const runner = RayaTaskRunner.make({ database, storage, sessions })
          const execution = RayaTaskExecution.make(storage)
          const goals = RayaGoal.make({ storage, sessions })
          const agent = yield* runner.tasks.create({
            name: "GOAL_STOP café 日本語 😀",
            objective: "Retain unverified historical request",
            schedule: { kind: "manual" },
            enabled: false,
            tools: [],
            access: "brief",
          })
          const id = crypto.randomUUID()
          const trigger = { kind: "manual" as const }
          const session = yield* sessions.create({
            metadata: {
              rayaRoutine: {
                version: 2,
                agentID: agent.id,
                runID: id,
                scheduleVersion: agent.scheduleVersion ?? 1,
                trigger,
              },
            },
          })
          const row = {
            id,
            agentID: agent.id,
            sessionID: session.id,
            at: Date.now(),
            status: "running" as const,
            scheduleVersion: agent.scheduleVersion ?? 1,
            trigger,
          }
          yield* runner.tasks.record(row)
          const goal = yield* goals.create(session.id, "Retain stopped café 日本語 😀")
          const edited = yield* goals.edit(session.id, { status: "paused", expectedIntent: goal.intent! })
          const permit = yield* execution.acquire(row)
          assert(permit)
          yield* execution.enter(row, Effect.void)
          // Real terminal writer retains the exact idle execution for the public Stop to retire.
          const current = (yield* runner.tasks.runsFor(agent.id)).find((item) => item.id === id)!
          assert(yield* runner.tasks.transition(current, { ...current, status: "error" }))
          return { sessionID: session.id, agentID: agent.id, runID: id, intent: edited.state.intent }
        }),
      ),
    ),
  )
  const stopped = await app.request(`/session/${seeded.sessionID}/goal/stop`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedIntent: seeded.intent }),
  })
  assert.equal(stopped.status, 200)
  const receipt = await stopped.json()
  assert.equal(receipt.phase, "finished")
  assert.equal(receipt.task.runs[0].id, seeded.runID)
  await writeFile(process.env.RAYA_TEST_GOAL_STOP_WITNESS!, JSON.stringify({ seeded, receipt }))
  await import("../../../src/index")
} else if (process.env.RAYA_TEST_GOAL_STOP_VERIFY === "1") {
  const { Server } = await import("../../../src/server/server")
  const evidence = JSON.parse(await readFile(process.env.RAYA_TEST_GOAL_STOP_WITNESS!, "utf8"))
  const headers = { "content-type": "application/json", "x-kilo-directory": process.env.RAYA_TEST_WORKSPACE! }
  const app = Server.Default().app
  const route = `/session/${evidence.seeded.sessionID}/goal/stop`
  const read = await app.request(route, { headers })
  assert.equal(read.status, 200)
  assert.deepEqual(await read.json(), evidence.receipt)
  const repeated = await app.request(route, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedIntent: evidence.seeded.intent }),
  })
  assert.equal(repeated.status, 200)
  assert.deepEqual(await repeated.json(), evidence.receipt)
  await writeFile(process.env.RAYA_TEST_GOAL_STOP_REOPEN!, JSON.stringify({ actualGET: true, repeatSameStop: true }))
  await import("../../../src/index")
} else {
  const [root, file] = process.argv.slice(2)
  assert(root && file)
  const pin = z
    .object({ extension: z.string(), sourceTree: z.string() })
    .parse(JSON.parse(await readFile(file, "utf8")))
  const helper = path.join(root, "native", "raya-process-host.exe")
  await mkdir(path.dirname(helper), { recursive: true })
  const original = path.join(pin.extension, "bin", "raya-process-host.exe")
  await copyFile(original, helper)
  const digest = sum(await readFile(helper))
  const metadata = z
    .object({ exe: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(JSON.parse(await readFile(path.join(pin.extension, "bin", "raya-process-host.json"), "utf8")))
  assert.equal(digest, metadata.exe)
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !/^(RAYA|KILO|OPENCODE|OTEL)_/i.test(entry[0]) &&
        !/TOKEN|SECRET|API_KEY|PASSWORD/i.test(entry[0]),
    ),
  )
  for (const dir of ["home", "local", "data", "config", "state", "cache", "workspace"])
    await mkdir(path.join(root, dir), { recursive: true })
  const database = path.join(root, "data", "kilo", "raya.db")
  await mkdir(path.dirname(database), { recursive: true })
  await mkdir(path.join(root, "config", "kilo"), { recursive: true })
  await writeFile(
    path.join(root, "config", "kilo", "kilo.json"),
    JSON.stringify({ $schema: "https://kilo.ai/config.json", enabled_providers: [], formatter: false, lsp: false }),
  )
  const workspace = path.join(root, "workspace")
  const witness = path.join(root, "witness.json")
  Object.assign(env, {
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    LOCALAPPDATA: path.join(root, "local"),
    KILO_TEST_HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    RAYA_DB: database,
    KILO_DB: database,
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    RAYA_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_VSCODE: "1",
    KILO_DISABLE_DEFAULT_PLUGINS: "1",
    RAYA_TEST_GOAL_STOP_SEED: "1",
    RAYA_TEST_WORKSPACE: workspace,
    RAYA_TEST_GOAL_STOP_WITNESS: witness,
  })
  const executable = await realpath(process.execPath)
  const session = await launch({
    executable,
    digest: sum(await readFile(executable)),
    cwd: path.resolve(import.meta.dir, "../../.."),
    env,
    helper: { executable: helper, digest },
    roots: [{ kind: "json", path: root }],
    policy: { version: 1, directories: [root], files: [] },
    args: ["run", "--conditions=browser", import.meta.path, "serve", "--hostname", "127.0.0.1", "--port", "0"],
    timeout: 60000,
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  session.child.stdout?.on("data", (bytes: Buffer) => stdout.push(bytes))
  session.child.stderr?.on("data", (bytes: Buffer) => stderr.push(bytes))
  const password = `goal-stop-private-${crypto.randomUUID()}`
  const output = path.join(os.tmpdir(), `raya-goal-stop-${crypto.randomUUID()}.raya`)
  try {
    await session.start()
    const deadline = Date.now() + 45000
    while (!Buffer.concat(stdout).toString().includes("kilo server listening on")) {
      if (Date.now() > deadline) throw new Error("Source startup deadline")
      await Bun.sleep(25)
    }
    const result = await exportSource(session, {
      profile: {
        database,
        storage: path.join(root, "data", "kilo", "storage"),
        data: path.join(root, "data", "kilo"),
        preferences: {},
      },
      password,
      output,
    })
    assert.equal(result.result.status, "exported")
    const outcomes = [proof(result)]
    const exited = await session.exit
    assert.equal(exited.code, 0)
    const { unseal } = await import("../../../src/kilocode/migration/profile-bundle")
    const { validateStorage } = await import("../../../src/kilocode/migration/profile-storage-correspondence")
    const { restore } = await import("../../../src/kilocode/migration/profile-restore")
    const { goalStop } = await import("../../../src/kilocode/migration/profile-goal-stop-correspondence")
    const value = await unseal(await readFile(output, "utf8"), password)
    const evidence = JSON.parse(await readFile(witness, "utf8"))
    const entry = value.disposition?.files.find(
      (item) => item.disposition.kind === "storage-json" && item.disposition.selector.role === "goal-stop",
    )
    assert(entry && entry.disposition.kind === "storage-json")
    const bound = entry.disposition
    validateStorage(bound, value)
    const receipt = value.json.find(
      (item) => item.path === `raya/goal-stops/${evidence.seeded.sessionID}/${sum(evidence.seeded.intent)}.json`,
    )
    assert(receipt)
    assert.deepEqual(JSON.parse(receipt.value), evidence.receipt)
    assert.equal(goalStop(receipt.path, "{", value), false)
    assert.equal(goalStop(receipt.path, JSON.stringify({ ...evidence.receipt, interrupted: undefined }), value), false)
    assert.equal(
      goalStop(receipt.path, JSON.stringify({ ...evidence.receipt, finishedAt: evidence.receipt.at - 1 }), value),
      false,
    )
    assert.equal(goalStop(receipt.path.replace(/[^/]+\.json$/, `${"0".repeat(64)}.json`), receipt.value, value), false)
    assert.equal(goalStop(receipt.path, JSON.stringify({ ...evidence.receipt, task: undefined }), value), false)
    const evicted = structuredClone(value)
    const historykey = `raya/agent-runs/${evidence.seeded.agentID}.json`
    evicted.json.find((item) => item.path === historykey)!.value = JSON.stringify({
      version: 1,
      cursor: 0,
      runs: [],
      events: [],
    })
    assert.equal(goalStop(receipt.path, receipt.value, evicted), false)
    const changed = structuredClone(value)
    changed.sql.find((table) => table.table === "session")!.rows[0][
      changed.sql.find((table) => table.table === "session")!.columns.indexOf("metadata")
    ] = "{}"
    assert.throws(() => validateStorage(bound, changed))
    const target = path.join(root, "destination")
    const mapping = Object.fromEntries(value.workspaces.map((dir, index) => [dir, path.join(root, `mapped-${index}`)]))
    for (const dir of Object.values(mapping)) await mkdir(dir, { recursive: true })
    const restored = await restore(await readFile(output, "utf8"), password, target, mapping)
    const stored = JSON.parse(await readFile(path.join(restored.path, "storage", ...receipt.path.split("/")), "utf8"))
    assert.deepEqual(stored, evidence.receipt)
    const { access } = await import("node:fs/promises")
    await assert.rejects(access(path.join(restored.path, "storage", "raya", "agent-executions")))
    await assert.rejects(access(path.join(restored.path, "storage", "raya", "agent-execution-reviews")))
    const next: Record<string, string> = { ...env, ...restored.env }
    delete next.RAYA_TEST_GOAL_STOP_SEED
    Object.assign(next, {
      RAYA_TEST_GOAL_STOP_VERIFY: "1",
      RAYA_TEST_GOAL_STOP_REOPEN: path.join(root, "reopen.json"),
      RAYA_TEST_WORKSPACE: Object.values(mapping)[0],
    })
    await mkdir(next.HOME, { recursive: true })
    await mkdir(next.LOCALAPPDATA, { recursive: true })
    const reopened = await launch({
      executable,
      digest: sum(await readFile(executable)),
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: next,
      helper: { executable: helper, digest },
      roots: [{ kind: "json", path: root }],
      policy: { version: 1, directories: [root], files: [] },
      args: ["run", "--conditions=browser", import.meta.path, "serve", "--hostname", "127.0.0.1", "--port", "0"],
      timeout: 60000,
    })
    const lines: Buffer[] = []
    const errors: Buffer[] = []
    reopened.child.stdout?.on("data", (bytes: Buffer) => lines.push(bytes))
    reopened.child.stderr?.on("data", (bytes: Buffer) => errors.push(bytes))
    const second = path.join(os.tmpdir(), `raya-goal-stop-second-${crypto.randomUUID()}.raya`)
    try {
      await reopened.start()
      const deadline = Date.now() + 45000
      while (!Buffer.concat(lines).toString().includes("kilo server listening on")) {
        if (Date.now() > deadline) throw new Error("Restored Source startup deadline")
        await Bun.sleep(25)
      }
      assert.deepEqual(JSON.parse(await readFile(path.join(root, "reopen.json"), "utf8")), {
        actualGET: true,
        repeatSameStop: true,
      })
      const exported = await exportSource(reopened, {
        profile: {
          database: restored.env.RAYA_DB,
          storage: path.join(restored.path, "storage"),
          data: restored.path,
          preferences: {},
        },
        password,
        output: second,
      })
      assert.equal(exported.result.status, "exported")
      outcomes.push(proof(exported))
      assert.equal((await reopened.exit).code, 0)
      const copied = await unseal(await readFile(second, "utf8"), password)
      const current = copied.json.find((item) => item.path === receipt.path)
      assert(current)
      assert.deepEqual(JSON.parse(current.value), evidence.receipt)
      const history = copied.archives?.find((item) => item.id === value.id)
      assert(history)
      assert.deepEqual(
        history.json.find((item) => item.path === receipt.path),
        receipt,
      )
      const secondclaim = copied.disposition?.files.find(
        (item) => item.disposition.kind === "storage-json" && item.disposition.selector.role === "goal-stop",
      )
      assert(secondclaim && secondclaim.disposition.kind === "storage-json")
      validateStorage(secondclaim.disposition, copied)
      assert.equal(copied.sql.find((table) => table.table === "message")!.rows.length, 0)
      assert.equal(copied.sql.find((table) => table.table === "raya_routine_occurrence")!.rows.length, 0)
      assert.equal(copied.sql.find((table) => table.table === "raya_routine_delegation")!.rows.length, 0)
      const roster = copied.json.find((item) => item.path === "raya/agent.json")
      assert(roster && JSON.parse(roster.value).every((agent: { enabled: boolean }) => agent.enabled === false))
      assert.equal(
        copied.json.some((item) => item.path.startsWith("raya/goal/")),
        false,
      )
      const secondmap = Object.fromEntries(
        copied.workspaces.map((dir, index) => [dir, path.join(root, `second-mapped-${index}`)]),
      )
      for (const dir of Object.values(secondmap)) await mkdir(dir, { recursive: true })
      const twice = await restore(
        await readFile(second, "utf8"),
        password,
        path.join(root, "second-destination"),
        secondmap,
      )
      assert.deepEqual(
        JSON.parse(await readFile(path.join(twice.path, "storage", ...receipt.path.split("/")), "utf8")),
        evidence.receipt,
      )
    } finally {
      await writeFile(path.join(root, "second-stdout.log"), Buffer.concat(lines))
      await writeFile(path.join(root, "second-stderr.log"), Buffer.concat(errors))
      if (reopened.child.exitCode === null)
        await writeFile(path.join(root, "second-forced-cleanup.json"), JSON.stringify(await reopened.abort()))
    }
    await writeFile(
      path.join(root, "receipt.json"),
      JSON.stringify({
        passed: true,
        actualHTTP: true,
        encryptedSource: true,
        inactive: true,
        executionAuthority: false,
        portable: false,
        sourceTree: pin.sourceTree,
        helper: digest,
        sourceCode: exited.code,
        twoHop: true,
        reopenedHTTP: true,
        noReplay: true,
        outcomes,
      }),
    )
  } finally {
    await writeFile(path.join(root, "source-stdout.log"), Buffer.concat(stdout))
    await writeFile(path.join(root, "source-stderr.log"), Buffer.concat(stderr))
    if (session.child.exitCode === null) {
      const stopped = await session.abort()
      await writeFile(path.join(root, "forced-cleanup.json"), JSON.stringify(stopped))
    }
  }
}
