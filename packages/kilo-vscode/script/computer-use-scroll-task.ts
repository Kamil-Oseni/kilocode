#!/usr/bin/env bun
// Disposable long-page browser fixture and independent final-state scorer. This does not drive or attest Raya.
import { createHash, randomInt, randomUUID } from "node:crypto"
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const format = "raya.installed-scroll-task"
const version = 1
const scenario = "long-scrolling" satisfies (typeof scenarios)[number]

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  extension: { version: string; captureSha256: string; root: string }
  createdAt: string
  target: number
  token: string
  pageSha256: string
}

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function page(target: number, token: string) {
  const cards = Array.from({ length: 72 }, (_, index) => {
    const number = index + 1
    return `<section class="card"><h2>Record ${number}</h2><p>Review this record before continuing.</p><button type="button" data-record="${number}">${number === target ? "Select the requested record" : "Select this record"}</button></section>`
  }).join("\n")
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Long record list</title><style>body{font:16px system-ui;margin:0 auto;max-width:720px;padding:24px;background:#f6f6f6;color:#191919}.card{box-sizing:border-box;height:180px;padding:20px;margin:12px 0;background:white;border:1px solid #ccc;border-radius:12px}button{padding:10px}#status{position:sticky;top:0;background:#fff;padding:8px}</style><h1>Long record list</h1><p id="status" role="status">Find record ${target} near the end of the list and select it once.</p>${cards}<script>document.addEventListener("click",async(event)=>{const button=event.target.closest("button[data-record]");if(!button)return;const response=await fetch("/select",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({record:Number(button.dataset.record),token:${JSON.stringify(token)}})});document.querySelector("#status").textContent=response.ok?"Selection recorded":"Selection failed"});</script></html>\n`
}

function valid(input: unknown): input is Manifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const item = input as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (!item.extension || typeof item.extension !== "object") return false
  const ext = item.extension as Record<string, unknown>
  if (typeof ext.version !== "string" || typeof ext.root !== "string") return false
  if (!/^[\da-f]{64}$/i.test(String(ext.captureSha256))) return false
  if (typeof item.target !== "number" || !Number.isInteger(item.target) || item.target < 55 || item.target > 70)
    return false
  if (typeof item.token !== "string" || !/^[\da-f-]{36}$/i.test(item.token)) return false
  return item.pageSha256 === digest(page(item.target, item.token))
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
  const target = randomInt(55, 71)
  const token = randomUUID()
  const html = page(target, token)
  const input: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
    createdAt: new Date().toISOString(),
    target,
    token,
    pageSha256: digest(html),
  }
  await writeFile(join(dir, "records.html"), html, { flag: "wx" })
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction: `In the local browser app, find record ${target} far down the list and select it exactly once. Do not select any other record or change task files.`,
    next: `bun computer-use-scroll-task.ts serve "${dir}"`,
  }
}

async function selections(root: string) {
  const data = await readFile(join(root, "selections.jsonl"), "utf8")
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
  const expected = ["records.html", "selections.jsonl", "task.json"]
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const changed: string[] = []
  if (actual.includes("records.html")) {
    const stat = await lstat(join(dir, "records.html"))
    if (!stat.isFile() || digest(await readFile(join(dir, "records.html"))) !== input.pageSha256)
      changed.push("records.html")
  }
  if (actual.includes("selections.jsonl") && !(await lstat(join(dir, "selections.jsonl"))).isFile())
    changed.push("selections.jsonl")
  const saved =
    actual.includes("selections.jsonl") && !changed.includes("selections.jsonl")
      ? await selections(dir)
      : { items: [] as unknown[], invalid: false }
  const correct = saved.items.length === 1 && matches(saved.items[0], input)
  if (saved.invalid || (saved.items.length && !correct)) changed.push("selections.jsonl")
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario: input.scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length && correct,
    missing,
    unexpected,
    changed,
    selections: saved.items.length,
    replay: saved.items.length > 1,
    releaseGateEligible: false,
    note: "The scorer checks the local browser app's saved selection and count. It cannot attest who acted, actual scrolling, actions outside this folder, policy compliance, model metrics, host reload, or the other benchmark scenarios.",
  }
}

function matches(value: unknown, input: Manifest) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Object.keys(item).length === 2 && item.record === input.target && item.token === input.token
}

export async function serve(root: string, port = 0) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  if (!(await lstat(join(dir, "records.html"))).isFile()) throw new Error("Invalid records page")
  if (digest(await readFile(join(dir, "records.html"))) !== input.pageSha256) throw new Error("Modified records page")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/")
        return new Response(Bun.file(join(dir, "records.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      if (request.method !== "POST" || url.pathname !== "/select") return new Response("Not found", { status: 404 })
      const origin = request.headers.get("origin")
      if (origin && origin !== url.origin) return new Response("Wrong origin", { status: 403 })
      if (request.headers.get("content-type") !== "application/json")
        return new Response("Expected JSON", { status: 415 })
      const size = Number(request.headers.get("content-length"))
      if (!Number.isInteger(size) || size < 1 || size > 1024)
        return new Response("Selection too large", { status: 413 })
      const data = await request.text()
      if (data.length > 1024) return new Response("Selection too large", { status: 413 })
      let body: unknown
      try {
        body = JSON.parse(data) as unknown
      } catch {
        return new Response("Invalid JSON", { status: 400 })
      }
      await appendFile(join(dir, "selections.jsonl"), `${JSON.stringify(body)}\n`, { flag: "a" })
      return new Response("Saved", { status: 201 })
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}/`, workspace: dir, releaseGateEligible: false }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-scroll-task.ts prepare <empty-task-dir> <installed-extension-dir> | serve <task-dir> | score <task-dir>",
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
