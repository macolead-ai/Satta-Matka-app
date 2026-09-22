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

// GET /markets/:id/results  -> chart of past results for one market (public)
router.get('/:id/results', async (req, res) => {
  const market = await prisma.market.findUnique({ where: { id: req.params.id } });
  if (!market) return res.status(404).json({ error: 'Market not found' });
  const results = await prisma.result.findMany({
    where: { marketId: req.params.id }, orderBy: { declaredAt: 'desc' }, take: 90,
  });
  res.json({
    market: { id: market.id, name: market.name, openTime: market.openTime, closeTime: market.closeTime },
    results: results.map((r) => ({ value: r.value, declaredAt: r.declaredAt })),
  });
});

module.exports = router;
