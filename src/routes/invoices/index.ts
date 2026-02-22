// ═══════════════════════════════════════
// DheCash — Invoices Routes
// POST /v1/invoices
// GET /v1/invoices
// GET /v1/invoices/:id
// POST /v1/invoices/:id/send
// ═══════════════════════════════════════

import { FastifyInstance } from 'fastify';
import { prisma } from '../../utils/prisma';
import { ApiError, successResponse, encodeCursor, decodeCursor } from '../../utils/errors';
import { jwtAuth, requirePermission, AuthenticatedRequest } from '../../plugins/auth';
import { sendInvoiceEmail } from '../../services/email';
import { z } from 'zod';
import { customAlphabet } from 'nanoid';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

export function generateInvoiceRef(): string {
    return `inv_${nanoid()}`;
}

const invoiceItemSchema = z.object({
    description: z.string().min(1),
    quantity: z.number().int().min(1).default(1),
    unit_price: z.number().positive(),
});

const createInvoiceSchema = z.object({
    customer_id: z.string().uuid(),
    currency: z.enum(['HTG', 'USD']).default('HTG'),
    due_date: z.string().datetime().optional(),
    notes: z.string().optional(),
    items: z.array(invoiceItemSchema).min(1),
    status: z.enum(['draft', 'open']).default('draft'),
});

