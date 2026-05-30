/**
 * Zod request-validation helpers.
 *
 * Bar §"Security": "Input validation at the boundary via Zod. Domain types not strings."
 * Every route that touches a request body, query string, or path parameter
 * pipes it through one of these helpers and receives a parsed, typed object.
 */
import type { NextFunction, Request, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { ValidationError } from './errors.js';

export function validateBody<S extends ZodTypeAny>(schema: S) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new ValidationError('invalid request body', result.error.issues));
      return;
    }
    // Replace with parsed (sanitized/coerced) value so handlers see the typed shape.
    (req as Request & { body: z.infer<S> }).body = result.data;
    next();
  };
}

export function validateQuery<S extends ZodTypeAny>(schema: S) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(new ValidationError('invalid query parameters', result.error.issues));
      return;
    }
    // Express's req.query is typed `ParsedQs`; we widen via cast in handlers.
    (req as Request & { validatedQuery: z.infer<S> }).validatedQuery = result.data;
    next();
  };
}

export function validateParams<S extends ZodTypeAny>(schema: S) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      next(new ValidationError('invalid path parameters', result.error.issues));
      return;
    }
    (req as Request & { validatedParams: z.infer<S> }).validatedParams = result.data;
    next();
  };
}
