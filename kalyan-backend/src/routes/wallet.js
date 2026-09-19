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

// GET /wallet/payment-info  (public) -> the platform's deposit details for the app
router.get('/payment-info', async (_req, res) => {
  const s = await prisma.setting.findUnique({ where: { id: 'payment' } });
  res.json({
    upiId: s?.upiId || '',
    upiName: s?.upiName || '',
    bankDetails: s?.bankDetails || '',
    qrImage: s?.qrImage || '',
  });
});

// POST /wallet/deposit  { amount, method, reference, proof? }
// Creates a PENDING deposit request. Balance is only credited after an admin
// verifies the real payment and approves it. No money is added automatically.
async function createDeposit(req, res) {
  const amount = Math.floor(Number(req.body?.amount));
  const method = String(req.body?.method || 'UPI').slice(0, 20);
  const reference = String(req.body?.reference || '').trim().slice(0, 120);
  let proof = req.body?.proof ? String(req.body.proof) : null;
  if (proof && proof.length > 3_000_000) return res.status(413).json({ error: 'Screenshot too large (max ~2MB)' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });
  if (!reference && !proof) return res.status(400).json({ error: 'Enter your UTR / reference or upload the payment screenshot' });

  const request = await prisma.depositRequest.create({
    data: { userId: req.userId, amount, method, reference: reference || '(screenshot)', proof, status: 'pending' },
  });
  res.json({ request, message: 'Deposit request submitted. Your balance updates once the admin verifies your payment.' });
}
router.post('/deposit', userAuth, createDeposit);
// Back-compat: /add-fund now also creates a request (never credits directly)
router.post('/add-fund', userAuth, createDeposit);

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
