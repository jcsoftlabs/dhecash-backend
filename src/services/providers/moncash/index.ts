// ═══════════════════════════════════════
// DheCash — MonCash Payment Provider
// Adapter for Digicel MonCash API
// ═══════════════════════════════════════

import axios, { AxiosInstance } from 'axios';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { redis } from '../../../utils/redis';
import { ApiError } from '../../../utils/errors';

const MONCASH_TOKEN_KEY = 'moncash:access_token';

interface MonCashTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    jti: string;
}

interface MonCashCreatePaymentResponse {
    mode: string;
    path: string;
    payment_token?: {
        expired: string;
        created: string;
        token: string;
    };
    payment?: { // Fallback for older API versions
        Reference: string;
        transactionId: string;
        cost: number;
        message: string;
        payer: string;
    };
    timestamp: number;
    status: number;
}

interface MonCashPaymentStatusResponse {
    payment: {
        transactionId: string;
        cost: number;
        message: string;
        payer: string;
        Reference: string;
    };
    timestamp: number;
    status: number;
}

export interface MonCashPaymentResult {
    provider_transaction_id: string;
    redirect_url: string;
    reference: string;
    status: 'pending' | 'completed' | 'failed';
}

class MonCashService {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: config.MONCASH_BASE_URL,
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ─────────────────────────────────────
    // OAuth2 token management (cached in Redis)
    // ─────────────────────────────────────
    private async getAccessToken(): Promise<string> {
        // Check Redis cache first
        const cached = await redis.get(MONCASH_TOKEN_KEY);
        if (cached) return cached;

        if (!config.MONCASH_CLIENT_ID || !config.MONCASH_CLIENT_SECRET) {
            throw new ApiError('PROVIDER_UNAVAILABLE');
        }

        try {
            const credentials = Buffer.from(
                `${config.MONCASH_CLIENT_ID}:${config.MONCASH_CLIENT_SECRET}`
            ).toString('base64');

            const response = await axios.post<MonCashTokenResponse>(
                `${config.MONCASH_BASE_URL}/Api/oauth/token`,
                'scope=read,write&grant_type=client_credentials',
                {
                    headers: {
                        Authorization: `Basic ${credentials}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    timeout: 10000,
                }
            );

            const { access_token, expires_in } = response.data;

            // Cache with 60-second buffer before real expiry
            await redis.set(MONCASH_TOKEN_KEY, access_token, 'EX', expires_in - 60);
            logger.info('🔑 MonCash token OAuth2 obtenu');

            return access_token;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            logger.error('Erreur obtention token MonCash', { error: message });
            throw new ApiError('PROVIDER_ERROR');
        }
    }

    // ─────────────────────────────────────
    // Create a MonCash payment
    // ─────────────────────────────────────
    async createPayment(params: {
        amount: number;
        currency: string;
        orderId: string;
        paymentRef: string;
    }): Promise<MonCashPaymentResult> {
        // Validate credentials are configured
        if (!config.MONCASH_CLIENT_ID) {
            logger.warn('MonCash non configuré — mode sandbox simulé');
            return this.mockPayment(params.paymentRef);
        }

        try {
            const token = await this.getAccessToken();

            // MonCash only accepts HTG, convert if needed
            const htgAmount = params.currency === 'USD'
                ? params.amount * 140 // Approximate USD→HTG rate
                : params.amount;

            const response = await this.client.post<MonCashCreatePaymentResponse>(
                '/Api/v1/CreatePayment',
                {
                    amount: htgAmount,
                    orderId: params.orderId || params.paymentRef,
                },
                {
                    headers: { Authorization: `Bearer ${token}` },
                }
            );

            const { payment, payment_token } = response.data;
            let transactionId = '';
            let reference = params.orderId || params.paymentRef;
            let redirectUrl = '';

            if (payment_token && payment_token.token) {
                // Parse JWT to extract transaction ID (id field)
                try {
                    const payloadB64 = payment_token.token.split('.')[1];
                    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
                    transactionId = payload.id;
                    reference = payload.ref || reference;
                } catch (e) {
                    logger.warn('MonCash: failed to parse payment_token JWT', { token: payment_token.token });
                }
                // Build redirect URL according to Digicel doc
                redirectUrl = `${config.MONCASH_BASE_URL}/Moncash-middleware/Checkout/Payment/Redirect?token=${payment_token.token}`;
            } else if (payment) {
                transactionId = payment.transactionId;
                reference = payment.Reference || reference;
                redirectUrl = `${config.MONCASH_BASE_URL}${response.data.path}?token=${payment.transactionId}`; // fallback
            } else {
                throw new Error('Invalid MonCash response structure');
            }

            logger.info('MonCash paiement créé', {
                transactionId,
                reference,
                amount: htgAmount,
            });

            return {
                provider_transaction_id: transactionId,
                redirect_url: redirectUrl,
                reference: reference,
                status: 'pending',
            };
        } catch (err: unknown) {
            if (err instanceof ApiError) throw err;
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.error('Erreur création paiement MonCash', { error: message });
            if (axios.isAxiosError(err) && err.response?.status === 408) {
                throw new ApiError('PROVIDER_TIMEOUT');
            }
            throw new ApiError('PROVIDER_ERROR');
        }
    }

    // ─────────────────────────────────────
    // Check payment status
    // ─────────────────────────────────────
    async getPaymentStatus(transactionId: string): Promise<{
        status: 'completed' | 'pending' | 'failed';
        payer?: string;
    }> {
        if (!config.MONCASH_CLIENT_ID) {
            return { status: 'completed', payer: '+509-mock-number' };
        }

        try {
            const token = await this.getAccessToken();
            const response = await this.client.post<MonCashPaymentStatusResponse>(
                '/Api/v1/RetrieveTransactionPayment',
                { transactionId },
                { headers: { Authorization: `Bearer ${token}` } }
            );

            const { payment, status } = response.data;
            return {
                status: status === 200 ? 'completed' : 'failed',
                payer: payment.payer,
            };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.error('Erreur vérification statut MonCash', { error: message, transactionId });
            return { status: 'failed' };
        }
    }

    // ─────────────────────────────────────
    // Validate MonCash webhook (HMAC signature)
    // MonCash sends payment notifications to our webhook URL
    // ─────────────────────────────────────
    validateWebhookPayload(payload: Record<string, unknown>): boolean {
        // MonCash doesn't use HMAC signatures — validate by checking required fields
        return !!(
            payload.transactionId &&
            payload.orderId &&
            typeof payload.amount === 'number'
        );
    }

    // ─────────────────────────────────────
    // Mock payment for sandbox/unconfigured mode
    // ─────────────────────────────────────
    private mockPayment(paymentRef: string): MonCashPaymentResult {
        const mockTxId = `MOCK_MCX_${Date.now()}`;
        return {
            provider_transaction_id: mockTxId,
            redirect_url: `https://sandbox.moncashbutton.digicelgroup.com/Moncash-business/Payment/Init?token=mock_${mockTxId}`,
            reference: paymentRef,
            status: 'pending',
        };
    }
}

export const monCashService = new MonCashService();
