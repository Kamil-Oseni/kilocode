import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { parse } from "../../src/second-brain/operation"
import { setup } from "../../src/second-brain/setup-v2"
import { release } from "../../src/second-brain/control/catalog-v2"
import { canonical, decode, sha } from "../../src/second-brain/control/frames"

type Case = {
  selected: Parameters<typeof parse>[1]
  pending: string
  terminal: string
  response: string | null
}
const python = process.env.RAYA_MEMORY_OPERATION_PYTHON
const genuine = python ? test : test.skip
const bytes = (value: string) => Buffer.from(value, "base64")
function seal(row: Record<string, unknown>) {
  delete row.receipt_sha256
  const parsed = decode(Buffer.from(JSON.stringify(row) + "\n"))
  row.receipt_sha256 = sha(canonical(parsed.tree, parsed.text, true).replace(/\u007f/g, "\\u007f"))
}
const fixtures = async (): Promise<Case[]> => {
  if (!python) throw new Error("Explicit fixed Python selection required")
  expect(
    createHash("sha256")
      .update(await readFile(python))
      .digest("hex"),
  ).toBe("b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2")
  const source = path.resolve(import.meta.dir, "../../script/memory")
  for (const name of ["operations.py", "retirement.py", "namespace.py"])
    expect(
      createHash("sha256")
        .update(await readFile(path.join(source, "service", name)))
        .digest("hex"),
    ).toBe(release[name])
  const child = Bun.spawn(
    [python, "-I", "-S", "-B", path.join(import.meta.dir, "fixtures/memory-settlement-producer.py"), source],
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
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code).toBe(0)
  expect(err).toBe("")
  expect(Buffer.byteLength(out)).toBeLessThan(65536)
  return JSON.parse(out).cases
}
const memo = (() => {
  let pending: Promise<Case[]> | undefined
  return () => (pending ??= fixtures())
})()

genuine("explicit v2 consumes actual Python Journal output and preserves original numeric tokens", async () => {
  for (const item of await memo()) {
    expect(Object.isFrozen(parse(bytes(item.pending), item.selected, "pending").operation)).toBe(true)
    expect(Object.isFrozen(parse(bytes(item.terminal), item.selected, "terminal").operation)).toBe(true)
    if (!item.response) continue
    expect(Object.isFrozen(parse(bytes(item.response), item.selected, "response").result)).toBe(true)
    const raw = bytes(item.response).toString("utf8")
    expect(raw).toContain("1.0")
    expect(raw).toContain("1e-07")
    expect(() =>
      parse(
        Buffer.from(raw.replace('"embedding_similarity":1.0', '"embedding_similarity":1')),
        item.selected,
        "response",
      ),
    ).toThrow()
  }
})

genuine("v2 requires explicit selection and rejects changed original downstream identities", async () => {
  const item = (await memo())[0]
  for (const protocol of [undefined, "raya.memory.operation.v1"] as const)
    expect(() => parse(bytes(item.terminal), { ...item.selected, protocol }, "terminal")).toThrow()
  expect(() =>
    parse(
      bytes(item.terminal),
      { ...item.selected, downstream: item.selected.downstream!.map((row) => ({ ...row, epoch: "0".repeat(32) })) },
      "terminal",
    ),
  ).toThrow()
})

genuine("strict settlement evidence rejects altered live, joined and never-started metadata", async () => {
  for (const item of await memo()) {
    const original = JSON.parse(bytes(item.terminal).toString("utf8"))
    for (const [key, value] of [
      ["version", 2.0],
      ["joins_observed", true],
      ["original_process_running", false],
      ["sequence", 0],
      ["writer_joined", false],
      ["unexpected", true],
    ] as const) {
      const row = structuredClone(original)
      row.downstream[0][key] = value
      if (JSON.stringify(row) === JSON.stringify(original)) continue
      seal(row.downstream[0])
      seal(row)
      expect(() => parse(Buffer.from(JSON.stringify(row)), item.selected, "terminal")).toThrow()
    }
  }
})

test("setup retains explicit v2 protocol and refuses automatic protocol adoption", () => {
  const input = { protocol: "raya.memory.operation.v2", root: "C:/Synthetic", source_sha256: release }
  expect(setup(input, "http://127.0.0.1:8874").protocol).toBe("raya.memory.operation.v2")
  expect(() => setup({ ...input, protocol: "automatic" }, "http://127.0.0.1:8874")).toThrow()
})
