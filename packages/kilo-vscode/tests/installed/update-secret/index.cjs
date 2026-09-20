const assert = require("node:assert/strict")
const vscode = require("vscode")

async function run() {
  const phase = process.env.RAYA_UPDATE_SECRET_PHASE
  const token = process.env.RAYA_UPDATE_SECRET_TOKEN
  assert.ok(token, "RAYA_UPDATE_SECRET_TOKEN is required")
  const extension = vscode.extensions.getExtension("eden.raya")
  assert.ok(extension, "The installed Raya snapshot was not loaded")
  await extension.activate()
  const result = await vscode.commands.executeCommand("raya.internal.updateCredentialAcceptance", {
    action: phase,
    token,
  })
  if (phase === "store") return assert.deepEqual(result, { saved: true })
  if (phase === "read-clear") return assert.deepEqual(result, { saved: true, cleared: true })
  throw new Error(`Unknown update credential acceptance phase: ${phase}`)
}

module.exports = { run }
