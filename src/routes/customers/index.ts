// ═══════════════════════════════════════
// DheCash — Customer Routes
// GET /v1/customers
// GET /v1/customers/:id
// ═══════════════════════════════════════

import { FastifyInstance } from 'fastify';
import { prisma } from '../../utils/prisma';
import { ApiError, successResponse, encodeCursor, decodeCursor } from '../../utils/errors';
import { jwtAuth, requirePermission, AuthenticatedRequest } from '../../plugins/auth';
import { z } from 'zod';

const customerFiltersSchema = z.object({
    search: z.string().optional(),
    after: z.string().optional(),
    limit: z.coerce.number().min(1).max(100).default(20),
});

const createCustomerSchema = z.object({
    name: z.string().min(2),
    email: z.string().email().optional().or(z.literal('')),
    phone: z.string().optional().or(z.literal('')),
});

export async function customerRoutes(fastify: FastifyInstance) {
    // ─────────────────────────────────────
    // GET /v1/customers — List customers
    // ─────────────────────────────────────
    fastify.get('/v1/customers', {
        preHandler: [jwtAuth as any, requirePermission('payments:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = customerFiltersSchema.safeParse(request.query);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const { search, after, limit } = parsed.data;
        const merchantId = request.merchant!.id;

        const where: any = {
            merchant_id: merchantId,
            environment: request.merchant!.environment as any,
        };

        if (search) {
            where.OR = [
                { email: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } },
            ];
        }

        // Cursor-based pagination
        if (after) {
            const cursorId = decodeCursor(after);
            where.id = { lt: cursorId };
        }

        const customers = await prisma.customer.findMany({
            where,
            orderBy: { last_payment_at: 'desc' },
            take: limit + 1,
            select: {
                id: true,
                email: true,
                phone: true,
                name: true,
                total_spent: true,
                payment_count: true,
                last_payment_at: true,
                created_at: true,
            },
        });

        const hasMore = customers.length > limit;
        const results = hasMore ? customers.slice(0, limit) : customers;
        const nextCursor = hasMore && results.length > 0
            ? encodeCursor(results[results.length - 1].id)
            : null;

        reply.send(successResponse(
            results.map(c => ({
                ...c,
                total_spent: Number(c.total_spent),
            })),
            {
                has_more: hasMore,
                next_cursor: nextCursor,
                count: results.length,
            }
        ));
    });

    // ─────────────────────────────────────
    // GET /v1/customers/:id — Get customer details
    // ─────────────────────────────────────
    fastify.get('/v1/customers/:id', {
        preHandler: [jwtAuth as any, requirePermission('payments:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const { id } = request.params as { id: string };
        const merchantId = request.merchant!.id;

        const customer = await prisma.customer.findFirst({
            where: {
                id,
                merchant_id: merchantId,
                environment: request.merchant!.environment as any,
            },
            include: {
                payments: {
                    select: {
                        payment_ref: true,
                        amount: true,
                        currency: true,
                        status: true,
                        channel: true,
                        created_at: true,
                    },
                    orderBy: { created_at: 'desc' },
                    take: 10,
                },
            },
        });

        if (!customer) {
            throw new ApiError('NOT_FOUND', { message: 'Client introuvable' });
        }

        reply.send(successResponse({
            ...customer,
            total_spent: Number(customer.total_spent),
            payments: customer.payments.map((p: any) => ({
                ...p,
                amount: Number(p.amount),
            })),
        }));
    });

    // ─────────────────────────────────────
    // POST /v1/customers — Create a customer
    // ─────────────────────────────────────
    fastify.post('/v1/customers', {
        preHandler: [jwtAuth as any, requirePermission('payments:write') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = createCustomerSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const { name, email, phone } = parsed.data;
        const merchantId = request.merchant!.id;
        const environment = request.merchant!.environment as any;

        // Optionally check if a customer with this email already exists
        if (email) {
            const existing = await prisma.customer.findFirst({
                where: { merchant_id: merchantId, environment, email }
            });
            if (existing) {
                throw new ApiError('VALIDATION_ERROR', { message: 'Un client avec cet email existe déjà.' });
            }
        }

        const customer = await prisma.customer.create({
            data: {
                merchant_id: merchantId,
                environment,
                name,
                email: email || null,
                phone: phone || null,
            }
        });

        reply.status(201).send(successResponse({
            id: customer.id,
            name: customer.name,
            email: customer.email,
            phone: customer.phone,
            created_at: customer.created_at
        }));
    });
}
