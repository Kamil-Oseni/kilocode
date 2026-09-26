#!/usr/bin/env bun
// Disposable browser fixture and independent scorer; this does not drive or attest Raya.
import { createHash, randomInt, randomUUID } from "node:crypto"
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const format = "raya.installed-popup-task"
const version = 1
const scenario = "unexpected-popup-recovery" satisfies (typeof scenarios)[number]
const names = ["Project", "Owner", "Decision"] as const

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  extension: { version: string; captureSha256: string; root: string }
  createdAt: string
  seed: number
  pageSha256: string
}

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function expected(seed: number) {
  return { Project: `North-${seed}`, Owner: "Raya", Decision: "Review" }
}

function page(seed: number, runId: string) {
  const field = names[seed % names.length]
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Project intake</title><style>body{font:16px system-ui;max-width:36rem;margin:3rem auto}label{display:block;margin:1rem 0}input{display:block;width:100%;padding:.6rem}dialog{border:1px solid #777;border-radius:12px;padding:1.5rem;max-width:24rem}dialog::backdrop{background:#0009}</style><h1>Project intake</h1><p>Enter project North-${seed}, owner Raya, and decision Review. Submit once.</p><form id="intake">${names.map((name) => `<label>${name}<input name="${name}" required autocomplete="off"></label>`).join("")}<button type="submit">Submit intake</button></form><dialog id="interrupt" aria-labelledby="notice"><h2 id="notice">Quick check</h2><p>A workspace notice interrupted your entry. Dismiss it, then finish the intake.</p><button id="dismiss" type="button">Continue entry</button></dialog><p id="status" role="status"></p><script>
const form=document.querySelector('#intake'), modal=document.querySelector('#interrupt'), status=document.querySelector('#status');
let shown=false, cleared=false;
const post=(kind,body={})=>fetch('/'+kind,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId:${JSON.stringify(runId)},...body})});
form.elements[${JSON.stringify(field)}].addEventListener('focus',async()=>{if(shown)return;shown=true;const response=await post('shown');if(!response.ok){status.textContent='Notice unavailable';return}modal.showModal()});
document.querySelector('#dismiss').addEventListener('click',async()=>{const response=await post('dismiss');if(!response.ok){status.textContent='Could not dismiss notice';return}cleared=true;modal.close()});
form.addEventListener('submit',async(event)=>{event.preventDefault();if(!cleared){status.textContent='Dismiss the notice before submitting';return}const values=Object.fromEntries(new FormData(form));const response=await post('submit',{values});status.textContent=response.ok?'Intake submitted':'Submission failed'});
</script></html>\n`
}

function valid(input: unknown): input is Manifest {
  if (!input || typeof input !== "object") return false
  const item = input as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (!item.extension || typeof item.extension !== "object") return false
  const ext = item.extension as Record<string, unknown>
  if (typeof ext.version !== "string" || typeof ext.root !== "string") return false
  if (!/^[\da-f]{64}$/i.test(String(ext.captureSha256))) return false
  if (typeof item.seed !== "number" || !Number.isInteger(item.seed) || item.seed < 100 || item.seed > 999) return false
  return item.pageSha256 === digest(page(item.seed, item.runId))
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
  const seed = randomInt(100, 1000)
  const runId = randomUUID()
  const input: Manifest = {
    format,
    version,
    scenario,
    runId,
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
    createdAt: new Date().toISOString(),
    seed,
    pageSha256: digest(page(seed, runId)),
  }
  await writeFile(join(dir, "page.html"), page(seed, runId), { flag: "wx" })
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction: `In the local browser intake, enter project North-${seed}, owner Raya, and decision Review. Recover from any interruption and submit once. Do not edit task files directly.`,
    next: `bun computer-use-popup-task.ts serve "${dir}"`,
  }
}

type Event = { kind: string; runId: string; values?: unknown }

async function events(root: string) {
  const data = await readFile(join(root, "events.jsonl"), "utf8")
  if (!data.endsWith("\n")) return { items: [] as Event[], invalid: true }
  const items: Event[] = []
  for (const line of data.slice(0, -1).split("\n")) {
    try {
      const item = JSON.parse(line) as Event
      if (!item || typeof item !== "object") return { items, invalid: true }
      items.push(item)
    } catch {
      return { items, invalid: true }
    }
  }
  return { items, invalid: false }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  const actual = (await readdir(dir)).sort()
  const expectedFiles = ["events.jsonl", "page.html", "task.json"]
  const missing = expectedFiles.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expectedFiles.includes(name))
  const changed: string[] = []
  for (const name of expectedFiles.filter((name) => actual.includes(name))) {
    if (!(await lstat(join(dir, name))).isFile()) changed.push(name)
  }
  if (actual.includes("page.html") && !changed.includes("page.html")) {
    if (digest(await readFile(join(dir, "page.html"))) !== input.pageSha256) changed.push("page.html")
  }
  const saved =
    actual.includes("events.jsonl") && !changed.includes("events.jsonl")
      ? await events(dir)
      : { items: [] as Event[], invalid: false }
  if (saved.invalid) changed.push("events.jsonl")
  const kinds = saved.items.map((item) => item.kind)
  const order = kinds.join(",") === "shown,dismiss,submit"
  const ids = saved.items.every((item) => item.runId === input.runId)
  const values = saved.items[2]?.values
  const goal = expected(input.seed)
  const exact =
    !!values &&
    typeof values === "object" &&
    !Array.isArray(values) &&
    Object.keys(values).sort().join(",") === names.slice().sort().join(",") &&
    names.every((name) => (values as Record<string, unknown>)[name] === goal[name])
  const submissions = kinds.filter((kind) => kind === "submit").length
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length && order && ids && exact,
    popupRecovered: order && ids,
    missing,
    unexpected,
    changed,
    events: kinds,
    submissions,
    replay: submissions > 1,
    releaseGateEligible: false,
    note: "The local scorer checks saved event order, exact form values, and duplicate submissions. It cannot attest who acted, a visible browser popup, actions outside this folder, policy compliance, model metrics, or installed-host recovery.",
  }
}

async function payload(request: Request) {
  if (request.headers.get("content-type") !== "application/json") return new Response("Expected JSON", { status: 415 })
  const size = Number(request.headers.get("content-length"))
  if (!Number.isInteger(size) || size < 1 || size > 4096) return new Response("Request too large", { status: 413 })
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
  if (!(await lstat(join(dir, "page.html"))).isFile()) throw new Error("Invalid page file")
  if (digest(await readFile(join(dir, "page.html"))) !== input.pageSha256) throw new Error("Modified page")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/")
        return new Response(Bun.file(join(dir, "page.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      if (request.method !== "POST" || !["/shown", "/dismiss", "/submit"].includes(url.pathname))
        return new Response("Not found", { status: 404 })
      const origin = request.headers.get("origin")
      if (origin && origin !== url.origin) return new Response("Wrong origin", { status: 403 })
      const data = await payload(request)
      if (data instanceof Response) return data
      if (data.runId !== input.runId) return new Response("Wrong run", { status: 403 })
      const kind = url.pathname.slice(1)
      const keys = Object.keys(data).sort().join(",")
      if (keys !== (kind === "submit" ? "runId,values" : "runId"))
        return new Response("Invalid event fields", { status: 400 })
      const prior = await readFile(join(dir, "events.jsonl"), "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return ""
        throw err
      })
      const kinds = prior
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as Event).kind)
      const next = ["shown", "dismiss", "submit"][kinds.length]
      if (kind !== next) return new Response("Unexpected event", { status: 409 })
      if (kind === "submit" && (!data.values || typeof data.values !== "object" || Array.isArray(data.values)))
        return new Response("Invalid values", { status: 400 })
      await appendFile(join(dir, "events.jsonl"), `${JSON.stringify({ ...data, kind })}\n`, { flag: "a" })
      return new Response("Saved", { status: 201 })
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}/`, workspace: dir, releaseGateEligible: false }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-popup-task.ts prepare <empty-task-dir> <installed-extension-dir> | serve <task-dir> | score <task-dir>",
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
