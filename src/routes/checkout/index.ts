import { FastifyInstance } from 'fastify';
import { prisma } from '../../utils/prisma';
import { ApiError, successResponse } from '../../utils/errors';

export async function checkoutRoutes(fastify: FastifyInstance) {
    // ─────────────────────────────────────
    // GET /v1/checkout/:ref — Public payment details for checkout page
    // ─────────────────────────────────────
    fastify.get('/v1/checkout/:ref', async (request, reply) => {
        const { ref } = request.params as { ref: string };

        const payment = await prisma.payment.findUnique({
            where: { payment_ref: ref },
            select: {
                payment_ref: true,
                amount: true,
                currency: true,
                channel: true,
                status: true,
                description: true,
                expires_at: true,
                merchant: {
                    select: {
                        business_name: true,
                        legal_name: true,
                        first_name: true,
                        last_name: true,
                    }
                }
            },
        });

        if (!payment) {
            throw new ApiError('PAYMENT_NOT_FOUND', {}, 'Paiement introuvable');
        }

        // Determine merchant display name
        const merchantName = payment.merchant.business_name || payment.merchant.legal_name || `${payment.merchant.first_name} ${payment.merchant.last_name}`;

        reply.send(successResponse({
            payment_ref: payment.payment_ref,
            amount: Number(payment.amount),
            currency: payment.currency,
            channel: payment.channel,
            status: payment.status,
            description: payment.description,
            expires_at: payment.expires_at,
            merchant_name: merchantName.trim() || 'Marchand',
        }));
    });
}
