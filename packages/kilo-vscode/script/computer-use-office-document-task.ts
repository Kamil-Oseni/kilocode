#!/usr/bin/env bun
// A disposable OOXML document task. File state alone cannot attest installed Office or Raya input.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inflateRawSync } from "node:zlib"
import { XMLParser } from "fast-xml-parser"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const format = "raya.installed-office-document-task"
const version = 1
const scenario = "office-document-editing" satisfies (typeof scenarios)[number]
const original = [
  "Raya office editing task",
  "Decision: Pending",
  "Owner: Unassigned",
  "Notes: Keep unchanged.",
] as const

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  createdAt: string
  code: string
  sourceSha256: string
  extension: { version: string; captureSha256: string; root: string }
}

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function unpack(data: Buffer, offset: number, compressed: number, size: number, method: number) {
  if (offset + 30 > data.length || data.readUInt32LE(offset) !== 0x04034b50)
    throw new Error("Invalid DOCX ZIP local entry")
  const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28)
  if (start + compressed > data.length) throw new Error("Truncated DOCX ZIP entry")
  const body = data.subarray(start, start + compressed)
  const result = method === 8 ? inflateRawSync(body, { maxOutputLength: 1_000_001 }) : body
  if (result.length !== size) throw new Error("Invalid DOCX ZIP entry size")
  return result
}

function entries(data: Buffer) {
  if (data.length > 10_000_000) throw new Error("Document exceeds fixture limit")
  let end = -1
  for (let pos = data.length - 22; pos >= Math.max(0, data.length - 65557); pos--) {
    if (data.readUInt32LE(pos) === 0x06054b50) {
      end = pos
      break
    }
  }
  if (end < 0) throw new Error("Invalid DOCX ZIP directory")
  const count = data.readUInt16LE(end + 10)
  let pos = data.readUInt32LE(end + 16)
  if (count > 200 || pos >= end) throw new Error("Document ZIP is too large or invalid")
  const found = new Map<string, Buffer>()
  for (let index = 0; index < count; index++) {
    if (pos + 46 > end || data.readUInt32LE(pos) !== 0x02014b50) throw new Error("Invalid DOCX ZIP entry")
    const flags = data.readUInt16LE(pos + 8)
    const method = data.readUInt16LE(pos + 10)
    const compressed = data.readUInt32LE(pos + 20)
    const size = data.readUInt32LE(pos + 24)
    const length = data.readUInt16LE(pos + 28)
    const extra = data.readUInt16LE(pos + 30)
    const comment = data.readUInt16LE(pos + 32)
    const offset = data.readUInt32LE(pos + 42)
    if (pos + 46 + length + extra + comment > end || size > 1_000_000 || compressed > 1_000_000)
      throw new Error("Document ZIP entry exceeds fixture limit")
    if (flags & 1 || ![0, 8].includes(method)) throw new Error("Unsupported DOCX ZIP entry")
    const name = data.subarray(pos + 46, pos + 46 + length).toString("utf8")
    if (found.has(name)) throw new Error("Duplicate DOCX ZIP entry")
    found.set(name, unpack(data, offset, compressed, size, method))
    pos += 46 + length + extra + comment
  }
  return found
}

function text(node: unknown): string {
  if (typeof node === "string") return node
  if (!node || typeof node !== "object") return ""
  if (Array.isArray(node)) return node.map(text).join("")
  const item = node as Record<string, unknown>
  return Object.entries(item)
    .filter(
      ([key]) => key === "w:t" || key === "w:r" || key === "w:hyperlink" || key === "w:ins" || key === "w:smartTag",
    )
    .map(([, value]) => text(value))
    .join("")
}