export async function invoiceRoutes(fastify: FastifyInstance) {
    // ─────────────────────────────────────
    // POST /v1/invoices — Create Invoice
    // ─────────────────────────────────────
    fastify.post('/v1/invoices', {
        preHandler: [jwtAuth as any, requirePermission('payments:write') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const parsed = createInvoiceSchema.safeParse(request.body);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', {
                fields: parsed.error.flatten().fieldErrors,
            });
        }

        const data = parsed.data;
        const merchantId = request.merchant!.id;
        const environment = request.merchant!.environment as any;

        // Verify customer belongs to merchant
        const customer = await prisma.customer.findFirst({
            where: { id: data.customer_id, merchant_id: merchantId, environment }
        });

        if (!customer) {
            throw new ApiError('VALIDATION_ERROR', { message: 'Client invalide ou introuvable.' });
        }

        // Calculate totals
        let totalAmount = 0;
        const processedItems = data.items.map((item: any) => {
            const amount = item.quantity * item.unit_price;
            totalAmount += amount;
            return {
                description: item.description,
                quantity: item.quantity,
                unit_price: item.unit_price,
                amount
            };
        });

        const invoiceRef = generateInvoiceRef();

        const invoice = await prisma.invoice.create({
            data: {
                invoice_ref: invoiceRef,
                merchant_id: merchantId,
                customer_id: customer.id,
                environment,
                status: data.status,
                amount: totalAmount,
                currency: data.currency,
                due_date: data.due_date ? new Date(data.due_date) : null,
                notes: data.notes,
                items: {
                    create: processedItems
                }
            },
            include: { items: true, customer: true }
        });

        reply.status(201).send(successResponse({
            ...invoice,
            amount: Number(invoice.amount),
            items: invoice.items.map(item => ({ ...item, unit_price: Number(item.unit_price), amount: Number(item.amount) }))
        }));
    });

    // ─────────────────────────────────────
    // GET /v1/invoices — List Invoices
    // ─────────────────────────────────────
    fastify.get('/v1/invoices', {
        preHandler: [jwtAuth as any, requirePermission('payments:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const querySchema = z.object({
            status: z.string().optional(),
            after: z.string().optional(),
            limit: z.coerce.number().min(1).max(100).default(20),
        });

        const parsed = querySchema.safeParse(request.query);
        if (!parsed.success) {
            throw new ApiError('VALIDATION_ERROR', { fields: parsed.error.flatten().fieldErrors });
        }

        const { status, after, limit } = parsed.data;
        const merchantId = request.merchant!.id;
        const environment = request.merchant!.environment as any;

        const where: any = { merchant_id: merchantId, environment };
        if (status) where.status = status;

        if (after) {
            const cursorId = decodeCursor(after);
            where.id = { lt: cursorId };
        }

        const invoices = await prisma.invoice.findMany({
            where,
            orderBy: { created_at: 'desc' },
            take: limit + 1,
            include: { customer: { select: { name: true, email: true } } },
        });

        const hasMore = invoices.length > limit;
        const results = hasMore ? invoices.slice(0, limit) : invoices;
        const nextCursor = hasMore && results.length > 0 ? encodeCursor(results[results.length - 1].id) : null;

        reply.send(successResponse(
            results.map((inv: any) => ({
                id: inv.id,
                invoice_ref: inv.invoice_ref,
                amount: Number(inv.amount),
                currency: inv.currency,
                status: inv.status,
                due_date: inv.due_date,
                created_at: inv.created_at,
                customer: inv.customer
            })),
            { has_more: hasMore, next_cursor: nextCursor, count: results.length }
        ));
    });

    // ─────────────────────────────────────
    // GET /v1/invoices/:id — Get Invoice Details
    // ─────────────────────────────────────
    fastify.get('/v1/invoices/:id', {
        preHandler: [jwtAuth as any, requirePermission('payments:read') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const { id } = request.params as { id: string };
        const merchantId = request.merchant!.id;

        const invoice = await prisma.invoice.findFirst({
            where: {
                id,
                merchant_id: merchantId,
                environment: request.merchant!.environment as any,
            },
            include: {
                items: true,
                customer: true,
                payment: {
                    select: {
                        payment_ref: true,
                        status: true,
                        channel: true,
                        completed_at: true,
                    }
                }
            },
        });

        if (!invoice) {
            throw new ApiError('NOT_FOUND', { message: 'Facture introuvable' });
        }

        reply.send(successResponse({
            ...invoice,
            amount: Number(invoice.amount),
            items: invoice.items.map(item => ({ ...item, unit_price: Number(item.unit_price), amount: Number(item.amount) }))
        }));
    });

    // ─────────────────────────────────────
    // POST /v1/invoices/:id/send — Send Invoice Email
    // ─────────────────────────────────────
    fastify.post('/v1/invoices/:id/send', {
        preHandler: [jwtAuth as any, requirePermission('payments:write') as any],
    }, async (request: AuthenticatedRequest, reply) => {
        const { id } = request.params as { id: string };
        const merchantId = request.merchant!.id;

        const invoice = await prisma.invoice.findFirst({
            where: {
                id,
                merchant_id: merchantId,
                environment: request.merchant!.environment as any,
            },
            include: {
                items: true,
                customer: true,
                merchant: { select: { business_name: true, first_name: true, last_name: true } }
            },
        }) as any; // Type override to fix TS2339 on joined tables

        if (!invoice) {
            throw new ApiError('NOT_FOUND', { message: 'Facture introuvable' });
        }

        if (!invoice.customer.email) {
            throw new ApiError('VALIDATION_ERROR', { message: 'Ce client n\'a pas d\'adresse email configurée.' });
        }

        // Generate public payment URL. Assuming frontend is on localhost:3000 during dev
        // In production, this would be an env var like FRONTEND_URL
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const paymentLink = `${frontendUrl}/factures/${invoice.invoice_ref}`;

        // Save the payment link reference on the invoice if not already there
        if (!invoice.payment_link_id) {
            await prisma.invoice.update({
                where: { id: invoice.id },
                data: { payment_link_id: invoice.invoice_ref, status: 'open' }
            });
        }

        // Fallback to name/first_name if business_name is not set
        const merchantName = invoice.merchant?.business_name || invoice.merchant?.name || invoice.merchant?.first_name || 'Votre Marchand';
        const customerName = invoice.customer.name || 'Client';

        const success = await sendInvoiceEmail({
            to: invoice.customer.email,
            customerName,
            merchantName,
            invoiceRef: invoice.invoice_ref,
            amount: Number(invoice.amount),
            currency: invoice.currency,
            dueDate: invoice.due_date ? invoice.due_date.toISOString() : undefined,
            paymentLink,
            items: invoice.items.map((i: any) => ({
                description: i.description,
                quantity: i.quantity,
                unit_price: Number(i.unit_price),
                amount: Number(i.amount)
            }))
        });

        if (!success) {
            throw new ApiError('INTERNAL_ERROR', { message: 'Échec de l\'envoi de l\'email via Resend.' });
        }

        reply.send(successResponse({
            message: 'Facture envoyée avec succès',
            sent_to: invoice.customer.email
        }));
    });
}
