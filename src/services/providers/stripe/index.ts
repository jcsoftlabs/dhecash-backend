// ═══════════════════════════════════════
// DheCash — Stripe Payment Provider
// Stripe Cards Integration
// ═══════════════════════════════════════

import Stripe from 'stripe';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { ApiError } from '../../../utils/errors';

let stripeClient: Stripe | null = null;

function getStripeClient(): Stripe {
    if (!stripeClient) {
        if (!config.STRIPE_SECRET_KEY) {
            throw new ApiError('PROVIDER_UNAVAILABLE');
        }
        stripeClient = new Stripe(config.STRIPE_SECRET_KEY, {
            apiVersion: '2024-06-20',
        });
    }
    return stripeClient;
}

export interface StripePaymentResult {
    provider_transaction_id: string;
    redirect_url: string;
    client_secret: string;
    status: 'pending' | 'completed' | 'failed';
}

export const stripeService = {
    // ─────────────────────────────────────
    // Create PaymentIntent
    // ─────────────────────────────────────
    async createPayment(params: {
        amount: number;
        currency: string;
        paymentRef: string;
        description?: string;
        customerEmail?: string;
        metadata?: Record<string, string>;
    }): Promise<StripePaymentResult> {
        if (!config.STRIPE_SECRET_KEY) {
            logger.warn('Stripe non configuré — mode mock');
            return {
                provider_transaction_id: `pi_mock_${Date.now()}`,
                redirect_url: `https://checkout.stripe.com/pay/mock`,
                client_secret: `pi_mock_${Date.now()}_secret_mock`,
                status: 'pending',
            };
        }

        try {
            const stripe = getStripeClient();

            // Stripe works in cents/smallest currency unit
            const amountInCents = Math.round(params.amount * 100);

            // Create PaymentIntent
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amountInCents,
                currency: params.currency.toLowerCase(),
                description: params.description,
                receipt_email: params.customerEmail,
                metadata: {
                    dhecash_ref: params.paymentRef,
                    ...params.metadata,
                },
                automatic_payment_methods: { enabled: true },
            });

            logger.info('Stripe PaymentIntent créé', {
                id: paymentIntent.id,
                amount: params.amount,
                currency: params.currency,
            });

            return {
                provider_transaction_id: paymentIntent.id,
                redirect_url: `https://pay.dhecash.com/stripe/${paymentIntent.id}`,
                client_secret: (paymentIntent.client_secret as string),
                status: 'pending',
            };
        } catch (err: unknown) {
            if (err instanceof ApiError) throw err;
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.error('Erreur création PaymentIntent Stripe', { error: message });
            throw new ApiError('PROVIDER_ERROR');
        }
    },

    // ─────────────────────────────────────
    // Create Refund
    // ─────────────────────────────────────
    async createRefund(params: {
        paymentIntentId: string;
        amount: number;
        reason?: string;
    }): Promise<{ refundId: string; status: string }> {
        try {
            const stripe = getStripeClient();
            const refund = await stripe.refunds.create({
                payment_intent: params.paymentIntentId,
                amount: Math.round(params.amount * 100),
                reason: 'requested_by_customer',
                metadata: { reason: params.reason || 'Remboursement client' },
            });

            logger.info('Stripe remboursement créé', { refundId: refund.id });

            return { refundId: refund.id, status: refund.status as string };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.error('Erreur remboursement Stripe', { error: message });
            throw new ApiError('PROVIDER_ERROR');
        }
    },

    // ─────────────────────────────────────
    // Validate Stripe Webhook Signature
    // ─────────────────────────────────────
    validateWebhookSignature(payload: Buffer, signature: string): Stripe.Event {
        try {
            const stripe = getStripeClient();
            return stripe.webhooks.constructEvent(
                payload,
                signature,
                config.STRIPE_WEBHOOK_SECRET
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.warn('Signature webhook Stripe invalide', { error: message });
            throw new ApiError('TOKEN_INVALID');
        }
    },

    // ─────────────────────────────────────
    // Map Stripe event to DheCash status
    // ─────────────────────────────────────
    mapEventToStatus(eventType: string): string | null {
        const map: Record<string, string> = {
            'payment_intent.succeeded': 'completed',
            'payment_intent.payment_failed': 'failed',
            'payment_intent.canceled': 'cancelled',
            'charge.refunded': 'refunded',
        };
        return map[eventType] || null;
    },
};
