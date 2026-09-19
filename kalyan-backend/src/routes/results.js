const router = require('express').Router();
const prisma = require('../db');

// GET /results  -> recent results across markets (public)
router.get('/', async (_req, res) => {
  const results = await prisma.result.findMany({
    orderBy: { declaredAt: 'desc' },
    take: 30,
    include: { market: { select: { name: true, openTime: true } } },
  });
  res.json({
    results: results.map((r) => ({
      id: r.id,
      market: r.market.name,
      time: r.market.openTime,
      value: r.value,
      declaredAt: r.declaredAt,
    })),
  });
});

module.exports = router;
