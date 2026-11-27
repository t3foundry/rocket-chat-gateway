import { readFileSync } from 'node:fs';

import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GATEWAY_CONFIG, type GatewayConfig } from '../config/configuration';

const SlotRulesSchema = z.record(
  z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'a slot id is 0x followed by 32 bytes of hex'),
  z.object({
    /** The slot's access rule, as a JSON string. */
    rule: z.string().min(1),
    /**
     * The salt of the rule's on-chain commitment. Not used: the gateway only reads
     * the rule. Accepted so a file written for an earlier gateway still loads.
     */
    salt: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'a rule salt is 0x followed by 32 bytes of hex')
      .optional(),
  }),
);

/**
 * The access rules of the slots this gateway issues reader credentials for.
 *
 * The gateway needs a slot's rule for one thing: to know which `key` claim value
 * a reader credential must carry. A rule held here is read directly, with no
 * round-trip to the network.
 *
 * It is the gateway's own source and is served to nobody: a reader needs neither
 * the rule nor its salt to decrypt, and a rule is confidential to the slot's
 * operator set.
 *
 * Loaded once from `TASRA_SLOT_RULES_FILE`: `{ "<slotId>": { "rule": "…" } }`.
 */
@Injectable()
export class TasraSlotRuleService {
  private rules: Map<string, string> | null = null;

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  /** The rule text for `slotId`, or `undefined` when this gateway holds none for it. */
  find(slotId: string): string | undefined {
    return this.load().get(slotId.toLowerCase());
  }

  private load(): Map<string, string> {
    if (this.rules) return this.rules;

    const path = this.config.tasra?.slotRulesFile;
    if (!path) return (this.rules = new Map());

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (cause) {
      throw new Error('TASRA_SLOT_RULES_FILE is not a valid slot rules file: unreadable or not JSON', { cause });
    }
    const checked = SlotRulesSchema.safeParse(raw);
    if (!checked.success) {
      // Name the fields, never their values: a rule is confidential.
      const issues = checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      throw new Error(`TASRA_SLOT_RULES_FILE is not a valid slot rules file: ${issues}`);
    }

    this.rules = new Map(Object.entries(checked.data).map(([slotId, entry]) => [slotId.toLowerCase(), entry.rule]));
    return this.rules;
  }
}
