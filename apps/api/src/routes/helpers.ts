/** Shared plumbing for route modules. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, badRequest } from '../errors.js';
import type { Principal } from '../auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('validation_failed', 'Request did not validate', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
};

/** Decimal-string validator. Amounts arrive as strings, never as JS numbers. */
export const amountString = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'must be a positive decimal string, e.g. "1250.00"');

export const currencyCode = z.string().length(3).regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase());

export const sendError = (reply: FastifyReply, err: unknown): FastifyReply => {
  if (err instanceof AppError) {
    return reply.code(err.statusCode).send({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
    });
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  reply.log.error({ err }, 'unhandled route error');
  return reply.code(500).send({ error: { code: 'internal_error', message } });
};

export const clientIp = (req: FastifyRequest): string =>
  (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip;
