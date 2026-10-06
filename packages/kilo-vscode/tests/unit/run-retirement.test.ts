import { expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunScriptManager } from "../../src/agent-manager/run/manager"
import { RunController } from "../../src/agent-manager/run/controller"
import type { RunHandle } from "../../src/agent-manager/run/manager"

it("joins an accepted removal before reporting manager retirement", async () => {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const manager = new RunScriptManager(
    () => {},
    () => {},
  )
  let disposed = 0
  let retired = false
  await manager.start("owned-probe", async () => ({
    stop: () => {
      entered.resolve()
      return gate.promise
    },
    dispose: () => disposed++,
  }))
  const removal = manager.remove("owned-probe")
  await entered.promise
  const closing = manager.dispose().then(() => {
    retired = true
  })
  // A microtask checkpoint observes the actual resolved retirement promise,
  // while the accepted removal is deterministically held by gate.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  const before = retired
  gate.resolve()
  await Promise.all([removal, closing])
  expect(disposed).toBe(1)
  expect(before).toBe(false)
  expect(retired).toBe(true)
})

it("retains a failed removal in manager retirement", async () => {
  const manager = new RunScriptManager(
    () => {},
    () => {},
  )
  await manager.start("owned-probe", async () => ({
    stop: () => {},
    dispose: () => {
      throw new Error("owned disposal failure")
    },
  }))
  await expect(manager.remove("owned-probe")).rejects.toThrow("owned disposal failure")
  const result = await manager.dispose().then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(result).toBeInstanceOf(AggregateError)
})

it("joins duplicate removal and refuses restart until the old handle retires", async () => {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const manager = new RunScriptManager(
    () => {},
    () => {},
  )
  let stopped = 0
  let disposed = 0
  let duplicate = false
  await manager.start("owned-probe", async () => ({
    stop: () => {
      stopped++
      entered.resolve()
      return gate.promise
    },
    dispose: () => disposed++,
  }))
  const removal = manager.remove("owned-probe")
  await entered.promise
  const repeated = manager.remove("owned-probe").then(() => {
    duplicate = true
  })
  const restarted = await manager.start("owned-probe", async () => ({ stop: () => {} }))
  const independent = await manager.start("independent-probe", async () => ({ stop: () => {} }))
  const before = duplicate
  gate.resolve()
  await Promise.all([removal, repeated])
  const later = await manager.start("owned-probe", async () => ({ stop: () => {} }))
  await manager.dispose()
  expect(stopped).toBe(1)
  expect(disposed).toBe(1)
  expect(before).toBe(false)
  expect(restarted).toBe(false)
  expect(independent).toBe(true)
  expect(later).toBe(true)
})

it("refuses manager removal after retirement fences intake", async () => {
  const manager = new RunScriptManager(
    () => {},
    () => {},
  )
  await manager.dispose()
  const result = await manager.remove("owned-probe").then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(result).toBeInstanceOf(Error)
})

it("requests other active stops while an accepted removal is held", async () => {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const manager = new RunScriptManager(
    () => {},
    () => {},
  )
  let stopped = 0
  await manager.start("owned-probe", async () => ({
    stop: () => {
      entered.resolve()
      return gate.promise
    },
  }))
  await manager.start("independent-probe", async () => ({
    stop: () => {
      stopped++
    },
  }))
  const removal = manager.remove("owned-probe")
  await entered.promise
  const closing = manager.dispose()
  await Promise.resolve()
  await Promise.resolve()
  const before = stopped
  gate.resolve()
  await Promise.all([removal, closing])
  expect(before).toBe(1)
  expect(stopped).toBe(1)
})

it("joins the same release when startup and removal race", async () => {
  const launch = Promise.withResolvers<RunHandle>()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const manager = new RunScriptManager(
    () => {},
    () => {},
  )
  let removed = false
  let stopped = 0
  let disposed = 0
  const started = manager.start("owned-probe", () => launch.promise)
  const removal = manager.remove("owned-probe").then(() => {
    removed = true
  })
  launch.resolve({
    stop: () => {
      stopped++
      entered.resolve()
      return gate.promise
    },
    dispose: () => disposed++,
  })
  await entered.promise
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  const before = removed
  gate.resolve()
  await Promise.all([started, removal])
  await manager.dispose()
  expect(stopped).toBe(1)
  expect(disposed).toBe(1)
  expect(before).toBe(false)
})

it("joins accepted controller removal before controller retirement", async () => {
  const root = mkdtempSync(join(tmpdir(), "raya-run-retirement-"))
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let disposed = 0
  let retired = false
  const controller = new RunController({
    root: () => root,
    state: () => undefined,
    open: async () => {},
    env: async () => ({}),
    start: async () => ({
      stop: () => {
        entered.resolve()
        return gate.promise
      },
      dispose: () => disposed++,
    }),
    post: () => {},
    error: () => {},
    log: () => {},
  })
  try {
    await controller.configure()
    await controller.run("local", "vscode")
    const removal = controller.remove("local")
    await entered.promise
    const closing = controller.dispose().then(() => {
      retired = true
    })
    for (const step of [0, 1, 2, 3, 4, 5]) {
      void step
      await Promise.resolve()
    }
    const before = retired
    gate.resolve()
    await Promise.all([removal, closing])
    expect(disposed).toBe(1)
    expect(before).toBe(false)
    expect(retired).toBe(true)
    const result = await controller.remove("local").then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(result).toBeInstanceOf(Error)
  } finally {
    gate.resolve()
    await controller.dispose()
    if (!root.startsWith(join(tmpdir(), "raya-run-retirement-"))) throw new Error("Foreign cleanup directory")
    rmSync(root, { recursive: true, force: true })
  }
})
