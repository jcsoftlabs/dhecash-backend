// ═══════════════════════════════════════
// DheCash — JWT Authentication Plugin
// Fastify plugin for JWT + API Key auth
// ═══════════════════════════════════════

import { FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { ApiError } from '../utils/errors';
import { MerchantRole } from '@prisma/client';

// ─────────────────────────────────────
// Types
// ─────────────────────────────────────
export interface JwtPayload {
    merchant_id: string;
    email: string;
    role: MerchantRole;
    type: 'access' | 'refresh';
    iat?: number;
    exp?: number;
}

export interface AuthenticatedRequest extends FastifyRequest {
    merchant?: {
        id: string;
        email: string;
        role: MerchantRole;
        type: string;
        environment: string;
    };
    apiKey?: {
        id: string;
        merchant_id: string;
        environment: string;
    };
}

// ─────────────────────────────────────
// Permission map
// ─────────────────────────────────────
const ROLE_PERMISSIONS: Record<MerchantRole, string[]> = {
    owner: ['*'], // All permissions
    super_admin: ['*'], // Complete platform access
    admin: [
        'payments:read', 'payments:write', 'payments:refund',
        'transactions:read', 'transactions:export',
        'api_keys:read', 'api_keys:write',
        'webhooks:read', 'webhooks:write',
        'team:read', 'team:write',
        'settings:read', 'settings:write',
        'analytics:read',
        'kyc:read', 'kyc:write',
    ],
    developer: [
        'payments:read', 'payments:write',
        'transactions:read',
        'api_keys:read',
        'webhooks:read',
        'analytics:read',
    ],
};

// ─────────────────────────────────────
// Token generation
// ─────────────────────────────────────
export const generateAccessToken = (payload: Omit<JwtPayload, 'type' | 'iat' | 'exp'>): string => {
    return jwt.sign({ ...payload, type: 'access' }, config.JWT_ACCESS_SECRET, {
        expiresIn: config.JWT_ACCESS_EXPIRY as any,
    });
};

export const generateRefreshToken = async (payload: Omit<JwtPayload, 'type' | 'iat' | 'exp'>): Promise<string> => {
    const token = jwt.sign({ ...payload, type: 'refresh' }, config.JWT_REFRESH_SECRET, {
        expiresIn: config.JWT_REFRESH_EXPIRY as any,
    });
    // Store in Redis (token rotation — only ONE valid refresh token per merchant)
    await redis.set(
        `refresh:${payload.merchant_id}`,
        token,
        'EX',
        7 * 24 * 60 * 60 // 7 days
    );
    return token;
};

export const verifyAccessToken = (token: string): JwtPayload => {
    try {
        const payload = jwt.verify(token, config.JWT_ACCESS_SECRET) as JwtPayload;
        if (payload.type !== 'access') {
            throw new ApiError('TOKEN_INVALID');
        }
        return payload;
    } catch (err: unknown) {
        if (err instanceof ApiError) throw err;
        if (err instanceof Error && err.name === 'TokenExpiredError') throw new ApiError('TOKEN_EXPIRED');
        throw new ApiError('TOKEN_INVALID');
    }
};

export const verifyRefreshToken = async (token: string): Promise<JwtPayload> => {
    try {
        const payload = jwt.verify(token, config.JWT_REFRESH_SECRET) as JwtPayload;
        if (payload.type !== 'refresh') {
            throw new ApiError('REFRESH_TOKEN_INVALID');
        }
        // Check if still valid in Redis (supports single-device revocation)
        const stored = await redis.get(`refresh:${payload.merchant_id}`);
        if (!stored || stored !== token) {
            throw new ApiError('REFRESH_TOKEN_INVALID');
        }
        return payload;
    } catch (err: unknown) {
        if (err instanceof ApiError) throw err;
        throw new ApiError('REFRESH_TOKEN_INVALID');
    }
};

// ─────────────────────────────────────
// Middleware: JWT Auth (Dashboard)
// ─────────────────────────────────────
export const jwtAuth = async (request: AuthenticatedRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new ApiError('AUTH_REQUIRED');
    }

    const token = authHeader.substring(7);

    // Check if token is blacklisted
    const isBlacklisted = await redis.get(`blacklist:${token}`);
    if (isBlacklisted) {
        throw new ApiError('TOKEN_INVALID');
    }

    const payload = verifyAccessToken(token);

    // Check merchant exists and is active
    const merchant = await prisma.merchant.findUnique({
        where: { id: payload.merchant_id },
        select: { id: true, email: true, role: true, status: true, type: true },
    });

    if (!merchant) {
        throw new ApiError('MERCHANT_NOT_FOUND');
    }

    if (merchant.status === 'suspended') {
        throw new ApiError('MERCHANT_SUSPENDED');
    }

    // Extract environment from header (sent by dashboard), default to 'live'
    const envHeader = request.headers['x-dhecash-environment'];
    const environment = typeof envHeader === 'string' && envHeader === 'test' ? 'test' : 'live';

    request.merchant = {
        id: merchant.id,
        email: merchant.email,
        role: merchant.role,
        type: merchant.type,
        environment,
    };
};

