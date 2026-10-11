import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { snapshot, absent } from "../../src/second-brain/generation-conflict"
import type { Descriptor } from "../../src/second-brain/managed/descriptor"
import { generation } from "../../src/second-brain/managed/generation"
import { Failure } from "../../src/second-brain/client"
import { interpreter } from "./fixtures/private-python"

test("partial managed generation reports its conflict without altering retained files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-generation-conflict-"))
  const folder = path.join(root, "Runs", "1".repeat(32))
  const file = path.join(folder, "memory-plan.json")
  const raw = "retained partial generation"
  const ref = { path: file, bytes: raw.length, sha256: "0".repeat(64) }
  const space = { root, sid: "S-1-5-18", generations: {} }
  const cfg: Descriptor = {
    format: "raya.memory.managed.launch",
    version: 2,
    root,
    python: ref,
    supervisor: ref,
    plan: ref,
    retrieval: ref,
    namespaces: { memory: space, retrieval: space },
  }
  try {
    await mkdir(folder, { recursive: true })
    await writeFile(file, raw)
    const err = await generation(cfg, { root: folder }, []).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(err).toBeInstanceOf(Failure)
    expect((err as Failure).code).toBe("managed_generation_conflict")
    expect((err as Failure).message).not.toContain(root)
    expect(await readFile(file, "utf8")).toBe(raw)
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})

test("partial generation admission retains files and refuses live owners or changed work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-partial-generation-"))
  const dir = await mkdtemp(path.join(tmpdir(), "raya-partial-interpreter-"))
  const python = await interpreter(dir)
  try {
    for (const kind of ["memory", "retrieval"]) {
      await mkdir(path.join(root, kind, "Requests"), { recursive: true })
      await mkdir(path.join(root, kind, "Runs"))
      await writeFile(path.join(root, kind + "-plan.json"), "{}")
    }
    const held = await snapshot(root)
    const child = Bun.spawn([python, "-I", "-S", "-c", "import sys;sys.stdin.buffer.read()", root], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    try {
      const refused = await absent(held, python).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(refused).toBeInstanceOf(AggregateError)
      const evidence = refused as AggregateError & {
        output: { stderr: string }
        receipt: { originalJoined: boolean; readersJoined: boolean }
      }
      expect(evidence.output.stderr).toContain("Partial generation has a live owner")
      expect(evidence.receipt.originalJoined).toBe(true)
      expect(evidence.receipt.readersJoined).toBe(true)
    } finally {
      child.stdin.end()
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, err).toBe(0)
      expect(out).toBe("")
    }
    const worker = Bun.spawn([python, "-I", "-S", "-c", "import sys;sys.stdin.buffer.read()"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    try {
      const refused = await absent(held, python).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(refused).toBeInstanceOf(AggregateError)
      expect((refused as AggregateError & { output: { stderr: string } }).output.stderr).toContain(
        "Selected interpreter remains live",
      )
    } finally {
      worker.stdin.end()
      const [code, out, err] = await Promise.all([
        worker.exited,
        new Response(worker.stdout).text(),
        new Response(worker.stderr).text(),
      ])
      expect(code, err).toBe(0)
      expect(out).toBe("")
    }
    expect((await absent(held, python)).receipt.code).toBe(0)
    // Windows' protected session-manager process exposes neither path nor command here.
    // Its non-Python executable name must still be refused when selected as interpreter.
    const unknown = await absent(held, path.join(process.env.SystemRoot!, "System32", "smss.exe")).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(unknown).toBeInstanceOf(AggregateError)
    expect((unknown as AggregateError & { output: { stderr: string } }).output.stderr).toContain(
      "Interpreter ownership is unverified",
    )
    expect(await readFile(path.join(root, "memory-plan.json"), "utf8")).toBe("{}")
    await writeFile(path.join(root, "memory-plan.json"), '{"changed":true}')
    await expect(absent(held, python)).rejects.toThrow("changed")
    await writeFile(path.join(root, "memory", "Requests", "unknown.json"), "{}")
    await expect(snapshot(root)).rejects.toThrow("unknown work")
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
    expect(path.dirname(dir)).toBe(path.resolve(tmpdir()))
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
