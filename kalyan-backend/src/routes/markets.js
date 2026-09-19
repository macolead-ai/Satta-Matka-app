const router = require('express').Router();
const prisma = require('../db');

// GET /markets  -> all markets with their latest result (public)
router.get('/', async (_req, res) => {
  const markets = await prisma.market.findMany({
    orderBy: { sort: 'asc' },
    include: { results: { orderBy: { declaredAt: 'desc' }, take: 1 } },
  });
  res.json({
    markets: markets.map((m) => ({
      id: m.id,
      name: m.name,
      openTime: m.openTime,
      closeTime: m.closeTime,
      status: m.status,
      latestResult: m.results[0]?.value || null,
    })),
  });
});

module.exports = router;
