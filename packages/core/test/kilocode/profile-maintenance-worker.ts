import { writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
import { admitProfileWriter, profileScope } from "../../src/kilocode/profile-maintenance"
import { Flock } from "../../src/util/flock"

const input = JSON.parse(process.argv[2]!) as {
  data: string
  ready: string
  release: string
  done: string
  key?: string
  dir?: string
  writer?: "profile.sqlite.primary.effect" | "profile.storage.json"
}
const work = async () => {
  const db =
    input.writer === "profile.sqlite.primary.effect" ? new Database(path.join(input.data, "kilo.db")) : undefined
  db?.run("CREATE TABLE IF NOT EXISTS fixture (value TEXT)")
  await writeFile(input.ready, String(process.pid))
  if (input.key) {
    // Deliberately block the heartbeat while this process remains alive.
    const until = performance.now() + 5_000
    while (!existsSync(input.release) && performance.now() < until) {
      /* Hold a real live owner without advancing its heartbeat. */
    }
  } else {
    while (!(await Bun.file(input.release).exists())) await Bun.sleep(10)
  }
  db?.run("INSERT INTO fixture VALUES ('settled')")
  db?.close()
  await writeFile(input.done, "settled")
}
if (input.key) await Flock.withLock(input.key, work, { dir: input.dir!, staleMs: 30, recover: false })
else {
  const scope = await profileScope({ data: input.data, channel: "latest", disabled: false })
  await admitProfileWriter(scope, input.writer ?? "profile.storage.json", work)
}
