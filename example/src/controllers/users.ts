import type { Request, Response } from 'express';
import type { CreateUserInput } from '../validators/user';
import type { ErrorDto, Paginated, UserDto } from '../types/user';

const db = new Map<string, UserDto>();

async function findUser(id: string): Promise<UserDto | null> {
  return db.get(id) ?? null;
}

/**
 * List users
 *
 * Returns a page of users, optionally filtered by a search term.
 */
export async function listUsers(req: Request, res: Response<Paginated<UserDto>>) {
  const page = Number(req.query.page);
  const limit = Number(req.query.limit);
  const search = req.query.search;
  const items = [...db.values()].filter((u) => !search || u.name.includes(String(search)));
  return res.json({ items: items.slice(0, limit || 10), total: items.length, page });
}

export async function createUser(req: Request<{}, UserDto | ErrorDto, CreateUserInput>, res: Response<UserDto | ErrorDto>) {
  const user: UserDto = {
    id: String(db.size + 1),
    name: req.body.name,
    email: req.body.email,
    role: req.body.role,
    plan: 'free' as UserDto['plan'],
    createdAt: new Date(),
    nickname: null,
  };
  db.set(user.id, user);
  return res.status(201).json(user);
}

export async function getUser(req: Request<{ id: string }>, res: Response<UserDto | ErrorDto>) {
  const user = await findUser(req.params.id);

  if (!user) {
    return res.status(404).json({
      message: 'User not found',
    });
  }

  return res.status(200).json(user);
}

export const updateUser = async (req: Request<{ id: string }>, res: Response) => {
  const user = await findUser(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  const updated = { ...user, ...req.body };
  db.set(user.id, updated);
  return res.json(updated);
};

export const deleteUser = async (req: Request<{ id: string }>, res: Response) => {
  db.delete(req.params.id);
  return res.status(204).end();
};
