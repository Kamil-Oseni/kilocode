import { expect, test } from "bun:test"
import { personal } from "../../src/second-brain/scope"

test("personal Memory accepts a trusted empty window and fences later workspace changes", () => {
  const state = { trusted: true, folders: [] as string[] }
  const guard = personal("C:/Program Files/Editor", () => state)
  expect(guard).not.toThrow()
  state.folders = ["C:/Work"]
  expect(guard).toThrow("window changed")
  state.folders = []
  state.trusted = false
  expect(guard).toThrow("window changed")
})

test("personal Memory keeps exact workspace authority and rejects untrusted or foreign contexts", () => {
  expect(() => personal("C:/Work", () => ({ trusted: false, folders: [] }))).toThrow("trusted")
  expect(() => personal("C:/Foreign", () => ({ trusted: true, folders: ["C:/Work"] }))).toThrow("exact")
  expect(() => personal("C:/Work/child", () => ({ trusted: true, folders: ["C:/Work"] }))).toThrow("exact")
  const state = { trusted: true, folders: ["C:/Other", "C:/Work"] }
  const guard = personal("c:/work", () => state)
  expect(guard).not.toThrow()
  state.folders = ["c:/work", "c:/other"]
  expect(guard).not.toThrow()
  state.folders = []
  expect(guard).toThrow("window changed")
})

test("personal Memory rechecks its actual window after awaited work", async () => {
  const state = { trusted: true, folders: [] as string[] }
  const guard = personal("C:/Editor", () => state)
  const release = Promise.withResolvers<void>()
  const result = (async () => {
    await release.promise
    guard()
    return "accepted"
  })()
  state.folders = ["C:/New"]
  release.resolve()
  await expect(result).rejects.toThrow("window changed")
})
