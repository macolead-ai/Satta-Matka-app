require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../src/db');

async function main() {
  // --- Admin (Google Authenticator is set up later via /admin/totp/setup) ---
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  await prisma.admin.upsert({
    where: { username },
    update: {},
    create: { username, password: await bcrypt.hash(password, 10) },
  });
  console.log(`Admin ready: ${username} / ${password}  (change the password!)`);

  // --- Markets ---
  const markets = [
    { name: 'Milan Day', openTime: '07:00 PM', closeTime: '08:00 PM', status: 'open', sort: 1 },
    { name: 'Kalyan Day', openTime: '04:00 PM', closeTime: '06:00 PM', status: 'open', sort: 2 },
    { name: 'Test Star', openTime: '07:00 PM', closeTime: '08:00 PM', status: 'closed', sort: 3 },
    { name: 'Shiva Night', openTime: '09:00 PM', closeTime: '11:00 PM', status: 'open', sort: 4 },
    { name: 'Main Ratan', openTime: '03:30 PM', closeTime: '05:30 PM', status: 'closed', sort: 5 },
  ];
  for (const m of markets) {
    const existing = await prisma.market.findFirst({ where: { name: m.name } });
    if (!existing) await prisma.market.create({ data: m });
  }
  console.log(`Seeded ${markets.length} markets`);

  // --- Demo user ---
  const phone = '9876543210';
  const demo = await prisma.user.upsert({
    where: { phone },
    update: {},
    create: { phone, name: 'Demo Player', password: await bcrypt.hash('demo1234', 10), balance: 2000 },
  });
  console.log(`Demo user ready: ${phone} / demo1234  (balance ₹${demo.balance})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
