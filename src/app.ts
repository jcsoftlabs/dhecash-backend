// ═══════════════════════════════════════
// DheCash — Fastify Application Bootstrap
// ═══════════════════════════════════════

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { logger } from './utils/logger';
import { ApiError } from './utils/errors';
import { redis } from './utils/redis';

// Routes
import { authRoutes } from './routes/auth';
import { paymentRoutes } from './routes/payments';
import { transactionRoutes } from './routes/transactions';
import { merchantRoutes } from './routes/merchants';

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: false, // We use Winston
        trustProxy: true,
    });

    // ─────────────────────────────────────
    // Security plugins
    // ─────────────────────────────────────
    await app.register(cors, {
        origin: config.CORS_ORIGIN.split(','),
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
        credentials: true,
    });

    await app.register(helmet, {
        contentSecurityPolicy: false,
    });

    // ─────────────────────────────────────
    // Rate limiting
    // ─────────────────────────────────────
    await app.register(rateLimit, {
        max: 100,
        timeWindow: '1 minute',
        keyGenerator: (request) => {
            // Use API key or IP for rate limiting
            const authHeader = request.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                return `api:${authHeader.substring(7, 30)}`; // Use first chars as key id
            }
            return `ip:${request.ip}`;
        },
        errorResponseBuilder: (request, context) => ({
            error: {
                code: 'RATE_LIMIT_EXCEEDED',
                message: 'Limite de requêtes dépassée. Réessayez plus tard.',
                details: {
                    retry_after: Math.ceil(context.ttl / 1000),
                },
            },
        }),
    });

    // ─────────────────────────────────────
    // Health check
    // ─────────────────────────────────────
    app.get('/health', async (request, reply) => {
        return {
            status: 'ok',
            service: 'dhecash-gateway',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
        };
    });

    // ─────────────────────────────────────
    // API info
    // ─────────────────────────────────────
    app.get('/', async (request, reply) => {
        return {
            name: 'DheCash Payment Gateway API',
            version: '1.0.0',
            documentation: '/v1/docs',
            status: 'live',
        };
    });

    // ─────────────────────────────────────
    // Register routes
    // ─────────────────────────────────────
    await app.register(authRoutes);
    await app.register(paymentRoutes);
    await app.register(transactionRoutes);
    await app.register(merchantRoutes);

    // ─────────────────────────────────────
    // Global error handler
    // ─────────────────────────────────────
    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ApiError) {
            logger.warn('Erreur API', {
                code: error.code,
                status: error.statusCode,
                path: request.url,
                method: request.method,
            });
            return reply.status(error.statusCode).send(error.toJSON());
        }

        // Fastify validation errors
        if (error.validation) {
            return reply.status(400).send({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Erreur de validation',
                    details: error.validation,
                },
            });
        }

        // Rate limit errors
        if (error.statusCode === 429) {
            return reply.status(429).send({
                error: {
                    code: 'RATE_LIMIT_EXCEEDED',
                    message: 'Limite de requêtes dépassée. Réessayez plus tard.',
                },
            });
        }

        // Unexpected errors
        logger.error('Erreur inattendue', {
            error: error.message,
            stack: error.stack,
            path: request.url,
            method: request.method,
        });

        return reply.status(500).send({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Erreur interne du serveur',
            },
        });
    });

    // 404 handler
    app.setNotFoundHandler((request, reply) => {
        reply.status(404).send({
            error: {
                code: 'NOT_FOUND',
                message: 'Ressource introuvable',
            },
        });
    });

    return app;
}
