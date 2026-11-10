import express from 'express';
import { healthRouter } from './routes/health';
import userRouter from './routes/users';

export const app = express();
app.use(express.json());

app.use('/api/users', userRouter);
app.use('/api', healthRouter);

if (require.main === module) {
  app.listen(3000);
}
