import assert from "node:assert/strict"
import path from "node:path"
import { Daemon } from "../../../src/kilocode/daemon/daemon"
import * as Windows from "../../../src/kilocode/background-process/windows-tree"

const root = process.env.RAYA_DAEMON_TEST_ROOT
if (!root) throw new Error("Missing private daemon fixture")
const mode = process.argv[2]
const owned: Daemon.State[] = []
const evidence: unknown[] = []
const input: Daemon.Options = {
  hostname: "127.0.0.1",
  port: 0,
  mdns: false,
  mdnsDomain: "kilo.local",
  cors: [],
  command: [
    process.execPath,
    "--conditions=browser",
    path.resolve(
      mode?.startsWith("receipt-")
        ? "test/kilocode/fixtures/daemon-receipt-child.ts"
        : mode === "capture-background" || mode === "handoff-background"
          ? "test/kilocode/fixtures/daemon-background-child.ts"
          : mode === "held" || mode === "failed"
            ? "test/kilocode/fixtures/daemon-native-child.ts"
            : "src/index.ts",
    ),
  ],
  env: { ...process.env, KILO_TEST_DAEMON_EPHEMERAL_PORT: "1", RAYA_DAEMON_CHILD_CASE: mode },
  timeout: 30000,
}
const state = { passed: false, forced: false }
try {
  const first = await Daemon.start(input)
  assert.ok(first.running && first.started && first.state?.owner)
  owned.push(first.state)
  const reused = await Daemon.ensure(input, [])
  assert.equal(reused.result.reused, true)
  assert.equal(reused.result.state?.pid, first.state.pid)
  if (mode?.startsWith("receipt-")) {
    await assert.rejects(Daemon.stop(first.state))
    assert.equal((await Windows.sample(first.state.pid)).status, "gone")
    assert.match((await Daemon.read())?.uncertain ?? "", /not confirmed/)
    const receipt = await Bun.file(first.state.owner.receipt).json()
    assert.equal(receipt.success, true)
    assert.equal(receipt.portableCaptureAuthorized, false)
    evidence.push(receipt)
    await assert.rejects(Daemon.quiesce(), /controller work could not be confirmed/)
  }
  if (mode === "handoff-background") {
    const stopped = await Daemon.stop(first.state)
    assert.equal(stopped.retirement?.exit.code, 0)
    const supervisor = Number(await Bun.file(path.join(root, "background-supervisor-pid")).text())
    const command = Number(await Bun.file(path.join(root, "background-command-pid")).text())
    assert.equal((await Windows.sample(supervisor)).status, "owned")
    assert.equal((await Windows.sample(command)).status, "owned")
    assert.equal(await Bun.file(path.join(root, "background-entered")).exists(), false)
    await Bun.write(path.join(root, "background-release"), "release")
    const deadline = Date.now() + 20000
    while ((await Windows.sample(supervisor)).status !== "gone") {
      if (Date.now() >= deadline) throw new Error("Ordinary handed-off supervisor did not exit after fixture release")
      await Bun.sleep(50)
    }
    assert.equal((await Windows.sample(command)).status, "gone")
    evidence.push({ ordinaryPersistentHandoff: true, supervisor, command, absent: true })
    await Daemon.quiesce()
  }
  if (mode === "capture" || mode === "capture-background") {
    const closing = Daemon.closeForCapture()
    assert.equal(Daemon.closeForCapture(), closing)
    const database = first.state.owner.roots.database
    if (mode === "capture-background") {
      const deadline = Date.now() + 20000
      while (!(await Bun.file(path.join(root, "background-entered")).exists())) {
        if (Date.now() >= deadline) throw new Error("Background capture cleanup never entered")
        await Bun.sleep(20)
      }
      let settled = false
      void closing.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      try {
        await Bun.sleep(150)
        assert.equal(settled, false)
        assert.equal(await Bun.file(first.state.owner.receipt).exists(), false)
        assert.equal(await Bun.file(path.join(root, "background-closed")).exists(), false)
      } finally {
        await Bun.write(path.join(root, "background-release"), "release")
      }
    }
    const receipt = await closing
    assert.equal(receipt.receipts.length, 1)
    assert.equal(receipt.receipts[0]?.exit.code, 0)
    assert.ok(receipt.roots.some((row) => row.kind === "sqlite" && row.path === database))
    assert.equal(receipt.completeProfileCoverage, false)
    assert.equal(receipt.portableCaptureAuthorized, false)
    if (mode === "capture-background") {
      assert.equal(
        await Bun.file(path.join(root, "background-native.log")).text(),
        "RAYA_DAEMON_BACKGROUND_FINAL_MARKER\n",
      )
      for (const file of ["background-command-pid", "background-supervisor-pid"]) {
        const pid: number = Number(await Bun.file(path.join(root, file)).text())
        assert.equal((await Windows.sample(pid)).status, "gone")
      }
    }
    await assert.rejects(Daemon.start(input), /admission is closed/)
    evidence.push(receipt)
  }
  if (mode === "clean") {
    const second = await Daemon.restart(input)
    assert.ok(second.running && second.state?.owner)
    owned.push(second.state)
    assert.notEqual(second.state.owner.generation, first.state.owner.generation)
    const old = await Bun.file(first.state.owner.receipt).json()
    assert.equal(old.success, true)
    assert.equal(old.birth, first.state.owner.birth)
    assert.equal(old.generation, first.state.owner.generation)
    assert.equal((await Daemon.stop(first.state)).stopped, false)
    const stopped = await Daemon.stop(second.state)
    assert.ok(stopped.stopped && stopped.retirement)
    assert.equal(stopped.retirement.exit.code, 0)
    assert.equal(stopped.retirement.forced, false)
    assert.equal(stopped.retirement.success, true)
    assert.equal(stopped.retirement.portableCaptureAuthorized, false)
    evidence.push(stopped.retirement)
    assert.equal((await Daemon.status()).running, false)
    await Daemon.quiesce()
    await assert.rejects(Daemon.start(input), /admission is closed/)
  }
  if (mode === "foreign") {
    const before = await Bun.file(Daemon.file()).text()
    const changed = {
      ...first.state,
      owner: { ...first.state.owner, birth: (BigInt(first.state.owner.birth) + 1n).toString() },
    }
    await Bun.write(Daemon.file(), JSON.stringify(changed))
    const preserved = await Bun.file(Daemon.file()).text()
    await assert.rejects(Daemon.stop(), /ownership changed/)
    assert.equal(await Bun.file(Daemon.file()).text(), preserved)
    assert.equal((await Windows.sample(first.state.pid)).birth, first.state.owner.birth)
    await Bun.write(Daemon.file(), before)
    const stopped = await Daemon.stop(first.state)
    assert.equal(stopped.retirement?.exit.code, 0)
    evidence.push(stopped.retirement)
    await assert.rejects(Daemon.quiesce(), /controller work could not be confirmed/)
  }
  if (mode === "held" || mode === "failed") {
    const stopped = Daemon.stop(first.state)
    const outcome = stopped.then(
      (value) => value,
      (err: unknown) => err,
    )
    const deadline = performance.now() + 20000
    while (!(await Bun.file(path.join(root, "native-finalizer-entered")).exists())) {
      if (performance.now() > deadline) throw new Error("Actual native finalizer did not enter")
      await Bun.sleep(25)
    }
    if (mode === "held") {
      const settled = { value: false }
      void outcome.then(() => {
        settled.value = true
      })
      try {
        await Bun.sleep(100)
        assert.equal(settled.value, false)
        assert.equal(await Bun.file(first.state.owner.receipt).exists(), false)
        assert.equal(await Bun.file(path.join(root, "native-finalizer-closed")).exists(), false)
      } finally {
        await Bun.write(path.join(root, "native-finalizer-release"), "release")
      }
      await outcome
      const result = await stopped
      assert.ok(result && typeof result === "object" && "retirement" in result && result.retirement)
      assert.equal(result.retirement.exit.code, 0)
      assert.equal(await Bun.file(path.join(root, "native-finalizer-closed")).text(), "closed")
      assert.equal(await Bun.file(path.join(root, "native-finalizer.log")).text(), "RAYA_DAEMON_NATIVE_FINAL_MARKER\n")
      evidence.push(result.retirement)
      await Daemon.quiesce()
    }
    if (mode === "failed") {
      assert.ok((await outcome) instanceof Error)
      const receipt = await Bun.file(first.state.owner.receipt).json()
      assert.equal(receipt.success, false)
      assert.match((await Daemon.read())?.uncertain ?? "", /not confirmed/)
      await assert.rejects(Daemon.quiesce(), /controller work could not be confirmed/)
      evidence.push(receipt)
    }
  }
  state.passed = true
} finally {
  const processes = []
  for (const child of owned) {
    const current = await Windows.sample(child.pid)
    if (current.status === "owned" && current.birth === child.owner?.birth) {
      state.forced = true
      await Windows.terminate(child.pid, child.owner.birth)
    }
    const after = await Windows.sample(child.pid)
    processes.push({
      pid: child.pid,
      birth: child.owner?.birth,
      absent: after.status === "gone" || after.birth !== child.owner?.birth,
    })
  }
  await Bun.write(
    path.join(root, "receipt.json"),
    JSON.stringify({ ...state, mode, evidence, processes, profile: root, portableCaptureAuthorized: false }),
  )
  assert.equal(state.forced, false, "Fixture required forced cleanup; retained evidence excludes acceptance")
}
