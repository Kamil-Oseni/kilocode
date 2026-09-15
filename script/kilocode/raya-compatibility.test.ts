import { expect, test } from "bun:test"
import { RayaMigrationLedger } from "../../packages/opencode/src/kilocode/migration/compatibility"
import { check } from "./raya-compatibility"

const root = new URL("../../", import.meta.url)
const files = [
  "package.json",
  "packages/opencode/package.json",
  "packages/kilo-console/package.json",
  "packages/kilo-docs/package.json",
  "packages/kilo-gateway/package.json",
  "packages/kilo-i18n/package.json",
  "packages/kilo-indexing/package.json",
  "packages/kilo-jetbrains/package.json",
  "packages/kilo-memory/package.json",
  "packages/kilo-telemetry/package.json",
  "packages/kilo-ui/package.json",
  "packages/kilo-web-ui/package.json",
  "packages/plugin/package.json",
  "packages/plugin-atomic-chat/package.json",
  "packages/kilo-sandbox/package.json",
  "packages/sdk/js/package.json",
  "script/upstream/package.json",
]
const [inventory, extension, manifests] = await Promise.all([
  Bun.file(new URL("script/raya-brand-inventory.json", root)).text(),
  Bun.file(new URL("packages/kilo-vscode/package.json", root)).text(),
  Promise.all(files.map(async (file) => ({ file, text: await Bun.file(new URL(file, root)).text() }))),
])

test("the real tree agrees with the fail-closed compatibility ledger", () => {
  expect(() => check(RayaMigrationLedger.snapshot, inventory, manifests, extension)).not.toThrow()
})

test("package, command, baseline and editor drift fail closed", () => {
  const cli = manifests.find((item) => item.file === "packages/opencode/package.json")!
  const cases = [
    {
      list: manifests.filter((item) => item.file !== "packages/kilo-memory/package.json"),
      brand: inventory,
      vscode: extension,
    },
    {
      list: manifests.map((item) =>
        item === cli ? { ...item, text: item.text.replace('"raya": "./bin/kilo"', '"raya": "./bin/raya"') } : item,
      ),
      brand: inventory,
      vscode: extension,
    },
    { list: manifests, brand: inventory.replace('"count": 35122', '"count": 35123'), vscode: extension },
    { list: manifests, brand: inventory, vscode: extension.replace('"publisher": "eden"', '"publisher": "other"') },
  ]
  for (const item of cases)
    expect(() => check(RayaMigrationLedger.snapshot, item.brand, item.list, item.vscode)).toThrow()
})

test("version 1 cannot declare a cutover ready", () => {
  const snapshot = structuredClone(RayaMigrationLedger.snapshot) as unknown as RayaMigrationLedger.Snapshot
  ;(snapshot.entries[0] as { cutoverReady: boolean }).cutoverReady = true
  expect(() => check(snapshot, inventory, manifests, extension)).toThrow()
})
