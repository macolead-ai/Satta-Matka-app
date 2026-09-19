const router = require('express').Router();
const prisma = require('../db');
const { userAuth } = require('../middleware/auth');

// POST /bids  { marketId, gameType, selections: { "05": 100, "23": 50 } }
router.post('/', userAuth, async (req, res) => {
  const { marketId, gameType, selections } = req.body || {};
  if (!marketId || !gameType || !selections || typeof selections !== 'object') {
    return res.status(400).json({ error: 'marketId, gameType and selections are required' });
  }

  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) return res.status(404).json({ error: 'Market not found' });
  if (market.status !== 'open') return res.status(400).json({ error: 'Market is closed' });

  // Sum the amounts, ignoring blanks / non-positive values
  let total = 0;
  for (const v of Object.values(selections)) {
    const n = Math.floor(Number(v));
    if (n > 0) total += n;
  }
  if (total <= 0) return res.status(400).json({ error: 'Enter an amount to submit' });

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (total > user.balance) return res.status(400).json({ error: 'Insufficient balance' });

  const [, bid, updated] = await prisma.$transaction([
    prisma.transaction.create({
      data: { userId: req.userId, type: 'bid', amount: -total, note: `${gameType} · ${market.name}` },
    }),
    prisma.bid.create({
      data: { userId: req.userId, marketId, gameType, selections, total, status: 'pending' },
    }),
    prisma.user.update({ where: { id: req.userId }, data: { balance: { decrement: total } } }),
  ]);

  res.json({ bid, balance: updated.balance });
});

// GET /bids/history  -> current user's bids
router.get('/history', userAuth, async (req, res) => {
  const bids = await prisma.bid.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { market: { select: { name: true } } },
  });
  res.json({ bids });
});

module.exports = router;
