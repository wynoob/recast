import { createHash } from "node:crypto";
import { SearchValidationError } from "./errors.js";
import {
  EmbeddingNamespaceSchema,
  EmbeddingNamespaceSeedSchema,
  type EmbeddingNamespace,
  type EmbeddingNamespaceSeed,
} from "./schemas.js";

export function namespaceFingerprint(
  input: EmbeddingNamespaceSeed | EmbeddingNamespace,
): string {
  const seed = EmbeddingNamespaceSeedSchema.parse({
    schemaVersion: input.schemaVersion,
    provider: input.provider,
    model: input.model,
    preprocessingVersion: input.preprocessingVersion,
    dimension: input.dimension,
  });
  const canonical = JSON.stringify([
    seed.schemaVersion,
    seed.provider,
    seed.model,
    seed.preprocessingVersion,
    seed.dimension,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function createEmbeddingNamespace(input: EmbeddingNamespaceSeed): EmbeddingNamespace {
  const seed = EmbeddingNamespaceSeedSchema.parse(input);
  return EmbeddingNamespaceSchema.parse({
    ...seed,
    fingerprint: namespaceFingerprint(seed),
  });
}

export function assertNamespace(namespace: EmbeddingNamespace): EmbeddingNamespace {
  const parsed = EmbeddingNamespaceSchema.parse(namespace);
  const expected = namespaceFingerprint(parsed);
  if (parsed.fingerprint !== expected) {
    throw new SearchValidationError(
      "NAMESPACE_INVALID",
      `namespace fingerprint 与 provider/model/version/dimension 不一致：${parsed.fingerprint}`,
    );
  }
  return parsed;
}

export function sameNamespace(
  left: EmbeddingNamespace,
  right: EmbeddingNamespace,
): boolean {
  return (
    left.fingerprint === right.fingerprint &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.preprocessingVersion === right.preprocessingVersion &&
    left.dimension === right.dimension
  );
}
