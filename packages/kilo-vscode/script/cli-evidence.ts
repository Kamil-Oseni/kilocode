import { $ } from "bun"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"

const keys = [
  "GH_REPO",
  "KILO_BUMP",
  "KILO_BWRAP_CACHE",
  "KILO_CHANNEL",
  "RAYA_MODELS_URL",
  "KILO_MODELS_URL",
  "KILO_PRE_RELEASE",
  "KILO_RELEASE",
  "KILO_SKIP_BUNDLED_BWRAP",
  "KILO_VERSION",
  "MODELS_DEV_API_JSON",
  "ZIG",
]
const sha = (raw: string | Uint8Array) => createHash("sha256").update(raw).digest("hex")

async function publish(target: string, value: unknown) {
  const raw = Buffer.from(JSON.stringify(value))
  await writeFile(target, raw, { flag: "wx" })
  const held = await file(target)
  if (held.bytes !== raw.length || held.sha256 !== sha(raw)) throw new Error("Original compiler publication changed")
  return held
}

async function retained(refs: Awaited<ReturnType<typeof file>>[]) {
  for (const ref of refs) {
    if (!isDeepStrictEqual(ref, await file(ref.path))) throw new Error("Original compiler publication changed")
  }
}

async function file(target: string, consume?: (raw: Uint8Array) => void, single = true) {
  const before = await lstat(target, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (single && before.nlink !== 1n) ||
    path.resolve(await realpath(target)) !== path.resolve(target)
  )
    throw new Error("Build evidence requires an ordinary single-link source")
  const hash = createHash("sha256")
  let bytes = 0
  for await (const raw of createReadStream(target)) {
    bytes += raw.length
    if (bytes > 1073741824) throw new Error("Build source exceeds its observation bound")
    hash.update(raw)
    consume?.(raw)
  }
  const after = await lstat(target, { bigint: true })
  const tuple = (stat: typeof before) =>
    [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(":")
  if (tuple(before) !== tuple(after) || BigInt(bytes) !== after.size)
    throw new Error("Build source changed during observation")
  return { path: target, bytes, sha256: hash.digest("hex"), tuple: tuple(after), links: String(after.nlink) }
}

async function git(root: string, paths: string[]) {
  const [tree, diff, extra, branch, tracked, head] = await Promise.all([
    $`git ls-tree -r HEAD -- ${paths}`.cwd(root).quiet(),
    $`git diff --binary HEAD -- ${paths}`.cwd(root).quiet(),
    $`git ls-files --others --exclude-standard -z -- ${paths}`.cwd(root).quiet(),
    $`git branch --show-current`.cwd(root).quiet(),
    $`git ls-files -z -- ${paths}`.cwd(root).quiet(),
    $`git rev-parse HEAD`.cwd(root).quiet(),
  ])
  return {
    tree: tree.text(),
    diff: diff.text(),
    extra: extra.text(),
    branch: branch.text(),
    tracked: tracked.text(),
    head: head.text().trim(),
  }
}

/** Observe the existing cache recipe and its complete declared Git source union; dependencies remain unsealed. */
export async function capture(root: string, paths: string[]) {
  const held = await git(root, paths)
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? ""]))
  const encoded = JSON.stringify(env)
  const hash = createHash("sha256").update(held.tree).update(held.diff).update(held.branch).update(encoded)
  const extras = held.extra.split("\0").filter(Boolean).sort()
  const names = [...new Set([...held.tracked.split("\0").filter(Boolean), ...extras])].sort()
  if (names.length > 65536) throw new Error("Build source inventory exceeds its bound")
  const files = []
  for (const name of names) {
    const target = path.resolve(root, name)
    if (path.relative(root, target).startsWith("..")) throw new Error("Build source escapes its checkout")
    const exists = await lstat(target).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" && !extras.includes(name)) return false
        throw err
      },
    )
    files.push(
      exists ? { ...(await file(target)), relative: name, status: "present" } : { relative: name, status: "absent" },
    )
  }
  for (const name of extras) {
    hash.update(name)
    const value = await file(path.join(root, name), (raw) => hash.update(raw))
    if (
      !files.some(
        (item) =>
          "sha256" in item && item.relative === name && item.sha256 === value.sha256 && item.tuple === value.tuple,
      )
    )
      throw new Error("Untracked build source changed")
  }
  const models = process.env.MODELS_DEV_API_JSON
    ? await file(path.resolve(process.env.MODELS_DEV_API_JSON), (raw) => hash.update(raw))
    : null
  if (!isDeepStrictEqual(held, await git(root, paths))) throw new Error("Build Git source changed during capture")
  return {
    format: "raya.cli.source-union.v1",
    root,
    paths,
    head: held.head,
    input: hash.digest("hex"),
    files,
    models,
    components: {
      tree: sha(held.tree),
      diff: sha(held.diff),
      branch: sha(held.branch),
      tracked: sha(held.tracked),
      untracked: sha(held.extra),
      environment: sha(encoded),
    },
    environmentKeys: keys,
    dependenciesSealed: false,
    ignoredInputsObserved: false,
  }
}

async function streams(child: ReturnType<typeof Bun.spawn>, dir: string) {
  const read = async (name: "stdout" | "stderr") => {
    const stream = child[name]
    if (!stream || typeof stream === "number") throw new Error("Original compiler pipe is unavailable")
    const hash = createHash("sha256")
    const parts: Uint8Array[] = []
    let bytes = 0
    for await (const raw of stream) {
      bytes += raw.length
      hash.update(raw)
      if (bytes <= 134217728) parts.push(raw)
      process[name].write(raw)
    }
    const target = path.join(dir, name + ".log")
    await writeFile(target, Buffer.concat(parts), { flag: "wx" })
    return { path: target, bytes, sha256: hash.digest("hex"), eof: true, joined: true, bounded: bytes <= 134217728 }
  }
  const rows = await Promise.allSettled([read("stdout"), read("stderr"), child.exited])
  return rows
}

