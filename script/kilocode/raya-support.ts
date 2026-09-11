import path from "node:path"
import contract from "../../docs/Raya-Support-Contract.json"

type Contract = typeof contract
const start = "<!-- raya-support:start -->"
const end = "<!-- raya-support:end -->"
const command = "bun run script/kilocode/raya-support.ts"

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

export function matrix(data: Contract) {
  return [
    start,
    `Extension: **\`${data.extension.publisher}.${data.extension.name}\`**. Minimum editor range: **VS Code \`${data.extension.editor}\`**. Backend compatibility: SDK, CLI and extension from the same source build.`,
    "",
    "| Build target | Runner | Expected release asset | Installation evidence |",
    "|---|---|---|---|",
    ...data.targets.map(
      (row) =>
        `| \`${row.target}\` | \`${row.os}\` | \`${row.asset}\` | ${row.installation === "local-checkpoint" ? "Local checkpoint only; not certification of a future release asset." : "Unverified; configured build target only."} |`,
    ),
    "",
    `Local installation evidence: \`${data.evidence.commit}\` (${data.evidence.date}), \`${data.evidence.target}\`; VSIX SHA-256 \`${data.evidence.sha256}\`. See the [delivery record](Raya-Implementation-Progress.md). This records packaging and installation, not all live workflows or activation after reload.`,
    end,
  ].join("\n")
}

export function replace(document: string, data: Contract) {
  const first = document.indexOf(start)
  const last = document.indexOf(end)
  if (first < 0 || last < first || document.indexOf(start, first + 1) >= 0 || document.indexOf(end, last + 1) >= 0)
    throw new Error("Support matrix markers must occur exactly once.")
  return document.slice(0, first) + matrix(data) + document.slice(last + end.length)
}

export function check(data: Contract, manifest: string, workflow: string, document: string) {
  const pkg = JSON.parse(manifest)
  if (data.version !== 1 || data.backend !== "same-source-build") throw new Error("Unsupported support contract.")
  if (
    pkg.publisher !== data.extension.publisher ||
    pkg.name !== data.extension.name ||
    pkg.engines?.vscode !== data.extension.editor
  )
    throw new Error("Extension identity or editor range differs from the support contract.")
  if (
    !/^[a-f0-9]{40}$/.test(data.evidence.commit) ||
    !/^[a-f0-9]{64}$/.test(data.evidence.sha256) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(data.evidence.date) ||
    data.evidence.record !== "docs/Raya-Implementation-Progress.md"
  )
    throw new Error("Invalid support evidence identity.")
  if (!data.targets.length || new Set(data.targets.map((row) => row.target)).size !== data.targets.length)
    throw new Error("Support targets must be unique and nonempty.")
  for (const row of data.targets) {
    if (
      !/^[a-z0-9]+-[a-z0-9]+$/.test(row.target) ||
      row.asset !== `raya-${row.target}.vsix` ||
      !["local-checkpoint", "unverified"].includes(row.installation)
    )
      throw new Error("Invalid support target or asset.")
    if ((row.installation === "local-checkpoint") !== (row.target === data.evidence.target))
      throw new Error("Installation claim lacks matching checkpoint evidence.")
  }
  if (!data.targets.some((row) => row.target === data.evidence.target)) throw new Error("Evidence target is absent.")
  const jobs = field(Bun.YAML.parse(workflow), "jobs")
  const actual = field(field(field(field(jobs, "build"), "strategy"), "matrix"), "include")
  if (JSON.stringify(actual) !== JSON.stringify(data.targets.map(({ os, target }) => ({ os, target }))))
    throw new Error("Release build matrix differs from the support contract.")
  const build = field(field(jobs, "build"), "steps")
  const publish = field(field(jobs, "release"), "steps")
  if (!Array.isArray(build) || !Array.isArray(publish)) throw new Error("Release steps are missing.")
  if (
    field(field(jobs, "build"), "runs-on") !== "${{ matrix.os }}" ||
    !build.some(
      (step: unknown) =>
        field(step, "run") === "bun run snapshot:release" &&
        field(field(step, "env"), "RAYA_VSCE_TARGET") === "${{ matrix.target }}",
    )
  )
    throw new Error("Release packaging must use the declared target and runner.")
  for (const steps of [build, publish]) {
    if (
      !steps.some(
        (step: unknown) =>
          String(field(step, "uses")).startsWith("actions/checkout@") &&
          field(field(step, "with"), "ref") === "${{ github.sha }}",
      )
    )
      throw new Error("Release checkout must pin the triggering source commit.")
  }
  if (
    !build.some((step: unknown) => field(step, "run") === command) ||
    !publish.some((step: unknown) => field(step, "run") === `${command} --notes dist/support-notes.md`)
  )
    throw new Error("Release must check support and generate pinned notes.")
  if (
    !publish.some((step: unknown) => {
      const run = field(step, "run")
      return typeof run === "string" && run.includes("--notes-file dist/support-notes.md")
    })
  )
    throw new Error("Release must publish the support notes.")
  if (replace(document, data) !== document) throw new Error("Generated support matrix is stale; run with --write.")
}

export function notes(data: Contract, repository: string, commit: string) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Release notes require a repository and full source commit.")
  return (
    `Raya extension \`${data.extension.publisher}.${data.extension.name}\` requires VS Code \`${data.extension.editor}\` and its matching bundled backend.\n\n` +
    `[Supported clients and validation boundaries](https://github.com/${repository}/blob/${commit}/docs/Raya-Supported-Clients.md).\n\n` +
    `Build targets: ${data.targets.map((row) => `\`${row.target}\``).join(", ")}. A built or published asset is not a verified installation. The matrix records local \`${data.evidence.target}\` checkpoint evidence separately. Installation remains unverified for: ${
      data.targets
        .filter((row) => row.installation === "unverified")
        .map((row) => `\`${row.target}\``)
        .join(", ") || "none of the declared targets"
    }.\n`
  )
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "../..")
  const file = path.join(root, "docs/Raya-Supported-Clients.md")
  const [manifest, workflow, document] = await Promise.all([
    Bun.file(path.join(root, "packages/kilo-vscode/package.json")).text(),
    Bun.file(path.join(root, ".github/workflows/raya-release.yml")).text(),
    Bun.file(file).text(),
  ])
  const args = Bun.argv.slice(2)
  if (args.length && !(args.length === 1 && args[0] === "--write") && !(args.length === 2 && args[0] === "--notes"))
    throw new Error("Usage: raya-support.ts [--write | --notes output.md]")
  const updated = args[0] === "--write" ? replace(document, contract) : document
  check(contract, manifest, workflow, updated.replaceAll("\r\n", "\n"))
  if (args[0] === "--write") await Bun.write(file, updated)
  if (args[0] === "--notes") {
    const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root })
    if (git.exitCode !== 0) throw new Error("Cannot identify checked-out release source.")
    await Bun.write(args[1]!, notes(contract, process.env.GITHUB_REPOSITORY ?? "", git.stdout.toString().trim()))
  }
  console.log("Raya support contract verified.")
}
