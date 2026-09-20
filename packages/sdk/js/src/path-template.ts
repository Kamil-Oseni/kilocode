const token = /%7B[^/]+?%7D|\{[^/{}]+\}/i

export function validatePath(request: Request) {
  const match = new URL(request.url).pathname.match(token)
  if (!match) return request

  const name = match[0].replace(/^%7B/i, "{").replace(/%7D$/i, "}")
  throw new TypeError(`Cannot send request with unresolved path parameter ${name}`)
}
