import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { MemoryRedact } from "../src/capture/redact"

test("large recovery bodies and adversarial assignment keys complete in a bounded actual subprocess", async () => {
  const file = fileURLToPath(new URL("../src/capture/redact.ts", import.meta.url))
  const script = `import { MemoryRedact } from ${JSON.stringify(file)};
    const values = [JSON.stringify({version:2,filler:'x'.repeat(600000)}), 'auth_'.repeat(120000)+'=none', 'auth='+ 'a'.repeat(600000), 'token_'.repeat(100000), 'x'.repeat(600000)+'_secret=short'];
    const start = performance.now();
    const rows = values.map(value=>({has:MemoryRedact.has(value),unchanged:MemoryRedact.text(value)===value}));
    console.log(JSON.stringify({rows,milliseconds:performance.now()-start}));`
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 3000)
  const code = await child.exited
  clearTimeout(timer)
  const output = await new Response(child.stdout).text()
  const errors = await new Response(child.stderr).text()
  assert.equal(code, 0, `Actual redactor subprocess did not complete: ${errors}`)
  expect(JSON.parse(output).rows).toEqual([
    { has: false, unchanged: true },
    { has: false, unchanged: true },
    { has: true, unchanged: false },
    { has: false, unchanged: true },
    { has: true, unchanged: false },
  ])
}, 5000)

test("complete assignment redaction retains prefixes, separators, quotes and low-entropy policy", () => {
  for (const key of [
    "refresh_token",
    "client-secret",
    "prefix.api_key.suffix",
    "prefix_api key_suffix",
    "--password.suffix",
    "api key",
    "private key",
    "access key",
    "passwords",
  ])
    for (const sep of ["=", ": "])
      for (const quote of ["", '"', "'"])
        expect(MemoryRedact.text(`${quote}${key}${quote}${sep}short`)).toBe("[redacted]")
  expect(MemoryRedact.text('x"password"=short')).toBe("x[redacted]")
  for (const value of ["auth_mode=none", "author=somebody", "tokenize=somebody", "authorization: none"])
    expect(MemoryRedact.text(value)).toBe(value)
  for (const value of ['auth="none"', "auth=abc123", "authorization=abcdefghijklmnop"])
    expect(MemoryRedact.text(value)).toBe("[redacted]")
})
