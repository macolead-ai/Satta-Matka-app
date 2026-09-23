const router = require('express').Router();
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { sign, userAuth } = require('../middleware/auth');

function publicUser(u) {
  return { id: u.id, phone: u.phone, name: u.name, balance: u.balance };
}

// POST /auth/register  { phone, name, password }
router.post('/register', async (req, res) => {
  const { phone, name, password } = req.body || {};
  if (!phone || !name || !password) {
    return res.status(400).json({ error: 'phone, name and password are required' });
  }
  const exists = await prisma.user.findUnique({ where: { phone } });
  if (exists) return res.status(409).json({ error: 'This mobile number is already registered' });

  const user = await prisma.user.create({
    data: { phone, name, password: await bcrypt.hash(password, 10) },
  });
  await prisma.notification.create({
    data: { userId: user.id, type: 'system', title: 'Welcome to Kalyan Games', body: 'Your account is ready. Add funds and start playing!' },
  });
  const token = sign({ sub: user.id, role: 'user' });
  res.json({ token, user: publicUser(user) });
});

// POST /auth/login  { phone, password }   (no OTP)
router.post('/login', async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone and password are required' });

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid mobile number or password' });
  }
  const token = sign({ sub: user.id, role: 'user' });
  res.json({ token, user: publicUser(user) });
});

// POST /auth/change-password  { oldPassword, newPassword }  (logged-in user)
router.post('/change-password', userAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Enter your current and new password' });
  if (String(newPassword).length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!(await bcrypt.compare(oldPassword, user.password))) {
    return res.status(401).json({ error: 'Your current password is incorrect' });
  }
  await prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(newPassword, 10) } });
  await prisma.notification.create({
    data: { userId: user.id, type: 'security', title: 'Password changed', body: 'Your password was changed successfully.' },
  });
  res.json({ ok: true, message: 'Password updated successfully' });
});

// GET /auth/me
router.get('/me', userAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

module.exports = router;
