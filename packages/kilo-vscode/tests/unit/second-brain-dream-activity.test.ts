import { expect, test } from "bun:test"
import { DreamActivity } from "../../src/second-brain/dream-activity"
import { latest } from "../../webview-ui/src/components/settings/brain-dream-state"

const selection = () => ({
  id: crypto.randomUUID(),
  owner: crypto.randomUUID(),
  project: "C:/Synthetic/project",
  model: "fixture/model",
})

test("activity retains original identity, copies snapshots and rejects a stale cancellation", () => {
  const view = new DreamActivity()
  const first = selection()
  const controller = new AbortController()
  view.begin(first, controller)
  expect(view.snapshot()).toMatchObject({ ...first, phase: "selection", lifecycle: "active" })
  const before = view.snapshot()
  expect(() => view.cancel({ id: first.id, owner: crypto.randomUUID() })).toThrow("unavailable")
  expect(controller.signal.aborted).toBe(false)
  view.observe({ ...first, phase: "generation" })
  expect(view.snapshot()?.revision).toBeGreaterThan(before!.revision)
  view.cancel({ id: first.id, owner: first.owner })
  expect(controller.signal.aborted).toBe(true)
  expect(view.snapshot()?.lifecycle).toBe("settling")
  expect(() => view.begin(selection(), new AbortController())).toThrow("still retained")
  view.finish(false)
  const second = selection()
  const next = new AbortController()
  view.begin(second, next)
  expect(() => view.cancel({ id: first.id, owner: first.owner })).toThrow("unavailable")
  expect(next.signal.aborted).toBe(false)
  view.observe({ ...first, phase: "completed" })
  expect(view.snapshot()).toMatchObject({ ...second, phase: "selection", lifecycle: "active" })
})

test("unknown cleanup cannot admit another run or be erased by display-copy mutation", () => {
  const view = new DreamActivity()
  const selected = selection()
  view.begin(selected, new AbortController())
  const copy = view.snapshot()
  expect(copy).toBeDefined()
  if (copy) Object.assign(copy, { model: "replacement/model", owner: crypto.randomUUID() })
  expect(view.snapshot()).toMatchObject(selected)
  view.settling()
  view.observe({ ...selected, phase: "reconciliation" })
  view.finish(true)
  expect(view.snapshot()).toMatchObject({ ...selected, phase: "reconciliation", lifecycle: "uncertain" })
  expect(() => view.begin(selection(), new AbortController())).toThrow("still retained")
  expect(() => view.cancel({ id: selected.id, owner: selected.owner })).toThrow("unavailable")
})

test("Cancel remains pending until the original host promise and its finalizer join", async () => {
  const view = new DreamActivity()
  const selected = selection()
  const controller = new AbortController()
  view.begin(selected, controller)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = held.finally(() => view.finish(false))
  let joined = false
  const close = view.join({ id: selected.id, owner: selected.owner }, original).then((row) => {
    joined = true
    return row
  })
  try {
    await Bun.sleep(10)
    expect(controller.signal.aborted).toBe(true)
    expect(joined).toBe(false)
    expect(view.snapshot()?.lifecycle).toBe("settling")
    expect(() => view.begin(selection(), new AbortController())).toThrow("still retained")
  } finally {
    release()
  }
  expect((await close)?.lifecycle).toBe("joined")
  expect(joined).toBe(true)
})

test("late activity reads cannot replace a joined run or a newer original selection", () => {
  const view = new DreamActivity()
  const first = selection()
  view.begin(first, new AbortController())
  const old = view.snapshot()
  view.settling()
  view.finish(false)
  const joined = view.snapshot()
  expect(latest(joined, old)).toEqual(joined)
  expect(latest(joined, undefined)).toEqual(joined)
  const second = selection()
  view.begin({ ...second, project: "", model: "" }, new AbortController())
  const fresh = view.snapshot()
  expect(latest(fresh, joined)).toEqual(fresh)
  view.select(second)
  const selected = view.snapshot()
  expect(latest(fresh, selected)).toEqual(selected)
  view.observe({ ...first, phase: "failed" })
  expect(view.snapshot()).toEqual(selected)
})
