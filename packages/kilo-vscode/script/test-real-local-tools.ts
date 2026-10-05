import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { backend, call, environment, installed, model, stop } from "./test-installed-local-chat"

// Pin the installed manifest and CLI digest, or explicitly use RAYA_LOCAL_SOURCE=1.
// Real Ollama proof: one metadata tool and one manual, question-only
// Routine worker. This does not exercise desktop tools, scheduled execution or GUI.
type Message = {
  info: {
    id: string
    role: string
    modelID?: string
    providerID?: string
    finish?: string
    error?: unknown
    time?: { completed?: number }
  }
  parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string; output?: string } }>
}
type Run = { id: string; status: string; sessionID: string; error?: unknown }

async function wait(check: () => Promise<boolean>, timeout: number, message: string) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (await check()) return
    await Bun.sleep(250)
  }
  throw new Error(message)
}

function sql(path: string, sid: string, worker?: string) {
  const db = new Database(path, { readonly: true })
  try {
    return {
      messages: db.query("SELECT * FROM message WHERE session_id = ? ORDER BY id").all(sid),
      parts: db.query("SELECT * FROM part WHERE session_id = ? ORDER BY id").all(sid),
      inbox: worker ? db.query("SELECT * FROM raya_routine_message WHERE agent_id = ? ORDER BY id").all(worker) : [],
    }
  } finally {
    db.close()
  }
}

