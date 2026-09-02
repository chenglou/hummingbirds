import { expect, test } from "bun:test"
import { httpOrigin, isLoopbackHost, localOrigin, networkSettings } from "../src/network.ts"

test("separates advertised hosts from listening interfaces and local management", () => {
  expect(networkSettings()).toEqual({ host: "127.0.0.1", bind: "127.0.0.1" })
  expect(networkSettings("LOCALHOST")).toEqual({ host: "127.0.0.1", bind: "127.0.0.1" })
  expect(networkSettings("Machine-A.example")).toEqual({ host: "machine-a.example", bind: "machine-a.example" })
  expect(networkSettings("machine-a.example", "0.0.0.0")).toEqual({ host: "machine-a.example", bind: "0.0.0.0" })
  expect(httpOrigin("machine-a.example", 3001)).toBe("http://machine-a.example:3001")
  expect(httpOrigin("192.0.2.7", 80)).toBe("http://192.0.2.7")
  expect(localOrigin({ host: "machine-a.example", bind: "0.0.0.0", port: 3001 })).toBe("http://127.0.0.1:3001")
  expect(localOrigin({ host: "machine-a.example", bind: "192.0.2.7", port: 3001 })).toBe("http://192.0.2.7:3001")
  expect(networkSettings("[2001:db8::7]", "::")).toEqual({ host: "2001:db8::7", bind: "::" })
  expect(httpOrigin("2001:db8::7", 3001)).toBe("http://[2001:db8::7]:3001")
  expect(localOrigin({ host: "2001:db8::7", bind: "::", port: 3001 })).toBe("http://[::1]:3001")
  for (const host of ["127.0.0.1", "127.2.3.4", "LOCALHOST", "localhost.", "[::1]", "::1", "::ffff:127.0.0.1", "::ffff:7f02:0304"]) {
    expect(isLoopbackHost(host)).toBe(true)
  }
  for (const host of ["192.0.2.7", "machine-a", "127.example", "2001:db8::7"]) {
    expect(isLoopbackHost(host)).toBe(false)
  }
  for (const host of ["0.0.0.0", "::", "[::]", "", ".", "[::1", "::1]", "https://bird.example", "bird.example:3001", "bird.example:80", "user@bird.example", "bird.example/ask", " bird.example"]) {
    expect(() => networkSettings(host)).toThrow()
  }
  expect(() => networkSettings("bird.example", "http://localhost")).toThrow()
})
