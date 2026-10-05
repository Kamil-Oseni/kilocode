import assert from "node:assert/strict"
import { ComposerDrafts } from "../../src/kilo-provider/composer-drafts"

const ctx = {
  backend: () => undefined,
  scope: async () => {
    throw new Error("Unused backend scope was initialized")
  },
  generation: () => 1,
  owners: () => [],
  post: () => undefined,
  message: async () => undefined,
}
const pane = new ComposerDrafts(ctx)
await pane.handle({ type: "composerDraftPane", active: true, epoch: "pane" })
const close = ComposerDrafts.captureCloseAll()
assert.equal(ComposerDrafts.captureCloseAll(), close)
await close
assert.throws(() => new ComposerDrafts(ctx), /registry is retired/)
await assert.rejects(pane.handle({ type: "composerDraftPane", active: true, epoch: "late" }), /intake is retired/)
pane.dispose()
console.log(JSON.stringify({ passed: true, scope: "Terminal loaded Composer registry only", portable: false }))
