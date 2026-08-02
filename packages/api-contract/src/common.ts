import { z } from 'zod';

/**
 * Every timestamp crossing the gateway boundary is an ISO-8601 string in UTC.
 * Rocket.Chat mixes `Date`, `{ $date: number }` and ISO strings depending on
 * whether a value arrived over REST or over DDP; normalising here means clients
 * never have to know which transport produced a record.
 */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const IdSchema = z.string().min(1);

/** Offset pagination, used wherever the upstream only offers skip/limit. */
export const OffsetPaginationSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type OffsetPagination = z.infer<typeof OffsetPaginationSchema>;

export const paginatedSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    offset: z.number().int().min(0),
    limit: z.number().int().min(0),
  });

export type Paginated<T> = {
  items: T[];
  total: number;
  offset: number;
  limit: number;
};

/**
 * Machine-readable error codes. Clients switch on these instead of parsing
 * upstream Rocket.Chat error strings, which differ between server versions.
 */
export const ErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'totp_required',
  'upstream_unavailable',
  'upstream_error',
  'unsupported_by_server',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    /** Upstream Rocket.Chat error identifier, kept for debugging only. */
    upstream: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
