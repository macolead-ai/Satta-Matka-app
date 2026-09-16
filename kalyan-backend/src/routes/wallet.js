const router = require('express').Router();
const prisma = require('../db');
const { userAuth } = require('../middleware/auth');

// GET /wallet  -> balance + recent transactions
router.get('/', userAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  const txns = await prisma.transaction.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  res.json({ balance: user.balance, transactions: txns });
});

// POST /wallet/add-fund  { amount }
// DEMO: credits the wallet directly (mock). In production this must be gated
// behind a verified payment / manual admin approval — see README section 5.
router.post('/add-fund', userAuth, async (req, res) => {
  const amount = Math.floor(Number(req.body?.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });

  const [user] = await prisma.$transaction([
    prisma.user.update({ where: { id: req.userId }, data: { balance: { increment: amount } } }),
    prisma.transaction.create({
      data: { userId: req.userId, type: 'deposit', amount, note: 'Added money to wallet' },
    }),
  ]);
  res.json({ balance: user.balance });
});

// POST /wallet/withdraw  { amount }  -> creates a pending WithdrawRequest
router.post('/withdraw', userAuth, async (req, res) => {
  const amount = Math.floor(Number(req.body?.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (amount > user.balance) return res.status(400).json({ error: 'Insufficient balance' });

  const request = await prisma.withdrawRequest.create({
    data: { userId: req.userId, amount, status: 'pending' },
  });
  res.json({ request, message: 'Withdrawal request submitted for approval' });
});

module.exports = router;
