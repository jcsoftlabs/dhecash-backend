// ═══════════════════════════════════════
// DheCash — Provider Webhook Routes
// POST /v1/webhooks/stripe
// POST /v1/webhooks/moncash
// POST /v1/webhooks/natcash
// ═══════════════════════════════════════

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { stripeService } from '../../services/providers/stripe';
import { notificationService } from '../../services/notification';
import { generateTransactionRef } from '../../utils/ids';

// Augment FastifyRequest to include rawBody set by our content-type parser
declare module 'fastify' {
    interface FastifyRequest {
        rawBody?: Buffer;
    }
}

// ─────────────────────────────────────
// Payment status updater — shared logic
// ─────────────────────────────────────
async function updatePaymentStatus(
    provider_transaction_id: string,
    newStatus: 'completed' | 'failed' | 'cancelled' | 'refunded',
    extra?: {
        completed_at?: Date;
        failed_at?: Date;
        failure_reason?: string;
        refunded_at?: Date;
        refunded_amount?: number;
    }
): Promise<string | null> {
    const payment = await prisma.payment.findFirst({
        where: { provider_transaction_id },
    });

    if (!payment) {
        logger.warn('Webhook: paiement introuvable', { provider_transaction_id });
        return null;
    }

    // Avoid double-processing
    if (payment.status === newStatus) {
        logger.info('Webhook: statut déjà à jour', { payment_ref: payment.payment_ref, status: newStatus });
        return payment.payment_ref;
    }

    // Build update data
    const updateData: Record<string, unknown> = { status: newStatus };

    if (newStatus === 'completed') {
        updateData.completed_at = extra?.completed_at || new Date();
        // Calculate net amount (amount - fee)
        const gross = Number(payment.amount);
        const fee = Number(payment.fee_amount || 0);
        updateData.net_amount = gross - fee;
    }

    if (newStatus === 'failed') {
        updateData.failed_at = extra?.failed_at || new Date();
        updateData.failure_reason = extra?.failure_reason;
    }

    if (newStatus === 'refunded') {
        updateData.refunded_at = extra?.refunded_at || new Date();
        if (extra?.refunded_amount) {
            updateData.refunded_amount = extra.refunded_amount;
        }
    }

    await prisma.payment.update({
        where: { id: payment.id },
        data: updateData as any,
    });

    logger.info('Webhook: paiement mis à jour', {
        payment_ref: payment.payment_ref,
        old_status: payment.status,
        new_status: newStatus,
        provider_transaction_id,
    });

    // Create transaction record for completed payments
    if (newStatus === 'completed') {
        const transactionRef = generateTransactionRef();
        await prisma.transaction.create({
            data: {
                transaction_ref: transactionRef,
                payment_id: payment.id,
                merchant_id: payment.merchant_id,
                type: 'credit',
                status: 'completed',
                amount: Number(payment.amount),
                currency: payment.currency as any,
                description: `Paiement ${payment.channel} — ${payment.payment_ref}`,
                metadata: {
                    provider_transaction_id,
                    channel: payment.channel,
                },
            },
        });

        // ─── Customer Synchronization ───
        if (payment.customer_email || payment.customer_phone) {
            // Find existing customer by email or phone for this merchant/environment
            const customerWhere = [];
            if (payment.customer_email) customerWhere.push({ email: payment.customer_email });
            if (payment.customer_phone) customerWhere.push({ phone: payment.customer_phone });

            let customer = await prisma.customer.findFirst({
                where: {
                    merchant_id: payment.merchant_id,
                    environment: payment.environment,
                    OR: customerWhere,
                },
            });

            if (customer) {
                // Update existing customer
                await prisma.customer.update({
                    where: { id: customer.id },
                    data: {
                        total_spent: { increment: Number(payment.amount) },
                        payment_count: { increment: 1 },
                        last_payment_at: new Date(),
                        // Update name if we didn't have one before
                        name: customer.name || payment.customer_name || null,
                    },
                });
            } else {
                // Create new customer
                customer = await prisma.customer.create({
                    data: {
                        merchant_id: payment.merchant_id,
                        environment: payment.environment,
                        email: payment.customer_email,
                        phone: payment.customer_phone,
                        name: payment.customer_name,
                        total_spent: Number(payment.amount),
                        payment_count: 1,
                        first_payment_at: new Date(),
                        last_payment_at: new Date(),
                    },
                });
            }

            // Link payment to this customer
            await prisma.payment.update({
                where: { id: payment.id },
                data: { customer_id: customer.id },
            });

            logger.info('Customer list mis à jour', { customer_id: customer.id, payment_ref: payment.payment_ref });
        }
    }

    return payment.payment_ref;
}

