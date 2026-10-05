import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { parse } from "../../src/second-brain/operation"

type Identity = { request: string; epoch: string; release: string; digest: string }
type Case = {
  name: string
  selected: Identity & { kind: "search" | "sync" }
  downstream: Identity[]
  pending: string
  terminal: string
  response: string | null
}
const source = process.env.RAYA_MEMORY_OPERATION_SOURCE
const python = process.env.RAYA_MEMORY_OPERATION_PYTHON
const genuine = source && python ? test : test.skip
const bytes = (value: string) => Buffer.from(value, "base64")
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const fixtures = async (): Promise<Case[]> => {
  if (!source || !python) throw new Error("Explicit pinned pure producer dependencies required")
  expect(
    createHash("sha256")
      .update(await readFile(python))
      .digest("hex"),
  ).toBe("b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2")
  const child = Bun.spawn(
    [python, "-I", "-S", "-B", path.join(import.meta.dir, "fixtures/memory-operation-producer.py"), source],
    {
      windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code).toBe(0)
  expect(stderr).toBe("")
  expect(Buffer.byteLength(stdout)).toBeLessThan(65536)
  const value = JSON.parse(stdout)
  expect(value.format).toBe("raya.memory.operation.producer-fixture")
  expect(value.sourceReviewSHA).toBe("f99cc7a0819bb7c2216c727e03620ca56ac3b1e8fc94ef0207ad3e7ccda7d037")
  return value.cases
}
const memo = (() => {
  let pending: Promise<Case[]> | undefined
  return () => (pending ??= fixtures())
})()

genuine(
  "real pinned producer pending, terminal and response codecs preserve Unicode and Python numeric tokens",
  async () => {
    for (const item of await memo()) {
      const selected = { ...item.selected, downstream: item.downstream }
      const pending = parse(bytes(item.pending), selected, "pending")
      const terminal = parse(bytes(item.terminal), selected, "terminal")
      expect(Object.isFrozen(pending.operation) && Object.isFrozen(terminal.operation)).toBe(true)
      expect(terminal.qualification).toContain("no HMAC")
      if (!item.response) continue
      const result = parse(bytes(item.response), selected, "response")
      expect(Object.isFrozen(result.result)).toBe(true)
      if (item.selected.kind !== "search") continue
      const raw = bytes(item.response).toString("utf8")
      expect(raw).toContain("café 日本語 😀")
      expect(raw).toContain("1.0")
      expect(raw).toContain("1e-07")
      expect(raw).toContain("\u007f")
      expect(() =>
        parse(
          new TextEncoder().encode(raw.replace('"embedding_similarity":1.0', '"embedding_similarity":1')),
          selected,
          "response",
        ),
      ).toThrow()
    }
  },
)

genuine(
  "operation selection refuses stale request, epoch, release, body, kind and optional downstream selections",
  async () => {
    const item = (await memo())[0]
    for (const selected of [
      { ...item.selected, request: "0".repeat(32) },
      { ...item.selected, epoch: "0".repeat(32) },
      { ...item.selected, release: "0".repeat(64) },
      { ...item.selected, digest: "0".repeat(64) },
      { ...item.selected, kind: "sync" as const },
      { ...item.selected, downstream: [] },
      { ...item.selected, downstream: item.downstream.map((value) => ({ ...value, epoch: "0".repeat(32) })) },
    ])
      expect(() => parse(bytes(item.terminal), selected, "terminal")).toThrow()
  },
)

genuine(
  "strict full proofs refuse duplicate, legacy, truncated, fabricated parent and unjoined worker evidence",
  async () => {
    const item = (await memo())[0]
    const value = JSON.parse(bytes(item.terminal).toString("utf8"))
    const cases = [
      { ...value, extra: true },
      { ...value, format: "raya.memory.operation.v0" },
      { ...value, downstream: [...value.downstream, value.downstream[0]] },
      { ...value, downstream: [{ ...value.downstream[0], input_closed: false }, value.downstream[1]] },
      { ...value, downstream: [{ ...value.downstream[0], writer_joined: false }, value.downstream[1]] },
      {
        ...value,
        downstream: [{ ...value.downstream[0], parent_request: item.selected.request }, value.downstream[1]],
      },
      { ...value, downstream: [value.downstream[0], { ...value.downstream[1], joins_observed: true }] },
      { ...value, downstream: [value.downstream[0], { ...value.downstream[1], queued_never_created: false }] },
    ]
    for (const current of cases) expect(() => parse(encode(current), item.selected, "terminal")).toThrow()
    expect(() =>
      parse(bytes(item.terminal), { ...item.selected, downstream: item.downstream.slice(0, 1) }, "terminal"),
    ).toThrow()
  },
)

genuine("safe exact counts, result correlation, complete outcomes and publication bound are mandatory", async () => {
  const item = (await memo()).find((value) => value.name === "sync-completed")!
  const value = JSON.parse(bytes(item.response!).toString("utf8"))
  for (const current of [
    { ...value, files: value.files + 1 },
    { ...value, rebuilt: false },
    { ...value, operation: { ...value.operation, result_sha256: "0".repeat(64) } },
    { ...value, operation: { ...value.operation, status: "pending" } },
    { ...value, operation: { ...value.operation, counts: { ...value.operation.counts, files: 9007199254740992 } } },
    { ...value, operation: { ...value.operation, downstream: [], extra: "x".repeat(65536) } },
  ])
    expect(() => parse(encode(current), item.selected, "response")).toThrow()
  expect(() => parse(bytes(item.pending), item.selected, "terminal")).toThrow()
  expect(() => parse(bytes(item.terminal), item.selected, "pending")).toThrow()
  const failed = (await memo()).find((value) => value.name === "sync-failed")!
  expect(() => parse(bytes(failed.terminal), failed.selected, "terminal")).not.toThrow()
  const cancelled = (await memo()).find((value) => value.name === "search-cancelled")!
  expect(() => parse(bytes(cancelled.terminal), cancelled.selected, "terminal")).not.toThrow()
})

genuine(
  "strict UTF8, duplicate fields, nonfinite numbers and integer lexemes cannot change original projections",
  async () => {
    const item = (await memo())[0]
    const raw = bytes(item.terminal).toString("utf8")
    expect(() => parse(new Uint8Array([0xff]), item.selected, "terminal")).toThrow()
    expect(() =>
      parse(new TextEncoder().encode(raw.replace('"version":1', '"version":1.0')), item.selected, "terminal"),
    ).toThrow()
    expect(() =>
      parse(new TextEncoder().encode(raw.replace('"version":1', '"version":1,"version":1')), item.selected, "terminal"),
    ).toThrow()
    expect(() =>
      parse(new TextEncoder().encode(raw.replace('"root_exit":0', '"root_exit":NaN')), item.selected, "terminal"),
    ).toThrow()
    expect(() => parse(new Uint8Array(262145), item.selected, "terminal")).toThrow()
  },
)
