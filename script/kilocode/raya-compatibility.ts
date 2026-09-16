import path from "node:path"
import { RayaMigrationLedger } from "../../packages/opencode/src/kilocode/migration/compatibility"

type Manifest = { file: string; text: string }

function entry(snapshot: RayaMigrationLedger.Snapshot, id: string) {
  const value = snapshot.entries.find((item) => item.id === id)
  if (!value) throw new Error(`Compatibility ledger entry is missing: ${id}`)
  return value
}

function names(manifests: readonly Manifest[]) {
  return manifests
    .map((item) => ({ file: item.file, value: JSON.parse(item.text) as { name?: string; bin?: unknown } }))
    .filter((item) => item.value.name?.startsWith("@kilocode/"))
}

export function check(
  snapshot: RayaMigrationLedger.Snapshot,
  inventory: string,
  manifests: readonly Manifest[],
  extension: string,
  paths: string,
) {
  if (snapshot.format !== "raya.compatibility-ledger" || snapshot.version !== 1)
    throw new Error("Unsupported compatibility ledger.")
  if (snapshot.entries.some((item) => item.cutoverReady !== false))
    throw new Error("Version 1 compatibility entries must fail closed.")

  const brand = JSON.parse(inventory) as {
    categories?: Record<string, { count?: number; digest?: string }>
  }
  const baseline = brand.categories?.["compatibility-key"]
  if (baseline?.count !== snapshot.baseline.count || baseline.digest !== snapshot.baseline.digest)
    throw new Error("Compatibility baseline differs from the brand inventory.")

  const packages = names(manifests)
  const actual = packages.map((item) => item.value.name!).sort()
  const declared = entry(snapshot, "package-identities")
    .identities.filter((item) => item.kind === "package:name")
    .map((item) => item.legacy)
    .sort()
  if (JSON.stringify(actual) !== JSON.stringify(declared))
    throw new Error("Package identities differ from the compatibility ledger.")

  const cli = packages.find((item) => item.value.name === "@kilocode/cli")?.value.bin
  if (
    !cli ||
    typeof cli !== "object" ||
    JSON.stringify(cli) !== JSON.stringify({ raya: "./bin/kilo", kilo: "./bin/kilo", kilocode: "./bin/kilo" })
  )
    throw new Error("CLI aliases differ from the compatibility ledger.")

  const env = entry(snapshot, "environment-inputs").identities.map((item) => [item.raya, item.legacy, item.policy])
  const expected = [
    "CONFIG",
    "CONFIG_CONTENT",
    "CONFIG_DIR",
    "AUTH_CONTENT",
    "DB",
    "GIT_BASH_PATH",
    "MODELS_PATH",
    "BIN_PATH",
    "TUI_CONFIG",
    "MODELS_URL",
    "COMMAND_TIMEOUT_MAX_MS",
    "COMMAND_TIMEOUT_MAX_MS_MESSAGE",
    "NO_DAEMON",
    "LOG_LEVEL",
    "PRINT_LOGS",
    "WEBSEARCH_PROVIDER",
    "DISABLE_PROJECT_CONFIG",
  ].map((name) => [`RAYA_${name}`, `KILO_${name}`, "raya-wins-legacy-write"])
  expected.push(
    ["RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD", "explicit-or-matching-aliases"],
    ["RAYA_SERVER_USERNAME", "KILO_SERVER_USERNAME", "explicit-or-matching-aliases"],
  )
  if (JSON.stringify(env) !== JSON.stringify(expected))
    throw new Error("Environment aliases or precedence differ from the compatibility ledger.")

  const config = entry(snapshot, "configuration-sources").identities
  for (const name of [
    "config.json",
    "kilo.json",
    "kilo.jsonc",
    "opencode.json",
    "opencode.jsonc",
    "raya.json",
    "raya.jsonc",
    ".kilocode",
    ".kilo",
    ".raya",
  ]) {
    if (!config.some((item) => item.raya === name || item.legacy === name))
      throw new Error(`Configuration identity is missing: ${name}`)
  }
  for (const item of config.filter(
    (item) => item.raya === "raya.json" || item.raya === "raya.jsonc" || item.raya === ".raya",
  )) {
    if (item.policy !== "raya-wins-legacy-write")
      throw new Error("Raya configuration sources must remain read-only aliases.")
  }

  const database = entry(snapshot, "database-files").identities.map((item) => item.legacy)
  if (
    JSON.stringify(database) !==
    JSON.stringify(["kilo.db", "kilo-${InstallationChannel}.db", "opencode-${InstallationChannel}.db"])
  )
    throw new Error("Database filename grammar differs from the compatibility ledger.")

  const roots = entry(snapshot, "profile-roots")
  if (
    !roots.identities.some(
      (item) =>
        item.kind === "inventory:global-path-consumers" &&
        item.legacy === "script/global-path-consumers.json" &&
        item.policy === "legacy-canonical",
    )
  )
    throw new Error("Global.Path consumer inventory is not bound to the profile-root migration.")
  const consumers = JSON.parse(paths) as {
    format?: unknown
    version?: unknown
    policy?: unknown
    total?: { count?: unknown }
    consumers?: unknown[]
  }
  if (
    consumers.format !== "raya.global-path-consumers" ||
    consumers.version !== 1 ||
    consumers.policy !== "inventory-only-no-cutover-evidence" ||
    typeof consumers.total?.count !== "number" ||
    consumers.total.count === 0 ||
    consumers.consumers?.length !== consumers.total.count
  )
    throw new Error("Global.Path consumer inventory is invalid or incorrectly claims cutover evidence.")

  const pkg = JSON.parse(extension) as { publisher?: string; name?: string }
  const editor = entry(snapshot, "editor-distribution")
  if (
    editor.phase !== "deferred-version-3" ||
    !editor.identities.some((item) => item.kind === "extension:id" && item.raya === `${pkg.publisher}.${pkg.name}`) ||
    !editor.identities.some((item) => item.kind === "editor:distribution" && item.policy === "deferred-version-3")
  )
    throw new Error("Extension identity or deferred editor policy differs from the compatibility ledger.")

  const text = JSON.stringify(snapshot)
  if (/([A-Z]:\\|\/Users\/|\/home\/|Bearer |api[_-]?key|token=)/i.test(text))
    throw new Error("Compatibility ledger contains a machine path or secret.")
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "../..")
  const list = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "package.json",
      "packages/*/package.json",
      "packages/sdk/js/package.json",
      "script/upstream/package.json",
    ],
    {
      cwd: root,
    },
  )
  if (list.exitCode !== 0) throw new Error("Cannot enumerate tracked package manifests.")
  const files = list.stdout.toString().replaceAll("\r\n", "\n").trim().split("\n").filter(Boolean)
  const [inventory, extension, paths, manifests] = await Promise.all([
    Bun.file(path.join(root, "script/raya-brand-inventory.json")).text(),
    Bun.file(path.join(root, "packages/kilo-vscode/package.json")).text(),
    Bun.file(path.join(root, "script/global-path-consumers.json")).text(),
    Promise.all(files.map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() }))),
  ])
  check(RayaMigrationLedger.snapshot, inventory, manifests, extension, paths)
  console.log("Raya compatibility ledger verified.")
}
