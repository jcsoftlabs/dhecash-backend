// ═══════════════════════════════════════
// DheCash — Error Handling
// Standardized API error format (French messages)
// ═══════════════════════════════════════

// ─────────────────────────────────────
// Error codes taxonomy
// ─────────────────────────────────────
export const ERROR_CODES = {
    // Auth errors
    AUTH_REQUIRED: { code: 'AUTH_REQUIRED', status: 401, message: 'Authentification requise' },
    INVALID_CREDENTIALS: { code: 'INVALID_CREDENTIALS', status: 401, message: 'Identifiants invalides' },
    TOKEN_EXPIRED: { code: 'TOKEN_EXPIRED', status: 401, message: 'Jeton expiré' },
    TOKEN_INVALID: { code: 'TOKEN_INVALID', status: 401, message: 'Jeton invalide' },
    REFRESH_TOKEN_INVALID: { code: 'REFRESH_TOKEN_INVALID', status: 401, message: 'Jeton de rafraîchissement invalide' },
    INSUFFICIENT_PERMISSIONS: { code: 'INSUFFICIENT_PERMISSIONS', status: 403, message: 'Permissions insuffisantes' },
    API_KEY_INVALID: { code: 'API_KEY_INVALID', status: 401, message: 'Clé API invalide' },
    API_KEY_REVOKED: { code: 'API_KEY_REVOKED', status: 401, message: 'Clé API révoquée' },

    // Rate limiting
    RATE_LIMIT_EXCEEDED: { code: 'RATE_LIMIT_EXCEEDED', status: 429, message: 'Limite de requêtes dépassée. Réessayez plus tard.' },

    // Validation
    VALIDATION_ERROR: { code: 'VALIDATION_ERROR', status: 400, message: 'Erreur de validation' },
    INVALID_INPUT: { code: 'INVALID_INPUT', status: 400, message: 'Données invalides' },

    // Merchant
    MERCHANT_NOT_FOUND: { code: 'MERCHANT_NOT_FOUND', status: 404, message: 'Marchand introuvable' },
    MERCHANT_SUSPENDED: { code: 'MERCHANT_SUSPENDED', status: 403, message: 'Compte marchand suspendu' },
    MERCHANT_ALREADY_EXISTS: { code: 'MERCHANT_ALREADY_EXISTS', status: 409, message: 'Un compte existe déjà avec cet email' },
    EMAIL_NOT_VERIFIED: { code: 'EMAIL_NOT_VERIFIED', status: 403, message: 'Adresse email non vérifiée' },

    // Payment
    PAYMENT_NOT_FOUND: { code: 'PAYMENT_NOT_FOUND', status: 404, message: 'Paiement introuvable' },
    PAYMENT_ALREADY_COMPLETED: { code: 'PAYMENT_ALREADY_COMPLETED', status: 409, message: 'Ce paiement a déjà été complété' },
    PAYMENT_EXPIRED: { code: 'PAYMENT_EXPIRED', status: 410, message: 'Ce paiement a expiré' },
    PAYMENT_FAILED: { code: 'PAYMENT_FAILED', status: 422, message: 'Le paiement a échoué' },
    REFUND_EXCEEDS_AMOUNT: { code: 'REFUND_EXCEEDS_AMOUNT', status: 422, message: 'Le montant du remboursement dépasse le montant du paiement' },
    REFUND_NOT_ALLOWED: { code: 'REFUND_NOT_ALLOWED', status: 422, message: 'Remboursement non autorisé pour ce paiement' },
    IDEMPOTENCY_CONFLICT: { code: 'IDEMPOTENCY_CONFLICT', status: 409, message: 'Conflit de clé d\'idempotence' },

    // Provider
    PROVIDER_ERROR: { code: 'PROVIDER_ERROR', status: 502, message: 'Erreur du fournisseur de paiement' },
    PROVIDER_TIMEOUT: { code: 'PROVIDER_TIMEOUT', status: 504, message: 'Le fournisseur de paiement n\'a pas répondu à temps' },
    PROVIDER_UNAVAILABLE: { code: 'PROVIDER_UNAVAILABLE', status: 503, message: 'Fournisseur de paiement temporairement indisponible' },

    // KYC
    KYC_NOT_FOUND: { code: 'KYC_NOT_FOUND', status: 404, message: 'Soumission KYC introuvable' },
    KYC_ALREADY_SUBMITTED: { code: 'KYC_ALREADY_SUBMITTED', status: 409, message: 'Documents KYC déjà soumis' },

    // Generic
    INTERNAL_ERROR: { code: 'INTERNAL_ERROR', status: 500, message: 'Erreur interne du serveur' },
    NOT_FOUND: { code: 'NOT_FOUND', status: 404, message: 'Ressource introuvable' },
    METHOD_NOT_ALLOWED: { code: 'METHOD_NOT_ALLOWED', status: 405, message: 'Méthode non autorisée' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

// ─────────────────────────────────────
// API Error class
// ─────────────────────────────────────
export class ApiError extends Error {
    public readonly code: string;
    public readonly statusCode: number;
    public readonly details: Record<string, any>;

    constructor(
        errorCode: ErrorCode,
        details: Record<string, any> = {},
        customMessage?: string
    ) {
        const errorDef = ERROR_CODES[errorCode];
        super(customMessage || errorDef.message);
        this.code = errorDef.code;
        this.statusCode = errorDef.status;
        this.details = details;
    }

    toJSON() {
        return {
            error: {
                code: this.code,
                message: this.message,
                details: Object.keys(this.details).length > 0 ? this.details : undefined,
            },
        };
    }
}

// ─────────────────────────────────────
// Success response helper
// ─────────────────────────────────────
export const successResponse = <T>(data: T, meta?: Record<string, any>) => ({
    data,
    ...(meta ? { meta } : {}),
});

// ─────────────────────────────────────
// Pagination cursor helpers
// ─────────────────────────────────────
export const encodeCursor = (id: string): string =>
    Buffer.from(id).toString('base64');

export const decodeCursor = (cursor: string): string =>
    Buffer.from(cursor, 'base64').toString('utf-8');
