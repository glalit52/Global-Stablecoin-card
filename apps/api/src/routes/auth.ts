/** Authentication, device registration and step-up (PRD §17.1). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createSession, grantStepUp, hashPassword, issueChallenge, requireCustomer,
  revokeSession, verifyChallenge, verifyPassword,
} from '../auth.js';
import { query, queryOne, transaction } from '../db.js';
import { audit } from '../audit.js';
import { badRequest, conflict, unauthorized } from '../errors.js';
import { clientIp, parse } from './helpers.js';
import type { AppContext } from '../context.js';

const registerBody = z.object({
  email: z.string().email(),
  password: z.string().min(12, 'Password must be at least 12 characters'),
  legalName: z.string().min(2).max(200),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  jurisdiction: z.enum(['US', 'GB', 'EU', 'AE', 'SG', 'CH', 'IN', 'CA', 'AU']),
  documentType: z.enum(['passport', 'drivers_license', 'national_id']).optional(),
  documentNumber: z.string().min(4).max(64).optional(),
});

export const registerAuthRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  app.post('/v1/auth/register', async (req, reply) => {
    const body = parse(registerBody, req.body);

    const existing = await queryOne<{ id: string }>(
      ctx.pool, 'SELECT id FROM customers WHERE lower(email) = lower($1)', [body.email],
    );
    // Do not reveal whether an address is already registered.
    if (existing) throw conflict('registration_failed', 'Unable to complete registration with these details');

    const { hash, salt } = await hashPassword(body.password);

    const result = await transaction(ctx.pool, async (tx) => {
      const row = await queryOne<{ id: string }>(
        tx,
        `INSERT INTO customers
           (email, legal_name, date_of_birth, jurisdiction, password_hash, password_salt, status)
         VALUES ($1,$2,$3,$4,$5,$6,'prospect') RETURNING id`,
        [body.email, body.legalName, body.dateOfBirth, body.jurisdiction, hash, salt],
      );
      const customerId = row!.id;

      const kyc = await ctx.partners.kyc.submit({
        customerId,
        legalName: body.legalName,
        dateOfBirth: body.dateOfBirth,
        email: body.email,
        jurisdiction: body.jurisdiction,
        addressCountry: body.jurisdiction,
        ...(body.documentType ? { documentType: body.documentType } : {}),
        ...(body.documentNumber ? { documentNumber: body.documentNumber } : {}),
      }, `kyc:${customerId}`);

      await query(
        tx,
        // $2 is cast explicitly at both use sites. Without the casts Postgres
        // has to deduce one type for a parameter compared against an enum
        // column in one clause and a text literal in another, and refuses.
        `UPDATE customers
            SET kyc_status = $2::kyc_status, kyc_reference = $3, sanctions_clear = $4,
                pep_review_cleared = $5, fraud_score = $6,
                status = CASE WHEN $2::text = 'approved'
                              THEN 'active'::customer_status ELSE status END
          WHERE id = $1`,
        [customerId, kyc.status, kyc.reference, kyc.sanctionsClear,
         !kyc.pepMatch, kyc.riskScore.toDecimalPlaces(4).toFixed()],
      );

      await audit(tx, {
        actorType: 'customer', actorId: customerId,
        action: 'customer.registered', entityType: 'customer', entityId: customerId,
        after: { jurisdiction: body.jurisdiction, kycStatus: kyc.status },
        ip: clientIp(req),
      });

      return { customerId, kyc };
    });

    const session = await createSession(
      ctx.pool, { customerId: result.customerId }, ctx.config.sessionTtlHours,
      { ip: clientIp(req), userAgent: req.headers['user-agent'] ?? '' },
    );

    return reply.code(201).send({
      customerId: result.customerId,
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      kyc: {
        status: result.kyc.status,
        reasons: result.kyc.reasons,
        sanctionsClear: result.kyc.sanctionsClear,
      },
    });
  });

  app.post('/v1/auth/login', async (req, reply) => {
    const body = parse(z.object({
      email: z.string().email(),
      password: z.string().min(1),
      deviceId: z.string().uuid().optional(),
    }), req.body);

    const customer = await queryOne<{ id: string; password_hash: string; password_salt: string; status: string }>(
      ctx.pool,
      'SELECT id, password_hash, password_salt, status FROM customers WHERE lower(email) = lower($1)',
      [body.email],
    );

    // Run the hash even when the account is unknown so the response time does
    // not disclose which addresses are registered.
    const ok = customer
      ? await verifyPassword(body.password, customer.password_hash, customer.password_salt)
      : await verifyPassword(body.password, '00'.repeat(64), 'decoy').then(() => false);

    if (!customer || !ok) throw unauthorized('Email or password is incorrect');
    if (customer.status === 'closed' || customer.status === 'suspended') {
      throw unauthorized('This account is not available');
    }

    const session = await createSession(
      ctx.pool,
      { customerId: customer.id, deviceId: body.deviceId ?? null },
      ctx.config.sessionTtlHours,
      { ip: clientIp(req), userAgent: req.headers['user-agent'] ?? '' },
    );

    await audit(ctx.pool, {
      actorType: 'customer', actorId: customer.id,
      action: 'auth.login', entityType: 'session', entityId: session.sessionId,
      ip: clientIp(req),
    });

    return reply.send({
      token: session.token,
      customerId: customer.id,
      expiresAt: session.expiresAt.toISOString(),
    });
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    await revokeSession(ctx.pool, principal.sessionId);
    return reply.send({ ok: true });
  });

  app.post('/v1/operator/login', async (req, reply) => {
    const body = parse(z.object({
      email: z.string().email(), password: z.string().min(1),
    }), req.body);

    const operator = await queryOne<{ id: string; password_hash: string; password_salt: string; active: boolean; roles: string[] }>(
      ctx.pool, 'SELECT * FROM operators WHERE lower(email) = lower($1)', [body.email],
    );
    const ok = operator
      ? await verifyPassword(body.password, operator.password_hash, operator.password_salt)
      : false;
    if (!operator || !ok || !operator.active) throw unauthorized('Email or password is incorrect');

    const session = await createSession(
      ctx.pool, { operatorId: operator.id }, 8,
      { ip: clientIp(req), userAgent: req.headers['user-agent'] ?? '' },
    );
    await audit(ctx.pool, {
      actorType: 'operator', actorId: operator.id,
      action: 'auth.operator_login', entityType: 'session', entityId: session.sessionId,
      ip: clientIp(req),
    });
    return reply.send({
      token: session.token, operatorId: operator.id,
      roles: operator.roles, expiresAt: session.expiresAt.toISOString(),
    });
  });

  // --- Device binding -------------------------------------------------------

  app.post('/v1/auth/devices', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const body = parse(z.object({
      deviceName: z.string().min(1).max(100),
      // SPKI DER, base64. Generated by the client; the private key never leaves it.
      publicKey: z.string().min(32),
      algorithm: z.literal('ed25519').default('ed25519'),
    }), req.body);

    const row = await queryOne<{ id: string }>(
      ctx.pool,
      `INSERT INTO devices (customer_id, device_name, public_key, algorithm, trusted)
       VALUES ($1,$2,$3,$4,TRUE) RETURNING id`,
      [principal.customerId, body.deviceName, body.publicKey, body.algorithm],
    );

    await audit(ctx.pool, {
      actorType: 'customer', actorId: principal.customerId,
      action: 'device.registered', entityType: 'device', entityId: row!.id,
      after: { deviceName: body.deviceName }, ip: clientIp(req),
    });

    return reply.code(201).send({ deviceId: row!.id });
  });

  app.get('/v1/auth/devices', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const rows = await query<{ id: string; device_name: string; trusted: boolean; last_seen_at: Date | null; created_at: Date }>(
      ctx.pool,
      `SELECT id, device_name, trusted, last_seen_at, created_at
         FROM devices WHERE customer_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
      [principal.customerId],
    );
    return reply.send({
      devices: rows.map((d) => ({
        id: d.id, name: d.device_name, trusted: d.trusted,
        lastSeenAt: d.last_seen_at?.toISOString() ?? null,
        createdAt: d.created_at.toISOString(),
      })),
    });
  });

  app.delete('/v1/auth/devices/:id', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await query(
      ctx.pool, 'UPDATE devices SET revoked_at = now() WHERE id = $1 AND customer_id = $2',
      [id, principal.customerId],
    );
    await audit(ctx.pool, {
      actorType: 'customer', actorId: principal.customerId,
      action: 'device.revoked', entityType: 'device', entityId: id, ip: clientIp(req),
    });
    return reply.send({ ok: true });
  });

  // --- Step-up --------------------------------------------------------------

  app.post('/v1/auth/step-up/challenge', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const body = parse(z.object({
      purpose: z.enum(['reveal_card', 'release_collateral', 'repayment', 'redeem', 'card_controls', 'high_value_transaction']),
    }), req.body);

    const challenge = await issueChallenge(
      ctx.pool, principal.customerId, principal.deviceId, body.purpose, ctx.config.stepUpTtlMinutes,
    );
    return reply.send({
      challenge: challenge.challenge,
      expiresAt: challenge.expiresAt.toISOString(),
      algorithm: 'ed25519',
    });
  });

  app.post('/v1/auth/step-up/verify', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const body = parse(z.object({
      challenge: z.string().min(16),
      signature: z.string().min(16),
      purpose: z.string().min(1),
    }), req.body);

    const result = await transaction(ctx.pool, async (tx) => {
      const verified = await verifyChallenge(
        tx, principal.customerId, body.challenge, body.signature, body.purpose,
      );
      const until = await grantStepUp(tx, principal.sessionId, ctx.config.stepUpTtlMinutes);
      await audit(tx, {
        actorType: 'customer', actorId: principal.customerId,
        action: 'auth.step_up_verified', entityType: 'session', entityId: principal.sessionId,
        after: { purpose: body.purpose, deviceId: verified.deviceId }, ip: clientIp(req),
      });
      return { until, deviceId: verified.deviceId };
    });

    return reply.send({
      verified: true,
      stepUpUntil: result.until.toISOString(),
      deviceId: result.deviceId,
    });
  });

  app.get('/v1/auth/me', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const customer = await queryOne<{
      id: string; email: string; legal_name: string; jurisdiction: string;
      status: string; tier: string; kyc_status: string; created_at: Date;
    }>(ctx.pool, 'SELECT * FROM customers WHERE id = $1', [principal.customerId]);
    if (!customer) throw badRequest('customer_missing', 'Session refers to a customer that no longer exists');

    return reply.send({
      id: customer.id,
      email: customer.email,
      legalName: customer.legal_name,
      jurisdiction: customer.jurisdiction,
      status: customer.status,
      tier: customer.tier,
      kycStatus: customer.kyc_status,
      memberSince: customer.created_at.toISOString(),
      stepUpActive: principal.stepUpUntil !== null && principal.stepUpUntil.getTime() > Date.now(),
    });
  });
};
