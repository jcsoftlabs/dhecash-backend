const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const payment = await prisma.payment.findUnique({
    where: { payment_ref: 'pay_tDh8s8bYx9syTOGMqAK6z' }
  });
  console.log('Redirect URL:', payment.provider_redirect_url);
}
run();
