const assert = require("node:assert/strict")
const { existsSync, readFileSync, watch, writeFileSync } = require("node:fs")
const { join } = require("node:path")
const vscode = require("vscode")

const root = process.env.RAYA_CANVAS_ROOT
const cache = process.env.RAYA_CANVAS_CACHE
const marker = process.env.RAYA_CANVAS_MARKER

function path(name, suffix) {
  return join(cache, `${name}.${suffix}.json`)
}

function source(name) {
  return join(root, ".raya", "canvases", `${name}.canvas.tsx`)
}

async function wait(check, message, timeout = 20_000) {
  const limit = Date.now() + timeout
  while (Date.now() < limit) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

async function close() {
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor")
}

async function open(name) {
  return vscode.commands.executeCommand("raya.openCanvas", { root, name })
}

function canvasTab() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.label.startsWith("Raya Canvas:"))
}

async function matrix() {
  const valid = await open("valid")
  assert.equal(valid?.status, "ready")
  assert.equal(valid?.data.value, 1)
  assert.equal(canvasTab(), true)
  await close()

  const damaged = await open("damaged")
  assert.equal(damaged?.status, "ready")
  assert.match(damaged?.warning ?? "", /restored the last working canvas/i)
  assert.equal(existsSync(`${path("damaged", "current")}.corrupt`), true)
  assert.equal(JSON.parse(readFileSync(path("damaged", "current"), "utf8")).build.name, "damaged")
  await close()

  const divergent = await open("divergent")
  assert.equal(divergent?.status, "ready")
  assert.match(divergent?.warning ?? "", /differs from its editable source\/data files/i)
  assert.equal(JSON.parse(readFileSync(source("divergent").replace(/\.tsx$/, ".json"), "utf8")).value, 99)
  await close()

  const current = readFileSync(path("dual", "current"), "utf8")
  const recovery = readFileSync(path("dual", "recovery"), "utf8")
  assert.equal(await open("dual"), undefined)
  assert.equal(readFileSync(path("dual", "current"), "utf8"), current)
  assert.equal(readFileSync(path("dual", "recovery"), "utf8"), recovery)
}

async function crash() {
  const build = await open("crash")
  assert.equal(build?.status, "ready")
  const journal = path("crash", "transaction")
  const durable = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.close()
      reject(new Error("Canvas save never reached its durable transaction checkpoint"))
    }, 45_000)
    const watcher = watch(cache, (_event, file) => {
      if (file !== "crash.transaction.json" || !existsSync(journal)) return
      clearTimeout(timer)
      watcher.close()
      resolve()
    })
  })
  const large = `export default function Crash() { return <main>Crash recovered</main> }\n/* ${"x".repeat(2_000_000)} */`
  const uri = vscode.Uri.file(source("crash"))
  const document = await vscode.workspace.openTextDocument(uri)
  const edit = new vscode.WorkspaceEdit()
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), large)
  assert.equal(await vscode.workspace.applyEdit(edit), true)
  assert.equal(await document.save(), true)
  await durable
  writeFileSync(marker, "extension host terminated after the transaction became durable")
  process.exit(86)
}

async function recover() {
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  const journal = path("crash", "transaction")
  if (existsSync(journal)) await open("crash")
  await wait(
    () => !existsSync(journal) && readFileSync(source("crash"), "utf8").includes("Crash recovered"),
    "Canvas did not finish the interrupted save after extension-host restart",
    30_000,
  )
  const build = await open("crash")
  assert.equal(build?.status, "ready")
  assert.equal(canvasTab(), true)
}

async function run() {
  assert.ok(root, "RAYA_CANVAS_ROOT is required")
  assert.ok(cache, "RAYA_CANVAS_CACHE is required")
  const extension = vscode.extensions.getExtension("eden.raya")
  assert.ok(extension, "The installed Raya snapshot was not loaded")
  await extension.activate()
  const phase = process.env.RAYA_CANVAS_PHASE
  if (phase === "matrix") return matrix()
  if (phase === "crash") return crash()
  if (phase === "recover") return recover()
  throw new Error(`Unknown Canvas acceptance phase: ${phase}`)
}

module.exports = { run }
