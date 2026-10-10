const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const WebSocket = require("ws")

assert.equal(process.release.name, "node")
const mode = process.argv[3]
const result = { mode, code: 0, reason: "", bytes: 0, frames: 0, replay: 0, gap: null, digest: "" }
const hash = createHash("sha256")
const sockets = new Set()
const ws = owned(new WebSocket(process.argv[2] + "/socket", { perMessageDeflate: false }))
let ready = false
let expired = false
const deadline = setTimeout(() => {
  expired = true
  process.exitCode = 1
  console.error("Sustained reader deadline expired")
  for (const socket of sockets) socket.terminate()
  process.stdin.destroy()
}, 7000)
ws.on("error", (err) => {
  console.error(err.message)
  process.exitCode = 1
})
ws.on("message", (data) => {
  if (!ready) {
    assert.equal(data.toString(), "READY")
    ready = true
    ws.pause() // Published ws API pauses the actual Node socket reader.
    ws.send("GO")
    return
  }
  const text = data.toString()
  assert.equal(text, String(result.frames).padStart(8, "0") + ":" + "x".repeat(65527))
  result.frames++
  result.bytes += data.length
  assert.ok(result.bytes <= 64 * 1024 * 1024)
  hash.update(data)
})
process.stdin.setEncoding("utf8")
process.stdin.on("data", (text) => {
  if (mode === "resume" && text.trim() === "resume") ws.resume()
  if (mode === "disconnect" && text.trim() === "disconnect") ws.terminate()
  if (mode === "never" && text.trim() === "released") ws.terminate()
})
ws.on("close", (code, reason) => {
  if (expired) return
  result.code = code
  result.reason = reason.toString()
  result.digest = hash.digest("hex")
  if (mode !== "resume") return finish()
  const replay = owned(new WebSocket(process.argv[2] + "/replay", { perMessageDeflate: false }))
  const chunks = []
  replay.on("error", (err) => {
    console.error(err.message)
    process.exitCode = 1
  })
  replay.on("message", (data) => {
    if (data[0] === 0) {
      assert.equal(result.gap, null)
      result.gap = JSON.parse(data.subarray(1).toString())
      return
    }
    assert.equal(result.gap, null)
    chunks.push(data)
    result.replay += data.length
    assert.ok(result.replay <= 2 * 1024 * 1024)
  })
  replay.on("close", (code) => {
    if (expired) return
    assert.equal(code, 1000)
    result.replayDigest = createHash("sha256").update(Buffer.concat(chunks)).digest("hex")
    finish()
  })
})
function owned(socket) {
  sockets.add(socket)
  socket.once("close", () => sockets.delete(socket))
  return socket
}
function finish() {
  clearTimeout(deadline)
  process.stdin.destroy()
  console.log(JSON.stringify(result))
}
