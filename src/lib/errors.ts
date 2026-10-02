/**
 * Exit-code conventions used across every spycore command.
 *   0 — success
 *   1 — user error (bad input, unknown key, missing arg)
 *   2 — auth error (not logged in, expired token, denied)
 *   3 — network error (cannot reach API, DNS, TLS)
 *   4 — server error (5xx, server bug)
 *
 * Codes are stable so shell scripts can branch on them. Do not renumber.
 */
export const EXIT_USER_ERROR = 1;
export const EXIT_AUTH_ERROR = 2;
export const EXIT_NETWORK_ERROR = 3;
export const EXIT_SERVER_ERROR = 4;

export type SpycoreErrorCode =
  | typeof EXIT_USER_ERROR
  | typeof EXIT_AUTH_ERROR
  | typeof EXIT_NETWORK_ERROR
  | typeof EXIT_SERVER_ERROR;

export class SpycoreCliError extends Error {
  readonly code: SpycoreErrorCode;
  readonly hint?: string | undefined;

  constructor(message: string, code: SpycoreErrorCode = EXIT_USER_ERROR, hint?: string) {
    super(message);
    this.name = 'SpycoreCliError';
    this.code = code;
    this.hint = hint;
  }
}

export function isSpycoreCliError(err: unknown): err is SpycoreCliError {
  return err instanceof SpycoreCliError;
}
