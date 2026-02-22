import { Resend } from 'resend';
import { config } from '../config';
import { logger } from '../utils/logger';

// For this specific feature we use the user-provided API key, or fallback to env for other emails
const resend = new Resend(process.env.RESEND_API_KEY || 're_aRCHBCjn_Aci2DkmMkC1oyvaH29tNsML9');

interface InvoiceEmailParams {
    to: string;
    customerName: string;
    merchantName: string;
    invoiceRef: string;
    amount: number;
    currency: string;
    dueDate?: string;
    paymentLink: string;
    items: Array<{ description: string; quantity: number; unit_price: number; amount: number }>;
}

export async function sendInvoiceEmail(params: InvoiceEmailParams): Promise<boolean> {
    const { to, customerName, merchantName, invoiceRef, amount, currency, dueDate, paymentLink, items } = params;

    const formatter = new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency: currency,
    });

    // Simple HTML template
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #0D1B2A; margin: 0;">${merchantName}</h1>
        </div>
        
        <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
            <h2 style="margin-top: 0; color: #0D1B2A;">Facture ${invoiceRef}</h2>
            <p><strong>Pour:</strong> ${customerName}</p>
            ${dueDate ? `<p><strong>Échéance:</strong> ${new Date(dueDate).toLocaleDateString('fr-FR')}</p>` : ''}
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
            <thead>
                <tr style="border-bottom: 2px solid #e2e8f0;">
                    <th style="text-align: left; padding: 10px 0;">Description</th>
                    <th style="text-align: right; padding: 10px 0;">Qté</th>
                    <th style="text-align: right; padding: 10px 0;">Prix unitaire</th>
                    <th style="text-align: right; padding: 10px 0;">Total</th>
                </tr>
            </thead>
            <tbody>
                ${items.map(item => `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 10px 0;">${item.description}</td>
                    <td style="text-align: right; padding: 10px 0;">${item.quantity}</td>
                    <td style="text-align: right; padding: 10px 0;">${formatter.format(item.unit_price)}</td>
                    <td style="text-align: right; padding: 10px 0;">${formatter.format(item.amount)}</td>
                </tr>
                `).join('')}
            </tbody>
            <tfoot>
                <tr>
                    <td colspan="3" style="text-align: right; padding: 15px 0; font-weight: bold;">Total:</td>
                    <td style="text-align: right; padding: 15px 0; font-weight: bold; font-size: 1.1em; color: #0D1B2A;">
                        ${formatter.format(amount)}
                    </td>
                </tr>
            </tfoot>
        </table>

        <div style="text-align: center; margin-top: 40px;">
            <a href="${paymentLink}" style="background-color: #0D1B2A; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Payer la facture
            </a>
            <p style="margin-top: 20px; font-size: 0.9em; color: #64748b;">
                Ou copiez ce lien dans votre navigateur:<br>
                <a href="${paymentLink}" style="color: #475569; word-break: break-all;">${paymentLink}</a>
            </p>
        </div>

        <div style="margin-top: 40px; text-align: center; font-size: 0.8em; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 20px;">
            Propulsé par DheCash
        </div>
    </div>
    `;

    try {
        const { data, error } = await resend.emails.send({
            from: 'DheCash Billing <billing@dhecash.com>', // Assuming verified domain
            to: [to],
            subject: `Facture ${invoiceRef} de ${merchantName}`,
            html: html,
        });

        if (error) {
            logger.error('Failed to send invoice email', { error, invoiceRef });
            return false;
        }

        logger.info('Invoice email sent successfully', { invoiceRef, emailId: data?.id });
        return true;
    } catch (err) {
        logger.error('Error dispatching email to Resend', { err, invoiceRef });
        return false;
    }
}
