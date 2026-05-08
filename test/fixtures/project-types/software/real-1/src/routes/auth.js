import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

export const router = Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  // password lookup elided
  const ok = await bcrypt.compare(password, '$2b$12$placeholderhashplaceholderhashplaceholderhashplaceholdr');
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ sub: email }, process.env.JWT_SECRET || 'dev', { expiresIn: '1h' });
  res.json({ token });
});

router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  const hash = await bcrypt.hash(password, 12);
  res.status(201).json({ email, hash });
});
