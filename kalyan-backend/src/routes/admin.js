const router = require('express').Router();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { authenticator } = require('otplib');
const prisma = require('../db');
const { sign, adminAuth } = require('../middleware/auth');
const { deriveResult, bidWin } = require('../lib/settle');

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

/* ----------------------------- Dashboard ------------------------------- */
// GET /admin/dashboard  -> real aggregates for the dashboard cards.
// Values that need bid settlement (win/loss/profit) are 0 until the results
// engine is built; everything else is computed from live data.
router.get('/dashboard', adminAuth, async (_req, res) => {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const [totalUsers, todayUsers, bids, txns] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: startOfToday } } }),
    prisma.bid.findMany({ select: { gameType: true, total: true, marketId: true, status: true } }),
    prisma.transaction.findMany({ select: { type: true, amount: true } }),
  ]);

  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
  const play = sum(bids, (b) => b.total);
  const deposit = sum(txns.filter((t) => t.type === 'deposit'), (t) => t.amount);
  const withdraw = -sum(txns.filter((t) => t.type === 'withdraw'), (t) => t.amount);
  const win = sum(txns.filter((t) => t.type === 'win'), (t) => t.amount);
  const loss = sum(bids.filter((b) => b.status === 'lost'), (b) => b.total);
  const commission = 0; // set an operator commission model later if needed
  const profit = play - win; // house profit before settlement

  // Game type overview
  const byType = {};
  for (const b of bids) {
    const k = b.gameType || 'Other';
    (byType[k] ||= { gameType: k, totalBids: 0, bidAmount: 0, won: 0, lost: 0 });
    byType[k].totalBids += 1; byType[k].bidAmount += b.total || 0;
  }

  res.json({
    summary: { play, commission, win, loss, deposit, withdraw, profit, todayUsers, totalUsers },
    gameTypes: Object.values(byType),
  });
});

/* ------------------------------- Users --------------------------------- */
router.get('/users', adminAuth, async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, phone: true, name: true, balance: true, bettingBlocked: true, createdAt: true },
  });
  res.json({ users });
});

// GET /admin/users/:id  -> full profile + game/wallet summary
router.get('/users/:id', adminAuth, async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!u) return res.status(404).json({ error: 'User not found' });
  const bids = await prisma.bid.findMany({ where: { userId: u.id }, select: { total: true, status: true } });
  const play = bids.reduce((s, b) => s + (b.total || 0), 0);
  const won = bids.filter((b) => b.status === 'won').length;
  const lost = bids.filter((b) => b.status === 'lost').length;
  const [dep, wd] = await Promise.all([
    prisma.transaction.aggregate({ where: { userId: u.id, type: 'deposit' }, _sum: { amount: true } }),
    prisma.transaction.aggregate({ where: { userId: u.id, type: 'withdraw' }, _sum: { amount: true } }),
  ]);
  res.json({
    user: {
      id: u.id, name: u.name, phone: u.phone, balance: u.balance, createdAt: u.createdAt,
      bettingBlocked: u.bettingBlocked,
      bankHolder: u.bankHolder, bankAccount: u.bankAccount, bankIfsc: u.bankIfsc, bankName: u.bankName, bankUpi: u.bankUpi,
    },
    summary: { play, totalBids: bids.length, won, lost, deposit: dep._sum.amount || 0, withdraw: -(wd._sum.amount || 0) },
  });
});

// PATCH /admin/users/:id  { bettingBlocked?, name? }
router.patch('/users/:id', adminAuth, async (req, res) => {
  const data = {};
  if (typeof req.body?.bettingBlocked === 'boolean') data.bettingBlocked = req.body.bettingBlocked;
  if (req.body?.name) data.name = String(req.body.name).slice(0, 80);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });
  const u = await prisma.user.update({ where: { id: req.params.id }, data });
  res.json({ ok: true, user: { id: u.id, name: u.name, bettingBlocked: u.bettingBlocked } });
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

