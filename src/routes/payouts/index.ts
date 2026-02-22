// ═══════════════════════════════════════
// DheCash — Payouts Routes
// POST /v1/payouts
// GET /v1/payouts
// ═══════════════════════════════════════

import { FastifyInstance } from 'fastify';
import { prisma } from '../../utils/prisma';
import { ApiError, successResponse, encodeCursor, decodeCursor } from '../../utils/errors';
import { jwtAuth, requirePermission, AuthenticatedRequest } from '../../plugins/auth';
import { z } from 'zod';
import { customAlphabet } from 'nanoid';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

export function generatePayoutRef(): string {
    return `po_${nanoid()}`;
}

const payoutRequestSchema = z.object({
    amount: z.number().positive(),
    currency: z.enum(['HTG', 'USD']),
});

const payoutFiltersSchema = z.object({
    status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
    after: z.string().optional(),
    limit: z.coerce.number().min(1).max(100).default(20),
});

export async function payoutRoutes(fastify: FastifyInstance) {
    // ─────────────────────────────────────
    // POST /v1/payouts — Request a payout
    // ─────────────────────────────────────
    fastify.post('/v1/payouts', {
        preHandler: [jwtAuth as any, requirePermission('payments:write') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = payoutRequestSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const { amount, currency } = parsed.data;
        const merchantId = request.merchant!.id;

        // Verify merchant has bank details configured
        const merchant = await prisma.merchant.findUnique({
            where: { id: merchantId },
            select: { bank_name: true, bank_account_number: true, bank_account_holder: true }
        });

        if (!merchant || !merchant.bank_name || !merchant.bank_account_number) {
            throw new ApiError('VALIDATION_ERROR', {
                message: 'Veuillez configurer vos coordonnées bancaires dans les paramètres avant de demander un retrait.',
            });
        }

        // Ideally, we'd check available balance here. 
        // For now, we accept the request and the admin verifies the ledger manually.

        const payoutRef = generatePayoutRef();

        const payout = await prisma.payout.create({
            data: {
                payout_ref: payoutRef,
                merchant_id: merchantId,
                amount,
                currency,
                status: 'pending',
                bank_name: merchant.bank_name,
                bank_account_number: merchant.bank_account_number,
                bank_account_holder: merchant.bank_account_holder || 'Non spécifié',
            }
        });

        reply.status(201).send(successResponse({
            payout_ref: payout.payout_ref,
            amount: Number(payout.amount),
            currency: payout.currency,
            status: payout.status,
            bank_name: payout.bank_name,
            requested_at: payout.requested_at,
        }));
    });

    // ─────────────────────────────────────
    // GET /v1/payouts — List payouts
    // ─────────────────────────────────────
    fastify.get('/v1/payouts', {
        preHandler: [jwtAuth as any, requirePermission('payments:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = payoutFiltersSchema.safeParse(request.query);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const { status, after, limit } = parsed.data;
        const merchantId = request.merchant!.id;

        const where: any = { merchant_id: merchantId };
        if (status) where.status = status;

        if (after) {
            const cursorId = decodeCursor(after);
            where.id = { lt: cursorId };
        }

        const payouts = await prisma.payout.findMany({
            where,
            orderBy: { requested_at: 'desc' },
            take: limit + 1,
            select: {
                id: true,
                payout_ref: true,
                amount: true,
                currency: true,
                status: true,
                bank_name: true,
                bank_account_number: true,
                external_ref: true,
                requested_at: true,
                processed_at: true,
            },
        });

        const hasMore = payouts.length > limit;
        const results = hasMore ? payouts.slice(0, limit) : payouts;
        const nextCursor = hasMore && results.length > 0
            ? encodeCursor(results[results.length - 1].id)
            : null;

        reply.send(successResponse(
            results.map((p: any) => ({
                ...p,
                amount: Number(p.amount),
            })),
            {
                has_more: hasMore,
                next_cursor: nextCursor,
                count: results.length,
            }
        ));
    });
}
