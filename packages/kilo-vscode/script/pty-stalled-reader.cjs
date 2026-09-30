// Run with Node: Bun's ws transport does not implement pause/resume.
const assert = require("node:assert/strict")
const WebSocket = require("ws")

assert.equal(process.release.name, "node", "Stalled reader requires the Node socket transport")
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  input += chunk
  assert.ok(input.length < 4096, "Reader configuration exceeds its bound")
})
process.stdin.on("end", () => {
  const cfg = JSON.parse(input)
  const ws = new WebSocket(cfg.url, { headers: { Authorization: cfg.auth }, perMessageDeflate: false })
  const report = {
    runtime: process.version,
    paused: false,
    durationMs: 0,
    before: 0,
    settled: 0,
    after: 0,
    receivedBytes: 0,
    failure: "",
  }
  let timer
  let paused = false
  const deadline = setTimeout(() => {
    ws.terminate()
    console.error("Stalled reader timed out")
    process.exitCode = 1
  }, 45000)
  ws.on("message", (data) => {
    report.receivedBytes += data.byteLength
    assert.ok(report.receivedBytes <= 32 * 1024 * 1024, "Reader output exceeded its bound")
    if (paused || data[0] !== 0) return
    paused = true
    // ws.pause() calls the actual Node net.Socket.pause(); record transport bytes,
    // not just application callbacks, to prove reads really stopped.
    ws.pause()
    assert.equal(ws.isPaused, true)
    report.paused = true
    report.before = ws._socket.bytesRead
    const started = Date.now()
    ws.send("GO\r")
    timer = setTimeout(() => {
      // Node may finish one read already in flight when pause is called. Prove
      // the transport stops after that bounded prefetch, rather than mistaking
      // pause of message callbacks alone for a stopped reader.
      report.settled = ws._socket.bytesRead
      timer = setTimeout(() => {
        report.durationMs = Date.now() - started
        report.after = ws._socket.bytesRead
        if (report.settled - report.before > 64 * 1024) report.failure = "Prefetch exceeded 64 KiB"
        if (report.after !== report.settled) report.failure = "Transport continued reading after settling"
        if (report.failure) process.exitCode = 1
        ws.resume()
      }, 2000)
    }, 500)
  })
  ws.on("error", (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  ws.on("close", (code, reason) => {
    clearTimeout(deadline)
    clearTimeout(timer)
    console.log(JSON.stringify({ ...report, closeCode: code, closeReason: reason.toString() }))
  })
})
