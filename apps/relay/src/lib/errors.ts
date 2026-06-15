/** Relay error taxonomy (TECHNICAL-SPEC §5). Each code maps to a fixed HTTP status. */
export const ERROR_STATUS = {
  invalid_api_key: 401,
  revoked_api_key: 401,
  rate_limited: 429,
  quota_exceeded: 429,
  channel_not_paired: 409,
  channel_offline: 503,
  payload_too_large: 413,
  invalid_payload: 422,
  pairing_code_invalid: 404,
  pairing_code_expired: 410,
  pairing_locked: 429,
  render_not_found: 404,
  context_timeout: 504,
  not_implemented: 501,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RelayError";
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export function errorBody(err: RelayError, requestId: string) {
  return {
    error: {
      code: err.code,
      message: err.message,
      requestId,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  };
}
