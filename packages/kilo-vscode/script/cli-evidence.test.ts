import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { $ } from "bun"
import { capture, execute, runtime } from "./cli-evidence"

async function fixture(body: string) {
  const root = await mkdtemp(path.join(tmpdir(), "raya-cli-evidence-"))
  const evidence = path.join(root, "evidence")
  await mkdir(evidence)
  await writeFile(path.join(root, ".gitignore"), "evidence/\noutput/\n")
  await writeFile(path.join(root, "entry.ts"), "export const selected = 17\n")
  await writeFile(path.join(root, "child.ts"), body)
  await $`git init -q ${root}`.quiet()
  await $`git -C ${root} add .`.quiet()
  await $`git -C ${root} -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture`.quiet()
  return {
    root,
    cwd: root,
    paths: ["entry.ts", "child.ts", ".gitignore"],
    manager: "bun@" + Bun.version,
    evidence,
    script: path.join(root, "child.ts"),
    args: [],
  }
}

const hook = path.resolve(import.meta.dir, "../../opencode/script/kilocode/build-evidence.ts").replaceAll("\\", "/")

test("original finite Bun.build child records natural exit and both EOFs without claiming family containment", async () => {
  const cfg = await fixture(`import {begin,finish} from ${JSON.stringify(hook)};
const phase=await begin('fixture',{entrypoints:['entry.ts'],compile:false});
const result=await Bun.build({entrypoints:['entry.ts'],outdir:'output',target:'bun'});
await finish(phase,result,process.cwd()+'/output/entry.js');
console.log('original-stdout');console.error('original-stderr');`)
  const before = await capture(cfg.root, cfg.paths)
  const proof = await execute(cfg)
  expect(proof.source).toBe(before.input)
  expect(proof.executionJoined).toBe(true)
  expect(proof.familyJoinsObserved).toBe(false)
  const launch = JSON.parse(await readFile(proof.launch.path, "utf8"))
  const terminal = JSON.parse(await readFile(proof.terminal.path, "utf8"))
  const phase = JSON.parse(await readFile(proof.phase.path, "utf8"))
  expect(launch.pid).toBe(terminal.pid)
  expect(phase.pid).toBe(launch.pid)
  expect(phase.api).toBe("Bun.build")
  expect(phase.recipe.compile).toBe(false)
  expect(phase.compilerProcessExitObserved).toBe(false)
  expect(terminal).toMatchObject({
    code: 0,
    originalJoined: true,
    forced: false,
    jobContainmentObserved: false,
    familyJoinsObserved: false,
    errors: [],
  })
  expect(terminal.stdout).toMatchObject({ eof: true, joined: true, bounded: true })
  expect(terminal.stderr).toMatchObject({ eof: true, joined: true, bounded: true })
  expect(await readFile(terminal.stdout.path, "utf8")).toContain("original-stdout")
  expect(await readFile(terminal.stderr.path, "utf8")).toContain("original-stderr")
  expect(JSON.parse(await readFile(proof.before.path, "utf8"))).toEqual(
    JSON.parse(await readFile(proof.after.path, "utf8")),
  )
  expect(phase.output.bytes).toBeGreaterThan(0)
  expect(launch.argv).toEqual([launch.interpreter.path, cfg.script])
}, 20000)

test("source capture includes tracked changes and untracked inputs without retaining environment values", async () => {
  const cfg = await fixture("console.log('fixture')")
  const before = await capture(cfg.root, cfg.paths)
  await writeFile(path.join(cfg.root, "entry.ts"), "export const selected = 18\n")
  const changed = await capture(cfg.root, cfg.paths)
  expect(changed.input).not.toBe(before.input)
  expect(changed.components.diff).not.toBe(before.components.diff)
  await writeFile(path.join(cfg.root, "extra.ts"), "export const extra = 1\n")
  const extra = await capture(cfg.root, [...cfg.paths, "extra.ts"])
  expect(extra.files.some((file) => file.relative === "extra.ts" && file.status === "present")).toBe(true)
  expect(extra.input).not.toBe(changed.input)
  expect(extra.dependenciesSealed).toBe(false)
  expect(JSON.stringify(extra)).not.toContain(process.env.KILO_MODELS_URL ?? "fixture-secret-that-is-not-in-evidence")
  await expect(runtime("bun@0.0.0")).rejects.toThrow("unavailable")
}, 20000)

