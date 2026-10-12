// Every error the API returns maps to one of these codes (docs/BACKEND.md §5).

export type ErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'removed'
  | 'too_large'
  | 'source_unreachable'
  | 'source_mismatch'
  | 'site_mismatch'
  | 'rate_limited'
  | 'conflict'
  | 'forbidden'
  | 'internal';

export class ApiError extends Error {
  code: ErrorCode;
  status: number;
  retryAfter?: number;

  constructor(code: ErrorCode, message: string, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const bad = (message: string) => new ApiError('invalid_request', message, 400);
export const notFound = (message = 'Not found') => new ApiError('not_found', message, 404);