// ─────────────────────────────────────
// Webhook routes plugin
// ─────────────────────────────────────
export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {

    // ─────────────────────────────────────
    // Stripe Webhook
    // POST /v1/webhooks/stripe
    //
    // IMPORTANT: Stripe requires the RAW body buffer for HMAC signature
    // verification. We register a custom content-type parser for this route
    // that preserves the raw bytes before JSON parsing.
    // ─────────────────────────────────────
    fastify.post('/v1/webhooks/stripe', {
        config: {
            // Disable rate limiting for webhook endpoints
            rateLimit: false,
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const signature = request.headers['stripe-signature'] as string;

        if (!signature) {
            logger.warn('Stripe webhook: signature manquante');
            return reply.status(400).send({ error: 'Signature manquante' });
        }

        // Validate HMAC signature using raw body buffer
        let stripeEvent;
        try {
            stripeEvent = stripeService.validateWebhookSignature(
                request.rawBody as Buffer,
                signature
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.warn('Stripe webhook: signature invalide', { error: message });
            return reply.status(400).send({ error: 'Signature invalide' });
        }

        logger.info('Stripe webhook reçu', { type: stripeEvent.type, id: stripeEvent.id });

        // Route event to appropriate handler
        try {
            switch (stripeEvent.type) {
                // ─── Payment Succeeded ───
                case 'payment_intent.succeeded': {
                    const pi = stripeEvent.data.object as { id: string };
                    const payment_ref = await updatePaymentStatus(pi.id, 'completed', {
                        completed_at: new Date(),
                    });
                    if (payment_ref) {
                        await notificationService.dispatchPaymentEvent(payment_ref, 'payment.succeeded');
                    }
                    break;
                }

                // ─── Payment Failed ───
                case 'payment_intent.payment_failed': {
                    const pi = stripeEvent.data.object as {
                        id: string;
                        last_payment_error?: { message?: string };
                    };
                    const reason = pi.last_payment_error?.message || 'Échec de paiement Stripe';
                    const payment_ref = await updatePaymentStatus(pi.id, 'failed', {
                        failed_at: new Date(),
                        failure_reason: reason,
                    });
                    if (payment_ref) {
                        await notificationService.dispatchPaymentEvent(payment_ref, 'payment.failed');
                    }
                    break;
                }

                // ─── Payment Canceled ───
                case 'payment_intent.canceled': {
                    const pi = stripeEvent.data.object as { id: string };
                    const payment_ref = await updatePaymentStatus(pi.id, 'cancelled');
                    if (payment_ref) {
                        await notificationService.dispatchPaymentEvent(payment_ref, 'payment.cancelled');
                    }
                    break;
                }

                // ─── Refund ───
                case 'charge.refunded': {
                    const charge = stripeEvent.data.object as {
                        payment_intent: string;
                        amount_refunded: number;
                    };
                    if (charge.payment_intent) {
                        const payment_ref = await updatePaymentStatus(charge.payment_intent, 'refunded', {
                            refunded_at: new Date(),
                            refunded_amount: charge.amount_refunded / 100, // Stripe uses cents
                        });
                        if (payment_ref) {
                            await notificationService.dispatchPaymentEvent(payment_ref, 'payment.refunded');
                        }
                    }
                    break;
                }

                default:
                    logger.info('Stripe webhook: événement ignoré', { type: stripeEvent.type });
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.error('Erreur traitement webhook Stripe', { error: message, type: stripeEvent.type });
            // Always return 200 so Stripe doesn't retry — we log the error for ops
        }

        return reply.status(200).send({ received: true });
    });

    // ─────────────────────────────────────
    // MonCash Webhook
    // POST /v1/webhooks/moncash
    // ─────────────────────────────────────
    fastify.post('/v1/webhooks/moncash', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Record<string, unknown>;

        logger.info('MonCash webhook reçu', {
            transactionId: body.transactionId,
            orderId: body.orderId,
        });

        if (!body.transactionId || !body.orderId) {
            return reply.status(400).send({ error: 'Payload invalide' });
        }

        try {
            const transactionId = body.transactionId as string;
            const payment_ref = await updatePaymentStatus(transactionId, 'completed', {
                completed_at: new Date(),
            });
            if (payment_ref) {
                await notificationService.dispatchPaymentEvent(payment_ref, 'payment.succeeded');
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.error('Erreur traitement webhook MonCash', { error: message });
        }

        return reply.status(200).send({ received: true });
    });

    // ─────────────────────────────────────
    // NatCash Webhook
    // POST /v1/webhooks/natcash
    // ─────────────────────────────────────
    fastify.post('/v1/webhooks/natcash', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Record<string, unknown>;

        logger.info('NatCash webhook reçu', {
            transactionId: body.transactionId,
            status: body.status,
        });

        if (!body.transactionId) {
            return reply.status(400).send({ error: 'Payload invalide' });
        }

        try {
            const transactionId = body.transactionId as string;
            const natStatus = (body.status as string || '').toUpperCase();
            const newStatus = natStatus === 'SUCCESS' ? 'completed' : 'failed';

            const payment_ref = await updatePaymentStatus(transactionId, newStatus as 'completed' | 'failed', {
                completed_at: newStatus === 'completed' ? new Date() : undefined,
                failed_at: newStatus === 'failed' ? new Date() : undefined,
                failure_reason: newStatus === 'failed' ? (body.errorMessage as string) : undefined,
            });

            if (payment_ref) {
                const event = newStatus === 'completed' ? 'payment.succeeded' : 'payment.failed';
                await notificationService.dispatchPaymentEvent(payment_ref, event);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.error('Erreur traitement webhook NatCash', { error: message });
        }

        return reply.status(200).send({ received: true });
    });
}
