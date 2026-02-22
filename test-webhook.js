const crypto = require('crypto');
const axios = require('axios');

async function triggerWebhook() {
    const secret = 'whsec_0DuWvSuxkQfYbgC4SE3V4pX5yfmMGH8s';
    const url = 'https://dhecash-backend-production.up.railway.app/v1/webhooks/stripe';

    // Create a minimal synthetic Stripe event matching the PI we created
    const payload = {
        id: 'evt_test123',
        object: 'event',
        api_version: '2024-06-20',
        created: Math.floor(Date.now() / 1000),
        type: 'payment_intent.succeeded',
        data: {
            object: {
                id: 'pi_3T3QxLKtG6epPH162DHAejw1',
                object: 'payment_intent',
                amount: 2500,
                currency: 'usd',
                status: 'succeeded'
            }
        }
    };

    const payloadString = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${payloadString}`;

    // Generate Stripe signature
    const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    const stripeSignatureHeader = `t=${timestamp},v1=${signature}`;

    console.log('Sending webhook to', url);
    console.log('Signature:', stripeSignatureHeader);

    try {
        const res = await axios.post(url, payloadString, {
            headers: {
                'stripe-signature': stripeSignatureHeader,
                'content-type': 'application/json'
            }
        });
        console.log('Response:', res.status, res.data);
    } catch (err) {
        console.error('Error:', err.response ? err.response.data : err.message);
    }
}

triggerWebhook();
