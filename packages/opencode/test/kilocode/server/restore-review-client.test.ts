import { afterEach, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Global } from "@opencode-ai/core/global"
import { Server } from "@/server/server"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { restoreReview } from "../../../../kilo-vscode/src/kilo-provider/restore-review"
import { Review } from "../../../../kilo-vscode/src/shared/restore-review"
import { disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("generated SDK and extension review bridge use the real held-profile API without enabling workers", async () => {
  const root = Global.Path.data
  expect(path.resolve(root).startsWith(path.resolve(os.tmpdir(), `opencode-test-data-${process.pid}`) + path.sep)).toBe(
    true,
  )
  const app = Server.Default().app
  const calls: Request[] = []
  const messages: unknown[] = []
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init)
      calls.push(request)
      return app.request(request)
    },
    { preconnect: fetch.preconnect },
  )
  const client = createKiloClient({ baseUrl: "http://localhost:4096", fetch: transport })
  const headers = { "Content-Type": "application/json" }
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Bridge paused worker",
      objective: "Keep paused",
      enabled: false,
      schedule: { kind: "manual" },
    }),
  })
  expect(created.status).toBe(200)
  const marker = path.join(root, "storage/raya/restore-hold.json")
  const file = path.join(root, "restore-review.json")
  const roster = path.join(root, "storage/raya/agent.json")
  const before = await readFile(roster)
  const id = crypto.randomUUID()
  await writeFile(marker, JSON.stringify({ version: 1, id, state: "held", createdAt: Date.now() }))
  await writeFile(
    file,
    JSON.stringify({
      format: "raya.restore-review",
      version: 1,
      bundle: crypto.randomUUID(),
      hold: id,
      workspaces: { "C:/old/café": "D:/new/café" },
      reconnectCredentials: true,
      uncertainWork: "held-no-replay",
    }),
  )
  try {
    const post = (message: unknown) => messages.push(message)
    const current = () => true
    await restoreReview({
      client,
      directory: process.cwd(),
      message: { type: "restoreReviewGet", requestID: "read" },
      post,
      current,
    })
    const entry = messages[0]
    if (!entry || typeof entry !== "object" || !("summary" in entry)) throw new Error("Missing review result")
    const summary = Review.parse(entry.summary)
    expect(summary.state).toBe("held")
    expect(summary.id).toBe(id)
    await restoreReview({
      client,
      directory: process.cwd(),
      message: {
        type: "restoreReviewApprove",
        requestID: "stale",
        approval: {
          id,
          revision: "0".repeat(64),
          reviewed: true,
          workspacesAcknowledged: true,
          reconnectAcknowledged: true,
        },
      },
      post,
      current,
    })
    expect(messages[1]).toMatchObject({ type: "restoreReviewResult", requestID: "stale", error: expect.any(String) })
    expect(JSON.parse(await readFile(marker, "utf8")).state).toBe("held")
    await restoreReview({
      client,
      directory: process.cwd(),
      message: {
        type: "restoreReviewApprove",
        requestID: "approve",
        approval: {
          id,
          revision: summary.revision,
          reviewed: true,
          workspacesAcknowledged: true,
          reconnectAcknowledged: true,
        },
      },
      post,
      current,
    })
    expect(messages[2]).toMatchObject({
      type: "restoreReviewResult",
      requestID: "approve",
      summary: { state: "released", id, review: { by: "user" } },
    })
    expect(await readFile(roster)).toEqual(before)
    expect(calls.map((request) => request.method)).toEqual(["GET", "POST", "POST"])
    expect(calls.every((request) => new URL(request.url).pathname === "/kilocode/profile/restore-review")).toBe(true)
    const count = calls.length
    await restoreReview({
      client,
      directory: process.cwd(),
      message: {
        type: "restoreReviewApprove",
        requestID: "changed-view",
        approval: {
          id,
          revision: summary.revision,
          reviewed: true,
          workspacesAcknowledged: true,
          reconnectAcknowledged: true,
        },
      },
      post,
      current: () => false,
    })
    expect(calls).toHaveLength(count)
    expect(messages[3]).toMatchObject({
      type: "restoreReviewResult",
      requestID: "changed-view",
      error: expect.any(String),
    })
  } finally {
    await rm(marker, { force: true })
    await rm(file, { force: true })
  }
}, 30000)
