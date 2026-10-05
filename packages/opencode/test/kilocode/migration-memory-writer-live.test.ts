import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import {
  acquireCoveredProfileRoot,
  acquireProfileRoot,
  coordinateNativeRoots,
} from "@opencode-ai/core/kilocode/profile-maintenance"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { ProfileWriterManifest } from "@/kilocode/migration/writer-manifest"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"
import { tmpdir } from "../fixture/fixture"

function count() {
  return Effect.runSync(ProfileWriterLive.snapshot).active.find((row) => row.id === "profile.data.memory")?.count ?? 0
}

test("finite runtime memory registration is idempotent while the complete manifest stays fail closed", () => {
  const admission = ProfileWriterLive.memory()
  expect(ProfileWriterLive.memory()).toBe(admission)
  expect(
    Effect.runSync(ProfileWriterLive.snapshot).registered.filter((id) => id === "profile.data.memory"),
  ).toHaveLength(1)
  expect(ProfileWriterLive.admission("profile.data.memory")).toBe(admission)
  expect(ProfileWriterManifest.manifest.writers.find((row) => row.id === "profile.data.memory")?.coverage).toBe(
    "integrated",
  )
  expect(ProfileWriterManifest.manifest.complete).toBe(false)
  expect(() => ProfileWriterRegistry.fromManifest(ProfileWriterManifest.manifest)).toThrow(
    "not complete and integrated",
  )
})

test("actual file admission is counted before its first await and remains counted through gated cleanup", async () => {
  await using tmp = await tmpdir()
  const root = { kind: "json" as const, path: path.join(tmp.path, "namespace") }
  await mkdir(root.path)
  const file = { kind: "json" as const, path: path.join(root.path, "value.json") }
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const exit = Promise.withResolvers<void>()
  const admission = ProfileWriterLive.memory()
  let settled = false
  const work = Effect.runPromise(
    admission.run(
      Effect.promise(async () => {
        const outer = await acquireProfileRoot(root)
        const child = await acquireCoveredProfileRoot(file, outer)
        await writeFile(file.path, "genuine accepted publication")
        await child.release()
        ready.resolve()
        await release.promise
        await outer.release()
        return "settled"
      }),
    ),
  ).finally(() => {
    settled = true
  })
  expect(count()).toBe(1)
  await ready.promise
  const maintenance = coordinateNativeRoots([file], async () => {
    gate.resolve()
    await exit.promise
  })
  await gate.promise
  release.resolve()
  await Bun.sleep(60)
  expect(count()).toBe(1)
  expect(settled).toBe(false)
  expect(await Bun.file(file.path).text()).toBe("genuine accepted publication")
  exit.resolve()
  await maintenance
  expect(await work).toBe("settled")
  expect(count()).toBe(0)
})

test("concurrent accepted lifetimes release exactly once and preserve original sole failures", async () => {
  const admission = ProfileWriterLive.memory()
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const one = Effect.runPromise(admission.run(Effect.promise(() => first.promise)))
  const two = Effect.runPromise(admission.run(Effect.promise(() => second.promise)))
  expect(count()).toBe(2)
  first.resolve()
  await one
  expect(count()).toBe(1)
  second.resolve()
  await two
  expect(count()).toBe(0)
  for (const err of [
    new Error("original reviewed state failure"),
    new AggregateError([new Error("body"), new Error("cleanup")], "original cleanup aggregate"),
  ]) {
    await rejects(
      Effect.runPromise(admission.run(Effect.promise(() => Promise.reject(err)))),
      (failure) => failure === err,
    )
    expect(count()).toBe(0)
  }
})
