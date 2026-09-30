import { expect, test } from "bun:test"
import { Scrubber } from "@/kilocode/session-export/worker/scrub"

test("batch cache preserves every repeated redaction occurrence across concurrent events", async () => {
  const scrubber = new Scrubber({ patterns: [{ name: "private", regex: /private/g }] }).batch()
  const results = await Promise.all([
    scrubber.scrubEvent({ text: ["private two private", "private two private"] }),
    scrubber.scrubEvent({ text: ["private two private", "private two private"] }),
  ])
  for (const result of results) {
    expect(result.success).toBe(true)
    expect(result.data.text).toEqual([
      "<<REDACTED:private>> two <<REDACTED:private>>",
      "<<REDACTED:private>> two <<REDACTED:private>>",
    ])
    expect(result.report.redactionsByType.private).toBe(4)
  }
})

test("batch cache evicts failed scrub promises without changing fail-closed results", async () => {
  const scrubber = new Scrubber({
    patterns: [{ name: "invalid", regex: Symbol("invalid policy") as unknown as RegExp }],
  }).batch()
  const results = await Promise.all([scrubber.scrubEvent("same"), scrubber.scrubEvent("same")])
  for (const result of results) expect(result.success).toBe(false)
  const cache: unknown = Reflect.get(scrubber, "cache")
  if (!(cache instanceof Map)) throw new Error("Batch cache is unavailable")
  expect(cache.size).toBe(0)
  expect((await scrubber.scrubEvent("same")).success).toBe(false)
  expect(cache.size).toBe(0)
})

test("batch cache caps retained entries and UTF-8 bytes without skipping scrubbed content", async () => {
  const scrubber = new Scrubber().batch()
  const values = Array.from({ length: 140 }, (_, seq) => `metadata-${seq}`)
  const result = await scrubber.scrubEvent(values)
  expect(result.success).toBe(true)
  expect(result.data).toEqual(values)
  const cache: unknown = Reflect.get(scrubber, "cache")
  if (!(cache instanceof Map)) throw new Error("Batch cache is unavailable")
  expect(cache.size).toBe(128)
  const fresh = new Scrubber().batch()
  const unicode = "界".repeat(2000)
  expect((await fresh.scrubEvent(unicode)).data).toBe(unicode)
  const large: unknown = Reflect.get(fresh, "cache")
  if (!(large instanceof Map)) throw new Error("Batch cache is unavailable")
  expect(large.size).toBe(0)
  const expanded = new Scrubber({ patterns: [{ name: "expanded", regex: /a/g }] }).batch()
  const output = await expanded.scrubEvent("a".repeat(256))
  expect(output.success).toBe(true)
  expect(output.report.redactionsByType.expanded).toBe(256)
  expect(Buffer.byteLength(output.data)).toBeGreaterThan(4096)
  const retained: unknown = Reflect.get(expanded, "cache")
  if (!(retained instanceof Map)) throw new Error("Batch cache is unavailable")
  expect(retained.size).toBe(0)
}, 30_000)

test("a later batch reevaluates identical text against its current policy", async () => {
  const patterns: { name: string; regex: RegExp }[] = []
  const scrubber = new Scrubber({ patterns })
  expect((await scrubber.batch().scrubEvent("example")).data).toBe("example")
  patterns.push({ name: "changed", regex: /example/g })
  const result = await scrubber.batch().scrubEvent("example")
  expect(result.data).toBe("<<REDACTED:changed>>")
  expect(result.report.redactionsByType.changed).toBe(1)
  expect(Reflect.get(scrubber, "cache")).toBeUndefined()
})
