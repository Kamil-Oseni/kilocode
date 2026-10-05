import { expect, test } from "bun:test"
import { mkdtemp, lstat, rename, writeFile, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigIntent } from "../../src/kilocode/config-intent"

const setup = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-config-atomic-"))
  const file = path.join(root, "kilo.jsonc")
  await writeFile(file, '{"model":"test/before"}', { mode: 0o600 })
  return { root, file }
}

test("atomic JSON publication retains mode and changes only its owned file generation", async () => {
  const cfg = await setup()
  const before = await lstat(cfg.file, { bigint: true })
  const ticket = await ConfigIntent.writing(cfg.file, '{"model":"test/before"}', '{"model":"test/after"}', {
    atomic: true,
    mode: 0o600,
  })
  const receipt = await ticket.publish()
  await ticket.complete(receipt)
  const after = await lstat(cfg.file, { bigint: true })
  expect(after.ino).not.toBe(before.ino)
  expect(await Bun.file(cfg.file).text()).toBe('{"model":"test/after"}')
  if (process.platform !== "win32") expect(Number(after.mode) & 0o777).toBe(0o600)
  expect((await readdir(cfg.root)).filter((name) => name !== ".raya-profile-locks")).toEqual(["kilo.jsonc"])
})

test("serialized receipts and another ticket publication cannot authorize JSON completion", async () => {
  const first = await setup()
  const second = await setup()
  const left = await ConfigIntent.writing(first.file, '{"model":"test/before"}', "{}", { atomic: true })
  const right = await ConfigIntent.writing(second.file, '{"model":"test/before"}', "{}", { atomic: true })
  await left.publish()
  const receipt = await right.publish()
  await expect(left.complete(receipt)).rejects.toThrow("publication receipt differs")
  await expect(right.complete(JSON.parse(JSON.stringify(receipt)))).rejects.toThrow("receipt is unknown")
  expect(await Bun.file(first.file).text()).toBe("{}")
})

test("foreign replacement with identical bytes after publication refuses the changed physical identity", async () => {
  const cfg = await setup()
  const ticket = await ConfigIntent.writing(cfg.file, '{"model":"test/before"}', "{}", { atomic: true })
  const receipt = await ticket.publish()
  const replacement = path.join(cfg.root, "foreign.json")
  await writeFile(replacement, "{}")
  await rename(replacement, cfg.file)
  await expect(ticket.complete(receipt)).rejects.toThrow("publication receipt differs")
  expect(await Bun.file(cfg.file).text()).toBe("{}")
})

test("changed predecessor refuses before atomic replacement and preserves foreign bytes", async () => {
  const cfg = await setup()
  const ticket = await ConfigIntent.writing(cfg.file, '{"model":"test/before"}', "{}", { atomic: true })
  await writeFile(cfg.file, '{"model":"test/foreign"}')
  await expect(ticket.publish()).rejects.toThrow("atomic publication failed")
  ticket.fail(new Error("Actual foreign predecessor refusal"))
  expect(await Bun.file(cfg.file).text()).toBe('{"model":"test/foreign"}')
})
