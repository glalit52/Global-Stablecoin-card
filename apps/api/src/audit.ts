/**
 * Audit trail (PRD §17.3, §22 "Audit logs").
 *
 * Every risk decision and every state change an operator or customer can make
 * lands here, with the before and after state and the policy version in force.
 * PRD §12.3 requires an immutable audit trail for risk actions specifically —
 * this table is append-only by convention and has no UPDATE path in the code.
 */
import { query, type Db } from './db.js';

export interface AuditInput {
  readonly actorType: 'customer' | 'operator' | 'system' | 'partner';
  readonly actorId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly policyVersion?: string | null;
  readonly correlationId?: string | null;
  readonly ip?: string | null;
}

export const audit = async (db: Db, input: AuditInput): Promise<void> => {
  await query(
    db,
    `INSERT INTO audit_log
       (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state,
        policy_version, correlation_id, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.actorType, input.actorId, input.action, input.entityType, input.entityId,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.policyVersion ?? null, input.correlationId ?? null, input.ip ?? null,
    ],
  );
};