async function main() {
  const app = await installed()
  const local = await model()
  const temp = await mkdtemp(join(tmpdir(), "raya-real-local-tools-"))
  const root = join(temp, "project")
  const home = join(temp, "home")
  await Promise.all([mkdir(root), mkdir(home)])
  await Bun.write(join(root, "README.md"), "Private local metadata and manual Routine acceptance.\n")
  const password = randomBytes(32).toString("hex")
  const env = environment(home, local.url, local.name, local.context, password)
  const hosts: Parameters<typeof backend>[3] = []
  const stages: unknown[] = []
  const errors: string[] = []
  const report = resolve(
    process.env.RAYA_LOCAL_TOOLS_REPORT ?? join(import.meta.dir, "../../../.tmp/real-local-tools.json"),
  )
  try {
    let host = await backend(app, root, env, hosts)
    const request = <T>(method: string, path: string, body?: unknown) =>
      call<T>(host, password, root, method, path, body)
    const messages = (sid: string) => request<Message[]>("GET", `/session/${sid}/message`)
    const session = await request<{ id: string }>("POST", "/session", { title: "Real metadata tool acceptance" })
    await request("POST", `/session/${session.id}/prompt_async`, {
      model: { providerID: "local", modelID: local.name },
      system:
        "Use only metadata tools. Do not access files, shell, browser, network or the operating system. /no_think",
      parts: [
        {
          type: "text",
          text: "Call get_goal to inspect this chat's current goal. Then briefly tell me whether a goal is armed. You must actually call get_goal; do not infer the answer. /no_think",
        },
      ],
    })
    const observed: { rows?: Message[] } = {}
    try {
      await wait(
        async () => {
          const rows = await messages(session.id)
          observed.rows = rows
          for (const row of rows) {
            assert.ok(!row.info.error, JSON.stringify(row.info.error))
            if (row.info.role === "assistant") {
              assert.equal(row.info.providerID, "local")
              assert.equal(row.info.modelID, local.name)
            }
            for (const part of row.parts.filter((part) => part.type === "tool")) {
              assert.ok(
                ["get_goal", "chief_route"].includes(part.tool ?? ""),
                "Unexpected tool in metadata-only acceptance",
              )
              assert.notEqual(part.state?.status, "error")
            }
          }
          const final = rows.filter(
            (row) => row.info.role === "assistant" && row.info.time?.completed && row.info.finish === "stop",
          )
          if (!final.length) return false
          assert.ok(
            rows.some((row) =>
              row.parts.some((part) => part.tool === "get_goal" && part.state?.status === "completed"),
            ),
            "The real model returned text without invoking get_goal",
          )
          return true
        },
        90_000,
        "Real metadata tool did not complete",
      )
      const saved = sql(env.RAYA_DB, session.id)
      const parts = saved.parts as Array<{ data: string }>
      assert.equal(
        parts.filter((part) => {
          const data = JSON.parse(part.data) as { type?: string; tool?: string; state?: { status?: string } }
          return data.type === "tool" && data.tool === "get_goal" && data.state?.status === "completed"
        }).length,
        1,
        "Expected exactly one real completed get_goal SQL receipt",
      )
      stages.push({ stage: "native-metadata-tool", ok: true, observed, sql: saved })
    } catch (err) {
      errors.push(err instanceof Error ? (err.stack ?? err.message) : String(err))
      stages.push({ stage: "native-metadata-tool", ok: false, observed, sql: sql(env.RAYA_DB, session.id) })
      await stop(host)
      host = await backend(app, root, env, hosts)
    }

    const state: { worker?: string; runs?: Run[]; parts?: Message[]; sql?: ReturnType<typeof sql> } = {}
    try {
      const nonce = `WORKER_${randomBytes(8).toString("hex")}`
      const worker = await request<{ id: string }>("POST", "/kilocode/agent", {
        name: "Real local manual worker",
        objective:
          "Reply to this private worker conversation briefly. Do not execute tools or access the operating system. /no_think",
        access: "brief",
        tools: [],
        model: { providerID: "local", id: local.name },
        schedule: { kind: "manual" },
      })
      state.worker = worker.id
      const page = await request<{ draftState: { owner: string; conversationID: string; revision: number } }>(
        "GET",
        `/kilocode/agent/${worker.id}/inbox`,
      )
      const source = `manual_${randomBytes(8).toString("hex")}`
      const body = `Reply with exactly this code and nothing else: ${nonce}. /no_think`
      const dispatch = await request("POST", `/kilocode/agent/${worker.id}/inbox`, {
        owner: page.draftState.owner,
        conversationID: page.draftState.conversationID,
        expectedRevision: page.draftState.revision,
        source,
        body,
      })
      const runs = () => request<Run[]>("GET", `/kilocode/agent/${worker.id}/runs`)
      await wait(
        async () => {
          const rows = await runs()
          state.runs = rows
          assert.ok(rows.length <= 1, "A single manual send must not create duplicate runs")
          if (!rows.length) return false
          assert.ok(!["failed", "cancelled", "blocked"].includes(rows[0].status), JSON.stringify(rows[0]))
          return rows[0].status === "complete"
        },
        120_000,
        "Real local manual worker did not complete",
      )
      const rows = await runs()
      const parts = await messages(rows[0].sessionID)
      state.parts = parts
      const saved = sql(env.RAYA_DB, rows[0].sessionID, worker.id)
      state.sql = saved
      const replies = parts.filter((row) => row.info.role === "assistant" && row.info.time?.completed)
      assert.equal(replies.length, 1, "One manual worker must produce one completed assistant turn")
      assert.equal(replies[0].info.providerID, "local")
      assert.equal(replies[0].info.modelID, local.name)
      assert.equal(replies[0].info.finish, "stop")
      assert.ok(replies.every((row) => !row.info.error && !row.parts.some((part) => part.type === "tool")))
      assert.ok(replies.some((row) => row.parts.some((part) => part.type === "text" && part.text?.trim() === nonce)))
      const inbox = saved.inbox as Array<{
        source: string
        kind: string
        body: string
        delivered_at: number | null
        delivery_id: string | null
        session_id: string
      }>
      const intake = inbox.filter(
        (row) => row.source === source && row.kind === "user" && row.body === body && row.delivered_at !== null,
      )
      assert.equal(intake.length, 1)
      const users = parts.filter((row) => row.info.role === "user")
      assert.equal(users.length, 1, "The manual send must persist exactly one core user message")
      assert.equal(users[0].info.id, intake[0].delivery_id)
      assert.equal(intake[0].session_id, rows[0].sessionID)
      assert.equal(
        users[0].parts.filter((part) => part.type === "text" && part.text?.split(body).length === 2).length,
        1,
        "The delivered worker prompt must contain the exact intake body once",
      )
      assert.equal(
        inbox.filter(
          (row) =>
            row.source === `reply:${rows[0].id}` && row.body.trim() === nonce && row.session_id === rows[0].sessionID,
        ).length,
        1,
      )
      stages.push({ stage: "manual-worker-completed", ok: true, worker, dispatch, runs: rows, parts, sql: saved })
      await stop(host)
      host = await backend(app, root, env, hosts)
      assert.deepEqual(await runs(), rows)
      assert.deepEqual(await messages(rows[0].sessionID), parts)
      await Bun.sleep(2_000)
      assert.deepEqual(await runs(), rows)
      assert.deepEqual(
        sql(env.RAYA_DB, rows[0].sessionID, worker.id),
        saved,
        "Completed manual worker was replayed or its receipts changed after restart",
      )
      stages.push({ stage: "manual-worker-restart", ok: true, runs: rows, sql: saved })
    } catch (err) {
      errors.push(err instanceof Error ? (err.stack ?? err.message) : String(err))
      if (state.runs?.[0]?.sessionID && state.worker) {
        state.parts = await messages(state.runs[0].sessionID)
        state.sql = sql(env.RAYA_DB, state.runs[0].sessionID, state.worker)
      }
      stages.push({ stage: "manual-worker", ok: false, state })
    }
    const loaded = (await local.read("/api/ps")) as {
      models: Array<{ name: string; digest: string; context_length: number }>
    }
    assert.equal(loaded.models.length, 1, "Acceptance requires one loaded local model")
    assert.equal(loaded.models[0].name, local.name)
    assert.equal(loaded.models[0].digest, local.digest)
    assert.equal(loaded.models[0].context_length, local.context)
    stages.push({ stage: "loaded-model-pin", ok: true, loaded })
  } catch (err) {
    errors.push(err instanceof Error ? (err.stack ?? err.message) : String(err))
  } finally {
    const cleanup = await Promise.allSettled(hosts.map(stop))
    errors.push(...cleanup.filter((item) => item.status === "rejected").map((item) => String(item.reason)))
    await mkdir(dirname(report), { recursive: true })
    await Bun.write(
      report,
      JSON.stringify(
        {
          ok: errors.length === 0,
          errors,
          app,
          model: { name: local.name, digest: local.digest, context: local.context, url: local.url },
          temp,
          profileRetained: true,
          scope:
            "Real local metadata-tool dispatch and one manual question-only Routine worker; backend identity pinned above; excludes GUI, scheduling and portable capture",
          stages,
          hosts: hosts.map((host) => ({ pid: host.child.pid, termination: host.termination, logs: host.logs })),
        },
        null,
        2,
      ),
    )
    console.log(JSON.stringify({ report, temp, ok: errors.length === 0 }))
    if (errors.length) throw new Error(errors.join("\n"))
  }
}

if (import.meta.main) await main()
