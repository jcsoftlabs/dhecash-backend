// ═══════════════════════════════════════
// DheCash — Zod Validation Schemas
// All input validation in French
// ═══════════════════════════════════════

import { z } from 'zod';

// ─────────────────────────────────────
// Auth schemas
// ─────────────────────────────────────
export const registerSchema = z.object({
    email: z.string().email('Adresse email invalide'),
    password: z
        .string()
        .min(8, 'Le mot de passe doit contenir au moins 8 caractères')
        .regex(/[A-Z]/, 'Le mot de passe doit contenir au moins une majuscule')
        .regex(/[a-z]/, 'Le mot de passe doit contenir au moins une minuscule')
        .regex(/[0-9]/, 'Le mot de passe doit contenir au moins un chiffre')
        .regex(/[^A-Za-z0-9]/, 'Le mot de passe doit contenir au moins un caractère spécial'),
    phone: z.string().optional(),
    type: z.enum(['individual', 'business'], {
        errorMap: () => ({ message: 'Type de marchand invalide' }),
    }),
    // Individual fields
    first_name: z.string().min(1, 'Prénom requis').optional(),
    last_name: z.string().min(1, 'Nom requis').optional(),
    // Business fields
    business_name: z.string().min(1, 'Nom commercial requis').optional(),
    legal_name: z.string().optional(),
}).refine(
    (data) => {
        if (data.type === 'individual') {
            return !!data.first_name && !!data.last_name;
        }
        if (data.type === 'business') {
            return !!data.business_name;
        }
        return true;
    },
    { message: 'Informations requises manquantes pour ce type de compte' }
);

export const loginSchema = z.object({
    email: z.string().email('Adresse email invalide'),
    password: z.string().min(1, 'Mot de passe requis'),
});

export const refreshTokenSchema = z.object({
    refresh_token: z.string().min(1, 'Jeton de rafraîchissement requis'),
});

export const verifyEmailSchema = z.object({
    token: z.string().min(1, 'Jeton de vérification requis'),
});

// ─────────────────────────────────────
// Payment schemas
// ─────────────────────────────────────
export const createPaymentSchema = z.object({
    amount: z
        .number()
        .positive('Le montant doit être supérieur à 0')
        .max(10000000, 'Le montant dépasse la limite autorisée'),
    currency: z.enum(['HTG', 'USD'], {
        errorMap: () => ({ message: 'Devise invalide. Utilisez HTG ou USD.' }),
    }),
    channel: z.enum(['moncash', 'natcash', 'stripe'], {
        errorMap: () => ({ message: 'Canal de paiement invalide' }),
    }),
    order_id: z.string().max(255).optional(),
    description: z.string().max(500).optional(),
    customer_email: z.string().email('Email client invalide').optional(),
    customer_phone: z.string().optional(),
    customer_name: z.string().optional(),
    metadata: z.record(z.any()).optional(),
});

export const refundPaymentSchema = z.object({
    amount: z
        .number()
        .positive('Le montant du remboursement doit être supérieur à 0'),
    reason: z.string().max(500).optional(),
});

// ─────────────────────────────────────
// Query schemas (pagination/filters)
// ─────────────────────────────────────
export const paginationSchema = z.object({
    after: z.string().optional(),
    limit: z.coerce.number().min(1).max(100).default(50),
});

export const transactionFiltersSchema = z.object({
    status: z.enum(['pending', 'completed', 'failed', 'reversed']).optional(),
    channel: z.enum(['moncash', 'natcash', 'stripe']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    export: z.enum(['csv']).optional(),
}).merge(paginationSchema);

export const paymentFiltersSchema = z.object({
    status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled', 'refunded', 'partially_refunded', 'expired']).optional(),
    channel: z.enum(['moncash', 'natcash', 'stripe']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
}).merge(paginationSchema);

// ─────────────────────────────────────
// KYC / Onboarding schemas
// ─────────────────────────────────────
export const businessInfoSchema = z.object({
    // Individual
    nif: z.string().min(1, 'NIF requis').optional(),
    niu: z.string().min(1, 'NIU requis').optional(),
    // Business
    patente_number: z.string().optional(),
    business_type: z.string().optional(),
    legal_name: z.string().optional(),
    // Address
    address_street: z.string().optional(),
    address_city: z.string().optional(),
    address_department: z.string().optional(),
});

export const bankDetailsSchema = z.object({
    bank_name: z.string().min(1, 'Nom de la banque requis'),
    bank_account_number: z.string().min(1, 'Numéro de compte requis'),
    bank_account_holder: z.string().min(1, 'Nom du titulaire requis'),
    bank_iban: z.string().optional(),
});

// ─────────────────────────────────────
// Webhook config schema
// ─────────────────────────────────────
export const webhookConfigSchema = z.object({
    url: z.string().url('URL de webhook invalide'),
    events: z.array(z.string()).min(1, 'Au moins un événement requis'),
});

// ─────────────────────────────────────
// API Key schema
// ─────────────────────────────────────
export const createApiKeySchema = z.object({
    label: z.string().max(100).optional(),
    environment: z.enum(['live', 'test']).default('live'),
});

// Type exports
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;
export type TransactionFilters = z.infer<typeof transactionFiltersSchema>;
export type PaymentFilters = z.infer<typeof paymentFiltersSchema>;
export type BusinessInfoInput = z.infer<typeof businessInfoSchema>;
export type BankDetailsInput = z.infer<typeof bankDetailsSchema>;