// DELETE /admin/markets/:id  -> only when it has no bids yet
router.delete('/markets/:id', adminAuth, async (req, res) => {
  const bidCount = await prisma.bid.count({ where: { marketId: req.params.id } });
  if (bidCount > 0) return res.status(400).json({ error: 'This market has bids — close it instead of deleting.' });
  await prisma.result.deleteMany({ where: { marketId: req.params.id } });
  await prisma.market.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* ------------------------------ Results -------------------------------- */
// GET /admin/results  -> recent declared results
router.get('/results', adminAuth, async (_req, res) => {
  const results = await prisma.result.findMany({
    orderBy: { declaredAt: 'desc' }, take: 100,
    include: { market: { select: { name: true } } },
  });
  res.json({ results: results.map((r) => ({ id: r.id, market: r.market && r.market.name, value: r.value, declaredAt: r.declaredAt })) });
});

// Shared: work out the settlement for a market's pending bids without writing.
async function computeSettlement(marketId, d) {
  const pend = await prisma.bid.findMany({
    where: { marketId, status: 'pending' },
    include: { user: { select: { id: true, name: true, phone: true } } },
  });
  const winners = []; let settled = 0, manual = 0, totalPayout = 0;
  for (const b of pend) {
    const r = bidWin(b.gameType, b.selections, d);
    if (!r.auto) { manual++; continue; }
    settled++;
    if (r.win > 0) { winners.push({ bid: b, win: r.win }); totalPayout += r.win; }
  }
  return { pend, winners, settled, manual, totalPayout };
}

// POST /admin/results/preview  { marketId, openPanna, closePanna }
// Dry-run: shows the derived result and who would win, without committing.
router.post('/results/preview', adminAuth, async (req, res) => {
  const { marketId, openPanna, closePanna } = req.body || {};
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) return res.status(404).json({ error: 'Market not found' });
  if (!/^\d{3}$/.test(String(openPanna)) || !/^\d{3}$/.test(String(closePanna))) {
    return res.status(400).json({ error: 'Open and close panna must each be 3 digits' });
  }
  const d = deriveResult(openPanna, closePanna);
  const s = await computeSettlement(marketId, d);
  res.json({
    market: market.name, derived: d,
    summary: { pending: s.pend.length, settled: s.settled, winners: s.winners.length, manual: s.manual, totalPayout: s.totalPayout },
    winners: s.winners.slice(0, 50).map((w) => ({ name: w.bid.user && w.bid.user.name, phone: w.bid.user && w.bid.user.phone, gameType: w.bid.gameType, win: w.win })),
  });
});

// POST /admin/results  { marketId, openPanna, closePanna }
// Declares the result, settles every pending bid on the market (credits
// winners, marks won/lost) and closes the market.
router.post('/results', adminAuth, async (req, res) => {
  const { marketId, openPanna, closePanna } = req.body || {};
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) return res.status(404).json({ error: 'Market not found' });
  if (!/^\d{3}$/.test(String(openPanna)) || !/^\d{3}$/.test(String(closePanna))) {
    return res.status(400).json({ error: 'Open and close panna must each be 3 digits' });
  }
  const d = deriveResult(openPanna, closePanna);
  const s = await computeSettlement(marketId, d);

  // Track running balances so multiple wins for one user record correctly.
  const ids = [...new Set(s.winners.map((w) => w.bid.userId))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, balance: true } }) : [];
  const bal = {}; users.forEach((u) => { bal[u.id] = u.balance; });

  const ops = [];
  for (const w of s.winners) {
    const uid = w.bid.userId; const before = bal[uid]; const after = before + w.win; bal[uid] = after;
    ops.push(prisma.user.update({ where: { id: uid }, data: { balance: { increment: w.win } } }));
    ops.push(prisma.transaction.create({ data: { userId: uid, type: 'win', amount: w.win, note: `Won ${w.bid.gameType} · ${market.name} (${d.value})`, balanceBefore: before, balanceAfter: after } }));
    ops.push(prisma.bid.update({ where: { id: w.bid.id }, data: { status: 'won' } }));
    ops.push(prisma.notification.create({ data: { userId: uid, type: 'win', title: 'You won! 🎉', body: `You won ₹${w.win} on ${market.name} (${w.bid.gameType}).` } }));
  }
  // Mark the auto-settled non-winners as lost (skip manual/unknown types).
  const winIds = new Set(s.winners.map((w) => w.bid.id));
  for (const b of s.pend) {
    if (winIds.has(b.id)) continue;
    const r = bidWin(b.gameType, b.selections, d);
    if (r.auto) ops.push(prisma.bid.update({ where: { id: b.id }, data: { status: 'lost' } }));
  }
  ops.push(prisma.result.create({ data: { marketId, value: d.value } }));
  ops.push(prisma.market.update({ where: { id: marketId }, data: { status: 'closed' } }));
  await prisma.$transaction(ops);

  res.json({
    result: { value: d.value }, derived: d,
    summary: { settled: s.settled, winners: s.winners.length, manual: s.manual, totalPayout: s.totalPayout },
  });
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
      data: { userId: wr.userId, type: 'withdraw', amount: -wr.amount, note: 'Withdrawal approved', balanceBefore: user.balance, balanceAfter: user.balance - wr.amount },
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
  const depUser = await prisma.user.findUnique({ where: { id: dr.userId } });
  await prisma.$transaction([
    prisma.user.update({ where: { id: dr.userId }, data: { balance: { increment: credit } } }),
    prisma.transaction.create({ data: { userId: dr.userId, type: 'deposit', amount: credit, note, balanceBefore: depUser.balance, balanceAfter: depUser.balance + credit } }),
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

/* ---------------------- Add Fund (manual credit) ----------------------- */
// POST /admin/users/:id/credit  { amount, note? }
// Admin directly credits a player's wallet (Wallet > Add Fund). Use for
// bonuses or a payment received outside the normal deposit-request flow.
router.post('/users/:id/credit', adminAuth, async (req, res) => {
  const amount = Math.floor(Number(req.body?.amount));
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount to credit' });
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const note = String(req.body?.note || '').slice(0, 200) || 'Wallet credited by admin';
  const [, txn, updated] = await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { balance: { increment: amount } } }),
    prisma.transaction.create({ data: { userId: user.id, type: 'deposit', amount, note, balanceBefore: user.balance, balanceAfter: user.balance + amount } }),
    prisma.user.findUnique({ where: { id: user.id } }),
  ]);
  await prisma.notification.create({
    data: { userId: user.id, type: 'deposit', title: 'Wallet credited', body: '₹' + amount + ' was added to your wallet.' },
  }).catch(() => {});
  res.json({ ok: true, balance: updated.balance, txn });
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
  const { upiId, upiName, bankDetails, qrImage, igUrl, fbUrl, ytUrl, waUrl, tgUrl } = req.body || {};
  if (qrImage && String(qrImage).length > 3_000_000) return res.status(413).json({ error: 'QR image too large (max ~2MB)' });
  const link = (v) => String(v || '').trim().slice(0, 300);
  const data = {
    upiId: (upiId || '').slice(0, 120),
    upiName: (upiName || '').slice(0, 120),
    bankDetails: (bankDetails || '').slice(0, 1000),
    qrImage: qrImage ? String(qrImage) : null,
    igUrl: link(igUrl), fbUrl: link(fbUrl), ytUrl: link(ytUrl), waUrl: link(waUrl), tgUrl: link(tgUrl),
  };
  const s = await prisma.setting.upsert({ where: { id: 'payment' }, update: data, create: { id: 'payment', ...data } });
  res.json({ settings: s });
});

module.exports = router;
