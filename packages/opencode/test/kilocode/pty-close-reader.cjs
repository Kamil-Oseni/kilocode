const assert = require("node:assert/strict")
const WebSocket = require("ws")

assert.equal(process.release.name, "node")
const ws = new WebSocket(process.argv[2], { perMessageDeflate: false })
const stalled = process.argv[3] === "stalled"
const result = { code: 0, reason: "", bytes: 0, settled: 0, after: 0, runtime: process.release.name }
let timer
let paused = false
const deadline = setTimeout(() => {
  ws.terminate()
  process.exitCode = 1
}, 7000)
ws.on("message", (data) => {
  if (!paused && data.toString() === "READY") {
    paused = true
    ws.pause()
    ws.send("GO")
    timer = setTimeout(() => {
      result.settled = ws._socket.bytesRead
      timer = setTimeout(() => {
        result.after = ws._socket.bytesRead
        if (!stalled) ws.resume()
      }, 150)
    }, 100)
    return
  }
  result.bytes += data.length
  assert.ok(result.bytes <= 2 * 1024 * 1024)
})
ws.on("error", (error) => {
  console.error(error.message)
  process.exitCode = 1
})
ws.on("close", (code, reason) => {
  clearTimeout(timer)
  clearTimeout(deadline)
  result.code = code
  result.reason = reason.toString()
  console.log(JSON.stringify(result))
})
