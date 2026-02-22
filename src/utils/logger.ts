// ═══════════════════════════════════════
// DheCash — Winston Structured Logger
// JSON structured logging + OpenTelemetry ready
// ═══════════════════════════════════════

import winston from 'winston';
import { config } from '../config';

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    config.NODE_ENV === 'production'
        ? winston.format.json()
        : winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
                const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
                return `${timestamp} [${level}]: ${message}${metaStr}`;
            })
        )
);

export const logger = winston.createLogger({
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    format: logFormat,
    defaultMeta: { service: 'dhecash-gateway' },
    transports: [
        new winston.transports.Console(),
    ],
});

// Never log sensitive data
export const sanitizeForLog = (obj: Record<string, any>): Record<string, any> => {
    const sensitive = ['password', 'secret', 'token', 'api_secret', 'password_hash', 'secret_hash'];
    const sanitized = { ...obj };
    for (const key of Object.keys(sanitized)) {
        if (sensitive.some(s => key.toLowerCase().includes(s))) {
            sanitized[key] = '[REDACTED]';
        }
    }
    return sanitized;
};
