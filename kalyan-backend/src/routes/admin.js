const router = require('express').Router();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { authenticator } = require('otplib');
const prisma = require('../db');
const { sign, adminAuth } = require('../middleware/auth');

authenticator.options = { window: 1 }; // tolerate +/- 1 time-step of clock drift
const ISSUER = process.env.ADMIN_TOTP_ISSUER || 'Kalyan Games';

/* ----------------------------- Admin login ----------------------------- */
// POST /admin/login  { username, password, token? }
// Password first. If Google Authenticator is enabled, a valid 6-digit `token`
// is ALSO required every time. Without it, responds { totpRequired: true }.
router.post('/login', async (req, res) => {
  const { username, password, token } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

  const admin = await prisma.admin.findUnique({ where: { username } });
  if (!admin || !(await bcrypt.compare(password, admin.password))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (admin.totpEnabled) {
    if (!token) return res.status(200).json({ totpRequired: true });
    const ok = authenticator.verify({ token: String(token), secret: admin.totpSecret });
    if (!ok) return res.status(401).json({ error: 'Invalid authenticator code' });
  }

  const jwt = sign({ sub: admin.id, role: 'admin' });
  res.json({ token: jwt, admin: { id: admin.id, username: admin.username, totpEnabled: admin.totpEnabled } });
});

/* -------------------- Google Authenticator enrolment -------------------- */
// POST /admin/totp/setup  -> returns a QR to scan in Google Authenticator
router.post('/totp/setup', adminAuth, async (req, res) => {
  const admin = await prisma.admin.findUnique({ where: { id: req.adminId } });
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(admin.username, ISSUER, secret);
  await prisma.admin.update({ where: { id: admin.id }, data: { totpSecret: secret, totpEnabled: false } });
  const qr = await QRCode.toDataURL(otpauth);
  res.json({ qr, otpauth, secret }); // show `secret` as manual-entry fallback
});

// POST /admin/totp/enable  { token }  -> confirm the first code, then enforce it
router.post('/totp/enable', adminAuth, async (req, res) => {
  const { token } = req.body || {};
  const admin = await prisma.admin.findUnique({ where: { id: req.adminId } });
  if (!admin.totpSecret) return res.status(400).json({ error: 'Run /totp/setup first' });
  const ok = authenticator.verify({ token: String(token || ''), secret: admin.totpSecret });
  if (!ok) return res.status(400).json({ error: 'Invalid code — try the current one' });
  await prisma.admin.update({ where: { id: admin.id }, data: { totpEnabled: true } });
  res.json({ totpEnabled: true });
});

router.get('/me', adminAuth, async (req, res) => {
  const admin = await prisma.admin.findUnique({ where: { id: req.adminId } });
  res.json({ admin: { id: admin.id, username: admin.username, totpEnabled: admin.totpEnabled } });
});

/* ------------------------------- Users --------------------------------- */
router.get('/users', adminAuth, async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, phone: true, name: true, balance: true, createdAt: true },
  });
  res.json({ users });
});

/* ------------------------------ Markets -------------------------------- */
router.post('/markets', adminAuth, async (req, res) => {
  const { name, openTime, closeTime, sort } = req.body || {};
  if (!name || !openTime || !closeTime) return res.status(400).json({ error: 'name, openTime, closeTime required' });
  const market = await prisma.market.create({ data: { name, openTime, closeTime, sort: Number(sort) || 0 } });
  res.json({ market });
});

// PATCH /admin/markets/:id  { status?, name?, openTime?, closeTime?, sort? }
router.patch('/markets/:id', adminAuth, async (req, res) => {
  const { status, name, openTime, closeTime, sort } = req.body || {};
  const data = {};
  if (status) data.status = status;
  if (name) data.name = name;
  if (openTime) data.openTime = openTime;
  if (closeTime) data.closeTime = closeTime;
  if (sort !== undefined) data.sort = Number(sort);
  const market = await prisma.market.update({ where: { id: req.params.id }, data });
  res.json({ market });
});

/* ------------------------------ Results -------------------------------- */
// POST /admin/results  { marketId, value }  -> declares a result
router.post('/results', adminAuth, async (req, res) => {
  const { marketId, value } = req.body || {};
  if (!marketId || !value) return res.status(400).json({ error: 'marketId and value required' });
  const result = await prisma.result.create({ data: { marketId, value } });
  res.json({ result });
});

/* --------------------------- Withdrawals ------------------------------- */
router.get('/withdrawals', adminAuth, async (_req, res) => {
  const withdrawals = await prisma.withdrawRequest.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { name: true, phone: true, balance: true } } },
  });
  res.json({ withdrawals });
});

