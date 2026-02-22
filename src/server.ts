// ═══════════════════════════════════════
// DheCash — Server Entry Point
// ═══════════════════════════════════════

import { config } from './config';
import { logger } from './utils/logger';
import { prisma } from './utils/prisma';
import { redis } from './utils/redis';
import { buildApp } from './app';
import { startWorkers } from './services/queue';

async function main() {
    try {
        // Connect to Redis (explicit for startup health check)
        await redis.connect();
        logger.info('✅ Redis connecté');

        // Verify database connection
        await prisma.$connect();
        logger.info('✅ PostgreSQL connecté');

        // Start BullMQ queue workers
        startWorkers();
        logger.info('✅ BullMQ workers actifs');

        // Build and start Fastify
        const app = await buildApp();

        await app.listen({
            port: config.PORT,
            host: config.HOST,
        });

        logger.info(`🚀 DheCash Gateway API démarré`, {
            port: config.PORT,
            env: config.NODE_ENV,
            url: `http://${config.HOST}:${config.PORT}`,
        });

        // Graceful shutdown
        const shutdown = async (signal: string) => {
            logger.info(`${signal} reçu — arrêt gracieux...`);
            await app.close();
            await prisma.$disconnect();
            await redis.quit();
            logger.info('✅ Arrêt complet');
            process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

        // Catch unhandled promise rejections
        process.on('unhandledRejection', (reason) => {
            logger.error('Promesse non gérée', { reason });
        });

        process.on('uncaughtException', (err) => {
            logger.error('Exception non capturée', { error: err.message, stack: err.stack });
            shutdown('uncaughtException');
        });

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown';
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error('❌ Échec du démarrage', { error: message, stack });
        process.exit(1);
    }
}

main();
