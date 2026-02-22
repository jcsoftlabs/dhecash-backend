const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const p = await prisma.payment.findUnique({ where: { payment_ref: 'pay_hzgxRVZZQI8p4N0m9fHWW' } });
  console.log(p);
}
main().catch(console.error).finally(() => prisma.$disconnect());