// POST /admin/withdrawals/:id/approve  -> deducts balance and records the payout
router.post('/withdrawals/:id/approve', adminAuth, async (req, res) => {
  const wr = await prisma.withdrawRequest.findUnique({ where: { id: req.params.id } });
  if (!wr || wr.status !== 'pending') return res.status(400).json({ error: 'Request not pending' });

  const user = await prisma.user.findUnique({ where: { id: wr.userId } });
  if (wr.amount > user.balance) return res.status(400).json({ error: 'User has insufficient balance' });

  await prisma.$transaction([
    prisma.user.update({ where: { id: wr.userId }, data: { balance: { decrement: wr.amount } } }),
    prisma.transaction.create({
      data: { userId: wr.userId, type: 'withdraw', amount: -wr.amount, note: 'Withdrawal approved' },
    }),
    prisma.withdrawRequest.update({ where: { id: wr.id }, data: { status: 'approved' } }),
  ]);
  res.json({ status: 'approved' });
});

router.post('/withdrawals/:id/reject', adminAuth, async (req, res) => {
  const wr = await prisma.withdrawRequest.findUnique({ where: { id: req.params.id } });
  if (!wr || wr.status !== 'pending') return res.status(400).json({ error: 'Request not pending' });
  await prisma.withdrawRequest.update({ where: { id: wr.id }, data: { status: 'rejected' } });
  await prisma.notification.create({
    data: { userId: wr.userId, type: 'withdraw', title: 'Withdrawal rejected', body: 'Your withdrawal of ₹' + wr.amount + ' was rejected. Please contact support.' },
  });
  res.json({ status: 'rejected' });
});

/* ---------------------------- Deposits --------------------------------- */
router.get('/deposits', adminAuth, async (_req, res) => {
  const deposits = await prisma.depositRequest.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { name: true, phone: true } } },
  });
  res.json({ deposits });
});

// POST /admin/deposits/:id/approve  -> credits the user's balance after the
// admin has confirmed the real payment (UPI/bank) using the reference/UTR.
// Optional { amount } lets the admin adjust the credited amount before approving.
router.post('/deposits/:id/approve', adminAuth, async (req, res) => {
  const dr = await prisma.depositRequest.findUnique({ where: { id: req.params.id } });
  if (!dr || dr.status !== 'pending') return res.status(400).json({ error: 'Request not pending' });
  const credit = req.body?.amount != null ? Math.floor(Number(req.body.amount)) : dr.amount;
  if (!credit || credit <= 0) return res.status(400).json({ error: 'Enter a valid amount to credit' });
  const note = credit === dr.amount
    ? 'Deposit approved (' + dr.method + ' ' + dr.reference + ')'
    : 'Deposit approved, adjusted to ₹' + credit + ' (' + dr.method + ' ' + dr.reference + ')';
  await prisma.$transaction([
    prisma.user.update({ where: { id: dr.userId }, data: { balance: { increment: credit } } }),
    prisma.transaction.create({ data: { userId: dr.userId, type: 'deposit', amount: credit, note } }),
    prisma.depositRequest.update({ where: { id: dr.id }, data: { status: 'approved' } }),
  ]);
  res.json({ status: 'approved', credited: credit });
});

router.post('/deposits/:id/reject', adminAuth, async (req, res) => {
  const dr = await prisma.depositRequest.findUnique({ where: { id: req.params.id } });
  if (!dr || dr.status !== 'pending') return res.status(400).json({ error: 'Request not pending' });
  await prisma.depositRequest.update({ where: { id: dr.id }, data: { status: 'rejected' } });
  await prisma.notification.create({
    data: { userId: dr.userId, type: 'deposit', title: 'Deposit rejected', body: 'Your deposit of ₹' + dr.amount + ' could not be verified. Please contact support.' },
  });
  res.json({ status: 'rejected' });
});

/* ------------------- Password reset (admin fallback) ------------------- */
// Used only if a player is locked out; players normally change their own
// password in the app (old password -> new password).
router.post('/users/:id/reset-password', adminAuth, async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  await prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(password, 10) } });
  res.json({ ok: true });
});

/* ------------------------- Payment settings ---------------------------- */
router.get('/settings', adminAuth, async (_req, res) => {
  const s = await prisma.setting.findUnique({ where: { id: 'payment' } });
  res.json({ settings: s || { id: 'payment', upiId: '', upiName: '', bankDetails: '', qrImage: '' } });
});

// PUT /admin/settings  { upiId, upiName, bankDetails, qrImage }
router.put('/settings', adminAuth, async (req, res) => {
  const { upiId, upiName, bankDetails, qrImage } = req.body || {};
  if (qrImage && String(qrImage).length > 3_000_000) return res.status(413).json({ error: 'QR image too large (max ~2MB)' });
  const data = {
    upiId: (upiId || '').slice(0, 120),
    upiName: (upiName || '').slice(0, 120),
    bankDetails: (bankDetails || '').slice(0, 1000),
    qrImage: qrImage ? String(qrImage) : null,
  };
  const s = await prisma.setting.upsert({ where: { id: 'payment' }, update: data, create: { id: 'payment', ...data } });
  res.json({ settings: s });
});

module.exports = router;
