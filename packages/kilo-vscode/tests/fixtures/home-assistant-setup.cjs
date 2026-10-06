const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")

const root = process.argv[3]
const scenario = process.argv[4]
const token = "synthetic-native-only-token"
const prompts = []
const messages = []
const values = new Map()
const secrets = new Map()
let handler
let finish
let entered
let removed = false
const ready = new Promise((resolve) => {
  entered = resolve
})
const gate = new Promise((resolve) => {
  finish = resolve
})
global.fetch = () => {
  throw new Error("Setup must not contact a service")
}
const native = {
  commands: {
    registerCommand(name, callback) {
      assert.ok(["raya.setupHomeAssistant", "kilo-code.new.setupHomeAssistant"].includes(name))
      if (name === "raya.setupHomeAssistant") handler = callback
      if (name === "kilo-code.new.setupHomeAssistant") assert.equal(callback, handler)
      return {
        dispose() {
          removed = true
        },
      }
    },
  },
  window: {
    async showInputBox(opts) {
      prompts.push(opts)
      if (prompts.length === 1) return "http://192.168.100.160"
      if (prompts.length === 2) return "light.bedroom_left,light.bedroom_right"
      assert.equal(opts.password, true)
      if (scenario === "closed-input") {
        entered()
        await gate
      }
      return token
    },
    async showQuickPick(items) {
      assert.equal(items.length, 16)
      assert.equal(items.filter((item) => item.mode.entity.startsWith("script.")).length, 3)
      assert.deepEqual(items.find((item) => item.mode.name === "sleep_mode").mode, {
        name: "sleep_mode",
        entity: "script.sleep_mode_fade",
        stop: true,
      })
      return items
    },
    async showInformationMessage(text) {
      messages.push(text)
    },
    async showErrorMessage(text) {
      messages.push(text)
    },
  },
}
const load = Module._load
Module._load = function (name, ...args) {
  return name === "vscode" ? native : load.call(this, name, ...args)
}
const { register } = require(process.argv[2])
const context = {
  subscriptions: [],
  globalState: {
    get(key) {
      return values.get(key)
    },
    async update(key, value) {
      if (scenario === "held-store") {
        entered()
        await gate
      }
      fs.writeFileSync(path.join(root, "public.json"), JSON.stringify(value))
      values.set(key, value)
    },
  },
  secrets: {
    async get(key) {
      return secrets.get(key)
    },
    async store(key, value) {
      secrets.set(key, value)
    },
    async delete(key) {
      secrets.delete(key)
    },
  },
}
async function run() {
  const owner = register(context)
  const job = handler()
  if (scenario !== "normal") {
    await ready
    assert.equal(handler(), undefined, "Concurrent setup must be refused")
    let closed = false
    const closing = owner.dispose().then(() => {
      closed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closed, false, "Disposal must join original native/store promise")
    assert.equal(handler(), undefined, "Closed generation must refuse intake")
    finish()
    await Promise.all([job, closing])
  } else {
    await job
    await owner.dispose()
  }
  assert.equal(removed, true)
  assert.equal(prompts.filter((value) => value.password === true).length, 1)
  assert.equal(JSON.stringify(messages).includes(token), false)
  assert.equal(JSON.stringify(prompts).includes(token), false)
  const saved = values.get("raya.homeAssistant.settings")
  if (scenario === "closed-input") {
    assert.equal(saved, undefined)
    assert.equal(secrets.size, 0)
  } else {
    assert.equal(JSON.stringify(saved).includes(token), false)
    assert.equal(saved.config.modes.length, 16)
    assert.equal(secrets.get(saved.credential), token)
    assert.equal(fs.readFileSync(path.join(root, "public.json"), "utf8").includes(token), false)
  }
  process.stdout.write(JSON.stringify({ passed: true, scenario, masked: true, serviceCalls: 0 }) + "\n")
}
run().catch(() => {
  process.stderr.write("Native setup fixture failed\n")
  process.exitCode = 1
})
