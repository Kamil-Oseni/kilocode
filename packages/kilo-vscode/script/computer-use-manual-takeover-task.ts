#!/usr/bin/env bun
// Disposable handoff fixture. Browser events alone cannot attest Raya's global pause.
import { createHash, randomInt, randomUUID } from "node:crypto"
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const format = "raya.installed-manual-takeover-task"
const version = 1
const scenario = "manual-takeover" satisfies (typeof scenarios)[number]
const order = ["start", "takeover", "human", "handback", "finish"] as const

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  createdAt: string
  seed: number
  pageSha256: string
  extension: { version: string; captureSha256: string; root: string }
}

type Event = { kind: string; runId: string; value?: string; at: string }

function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex")
}

function value(seed: number, kind: string) {
  return kind === "start" ? `North-${seed}` : kind === "human" ? `Human-${seed}` : `South-${seed}`
}

function page(input: Pick<Manifest, "runId" | "seed">) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Raya manual takeover ${input.seed}</title><style>body{font:16px system-ui;background:#161616;color:#eee;max-width:38rem;margin:4rem auto}section{padding:1.5rem;border:1px solid #444;border-radius:16px}button,input{font:inherit;padding:.7rem;margin:.5rem 0}input{display:block;width:95%}button{border-radius:9px;cursor:pointer}p{line-height:1.5}#state{color:#9ed}</style><section><h1>Manual takeover</h1><p>Raya enters North-${input.seed} and starts. Use Raya's global Pause shortcut. Then you take over, enter Human-${input.seed}, and hand back. Resume Raya explicitly; Raya enters South-${input.seed} and finishes. Leave this page open.</p><label>Entry<input id="entry" autocomplete="off"></label><button id="start">Raya start</button><button id="takeover">Take over</button><button id="human">Save my entry</button><button id="handback">Hand back</button><button id="finish">Raya finish</button><p id="state" role="status">Ready</p></section><script>
const input=document.querySelector('#entry'),status=document.querySelector('#state');
for(const kind of ${JSON.stringify(order)})document.querySelector('#'+kind).addEventListener('click',async()=>{const response=await fetch('/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId:${JSON.stringify(input.runId)},kind,...(['start','human','finish'].includes(kind)?{value:input.value}:{})})});status.textContent=response.ok?kind+' recorded':await response.text();if(response.ok)input.value=''});
</script></html>\n`
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
  if (typeof item.seed !== "number" || !Number.isInteger(item.seed) || item.seed < 1000 || item.seed > 9999)
    return false
  if (item.pageSha256 !== digest(page(item as Manifest))) return false
  return extension(item.extension)
}

async function manifest(dir: string) {
  if (!(await lstat(join(dir, "task.json"))).isFile()) throw new Error("Invalid task manifest file")
  const input = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as unknown
  if (!valid(input)) throw new Error("Invalid or modified task manifest")
  return input
}

async function events(dir: string) {
  const data = await readFile(join(dir, "events.jsonl"), "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return ""
    throw err
  })
  if (data && !data.endsWith("\n")) return { items: [] as Event[], invalid: true }
  const items: Event[] = []
  for (const line of data.trimEnd().split("\n").filter(Boolean)) {
    try {
      const item = JSON.parse(line) as Event
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.kind !== "string" ||
        typeof item.runId !== "string" ||
        typeof item.at !== "string" ||
        !Number.isFinite(Date.parse(item.at))
      )
        return { items, invalid: true }
      items.push(item)
    } catch {
      return { items, invalid: true }
    }
  }
  return { items, invalid: false }
}

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The installed takeover task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  const input: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    seed: randomInt(1000, 10000),
    pageSha256: "",
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
  }
  input.pageSha256 = digest(page(input))
  await writeFile(join(dir, "page.html"), page(input), { flag: "wx" })
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction: `In the local browser fixture, enter North-${input.seed} and select Raya start. Pause Raya with its global shortcut and let the user take over, enter Human-${input.seed}, and hand back. After explicit Resume, enter South-${input.seed} and select Raya finish. Do not edit task files directly.`,
    releaseGateEligible: false,
  }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  const actual = (await readdir(dir)).sort()
  const expected = ["events.jsonl", "page.html", "task.json"]
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const changed: string[] = []
  for (const name of expected.filter((name) => actual.includes(name)))
    if (!(await lstat(join(dir, name))).isFile()) changed.push(name)
  if (actual.includes("page.html") && !changed.includes("page.html"))
    if (digest(await readFile(join(dir, "page.html"))) !== input.pageSha256) changed.push("page.html")
  const saved = await events(dir)
  if (saved.invalid) changed.push("events.jsonl")
  const sequence = saved.items.map((item) => item.kind).join(",") === order.join(",")
  const ids = saved.items.every((item) => item.runId === input.runId)
  const values = saved.items.every((item) =>
    ["start", "human", "finish"].includes(item.kind)
      ? item.value === value(input.seed, item.kind)
      : item.value === undefined,
  )
  const times = saved.items.every((item, index) => index === 0 || item.at >= saved.items[index - 1].at)
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length && sequence && ids && values && times,
    missing,
    unexpected,
    changed,
    events: saved.items.map((item) => item.kind),
    releaseGateEligible: false,
    note: "The browser fixture proves only a sequenced handoff and exact entries. It cannot prove the user physically took over, Raya paused input immediately, held inputs were released, no actions occurred during takeover, or Resume was explicit. Bind installed-host pause/resume and input receipts before release use.",
  }
}

async function payload(request: Request, url: URL) {
  if (request.headers.get("content-type") !== "application/json") return new Response("Expected JSON", { status: 415 })
  const origin = request.headers.get("origin")
  if (origin && origin !== url.origin) return new Response("Wrong origin", { status: 403 })
  const size = Number(request.headers.get("content-length"))
  if (!Number.isInteger(size) || size < 1 || size > 2048) return new Response("Request too large", { status: 413 })
  const data = await request.json().catch(() => undefined)
  if (!data || typeof data !== "object" || Array.isArray(data)) return new Response("Invalid event", { status: 400 })
  return data as Record<string, unknown>
}

async function dispatch(dir: string, input: Manifest, request: Request) {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/")
    return new Response(Bun.file(join(dir, "page.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  if (request.method !== "POST" || url.pathname !== "/event") return new Response("Not found", { status: 404 })
  const item = await payload(request, url)
  if (item instanceof Response) return item
  if (item.runId !== input.runId) return new Response("Wrong run", { status: 403 })
  const saved = await events(dir)
  if (saved.invalid) return new Response("Invalid event log", { status: 409 })
  const kind = order[saved.items.length]
  if (!kind || item.kind !== kind) return new Response("Unexpected event", { status: 409 })
  const text = ["start", "human", "finish"].includes(kind)
  if (Object.keys(item).sort().join(",") !== (text ? "kind,runId,value" : "kind,runId"))
    return new Response("Invalid event fields", { status: 400 })
  if (text && item.value !== value(input.seed, kind)) return new Response("Wrong value", { status: 400 })
  await appendFile(join(dir, "events.jsonl"), `${JSON.stringify({ ...item, at: new Date().toISOString() })}\n`)
  return new Response("Saved", { status: 201 })
}

export async function serve(root: string, port = 0) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  if (!(await lstat(join(dir, "page.html"))).isFile()) throw new Error("Invalid page file")
  if (digest(await readFile(join(dir, "page.html"))) !== input.pageSha256) throw new Error("Modified page")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => dispatch(dir, input, request),
  })
  return { server, url: `http://127.0.0.1:${server.port}/`, workspace: dir, releaseGateEligible: false }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-manual-takeover-task.ts prepare <empty-task-dir> <installed-extension-dir> | serve <task-dir> | score <task-dir>",
    )
  const result =
    cmd === "prepare" && installed
      ? await prepare(root, installed)
      : cmd === "serve"
        ? await serve(root)
        : cmd === "score"
          ? await score(root)
          : undefined
  if (!result) throw new Error("Unknown command or missing installed extension directory")
  if ("server" in result) console.log(JSON.stringify({ url: result.url, workspace: result.workspace }))
  if (!("server" in result)) console.log(JSON.stringify(result, null, 2))
  if (cmd === "score" && "correctFinalState" in result && !result.correctFinalState) process.exitCode = 2
}
