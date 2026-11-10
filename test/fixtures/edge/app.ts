import express, { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { z } from 'zod';

const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };
const validate = (_s: unknown): RequestHandler => (_req, _res, next) => next();
const requireAuth: RequestHandler = (_req, _res, next) => next();

const Item = z.object({ productId: z.string().uuid(), quantity: z.number().int().positive() });
const OrderSchema = z.object({
  items: z.array(Item).nonempty(),
  note: z.string().max(200).nullable().optional(),
  kind: z.union([z.literal('pickup'), z.literal('delivery')]),
  address: z.object({ city: z.string(), zip: z.string().regex(/^\d{5}$/) }).optional(),
});
const AdminOrderSchema = OrderSchema.extend({ internalId: z.string() });

interface OrderDto { id: string; status: 'created' | 'shipped'; total: number }

class OrdersController {
  get = async (req: Request<{ orderId: string }>, res: Response<OrderDto>) => {
    return res.json({ id: req.params.orderId, status: 'created', total: 1 });
  };
  async remove(req: Request, res: Response) {
    res.sendStatus(204);
  }
}
const ctrl = new OrdersController();

export function createOrdersRouter() {
  const r = Router();
  r.use(requireAuth);
  r.post('/', validate(OrderSchema), asyncHandler(async (_req, res) => {
    res.status(201).json({ id: 'o1', status: 'created' });
  }));
  r.post('/admin', validate(AdminOrderSchema), (req, res) => { res.status(201).json(req.body); });
  r.get('/:orderId', ctrl.get);
  r.delete('/:orderId', ctrl.remove);
  return r;
}

const legacy = Router();
legacy.get('/search', (req, res) => {
  const { q, page = 1 } = req.query;
  const limit = parseInt(req.query.limit as string);
  const trace = req.get('x-trace-id');
  res.json({ q, page, limit, trace, results: [] as string[] });
});
legacy.post('/items', (req, res) => {
  const { title, price } = req.body;
  res.status(201).send({ title, price });
});
legacy.get('/ping', (_req, res) => res.send('pong'));
legacy.get('/old', (_req, res) => res.redirect('/legacy/search'));

export const app = express();
app.use('/v1/orders', createOrdersRouter());
app.use('/legacy', legacy);
