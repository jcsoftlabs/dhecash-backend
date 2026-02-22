// ═══════════════════════════════════════
// DheCash — NatCash Payment Provider
// Adapter for NatCash API
// Same pattern as MonCash
// ═══════════════════════════════════════

import axios from 'axios';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { redis } from '../../../utils/redis';
import { ApiError } from '../../../utils/errors';

const NATCASH_TOKEN_KEY = 'natcash:access_token';

interface NatCashTokenResponse {
    access_token: string;
    expires_in: number;
    token_type: string;
}

export interface NatCashPaymentResult {
    provider_transaction_id: string;
    redirect_url: string;
    reference: string;
    status: 'pending' | 'completed' | 'failed';
}

class NatCashService {
    private async getAccessToken(): Promise<string> {
        const cached = await redis.get(NATCASH_TOKEN_KEY);
        if (cached) return cached;

        if (!config.NATCASH_CLIENT_ID || !config.NATCASH_CLIENT_SECRET) {
            throw new ApiError('PROVIDER_UNAVAILABLE');
        }

        try {
            const credentials = Buffer.from(
                `${config.NATCASH_CLIENT_ID}:${config.NATCASH_CLIENT_SECRET}`
            ).toString('base64');

            const response = await axios.post<NatCashTokenResponse>(
                `${config.NATCASH_BASE_URL}/oauth/token`,
                'grant_type=client_credentials',
                {
                    headers: {
                        Authorization: `Basic ${credentials}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    timeout: 10000,
                }
            );

            const { access_token, expires_in } = response.data;
            await redis.set(NATCASH_TOKEN_KEY, access_token, 'EX', expires_in - 60);

            logger.info('🔑 NatCash token OAuth2 obtenu');
            return access_token;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.error('Erreur obtention token NatCash', { error: message });
            throw new ApiError('PROVIDER_ERROR');
        }
    }

    async createPayment(params: {
        amount: number;
        currency: string;
        orderId: string;
        paymentRef: string;
        customerPhone?: string;
    }): Promise<NatCashPaymentResult> {
        if (!config.NATCASH_CLIENT_ID) {
            logger.warn('NatCash non configuré — mode sandbox simulé');
            return this.mockPayment(params.paymentRef);
        }

        try {
            const token = await this.getAccessToken();
            const htgAmount = params.currency === 'USD' ? params.amount * 140 : params.amount;

            const response = await axios.post(
                `${config.NATCASH_BASE_URL}/api/v1/payment/create`,
                {
                    amount: htgAmount,
                    orderId: params.orderId || params.paymentRef,
                    customerPhone: params.customerPhone,
                    callbackUrl: `${process.env.APP_URL || 'https://api.dhecash.com'}/v1/webhooks/natcash`,
                },
                {
                    headers: { Authorization: `Bearer ${token}` },
                    timeout: 30000,
                }
            );

            const { data } = response;
            logger.info('NatCash paiement créé', { transactionId: data.transactionId });

            return {
                provider_transaction_id: data.transactionId,
                redirect_url: data.paymentUrl || `${config.NATCASH_BASE_URL}/pay/${data.transactionId}`,
                reference: data.reference || params.paymentRef,
                status: 'pending',
            };
        } catch (err: unknown) {
            if (err instanceof ApiError) throw err;
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.error('Erreur création paiement NatCash', { error: message });
            if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') {
                throw new ApiError('PROVIDER_TIMEOUT');
            }
            throw new ApiError('PROVIDER_ERROR');
        }
    }

    async getPaymentStatus(transactionId: string): Promise<{
        status: 'completed' | 'pending' | 'failed';
    }> {
        if (!config.NATCASH_CLIENT_ID) {
            return { status: 'completed' };
        }

        try {
            const token = await this.getAccessToken();
            const response = await axios.get(
                `${config.NATCASH_BASE_URL}/api/v1/payment/${transactionId}`,
                { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
            );

            const statusMap: Record<string, 'completed' | 'pending' | 'failed'> = {
                SUCCESS: 'completed',
                PENDING: 'pending',
                FAILED: 'failed',
                CANCELLED: 'failed',
            };

            return { status: statusMap[response.data.status] || 'failed' };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown';
            logger.error('Erreur vérification statut NatCash', { error: message, transactionId });
            return { status: 'failed' };
        }
    }

    private mockPayment(paymentRef: string): NatCashPaymentResult {
        const mockTxId = `MOCK_NCX_${Date.now()}`;
        return {
            provider_transaction_id: mockTxId,
            redirect_url: `https://sandbox.natcash.com/pay/mock_${mockTxId}`,
            reference: paymentRef,
            status: 'pending',
        };
    }
}

export const natCashService = new NatCashService();
