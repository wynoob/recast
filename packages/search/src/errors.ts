export type SearchErrorCode =
  | "CHUNK_INPUT_INVALID"
  | "INVALID_QUERY"
  | "NAMESPACE_INVALID"
  | "NAMESPACE_MISMATCH"
  | "DIMENSION_MISMATCH"
  | "VECTOR_INVALID"
  | "VECTOR_ZERO_NORM"
  | "SEMANTIC_STATE_INVALID";

export class SearchValidationError extends Error {
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = "SearchValidationError";
    this.code = code;
  }
}
