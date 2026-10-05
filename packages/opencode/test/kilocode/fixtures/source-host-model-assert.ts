import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type z from "zod"
import { payload } from "../../../src/kilocode/migration/profile-bundle"

export async function verifyModels(bundle: z.output<typeof payload>) {
  const groups = bundle.disposition?.files.filter((item) => item.disposition.kind === "host-model") ?? []
  assert.equal(groups.length, 1)
  const record = groups[0]
  assert.equal(record.disposition.kind, "host-model")
  if (record.disposition.kind !== "host-model") throw new Error("Actual host model correspondence is absent")
  const entry = record.disposition
  const bytes = await readFile(entry.source)
  assert.equal(bytes.length, record.bytes)
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.digest)
  assert.equal(entry.dev, record.dev)
  assert.equal(entry.ino, record.ino)
  assert.equal(entry.activation, "inert")
  assert.equal(entry.rawBytesPreserved, false)
  const current = bundle.host?.hosts.find((item) => item.id === entry.host)
  const owner = current?.owners.find((item) => item.id === entry.owner)
  assert.ok(owner?.models)
  assert.equal(owner.revision, entry.revision)
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), owner.models)
  const changed = structuredClone(bundle)
  const target = changed.host?.hosts
    .find((item) => item.id === entry.host)
    ?.owners.find((item) => item.id === entry.owner)
  assert.ok(target)
  target.revision++
  assert.equal(payload.safeParse(changed).success, false)
  return { count: groups.length, exactNativeBytes: true, inertModelChoices: true, tamperRefused: true }
}
