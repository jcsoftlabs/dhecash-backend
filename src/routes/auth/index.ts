// ═══════════════════════════════════════
// DheCash — Auth Routes
// POST /v1/auth/register, login, refresh, logout
// ═══════════════════════════════════════

import { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { ApiError, successResponse } from '../../utils/errors';
import { registerSchema, loginSchema, refreshTokenSchema, verifyEmailSchema } from '../../schemas';
import { generateApiKeyId, generateApiSecret } from '../../utils/ids';
import {
    generateAccessToken,
    generateRefreshToken,
    verifyRefreshToken,
    jwtAuth,
    blacklistToken,
    revokeRefreshToken,
    AuthenticatedRequest,
} from '../../plugins/auth';

const BCRYPT_COST = 12;

export async function authRoutes(fastify: FastifyInstance) {
    // ─────────────────────────────────────
    // POST /v1/auth/register
    // ─────────────────────────────────────
    fastify.post('/v1/auth/register', async (request, reply) => {
        const parsed = registerSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const { email, password, type, phone, first_name, last_name, business_name, legal_name } = parsed.data;

        // Check if merchant exists
        const existing = await prisma.merchant.findUnique({ where: { email } });
        if (existing) {
            throw new ApiError('MERCHANT_ALREADY_EXISTS');
        }

        // Hash password
        const password_hash = await bcrypt.hash(password, BCRYPT_COST);

        // Generate email verification token
        const email_verify_token = require('crypto').randomBytes(32).toString('hex');
        const email_verify_expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

        // Create merchant
        const merchant = await prisma.merchant.create({
            data: {
                email,
                password_hash,
                phone,
                type,
                first_name,
                last_name,
                business_name,
                legal_name,
                email_verify_token,
                email_verify_expires,
            },
            select: {
                id: true,
                email: true,
                type: true,
                status: true,
                created_at: true,
            },
        });

        // Generate initial API key for the new merchant account
        const keyId = generateApiKeyId('live');
        const secret = generateApiSecret('live');
        const secret_hash = await bcrypt.hash(secret, BCRYPT_COST);
        const secretPayload = secret.replace('sk_live_', '');
        const secret_prefix = secretPayload.substring(0, 8);

        await prisma.apiKey.create({
            data: {
                merchant_id: merchant.id,
                key_id: keyId,
                secret_hash,
                secret_prefix,
                environment: 'live',
                label: 'Clé par défaut',
            },
        });

        // Generate tokens
        const access_token = generateAccessToken({
            merchant_id: merchant.id,
            email: merchant.email,
            role: 'owner',
        });
        const refresh_token = await generateRefreshToken({
            merchant_id: merchant.id,
            email: merchant.email,
            role: 'owner',
        });

        logger.info('Nouveau marchand enregistré', {
            merchant_id: merchant.id,
            type: merchant.type,
        });

        reply.status(201).send(successResponse({
            merchant,
            api_keys: {
                key_id: keyId,
                secret: secret, // Only shown ONCE at creation
                environment: 'live',
            },
            tokens: {
                access_token,
                refresh_token,
                expires_in: '15m',
            },
            email_verification: {
                token: email_verify_token, // In production, send this via email
                message: 'Un email de vérification a été envoyé.',
            },
        }));
    });

    // ─────────────────────────────────────
    // POST /v1/auth/login
    // ─────────────────────────────────────
    fastify.post('/v1/auth/login', async (request, reply) => {
        const parsed = loginSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const { email, password } = parsed.data;

        const merchant = await prisma.merchant.findUnique({
            where: { email },
            select: {
                id: true,
                email: true,
                password_hash: true,
                role: true,
                status: true,
                type: true,
                first_name: true,
                last_name: true,
                business_name: true,
            },
        });

        if (!merchant) {
            throw new ApiError('INVALID_CREDENTIALS');
        }

        const valid = await bcrypt.compare(password, merchant.password_hash);
        if (!valid) {
            logger.warn('Tentative de connexion échouée', { email });
            throw new ApiError('INVALID_CREDENTIALS');
        }

        if (merchant.status === 'suspended') {
            throw new ApiError('MERCHANT_SUSPENDED');
        }

        const access_token = generateAccessToken({
            merchant_id: merchant.id,
            email: merchant.email,
            role: merchant.role,
        });
        const refresh_token = await generateRefreshToken({
            merchant_id: merchant.id,
            email: merchant.email,
            role: merchant.role,
        });

        logger.info('Connexion réussie', { merchant_id: merchant.id });

        reply.send(successResponse({
            merchant: {
                id: merchant.id,
                email: merchant.email,
                type: merchant.type,
                status: merchant.status,
                role: merchant.role,
                name: merchant.type === 'business'
                    ? merchant.business_name
                    : `${merchant.first_name} ${merchant.last_name}`,
            },
            tokens: {
                access_token,
                refresh_token,
                expires_in: '15m',
            },
        }));
    });

    // ─────────────────────────────────────
    // POST /v1/auth/refresh
    // ─────────────────────────────────────
    fastify.post('/v1/auth/refresh', async (request, reply) => {
        const parsed = refreshTokenSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const payload = await verifyRefreshToken(parsed.data.refresh_token);

        const access_token = generateAccessToken({
            merchant_id: payload.merchant_id,
            email: payload.email,
            role: payload.role,
        });
        const refresh_token = await generateRefreshToken({
            merchant_id: payload.merchant_id,
            email: payload.email,
            role: payload.role,
        });

        reply.send(successResponse({
            tokens: {
                access_token,
                refresh_token,
                expires_in: '15m',
            },
        }));
    });

    // ─────────────────────────────────────
    // POST /v1/auth/logout
    // ─────────────────────────────────────
    fastify.post('/v1/auth/logout', {
        preHandler: [jwtAuth as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const token = request.headers.authorization!.substring(7);

        // Blacklist access token
        await blacklistToken(token);

        // Revoke refresh token
        if (request.merchant) {
            await revokeRefreshToken(request.merchant.id);
        }

        logger.info('Déconnexion réussie', { merchant_id: request.merchant?.id });

        reply.send(successResponse({ message: 'Déconnexion réussie' }));
    });

    // ─────────────────────────────────────
    // POST /v1/auth/verify-email
    // ─────────────────────────────────────
    fastify.post('/v1/auth/verify-email', async (request, reply) => {
        const parsed = verifyEmailSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR');
        }

        const merchant = await prisma.merchant.findFirst({
            where: {
                email_verify_token: parsed.data.token,
                email_verify_expires: { gte: new Date() },
            },
        });

        if (!merchant) {
            throw new ApiError('TOKEN_INVALID');
        }

        await prisma.merchant.update({
            where: { id: merchant.id },
            data: {
                email_verified: true,
                email_verify_token: null,
                email_verify_expires: null,
            },
        });

        logger.info('Email vérifié', { merchant_id: merchant.id });

        reply.send(successResponse({ message: 'Email vérifié avec succès' }));
    });
}
