/**
 * Authentication, device binding and step-up (PRD §17.1).
 *
 * Three layers, each doing one job:
 *   1. Password establishes who you are. scrypt with a per-user salt.
 *   2. A session token, stored only as a SHA-256 hash, carries that identity.
 *      A database leak yields hashes, not usable tokens.
 *   3. Device binding plus Ed25519 challenge signing gates the actions where
 *      being logged in is not enough — releasing collateral, moving money,
 *      revealing a card number.
 *
 * Every comparison of a secret uses timingSafeEqual. String `===` on a token
 * leaks its prefix through timing.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, verify as verifySignature, createPublicKey } from 'node:crypto';
import { promisify } from 'node:util';
import type pg from 'pg';
import { query, queryOne, type Db } from './db.js';
import { forbidden, stepUpRequired, unauthorized } from './errors.js';

const scrypt = promisify(scryptCb) as (p: string | Buffer, s: string | Buffer, k: number) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;

export const hashPassword = async (password: string): Promise<{ hash: string; salt: string }> => {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return { hash: derived.toString('hex'), salt };
};

export const verifyPassword = async (
  password: string, hash: string, salt: string,
): Promise<boolean> => {
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, 'hex');
  // Length must match before timingSafeEqual, which throws on a mismatch.
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(derived, stored);
};

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const newToken = (): string => randomBytes(32).toString('base64url');

export type Principal =
  | { kind: 'customer'; customerId: string; sessionId: string; deviceId: string | null; stepUpUntil: Date | null }
  | { kind: 'operator'; operatorId: string; sessionId: string; roles: string[] };

interface SessionRow {
  id: string;
  customer_id: string | null;
  operator_id: string | null;
  device_id: string | null;
  step_up_until: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  roles: string[] | null;
}

/** Resolve a bearer token to a principal, or null when it is not valid. */
export const resolveSession = async (db: Db, token: string): Promise<Principal | null> => {
  const row = await queryOne<SessionRow>(
    db,
    `SELECT s.id, s.customer_id, s.operator_id, s.device_id, s.step_up_until,
            s.expires_at, s.revoked_at, o.roles
       FROM sessions s
       LEFT JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at.getTime() <= Date.now()) return null;

  if (row.customer_id) {
    return {
      kind: 'customer',
      customerId: row.customer_id,
      sessionId: row.id,
      deviceId: row.device_id,
      stepUpUntil: row.step_up_until,
    };
  }
  if (row.operator_id) {
    return {
      kind: 'operator',
      operatorId: row.operator_id,
      sessionId: row.id,
      roles: row.roles ?? [],
    };
  }
  return null;
};

export const createSession = async (
  db: Db,
  principal: { customerId?: string; operatorId?: string; deviceId?: string | null },
  ttlHours: number,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; sessionId: string; expiresAt: Date }> => {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  const row = await queryOne<{ id: string }>(
    db,
    `INSERT INTO sessions (customer_id, operator_id, device_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      principal.customerId ?? null, principal.operatorId ?? null, principal.deviceId ?? null,
      hashToken(token), meta.ip ?? null, meta.userAgent ?? null, expiresAt,
    ],
  );
  return { token, sessionId: row!.id, expiresAt };
};

export const revokeSession = async (db: Db, sessionId: string): Promise<void> => {
  await query(db, 'UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
};

export const requireCustomer = (principal: Principal | null): Extract<Principal, { kind: 'customer' }> => {
  if (!principal) throw unauthorized();
  if (principal.kind !== 'customer') throw forbidden('This endpoint is for customer sessions');
  return principal;
};

export const requireOperator = (
  principal: Principal | null, ...roles: string[]
): Extract<Principal, { kind: 'operator' }> => {
  if (!principal) throw unauthorized();
  if (principal.kind !== 'operator') throw forbidden('This endpoint is for operator sessions');
  if (roles.length > 0 && !roles.some((r) => principal.roles.includes(r))) {
    throw forbidden(`Requires one of the following roles: ${roles.join(', ')}`);
  }
  return principal;
};

/** Throws unless the session completed a step-up that has not yet expired. */
export const requireStepUp = (
  principal: Extract<Principal, { kind: 'customer' }>, purpose: string,
): void => {
  if (!principal.stepUpUntil || principal.stepUpUntil.getTime() <= Date.now()) {
    throw stepUpRequired(purpose);
  }
};

// --- Device binding and challenge signing -----------------------------------

export const issueChallenge = async (
  db: Db, customerId: string, deviceId: string | null, purpose: string, ttlMinutes: number,
): Promise<{ challenge: string; expiresAt: Date }> => {
  const challenge = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  await query(
    db,
    `INSERT INTO step_up_challenges (customer_id, device_id, challenge, purpose, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [customerId, deviceId, challenge, purpose, expiresAt],
  );
  return { challenge, expiresAt };
};

/**
 * Verify an Ed25519 signature over a challenge with a registered device key.
 *
 * The challenge is consumed on the first successful verification, so a
 * captured signature cannot be replayed for a second sensitive action.
 */
export const verifyChallenge = async (
  tx: pg.PoolClient, customerId: string, challenge: string, signatureB64: string, purpose: string,
): Promise<{ deviceId: string }> => {
  const row = await queryOne<{ id: string; device_id: string | null; expires_at: Date; consumed_at: Date | null; purpose: string }>(
    tx,
    `SELECT id, device_id, expires_at, consumed_at, purpose
       FROM step_up_challenges
      WHERE customer_id = $1 AND challenge = $2
      FOR UPDATE`,
    [customerId, challenge],
  );
  if (!row) throw unauthorized('Unknown challenge');
  if (row.consumed_at) throw unauthorized('Challenge has already been used');
  if (row.expires_at.getTime() <= Date.now()) throw unauthorized('Challenge has expired');
  if (row.purpose !== purpose) throw forbidden('Challenge was issued for a different action');

  const devices = await query<{ id: string; public_key: string }>(
    tx,
    `SELECT id, public_key FROM devices
      WHERE customer_id = $1 AND revoked_at IS NULL
        AND ($2::uuid IS NULL OR id = $2::uuid)`,
    [customerId, row.device_id],
  );
  if (devices.length === 0) throw forbidden('No registered device is available to sign this action');

  const signature = Buffer.from(signatureB64, 'base64');
  const data = Buffer.from(challenge);

  for (const device of devices) {
    try {
      const key = createPublicKey({
        key: Buffer.from(device.public_key, 'base64'),
        format: 'der',
        type: 'spki',
      });
      if (verifySignature(null, data, key, signature)) {
        await query(tx, 'UPDATE step_up_challenges SET consumed_at = now() WHERE id = $1', [row.id]);
        await query(tx, 'UPDATE devices SET last_seen_at = now() WHERE id = $1', [device.id]);
        return { deviceId: device.id };
      }
    } catch {
      // A malformed stored key must not abort the loop: another registered
      // device may still hold the right one.
      continue;
    }
  }
  throw unauthorized('Signature did not verify against any registered device');
};

export const grantStepUp = async (
  db: Db, sessionId: string, ttlMinutes: number,
): Promise<Date> => {
  const until = new Date(Date.now() + ttlMinutes * 60_000);
  await query(db, 'UPDATE sessions SET step_up_until = $2 WHERE id = $1', [sessionId, until]);
  return until;
};
