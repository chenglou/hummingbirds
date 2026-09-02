import { isIP } from "net"

export type Network = { host: string; port: number; bind: string }

// Advertise a reachable hostname; bind can instead name a local interface or wildcard.
export function networkSettings(address = "127.0.0.1", bind?: string): Network {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(address)
  if (match === null || match[1] === undefined) {
    throw new Error("Address must be a host or host:port (use [IPv6] for IPv6).")
  }
  const advertised = hostname(match[1])
  const port = Number(match[2] ?? 0)
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("Address port must be between 0 and 65535.")
  }
  if (advertised === "0.0.0.0" || advertised === "::") {
    throw new Error("Bird host must be a reachable IP or hostname, not a wildcard.")
  }
  return { host: advertised, port, bind: bind === undefined ? advertised : hostname(bind) }
}

export function hostPort(host: string, port?: number): string {
  const address = isIP(host) === 6 ? `[${host}]` : host
  return port === undefined ? address : `${address}:${port}`
}

export function httpOrigin(host: string, port: number): string {
  return new URL(`http://${hostPort(host, port)}`).origin
}

// Management stays on the bound interface, without relying on the advertised DNS.
export function localOrigin(bird: Network): string {
  const host = bird.bind === "0.0.0.0" ? "127.0.0.1" : bird.bind === "::" ? "::1" : bird.bind
  return httpOrigin(host, bird.port)
}

function hostname(value: string): string {
  if (typeof value !== "string") throw new Error("Bird hosts must be IPs or hostnames, without a port or URL path.")
  const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value
  if (isIP(bare) === 6) return new URL(`http://[${bare}]`).hostname.slice(1, -1)
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value)) {
    throw new Error("Bird hosts must be IPs or hostnames, without a port or URL path.")
  }
  const host = new URL(`http://${value}`).hostname.replace(/\.$/, "")
  if (host === "") throw new Error("Bird hosts must not be empty.")
  return host === "localhost" ? "127.0.0.1" : host
}