// ─────────────────────────────────────
// Middleware: API Key Auth (Programmatic)
//
// Security design:
//   Bearer Header = "sk_live_<21chars>"
//   The key_id (pk_live_xxx) is stored plaintext; we look it up from the secret prefix.
//   Secret format: sk_{env}_{payload}  — we store an indexed prefix (first 12 chars of payload)
//   so we can do a DB lookup before bcrypt, avoiding O(n) full scan.
//
// Lookup strategy:
//   1. Parse env from prefix (sk_live_ | sk_test_)
//   2. Use raw_prefix column (first 8 chars of the generated nanoid) stored at key creation
//   3. Bcrypt compare only the matching candidates (usually 1)
// ─────────────────────────────────────
export const apiKeyAuth = async (request: AuthenticatedRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new ApiError('AUTH_REQUIRED');
    }

    const apiSecret = authHeader.substring(7);

    // Validate format: sk_live_XXX or sk_test_XXX
    const match = apiSecret.match(/^sk_(live|test)_(.+)$/);
    if (!match) {
        throw new ApiError('API_KEY_INVALID');
    }

    const [, env, secretPayload] = match;

    // Use the first 8 chars of the secret payload as a lookup prefix (stored in secret_prefix column)
    // This narrows the bcrypt candidates from ALL keys to typically 1-2
    const secretPrefix = secretPayload.substring(0, 8);

    const candidates = await prisma.apiKey.findMany({
        where: {
            is_active: true,
            revoked_at: null,
            environment: env as any,
            secret_prefix: secretPrefix,
        },
        include: {
            merchant: {
                select: { id: true, email: true, role: true, status: true, type: true },
            },
        },
    });

    let foundKey: (typeof candidates)[0] | null = null;
    for (const key of candidates) {
        const isMatch = await bcrypt.compare(apiSecret, key.secret_hash);
        if (isMatch) {
            foundKey = key;
            break;
        }
    }

    if (!foundKey) {
        logger.warn('Tentative avec clé API invalide', {
            env,
            prefix: secretPrefix,
            ip: request.ip,
        });
        throw new ApiError('API_KEY_INVALID');
    }

    if (foundKey.merchant.status === 'suspended') {
        throw new ApiError('MERCHANT_SUSPENDED');
    }

    // Update last_used_at async (fire-and-forget, non-blocking)
    prisma.apiKey.update({
        where: { id: foundKey.id },
        data: { last_used_at: new Date() },
    }).catch((err: unknown) => logger.error('Erreur mise à jour last_used_at', { error: err instanceof Error ? err.message : 'Unknown' }));

    request.apiKey = {
        id: foundKey.id,
        merchant_id: foundKey.merchant_id,
        environment: foundKey.environment,
    };

    request.merchant = {
        id: foundKey.merchant.id,
        email: foundKey.merchant.email,
        role: foundKey.merchant.role,
        type: foundKey.merchant.type,
        environment: foundKey.environment,
    };
};

// ─────────────────────────────────────
// Middleware: Either JWT or API Key
// ─────────────────────────────────────
export const eitherAuth = async (request: AuthenticatedRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new ApiError('AUTH_REQUIRED');
    }

    const token = authHeader.substring(7);

    // JWTs contain dots (header.payload.signature)
    if (token.includes('.')) {
        try {
            await jwtAuth(request, reply);
            return;
        } catch (err) {
            // If JWT parse fails, fall through to API key
            if (err instanceof ApiError && err.code === 'AUTH_REQUIRED') throw err;
        }
    }

    // Try API key (sk_live_xxx or sk_test_xxx format)
    await apiKeyAuth(request, reply);
};

// ─────────────────────────────────────
// Middleware: Permission check
// ─────────────────────────────────────
export const requirePermission = (permission: string) => {
    return async (request: AuthenticatedRequest, reply: FastifyReply) => {
        if (!request.merchant) {
            throw new ApiError('AUTH_REQUIRED');
        }

        const role = request.merchant.role as MerchantRole;
        const permissions = ROLE_PERMISSIONS[role];

        if (!permissions.includes('*') && !permissions.includes(permission)) {
            logger.warn('Tentative d\'accès non autorisée', {
                merchant_id: request.merchant.id,
                role,
                required_permission: permission,
            });
            throw new ApiError('INSUFFICIENT_PERMISSIONS');
        }
    };
};

// ─────────────────────────────────────
// Middleware: Super Admin Check
// ─────────────────────────────────────
export const requireSuperAdmin = async (request: AuthenticatedRequest, reply: FastifyReply) => {
    if (!request.merchant) {
        throw new ApiError('AUTH_REQUIRED');
    }

    if (request.merchant.role !== 'super_admin') {
        logger.warn('Tentative d\'accès non autorisée au panel Admin', {
            user_id: request.merchant.id,
            role: request.merchant.role,
        });
        throw new ApiError('INSUFFICIENT_PERMISSIONS');
    }
};

// ─────────────────────────────────────
// Token lifecycle utilities
// ─────────────────────────────────────
export const blacklistToken = async (token: string): Promise<void> => {
    // Blacklist for 16 minutes (slightly over 15m access token lifetime)
    await redis.set(`blacklist:${token}`, '1', 'EX', 16 * 60);
};

export const revokeRefreshToken = async (merchantId: string): Promise<void> => {
    await redis.del(`refresh:${merchantId}`);
};
