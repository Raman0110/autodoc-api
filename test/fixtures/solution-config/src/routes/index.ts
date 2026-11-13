import { Router } from 'express';
import { usersRouter } from '@/routes/users';

const router = Router();
router.use('/users', usersRouter);

export default router;
