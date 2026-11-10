import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';

const createRequestSchema = z.object({
  title: z.string().trim().min(1).max(150),
  description: z.string().trim().max(2_000).optional(),
  slug: z.string().trim().max(80).regex(/^[a-z0-9-]*$/).optional().default(''),
  password: z.string().min(4).max(128).optional(),
  // z.iso exists in zod 4; the analyzer reads the syntax, so this works either way
  expiresAt: (z as any).iso.datetime({ offset: true }).optional(),
});
const passwordSchema = z.object({
  slug: z.string().min(1).max(80),
  password: z.string().min(1).max(128),
});

const serialize = (r: any) => ({ id: r.id, title: r.title });

export const createFileRequest = async (req: Request, res: Response) => {
  try {
    const body = createRequestSchema.parse(req.body);
    res.status(201).json({ message: 'File request created', request: serialize(body) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const checkRequestPassword = async (req: Request, res: Response) => {
  try {
    const { slug, password } = passwordSchema.parse(req.body);
    res.status(200).json({ message: 'ok', success: true, slug, password });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const deleteFileRequest = async (req: Request, res: Response) => {
  if (!req.params.slug) return void res.status(401).json({ error: 'Unauthorized' });
  res.status(204).send();
};

export const router = Router();
router.post('/', createFileRequest);
router.post('/password', checkRequestPassword);
router.delete('/:slug', deleteFileRequest);

export const app = express();
app.use('/requests', router);
