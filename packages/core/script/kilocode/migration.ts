export function statement(sql: string, rendered: string) {
  const owned = /^CREATE\s+(?:TABLE\s+[`"]?raya_\w+|(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+[`"]?raya_\w+)/i.test(sql)
  return owned ? `      // kilocode_change start\n${rendered}\n      // kilocode_change end` : rendered
}

export function entry(name: string, rendered: string) {
  return name.includes("kilocode") ? `${rendered} // kilocode_change` : rendered
}
