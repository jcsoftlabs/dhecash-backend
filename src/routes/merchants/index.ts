// ═══════════════════════════════════════
// DheCash — Merchant Routes
// Profile, KYC, API Keys, Webhooks, Team
// ═══════════════════════════════════════

import { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { ApiError, successResponse } from '../../utils/errors';
import { businessInfoSchema, bankDetailsSchema, webhookConfigSchema, createApiKeySchema } from '../../schemas';
import { generateApiKeyId, generateApiSecret } from '../../utils/ids';
import { jwtAuth, requirePermission, AuthenticatedRequest } from '../../plugins/auth';

const BCRYPT_COST = 12;

export async function merchantRoutes(fastify: FastifyInstance) {
    // ─────────────────────────────────────
    // GET /v1/merchants/me — Get profile
    // ─────────────────────────────────────
    fastify.get('/v1/merchants/me', {
        preHandler: [jwtAuth as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const merchant = await prisma.merchant.findUnique({
            where: { id: request.merchant!.id },
            select: {
                id: true, email: true, phone: true, type: true, status: true, role: true,
                first_name: true, last_name: true, nif: true, niu: true,
                business_name: true, legal_name: true, patente_number: true, business_type: true,
                address_street: true, address_city: true, address_department: true,
                bank_name: true, bank_account_number: true, bank_account_holder: true, bank_iban: true,
                email_verified: true, created_at: true, updated_at: true,
            },
        });
        if (!merchant) throw new ApiError('MERCHANT_NOT_FOUND');
        reply.send(successResponse(merchant));
    });

    // ─────────────────────────────────────
    // PUT /v1/merchants/me/business — Update business info
    // ─────────────────────────────────────
    fastify.put('/v1/merchants/me/business', {
        preHandler: [jwtAuth as any, requirePermission('settings:write') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = businessInfoSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', { fields: parsed.error.flatten().fieldErrors });
        }
        const merchant = await prisma.merchant.update({
            where: { id: request.merchant!.id },
            data: parsed.data,
            select: {
                id: true, nif: true, niu: true, patente_number: true, business_type: true,
                address_street: true, address_city: true, address_department: true, updated_at: true
            },
        });
        reply.send(successResponse(merchant));
    });

    // ─────────────────────────────────────
    // PUT /v1/merchants/me/bank — Update bank details
    // ─────────────────────────────────────
    fastify.put('/v1/merchants/me/bank', {
        preHandler: [jwtAuth as any, requirePermission('settings:write') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = bankDetailsSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', { fields: parsed.error.flatten().fieldErrors });
        }
        const merchant = await prisma.merchant.update({
            where: { id: request.merchant!.id },
            data: parsed.data,
            select: { id: true, bank_name: true, bank_account_number: true, bank_account_holder: true, bank_iban: true, updated_at: true },
        });
        reply.send(successResponse(merchant));
    });

    // ─────────────────────────────────────
    // API Keys
    // ─────────────────────────────────────
    fastify.get('/v1/api-keys', {
        preHandler: [jwtAuth as any, requirePermission('api_keys:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const keys = await prisma.apiKey.findMany({
            where: { merchant_id: request.merchant!.id },
            select: {
                id: true, key_id: true, environment: true, label: true, is_active: true,
                last_used_at: true, created_at: true, revoked_at: true
            },
            orderBy: { created_at: 'desc' },
        });
        reply.send(successResponse(keys));
    });

    fastify.post('/v1/api-keys', {
        preHandler: [jwtAuth as any, requirePermission('api_keys:write') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = createApiKeySchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', { fields: parsed.error.flatten().fieldErrors });
        }

        const { label, environment } = parsed.data;
        const env = environment as 'live' | 'test';
        const keyId = generateApiKeyId(env);
        const secret = generateApiSecret(env);
        const secret_hash = await bcrypt.hash(secret, BCRYPT_COST);

        // Extract prefix from secret: sk_{env}_{payload} → first 8 chars of payload
        const secretPayload = secret.replace(`sk_${env}_`, '');
        const secret_prefix = secretPayload.substring(0, 8);

        const apiKey = await prisma.apiKey.create({
            data: {
                merchant_id: request.merchant!.id,
                key_id: keyId,
                secret_hash,
                secret_prefix,
                environment: env,
                label,
            },
            select: { id: true, key_id: true, environment: true, label: true, created_at: true },
        });

        logger.info('Clé API créée', { merchant_id: request.merchant!.id, key_id: keyId });

        reply.status(201).send(successResponse({
            ...apiKey,
            secret, // Only shown ONCE
        }));
    });

    fastify.post('/v1/api-keys/rotate', {
        preHandler: [jwtAuth as any, requirePermission('api_keys:write') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const { key_id } = request.body as { key_id: string };
        if (!key_id) throw new ApiError('VALIDATION_ERROR', { fields: { key_id: 'Requis' } });

        const existing = await prisma.apiKey.findFirst({
            where: { key_id, merchant_id: request.merchant!.id, is_active: true },
        });
        if (!existing) throw new ApiError('API_KEY_INVALID');

        // Revoke old key
        await prisma.apiKey.update({
            where: { id: existing.id },
            data: { is_active: false, revoked_at: new Date() },
        });

        // Create new key
        const env = existing.environment as 'live' | 'test';
        const newKeyId = generateApiKeyId(env);
        const newSecret = generateApiSecret(env);
        const secret_hash = await bcrypt.hash(newSecret, BCRYPT_COST);
        const newSecretPayload = newSecret.replace(`sk_${env}_`, '');
        const secret_prefix = newSecretPayload.substring(0, 8);

        const newKey = await prisma.apiKey.create({
            data: {
                merchant_id: request.merchant!.id,
                key_id: newKeyId,
                secret_hash,
                secret_prefix,
                environment: env,
                label: existing.label,
            },
            select: { id: true, key_id: true, environment: true, label: true, created_at: true },
        });

        logger.info('Clé API renouvelée', { merchant_id: request.merchant!.id, old_key: key_id, new_key: newKeyId });

        reply.send(successResponse({
            ...newKey,
            secret: newSecret, // Only shown ONCE
            rotated_from: key_id,
        }));
    });

    // ─────────────────────────────────────
    // Webhook Configs
    // ─────────────────────────────────────
    fastify.get('/v1/webhooks', {
        preHandler: [jwtAuth as any, requirePermission('webhooks:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const configs = await prisma.webhookConfig.findMany({
            where: { merchant_id: request.merchant!.id },
            orderBy: { created_at: 'desc' },
        });
        reply.send(successResponse(configs));
    });

    fastify.post('/v1/webhooks', {
        preHandler: [jwtAuth as any, requirePermission('webhooks:write') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = webhookConfigSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', { fields: parsed.error.flatten().fieldErrors });
        }

        const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;

        const config = await prisma.webhookConfig.create({
            data: {
                merchant_id: request.merchant!.id,
                url: parsed.data.url,
                events: parsed.data.events,
                secret,
            },
        });

        reply.status(201).send(successResponse({
            ...config,
            secret, // Only shown ONCE
        }));
    });

    // ─────────────────────────────────────
    // Dashboard Analytics
    // ─────────────────────────────────────
    fastify.get('/v1/merchants/me/stats', {
        preHandler: [jwtAuth as any, requirePermission('analytics:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const merchantId = request.merchant!.id;
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const [todayRevenue, monthRevenue, totalTransactions, successRate] = await Promise.all([
            // Today's revenue
            prisma.payment.aggregate({
                where: { merchant_id: merchantId, status: 'completed', completed_at: { gte: todayStart } },
                _sum: { net_amount: true },
            }),
            // Month's revenue
            prisma.payment.aggregate({
                where: { merchant_id: merchantId, status: 'completed', completed_at: { gte: monthStart } },
                _sum: { net_amount: true },
            }),
            // Total transactions
            prisma.payment.count({ where: { merchant_id: merchantId } }),
            // Success rate
            prisma.payment.groupBy({
                by: ['status'],
                where: { merchant_id: merchantId, created_at: { gte: monthStart } },
                _count: true,
            }),
        ]);

        const totalThisMonth = successRate.reduce((acc: number, s: { status: string; _count: number }) => acc + s._count, 0);
        const completedThisMonth = successRate.find((s: { status: string }) => s.status === 'completed')?._count || 0;
        const rate = totalThisMonth > 0 ? ((completedThisMonth / totalThisMonth) * 100).toFixed(1) : '0';

        reply.send(successResponse({
            revenue_today: Number(todayRevenue._sum.net_amount || 0),
            revenue_month: Number(monthRevenue._sum.net_amount || 0),
            total_transactions: totalTransactions,
            success_rate: parseFloat(rate),
            currency: 'HTG',
        }));
    });

    // Revenue chart data (last 30 days)
    fastify.get('/v1/merchants/me/revenue-chart', {
        preHandler: [jwtAuth as any, requirePermission('analytics:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const merchantId = request.merchant!.id;
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const payments = await prisma.payment.findMany({
            where: {
                merchant_id: merchantId,
                status: 'completed',
                completed_at: { gte: thirtyDaysAgo },
            },
            select: { net_amount: true, completed_at: true },
            orderBy: { completed_at: 'asc' },
        });

        // Group by day
        const dailyRevenue: Record<string, number> = {};
        for (let i = 0; i < 30; i++) {
            const date = new Date(Date.now() - (29 - i) * 24 * 60 * 60 * 1000);
            dailyRevenue[date.toISOString().split('T')[0]] = 0;
        }
        payments.forEach((p: { completed_at: Date | null; net_amount: { toString(): string } | null }) => {
            if (p.completed_at) {
                const day = p.completed_at.toISOString().split('T')[0];
                dailyRevenue[day] = (dailyRevenue[day] || 0) + Number(p.net_amount || 0);
            }
        });

        const chart = Object.entries(dailyRevenue).map(([date, amount]) => ({ date, amount }));

        reply.send(successResponse(chart));
    });

    // Revenue by channel
    fastify.get('/v1/merchants/me/revenue-by-channel', {
        preHandler: [jwtAuth as any, requirePermission('analytics:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const merchantId = request.merchant!.id;
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

        const byChannel = await prisma.payment.groupBy({
            by: ['channel'],
            where: { merchant_id: merchantId, status: 'completed', completed_at: { gte: monthStart } },
            _sum: { net_amount: true },
            _count: true,
        });

        reply.send(successResponse(byChannel.map((c: { channel: string; _sum: { net_amount: { toString(): string } | null }; _count: number }) => ({
            channel: c.channel,
            revenue: Number(c._sum.net_amount || 0),
            count: c._count,
        }))));
    });
}
