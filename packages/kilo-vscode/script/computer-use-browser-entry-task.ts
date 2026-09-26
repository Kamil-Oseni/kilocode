#!/usr/bin/env bun
// Disposable browser fixture and independent final-state scorer. This does not drive or attest Raya.
import { createHash, randomInt, randomUUID } from "node:crypto"
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspect } from "./computer-use-installed-probe"

const format = "raya.installed-browser-entry-task"
const version = 1
const names = ["Aster", "Birch", "Cedar"] as const
const regions = ["North", "East", "West"] as const

type Row = { name: string; region: string; units: number }
type Manifest = {
  format: typeof format
  version: typeof version
  scenario: "browser-research-entry"
  runId: string
  extension: { version: string; captureSha256: string; root: string }
  createdAt: string
  seed: number
  sourceSha256: string
  entrySha256: string
}

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function expected(seed: number): Row[] {
  return names.map((name, index) => ({ name, region: regions[index], units: seed + index * 7 }))
}

function source(seed: number) {
  const rows = expected(seed)
    .map((row) => `<tr><th scope="row">${row.name}</th><td>${row.region}</td><td>${row.units}</td></tr>`)
    .join("\n")
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Allocation notes</title><h1>Allocation notes</h1><p>Use the approved units for each project.</p><table><thead><tr><th>Project</th><th>Region</th><th>Approved units</th></tr></thead><tbody>${rows}</tbody></table><p><a href="/entry">Open the entry form</a></p></html>\n`
}

const entry = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Allocation entry</title><h1>Allocation entry</h1><p>Read the allocation notes, then enter each project's region and approved units.</p><p><a href="/source">Read allocation notes</a></p><form id="entry"><table><thead><tr><th>Project</th><th>Region</th><th>Approved units</th></tr></thead><tbody>${names.map((name) => `<tr><th scope="row">${name}</th><td><input name="${name}-region" aria-label="${name} region" required></td><td><input name="${name}-units" aria-label="${name} approved units" type="number" min="0" required></td></tr>`).join("")}</tbody></table><button type="submit">Submit entries</button></form><p id="status" role="status"></p><script>document.querySelector("#entry").addEventListener("submit", async (event) => {event.preventDefault();const form = new FormData(event.currentTarget);const rows = ${JSON.stringify(names)}.map((name) => ({name,region:form.get(name+"-region"),units:Number(form.get(name+"-units"))}));const response = await fetch("/submit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rows})});document.querySelector("#status").textContent = response.ok ? "Entries submitted" : "Submission failed";});</script></html>\n`

function valid(input: unknown): input is Manifest {
  if (!input || typeof input !== "object") return false
  const item = input as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== "browser-research-entry") return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (!item.extension || typeof item.extension !== "object") return false
  const ext = item.extension as Record<string, unknown>
  if (typeof ext.version !== "string" || typeof ext.root !== "string") return false
  if (!/^[\da-f]{64}$/i.test(String(ext.captureSha256))) return false
  if (typeof item.seed !== "number" || !Number.isInteger(item.seed) || item.seed < 20 || item.seed > 80) return false
  return item.sourceSha256 === digest(source(item.seed)) && item.entrySha256 === digest(entry)
}

async function manifest(root: string) {
  if (!(await lstat(join(root, "task.json"))).isFile()) throw new Error("Invalid task manifest file")
  const input = JSON.parse(await readFile(join(root, "task.json"), "utf8")) as unknown
  if (!valid(input)) throw new Error("Invalid or modified task manifest")
  return input
}

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The installed desktop task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const seed = randomInt(20, 81)
  const input: Manifest = {
    format,
    version,
    scenario: "browser-research-entry",
    runId: randomUUID(),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
    createdAt: new Date().toISOString(),
    seed,
    sourceSha256: digest(source(seed)),
    entrySha256: digest(entry),
  }
  await writeFile(join(dir, "source.html"), source(seed), { flag: "wx" })
  await writeFile(join(dir, "entry.html"), entry, { flag: "wx" })
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction:
      "In the local browser app, read Allocation notes. Enter the region and approved units for Aster, Birch, and Cedar in the entry form, then submit once. Do not alter the source or create other files in this task folder.",
    next: `bun computer-use-browser-entry-task.ts serve "${dir}"`,
  }
}

function matches(input: unknown, seed: number) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const item = input as Record<string, unknown>
  if (Object.keys(item).length !== 1 || !Array.isArray(item.rows) || item.rows.length !== names.length) return false
  return item.rows.every((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false
    const data = row as Record<string, unknown>
    const goal = expected(seed)[index]
    return (
      Object.keys(data).length === 3 &&
      data.name === goal.name &&
      data.region === goal.region &&
      data.units === goal.units
    )
  })
}

