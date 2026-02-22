// ═══════════════════════════════════════
// DheCash — Transaction Routes
// GET /v1/transactions (with CSV export)
// ═══════════════════════════════════════

import { FastifyInstance } from 'fastify';
import { prisma } from '../../utils/prisma';
import { ApiError, successResponse, encodeCursor, decodeCursor } from '../../utils/errors';
import { transactionFiltersSchema } from '../../schemas';
import { eitherAuth, requirePermission, AuthenticatedRequest } from '../../plugins/auth';

export async function transactionRoutes(fastify: FastifyInstance) {
    // ─────────────────────────────────────
    // GET /v1/transactions
    // ─────────────────────────────────────
    fastify.get('/v1/transactions', {
        preHandler: [eitherAuth as any, requirePermission('transactions:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = transactionFiltersSchema.safeParse(request.query);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const { status, channel, from, to, after, limit } = parsed.data;
        const merchantId = request.merchant!.id;
        const isExport = parsed.data.export === 'csv';

        const where: any = { merchant_id: merchantId };
        if (status) where.status = status;
        if (from || to) {
            where.created_at = {};
            if (from) where.created_at.gte = new Date(from);
            if (to) where.created_at.lte = new Date(to);
        }

        // For CSV export, fetch all matching records
        if (isExport) {
            const transactions = await prisma.transaction.findMany({
                where,
                orderBy: { created_at: 'desc' },
                include: {
                    payment: {
                        select: {
                            payment_ref: true,
                            channel: true,
                            order_id: true,
                        },
                    },
                },
            });

            // Build CSV
            const headers = 'Référence,Paiement,Canal,Type,Montant,Devise,Statut,Date\n';
            const rows = transactions.map(t =>
                `${t.transaction_ref},${t.payment.payment_ref},${t.payment.channel},${t.type},${Number(t.amount)},${t.currency},${t.status},${t.created_at.toISOString()}`
            ).join('\n');

            reply
                .header('Content-Type', 'text/csv; charset=utf-8')
                .header('Content-Disposition', `attachment; filename=transactions_${new Date().toISOString().split('T')[0]}.csv`)
                .send(headers + rows);
            return;
        }

        // Cursor-based pagination
        if (after) {
            const cursorId = decodeCursor(after);
            where.id = { lt: cursorId };
        }

        const transactions = await prisma.transaction.findMany({
            where,
            orderBy: { created_at: 'desc' },
            take: limit + 1,
            include: {
                payment: {
                    select: {
                        payment_ref: true,
                        channel: true,
                        order_id: true,
                    },
                },
            },
        });

        const hasMore = transactions.length > limit;
        const results = hasMore ? transactions.slice(0, limit) : transactions;
        const nextCursor = hasMore && results.length > 0
            ? encodeCursor(results[results.length - 1].id)
            : null;

        reply.send(successResponse(
            results.map(t => ({
                transaction_ref: t.transaction_ref,
                payment_ref: t.payment.payment_ref,
                channel: t.payment.channel,
                order_id: t.payment.order_id,
                type: t.type,
                amount: Number(t.amount),
                currency: t.currency,
                status: t.status,
                description: t.description,
                created_at: t.created_at,
            })),
            {
                has_more: hasMore,
                next_cursor: nextCursor,
                count: results.length,
            }
        ));
    });
}
