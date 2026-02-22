// ═══════════════════════════════════════
// DheCash — Notification Service
// Webhook delivery with HMAC signatures
// ═══════════════════════════════════════

import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import type { WebhookJobData } from '../queue';

// ─────────────────────────────────────
// Event payload builders
// ─────────────────────────────────────
const EVENT_VERSION = '1.0';

function buildPayload(
    event_type: string,
    data: Record<string, unknown>
): Record<string, unknown> {
    return {
        api_version: EVENT_VERSION,
        event_type,
        created_at: new Date().toISOString(),
        data,
    };
}

// ─────────────────────────────────────
// HMAC-SHA256 webhook signature
// Header: DheCash-Signature: t={timestamp},v1={hmac}
// ─────────────────────────────────────
function signPayload(secret: string, payload: string, timestamp: number): string {
    const message = `${timestamp}.${payload}`;
    const hmac = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return `t=${timestamp},v1=${hmac}`;
}

// ─────────────────────────────────────
// Notification Service
// ─────────────────────────────────────
export const notificationService = {
    // ─────────────────────────────────────
    // Dispatch payment event to all configured webhooks for a merchant
    // ─────────────────────────────────────
    async dispatchPaymentEvent(payment_ref: string, event_type: string): Promise<void> {
        const payment = await prisma.payment.findUnique({
            where: { payment_ref },
            include: {
                merchant: {
                    include: {
                        webhook_configs: {
                            where: { is_active: true },
                        },
                    },
                },
            },
        });

        if (!payment) {
            logger.warn('dispatchPaymentEvent: paiement introuvable', { payment_ref, event_type });
            return;
        }

        // Filter webhooks subscribed to this event
        const subscribedWebhooks = payment.merchant.webhook_configs.filter(
            (wh: { events: unknown }) => {
                const events = wh.events as string[];
                return events.includes(event_type) || events.includes('*');
            }
        );

        if (subscribedWebhooks.length === 0) {
            logger.info('Aucun webhook souscrit', { event_type, merchant_id: payment.merchant_id });
            return;
        }

        const payload = buildPayload(event_type, {
            payment_ref: payment.payment_ref,
            order_id: payment.order_id,
            channel: payment.channel,
            status: payment.status,
            amount: Number(payment.amount),
            currency: payment.currency,
            fee_amount: Number(payment.fee_amount || 0),
            net_amount: Number(payment.net_amount || 0),
            provider_transaction_id: payment.provider_transaction_id,
            created_at: payment.created_at,
            completed_at: payment.completed_at,
            failed_at: payment.failed_at,
            failure_reason: payment.failure_reason,
        });

        // Lazy import to avoid circular dependency with queue/index.ts
        const { webhookQueue } = await import('../queue');

        for (const webhook of subscribedWebhooks) {
            // Create DB log entry
            const log = await prisma.webhookLog.create({
                data: {
                    webhook_config_id: webhook.id,
                    payment_id: payment.id,
                    event_type,
                    payload: payload as any,
                    status: 'pending',
                },
            });

            // Queue delivery with retry
            await webhookQueue.add(`${event_type}_${log.id}`, {
                webhook_config_id: webhook.id,
                payment_id: payment.id,
                event_type,
                payload,
                attempt: 1,
            }, {
                attempts: 5,
                backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s, 40s, 80s
            });
        }

        logger.info('Événement webhook dispatché', {
            event_type,
            payment_ref,
            webhook_count: subscribedWebhooks.length,
        });
    },

    // ─────────────────────────────────────
    // Deliver a single webhook (called by queue worker)
    // ─────────────────────────────────────
    async deliverWebhook(data: WebhookJobData): Promise<void> {
        const { webhook_config_id, payment_id, event_type, payload, attempt } = data;

        const webhookConfig = await prisma.webhookConfig.findUnique({
            where: { id: webhook_config_id },
        });

        if (!webhookConfig || !webhookConfig.is_active) {
            logger.warn('Webhook config introuvable ou désactivée', { webhook_config_id });
            return;
        }

        const payloadString = JSON.stringify(payload);
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = signPayload(webhookConfig.secret, payloadString, timestamp);

        let httpStatus: number | undefined;
        let responseBody: string | undefined;
        let deliveredAt: Date | undefined;
        let newStatus: 'delivered' | 'failed' = 'failed';

        try {
            const response = await axios.post(webhookConfig.url, payload, {
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'DheCash-Webhook/1.0',
                    'DheCash-Signature': signature,
                    'DheCash-Event-Type': event_type,
                    'DheCash-Timestamp': String(timestamp),
                },
                validateStatus: (status: number) => status >= 200 && status < 300,
            });

            httpStatus = response.status;
            responseBody = JSON.stringify(response.data).substring(0, 500);
            newStatus = 'delivered';
            deliveredAt = new Date();

            logger.info('Webhook livré', {
                webhook_config_id,
                url: webhookConfig.url,
                event_type,
                status: httpStatus,
            });

        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                httpStatus = err.response?.status;
                responseBody = err.message.substring(0, 500);
            }

            logger.warn('Échec livraison webhook', {
                webhook_config_id,
                url: webhookConfig.url,
                event_type,
                attempt,
                error: err instanceof Error ? err.message : 'Unknown',
            });

            throw err; // Re-throw so BullMQ retries
        } finally {
            // Always update the webhook log
            const log = await prisma.webhookLog.findFirst({
                where: { webhook_config_id, payment_id, event_type },
                orderBy: { created_at: 'desc' },
            });

            if (log) {
                await prisma.webhookLog.update({
                    where: { id: log.id },
                    data: {
                        status: newStatus,
                        http_status: httpStatus,
                        response_body: responseBody,
                        attempt_count: attempt,
                        last_attempt_at: new Date(),
                        delivered_at: deliveredAt,
                    },
                });
            }
        }
    },
};
