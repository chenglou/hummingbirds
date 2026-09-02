import { expect, test } from "bun:test"
import { hostPort, httpOrigin, localOrigin, networkSettings } from "../src/network.ts"

test("separates advertised hosts from listening interfaces and local management", () => {
  expect(networkSettings()).toEqual({ host: "127.0.0.1", port: 0, bind: "127.0.0.1" })
  expect(networkSettings("127.0.0.1")).toEqual({ host: "127.0.0.1", port: 0, bind: "127.0.0.1" })
  expect(networkSettings("LOCALHOST")).toEqual({ host: "127.0.0.1", port: 0, bind: "127.0.0.1" })
  expect(networkSettings("Machine-A.example", "0.0.0.0")).toEqual({ host: "machine-a.example", port: 0, bind: "0.0.0.0" })
  expect(networkSettings("LOCALHOST:3001")).toEqual({ host: "127.0.0.1", port: 3001, bind: "127.0.0.1" })
  expect(networkSettings("Machine-A.example:80")).toEqual({ host: "machine-a.example", port: 80, bind: "machine-a.example" })
  expect(networkSettings("machine-a.example:0", "0.0.0.0")).toEqual({ host: "machine-a.example", port: 0, bind: "0.0.0.0" })
  expect(httpOrigin("machine-a.example", 3001)).toBe("http://machine-a.example:3001")
  expect(httpOrigin("192.0.2.7", 80)).toBe("http://192.0.2.7")
  expect(localOrigin({ host: "machine-a.example", bind: "0.0.0.0", port: 3001 })).toBe("http://127.0.0.1:3001")
  expect(localOrigin({ host: "machine-a.example", bind: "192.0.2.7", port: 3001 })).toBe("http://192.0.2.7:3001")
  expect(networkSettings("[2001:db8::7]", "::")).toEqual({ host: "2001:db8::7", port: 0, bind: "::" })
  expect(networkSettings("[2001:db8::7]:3001", "::")).toEqual({ host: "2001:db8::7", port: 3001, bind: "::" })
  expect(hostPort("machine-a.example")).toBe("machine-a.example")
  expect(hostPort("2001:db8::7")).toBe("[2001:db8::7]")
  expect(hostPort("2001:db8::7", 0)).toBe("[2001:db8::7]:0")
  expect(httpOrigin("2001:db8::7", 3001)).toBe("http://[2001:db8::7]:3001")
  expect(localOrigin({ host: "2001:db8::7", bind: "::", port: 3001 })).toBe("http://[::1]:3001")
  for (const address of ["0.0.0.0", "[::]", "0.0.0.0:3001", "[::]:3001", "", ".:3001", "--help:3001", "-bird.example:3001", "[::1", "2001:db8::7", "[::1]:", "[::1:3001", "::1]:3001", "http://bird.example", "http://bird.example:3001", "https://bird.example:3001", "bird.example:", "bird.example:-1", "bird.example:1.5", "bird.example:65536", "bird.example:9007199254740993", "user@bird.example", "user@bird.example:3001", "bird.example/messages", "bird.example:3001/messages", "bird.example:3001?x=1", "bird.example:3001#fragment", " bird.example", " bird.example:3001"]) {
    expect(() => networkSettings(address)).toThrow()
  }
  expect(() => networkSettings("bird.example:3001", "http://localhost")).toThrow()
})
