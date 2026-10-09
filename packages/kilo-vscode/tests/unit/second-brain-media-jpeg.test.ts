import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { z } from "zod"
import { jpeg } from "./fixtures/media-jpeg"
import { run, type Launch, type Request } from "../../src/second-brain/media/transport"
import { document, object, sha } from "../../src/second-brain/control/frames"
import { fingerprint } from "../../src/second-brain/failed-repair"

const native = process.platform === "win32" ? test : test.skip
const id = () => randomUUID().replaceAll("-", "")

native(
  "actual contained JPEG decode/import/forget preserves canonical bytes without indexing or models",
  async () => {
    const f = await jpeg()
    try {
      const selection: Request["selection"] = {
        format: "raya.media.selection.v1",
        project: f.project,
        source: f.source,
        root: f.root,
        excluded: [],
        files: [
          { path: f.file, sha256: sha(f.bytes), bytes: f.bytes.length, kind: "image", title: "Actual JPEG fixture" },
        ],
      }
      const cfg: Launch = {
        format: "raya.media.launch.v1",
        root: f.root,
        dependencies: f.deps,
        python: f.cfg.python,
        sources: {
          "supervisor.py": f.sources["supervisor.py"],
          "worker.py": f.sources["worker.py"],
          "session.py": f.sources["session.py"],
          "library.py": f.sources["library.py"],
          "encoder.py": f.sources["encoder.py"],
          "owner.py": f.sources["owner.py"],
        },
      }
      expect(f.witness.files).toHaveLength(122)
      expect(f.created.receipt).toMatchObject({ code: 0, originalJoined: true, readersJoined: true, forced: false })
      for (const op of ["inspect", "import", "forget"] as const) {
        const input: Request = {
          format: "raya.media.operation.v1",
          request: id(),
          epoch: id(),
          release: f.release,
          policySHA: fingerprint(selection),
          op,
          selection,
          args: { id: sha(f.bytes) },
          model: null,
        }
        const bound: unknown[] = []
        const result = await run(
          path.resolve(import.meta.dir, "../.."),
          cfg,
          input,
          new AbortController().signal,
          f.authorize,
          async (value) => {
            bound.push(value)
          },
        )
        expect(bound).toHaveLength(1)
        expect(result.terminal).toMatchObject({
          accepted: true,
          status: "completed",
          authority: false,
          replay: false,
          forced: false,
          release: input.release,
          policySHA: input.policySHA,
        })
        expect(result.terminal.ownership).toMatchObject({
          job_active: 0,
          root_exit: 0,
          membership_observed: true,
          joins_observed: true,
          writer_joined: true,
          ownership_retained: false,
        })
        const value = object(result.terminal.result)
        expect(value.decoded).toMatchObject({
          kind: "image",
          sha256: sha(f.bytes),
          bytes: f.bytes.length,
          width: 3,
          height: 2,
          segments: [],
        })
        expect(value.origin).toBe(f.file)
        expect(value.sourceSHA).toBe(sha(f.bytes))
        const receipt = object(document(await readFile(result.receipt.path)).value)
        expect(receipt).toMatchObject({
          originalJoined: true,
          readersJoined: true,
          writerJoined: true,
          familyJoined: true,
          forced: false,
          requestSettlement: false,
          replay: false,
        })
        expect(receipt.eof).toEqual({ stdout: true, stderr: true })
        const refs = z
          .array(z.object({ path: z.string(), sha256: z.string() }).passthrough())
          .length(2)
          .parse(receipt.evidence)
        for (const ref of refs) expect(sha(await readFile(ref.path))).toBe(ref.sha256)
        const target = path.join(f.root, "Assets", sha(f.bytes) + ".jpg")
        if (op === "import") {
          expect(value).toMatchObject({
            imported: true,
            indexed: false,
            snapshot: { path: target, sha256: sha(f.bytes), bytes: f.bytes.length },
          })
          expect(await readFile(target)).toEqual(f.bytes)
          const files = await readdir(f.root)
          const name = files.find((file) => file.startsWith("gemma2-") && file.endsWith(".sqlite"))
          expect(name).toBeDefined()
          const db = new Database(path.join(f.root, name!), { readonly: true })
          try {
            expect(db.query("SELECT COUNT(*) AS count FROM items WHERE vector IS NOT NULL").get()).toEqual({ count: 0 })
            expect(db.query("SELECT COUNT(*) AS count FROM segments").get()).toEqual({ count: 0 })
          } finally {
            db.close()
          }
        }
        if (op === "forget") {
          expect(value.forgotten).toBe(true)
          expect(await readdir(path.join(f.root, "Assets"))).not.toContain(path.basename(target))
        }
        expect(await readFile(f.file)).toEqual(f.bytes)
      }
      await f.authorize()
    } finally {
      await f.owned.cleanup()
    }
  },
  45000,
)
