import { expect, test } from "bun:test"
import { dispose, paired, scope } from "../../src/second-brain/managed/projection-cache"

test("exact paired inputs and complete arguments hit without retaining aliases", () => {
  const cache = scope()
  const owner = {}
  const inputs = [Buffer.from("memory"), Buffer.from("retrieval")]
  const args = { replacements: [["source", { identity: ["1", "2"] }]], namespaces: { memory: "old" } }
  let calls = 0
  const produce = () => {
    calls++
    return inputs.map((raw) => Buffer.from(raw))
  }
  const first = paired(cache, owner, inputs, args, produce)
  first[0][0] = 0
  expect(paired(cache, owner, inputs, args, produce)[0].toString()).toBe("memory")
  expect(calls).toBe(1)
  inputs[0][0] = 1
  paired(cache, owner, inputs, args, produce)
  expect(calls).toBe(2)
  args.replacements[0][1] = { identity: ["1", "3"] }
  paired(cache, owner, inputs, args, produce)
  expect(calls).toBe(3)
  args.namespaces.memory = "new"
  paired(cache, owner, inputs, args, produce)
  expect(calls).toBe(4)
  dispose(cache)
})

test("foreign producer seeds cannot satisfy the private projector owner", () => {
  const cache = scope()
  const inputs = [Buffer.from("one"), Buffer.from("two")]
  paired(cache, {}, inputs, { release: "same" }, () => [Buffer.from("forged")])
  const owner = {}
  let calls = 0
  const actual = () => {
    calls++
    return inputs.map((raw) => Buffer.from(raw))
  }
  expect(paired(cache, owner, inputs, { release: "same" }, actual)).toEqual(inputs)
  paired(cache, owner, inputs, { release: "same" }, actual)
  expect(calls).toBe(1)
  dispose(cache)
})

test("twelve entries evict oldest and disposal permanently disables retained scopes", () => {
  const cache = scope()
  const owner = {}
  let calls = 0
  const produce = () => {
    calls++
    return [Buffer.from("result")]
  }
  for (let index = 0; index < 13; index++) paired(cache, owner, [Buffer.from(String(index))], {}, produce)
  paired(cache, owner, [Buffer.from("12")], {}, produce)
  expect(calls).toBe(13)
  paired(cache, owner, [Buffer.from("0")], {}, produce)
  expect(calls).toBe(14)
  dispose(cache)
  paired(cache, owner, [Buffer.from("0")], {}, produce)
  paired(cache, owner, [Buffer.from("0")], {}, produce)
  expect(calls).toBe(16)
})

test("encoded input/output/key bytes evict before crossing the 256 MiB budget", () => {
  const cache = scope()
  const owner = {}
  const raw = Buffer.alloc(32 * 1024 * 1024)
  let calls = 0
  const produce = () => {
    calls++
    return [raw]
  }
  try {
    for (let index = 0; index < 4; index++) paired(cache, owner, [raw], { index }, produce)
    paired(cache, owner, [raw], { index: 3 }, produce)
    expect(calls).toBe(4)
    paired(cache, owner, [raw], { index: 0 }, produce)
    expect(calls).toBe(5)
  } finally {
    dispose(cache)
  }
})
