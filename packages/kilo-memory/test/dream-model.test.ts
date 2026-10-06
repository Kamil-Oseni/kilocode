import { expect, test } from "bun:test"
import { Effect } from "effect"
import { MemoryDreamModel } from "../src/storage/dream-model"
import type { MemoryPorts } from "../src/effect/ports"

test("model retirement joins original decoding and retains the admitted retirement hook", async () => {
  let release!: () => void
  let entered!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const began = new Promise<void>((resolve) => {
    entered = resolve
  })
  const events: string[] = []
  const model: MemoryPorts.ModelPort = {
    resolve: () => Effect.succeed({ handle: "original" }),
    run: async () => ({ text: "synthetic", usage: undefined }),
    retire: async () => {
      events.push("original-retired")
    },
  }
  const lease = await MemoryDreamModel.admit(
    {
      model,
      execute: Effect.runPromise,
      selection: {
        id: crypto.randomUUID(),
        owner: crypto.randomUUID(),
        model: "fixture/model",
        budget: { input: 1000, output: 500 },
        timeout: 5000,
      },
      system: "Synthetic input",
      prompt: "Synthetic input",
      decode: async () => {
        entered()
        await barrier
        events.push("decoded")
        return []
      },
    },
    new AbortController().signal,
  )
  model.retire = async () => {
    events.push("replacement-retired")
  }
  const work = lease.generate(new AbortController().signal)
  await began
  const close = lease.retire()
  await Bun.sleep(10)
  expect(events).toEqual([])
  await expect(lease.generate(new AbortController().signal)).rejects.toThrow("cannot be reused")
  release()
  await Promise.all([work, close])
  expect(events).toEqual(["decoded", "original-retired"])
})

test("failed generation does not hide original host retirement failure", async () => {
  const cause = new Error("Original backend settlement remains unknown")
  const lease = await MemoryDreamModel.admit(
    {
      model: {
        resolve: () => Effect.succeed({ handle: "original" }),
        run: async () => {
          throw new Error("Generation failed")
        },
        retire: async () => {
          throw cause
        },
      },
      execute: Effect.runPromise,
      selection: {
        id: crypto.randomUUID(),
        owner: crypto.randomUUID(),
        model: "fixture/model",
        budget: { input: 1000, output: 500 },
        timeout: 5000,
      },
      system: "Synthetic input",
      prompt: "Synthetic input",
      decode: async () => [],
    },
    new AbortController().signal,
  )
  await expect(lease.generate(new AbortController().signal)).rejects.toThrow("Generation failed")
  await expect(lease.retire()).rejects.toBe(cause)
})
