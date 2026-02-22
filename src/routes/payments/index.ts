// ═══════════════════════════════════════
// DheCash — Payment Routes
// POST /v1/payments, GET /v1/payments/:ref,
// POST /v1/payments/:ref/refund
// ═══════════════════════════════════════

import { FastifyInstance } from 'fastify';
import { prisma } from '../../utils/prisma';
import { redis } from '../../utils/redis';
import { logger } from '../../utils/logger';
import { ApiError, successResponse, encodeCursor, decodeCursor } from '../../utils/errors';
import { createPaymentSchema, refundPaymentSchema, paymentFiltersSchema } from '../../schemas';
import { generatePaymentRef, generateTransactionRef } from '../../utils/ids';
import { eitherAuth, requirePermission, AuthenticatedRequest } from '../../plugins/auth';
import { queuePayment } from '../../services/queue';

// Fee rates per channel
const FEE_RATES: Record<string, number> = {
    moncash: 0.025,  // 2.5%
    natcash: 0.025,  // 2.5%
    stripe: 0.035,   // 3.5%
};

export async function paymentRoutes(fastify: FastifyInstance) {
    // ─────────────────────────────────────
    // POST /v1/payments — Create payment
    // ─────────────────────────────────────
    fastify.post('/v1/payments', {
        preHandler: [eitherAuth as any, requirePermission('payments:write') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = createPaymentSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const { amount, currency, channel, order_id, description, customer_email, customer_phone, customer_name, metadata } = parsed.data;
        const merchantId = request.merchant!.id;

        // Idempotency check
        const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
        if (idempotencyKey) {
            const cached = await redis.get(`idempotency:${idempotencyKey}`);
            if (cached) {
                const existing = JSON.parse(cached);
                logger.info('Requête idempotente détectée', { idempotency_key: idempotencyKey });
                return reply.send(successResponse(existing));
            }
        }

        // Calculate fees
        const feeRate = FEE_RATES[channel];
        const feeAmount = parseFloat((amount * feeRate).toFixed(2));
        const netAmount = parseFloat((amount - feeAmount).toFixed(2));

        // Generate references
        const paymentRef = generatePaymentRef();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min expiry

        // Create payment
        const payment = await prisma.payment.create({
            data: {
                payment_ref: paymentRef,
                merchant_id: merchantId,
                order_id,
                idempotency_key: idempotencyKey || null,
                channel,
                status: 'pending',
                amount,
                currency,
                fee_amount: feeAmount,
                fee_rate: feeRate,
                net_amount: netAmount,
                description,
                customer_email,
                customer_phone,
                customer_name,
                metadata: metadata || undefined,
                expires_at: expiresAt,
            },
            select: {
                payment_ref: true,
                channel: true,
                status: true,
                amount: true,
                currency: true,
                fee_amount: true,
                net_amount: true,
                description: true,
                expires_at: true,
                created_at: true,
            },
        });

        // Publish to BullMQ queue for async provider processing
        await queuePayment(channel as 'moncash' | 'natcash' | 'stripe', {
            payment_ref: paymentRef,
            merchant_id: merchantId,
            amount,
            currency,
            order_id,
            description,
            customer_email,
            customer_phone,
        });

        const response = {
            payment_ref: payment.payment_ref,
            channel: payment.channel,
            status: payment.status,
            amount: Number(payment.amount),
            currency: payment.currency,
            fee_amount: Number(payment.fee_amount),
            net_amount: Number(payment.net_amount),
            description: payment.description,
            redirect_url: null as string | null, // Will be set by provider service
            expires_at: payment.expires_at,
            created_at: payment.created_at,
        };

        // Cache for idempotency (24h TTL)
        if (idempotencyKey) {
            await redis.set(
                `idempotency:${idempotencyKey}`,
                JSON.stringify(response),
                'EX',
                24 * 60 * 60
            );
        }

        logger.info('Paiement créé', {
            payment_ref: paymentRef,
            merchant_id: merchantId,
            channel,
            amount,
            currency,
        });

        reply.status(201).send(successResponse(response));
    });

    // ─────────────────────────────────────
    // GET /v1/payments/:ref — Get payment
    // ─────────────────────────────────────
    fastify.get('/v1/payments/:ref', {
        preHandler: [eitherAuth as any, requirePermission('payments:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const { ref } = request.params as { ref: string };
        const merchantId = request.merchant!.id;

        const payment = await prisma.payment.findFirst({
            where: {
                payment_ref: ref,
                merchant_id: merchantId,
            },
            select: {
                payment_ref: true,
                order_id: true,
                channel: true,
                status: true,
                amount: true,
                currency: true,
                fee_amount: true,
                fee_rate: true,
                net_amount: true,
                description: true,
                customer_email: true,
                customer_phone: true,
                customer_name: true,
                provider_transaction_id: true,
                refunded_amount: true,
                metadata: true,
                expires_at: true,
                completed_at: true,
                failed_at: true,
                failure_reason: true,
                created_at: true,
                updated_at: true,
            },
        });

        if (!payment) {
            throw new ApiError('PAYMENT_NOT_FOUND');
        }

        reply.send(successResponse({
            ...payment,
            amount: Number(payment.amount),
            fee_amount: payment.fee_amount ? Number(payment.fee_amount) : null,
            fee_rate: payment.fee_rate ? Number(payment.fee_rate) : null,
            net_amount: payment.net_amount ? Number(payment.net_amount) : null,
            refunded_amount: Number(payment.refunded_amount),
        }));
    });

    // ─────────────────────────────────────
    // GET /v1/payments — List payments
    // ─────────────────────────────────────
    fastify.get('/v1/payments', {
        preHandler: [eitherAuth as any, requirePermission('payments:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = paymentFiltersSchema.safeParse(request.query);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const { status, channel, from, to, after, limit } = parsed.data;
        const merchantId = request.merchant!.id;

        const where: any = { merchant_id: merchantId };
        if (status) where.status = status;
        if (channel) where.channel = channel;
        if (from || to) {
            where.created_at = {};
            if (from) where.created_at.gte = new Date(from);
            if (to) where.created_at.lte = new Date(to);
        }

        // Cursor-based pagination
        if (after) {
            const cursorId = decodeCursor(after);
            where.id = { lt: cursorId };
        }

        const payments = await prisma.payment.findMany({
            where,
            orderBy: { created_at: 'desc' },
            take: limit + 1, // Fetch one extra to check if there's a next page
            select: {
                id: true,
                payment_ref: true,
                order_id: true,
                channel: true,
                status: true,
                amount: true,
                currency: true,
                fee_amount: true,
                net_amount: true,
                customer_name: true,
                created_at: true,
            },
        });

        const hasMore = payments.length > limit;
        const results = hasMore ? payments.slice(0, limit) : payments;
        const nextCursor = hasMore && results.length > 0
            ? encodeCursor(results[results.length - 1].id)
            : null;

        reply.send(successResponse(
            results.map((p: { id: string; payment_ref: string; order_id: string | null; channel: string; status: string; amount: unknown; currency: string; fee_amount: unknown; net_amount: unknown; customer_name: string | null; created_at: Date }) => ({
                ...p,
                amount: Number(p.amount),
                fee_amount: p.fee_amount ? Number(p.fee_amount) : null,
                net_amount: p.net_amount ? Number(p.net_amount) : null,
            })),
            {
                has_more: hasMore,
                next_cursor: nextCursor,
                count: results.length,
            }
        ));
    });

    // ─────────────────────────────────────
    // POST /v1/payments/:ref/refund
    // ─────────────────────────────────────
    fastify.post('/v1/payments/:ref/refund', {
        preHandler: [eitherAuth as any, requirePermission('payments:refund') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const { ref } = request.params as { ref: string };
        const parsed = refundPaymentSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const { amount, reason } = parsed.data;
        const merchantId = request.merchant!.id;

        const payment = await prisma.payment.findFirst({
            where: { payment_ref: ref, merchant_id: merchantId },
        });

        if (!payment) {
            throw new ApiError('PAYMENT_NOT_FOUND');
        }

        if (payment.status !== 'completed' && payment.status !== 'partially_refunded') {
            throw new ApiError('REFUND_NOT_ALLOWED');
        }

        const totalRefunded = Number(payment.refunded_amount) + amount;
        if (totalRefunded > Number(payment.amount)) {
            throw new ApiError('REFUND_EXCEEDS_AMOUNT');
        }

        const transactionRef = generateTransactionRef();
        const isFullRefund = totalRefunded === Number(payment.amount);

        // Atomic: create refund transaction + update payment
        const [transaction, updatedPayment] = await prisma.$transaction([
            prisma.transaction.create({
                data: {
                    transaction_ref: transactionRef,
                    payment_id: payment.id,
                    merchant_id: merchantId,
                    type: 'refund',
                    status: 'completed',
                    amount,
                    currency: payment.currency,
                    description: reason || 'Remboursement',
                },
            }),
            prisma.payment.update({
                where: { id: payment.id },
                data: {
                    refunded_amount: totalRefunded,
                    status: isFullRefund ? 'refunded' : 'partially_refunded',
                },
            }),
        ]);

        logger.info('Remboursement effectué', {
            payment_ref: ref,
            refund_ref: transactionRef,
            amount,
            total_refunded: totalRefunded,
        });

        reply.status(201).send(successResponse({
            refund_ref: transactionRef,
            payment_ref: ref,
            amount,
            status: transaction.status,
            total_refunded: totalRefunded,
            payment_status: updatedPayment.status,
            created_at: transaction.created_at,
        }));
    });
}