export function paragraphs(data: Buffer) {
  const zip = entries(data)
  if (!zip.has("[Content_Types].xml") || !zip.has("_rels/.rels") || !zip.has("word/document.xml"))
    throw new Error("Missing core DOCX parts")
  const xml = zip.get("word/document.xml")?.toString("utf8")
  if (!xml) throw new Error("Empty Word document")
  const parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: false }).parse(xml) as {
    "w:document"?: { "w:body"?: { "w:p"?: unknown } }
  }
  const body = parsed["w:document"]?.["w:body"]?.["w:p"]
  if (!body) throw new Error("No Word paragraphs")
  return (Array.isArray(body) ? body : [body]).map(text)
}

function extension(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const ext = input as Record<string, unknown>
  return (
    typeof ext.version === "string" &&
    typeof ext.root === "string" &&
    typeof ext.captureSha256 === "string" &&
    /^[\da-f]{64}$/i.test(ext.captureSha256)
  )
}

function valid(input: unknown): input is Manifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const item = input as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) return false
  if (typeof item.code !== "string" || !/^[A-F\d]{8}$/.test(item.code)) return false
  if (typeof item.sourceSha256 !== "string" || !/^[\da-f]{64}$/i.test(item.sourceSha256)) return false
  return extension(item.extension)
}

async function manifest(dir: string) {
  if (!(await lstat(join(dir, "task.json"))).isFile()) throw new Error("Invalid task manifest file")
  const input = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as unknown
  if (!valid(input)) throw new Error("Invalid or modified task manifest")
  return input
}

export async function prepare(root: string, installed: string, source: string) {
  if (process.platform !== "win32") throw new Error("The installed Office task requires Windows")
  const ext = await inspect(installed)
  const doc = await readFile(source)
  if (paragraphs(doc).join("\n") !== original.join("\n"))
    throw new Error("Source DOCX must contain the exact four baseline paragraphs")
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const input: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    code: randomBytes(4).toString("hex").toUpperCase(),
    sourceSha256: digest(doc),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
  }
  await copyFile(source, join(dir, "baseline.docx"))
  await copyFile(source, join(dir, "Working.docx"))
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction: `Open Working.docx in Microsoft Word. Change Decision: Pending to Decision: Approved for ${input.code} and Owner: Unassigned to Owner: Raya. Keep the title and notes unchanged. Save the document; do not edit files through a script.`,
    releaseGateEligible: false,
  }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  const actual = (await readdir(dir)).sort()
  const expected = ["baseline.docx", "Working.docx", "task.json"]
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const changed: string[] = []
  for (const name of expected.filter((name) => actual.includes(name)))
    if (!(await lstat(join(dir, name))).isFile()) changed.push(name)
  if (actual.includes("baseline.docx") && !changed.includes("baseline.docx"))
    if (digest(await readFile(join(dir, "baseline.docx"))) !== input.sourceSha256) changed.push("baseline.docx")
  const result =
    actual.includes("Working.docx") && !changed.includes("Working.docx")
      ? await readFile(join(dir, "Working.docx"))
          .then(paragraphs)
          .catch(() => undefined)
      : undefined
  const target = [original[0], `Decision: Approved for ${input.code}`, "Owner: Raya", original[3]]
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState:
      !missing.length && !unexpected.length && !changed.length && result?.join("\n") === target.join("\n"),
    missing,
    unexpected,
    changed,
    paragraphs: result,
    releaseGateEligible: false,
    note: "The scorer independently reads the saved OOXML paragraphs and baseline hash. It cannot prove Microsoft Word was opened, Raya acted through the installed host, no edits occurred elsewhere, or the rendered document remained visually sound.",
  }
}

if (import.meta.main) {
  const [cmd, root, installed, source] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-office-document-task.ts prepare <empty-task-dir> <installed-extension-dir> <source.docx> | score <task-dir>",
    )
  const result =
    cmd === "prepare" && installed && source
      ? await prepare(root, installed, source)
      : cmd === "score"
        ? await score(root)
        : undefined
  if (!result) throw new Error("Unknown command or missing source or installed extension")
  console.log(JSON.stringify(result, null, 2))
  if (cmd === "score" && !result.correctFinalState) process.exitCode = 2
}
