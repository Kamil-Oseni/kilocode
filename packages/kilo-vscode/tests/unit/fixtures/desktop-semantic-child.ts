import { writeFileSync } from "node:fs"

// Real transport fault fixture. This does not stand in for a Windows UIA benchmark.
const mode = process.argv[2]
const witness = process.argv[3]
writeFileSync(witness, String(process.pid))
console.log('{"version":1,"type":"ready"}')
let buffer = Buffer.alloc(0)
let count = 0
for await (const chunk of Bun.stdin.stream()) {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 144) {
    const data = buffer.subarray(0, 144)
    buffer = buffer.subarray(144)
    count += 1
    const request = data.toString("ascii", 112, 144)
    const generation = Number(data.readBigUInt64LE(12))
    if (mode === "refused") {
      console.log(JSON.stringify({ version: 1, request, generation, type: "error", code: "target_changed" }))
      continue
    }
    const qpc = process.hrtime.bigint().toString()
    const frequency = "1000000000"
    console.log(JSON.stringify({ version: 1, type: "clock", request, generation, qpc, frequency }))
    if (mode === "hang" && count === 2) await Bun.sleep(10_000)
    if (mode === "overflow") {
      process.stdout.write("x".repeat(1_048_577))
      continue
    }
    if (mode === "malformed") {
      console.log('{"private":"must not appear in an error",broken}')
      continue
    }
    const viewport = {
      x: data.readInt32LE(32),
      y: data.readInt32LE(36),
      width: data.readInt32LE(40) - data.readInt32LE(32),
      height: data.readInt32LE(44) - data.readInt32LE(36),
    }
    const value = {
      version: 1,
      request: mode === "wrong" ? "f".repeat(32) : request,
      generation,
      windowID: `0x${data.readBigUInt64LE(20).toString(16).toUpperCase()}`,
      identity: data.toString("ascii", 48, 112),
      viewport,
      clock: {
        version: 1,
        acquisition: process.hrtime.bigint().toString(),
        prepared: process.hrtime.bigint().toString(),
        frequency,
      },
      semantics: { source: "windows_ui_automation", status: "available", viewport, controls: [], truncated: false },
    }
    console.log(JSON.stringify(value))
  }
}
