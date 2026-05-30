/**
 * Correlation ID middleware.
 *
 * Reads `x-correlation-id` from the request if present (so callers can stitch
 * traces); otherwise mints a UUID. Attaches to `req.correlationId`, echoes
 * back as a response header, and binds a child logger onto `req.log`.
 *
 * This is the foundation of every other piece of observability — without it,
 * a 4-line failed transaction in one log line cannot be tied to its origin.
 */
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { getLogger } from '../logging.js';

const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.header(CORRELATION_HEADER);
  // Reject obviously malformed inbound IDs to prevent log-injection (newlines,
  // ANSI escapes). Length cap of 128 covers UUIDs and most trace IDs.
  const id = inbound && CORRELATION_REGEX.test(inbound) ? inbound : uuidv4();
  req.correlationId = id;
  res.setHeader(CORRELATION_HEADER, id);
  req.log = getLogger().child({ correlationId: id });
  next();
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      log: Logger;
      // Populated by requireAuth — undefined on public routes.
      user?: { id: number; email: string };
      session?: { id: number; user_id: number };
    }
  }
}
