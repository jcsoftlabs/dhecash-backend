// ═══════════════════════════════════════
// DheCash — BullMQ Payment Queue
// Async payment processing workers
// NOTE: BullMQ bundles its own ioredis internally.
//       We pass the REDIS_URL string (not our Redis client instance)
//       to avoid ioredis version conflicts.
// ═══════════════════════════════════════

import { Queue, Worker, Job } from 'bullmq';
import { config } from '../../config';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { monCashService } from '../providers/moncash';
import { natCashService } from '../providers/natcash';
import { stripeService } from '../providers/stripe';

// ─────────────────────────────────────
// BullMQ uses its own bundled ioredis.
// Pass REDIS_URL string for connection.
// ─────────────────────────────────────
const redisConnection = { url: config.REDIS_URL };

// ─────────────────────────────────────
// Queue names
// ─────────────────────────────────────
export const QUEUES = {
    MONCASH: 'payments.moncash',
    NATCASH: 'payments.natcash',
    STRIPE: 'payments.stripe',
    DLQ: 'payments.dlq',
    WEBHOOK: 'notifications.webhooks',
} as const;

// ─────────────────────────────────────
// Job types
// ─────────────────────────────────────
export interface PaymentJobData {
    payment_ref: string;
    merchant_id: string;
    amount: number;
    currency: string;
    order_id?: string;
    description?: string;
    customer_phone?: string;
    customer_email?: string;
}

export interface WebhookJobData {
    webhook_config_id: string;
    payment_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    attempt: number;
}

// ─────────────────────────────────────
// Queue instances (BullMQ accepts URL string)
// ─────────────────────────────────────
export const monCashQueue = new Queue<PaymentJobData>(QUEUES.MONCASH, { connection: redisConnection });
export const natCashQueue = new Queue<PaymentJobData>(QUEUES.NATCASH, { connection: redisConnection });
export const stripeQueue = new Queue<PaymentJobData>(QUEUES.STRIPE, { connection: redisConnection });
export const dlqQueue = new Queue<PaymentJobData>(QUEUES.DLQ, { connection: redisConnection });
export const webhookQueue = new Queue<WebhookJobData>(QUEUES.WEBHOOK, { connection: redisConnection });

// ─────────────────────────────────────
// Payment processor — shared logic
// ─────────────────────────────────────
async function processPayment(
    job: Job<PaymentJobData>,
    provider: 'moncash' | 'natcash' | 'stripe'
): Promise<void> {
    const { payment_ref, merchant_id, amount, currency, order_id, description, customer_phone, customer_email } = job.data;

    logger.info(`⚙️  Traitement paiement ${provider}`, { payment_ref, amount, currency });

    // Mark payment as processing
    await prisma.payment.update({
        where: { payment_ref },
        data: { status: 'processing' },
    });

    try {
        let result: { provider_transaction_id: string; redirect_url: string; status: string };

        if (provider === 'moncash') {
            result = await monCashService.createPayment({
                amount, currency,
                orderId: order_id || payment_ref,
                paymentRef: payment_ref,
            });
        } else if (provider === 'natcash') {
            result = await natCashService.createPayment({
                amount, currency,
                orderId: order_id || payment_ref,
                paymentRef: payment_ref,
                customerPhone: customer_phone,
            });
        } else {
            result = await stripeService.createPayment({
                amount, currency, paymentRef: payment_ref, description, customerEmail: customer_email,
            });
        }

        // Update payment with provider details
        await prisma.payment.update({
            where: { payment_ref },
            data: {
                provider_transaction_id: result.provider_transaction_id,
                provider_redirect_url: result.redirect_url,
                // Status remains 'processing' until webhook/callback confirms completion
            },
        });

        logger.info(`✅ Paiement ${provider} initié`, {
            payment_ref,
            provider_transaction_id: result.provider_transaction_id,
        });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Erreur inconnue';
        logger.error(`❌ Échec paiement ${provider}`, { payment_ref, error: message });

        // Mark as failed
        await prisma.payment.update({
            where: { payment_ref },
            data: {
                status: 'failed',
                failed_at: new Date(),
                failure_reason: message,
            },
        });

        // Dispatch failure webhook (lazy import to avoid circular dep with notification)
        const { notificationService } = await import('../notification');
        await notificationService.dispatchPaymentEvent(payment_ref, 'payment.failed').catch((e: unknown) => {
            logger.error('Erreur dispatch webhook échec', { error: e instanceof Error ? e.message : 'Unknown' });
        });

        throw err; // Re-throw so BullMQ handles retry
    }
}

// ─────────────────────────────────────
// Workers
// ─────────────────────────────────────
export function startWorkers(): void {
    const workerOpts = {
        connection: redisConnection,
        concurrency: 5,
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
    };

    const monCashWorker = new Worker<PaymentJobData>(
        QUEUES.MONCASH,
        async (job) => processPayment(job, 'moncash'),
        workerOpts
    );

    const natCashWorker = new Worker<PaymentJobData>(
        QUEUES.NATCASH,
        async (job) => processPayment(job, 'natcash'),
        workerOpts
    );

    const stripeWorker = new Worker<PaymentJobData>(
        QUEUES.STRIPE,
        async (job) => processPayment(job, 'stripe'),
        workerOpts
    );

    // DLQ: log and alert on dead-letter queue items (all retries exhausted)
    const dlqWorker = new Worker<PaymentJobData>(
        QUEUES.DLQ,
        async (job) => {
            logger.error('💀 Paiement en DLQ — toutes tentatives échouées', {
                payment_ref: job.data.payment_ref,
                merchant_id: job.data.merchant_id,
                amount: job.data.amount,
            });
            // TODO: Alert ops team via email/Slack notifier
        },
        { connection: redisConnection }
    );

    // Webhook dispatching worker
    const webhookWorker = new Worker<WebhookJobData>(
        QUEUES.WEBHOOK,
        async (job) => {
            const { notificationService } = await import('../notification');
            await notificationService.deliverWebhook(job.data);
        },
        { ...workerOpts, concurrency: 10 }
    );

    // Attach event listeners to all workers
    const allWorkers = [monCashWorker, natCashWorker, stripeWorker, dlqWorker, webhookWorker];
    for (const worker of allWorkers) {
        worker.on('failed', (job, err) => {
            logger.error('Worker job échoué', {
                queue: worker.name,
                jobId: job?.id,
                error: err.message,
                attempt: job?.attemptsMade,
            });
        });

        worker.on('completed', (job) => {
            logger.info('Worker job terminé', { queue: worker.name, jobId: job.id });
        });
    }

    logger.info('✅ BullMQ workers démarrés', { queues: Object.values(QUEUES) });
}

// ─────────────────────────────────────
// Queue a payment for processing
// ─────────────────────────────────────
export async function queuePayment(
    channel: 'moncash' | 'natcash' | 'stripe',
    data: PaymentJobData
): Promise<void> {
    const queueMap: Record<string, Queue<PaymentJobData>> = {
        moncash: monCashQueue,
        natcash: natCashQueue,
        stripe: stripeQueue,
    };

    const queue = queueMap[channel];

    await queue.add(`pay_${channel}_${data.payment_ref}`, data, {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000, // 2s → 4s → 8s
        },
        removeOnFail: false, // Keep failed jobs for DLQ routing
    });

    logger.info(`📤 Paiement enqueued [${channel}]`, { payment_ref: data.payment_ref });
}
