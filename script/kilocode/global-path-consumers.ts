#!/usr/bin/env bun
// kilocode_change - new file

import { spawnSync } from "node:child_process"
import path from "node:path"
import ts from "typescript"

const ROOT = path.resolve(import.meta.dir, "../..")
const FILE = "script/global-path-consumers.json"
const MEMBERS = ["bin", "cache", "config", "data", "home", "log", "repos", "state", "tmp"] as const
type Member = (typeof MEMBERS)[number] | "*"
const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
])

export type Consumer = {
  file: string
  member: Member
  phase: "module" | "runtime"
  access: "read" | "write"
  context: string
  ordinal: number
}

export type Inventory = {
  format: "raya.global-path-consumers"
  version: 1
  scope: "tracked-package-runtime-source"
  policy: "inventory-only-no-cutover-evidence"
  total: { count: number; digest: string }
  members: Record<(typeof MEMBERS)[number], { count: number; module: number; writes: number }>
  enumerations: number
  files: Array<{ file: string; count: number }>
  moduleCaptures: Consumer[]
  consumers: Consumer[]
}

type Raw = Omit<Consumer, "ordinal">

function property(node: ts.PropertyName | undefined) {
  if (!node) return undefined
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

export function checkProducer(text: string) {
  const source = ts.createSourceFile(
    "packages/core/src/global.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const object: string[] = []
  const shape: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "paths" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const item of node.initializer.properties) {
        if (!("name" in item)) continue
        const name = property(item.name)
        if (name) object.push(name)
      }
    }
    if (ts.isInterfaceDeclaration(node) && node.name.text === "Interface") {
      for (const item of node.members) {
        const name = property(item.name)
        if (name) shape.push(name)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const expected = [...MEMBERS].sort()
  const errors: string[] = []
  if (JSON.stringify(object.sort()) !== JSON.stringify(expected))
    errors.push(
      `Global.Path producer fields changed: expected ${expected.join(", ")}, found ${object.sort().join(", ")}.`,
    )
  if (JSON.stringify(shape.sort()) !== JSON.stringify(expected))
    errors.push(`Global interface fields changed: expected ${expected.join(", ")}, found ${shape.sort().join(", ")}.`)
  return errors
}

function sourceKind(file: string) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (file.endsWith(".js") || file.endsWith(".mjs")) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function moduleName(value: ts.Expression) {
  if (!ts.isStringLiteral(value)) return undefined
  return value.text.replaceAll("\\", "/")
}

function imported(value: ts.Expression | undefined) {
  const expr = value && ts.isAwaitExpression(value) ? value.expression : value
  if (!expr || !ts.isCallExpression(expr) || expr.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined
  return expr.arguments[0] ? moduleName(expr.arguments[0]) : undefined
}

function globalModule(name: string | undefined) {
  return !!name && /(?:^|\/)global(?:\.[cm]?js)?$/.test(name)
}

type Bindings = {
  globals: Set<string>
  paths: Set<string>
  namespaces: Set<string>
}

function bindings(source: ts.SourceFile): Bindings {
  const result: Bindings = { globals: new Set(), paths: new Set(), namespaces: new Set() }
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node)) continue
    const name = moduleName(node.moduleSpecifier)
    if (!globalModule(name)) continue
    const clause = node.importClause?.namedBindings
    if (clause && ts.isNamespaceImport(clause)) result.namespaces.add(clause.name.text)
    if (!clause || !ts.isNamedImports(clause)) continue
    for (const item of clause.elements) {
      const name = item.propertyName?.text ?? item.name.text
      if (name === "Global") result.globals.add(item.name.text)
      if (name === "Path") result.paths.add(item.name.text)
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      globalModule(imported(node.initializer))
    ) {
      for (const item of node.name.elements) {
        const name =
          item.propertyName && ts.isIdentifier(item.propertyName) ? item.propertyName.text : item.name.getText(source)
        if (!ts.isIdentifier(item.name)) continue
        if (name === "Global") result.globals.add(item.name.text)
        if (name === "Path") result.paths.add(item.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function base(node: ts.Expression, names: Bindings) {
  if (ts.isIdentifier(node)) return names.paths.has(node.text)
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "Path") return false
  if (ts.isIdentifier(node.expression))
    return names.globals.has(node.expression.text) || names.namespaces.has(node.expression.text)
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "Global" &&
    ts.isIdentifier(node.expression.expression) &&
    names.namespaces.has(node.expression.expression.text)
  )
}

function enumeration(node: ts.Node) {
  const parent = node.parent
  if (!ts.isCallExpression(parent) || !parent.arguments.some((item) => item === node)) return false
  if (!ts.isPropertyAccessExpression(parent.expression)) return false
  return (
    ts.isIdentifier(parent.expression.expression) &&
    parent.expression.expression.text === "Object" &&
    ["entries", "keys", "values"].includes(parent.expression.name.text)
  )
}

function member(node: ts.Node, names: Bindings) {
  if (ts.isPropertyAccessExpression(node) && base(node.expression, names)) return node.name.text
  if (!ts.isElementAccessExpression(node) || !base(node.expression, names)) return undefined
  return ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null
}

function nested(node: ts.Node): boolean {
  if (!node.parent) return false
  return ts.isFunctionLike(node.parent) || nested(node.parent)
}

function phase(node: ts.Node) {
  return nested(node) ? ("runtime" as const) : ("module" as const)
}

function access(node: ts.Node) {
  const parent = node.parent
  if (ts.isDeleteExpression(parent)) return "write" as const
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return "write" as const
  if (ts.isBinaryExpression(parent) && parent.left === node && ASSIGNMENTS.has(parent.operatorToken.kind))
    return "write" as const
  return "read" as const
}

function context(source: ts.SourceFile, node: ts.Node) {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
  const start = source.getPositionOfLineAndCharacter(line, 0)
  const end = line + 1 < source.getLineStarts().length ? source.getPositionOfLineAndCharacter(line + 1, 0) : source.end
  return source.text.slice(start, end).trim().replace(/\s+/g, " ")
}

export function scanSource(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, sourceKind(file))
  const names = bindings(source)
  const hits: Array<Raw & { pos: number }> = []
  const errors: string[] = []
  const visit = (node: ts.Node): void => {
    const declaration =
      ts.isIdentifier(node) && (ts.isImportSpecifier(node.parent) || ts.isNamespaceImport(node.parent))
    if (!declaration && base(node as ts.Expression, names)) {
      const parent = node.parent
      const used =
        (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
        (ts.isElementAccessExpression(parent) && parent.expression === node)
      if (enumeration(node)) {
        hits.push({
          file,
          member: "*",
          phase: phase(node),
          access: "read",
          context: context(source, node),
          pos: node.getStart(source),
        })
      } else if (!used) errors.push(`${file}: bare Global.Path access is not classified: ${context(source, node)}`)
    }
    const name = member(node, names)
    if (name === null) errors.push(`${file}: dynamic Global.Path member is not classified: ${context(source, node)}`)
    if (typeof name === "string") {
      if (!MEMBERS.some((item) => item === name)) {
        errors.push(`${file}: unknown Global.Path member ${name}: ${context(source, node)}`)
      } else {
        hits.push({
          file,
          member: name,
          phase: phase(node),
          access: access(node),
          context: context(source, node),
          pos: node.getStart(source),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const seen = new Map<string, number>()
  const consumers = hits
    .sort((a, b) => a.pos - b.pos)
    .map(({ pos: _, ...item }) => {
      const key = JSON.stringify(item)
      const ordinal = (seen.get(key) ?? 0) + 1
      seen.set(key, ordinal)
      return { ...item, ordinal }
    })
  return { consumers, errors }
}

function digest(consumers: readonly Consumer[]) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(consumers)).digest("hex")
}

export function make(consumers: Consumer[]): Inventory {
  const sorted = consumers.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const members = Object.fromEntries(
    MEMBERS.map((name) => {
      const items = sorted.filter((item) => item.member === name)
      return [
        name,
        {
          count: items.length,
          module: items.filter((item) => item.phase === "module").length,
          writes: items.filter((item) => item.access === "write").length,
        },
      ]
    }),
  ) as Inventory["members"]
  const files = [...Map.groupBy(sorted, (item) => item.file)].map(([file, items]) => ({ file, count: items.length }))
  return {
    format: "raya.global-path-consumers",
    version: 1,
    scope: "tracked-package-runtime-source",
    policy: "inventory-only-no-cutover-evidence",
    total: { count: sorted.length, digest: digest(sorted) },
    members,
    enumerations: sorted.filter((item) => item.member === "*").length,
    files,
    moduleCaptures: sorted.filter((item) => item.phase === "module"),
    consumers: sorted,
  }
}

export function compare(actual: Inventory, expected: Inventory) {
  const errors: string[] = []
  if (expected.format !== "raya.global-path-consumers" || expected.version !== 1)
    errors.push("Unsupported Global.Path consumer inventory.")
  if (expected.policy !== "inventory-only-no-cutover-evidence")
    errors.push("Global.Path inventory must not count as storage-cutover evidence.")
  if (actual.total.count !== expected.total.count)
    errors.push(`Global.Path consumer count changed: expected ${expected.total.count}, found ${actual.total.count}.`)
  if (actual.total.digest !== expected.total.digest)
    errors.push(
      `Global.Path consumer context changed: expected ${expected.total.digest}, found ${actual.total.digest}.`,
    )
  if (JSON.stringify(actual.members) !== JSON.stringify(expected.members))
    errors.push("Global.Path member totals changed.")
  if (actual.enumerations !== expected.enumerations) errors.push("Global.Path bounded enumerations changed.")
  if (JSON.stringify(actual.files) !== JSON.stringify(expected.files)) errors.push("Global.Path source files changed.")
  if (JSON.stringify(actual.moduleCaptures) !== JSON.stringify(expected.moduleCaptures))
    errors.push("Global.Path module-scope captures changed.")
  return errors
}

export async function inventory(root = ROOT) {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
  if (listed.status !== 0) throw new Error("Cannot enumerate tracked files for the Global.Path inventory.")
  const files = listed.stdout
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((file) => /^packages\/[^/]+\/src\/.*\.(?:ts|tsx|js|mjs)$/.test(file))
    .sort()
  const consumers: Consumer[] = []
  const producer = await Bun.file(path.join(root, "packages/core/src/global.ts")).text()
  const errors = checkProducer(producer)
  for (const file of files) {
    const text = await Bun.file(path.join(root, file)).text()
    if (!text.includes("Path")) continue
    const result = scanSource(file, text)
    consumers.push(...result.consumers)
    errors.push(...result.errors)
  }
  if (errors.length) throw new Error(errors.join("\n"))
  return make(consumers)
}

if (import.meta.main) {
  const actual = await inventory()
  if (process.argv.includes("--update")) {
    await Bun.write(path.join(ROOT, FILE), JSON.stringify(actual, null, 2) + "\n")
    console.log(`global-path-consumers: wrote ${actual.total.count} reviewed consumer(s) to ${FILE}.`)
    process.exit(0)
  }
  const expected = (await Bun.file(path.join(ROOT, FILE)).json()) as Inventory
  const errors = compare(actual, expected)
  if (errors.length) {
    for (const error of errors) console.error(error)
    console.error("Run with --update only after reviewing every changed consumer and its storage implications.")
    process.exit(1)
  }
  console.log(
    `global-path-consumers: ${actual.total.count} consumer(s), ${actual.moduleCaptures.length} module capture(s), no drift.`,
  )
}