test("failed original child retains true exit and EOF receipts but cannot publish qualified completion", async () => {
  const cfg = await fixture("console.log('before-failure');console.error('failed-original');process.exitCode=7")
  await expect(execute(cfg)).rejects.toThrow("did not retire successfully")
  const [name] = await readdir(cfg.evidence)
  const dir = path.join(cfg.evidence, name)
  const terminal = JSON.parse(await readFile(path.join(dir, "terminal.json"), "utf8"))
  expect(terminal).toMatchObject({ code: 7, forced: false, originalJoined: true })
  expect(terminal.stdout.eof).toBe(true)
  expect(terminal.stderr.eof).toBe(true)
  expect(await Bun.file(path.join(dir, "result.json")).exists()).toBe(false)
}, 20000)

test("source mutation during the original child refuses source CAS and preserves its natural exit evidence", async () => {
  const cfg = await fixture("await Bun.write('entry.ts','export const changed=1');console.log('finished');")
  await expect(execute(cfg)).rejects.toThrow("source or interpreter changed")
  const [name] = await readdir(cfg.evidence)
  const dir = path.join(cfg.evidence, name)
  expect(JSON.parse(await readFile(path.join(dir, "terminal.json"), "utf8"))).toMatchObject({
    code: 0,
    originalJoined: true,
    forced: false,
  })
  expect(await Bun.file(path.join(dir, "result.json")).exists()).toBe(false)
}, 20000)

test("an exit-zero launcher without its actual compiler phase cannot qualify", async () => {
  const cfg = await fixture("console.log('not-a-compiler');")
  await expect(execute(cfg)).rejects.toThrow()
  const [name] = await readdir(cfg.evidence)
  const dir = path.join(cfg.evidence, name)
  expect(JSON.parse(await readFile(path.join(dir, "terminal.json"), "utf8"))).toMatchObject({
    code: 0,
    originalJoined: true,
  })
  expect(await Bun.file(path.join(dir, "result.json")).exists()).toBe(false)
}, 20000)

test("original compiler output substitution after its phase refuses qualified completion", async () => {
  const cfg = await fixture(`import {begin,finish} from ${JSON.stringify(hook)};
const phase=await begin('fixture',{compile:false});
const result=await Bun.build({entrypoints:['entry.ts'],outdir:'output',target:'bun'});
await finish(phase,result,process.cwd()+'/output/entry.js');
await Bun.write('output/entry.js','changed after original phase');`)
  await expect(execute(cfg)).rejects.toThrow("output changed")
  const [name] = await readdir(cfg.evidence)
  const dir = path.join(cfg.evidence, name)
  expect(JSON.parse(await readFile(path.join(dir, "terminal.json"), "utf8"))).toMatchObject({
    code: 0,
    originalJoined: true,
    forced: false,
  })
  expect(await Bun.file(path.join(dir, "result.json")).exists()).toBe(false)
}, 20000)

test("retained source publication tampering cannot relabel an actual completed compiler", async () => {
  const cfg = await fixture(`import {begin,finish} from ${JSON.stringify(hook)};
const phase=await begin('fixture',{compile:false});
const result=await Bun.build({entrypoints:['entry.ts'],outdir:'output',target:'bun'});
await finish(phase,result,process.cwd()+'/output/entry.js');
const target=process.env.RAYA_CLI_COMPILER_EVIDENCE+'/source-before.json';
const before=await Bun.file(target).json();before.files=[];await Bun.write(target,JSON.stringify(before));`)
  await expect(execute(cfg)).rejects.toThrow("publication changed")
  const [name] = await readdir(cfg.evidence)
  const dir = path.join(cfg.evidence, name)
  expect(JSON.parse(await readFile(path.join(dir, "terminal.json"), "utf8"))).toMatchObject({
    code: 0,
    originalJoined: true,
    forced: false,
  })
  expect(await Bun.file(path.join(dir, "result.json")).exists()).toBe(false)
}, 20000)
