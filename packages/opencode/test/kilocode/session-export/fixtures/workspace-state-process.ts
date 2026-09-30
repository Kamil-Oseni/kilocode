import { join } from "node:path"
import { closeSync, openSync, unlinkSync } from "node:fs"
import { createWorkspaceProvider } from "../../../../src/kilocode/session-export/workspace-provider"

const [root, state, dir, name, session] = process.argv.slice(2)

async function wait(name: string) {
  const deadline = Date.now() + 15_000
  while (!(await Bun.file(join(dir, name)).exists())) {
    if (Date.now() >= deadline) throw new Error(`Missing workspace state gate: ${name}`)
    await Bun.sleep(10)
  }
}

async function run() {
  if (session === "__lock__") {
    const fd = openSync(`${state}.lock`, "wx")
    try {
      await Bun.write(join(dir, `${name}.loaded`), "ready")
      await wait(`${name}.commit`)
      return { ok: true, pid: process.pid }
    } finally {
      closeSync(fd)
      unlinkSync(`${state}.lock`)
    }
  }
  const provider = createWorkspaceProvider({ root, statePath: state })
  await Bun.write(join(dir, `${name}.loaded`), "ready")
  await wait("capture")
  const baseline = await provider.baseline()
  await Bun.write(join(dir, `${name}.captured`), baseline.snapshotId)
  await wait(`${name}.commit`)
  provider.remember(session, baseline.snapshotId)
  return { ok: true, id: provider.current(session), pid: process.pid }
}

try {
  console.log(JSON.stringify(await run()))
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), pid: process.pid }))
}
