import { Router } from 'express';
import { Pool } from 'pg';

export const router = Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT id, email FROM users');
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.params.id]);
  res.json(rows[0] || null);
});
