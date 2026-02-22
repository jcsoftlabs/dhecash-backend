import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash('AdminDheCash2026!', 10);
  
  const admin = await prisma.merchant.upsert({
    where: { email: 'admin@dhecash.com' },
    update: { role: 'super_admin' },
    create: {
      email: 'admin@dhecash.com',
      password: hashedPassword,
      first_name: 'Sys',
      last_name: 'Admin',
      business_name: 'DheCash System',
      phone: '+50900000000',
      type: 'business',
      role: 'super_admin',
    },
  });
  console.log('Super admin ready:', admin.email);
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
