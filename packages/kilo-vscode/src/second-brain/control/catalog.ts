import path from "node:path"
import { check } from "./frames"
import { release, bridge as modern } from "./catalog-v2"

const sources = Object.freeze({
  "server.py": "51a19ed48dc3ec36ca608a141b3d1acca681c6993dde189ac8fc2ab04ae288b2",
  "index.py": "6ce3985be9f34ef758f02091ce8052a181a8ece154fc6ef6bc3649e11ba984f9",
  "notes.py": "59488d324200d95b0974bfa119215de627bc1b17dd3233fc6b02ab137b651923",
  "policy.py": "87c931cfa7cceb7386e6d2b4b05fdacf916360fd2cb0ff590d0fccf5dd334ae2",
  "admission.py": "5a4ae56bc2a5d55e0a1dab14c1401a98b56ebc5fedf9b8bd5312d84899877770",
  "host.py": "4854ab90b06085450136e764ec1f70034ae27c597af9b6fa98a99860aa049a97",
})
const interpreter = "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2"
const bridge = "d135c8c3f6a0ca8c2a746f5c7ac74f65909ff4ee4a7df8a1459a31ddb1c1abe5"

export type Catalog = Readonly<{
  format: "raya.memory.control.catalog"
  version: 1 | 2
  python: string
  source: string
  bridge: string
  python_sha256: string
  bridge_sha256: string
  source_sha256: Readonly<Record<string, string>>
}>

function object(input: unknown): Record<string, unknown> {
  check(input !== null && typeof input === "object" && !Array.isArray(input), "Control catalog object required")
  return input as Record<string, unknown>
}

function absolute(input: unknown): string {
  check(
    typeof input === "string" && input.length <= 4096 && !/[\u0000-\u001f]/.test(input) && path.isAbsolute(input),
    "Absolute local catalog path required",
  )
  check(!input.startsWith("\\\\") && !input.startsWith("//"), "Remote catalog paths refused")
  return input
}

/** Validate a deliberately selected control release; search setup is not control consent. */
export function parseCatalog(input: unknown): Catalog {
  const row = object(input)
  check(
    Object.keys(row).sort().join("|") ===
      ["format", "version", "python", "source", "bridge", "python_sha256", "bridge_sha256", "source_sha256"]
        .sort()
        .join("|"),
    "Exact control catalog fields required",
  )
  check(
    row.format === "raya.memory.control.catalog" && (row.version === 1 || row.version === 2),
    "Control catalog version refused",
  )
  const selected = row.version === 2 ? release : sources
  const transport = row.version === 2 ? modern : bridge
  check(row.python_sha256 === interpreter && row.bridge_sha256 === transport, "Unreviewed control release refused")
  const pins = object(row.source_sha256)
  check(Object.keys(pins).sort().join("|") === Object.keys(selected).sort().join("|"), "Exact source pins required")
  for (const [name, digest] of Object.entries(selected)) {
    check(pins[name] === digest, "Unreviewed control source refused")
  }
  return Object.freeze({
    format: "raya.memory.control.catalog",
    version: row.version,
    python: absolute(row.python),
    source: absolute(row.source),
    bridge: absolute(row.bridge),
    python_sha256: interpreter,
    bridge_sha256: transport,
    source_sha256: selected,
  })
}
