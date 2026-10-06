import { mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawn } from "../../util/process"
import { check } from "./frames"
import { directory, image, observe } from "./identity"
import { protect } from "./protection"
import { Transport, held, drain as close } from "./transport"
import { parseCatalog, type Catalog } from "./catalog"

export { parseCatalog, type Catalog } from "./catalog"

export async function packaged(extension: string) {
  const root = await directory(path.join(extension, "bin"))
  const helper = path.join(root, "raya-process-host.exe")
  const names = [helper, path.join(root, "raya-process-host.pdb"), path.join(root, "raya-process-host.json")]
  const files = await Promise.all(names.map((name) => image(name, 16777216)))
  const metadata: unknown = JSON.parse(files[2].raw.toString("utf8"))
  check(metadata && typeof metadata === "object" && !Array.isArray(metadata), "Packaged helper metadata required")
  const row = metadata as Record<string, unknown>
  check(
    Object.keys(row).sort().join("|") === "exe|pdb|recipe|version" &&
      row.version === 1 &&
      (row.recipe === "fb46d5ad1ef444acaaa7307fe48b04b62352a7b205384129dede17a50f04bc3f" ||
        row.recipe === "42bca4a2e77642037c051d85b750548e09a3b0cca43d97499961bfca1091f8d9" ||
        row.recipe === "7ee9b6893912140187a3feaaee83fa1058c0b4f1d82f48d0690fce751af6ac5b" ||
        row.recipe === "a2d7ec6c76b6211fadcb13607293fd16ed30dd0f97eaef761526e58b1c783925") &&
      row.exe === files[0].digest &&
      row.pdb === files[1].digest,
    "Packaged helper fingerprint refused",
  )
  return { helper, digest: files[0].digest, names, files }
}

async function retained(names: string[], before: Awaited<ReturnType<typeof image>>[], limit: number) {
  for (const [index, name] of names.entries()) {
    const after = await image(name, limit)
    check(after.digest === before[index].digest && after.tuple === before[index].tuple, "Control image rebound")
  }
}

/** Host-only factory. Catalog selection and native human approval belong to the host coordinator. */
let opening = false
let accepted: Promise<Transport> | undefined
let retired = false
let ending: Promise<void> | undefined
export const Control = {
  held,
  drain() {
    retired = true
    if (!ending) ending = retire(accepted)
    return ending
  },
  open(root: string, input: Catalog, extension: string) {
    check(!retired && !opening && held().length === 0, "Original control launch or child remains owned")
    opening = true
    const pending = start(root, input, extension)
    accepted = pending
    return pending.finally(() => {
      opening = false
      if (accepted === pending) accepted = undefined
    })
  },
}

async function retire(pending: Promise<Transport> | undefined) {
  const failures: unknown[] = []
  await pending?.catch((err: unknown) => failures.push(err))
  await close().catch((err: unknown) => failures.push(err))
  if (failures.length) throw new AggregateError(failures, "Control launch and retirement failures retained")
}

async function start(root: string, input: Catalog, extension: string) {
  const catalog = parseCatalog(input)
  const selected = await directory(root)
  await directory(path.join(selected, "System"))
  for (const parent of [catalog.source, path.dirname(catalog.python), path.dirname(catalog.bridge)]) {
    await directory(parent)
  }
  const helper = await packaged(extension)
  const names = [
    catalog.python,
    catalog.bridge,
    ...Object.keys(catalog.source_sha256).map((name) => path.join(catalog.source, name)),
  ]
  const files = await Promise.all(names.map((name) => image(name)))
  const hashes = [catalog.python_sha256, catalog.bridge_sha256, ...Object.values(catalog.source_sha256)]
  check(
    files.every((row, index) => row.digest === hashes[index]),
    "Selected reviewed release differs",
  )
  const tmp = await mkdtemp(path.join(os.tmpdir(), "raya-memory-control-"))
  await protect(tmp)
  const bootstrap = path.join(tmp, "bootstrap.private.json")
  await writeFile(
    bootstrap,
    JSON.stringify({
      format: "raya.memory.control.setup",
      version: catalog.version,
      root: selected,
      source_dir: catalog.source,
      source_sha256: catalog.source_sha256,
    }),
    { flag: "wx", mode: 0o600 },
  )
  const before = await image(bootstrap, 65536)
  const env = {
    SystemRoot: process.env.SystemRoot!,
    WINDIR: process.env.WINDIR!,
    PATH: path.join(process.env.SystemRoot!, "System32"),
    TEMP: tmp,
    TMP: tmp,
  }
  check(env.SystemRoot && env.WINDIR, "Windows environment required")
  const child = spawn(
    catalog.python,
    ["-I", ...(catalog.version === 2 ? ["-S"] : []), "-u", catalog.bridge, "--config", bootstrap],
    {
      cwd: tmp,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    },
  )
  const owner = new Transport(child, selected)
  try {
    const identity = await observe(child, catalog.python, helper.helper, catalog.python_sha256)
    await retained(names, files, 1048576)
    await retained(helper.names, helper.files, 16777216)
    await retained([bootstrap], [before], 65536)
    owner.bind(identity)
    return owner
  } catch (err) {
    const cause = err instanceof Error ? err : new Error("Control identity failed")
    const closed = await owner.close().catch((closing: unknown) => {
      throw new AggregateError([cause, closing], "Identity and closure failed; original child remains owned")
    })
    if (closed.code !== 0 || closed.signal !== null || !closed.stdout || !closed.stderr) {
      throw new AggregateError(
        [
          cause,
          new Error(
            `Control closure failed: code=${closed.code};signal=${closed.signal};stdout=${closed.stdout};stderr=${closed.stderr}`,
          ),
        ],
        "Identity and closure failures retained",
      )
    }
    throw cause
  }
}
