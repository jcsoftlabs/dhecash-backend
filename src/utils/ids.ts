// ═══════════════════════════════════════
// DheCash — ID Generator
// Nanoid-based unique IDs with prefixes
// ═══════════════════════════════════════

import { customAlphabet } from 'nanoid';

// URL-safe alphabet, 21 chars default
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 21);

/** Generate a payment reference: pay_{nanoid} */
export const generatePaymentRef = (): string => `pay_${nanoid()}`;

/** Generate a transaction reference: txn_{nanoid} */
export const generateTransactionRef = (): string => `txn_${nanoid()}`;

/** Generate a public API key ID: pk_live_{nanoid} or pk_test_{nanoid} */
export const generateApiKeyId = (env: 'live' | 'test'): string => `pk_${env}_${nanoid()}`;

/** Generate an API secret: sk_live_{nanoid} or sk_test_{nanoid} */
export const generateApiSecret = (env: 'live' | 'test'): string => `sk_${env}_${nanoid(32)}`;

/** Generate a generic unique ID */
export const generateId = (): string => nanoid();
