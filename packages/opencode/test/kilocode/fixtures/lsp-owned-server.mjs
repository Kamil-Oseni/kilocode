import fs from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { spawn } from "node:child_process"

const gate = process.argv[2]
const mode = process.argv[3]
if (mode === "tail") {
  await fs.writeFile(gate + ".ready", String(process.pid))
  while (
    !(await fs.stat(gate).then(
      () => true,
      () => false,
    ))
  )
    await sleep(10)
  process.exit(0)
}
let input = Buffer.alloc(0)
const send = (id, result) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
const stop = async () => {
  if (mode === "pipe") {
    spawn(process.execPath, [import.meta.filename, gate, "tail"], {
      stdio: ["ignore", process.stdout, process.stderr],
      windowsHide: true,
    })
    while (
      !(await fs.stat(gate + ".ready").then(
        () => true,
        () => false,
      ))
    )
      await sleep(10)
    process.exit(0)
  }
  if (gate)
    while (
      !(await fs.stat(gate).then(
        () => true,
        () => false,
      ))
    )
      await sleep(10)
  process.exit(0)
}
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk])
  while (true) {
    const index = input.indexOf("\r\n\r\n")
    if (index < 0) return
    const length = Number(/Content-Length:\s*(\d+)/i.exec(input.subarray(0, index).toString())?.[1])
    if (!Number.isSafeInteger(length) || length < 1) throw new Error("Invalid fixture frame")
    if (input.length < index + 4 + length) return
    const row = JSON.parse(input.subarray(index + 4, index + 4 + length).toString())
    input = input.subarray(index + 4 + length)
    if (row.method === "initialize") {
      if (mode === "refuse") {
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: row.id,
          error: { code: -32002, message: "Actual initialize refusal" },
        })
        process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
        continue
      }
      send(row.id, { capabilities: {} })
    }
    if (row.method === "shutdown") send(row.id, null)
    if (row.method === "exit") void stop()
  }
})
process.stdin.on("end", () => void stop())
