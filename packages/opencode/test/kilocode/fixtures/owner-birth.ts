import { durable } from "../../../src/kilocode/task/owner"

process.stdout.write(`${JSON.stringify(durable())}\nREADY\n`)
await new Promise<void>(() => {})
