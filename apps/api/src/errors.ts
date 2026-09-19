/** Application errors that map cleanly onto HTTP responses. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not permitted') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what: string) =>
  new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
/** Step-up authentication required before this action may proceed. */
export const stepUpRequired = (purpose: string) =>
  new AppError(428, 'step_up_required', 'Additional verification is required for this action', { purpose });
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
export const serverError = (message = 'Internal error') =>
  new AppError(500, 'internal_error', message);