async function intact(root: string, name: string, hash?: string) {
  if (!(await lstat(join(root, name))).isFile()) return false
  return !hash || digest(await readFile(join(root, name))) === hash
}

async function submissions(root: string) {
  const data = await readFile(join(root, "submissions.jsonl"), "utf8")
  const lines = data.endsWith("\n") ? data.slice(0, -1).split("\n") : data ? [data] : []
  const items: unknown[] = []
  let invalid = !!data && !data.endsWith("\n")
  for (const line of lines) {
    try {
      items.push(JSON.parse(line) as unknown)
    } catch {
      invalid = true
    }
  }
  return { items, invalid }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  const actual = (await readdir(dir)).sort()
  const expectedFiles = ["entry.html", "source.html", "submissions.jsonl", "task.json"]
  const missing = expectedFiles.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expectedFiles.includes(name))
  const changed: string[] = []
  const hashes: Record<string, string | undefined> = {
    "task.json": undefined,
    "source.html": input.sourceSha256,
    "entry.html": input.entrySha256,
    "submissions.jsonl": undefined,
  }
  for (const name of expectedFiles.filter((name) => actual.includes(name))) {
    if (!(await intact(dir, name, hashes[name]))) changed.push(name)
  }
  const saved =
    actual.includes("submissions.jsonl") && !changed.includes("submissions.jsonl")
      ? await submissions(dir)
      : { items: [] as unknown[], invalid: false }
  if (saved.invalid || (saved.items.length === 1 && !matches(saved.items[0], input.seed)))
    changed.push("submissions.jsonl")
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario: input.scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length && saved.items.length === 1,
    missing,
    unexpected,
    changed,
    submissions: saved.items.length,
    replay: saved.items.length > 1,
    releaseGateEligible: false,
    note: "The scorer checks the local browser app's saved source and submission count. It cannot attest who acted, visual browser behavior, actions outside this folder, policy compliance, model metrics, host reload, or the other benchmark scenarios.",
  }
}

export async function serve(root: string, port = 0) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  if (!(await lstat(join(dir, "source.html"))).isFile()) throw new Error("Invalid source page")
  if (!(await lstat(join(dir, "entry.html"))).isFile()) throw new Error("Invalid entry page")
  if (digest(await readFile(join(dir, "source.html"))) !== input.sourceSha256) throw new Error("Modified source page")
  if (digest(await readFile(join(dir, "entry.html"))) !== input.entrySha256) throw new Error("Modified entry page")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/source")
        return new Response(Bun.file(join(dir, "source.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/entry"))
        return new Response(Bun.file(join(dir, "entry.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      if (request.method !== "POST" || url.pathname !== "/submit") return new Response("Not found", { status: 404 })
      const origin = request.headers.get("origin")
      if (origin && origin !== url.origin) return new Response("Wrong origin", { status: 403 })
      if (request.headers.get("content-type") !== "application/json")
        return new Response("Expected JSON", { status: 415 })
      const size = Number(request.headers.get("content-length"))
      if (!Number.isInteger(size) || size < 1 || size > 16_384)
        return new Response("Submission too large", { status: 413 })
      const data = await request.text()
      if (data.length > 16_384) return new Response("Submission too large", { status: 413 })
      let body: unknown
      try {
        body = JSON.parse(data) as unknown
      } catch {
        return new Response("Invalid JSON", { status: 400 })
      }
      await appendFile(join(dir, "submissions.jsonl"), `${JSON.stringify(body)}\n`, { flag: "a" })
      return new Response("Saved", { status: 201 })
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}/source`, workspace: dir, releaseGateEligible: false }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-browser-entry-task.ts prepare <empty-task-dir> <installed-extension-dir> | serve <task-dir> | score <task-dir>",
    )
  const result =
    cmd === "prepare" && installed
      ? await prepare(root, installed)
      : cmd === "score"
        ? await score(root)
        : cmd === "serve"
          ? await serve(root)
          : undefined
  if (!result) throw new Error("Unknown command or missing installed extension directory")
  if ("server" in result)
    console.log(JSON.stringify({ url: result.url, workspace: result.workspace, releaseGateEligible: false }, null, 2))
  if (!("server" in result)) console.log(JSON.stringify(result, null, 2))
  if (cmd === "score" && "correctFinalState" in result && !result.correctFinalState) process.exitCode = 2
}
