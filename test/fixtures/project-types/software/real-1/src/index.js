import express from 'express';
import { router as authRouter } from './routes/auth.js';
import { router as usersRouter } from './routes/users.js';

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use('/users', usersRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('listening on ' + port));
