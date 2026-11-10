import { Router } from 'express';

export const healthRouter = Router();

// router.route() chaining + inline handler
healthRouter
  .route('/health')
  .get((_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });
