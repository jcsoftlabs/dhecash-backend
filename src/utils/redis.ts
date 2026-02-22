// ═══════════════════════════════════════
// DheCash — Redis Client
// ═══════════════════════════════════════

import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

// lazyConnect: true so we can call redis.connect() explicitly in server.ts
// and get a proper connection error on startup rather than silently failing
export const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,        // Explicit connect via redis.connect() in server.ts
    enableAutoPipelining: true, // Auto-pipeline concurrent commands for throughput
    retryStrategy(times) {
        if (times > 10) return null; // Stop retrying after 10 attempts
        const delay = Math.min(times * 200, 5000);
        logger.warn(`Reconnexion Redis dans ${delay}ms (tentative ${times})`);
        return delay;
    },
});

redis.on('connect', () => logger.info('✅ Redis connecté'));
redis.on('ready', () => logger.info('✅ Redis prêt'));
redis.on('error', (err) => logger.error('❌ Erreur Redis', { error: err.message }));
redis.on('close', () => logger.warn('⚠️  Redis connexion fermée'));

export default redis;
