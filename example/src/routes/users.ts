import { Router } from 'express';
import { docs } from '../../../src/docs';
import { createUser, deleteUser, getUser, listUsers, updateUser } from '../controllers/users';
import { authenticate, validate, validateQuery } from '../middleware';
import { CreateUserSchema, ListUsersQuery, UpdateUserSchema } from '../validators/user';

const router = Router();

router.get('/', validateQuery(ListUsersQuery), listUsers);

router.post('/', validate(CreateUserSchema), createUser);

router.get('/:id', authenticate, getUser);

router.patch(
  '/:id',
  authenticate,
  validate(UpdateUserSchema),
  docs(updateUser, {
    summary: 'Update a user',
    responses: { 404: 'No user exists with that id' },
  }),
);

router.delete('/:id', authenticate, deleteUser);

export default router;
