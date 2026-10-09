import { expect } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, mkdir, writeFile, rm, copyFile, cp } from "node:fs/promises"
import { descriptor } from "../../../src/second-brain/managed/descriptor"
import { interpreter, current } from "../../../src/second-brain/managed/catalog"
import { catalogs, images, fingerprint } from "../../../src/second-brain/managed/reuse-catalog"
import { sha } from "../../../src/second-brain/control/frames"
import { powershell } from "../../../src/second-brain/control/identity"
import { exec } from "../../../src/util/process"
import { space } from "../../../src/second-brain/managed/generation"

async function owner() {
  const who = await exec(
    powershell(),
    ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
    { timeout: 10000, maxBuffer: 4096 },
  )
  return who.stdout.trim()
}

export async function fixture(opts: { contained?: boolean } = {}) {
  const outer = await mkdtemp(path.join(tmpdir(), "raya-media-provision-"))
  const root = opts.contained ? path.join(outer, "contained") : outer
  if (opts.contained) await space(root, await owner())
  const deps = path.join(root, "deps")
  await mkdir(path.join(deps, "__pycache__"), { recursive: true })
  const pyc = path.join(deps, "__pycache__", "selected.cpython-312.pyc")
  await writeFile(pyc, "owned dependency bytes")
  const files = [
    { path: path.join(root, "python.exe"), bytes: 107312, sha256: interpreter },
    { path: pyc, bytes: 22, sha256: sha("owned dependency bytes"), identity: [18446744073709551615, 1, 1] },
    ...Object.entries(images).map(([name, sha256]) => ({ path: path.join(root, "source", name), bytes: 1, sha256 })),
    ...Object.entries(catalogs).map(([name, sha256]) => ({
      path: path.join(root, "catalog", name),
      bytes: 4507,
      sha256,
    })),
  ]
  const plan = {
    format: "raya.memory.managed.supervisor",
    version: 1,
    kind: "retrieval",
    execution_admitted: true,
    root,
    python_sha256: interpreter,
    source: path.join(root, "source"),
    source_sha256: images,
    dependencies: deps,
    files,
    env: { RAYA_RETRIEVAL_RELEASE_SHA256: fingerprint },
    retrieval_protocol: "raya.retrieval.request.settlement.v2",
  }
  const spaces = {
    root,
    sid: "S-1-5-21-1-2-3-4",
    generations: { root: ["1", "2", "3"], Runs: ["1", "2", "4"], Requests: ["1", "2", "5"] },
  }
  const binding = (value = plan) => {
    const raw = Buffer.from(JSON.stringify(value))
    const cfg = descriptor({
      format: "raya.memory.managed.launch",
      version: 2,
      root,
      python: files[0],
      supervisor: { path: path.join(root, "supervise.py"), bytes: 1, sha256: current },
      plan: { path: path.join(root, "memory.json"), bytes: 1, sha256: "a".repeat(64) },
      retrieval: { path: path.join(root, "retrieval.json"), bytes: raw.length, sha256: sha(raw) },
      namespaces: { memory: spaces, retrieval: spaces },
    })
    return { cfg, raw }
  }
  const cleanup = async () => {
    expect(path.dirname(outer)).toBe(path.resolve(tmpdir()))
    expect(path.basename(outer).startsWith("raya-media-provision-")).toBe(true)
    await rm(outer, { recursive: true })
  }
  const selected = async () => {
    await mkdir(path.join(root, "catalog"))
    await copyFile(
      "D:/Raya/Models/Catalog/google--embeddinggemma-2.json",
      path.join(root, "catalog", "google--embeddinggemma-2.json"),
    )
    await copyFile(
      "D:/Raya/Services/Memory/Managed/raya-memory-managed-45b36f49c36b4a9d880266dffe59d43c/python/python.exe",
      path.join(root, "python.exe"),
    )
    if (opts.contained) {
      // Same owned stdlib bootstrap recipe as native-memory-runtime; excludes all installed packages.
      const base = "D:/Raya/Services/Packaging/Python/3.12.14"
      await Promise.all(
        ["python3.dll", "python312.dll", "vcruntime140.dll", "vcruntime140_1.dll"].map((name) =>
          copyFile(path.join(base, name), path.join(root, name)),
        ),
      )
      await Promise.all(
        ["Lib", "DLLs"].map((name) =>
          cp(path.join(base, name), path.join(root, name), {
            recursive: true,
            filter: (file) => !file.includes("site-packages") && !file.includes("__pycache__"),
          }),
        ),
      )
    }
    const sid = await owner()
    const original = binding()
    const cfg = descriptor({
      ...original.cfg,
      namespaces: {
        memory: { ...original.cfg.namespaces.memory, sid },
        retrieval: { ...original.cfg.namespaces.retrieval, sid },
      },
    })
    await writeFile(cfg.retrieval!.path, original.raw)
    return cfg
  }
  return { root, deps, pyc, plan, binding, selected, cleanup }
}
