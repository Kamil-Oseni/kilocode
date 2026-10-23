import { afterAll, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Schema } from "effect"
import { Database } from "bun:sqlite"
import { createKiloClient } from "@kilocode/sdk/v2/client"

const mode = process.env.RAYA_RESTORE_REVIEW_CHILD
if (mode !== undefined && mode !== "1") throw new Error("Invalid private review child mode")

if (mode === undefined) {
  test("destination review production integration owns and joins its isolated child", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "--timeout", "60000"], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: { ...process.env, RAYA_RESTORE_REVIEW_CHILD: "1" },
      windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const control = { expired: false }
    const timer = setTimeout(() => {
      control.expired = true
      child.kill()
    }, 50_000)
    const results = await Promise.allSettled([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Private review child observation failed")
    const [exit, output, diagnostic] = results
    if (exit.status !== "fulfilled" || output.status !== "fulfilled" || diagnostic.status !== "fulfilled")
      throw new Error("Private review child did not join")
    process.stdout.write(output.value)
    process.stderr.write(diagnostic.value)
    expect(control.expired, "The private review child exceeded its deadline and was stopped; no acceptance").toBe(false)
    expect(exit.value, `${output.value}\n${diagnostic.value}`).toBe(0)
    expect(diagnostic.value).toContain(
      "(pass) destination review binds exact evidence without enabling or replaying workers",
    )
  }, 60_000)
}

