import { expect, test } from "bun:test"
import contract from "../../docs/Raya-Support-Contract.json"
import { check, matrix, notes, replace } from "./raya-support"

const [manifest, workflow, document] = await Promise.all([
  Bun.file(new URL("../../packages/kilo-vscode/package.json", import.meta.url)).text(),
  Bun.file(new URL("../../.github/workflows/raya-release.yml", import.meta.url)).text(),
  Bun.file(new URL("../../docs/Raya-Supported-Clients.md", import.meta.url)).text(),
]).then((values) => values.map((value) => value.replaceAll("\r\n", "\n")))

test("real manifest, workflow and published matrix agree", () => {
  expect(() => check(contract, manifest!, workflow!, document!)).not.toThrow()
})

test("identity and minimum editor drift fail closed", () => {
  for (const update of [{ publisher: "other" }, { name: "other" }, { engines: { vscode: "^1.107.0" } }]) {
    expect(() =>
      check(contract, JSON.stringify({ ...JSON.parse(manifest!), ...update }), workflow!, document!),
    ).toThrow("identity or editor")
  }
})

test("target, runner, publishing and generated documentation drift fail", () => {
  for (const [before, after] of [
    ["target: linux-x64", "target: linux-arm64"],
    ["os: macos-latest", "os: macos-14"],
    ["--notes-file dist/support-notes.md", "--notes-file other.md"],
    ["--notes dist/support-notes.md", "--notes other.md"],
  ]) {
    expect(() => check(contract, manifest!, workflow!.replace(before!, after!), document!)).toThrow()
  }
  expect(() => check(contract, manifest!, workflow!, document!.replace("raya-linux-x64.vsix", "other.vsix"))).toThrow(
    "stale",
  )
})

test("invalid assets, duplicate targets and unsupported installation claims fail", () => {
  const asset = structuredClone(contract)
  asset.targets[0]!.asset = "upstream.vsix"
  const duplicate = structuredClone(contract)
  duplicate.targets.push(duplicate.targets[0]!)
  const evidence = structuredClone(contract)
  evidence.targets[1]!.installation = "local-checkpoint"
  for (const value of [asset, duplicate, evidence])
    expect(() => check(value, manifest!, workflow!, document!)).toThrow()
})

test("packaging target and checkout cannot drift from the claimed release source", () => {
  expect(() =>
    check(
      contract,
      manifest!,
      workflow!.replace("RAYA_VSCE_TARGET: ${{ matrix.target }}", "RAYA_VSCE_TARGET: linux-arm64"),
      document!,
    ),
  ).toThrow("declared target")
  expect(() =>
    check(contract, manifest!, workflow!.replaceAll("ref: ${{ github.sha }}", "ref: main"), document!),
  ).toThrow("triggering source")
})

test("generation is idempotent and preserves manual feature coverage", () => {
  const source = `introduction\n<!-- raya-support:start -->old<!-- raya-support:end -->\nfeature limits`
  const generated = replace(source, contract)
  expect(generated).toBe(`introduction\n${matrix(contract)}\nfeature limits`)
  expect(replace(generated, contract)).toBe(generated)
  expect(() => replace("missing", contract)).toThrow("exactly once")
  expect(() => replace(source + "<!-- raya-support:start -->", contract)).toThrow("exactly once")
})

test("release notes use immutable source links and distinguish evidence from assets", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678"
  const text = notes(contract, "owner/fork", sha)
  expect(text).toContain(`https://github.com/owner/fork/blob/${sha}/docs/Raya-Supported-Clients.md`)
  expect(text).not.toContain("/blob/main/")
  expect(text).toContain("eden.raya")
  expect(text).toContain("^1.106.0")
  expect(text).toContain("not a verified installation")
  expect(text).toContain("Installation remains unverified for: `darwin-arm64`, `linux-x64`")
  expect(() => notes(contract, "owner/fork", "main")).toThrow("full source commit")
  expect(() => notes(contract, "owner/fork\ninjected", sha)).toThrow("repository")
})