/** Select an already available exact pinned interpreter; this never downloads or installs one. */
export async function runtime(manager: string) {
  const version = /^bun@(\d+\.\d+\.\d+)$/.exec(manager)?.[1]
  if (!version) throw new Error("Exact pinned Bun version required for compiler evidence")
  const home = process.env.BUN_INSTALL ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".bun")
  const names = [
    ...new Set(
      [
        process.execPath,
        Bun.which("bun"),
        path.join(home, "install/cache", manager + "@@@1", "bin", process.platform === "win32" ? "bun.exe" : "bun"),
      ].filter((item): item is string => !!item),
    ),
  ]
  for (const target of names) {
    if (!(await Bun.file(target).exists())) continue
    const held = await file(target, undefined, false)
    const child = Bun.spawn([target, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (
      code === 0 &&
      stdout.trim() === version &&
      !stderr.trim() &&
      isDeepStrictEqual(held, await file(target, undefined, false))
    )
      return { ...held, version }
  }
  throw new Error("An observed exact pinned Bun interpreter is unavailable")
}

async function phase(dir: string, pid: number, source: string, cwd: string, interpreter: string) {
  const value = JSON.parse(await readFile(path.join(dir, "phase-complete.json"), "utf8")) as {
    pid?: unknown
    source?: unknown
    succeeded?: unknown
    cwd?: unknown
    interpreter?: unknown
    output?: { path?: unknown; bytes?: unknown; sha256?: unknown }
  }
  if (
    value.pid !== pid ||
    value.source !== source ||
    value.succeeded !== true ||
    value.cwd !== cwd ||
    value.interpreter !== interpreter ||
    typeof value.output?.path !== "string"
  )
    throw new Error("Actual Bun.build phase does not bind its original compiler")
  const output = await file(value.output.path)
  if (output.bytes !== value.output.bytes || output.sha256 !== value.output.sha256)
    throw new Error("Actual compiler output changed after its phase")
  return output
}

/** Hold the actual Bun process running Bun.build, not a bunx/local-bin launcher, and retain only observed joins. */
export async function execute(opts: {
  root: string
  cwd: string
  paths: string[]
  manager: string
  evidence: string
  script: string
  args: string[]
}) {
  if (!path.isAbsolute(opts.evidence) || !path.isAbsolute(opts.script))
    throw new Error("Absolute build evidence and script paths required")
  await mkdir(opts.evidence, { recursive: true })
  if (path.resolve(await realpath(opts.evidence)) !== path.resolve(opts.evidence))
    throw new Error("Build evidence directory is redirected")
  const dir = path.join(opts.evidence, randomUUID().replaceAll("-", ""))
  await mkdir(dir)
  const before = await capture(opts.root, opts.paths)
  const interpreter = await runtime(opts.manager)
  const original = await publish(path.join(dir, "source-before.json"), before)
  const argv = [interpreter.path, opts.script, ...opts.args]
  const child = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env, RAYA_CLI_COMPILER_EVIDENCE: dir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const publication = await publish(path.join(dir, "launch.json"), {
    format: "raya.cli.compiler-launch.v1",
    pid: child.pid,
    parent: process.pid,
    argv,
    cwd: opts.cwd,
    interpreter,
    source: before.input,
    windowsHide: true,
    stdin: "ignore",
    jobContainmentObserved: false,
    familyJoinsObserved: false,
    protection: { exclusivePublication: true, aclObserved: false },
  }).then(
    (ref) => ({ ref }),
    (err: unknown) => ({ err }),
  )
  const rows = await streams(child, dir)
  const [stdout, stderr, exit] = rows
  const terminal = {
    format: "raya.cli.compiler-terminal.v1",
    pid: child.pid,
    originalJoined: exit.status === "fulfilled",
    code: exit.status === "fulfilled" ? exit.value : null,
    stdout: stdout.status === "fulfilled" ? stdout.value : null,
    stderr: stderr.status === "fulfilled" ? stderr.value : null,
    forced: false,
    jobContainmentObserved: false,
    familyJoinsObserved: false,
    errors: [
      ...("err" in publication ? [String(publication.err)] : []),
      ...rows.flatMap((row) => (row.status === "rejected" ? [String(row.reason)] : [])),
    ],
  }
  const retired = await publish(path.join(dir, "terminal.json"), terminal)
  const after = await capture(opts.root, opts.paths)
  const current = await publish(path.join(dir, "source-after.json"), after)
  if (
    !isDeepStrictEqual(before, after) ||
    !isDeepStrictEqual(
      interpreter,
      await file(interpreter.path, undefined, false).then((value) => ({ ...value, version: interpreter.version })),
    )
  )
    throw new Error("Compiler source or interpreter changed; original evidence retained")
  if (
    "err" in publication ||
    terminal.code !== 0 ||
    terminal.errors.length ||
    !terminal.stdout?.bounded ||
    !terminal.stderr?.bounded
  )
    throw new Error("Original compiler did not retire successfully; evidence retained")
  await retained([original, retired, current, publication.ref])
  const output = await phase(dir, child.pid, before.input, opts.cwd, interpreter.path)
  const result = {
    format: "raya.cli.compiler-evidence.v1",
    dir,
    source: before.input,
    launch: publication.ref,
    terminal: retired,
    before: original,
    after: current,
    phase: await file(path.join(dir, "phase-complete.json")),
    output,
    executionJoined: true,
    familyJoinsObserved: false,
  }
  await writeFile(path.join(dir, "result.json"), JSON.stringify(result), { flag: "wx" })
  return result
}
