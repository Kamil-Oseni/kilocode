import { readFile, stat, writeFile } from "node:fs/promises"
import { SelfHealInstallation, type Plan } from "../../src/self-heal/installation"

const input = JSON.parse(process.argv[2]) as {
  root: string
  plan: string
  ready: string
  go: string
  result: string
  dispatch: string
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  )
}

await writeFile(input.ready, "ready")
while (!(await exists(input.go))) await Bun.sleep(20)

const plan = JSON.parse(await readFile(input.plan, "utf8")) as Plan
const result = await new SelfHealInstallation(input.root)
  .run(plan, async () => {
    await writeFile(input.dispatch, String(process.pid), { flag: "wx" })
    await Bun.sleep(100)
  })
  .then(
    (value) => ({ ok: true, dispatched: value.dispatched, id: value.record.id, phase: value.record.phase }),
    (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  )

await writeFile(input.result, JSON.stringify(result))
await readFile(input.result)
