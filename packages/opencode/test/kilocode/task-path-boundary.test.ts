import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { RayaPath } from "../../src/kilocode/task/path-boundary"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("canonicalizes existing and missing paths through a directory link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-path-"))
  roots.push(root)
  const target = path.join(root, "target")
  const link = path.join(root, "link")
  await mkdir(target)
  await writeFile(path.join(target, "saved.txt"), "saved")
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir")

  const layer = AppNodeBuilder.build(FSUtil.node)
  const existing = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return yield* RayaPath.canonical(fs, path.join(link, "saved.txt"))
    }).pipe(Effect.provide(layer)),
  )
  const missing = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return yield* RayaPath.canonical(fs, path.join(link, "new", "report.txt"))
    }).pipe(Effect.provide(layer)),
  )

  expect(existing).toBe(path.join(target, "saved.txt"))
  expect(missing).toBe(path.join(target, "new", "report.txt"))
  expect(RayaPath.patterns(root, [path.join(link, "saved.txt"), existing])).toEqual([
    "link/saved.txt",
    "target/saved.txt",
  ])
})
