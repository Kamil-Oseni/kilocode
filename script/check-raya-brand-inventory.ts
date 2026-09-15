#!/usr/bin/env bun
// kilocode_change - new file

/**
 * Classifies every tracked textual Kilo/Kilocode reference before the Raya
 * migration changes public names, compatibility keys, or stored data.
 *
 * The baseline is intentionally a ratchet, not a rename list. It has no line
 * numbers: a normalized line fingerprint survives indentation-only edits but
 * changes when a reference, its context, or its category changes.
 */

import { spawnSync } from "node:child_process"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const FILE = "script/raya-brand-inventory.json"
const OMIT = new Set(["script/check-raya-brand-inventory.ts", FILE])
const TOKEN = /kilo(?:-?code)?/gi
const categories = ["user-visible-defect", "compatibility-key", "upstream-provenance", "internal-migration"] as const

type Category = (typeof categories)[number]
type Hit = { file: string; token: string; context: string; category: Category }
type Rule<T, Name extends string = string> = { name: Name; match: (value: T) => boolean }
type Baseline = {
  version: 1
  description: string
  categories: Record<Category, { count: number; digest: string; reason: string }>
  total: { count: number; digest: string }
}

const provenance = (file: string) =>
  /^(?:patches\/|script\/upstream\/|translations\/|THIRD_PARTY|LICENSE|CHANGELOG|README\.md$|AGENTS\.md$)/i.test(
    file,
  ) || /(?:^|\/)(?:AGENTS|LICENSE|CHANGELOG|README)\.md$/i.test(file)

const compatible = (context: string) =>
  /@kilocode|\.kilo(?:code)?(?:\/|\\|\b)|\bkilo[-_.][\w.-]*|\bKILO_[A-Z0-9_]+|["'`]kilo(?:code|-code)?["'`]|[\\/]kilocode(?:[\\/]|\b)/i.test(
    context,
  )

const visible = (file: string) =>
  /(?:^|\/)package\.json$/i.test(file) ||
  /packages\/kilo-vscode\/webview-ui\/src\/(?:i18n\/|.*\.(?:tsx|html)$)/i.test(file) ||
  /packages\/kilo-vscode\/src\/.*\.(?:md|html)$/i.test(file)

function rules(file: string, context: string): Rule<undefined, Category>[] {
  const upstream = provenance(file)
  const key = !upstream && compatible(context)
  const ui = !upstream && !key && visible(file)
  return [
    { name: "upstream-provenance", match: () => upstream },
    { name: "compatibility-key", match: () => key },
    { name: "user-visible-defect", match: () => ui },
    { name: "internal-migration", match: () => !upstream && !key && !ui },
  ]
}

function classify<T, Name extends string>(value: T, items: Rule<T, Name>[]) {
  const found = items.filter((rule) => rule.match(value)).map((rule) => rule.name)
  if (found.length !== 1) return { found }
  return { found, value: found[0] }
}

function validate(hits: Hit[], baseline: Baseline) {
  const errs: string[] = []
  if (baseline.version !== 1) errs.push(`unsupported baseline version: ${String(baseline.version)}`)
  for (const category of Object.keys(baseline.categories)) {
    if (!categories.some((expected) => expected === category)) errs.push(`stale baseline category: ${category}`)
  }
  const grouped: Record<Category, Hit[]> = {
    "user-visible-defect": [],
    "compatibility-key": [],
    "upstream-provenance": [],
    "internal-migration": [],
  }
  for (const hit of hits) grouped[hit.category].push(hit)
  const encoded = (items: Hit[]) =>
    items
      .map((hit) => JSON.stringify(hit))
      .sort()
      .join("\n")
  const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

  for (const category of categories) {
    const expected = baseline.categories[category]
    if (!expected) {
      errs.push(`missing baseline category: ${category}`)
      continue
    }
    const items = grouped[category]
    const digest = hash(encoded(items))
    if (expected.count !== items.length)
      errs.push(`${category}: expected ${expected.count} reference(s), found ${items.length}`)
    if (expected.digest !== digest)
      errs.push(`${category}: reference context drifted (expected ${expected.digest}, found ${digest})`)
  }

  const digest = hash(encoded(hits))
  if (baseline.total.count !== hits.length) errs.push(`total: expected ${baseline.total.count}, found ${hits.length}`)
  if (baseline.total.digest !== digest)
    errs.push(`total reference context drifted (expected ${baseline.total.digest}, found ${digest})`)
  return { errs, grouped, digest, hash, encoded }
}

function selftest() {
  const one = classify("x", [
    { name: "a", match: () => true },
    { name: "b", match: () => false },
  ])
  const none = classify("x", [{ name: "a", match: () => false }])
  const overlap = classify("x", [
    { name: "a", match: () => true },
    { name: "b", match: () => true },
  ])
  if (one.value !== "a" || none.found.length !== 0 || overlap.found.length !== 2)
    throw new Error("classification self-test failed")

  const empty = new Bun.CryptoHasher("sha256").update("").digest("hex")
  const baseline: Baseline = {
    version: 1,
    description: "fixture",
    categories: {
      "user-visible-defect": { count: 0, digest: empty, reason: "fixture" },
      "compatibility-key": { count: 0, digest: empty, reason: "fixture" },
      "upstream-provenance": { count: 0, digest: empty, reason: "fixture" },
      "internal-migration": { count: 1, digest: empty, reason: "fixture" },
    },
    total: { count: 1, digest: empty },
  }
  const hit: Hit = { file: "x.ts", token: "kilo", context: "kilo", category: "internal-migration" }
  baseline.categories["internal-migration"].count = 2
  const errs = validate([hit], baseline).errs.join("\n")
  if (
    !errs.includes("internal-migration: expected 2 reference(s), found 1") ||
    !errs.includes("internal-migration: reference context drifted") ||
    !errs.includes("total reference context drifted")
  )
    throw new Error("drift self-test failed")
  const stale = {
    ...baseline,
    categories: { ...baseline.categories, legacy: { count: 0, digest: empty, reason: "stale fixture" } },
  }
  const staleErrs = validate([hit], stale).errs
  if (!staleErrs.some((err) => err.includes("stale baseline category")))
    throw new Error("stale baseline self-test failed")
  console.log("check-raya-brand-inventory: self-test passed (unmatched, overlap, stale and drift cases).")
}

