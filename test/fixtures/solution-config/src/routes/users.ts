import { Router } from 'express';

const router = Router();
router.get('/:id', (_req, res) => res.json({}));

export const usersRouter = router;
