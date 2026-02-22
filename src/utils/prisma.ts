// ═══════════════════════════════════════
// DheCash — Prisma Client Singleton
// ═══════════════════════════════════════

import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

export const prisma = new PrismaClient({
    log: [
        { level: 'query', emit: 'event' },
        { level: 'error', emit: 'event' },
        { level: 'warn', emit: 'event' },
    ],
});

// Log slow queries in development
prisma.$on('query', (e) => {
    if (e.duration > 200) {
        logger.warn('Requête lente détectée', {
            query: e.query,
            duration: `${e.duration}ms`,
        });
    }
});

prisma.$on('error', (e) => {
    logger.error('Erreur Prisma', { message: e.message });
});

export default prisma;