if (process.argv.includes("--self-test")) {
  selftest()
  process.exit(0)
}

const git = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer" })
if (git.status !== 0) {
  console.error(git.stderr?.toString().trim() || "git ls-files failed")
  process.exit(1)
}

const hits: Hit[] = []
const files = git.stdout
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((file) => !OMIT.has(file))
for (const file of files) {
  const data = await Bun.file(path.join(ROOT, file))
    .arrayBuffer()
    .catch(() => null)
  if (!data) continue
  const bytes = new Uint8Array(data)
  if (bytes.includes(0)) continue
  const text = new TextDecoder("utf8", { fatal: false }).decode(bytes)
  for (const line of text.split(/\r?\n/)) {
    const context = line.trim().replace(/\s+/g, " ")
    TOKEN.lastIndex = 0
    for (const match of context.matchAll(TOKEN)) {
      const result = classify(undefined, rules(file, context))
      if (!result.value) {
        console.error(
          `${file}: reference ${JSON.stringify(match[0])} matched ${result.found.length} categories: ${result.found.join(", ")}`,
        )
        process.exit(1)
      }
      hits.push({
        file: file.replaceAll("\\", "/"),
        token: match[0].toLowerCase(),
        context,
        category: result.value,
      })
    }
  }
}

hits.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
const template: Baseline = {
  version: 1,
  description:
    "Checked Raya migration baseline. Public defects are fixed in small batches; compatibility keys require dual-read migration; provenance stays attributed; internal names migrate after public contracts stabilize.",
  categories: {
    "user-visible-defect": {
      count: 0,
      digest: "",
      reason: "Potential user-facing Kilo names in extension manifests or rendered webview sources.",
    },
    "compatibility-key": {
      count: 0,
      digest: "",
      reason:
        "Persisted, protocol, package, command, path, provider, environment or API identity requiring a dual-read migration.",
    },
    "upstream-provenance": {
      count: 0,
      digest: "",
      reason: "Legal, attribution, fork documentation, translation process or upstream merge material.",
    },
    "internal-migration": {
      count: 0,
      digest: "",
      reason: "Internal source identity that can migrate after public and stored compatibility contracts stabilize.",
    },
  },
  total: { count: 0, digest: "" },
}

const current = validate(hits, template)
if (process.argv.includes("--update")) {
  for (const category of categories) {
    const items = current.grouped[category]
    template.categories[category].count = items.length
    template.categories[category].digest = current.hash(current.encoded(items))
  }
  template.total = { count: hits.length, digest: current.hash(current.encoded(hits)) }
  await Bun.write(path.join(ROOT, FILE), JSON.stringify(template, null, 2) + "\n")
  console.log(`check-raya-brand-inventory: wrote ${hits.length} classified reference(s) to ${FILE}.`)
  process.exit(0)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function entry(value: unknown) {
  if (!record(value)) throw new Error("invalid brand inventory category")
  const item = value
  if (typeof item.count !== "number" || typeof item.digest !== "string" || typeof item.reason !== "string")
    throw new Error("invalid brand inventory category")
  return { count: item.count, digest: item.digest, reason: item.reason }
}

function parse(value: unknown): Baseline {
  if (!record(value)) throw new Error("invalid brand inventory")
  const data = value
  if (!record(data.categories)) throw new Error("invalid brand inventory categories")
  if (!record(data.total)) throw new Error("invalid brand inventory total")
  const source = data.categories
  const total = data.total
  if (typeof data.description !== "string" || typeof total.count !== "number" || typeof total.digest !== "string")
    throw new Error("invalid brand inventory fields")
  if (data.version !== 1) throw new Error(`unsupported brand inventory version: ${String(data.version)}`)
  return {
    version: 1,
    description: data.description,
    categories: {
      "user-visible-defect": entry(source["user-visible-defect"]),
      "compatibility-key": entry(source["compatibility-key"]),
      "upstream-provenance": entry(source["upstream-provenance"]),
      "internal-migration": entry(source["internal-migration"]),
      ...Object.fromEntries(Object.entries(source).filter(([key]) => !categories.some((category) => category === key))),
    },
    total: { count: total.count, digest: total.digest },
  }
}

const raw: unknown = await Bun.file(path.join(ROOT, FILE)).json()
const baseline = parse(raw)
const result = validate(hits, baseline)
if (result.errs.length) {
  for (const err of result.errs) console.error(err)
  console.error("Run with --update only after reviewing each changed reference and its migration category.")
  process.exit(1)
}

console.log(
  `check-raya-brand-inventory: ${hits.length} reference(s) classified (${categories.map((category) => `${category}=${result.grouped[category].length}`).join(", ")}).`,
)
