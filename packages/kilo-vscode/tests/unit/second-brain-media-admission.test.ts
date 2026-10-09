import { expect, test } from "bun:test"
import path from "node:path"
import { exec } from "../../src/util/process"

const native = process.platform === "win32" ? test : test.skip

native(
  "actual media cold admission uses total free RAM of 6 GiB and unchanged free commit of 5 GiB",
  async () => {
    const result = await exec(
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        String.raw`
import sys
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
from worker import admission, capacity
G = 1073741824
def row(free, available, physical=16*G, commit=32*G):
    return SimpleNamespace(free=free, available=available, physical=physical, commit=commit)
for free in (6*G, 6*G+1, 7*G, 10*G):
    assert capacity(row(free, 5*G)) == dict(free=free, available=5*G)
for value in (row(6*G-1, 5*G), row(6*G, 5*G-1), row(10*G, 5*G-1)):
    try:
        capacity(value)
    except ValueError as error:
        assert str(error) == 'Cold media inference requires 6 GiB free RAM and 5 GiB free commit.'
    else:
        raise AssertionError('Insufficient original free totals accepted')
for value in (row(17*G, 5*G), row(6*G, 33*G)):
    try:
        capacity(value)
    except ValueError as error:
        assert str(error) == 'Native media resource observation inconsistent.'
    else:
        raise AssertionError('Inconsistent native observation accepted')
assert admission.__globals__['capacity'] is capacity
assert 'torch' not in sys.modules and 'PIL' not in sys.modules and 'encoder' not in sys.modules
print('11 actual cold-policy assertions passed; no inference or decoder imports.')
`,
        path.resolve(import.meta.dir, "../../script/memory/media"),
      ],
      { timeout: 10000, maxBuffer: 4096 },
    )
    expect(result.stderr).toBe("")
    expect(result.stdout.trim()).toBe("11 actual cold-policy assertions passed; no inference or decoder imports.")
  },
  15000,
)
