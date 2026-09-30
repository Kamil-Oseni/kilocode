import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { coordinateProfileWriters, profileScope } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Storage } from "@/kilocode/session-export/worker/storage"
import { Chunker } from "@/kilocode/session-export/worker/chunks"
import { Scrubber } from "@/kilocode/session-export/worker/scrub"
import { handleBatch } from "@/kilocode/session-export/worker/handlers"
import { Inbox } from "@/kilocode/session-export/worker/inbox"
import type { LlmRequestStarted } from "@/kilocode/session-export/events"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-export-batch-"))
  await mkdir(path.join(dir, "storage"))
  const file = path.join(dir, "export.db")
  const storage = new Storage(file)
  storage.migrate()
  const ctx = {
    storage,
    chunker: new Chunker(storage, { chunkBytes: 1024 }),
    scrubber: new Scrubber(),
    inlineThresholdBytes: 16,
  }
  return {
    dir,
    file,
    ctx,
    async [Symbol.asyncDispose]() {
      storage.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function event(seq: number): LlmRequestStarted {
  return {
    id: `batch-${seq}`,
    seq,
    schemaVersion: 1,
    type: "llm_request_started",
    sessionId: "s",
    rootSessionId: "s",
    ts: seq,
    agentVersion: "test",
    requestId: `r-${seq}`,
    userMessageId: `u-${seq}`,
    agent: "build",
    modeId: "build",
    model: { providerId: "kilo", modelId: "free", isFree: true },
    input: {
      system: ["same shared string that will be chunked"],
      messages: [],
      tools: {},
      permissions: [],
      params: {},
    },
    time: { created: 0 },
  }
}

test("bounded batch publishes complete event/chunk references and rolls all SQL back on duplicate event", async () => {
  await using tmp = await fixture()
  await expect(handleBatch([event(0), event(0)], tmp.ctx)).rejects.toThrow()
  expect(tmp.ctx.storage.pendingEvents({ now: Date.now(), limitBytes: 1000000 })).toEqual([])
  const staged = tmp.ctx.chunker.stage(1000)
  const ids = await staged.write(Buffer.from("same shared string that will be chunked"))
  expect(tmp.ctx.storage.getChunk(ids[0]!)).toBeUndefined()
  await handleBatch([event(0), event(1)], tmp.ctx)
  expect(tmp.ctx.storage.pendingEvents({ now: Date.now(), limitBytes: 1000000 }).map((row) => row.id)).toEqual([
    "batch-0",
    "batch-1",
  ])
  expect(tmp.ctx.storage.getChunk(ids[0]!)?.refCount).toBe(2)
  const refs = tmp.ctx.storage.chunkRefsForEvents(["batch-0", "batch-1"])
  expect(refs).toEqual([ids[0]!, ids[0]!])
  await expect(handleBatch([event(2), event(0)], tmp.ctx)).rejects.toThrow()
  expect(tmp.ctx.storage.getChunk(ids[0]!)?.refCount).toBe(2)
  expect(tmp.ctx.storage.pendingEvents({ now: Date.now(), limitBytes: 1000000 }).map((row) => row.id)).toEqual([
    "batch-0",
    "batch-1",
  ])
  expect(Buffer.from(await tmp.ctx.chunker.read([ids[0]!])).toString()).toBe("same shared string that will be chunked")
}, 30_000)

test("async preparation creates no SQLite effects and maintenance refuses the final transaction", async () => {
  await using tmp = await fixture()
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false, override: tmp.file })
  await coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    const staged = tmp.ctx.chunker.stage(1000)
    expect(await staged.write(Buffer.from("prepared without SQL"))).toHaveLength(1)
    await expect(handleBatch([event(0)], tmp.ctx)).rejects.toThrow("maintenance excludes")
  })
  expect(tmp.ctx.storage.pendingEvents({ now: Date.now(), limitBytes: 1000000 })).toEqual([])
  await handleBatch([event(0)], tmp.ctx)
  expect(tmp.ctx.storage.pendingEvents({ now: Date.now(), limitBytes: 1000000 })).toHaveLength(1)
}, 30_000)

test("staging bounds refuse oversized batches before publication", async () => {
  await using tmp = await fixture()
  await expect(
    handleBatch(
      Array.from({ length: 65 }, (_, seq) => event(seq)),
      tmp.ctx,
    ),
  ).rejects.toThrow("event limit")
  await expect(handleBatch([event(0)], { ...tmp.ctx, batchBytes: 1 })).rejects.toThrow("batch limit")
  expect(tmp.ctx.storage.pendingEvents({ now: Date.now(), limitBytes: 1000000 })).toEqual([])
})

test("failed inbox batch restores FIFO evidence and byte accounting ahead of later intake", () => {
  const inbox = new Inbox({ capacityBytes: 40 })
  for (const seq of [0, 1, 2]) inbox.enqueue("s", 10, event(seq))
  const batch = inbox.take(64, 20)
  expect(batch.map((item) => item.envelope.seq)).toEqual([0, 1])
  inbox.enqueue("s", 10, event(3))
  expect(inbox.enqueue("s", 10, event(4)).accepted).toBe(false)
  inbox.restore(batch)
  expect(inbox.usedBytes()).toBe(40)
  expect(inbox.drainBatch(64).map((item) => item.envelope.seq)).toEqual([0, 1, 2, 3])
  expect(inbox.usedBytes()).toBe(0)
  inbox.enqueue("s", 10, event(5))
  const committed = inbox.take(64, 20)
  expect(inbox.usedBytes()).toBe(10)
  inbox.commit(committed)
  expect(inbox.usedBytes()).toBe(0)
})
