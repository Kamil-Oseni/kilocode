import path from "node:path"
import { check, child, document, object } from "../control/frames"
import { release, selected } from "../control/catalog-capture"
import { normalize } from "../control/identity"
import { current } from "./catalog"

type Image = Readonly<{ path: string; bytes: number; sha256: string; identity: readonly string[] }>
type Directory = Readonly<{ path: string; identity: readonly string[] }>
type Source = Readonly<{ path: string; pins: Readonly<Record<string, string>> }>

function same(input: Readonly<Record<string, unknown>>, pins: Readonly<Record<string, string>>) {
  return (
    Object.keys(input).length === Object.keys(pins).length &&
    Object.entries(pins).every(([name, sha]) => input[name] === sha)
  )
}

function tuple(input: readonly string[], count: number) {
  check(
    input.length === count &&
      input.every((value) => /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn),
    "Exact native upgrade identity required",
  )
  return "[" + input.join(",") + "]"
}

function image(input: Image) {
  check(
    Number.isSafeInteger(input.bytes) && input.bytes > 0 && /^[a-f0-9]{64}$/.test(input.sha256),
    "Upgrade image required",
  )
  check(input.identity[2] === String(input.bytes) && input.identity[5] === "1", "Ordinary upgrade image required")
  return (
    '{"path":' +
    JSON.stringify(input.path) +
    ',"bytes":' +
    input.bytes +
    ',"sha256":' +
    JSON.stringify(input.sha256) +
    ',"identity":' +
    tuple(input.identity, 6) +
    "}"
  )
}

function selection(
  plan: ReturnType<typeof object>,
  source: string,
  pins: Readonly<Record<string, string>>,
  supervisor: Image,
  directory: Directory,
  prior: Source,
) {
  check(plan.kind === "memory" || plan.kind === "retrieval", "Paired upgrade plan required")
  check(plan.format === "raya.memory.managed.supervisor" && plan.version === 1, "Original managed plan required")
  check(typeof plan.root === "string" && path.isAbsolute(plan.root), "Original managed root required")
  check(
    path.isAbsolute(source) &&
      directory.path === source &&
      normalize(source).startsWith(normalize(plan.root) + "/") &&
      normalize(prior.path).startsWith(normalize(plan.root) + "/") &&
      normalize(source) !== normalize(prior.path) &&
      !normalize(source).startsWith(normalize(prior.path) + "/") &&
      !normalize(prior.path).startsWith(normalize(source) + "/"),
    "Separate new ordinary source directory required",
  )
  check(same(pins, release), "Exact current Memory release required")
  check(
    same(prior.pins, selected(prior.pins)) &&
      same({ ...prior.pins, "server.py": pins["server.py"], "index.py": pins["index.py"] }, pins),
    "Exact previous capture release required",
  )
  check(
    supervisor.path === path.join(source, "supervise.py") && supervisor.sha256 === current,
    "Known new supervisor required",
  )
  if (plan.kind === "memory")
    check(plan.source === prior.path && same(object(plan.source_sha256), prior.pins), "Original Memory source differs")
}

/** Project only new source images; preserve every unrelated original plan token, including uint64 identities. */
export function project(
  raw: Buffer,
  source: string,
  pins: Readonly<Record<string, string>>,
  replacements: ReadonlyMap<string, Image>,
  supervisor: Image,
  directory: Directory,
  prior: Source,
) {
  const parsed = document(raw, 16777216, 1000000)
  const plan = object(parsed.value)
  selection(plan, source, pins, supervisor, directory, prior)
  const files = child(parsed.tree, "files")
  const directories = child(parsed.tree, "directories")
  check(files.type === "array" && directories.type === "array", "Original dependency inventory required")
  check(replacements.size === Object.keys(pins).length, "Exact replacement inventory required")
  for (const name of Object.keys(pins))
    check(replacements.has(path.join(prior.path, name)), "Original source replacement required")
  const paths = new Set<string>()
  const dirs = (directories.children ?? []).map((node) =>
    object(document(Buffer.from(parsed.text.slice(node.offset, node.offset + node.length))).value),
  )
  check(
    dirs.some((item) => item.path === prior.path),
    "Original source directory missing",
  )
  check(
    !dirs.some((item) => typeof item.path === "string" && normalize(item.path) === normalize(source)),
    "New source directory already declared",
  )
  const found = new Set<string>()
  const changes: { node: { offset: number; length: number }; text: string }[] = (files.children ?? []).flatMap(
    (node) => {
      const item = object(document(Buffer.from(parsed.text.slice(node.offset, node.offset + node.length))).value)
      check(typeof item.path === "string", "Original dependency path required")
      const key = normalize(item.path)
      check(!paths.has(key), "Duplicate original dependency refused")
      paths.add(key)
      check(
        !key.startsWith(normalize(source) + "/") && key !== normalize(source),
        "New source location already declared",
      )
      const selected = replacements.get(item.path)
      if (!selected) return []
      const name = path.basename(item.path)
      check(
        item.sha256 === prior.pins[name] && Number.isSafeInteger(item.bytes) && Number(item.bytes) > 0,
        "Original source image differs",
      )
      const identity = child(node, "identity")
      check(identity.type === "array", "Original source identity required")
      const tokens = (identity.children ?? []).map((entry) =>
        parsed.text.slice(entry.offset, entry.offset + entry.length),
      )
      tuple(tokens, 6)
      check(tokens[2] === String(item.bytes) && tokens[5] === "1", "Ordinary original source required")
      check(selected.path === path.join(source, name) && selected.sha256 === pins[name], "Upgrade source image differs")
      check(!found.has(item.path), "Duplicate upgrade source refused")
      found.add(item.path)
      return [{ node, text: image(selected) }]
    },
  )
  check(
    found.size === replacements.size && found.size === Object.keys(pins).length,
    "Exact upgrade source inventory required",
  )
  const end = { offset: files.offset + files.length - 1, length: 0 }
  changes.push({ node: end, text: (files.children?.length ? "," : "") + image(supervisor) })
  const addition = '{"path":' + JSON.stringify(directory.path) + ',"identity":' + tuple(directory.identity, 3) + "}"
  changes.push({
    node: { offset: directories.offset + directories.length - 1, length: 0 },
    text: (directories.children?.length ? "," : "") + addition,
  })
  if (plan.kind === "memory") {
    changes.push({ node: child(parsed.tree, "source"), text: JSON.stringify(source) })
    changes.push({ node: child(parsed.tree, "source_sha256"), text: JSON.stringify(pins) })
  }
  let result = parsed.text
  for (const item of changes.sort((a, b) => b.node.offset - a.node.offset))
    result = result.slice(0, item.node.offset) + item.text + result.slice(item.node.offset + item.node.length)
  const output = Buffer.from(result)
  document(output, 16777216, 1000000)
  return output
}
