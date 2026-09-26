#!/usr/bin/env bun
// Disposable portable-app update fixture. This is not a Windows installer or Raya attestation.
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspect } from "./computer-use-installed-probe"
import { scenarios } from "./computer-use-release-gate"

const format = "raya.installed-portable-update-task"
const version = 1
const scenario = "application-install-update" satisfies (typeof scenarios)[number]
const old = "Raya benchmark portable app\nVersion: 1\n"
const next = "Raya benchmark portable app\nVersion: 2\nUpdate complete\n"
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Portable app updater</title><h1>Portable app updater</h1><p>The disposable portable app is at version 1. Update it to version 2.</p><button id="update">Install local update</button><p id="status" role="status"></p><script>document.querySelector("#update").onclick=async()=>{const response=await fetch("/update",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});document.querySelector("#status").textContent=await response.text()}</script></html>`

type Manifest = {
  format: typeof format
  version: typeof version
  scenario: typeof scenario
  runId: string
  extension: { version: string; captureSha256: string; root: string }
  createdAt: string
  oldSha256: string
  nextSha256: string
  pageSha256: string
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function valid(value: unknown): value is Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.format !== format || item.version !== version || item.scenario !== scenario) return false
  if (typeof item.runId !== "string" || !/^[\da-f-]{36}$/i.test(item.runId)) return false
  if (item.oldSha256 !== digest(old) || item.nextSha256 !== digest(next) || item.pageSha256 !== digest(page))
    return false
  if (!item.extension || typeof item.extension !== "object" || Array.isArray(item.extension)) return false
  const ext = item.extension as Record<string, unknown>
  return (
    typeof ext.version === "string" &&
    typeof ext.root === "string" &&
    typeof ext.captureSha256 === "string" &&
    /^[\da-f]{64}$/i.test(ext.captureSha256)
  )
}

async function manifest(root: string) {
  const value = JSON.parse(await readFile(join(root, "task.json"), "utf8")) as unknown
  if (!valid(value)) throw new Error("Invalid or modified update task manifest")
  return value
}

export async function prepare(root: string, installed: string) {
  if (process.platform !== "win32") throw new Error("The installed update task requires Windows")
  const ext = await inspect(installed)
  const dir = resolve(root)
  await mkdir(dir, { recursive: true })
  if ((await readdir(dir)).length) throw new Error("Use an empty disposable task directory")
  await mkdir(join(dir, "App"))
  await mkdir(join(dir, "Updates"))
  await writeFile(join(dir, "App", "portable-app.txt"), old, { flag: "wx" })
  await writeFile(join(dir, "Updates", "portable-app-v2.txt"), next, { flag: "wx" })
  await writeFile(join(dir, "updater.html"), page, { flag: "wx" })
  const input: Manifest = {
    format,
    version,
    scenario,
    runId: randomUUID(),
    extension: { version: ext.version, captureSha256: ext.sha256, root: ext.root },
    createdAt: new Date().toISOString(),
    oldSha256: digest(old),
    nextSha256: digest(next),
    pageSha256: digest(page),
  }
  await writeFile(join(dir, "task.json"), JSON.stringify(input, null, 2), { flag: "wx" })
  return {
    manifest: input,
    workspace: dir,
    instruction:
      "In the local portable-app updater, install the version 2 update exactly once. Keep the downloaded update package. Do not modify other task files. Follow Raya's separate software-installation policy if this action is classified as sensitive.",
    next: `bun computer-use-update-task.ts serve "${dir}"`,
  }
}

async function inventory(root: string, path = ""): Promise<string[]> {
  const found: string[] = []
  for (const item of await readdir(join(root, path), { withFileTypes: true })) {
    const name = [path, item.name].filter(Boolean).join("/")
    if (item.isDirectory()) {
      found.push(`${name}/`)
      found.push(...(await inventory(root, name)))
      continue
    }
    found.push(item.isFile() ? name : `${name}:nonfile`)
  }
  return found
}

function receipt(value: string, input: Manifest) {
  if (!value.endsWith("\n")) return false
  const lines = value.slice(0, -1).split("\n")
  if (lines.length !== 1) return false
  try {
    const item = JSON.parse(lines[0]) as Record<string, unknown>
    return (
      Object.keys(item).sort().join(",") === "action,from,runId,to" &&
      item.runId === input.runId &&
      item.action === "local-portable-update" &&
      item.from === 1 &&
      item.to === 2
    )
  } catch {
    return false
  }
}

export async function score(root: string) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  const actual = (await inventory(dir)).sort()
  const expected = [
    "App/",
    "App/portable-app.txt",
    "Updates/",
    "Updates/portable-app-v2.txt",
    "task.json",
    "updater.html",
    "update.jsonl",
  ]
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  const changed: string[] = []
  for (const [name, hash] of [
    ["App/portable-app.txt", input.nextSha256],
    ["Updates/portable-app-v2.txt", input.nextSha256],
    ["updater.html", input.pageSha256],
  ] as const) {
    if (actual.includes(name) && digest(await readFile(join(dir, name), "utf8")) !== hash) changed.push(name)
  }
  const data = actual.includes("update.jsonl") ? await readFile(join(dir, "update.jsonl"), "utf8") : ""
  const observed = !!data && receipt(data, input)
  if (data && !observed) changed.push("update.jsonl")
  return {
    format: "raya.installed-desktop-task-result" as const,
    version,
    scenario: input.scenario,
    runId: input.runId,
    extension: input.extension,
    workspace: dir,
    correctFinalState: !missing.length && !unexpected.length && !changed.length && observed,
    missing,
    unexpected,
    changed,
    updateObserved: observed,
    replay: data.slice(0, -1).split("\n").filter(Boolean).length > 1,
    releaseGateEligible: false,
    note: "The scorer checks a disposable local portable-app update and one persisted update event. It does not attest a Windows installer, software trust/signature, Raya authorization, actor identity, loaded installed host, or the full benchmark.",
  }
}

export async function serve(root: string, port = 0) {
  const dir = await realpath(root)
  const input = await manifest(dir)
  if (digest(await readFile(join(dir, "App", "portable-app.txt"), "utf8")) !== input.oldSha256)
    throw new Error("Modified installed portable app")
  if (digest(await readFile(join(dir, "Updates", "portable-app-v2.txt"), "utf8")) !== input.nextSha256)
    throw new Error("Modified update package")
  if (digest(await readFile(join(dir, "updater.html"), "utf8")) !== input.pageSha256)
    throw new Error("Modified updater page")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/")
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } })
      if (request.method !== "POST" || url.pathname !== "/update") return new Response("Not found", { status: 404 })
      const origin = request.headers.get("origin")
      if (origin && origin !== url.origin) return new Response("Wrong origin", { status: 403 })
      if (request.headers.get("content-type") !== "application/json")
        return new Response("Expected JSON", { status: 415 })
      const size = Number(request.headers.get("content-length"))
      if (!Number.isInteger(size) || size < 2 || size > 128) return new Response("Invalid size", { status: 413 })
      const files = await readdir(dir)
      if (files.includes("update.jsonl")) return new Response("Already updated", { status: 409 })
      const body = await request.text()
      if (body !== "{}") return new Response("Invalid request", { status: 400 })
      const app = join(dir, "App", "portable-app.txt")
      if (digest(await readFile(app, "utf8")) !== input.oldSha256) return new Response("App changed", { status: 409 })
      if (digest(await readFile(join(dir, "Updates", "portable-app-v2.txt"), "utf8")) !== input.nextSha256)
        return new Response("Update changed", { status: 409 })
      await writeFile(
        join(dir, "update.jsonl"),
        JSON.stringify({ runId: input.runId, action: "local-portable-update", from: 1, to: 2 }) + "\n",
        { flag: "wx" },
      )
      await writeFile(app, next)
      return new Response("Local portable app updated to version 2", { status: 201 })
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}/`, workspace: dir, releaseGateEligible: false }
}

if (import.meta.main) {
  const [cmd, root, installed] = Bun.argv.slice(2)
  if (!cmd || !root)
    throw new Error(
      "Usage: bun computer-use-update-task.ts prepare <empty-dir> <installed-extension-dir> | serve <dir> | score <dir>",
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
  if ("server" in result)
    console.log(JSON.stringify({ url: result.url, workspace: result.workspace, releaseGateEligible: false }, null, 2))
  if (!("server" in result)) console.log(JSON.stringify(result, null, 2))
  if (cmd === "score" && "correctFinalState" in result && !result.correctFinalState) process.exitCode = 2
}
