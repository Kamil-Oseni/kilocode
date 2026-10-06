import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryFiles } from "../src/storage/store"

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "raya-dream-input-"))
  const root = path.join(base, "memory")
  const project = path.join(base, "project")
  await mkdir(root)
  await mkdir(project)
  const text = "Approved synthetic project preference: concise replies."
  await writeFile(path.join(project, "approved.md"), text)
  const input = {
    scope: "971da465-70aa-4e29-baad-272aaf840354",
    sources: [{ path: "approved.md", sha256: hash(text), kind: "approved-summary" as const }],
    targets: [{ key: "reply.style", path: "Preferences/replies.md", expected: null }],
    budget: 3000,
  }
  const output = JSON.stringify({
    items: [
      {
        key: "reply.style",
        sources: ["approved.md"],
        content: "Prefer concise replies.",
        rationale: "Explicit approved preference.",
        contradictions: [],
      },
    ],
  })
  return { base, root, project, input, output }
}

test("approved input assembles bounded evidence and assigns stable owner-defined fact IDs", async () => {
  const f = await fixture()
  const plan = await MemoryFiles.dreamInput.prepare(f.root, f.project, f.input)
  expect(JSON.parse(plan.prompt).evidence[0].text).toContain("concise replies")
  const [candidate] = await plan.decode(f.output)
  expect(candidate.fact).toBe(hash(`${f.input.scope}\0reply.style`))
  await plan.validate(candidate)
  f.input.targets[0].path = "Preferences/moved.md"
  const moved = await MemoryFiles.dreamInput.prepare(f.root, f.project, f.input)
  expect((await moved.decode(f.output))[0].fact).toBe(candidate.fact)
  expect(await MemoryFiles.exists(path.join(f.root, "Preferences"))).toBe(false)
})

test("source revision and target baseline changes require renewed selection", async () => {
  const f = await fixture()
  const plan = await MemoryFiles.dreamInput.prepare(f.root, f.project, f.input)
  const [candidate] = await plan.decode(f.output)
  await mkdir(path.join(f.root, "Preferences"))
  await writeFile(path.join(f.root, "Preferences/replies.md"), "Unexpected note")
  await expect(plan.validate(candidate)).rejects.toThrow("baseline changed")
  await writeFile(path.join(f.project, "approved.md"), "Changed evidence")
  await expect(plan.validate(candidate)).rejects.toThrow("not approved")
})

test("generated links resolve only to selected note revisions and ignore code examples", async () => {
  const f = await fixture()
  const text = "# Eden\nApproved synthetic project note."
  await mkdir(path.join(f.root, "Projects"))
  await writeFile(path.join(f.root, "Projects/Eden.md"), text)
  const plan = await MemoryFiles.dreamInput.prepare(f.root, f.project, {
    ...f.input,
    targets: [...f.input.targets, { key: "eden", path: "Projects/Eden.md", expected: hash(text) }],
  })
  const [candidate] = await plan.decode(f.output)
  const revise = (content: string) => ({ ...candidate, changes: [{ ...candidate.changes[0], content }] })
  await plan.validate(revise("[Eden](../Projects/Eden.md) and [self](#preferences)."))
  await plan.validate(revise("[Eden][project]\n\n[project]: ../Projects/Eden.md"))
  await plan.validate(revise("`[example](https://example.com)`\n\n```md\n[example](../../Private/secret.md)\n```"))
  for (const content of [
    "[external](https://example.com)",
    "![external](https://example.com/image.png)",
    "[foreign](../../project/approved.md)",
    "[missing](missing.md)",
    "[private](../Private/secret.md)",
    "[encoded](%2e%2e/%2e%2e/secret.md)",
    "[double](%252e%252e/secret.md)",
    "[absolute](C:/secret.md)",
    "[network](//host/share.md)",
    '<a href="../Projects/Eden.md">HTML</a>',
    "[reference][bad]\n\n[bad]: https://example.com",
    "[file](../Projects/Eden.md?read=1)",
  ]) {
    await expect(plan.validate(revise(content))).rejects.toThrow()
  }
  await writeFile(path.join(f.root, "Projects/Eden.md"), "Changed after approval")
  await expect(plan.validate(revise("[Eden](../Projects/Eden.md)"))).rejects.toThrow("not approved")
})

test("unapproved keys, citations, extra authority and empty evidence are refused", async () => {
  const f = await fixture()
  const plan = await MemoryFiles.dreamInput.prepare(f.root, f.project, f.input)
  for (const patch of [{ key: "other.key" }, { sources: ["foreign.md"] }, { fact: "a".repeat(64) }, { sources: [] }]) {
    const value = JSON.parse(f.output)
    Object.assign(value.items[0], patch)
    await expect(plan.decode(JSON.stringify(value))).rejects.toThrow()
  }
  const [candidate] = await plan.decode(f.output)
  plan.sources[0].sha256 = "b".repeat(64)
  expect((await plan.decode(f.output))[0].sources).toEqual(candidate.sources)
})

test("secrets, excessive input, unsupported source types and root escapes never become a prompt", async () => {
  const f = await fixture()
  await expect(MemoryFiles.dreamInput.prepare(f.root, f.project, { ...f.input, budget: 10 })).rejects.toThrow(
    "input budget",
  )
  for (const name of ["../foreign.md", "Private/note.md", "C:/foreign.md"]) {
    await expect(
      MemoryFiles.dreamInput.prepare(f.root, f.project, {
        ...f.input,
        sources: [{ ...f.input.sources[0], path: name }],
      }),
    ).rejects.toThrow()
  }
  await writeFile(path.join(f.project, "approved.md"), "password=hunterx")
  await expect(
    MemoryFiles.dreamInput.prepare(f.root, f.project, {
      ...f.input,
      sources: [{ ...f.input.sources[0], sha256: hash("password=hunterx") }],
    }),
  ).rejects.toThrow("secret")
})

test("linked sources and junction ancestry are refused with actual filesystem entries", async () => {
  const f = await fixture()
  await link(path.join(f.project, "approved.md"), path.join(f.project, "linked.md"))
  await expect(MemoryFiles.dreamInput.prepare(f.root, f.project, f.input)).rejects.toThrow("linked")
  const clean = await fixture()
  const alias = path.join(clean.base, "alias")
  await symlink(clean.project, alias, process.platform === "win32" ? "junction" : "dir")
  await expect(MemoryFiles.dreamInput.prepare(clean.root, alias, clean.input)).rejects.toThrow("ordinary directory")
})

test("invalid UTF-8 and oversized files are refused before generation", async () => {
  const f = await fixture()
  for (const raw of [Buffer.from([0xff, 0xfe]), Buffer.alloc(256001, 65)]) {
    await writeFile(path.join(f.project, "approved.md"), raw)
    await expect(
      MemoryFiles.dreamInput.prepare(f.root, f.project, {
        ...f.input,
        sources: [{ ...f.input.sources[0], sha256: hash(await readFile(path.join(f.project, "approved.md"))) }],
      }),
    ).rejects.toThrow()
  }
})

test("cancelled preparation and later validation do not continue reading", async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort(new Error("User cancelled"))
  await expect(MemoryFiles.dreamInput.prepare(f.root, f.project, f.input, controller.signal)).rejects.toThrow(
    "User cancelled",
  )
  const plan = await MemoryFiles.dreamInput.prepare(f.root, f.project, f.input)
  const [candidate] = await plan.decode(f.output)
  await expect(plan.validate(candidate, controller.signal)).rejects.toThrow("User cancelled")
})
