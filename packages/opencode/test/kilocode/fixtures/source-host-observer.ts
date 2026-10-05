import { watch } from "../../../src/kilocode/daemon/exit"
import { writeFile } from "node:fs/promises"
const observer = await watch(Number(process.argv[2]), process.argv[3], 60_000)
await writeFile(process.argv[4], "ready")
try {
  console.log(JSON.stringify(await observer.done))
} finally {
  await observer.close()
}
