require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Simple request log
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get('/', (_req, res) => res.json({ name: 'Kalyan Games API', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/auth', require('./routes/auth'));
app.use('/wallet', require('./routes/wallet'));
app.use('/markets', require('./routes/markets'));
app.use('/bids', require('./routes/bids'));
app.use('/results', require('./routes/results'));
app.use('/admin', require('./routes/admin'));

// 404 + error handlers
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Kalyan Games API listening on :${PORT}`));
