import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { ApiException } from './api-exception';

/**
 * Validates a request part against a zod schema from the shared contract.
 *
 * Nest's built-in `ValidationPipe` needs class DTOs with decorators, which
 * would mean maintaining a second description of every payload alongside the
 * schemas the client already consumes. Using the contract schemas directly
 * keeps exactly one source of truth.
 */
@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    throw ApiException.localized('bad_request', 'invalidRequestPart', {
      variables: { type: metadata.type },
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }
}

/** `@Query(zodPipe(ListMessagesQuerySchema)) query: ListMessagesQuery` */
export const zodPipe = <T extends z.ZodType>(schema: T): ZodValidationPipe<T> => new ZodValidationPipe(schema);