if (mode === "1") {
  const { HttpApiApp } = await import("@/server/routes/instance/httpapi/server")
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { close } = await import("@/storage/db")
  const { RuntimeRegistry } = await import("@opencode-ai/core/kilocode/runtime-registry")
  const { RayaTask } = await import("@/kilocode/task")
  const { Summary } = await import("@/kilocode/migration/destination-review")
  const { Global } = await import("@opencode-ai/core/global")
  const { Server } = await import("@/server/server")
  const { resetDatabase } = await import("../../fixture/db")
  const { disposeAllInstances, disposeTestRuntime, tmpdir } = await import("../../fixture/fixture")

  const db = path.join(Global.Path.data, `review-${crypto.randomUUID()}.sqlite`)

  async function cleanup(actions: readonly (readonly [string, () => unknown])[]) {
    const errors: unknown[] = []
    for (const [name, action] of actions) {
      const [result] = await Promise.allSettled([Promise.resolve().then(action)])
      if (result.status === "rejected") errors.push(new Error(`Cleanup failed: ${name}`, { cause: result.reason }))
    }
    return errors
  }

  afterAll(async () => {
    const errors = await cleanup([
      ["instances", () => disposeAllInstances()],
      ["reset", () => resetDatabase()],
      ["fixture", () => disposeTestRuntime()],
      ["handler", () => (HttpApiApp.webHandler.loaded() ? HttpApiApp.webHandler().dispose() : undefined)],
      ["application", () => AppRuntime.dispose()],
      ["registry", () => RuntimeRegistry.drain()],
      ["legacy", () => close()],
    ])
    // Failed ownership retirement preserves the private diagnostic database.
    if (errors.length) throw new AggregateError(errors, "Private review owner cleanup failed")
    const files = await cleanup(
      [db, `${db}-wal`, `${db}-shm`].map((file) => [file, () => rm(file, { force: true })] as const),
    )
    if (files.length) throw new AggregateError(files, "Private review file cleanup failed")
  }, 60_000)

  test("destination review binds exact evidence without enabling or replaying workers", async () => {
    await using directory = await tmpdir({ git: true })
    const previous = { raya: process.env.RAYA_DB, kilo: process.env.KILO_DB }
    process.env.RAYA_DB = db
    process.env.KILO_DB = db
    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
      const app = Server.Default().app
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.request(request) })
      const client = createKiloClient({ baseUrl: server.url.toString(), throwOnError: true })
      const route = "/kilocode/profile/restore-review"
      const post = (value: unknown) => app.request(route, { method: "POST", headers, body: JSON.stringify(value) })
      expect(await (await app.request(route, { headers })).json()).toMatchObject({ state: "absent" })
      const created = await app.request("/kilocode/agent", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Transferred worker",
          objective: "Keep paused",
          enabled: false,
          schedule: { kind: "manual" },
        }),
      })
      expect(created.status, await created.clone().text()).toBe(200)
      const worker = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
      const root = Global.Path.data
      expect(
        path.resolve(root).startsWith(path.resolve(os.tmpdir(), `opencode-test-data-${process.pid}`) + path.sep),
      ).toBe(true)
      const marker = path.join(root, "storage", "raya", "restore-hold.json")
      const file = path.join(root, "restore-review.json")
      const roster = path.join(root, "storage", "raya", "agent.json")
      const before = await readFile(roster)
      const id = crypto.randomUUID()
      const held = JSON.stringify({ version: 1, id, state: "held", createdAt: Date.now() })
      const evidence = {
        format: "raya.restore-review",
        version: 1,
        bundle: crypto.randomUUID(),
        hold: id,
        workspaces: { "C:\\old\\workspace": directory.path },
        reconnectCredentials: true,
        uncertainWork: "held-no-replay",
      }
      await writeFile(marker, held, { flag: "wx" })
      await writeFile(file, JSON.stringify(evidence), { flag: "wx" })
      try {
        const loaded = await app.request(route, { headers })
        expect(loaded.status).toBe(200)
        const summary = Schema.decodeUnknownSync(Schema.toCodecJson(Summary))(await loaded.json())
        if (!summary.revision) throw new Error("Expected held revision")
        expect(summary.choices).toEqual({ version: 1, state: "absent" })
        const profile = {
          format: "raya.profile-preferences" as const,
          version: 1 as const,
          reviewOnly: true as const,
          activation: "held" as const,
          config: {
            model: { providerID: "local", modelID: "unavailable-default" },
            smallModel: { providerID: "local", modelID: "small" },
            defaultAgent: "general",
          },
          modelState: {
            models: [{ agent: "general", providerID: "local", modelID: "unavailable-choice" }],
            recent: [],
            favorite: [],
          },
          extensionState: {
            recentModels: [{ providerID: "local", modelID: "recent" }],
            favoriteModels: [{ providerID: "local", modelID: "favorite" }],
            variants: [
              { providerID: "local", modelID: "favorite", variant: "high" },
              { agent: "general", providerID: "local", modelID: "favorite", variant: "" },
            ],
            expanded: false,
          },
        }
        const captured = {
          selected: { providerID: "local", modelID: "captured-default" },
          recent: [],
          favorite: [],
          agents: [{ agent: "code", providerID: "local", modelID: "captured-code" }],
          variants: [
            { providerID: "local", modelID: "captured-code", variant: "low" },
            { agent: "code", providerID: "local", modelID: "captured-code", variant: "" },
          ],
          expanded: true,
        }
        const cli = { ...captured, variants: [{ providerID: "local", modelID: "captured-code", variant: "" }] }
        const host = {
          id: crypto.randomUUID(),
          role: "view" as const,
          revision: 4,
          models: captured,
          owners: [
            {
              id: crypto.randomUUID(),
              revision: 5,
              models: cli,
              root: { kind: "json", path: path.join(root, "source-state") },
            },
          ],
          contexts: [],
        }
        const preferences = path.join(root, "restore-preferences.json")
        const capsule = path.join(root, "restore-host.json")
        await writeFile(preferences, JSON.stringify(profile), { flag: "wx" })
        await writeFile(capsule, JSON.stringify({ format: "raya.host-capsule", version: 1, hosts: [host] }), {
          flag: "wx",
        })
        const loadedChoices = await client.kilocode.profile.restoreReview({ directory: directory.path })
        expect(loadedChoices.response.status).toBe(200)
        const selected = loadedChoices.data?.choices
        if (selected?.state !== "ready") throw new Error("Expected SDK choice inventory")
        expect(selected.sources).toEqual([
          { kind: "profile", preferences: profile },
          {
            kind: "host",
            id: host.id,
            role: host.role,
            revision: host.revision,
            models: captured,
            owners: [{ id: host.owners[0].id, revision: 5, models: cli }],
          },
        ])
        expect(loadedChoices.data?.revision).toBe(summary.revision)
        expect(JSON.stringify(selected)).not.toContain("source-state")
        await writeFile(preferences, JSON.stringify(profile) + "\n")
        const refreshed = await client.kilocode.profile.restoreReview({ directory: directory.path })
        if (refreshed.data?.choices?.state !== "ready") throw new Error("Expected refreshed SDK inventory")
        expect(refreshed.data.choices.revision).not.toBe(selected.revision)
        expect(refreshed.data.choices.sources).toEqual(selected.sources)
        expect(refreshed.data.revision).toBe(summary.revision)
        for (const captured of [
          { ...host, models: { ...host.models, variants: [host.models.variants[1], host.models.variants[1]] } },
          {
            ...host,
            owners: [{ ...host.owners[0], models: { ...cli, variants: [cli.variants[0], cli.variants[0]] } }],
          },
          { ...host, owners: [{ ...host.owners[0], models: { ...cli, variants: [host.models.variants[1]] } }] },
        ]) {
          await writeFile(capsule, JSON.stringify({ format: "raya.host-capsule", version: 1, hosts: [captured] }))
          const refused = await client.kilocode.profile.restoreReview({ directory: directory.path })
          expect(refused.response.status).toBe(200)
          expect(refused.data).toMatchObject({
            state: "held",
            id,
            revision: summary.revision,
            choices: { version: 1, state: "unavailable" },
            workers: [{ id: worker.id, enabled: false }],
          })
          expect(await readFile(marker, "utf8")).toBe(held)
        }
        await writeFile(capsule, "{broken")
        const unavailable = await client.kilocode.profile.restoreReview({ directory: directory.path })
        expect(unavailable.response.status).toBe(200)
        expect(unavailable.data).toMatchObject({
          state: "held",
          id,
          revision: summary.revision,
          choices: {
            version: 1,
            state: "unavailable",
            error: "Saved model choices are unavailable. Repair the saved evidence before applying choices.",
          },
          workers: [{ id: worker.id, enabled: false }],
        })
        expect(await readFile(marker, "utf8")).toBe(held)
        expect(await readFile(roster)).toEqual(before)
        expect((await client.kilocode.routine.runs({ agentID: worker.id, directory: directory.path })).data).toEqual([])
        const database = new Database(db, { readonly: true })
        try {
          expect(
            database
              .query<{ name: string; file: string }, []>("PRAGMA database_list")
              .all()
              .find((row) => row.name === "main")?.file,
          ).toBe(db)
        } finally {
          database.close()
        }
        const approval = {
          id,
          revision: summary.revision,
          reviewed: true,
          workspacesAcknowledged: true,
          reconnectAcknowledged: true,
        }
        expect((await post({ ...approval, reconnectAcknowledged: false })).status).toBe(400)
        expect((await post({ ...approval, id: crypto.randomUUID() })).status).toBe(409)
        await writeFile(file, JSON.stringify({ ...evidence, workspaces: { "C:\\changed": directory.path } }))
        expect((await post(approval)).status).toBe(409)
        expect(await readFile(marker, "utf8")).toBe(held)
        await writeFile(file, "{broken")
        expect((await app.request(route, { headers })).status).toBe(503)
        expect((await post(approval)).status).toBe(503)
        await writeFile(file, JSON.stringify({ ...evidence, hold: crypto.randomUUID() }))
        expect((await app.request(route, { headers })).status).toBe(409)
        await writeFile(file, JSON.stringify(evidence))
        const accepted = await post(approval)
        expect(accepted.status).toBe(200)
        expect(await accepted.json()).toMatchObject({
          state: "released",
          review: { by: "user", revision: summary.revision },
          workers: [{ id: worker.id, enabled: false }],
        })
        expect((await post(approval)).status).toBe(200)
        expect((await post({ ...approval, revision: "0".repeat(64) })).status).toBe(409)
        await disposeAllInstances()
        expect(await (await app.request(route, { headers })).json()).toMatchObject({
          state: "released",
          workers: [{ id: worker.id, enabled: false }],
        })
        expect(await readFile(roster)).toEqual(before)
        expect(await (await app.request(`/kilocode/agent/${worker.id}/runs`, { headers })).json()).toEqual([])
        await writeFile(marker, "{broken")
        expect((await app.request(route, { headers })).status).toBe(503)
      } finally {
        await rm(marker, { force: true })
        await rm(file, { force: true })
        await rm(path.join(root, "restore-preferences.json"), { force: true })
        await rm(path.join(root, "restore-host.json"), { force: true })
      }
    } finally {
      try {
        const errors = await cleanup([
          ["listener", () => server?.stop(true)],
          ["handler", () => (HttpApiApp.webHandler.loaded() ? HttpApiApp.webHandler().dispose() : undefined)],
        ])
        if (errors.length) throw new AggregateError(errors, "Private review request cleanup failed")
      } finally {
        if (previous.raya === undefined) delete process.env.RAYA_DB
        else process.env.RAYA_DB = previous.raya
        if (previous.kilo === undefined) delete process.env.KILO_DB
        else process.env.KILO_DB = previous.kilo
      }
    }
  }, 60_000)
}
