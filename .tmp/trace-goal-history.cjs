const assert = require('node:assert/strict')
const check = assert.ok
assert.ok = (value, message) => {
  if (!value) console.error(new Error('Failed assertion').stack)
  return check(value, message)
}
