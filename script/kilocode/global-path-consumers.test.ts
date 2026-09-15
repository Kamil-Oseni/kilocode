// kilocode_change - new file

import { expect, test } from "bun:test"
import { checkProducer, compare, make, scanSource } from "./global-path-consumers"

test("the producer and public interface expose only the reviewed fields", () => {
  const source = `const paths = { home: "", data: "", cache: "", config: "", state: "", tmp: "", bin: "", log: "", repos: "" }
interface Interface { home: string; data: string; cache: string; config: string; state: string; tmp: string; bin: string; log: string; repos: string }`
  expect(checkProducer(source)).toEqual([])
  expect(checkProducer(source.replace('repos: ""', 'repos: "", future: ""')).join("\n")).toContain(
    "Global.Path producer fields changed",
  )
  expect(checkProducer(source.replace("repos: string", "future: string")).join("\n")).toContain(
    "Global interface fields changed",
  )
})

test("classifies aliases, runtime reads, module captures and writes", () => {
  const result = scanSource(
    "fixture.ts",
    `import { Global as Roots } from "@opencode-ai/core/global"
const eager = Roots.Path.data
export function run() {
  const cache = Roots.Path["cache"]
  Roots.Path.state = cache
  const names = Object.keys(Roots.Path)
  return eager
}`,
  )
  expect(result.errors).toEqual([])
  expect(result.consumers).toEqual([
    {
      file: "fixture.ts",
      member: "data",
      phase: "module",
      access: "read",
      context: "const eager = Roots.Path.data",
      ordinal: 1,
    },
    {
      file: "fixture.ts",
      member: "cache",
      phase: "runtime",
      access: "read",
      context: 'const cache = Roots.Path["cache"]',
      ordinal: 1,
    },
    {
      file: "fixture.ts",
      member: "state",
      phase: "runtime",
      access: "write",
      context: "Roots.Path.state = cache",
      ordinal: 1,
    },
    {
      file: "fixture.ts",
      member: "*",
      phase: "runtime",
      access: "read",
      context: "const names = Object.keys(Roots.Path)",
      ordinal: 1,
    },
  ])
})

test("fails closed for bare, dynamic and unknown path access", () => {
  const result = scanSource(
    "fixture.ts",
    `import { Global } from "@opencode-ai/core/global"
const all = Global.Path
const key = "data"
const dynamic = Global.Path[key]
const unknown = Global.Path.future`,
  )
  expect(result.consumers).toEqual([])
  expect(result.errors).toHaveLength(3)
  expect(result.errors.join("\n")).toContain("bare Global.Path access")
  expect(result.errors.join("\n")).toContain("dynamic Global.Path member")
  expect(result.errors.join("\n")).toContain("unknown Global.Path member future")
})

test("tracks direct Path and namespace imports but ignores unrelated globals", () => {
  const direct = scanSource(
    "direct.ts",
    'import { Path as Roots } from "@opencode-ai/core/global"\nconst data = Roots.data',
  )
  const namespace = scanSource(
    "namespace.ts",
    'import * as CoreGlobal from "@opencode-ai/core/global"\nconst state = CoreGlobal.Path.state\nconst cache = CoreGlobal.Global.Path.cache',
  )
  const unrelated = scanSource("unrelated.ts", "const Global = { Path: { data: 'x' } }\nconsole.log(Global.Path.data)")
  const dynamic = scanSource(
    "dynamic.ts",
    'async function load() { const { Global: Roots } = await import("@opencode-ai/core/global"); return Roots.Path.data }',
  )
  expect(direct.errors).toEqual([])
  expect(direct.consumers.map((item) => item.member)).toEqual(["data"])
  expect(namespace.errors).toEqual([])
  expect(namespace.consumers.map((item) => item.member)).toEqual(["state", "cache"])
  expect(dynamic.consumers.map((item) => item.member)).toEqual(["data"])
  expect(unrelated).toEqual({ consumers: [], errors: [] })
})

test("detects baseline count, context and policy drift", () => {
  const first = scanSource("fixture.ts", 'import { Global } from "./global"\nconst data = Global.Path.data').consumers
  const second = scanSource("fixture.ts", 'import { Global } from "./global"\nconst data = Global.Path.cache').consumers
  const baseline = make(first)
  const changed = make(second)
  expect(compare(baseline, baseline)).toEqual([])
  expect(compare(changed, baseline).join("\n")).toContain("Global.Path consumer context changed")
  expect(compare(changed, baseline).join("\n")).toContain("Global.Path member totals changed")
  expect(compare(baseline, { ...baseline, policy: "cutover-ready" as never }).join("\n")).toContain(
    "must not count as storage-cutover evidence",
  )
})
