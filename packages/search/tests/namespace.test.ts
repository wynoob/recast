import { describe, expect, it } from "vitest";
import {
  SearchValidationError,
  assertNamespace,
  createEmbeddingNamespace,
  namespaceFingerprint,
} from "../src/index.js";

describe("embedding namespace", () => {
  const seed = {
    schemaVersion: 1 as const,
    provider: "dmall-test",
    model: "embedding-v1",
    preprocessingVersion: "nfkc-lower-v1",
    dimension: 3,
  };

  it("fingerprint 稳定，并随模型、预处理版本和维度变化", () => {
    const base = namespaceFingerprint(seed);
    expect(base).toMatch(/^[a-f0-9]{64}$/u);
    expect(namespaceFingerprint(seed)).toBe(base);
    expect(namespaceFingerprint({ ...seed, model: "embedding-v2" })).not.toBe(base);
    expect(namespaceFingerprint({ ...seed, preprocessingVersion: "nfkc-lower-v2" })).not.toBe(base);
    expect(namespaceFingerprint({ ...seed, dimension: 4 })).not.toBe(base);
  });

  it("拒绝被篡改的 namespace fingerprint", () => {
    const namespace = createEmbeddingNamespace(seed);
    expect(assertNamespace(namespace)).toEqual(namespace);
    expect(() => assertNamespace({ ...namespace, fingerprint: "0".repeat(64) })).toThrow(
      SearchValidationError,
    );
  });
});
