// ═══════════════════════════════════════
// DheCash — Environment Configuration
// Zod-validated, type-safe config
// ═══════════════════════════════════════

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3001),
    HOST: z.string().default('0.0.0.0'),

    // Database
    DATABASE_URL: z.string().url(),

    // Redis
    REDIS_URL: z.string(),

    // JWT
    JWT_ACCESS_SECRET: z.string().min(16),
    JWT_REFRESH_SECRET: z.string().min(16),
    JWT_ACCESS_EXPIRY: z.string().default('15m'),
    JWT_REFRESH_EXPIRY: z.string().default('7d'),

    // CORS
    CORS_ORIGIN: z.string().default('http://localhost:3000'),

    // MonCash
    MONCASH_CLIENT_ID: z.string().optional().default(''),
    MONCASH_CLIENT_SECRET: z.string().optional().default(''),
    MONCASH_BASE_URL: z.string().default('https://sandbox.moncashbutton.digicelgroup.com'),

    // NatCash
    NATCASH_CLIENT_ID: z.string().optional().default(''),
    NATCASH_CLIENT_SECRET: z.string().optional().default(''),
    NATCASH_BASE_URL: z.string().default('https://sandbox.natcash.com'),

    // Stripe
    STRIPE_SECRET_KEY: z.string().optional().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),

    // Webhook
    WEBHOOK_SIGNING_SECRET: z.string().min(8),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('❌ Configuration invalide:', parsed.error.flatten().fieldErrors);
    process.exit(1);
}

export const config = parsed.data;
export type Config = z.infer<typeof envSchema>;
