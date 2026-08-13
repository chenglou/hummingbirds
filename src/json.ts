import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export function parseJsonText(text: string, label: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${detail}`);
  }
  return toJsonValue(parsed, label);
}

export function readJson(path: string): JsonValue {
  return parseJsonText(readFileSync(path, "utf8"), path);
}

export function toJsonValue(value: unknown, label = "value"): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toJsonValue(item, `${label}[${index}]`));
  }
  if (typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = toJsonValue(item, `${label}.${key}`);
    }
    return output;
  }
  throw new Error(`${label} contains a non-JSON value`);
}

export function expectObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

export function expectArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

export function expectString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function expectInteger(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

export function expectBoolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

export function canonicalStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const fields = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key] ?? null)}`);
  return `{${fields.join(",")}}`;
}

export function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
