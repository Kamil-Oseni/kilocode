import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { coordinateProfileWriters, profileScope } from "@opencode-ai/core/kilocode/profile-maintenance"
import { createSequencer } from "@/kilocode/session-export/sequence"
import { Storage, type EventRow } from "@/kilocode/session-export/worker/storage"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-export-admission-"))
  await mkdir(path.join(dir, "storage"))
  return {
    dir,
    file: path.join(dir, "export.db"),
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function event(id: string, seq: number): EventRow {
  return {
    id,
    seq,
    schemaVersion: 1,
    sessionId: "session",
    rootSessionId: "session",
    type: "llm_request_started",
    ts: seq,
    agentVersion: "admission-fixture",
    dataJson: JSON.stringify({ chunkIds: ["chunk"], text: "exact Unicode café 中文" }),
    clientScrubbed: 1,
  }
}

test("actual sequence and Drizzle stores refuse maintenance operations without losing evidence", async () => {
  await using tmp = await fixture()
  const seq = createSequencer(tmp.file)
  const store = new Storage(tmp.file)
  store.migrate()
  const first = seq.next("session")
  store.insertEvent(event("first", first))
  store.upsertChunk({ id: "chunk", bytes: new Uint8Array([0, 255, 14]), size: 3, encoding: "zstd" })
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false, override: tmp.file })
  try {
    await coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
      for (const run of [
        () => createSequencer(tmp.file),
        () => new Storage(tmp.file),
        () => seq.next("session"),
        () => store.migrate(),
        () => store.insertEvent(event("blocked", 1)),
        () => store.upsertChunk({ id: "blocked", bytes: new Uint8Array([1]), size: 1, encoding: "zstd" }),
        () => store.incrementRefCount("chunk"),
        () => store.getChunk("chunk"),
        () => store.pendingEvents({ now: Date.now(), limitBytes: 10_000 }),
        () => store.markRetry("first", Date.now()),
        () => store.retry([{ id: "first", next: Date.now() }]),
        () => store.persist([event("blocked", 1)], []),
        () => store.markUploaded(["first"]),
        () => store.deleteUploaded(),
        () => store.decRefChunks(["chunk"]),
        () => store.commitUploaded(["first"], ["chunk"]),
        () => store.chunkRefsForEvents("first"),
        () => store.chunksForEvents(["first"]),
        () => store.dbSize(),
        () => seq.close(),
        () => store.close(),
      ])
        expect(run).toThrow("maintenance excludes")
    })
    expect(seq.next("session")).toBe(1)
    expect(store.pendingEvents({ now: Date.now(), limitBytes: 10_000 })).toEqual([
      { ...event("first", first), uploadAttempts: 0 },
    ])
    expect(store.getChunk("chunk")?.refCount).toBe(1)
    expect(store.getChunk("blocked")).toBeUndefined()
    expect(store.commitUploaded(["first"], ["chunk"])).toEqual({ events: 1, chunks: 1 })
  } finally {
    seq.close()
    store.close()
  }
  const reopened = createSequencer(tmp.file)
  try {
    expect(reopened.next("session")).toBe(2)
  } finally {
    reopened.close()
  }
})

test("independent sequence and worker storage processes honor canonical maintenance admission", async () => {
  await using tmp = await fixture()
  const seq = createSequencer(tmp.file)
  seq.next("session")
  seq.close()
  const store = new Storage(tmp.file)
  store.migrate()
  store.insertEvent(event("retained", 0))
  store.close()
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false, override: tmp.file })
  const script = `
    import { createSequencer } from "./src/kilocode/session-export/sequence.ts";
    import { Storage } from "./src/kilocode/session-export/worker/storage.ts";
    const input = JSON.parse(process.env.RAYA_ADMISSION_FIXTURE);
    const attempt = (fn) => {
      try { fn(); return false; }
      catch (err) { if (!(err instanceof Error) || !err.message.includes("maintenance excludes")) throw err; return true; }
    };
    console.log(JSON.stringify([attempt(() => createSequencer(input)), attempt(() => new Storage(input))]));
  `
  const alias = path.join(tmp.dir, "storage", "..", "export.db")
  await coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: { ...process.env, RAYA_ADMISSION_FIXTURE: JSON.stringify(alias) },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    try {
      expect(await child.exited).toBe(0)
      expect(await new Response(child.stderr).text()).toBe("")
      expect(JSON.parse(await new Response(child.stdout).text())).toEqual([true, true])
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
    }
  })
  const peer = createSequencer(alias)
  const recovered = new Storage(alias)
  try {
    expect(peer.next("session")).toBe(1)
    expect(recovered.pendingEvents({ now: Date.now(), limitBytes: 10_000 }).map((row) => row.id)).toEqual(["retained"])
  } finally {
    peer.close()
    recovered.close()
  }
}, 30_000)
