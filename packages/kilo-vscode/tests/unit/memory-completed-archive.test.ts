import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { review } from "../../src/second-brain/failed-archive"
import { unpublished } from "../../src/second-brain/completed-archive"
import { image } from "../../src/second-brain/control/identity"
import { BrainSettings } from "../../src/second-brain/settings"
import { fingerprint } from "../../src/second-brain/failed-repair"

const source = process.env.RAYA_COMPLETED_ARCHIVE_FIXTURE
const genuine = source ? test : test.skip
const key = "raya.secondBrain.setup"
const debt = "raya.secondBrain.control.uncertainty"

async function fixture() {
  if (!source) throw new Error("Explicit original completed request fixture required")
  const value = await Bun.file(source).json()
  const root = await mkdtemp(path.join(tmpdir(), "raya-completed-archive-test-"))
  const input = await Bun.file(value.selection).json()
  async function save(name: string, value: unknown) {
    const file = path.join(root, name)
    await writeFile(file, JSON.stringify(value))
    const held = await image(file)
    return { path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple }
  }
  async function cleanup() {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()))
    expect(path.basename(root).startsWith("raya-completed-archive-test-")).toBe(true)
    await rm(root, { recursive: true })
  }
  return { ...value, input, root, save, cleanup }
}

genuine(
  "original completed handoff quarantine retains exact terminal, closed pair and both downstream publications",
  async () => {
    const value = await fixture()
    try {
      const result = await review(value.selection, value.state[key], value.state[debt])
      expect(result.outcome).toBe("completed")
      expect(result.settlement).toBe(false)
      expect(result.closure).toBe("unproven")
      expect(result.downstream).toHaveLength(2)
      for (const row of result.downstream ?? []) expect(row.files).toHaveLength(2)
      expect(result.terminal?.sha256).toBe("96555d58a2592e18a03c714b8111c5dc50b515c94c7aae65bdb3c573f6f980d5")
      expect(result.closed).toEqual(value.state[key].launch.receipt)
    } finally {
      await value.cleanup()
    }
  },
)

genuine("changed original debt, entry, terminal and closed receipts refuse completed handoff quarantine", async () => {
  const value = await fixture()
  try {
    await expect(
      review(value.selection, { ...value.state[key], credential: "changed" }, value.state[debt]),
    ).rejects.toThrow()
    await expect(
      review(value.selection, value.state[key], {
        ...value.state[debt],
        request: { ...value.state[debt].request, id: "a".repeat(32) },
      }),
    ).rejects.toThrow()
    const witness = await Bun.file(value.input.observation.path).json()
    for (const changed of [
      { ...witness, terminal_file: { ...witness.terminal_file, sha256: "a".repeat(64) } },
      { ...witness, closed: { ...witness.closed, sha256: "a".repeat(64) } },
    ]) {
      const observation = await value.save(crypto.randomUUID() + ".json", changed)
      const input = await value.save(crypto.randomUUID() + ".json", { ...value.input, observation })
      await expect(review(input.path, value.state[key], value.state[debt])).rejects.toThrow()
    }
  } finally {
    await value.cleanup()
  }
})

genuine("deferred running entry uses its exact genuine closure without projecting or settling saved debt", async () => {
  const value = await fixture()
  try {
    const witness = await Bun.file(value.input.observation.path).json()
    const closure = await Bun.file(witness.closed.path).json()
    const entry = { ...value.state[key], launch: { phase: "running", receipt: closure.original } }
    const before = JSON.stringify({ entry, debt: value.state[debt] })
    const observation = await value.save("running-observation.json", {
      ...witness,
      entry_sha256: fingerprint(entry),
    })
    const selection = await value.save("running-selection.json", { ...value.input, observation })
    const result = await review(selection.path, entry, value.state[debt])
    expect(result.outcome).toBe("completed")
    expect(result.closed).toEqual(witness.closed)
    expect(result.original).toEqual(closure.original)
    expect(result.settlement).toBe(false)
    expect(result.closure).toBe("unproven")
    expect(result.downstream).toHaveLength(2)
    expect(JSON.stringify({ entry, debt: value.state[debt] })).toBe(before)
    for (const launch of [
      { phase: "running", receipt: { ...closure.original, sha256: "a".repeat(64) } },
      { phase: "running", receipt: witness.closed },
      { phase: "uncertain", receipt: closure.original },
    ]) {
      const changed = { ...entry, launch }
      const observation = await value.save(crypto.randomUUID() + ".json", {
        ...witness,
        entry_sha256: fingerprint(changed),
      })
      const selection = await value.save(crypto.randomUUID() + ".json", { ...value.input, observation })
      await expect(review(selection.path, changed, value.state[debt])).rejects.toThrow()
    }
  } finally {
    await value.cleanup()
  }
})

