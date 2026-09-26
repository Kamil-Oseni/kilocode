#!/usr/bin/env bun
// Disposable interrupted-work fixture. A fixture-server restart is not proof that Raya restarted.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const format = "raya.installed-restart-task"
const version = 1
const scenario = "backend-disconnect-restart" satisfies (typeof scenarios)[number]
const names = ["draft", "interrupt", "resume", "finish"] as const

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  code: string
  createdAt: string
  pageSha256: string
  extension: { version: string; captureSha256: string; root: string }
}
type Event = { kind: (typeof names)[number]; runId: string; epoch?: string; value?: string }

function digest(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex")
}

function page(input: Pick<Manifest, "runId" | "code">) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Interrupted intake</title><style>body{font:16px system-ui;max-width:36rem;margin:3rem auto;background:#171717;color:#eee}button,input{font:inherit;padding:.65rem;border-radius:8px;margin:.4rem 0}input{display:block;width:100%;box-sizing:border-box}button{cursor:pointer}#status{min-height:2rem}</style><h1>Interrupted intake</h1><p>Save a draft labelled ${input.code}. After the interruption, resume and submit the final value ${input.code}-complete exactly once.</p><button id="draft">Save draft</button><label>Final value<input id="value" autocomplete="off"></label><button id="finish">Submit final value</button><p id="status" role="status"></p><script>
const runId=${JSON.stringify(input.runId)},status=document.querySelector('#status');
async function send(kind,value){try{const response=await fetch('/'+kind,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId,...(value===undefined?{}:{value})})});status.textContent=response.ok?kind+' saved':(await response.text());}catch{status.textContent='Connection lost. Wait for the workspace to return, then try again.'}}
document.querySelector('#draft').onclick=()=>send('draft',${JSON.stringify(input.code)});
document.querySelector('#finish').onclick=()=>send('finish',document.querySelector('#value').value);
</script></html>\n`
}

function valid(value: unknown): value is Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (typeof item.code !== "string" || !/^[A-F\d]{8}$/.test(item.code)) return false
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) return false
  if (typeof item.pageSha256 !== "string" || item.pageSha256 !== digest(page(item as Manifest))) return false
  if (!item.extension || typeof item.extension !== "object") return false
  const ext = item.extension as Record<string, unknown>
  return (
    typeof ext.version === "string" &&
    typeof ext.root === "string" &&
    typeof ext.captureSha256 === "string" &&
    /^[\da-f]{64}$/i.test(ext.captureSha256)
  )
}

async function manifest(dir: string) {
  if (!(await lstat(join(dir, "task.json"))).isFile()) throw new Error("Invalid restart task manifest")
  const item = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as unknown
  if (!valid(item)) throw new Error("Invalid or modified restart task manifest")
  return item
}

async function journal(dir: string) {
  const data = await readFile(join(dir, "events.jsonl"), "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return ""
    throw err
  })
  if (data && !data.endsWith("\n")) return { items: [] as Event[], invalid: true }
  const items: Event[] = []
  for (const line of data.trimEnd().split("\n").filter(Boolean)) {
    try {
      const item = JSON.parse(line) as Event
      if (!item || typeof item !== "object" || Array.isArray(item)) return { items, invalid: true }
      items.push(item)
    } catch {
      return { items, invalid: true }
    }
  }
  return { items, invalid: false }
}

async function record(dir: string, item: Event) {
  const saved = await journal(dir)
  if (saved.invalid) throw new Error("Invalid event journal")
  if (item.kind !== names[saved.items.length]) return false
  await appendFile(join(dir, "events.jsonl"), `${JSON.stringify(item)}\n`, { flag: "a" })
  return true
}

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The installed desktop task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const input: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    code: randomBytes(4).toString("hex").toUpperCase(),
    createdAt: new Date().toISOString(),
    pageSha256: "",
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
  }
  input.pageSha256 = digest(page(input))
  await writeFile(join(dir, "page.html"), page(input), { flag: "wx" })
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction: `In the local intake, save draft ${input.code}. After the external backend interruption and restart, reconnect and submit ${input.code}-complete once. Do not edit task files directly.`,
    releaseGateEligible: false,
  }
}

// The operator invokes this between stopping the first fixture server and starting the second.
// It records an interruption marker, but does not attest a Raya backend process transition.
export async function interrupt(root: string) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  if (!(await record(dir, { kind: "interrupt", runId: input.runId }))) throw new Error("Draft must be saved first")
  return { runId: input.runId, interruptionRecorded: true, releaseGateEligible: false }
}

function assess(input: Manifest, items: Event[]) {
  const order = items.map((item) => item.kind).join(",") === names.join(",")
  const ids = items.every((item) => item.runId === input.runId)
  const epochs =
    typeof items[0]?.epoch === "string" &&
    typeof items[2]?.epoch === "string" &&
    items[0].epoch !== items[2].epoch &&
    items[3]?.epoch === items[2].epoch
  const values = items[0]?.value === input.code && items[3]?.value === `${input.code}-complete`
  const fields = items.every((item) => {
    const keys = Object.keys(item).sort().join(",")
    return (
      keys ===
      (item.kind === "interrupt"
        ? "kind,runId"
        : item.kind === "resume"
          ? "epoch,kind,runId"
          : "epoch,kind,runId,value")
    )
  })
  return { correct: order && ids && epochs && values && fields, recovered: order && ids && epochs }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  const actual = (await readdir(dir)).sort()
  const expected = ["events.jsonl", "page.html", "task.json"]
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const changed: string[] = []
  for (const name of expected.filter((name) => actual.includes(name))) {
    if (!(await lstat(join(dir, name))).isFile()) changed.push(name)
  }
  if (actual.includes("page.html") && !changed.includes("page.html")) {
    if (digest(await readFile(join(dir, "page.html"))) !== input.pageSha256) changed.push("page.html")
  }
  const saved = await journal(dir)
  if (saved.invalid) changed.push("events.jsonl")
  const items = saved.items
  const verdict = assess(input, items)
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length && verdict.correct,
    interruptionRecovered: verdict.recovered,
    duplicateEffects: items.filter((item) => item.kind === "draft" || item.kind === "finish").length > 2,
    missing,
    unexpected,
    changed,
    events: items.map((item) => item.kind),
    releaseGateEligible: false,
    note: "The scorer checks durable draft and final values around an external marker and distinct fixture server instances. It cannot attest Raya backend disconnect/restart, actor identity, native actions, policy, or actions outside this folder; bind host-origin evidence before release use.",
  }
}

async function payload(request: Request) {
  if (request.headers.get("content-type") !== "application/json") return new Response("Expected JSON", { status: 415 })
  const size = Number(request.headers.get("content-length"))
  if (!Number.isInteger(size) || size < 1 || size > 512) return new Response("Request too large", { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(await request.text()) as unknown
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("Invalid event", { status: 400 })
  return body as Record<string, unknown>
}

export async function serve(root: string, port = 0) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  if (!(await lstat(join(dir, "page.html"))).isFile()) throw new Error("Invalid page")
  if (digest(await readFile(join(dir, "page.html"))) !== input.pageSha256) throw new Error("Modified page")
  const epoch = randomUUID()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/")
        return new Response(Bun.file(join(dir, "page.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      if (request.method !== "POST" || !["/draft", "/resume", "/finish"].includes(url.pathname))
        return new Response("Not found", { status: 404 })
      const origin = request.headers.get("origin")
      if (origin && origin !== url.origin) return new Response("Wrong origin", { status: 403 })
      const data = await payload(request)
      if (data instanceof Response) return data
      if (data.runId !== input.runId) return new Response("Wrong run", { status: 403 })
      const kind = url.pathname.slice(1) as Event["kind"]
      const keys = Object.keys(data).sort().join(",")
      if (keys !== (kind === "resume" ? "runId" : "runId,value"))
        return new Response("Invalid event fields", { status: 400 })
      if (kind !== "resume" && typeof data.value !== "string") return new Response("Invalid value", { status: 400 })
      const item: Event = {
        kind,
        runId: input.runId,
        epoch,
        ...(kind === "resume" ? {} : { value: data.value as string }),
      }
      if (!(await record(dir, item))) return new Response("Unexpected event", { status: 409 })
      return new Response("Saved", { status: 201 })
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}/`, runId: input.runId, releaseGateEligible: false }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!root)
    throw new Error(
      "Usage: bun computer-use-restart-task.ts <prepare|serve|interrupt|score> <task-dir> [installed-extension-dir]",
    )
  const result =
    cmd === "prepare" && installed
      ? await prepare(root, installed)
      : cmd === "serve"
        ? await serve(root)
        : cmd === "interrupt"
          ? await interrupt(root)
          : cmd === "score"
            ? await score(root)
            : undefined
  if (!result) throw new Error("Unknown command or missing installed extension directory")
  console.log(
    JSON.stringify(
      "server" in result ? { url: result.url, runId: result.runId, releaseGateEligible: false } : result,
      null,
      2,
    ),
  )
  if (cmd === "score" && "correctFinalState" in result && !result.correctFinalState) process.exitCode = 2
}
