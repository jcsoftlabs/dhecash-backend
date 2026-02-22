const axios = require('axios');

async function testMonCash() {
    const MONCASH_CLIENT_ID = '2e7c5a42a158cf47cab678ede6f9b847';
    const MONCASH_CLIENT_SECRET = 'U1DtktOkThAhVjEeMRsRR_JmcUCDVJXAUdbasVpNXScCECaZBWYGgKDj0XHnG-Yt';
    const MONCASH_BASE_URL = 'https://sandbox.moncashbutton.digicelgroup.com';

    try {
        console.log('1. Fetching token...');
        const credentials = Buffer.from(`${MONCASH_CLIENT_ID}:${MONCASH_CLIENT_SECRET}`).toString('base64');

        const tokenRes = await axios.post(
            `${MONCASH_BASE_URL}/Api/oauth/token`,
            'scope=read,write&grant_type=client_credentials',
            {
                headers: {
                    Authorization: `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );

        const token = tokenRes.data.access_token;
        console.log('Token OK:', token.substring(0, 15) + '...');

        console.log('2. Creating payment...');
        const payRes = await axios.post(
            `${MONCASH_BASE_URL}/Api/v1/CreatePayment`,
            {
                amount: 200,
                orderId: 'ORDER-TEST-005',
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        console.log('Payment OK:', payRes.data);

    } catch (err) {
        console.error('Error in MonCash API:');
        if (err.response) {
            console.error('Status:', err.response.status);
            console.error('Data:', err.response.data);
        } else {
            console.error(err.message);
        }
    }
}

testMonCash();