genuine("fresh completed handoff selection refuses mixed source pins and unknown supervisor", async () => {
  const value = await fixture()
  try {
    for (const input of [
      {
        ...value.input,
        setup: {
          ...value.input.setup,
          source_sha256: {
            ...value.input.setup.source_sha256,
            "server.py": "deb92041d4cc08c64d64403cb23edfe71221105b2c8094a064aa1e184a168b8b",
          },
        },
      },
      {
        ...value.input,
        managed: { ...value.input.managed, supervisor: { ...value.input.managed.supervisor, sha256: "a".repeat(64) } },
      },
    ]) {
      const file = await value.save(crypto.randomUUID() + ".json", input)
      await expect(review(file.path, value.state[key], value.state[debt])).rejects.toThrow()
    }
  } finally {
    await value.cleanup()
  }
})

test("actual published residency metadata blocks quarantine of its original request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-completed-archive-test-"))
  try {
    await unpublished(root, "a".repeat(32))
    await writeFile(
      path.join(root, "a".repeat(32) + "-" + "b".repeat(32) + ".json"),
      JSON.stringify({ format: "raya.memory.residency.release" }),
    )
    await expect(unpublished(root, "a".repeat(32))).rejects.toThrow("Published original residency proof")
    await unpublished(root, "c".repeat(32))
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()))
    await rm(root, { recursive: true })
  }
})

genuine(
  "file-backed administrative activation preserves previous entry, credential reference and request debt in quarantine",
  async () => {
    const value = await fixture()
    try {
      const file = (await value.save("state.json", value.state)).path
      const settings = new BrainSettings(
        {
          get<T>(key: string) {
            return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
          },
          async update(key, value) {
            const state = JSON.parse(await readFile(file, "utf8"))
            if (value === undefined) delete state[key]
            else state[key] = value
            await writeFile(file, JSON.stringify(state))
          },
        },
        {
          async get() {
            return "synthetic"
          },
          async store() {
            throw new Error("No credential writes permitted")
          },
          async delete() {
            throw new Error("No credential deletion permitted")
          },
        },
      )
      await settings.archive(value.selection, async () => true)
      const state = JSON.parse(await readFile(file, "utf8"))
      const audit = state[`raya.secondBrain.failedSearchArchive.${value.state[debt].request.id}`]
      expect(audit.previous).toEqual(value.state[key])
      expect(audit.debt).toEqual(value.state[debt])
      expect(audit.settlement).toBe(false)
      expect(audit.closure).toBe("unproven")
      expect(audit.phase).toBe("applied")
      expect(audit.review.downstream).toHaveLength(2)
      expect(state[key].credential).toBe(value.state[key].credential)
      expect(state["raya.secondBrain.quarantinedSetups"]).toContainEqual(value.state[key])
      expect(settings.pending()).toBeUndefined()
      for (const [name, entry] of Object.entries(value.state))
        if (![key, debt, "raya.secondBrain.quarantinedSetups"].includes(name)) expect(state[name]).toEqual(entry)
      expect((await Bun.file(source!).json()).state).toEqual(value.state)
    } finally {
      await value.cleanup()
    }
  },
  30000,
)
