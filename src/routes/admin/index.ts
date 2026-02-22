import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireSuperAdmin, eitherAuth, AuthenticatedRequest } from '../../plugins/auth';
import { ApiError } from '../../utils/errors';

export const adminRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {

    // Protect all routes in this plugin with super_admin permissions
    app.addHook('preValidation', eitherAuth);
    app.addHook('preValidation', requireSuperAdmin);

    // ─────────────────────────────────────
    // 1. GET /v1/admin/metrics
    // Global platform overview (Volumes & Commissions)
    // ─────────────────────────────────────
    app.get('/metrics', async (request, reply) => {
        // Query distinct providers
        const [
            totalMerchants,
            totalCustomers,
            successfulPayments,
            aggregateVolume,
            recentPayouts
        ] = await Promise.all([
            prisma.merchant.count(),
            prisma.customer.count(),
            prisma.payment.count({ where: { status: 'completed' } }),
            prisma.payment.aggregate({
                where: { status: 'completed' },
                _sum: { amount: true, fee_amount: true, net_amount: true }
            }),
            prisma.payout.findMany({
                where: { status: 'pending' },
                orderBy: { requested_at: 'desc' },
                take: 5,
                include: { merchant: { select: { business_name: true, first_name: true, last_name: true } } }
            })
        ]);

        // Break down by channel
        const volumeByChannel = await prisma.payment.groupBy({
            by: ['channel'],
            where: { status: 'completed' },
            _sum: { amount: true, fee_amount: true }
        });

        // Break down by currency
        const volumeByCurrency = await prisma.payment.groupBy({
            by: ['currency'],
            where: { status: 'completed' },
            _sum: { amount: true, fee_amount: true }
        });

        return reply.code(200).send({
            success: true,
            data: {
                overview: {
                    merchants: totalMerchants,
                    customers: totalCustomers,
                    transactions: successfulPayments,
                    total_volume: aggregateVolume._sum.amount || 0,
                    total_fees_earned: aggregateVolume._sum.fee_amount || 0,
                    total_net_payouts_due: aggregateVolume._sum.net_amount || 0
                },
                by_channel: volumeByChannel.map(v => ({
                    channel: v.channel,
                    volume: v._sum.amount || 0,
                    fees: v._sum.fee_amount || 0
                })),
                by_currency: volumeByCurrency.map(v => ({
                    currency: v.currency,
                    volume: v._sum.amount || 0,
                    fees: v._sum.fee_amount || 0
                })),
                pending_payouts: recentPayouts
            }
        });
    });

    // ─────────────────────────────────────
    // 2. GET /v1/admin/merchants
    // Directory of all registered merchants
    // ─────────────────────────────────────
    const listingSchema = z.object({
        limit: z.coerce.number().min(1).max(100).default(50),
        page: z.coerce.number().min(1).default(1),
        search: z.string().optional(),
    });

    app.get('/merchants', async (request, reply) => {
        const query = listingSchema.parse(request.query);
        const skip = (query.page - 1) * query.limit;

        const where: any = {};
        if (query.search) {
            where.OR = [
                { email: { contains: query.search, mode: 'insensitive' } },
                { business_name: { contains: query.search, mode: 'insensitive' } },
                { first_name: { contains: query.search, mode: 'insensitive' } },
                { last_name: { contains: query.search, mode: 'insensitive' } },
            ];
        }

        const [merchants, total] = await Promise.all([
            prisma.merchant.findMany({
                where,
                skip,
                take: query.limit,
                orderBy: { created_at: 'desc' },
                select: {
                    id: true,
                    email: true,
                    type: true,
                    status: true,
                    business_name: true,
                    first_name: true,
                    last_name: true,
                    phone: true,
                    created_at: true,
                    _count: {
                        select: { payments: { where: { status: 'completed' } } }
                    }
                }
            }),
            prisma.merchant.count({ where })
        ]);

        return reply.code(200).send({
            success: true,
            data: merchants,
            pagination: {
                total,
                page: query.page,
                limit: query.limit,
                total_pages: Math.ceil(total / query.limit)
            }
        });
    });

    // ─────────────────────────────────────
    // 3. GET /v1/admin/payouts
    // Global Payout requests management
    // ─────────────────────────────────────
    const payoutListingSchema = z.object({
        status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
        limit: z.coerce.number().min(1).max(100).default(50),
        page: z.coerce.number().min(1).default(1),
    });

    app.get('/payouts', async (request, reply) => {
        const query = payoutListingSchema.parse(request.query);
        const skip = (query.page - 1) * query.limit;

        const where = query.status ? { status: query.status } : {};

        const [payouts, total] = await Promise.all([
            prisma.payout.findMany({
                where,
                skip,
                take: query.limit,
                orderBy: { requested_at: 'desc' },
                include: {
                    merchant: {
                        select: { id: true, business_name: true, first_name: true, last_name: true, email: true }
                    }
                }
            }),
            prisma.payout.count({ where })
        ]);

        return reply.code(200).send({
            success: true,
            data: payouts,
            pagination: {
                total,
                page: query.page,
                limit: query.limit,
                total_pages: Math.ceil(total / query.limit)
            }
        });
    });

    // ─────────────────────────────────────
    // 4. PUT /v1/admin/payouts/:id/status
    // Advance a payout request
    // ─────────────────────────────────────
    const updatePayoutSchema = z.object({
        status: z.enum(['processing', 'completed', 'failed']),
        external_ref: z.string().optional(),
        admin_notes: z.string().optional(),
    });

    app.put('/payouts/:id/status', async (request, reply) => {
        const { id } = request.params as { id: string };
        const data = updatePayoutSchema.parse(request.body);

        const payout = await prisma.payout.findUnique({ where: { id } });
        if (!payout) {
            throw new ApiError('NOT_FOUND', { message: 'Payout introuvable' });
        }

        // Apply timestamp based on the new status
        let timestampUpdate = {};
        if (data.status === 'completed') {
            timestampUpdate = { processed_at: new Date() };
        } else if (data.status === 'failed') {
            timestampUpdate = { failed_at: new Date() };
        }

        const updated = await prisma.payout.update({
            where: { id },
            data: {
                status: data.status,
                external_ref: data.external_ref,
                admin_notes: data.admin_notes,
                processed_by: (request as AuthenticatedRequest).merchant?.id, // ID of the super_admin who did it
                ...timestampUpdate
            },
            include: {
                merchant: {
                    select: { email: true, business_name: true, first_name: true }
                }
            }
        });

        // Trigger Payout Transaction resolution
        if (data.status === 'completed') {
            await prisma.transaction.updateMany({
                where: { payout_id: id },
                data: { status: 'completed', updated_at: new Date() }
            });

            // TODO: Here we could trigger a Resend email to the merchant informing them the funds 
            // have been deposited into their bank account.
        } else if (data.status === 'failed') {
            await prisma.transaction.updateMany({
                where: { payout_id: id },
                data: { status: 'failed', updated_at: new Date() }
            });
        }

        return reply.code(200).send({
            success: true,
            data: updated
        });
    });
};
