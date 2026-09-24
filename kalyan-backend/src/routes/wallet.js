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

// GET /wallet/social  (public) -> the platform's social media links
router.get('/social', async (_req, res) => {
  const s = await prisma.setting.findUnique({ where: { id: 'payment' } });
  res.json({
    instagram: s?.igUrl || '', facebook: s?.fbUrl || '', youtube: s?.ytUrl || '',
    whatsapp: s?.waUrl || '', telegram: s?.tgUrl || '',
  });
});

// GET /wallet/passbook  -> full transaction history
router.get('/passbook', userAuth, async (req, res) => {
  const txns = await prisma.transaction.findMany({
    where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 200,
  });
  res.json({ transactions: txns });
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
  await prisma.notification.create({
    data: { userId: req.userId, type: 'deposit', title: 'Deposit request submitted', body: '₹' + amount + ' will be added within 24 hours after verification.' },
  });
  res.json({ request, message: 'Deposit request submitted. Your balance updates once the admin verifies your payment.' });
}
router.post('/deposit', userAuth, createDeposit);
// Back-compat: /add-fund now also creates a request (never credits directly)
router.post('/add-fund', userAuth, createDeposit);

const BANK_LOCK_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function bankView(u) {
  const has = !!(u.bankAccount && u.bankIfsc);
  let canChange = true, nextChangeAt = null;
  if (u.bankUpdatedAt) {
    const next = new Date(u.bankUpdatedAt.getTime() + BANK_LOCK_MS);
    if (next > new Date()) { canChange = false; nextChangeAt = next; }
  }
  return {
    hasBank: has,
    holder: u.bankHolder || '', account: u.bankAccount || '', ifsc: u.bankIfsc || '',
    bankName: u.bankName || '', upi: u.bankUpi || '',
    updatedAt: u.bankUpdatedAt, canChange, nextChangeAt,
  };
}

// GET /wallet/bank  -> the user's saved withdrawal bank + whether it can change
router.get('/bank', userAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  res.json(bankView(user));
});

// POST /wallet/bank  { holder, account, ifsc, bankName, upi }  (once per 30 days)
router.post('/bank', userAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (user.bankUpdatedAt && new Date(user.bankUpdatedAt.getTime() + BANK_LOCK_MS) > new Date()) {
    const next = new Date(user.bankUpdatedAt.getTime() + BANK_LOCK_MS);
    return res.status(403).json({ error: 'Bank details can only be changed once every 30 days. Next change on ' + next.toLocaleDateString('en-IN') + '.' });
  }
  const holder = String(req.body?.holder || '').trim().slice(0, 80);
  const account = String(req.body?.account || '').replace(/\s/g, '').slice(0, 30);
  const ifsc = String(req.body?.ifsc || '').trim().toUpperCase().slice(0, 20);
  const bankName = String(req.body?.bankName || '').trim().slice(0, 80);
  const upi = String(req.body?.upi || '').trim().slice(0, 80);
  if (!holder || !account || !ifsc) return res.status(400).json({ error: 'Enter account holder, account number and IFSC' });

  const updated = await prisma.user.update({
    where: { id: req.userId },
    data: { bankHolder: holder, bankAccount: account, bankIfsc: ifsc, bankName, bankUpi: upi, bankUpdatedAt: new Date() },
  });
  res.json({ ok: true, message: 'Bank details saved', bank: bankView(updated) });
});

// POST /wallet/bank/remove  -> clears the saved bank (counts as the 30-day change)
router.post('/bank/remove', userAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (user.bankUpdatedAt && new Date(user.bankUpdatedAt.getTime() + BANK_LOCK_MS) > new Date()) {
    const next = new Date(user.bankUpdatedAt.getTime() + BANK_LOCK_MS);
    return res.status(403).json({ error: 'Bank details can only be changed once every 30 days. Next change on ' + next.toLocaleDateString('en-IN') + '.' });
  }
  const updated = await prisma.user.update({
    where: { id: req.userId },
    data: { bankHolder: null, bankAccount: null, bankIfsc: null, bankName: null, bankUpi: null, bankUpdatedAt: new Date() },
  });
  res.json({ ok: true, message: 'Bank account removed', bank: bankView(updated) });
});

// GET /wallet/activity  -> merged notification feed (transactions + notifications)
router.get('/activity', userAuth, async (req, res) => {
  const [txns, notes] = await Promise.all([
    prisma.transaction.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.notification.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  const titleFor = { deposit: 'Deposit', withdraw: 'Withdrawal', bid: 'Bid placed', win: 'You won', loss: 'Bid lost' };
  const items = [];
  for (const t of txns) items.push({ kind: t.type, title: titleFor[t.type] || t.type, body: t.note || '', amount: t.amount, at: t.createdAt });
  for (const n of notes) items.push({ kind: n.type, title: n.title, body: n.body || '', amount: null, at: n.createdAt });
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ items: items.slice(0, 120) });
});

// POST /wallet/withdraw  { amount }  -> creates a pending WithdrawRequest
router.post('/withdraw', userAuth, async (req, res) => {
  const amount = Math.floor(Number(req.body?.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user.bankAccount || !user.bankIfsc) return res.status(400).json({ error: 'Add your bank account first, then request a withdrawal.' });
  if (amount > user.balance) return res.status(400).json({ error: 'Insufficient balance' });

  const bankInfo = [user.bankHolder, 'A/C ' + user.bankAccount, 'IFSC ' + user.bankIfsc, user.bankName, user.bankUpi]
    .filter(Boolean).join(' | ');
  const request = await prisma.withdrawRequest.create({
    data: { userId: req.userId, amount, bankInfo, status: 'pending' },
  });
  await prisma.notification.create({
    data: { userId: req.userId, type: 'withdraw', title: 'Withdrawal requested', body: '₹' + amount + ' will be paid to your bank within 24 hours after review.' },
  });
  res.json({ request, message: 'Withdrawal request submitted for approval' });
});

module.exports = router;
