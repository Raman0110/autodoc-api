import express, { Router, type Request, type Response } from 'express';

export interface CreateUserPayload {
  name: string;
  email: string;
  password: string;
  age?: number;
}
export interface LoginPayload {
  email: string;
  password: string;
}

export class UserService {
  async createUser(payload: CreateUserPayload): Promise<{ id: string; name: string }> {
    return { id: '1', name: payload.name };
  }
  async loginUser(payload: LoginPayload): Promise<string> {
    return payload.email;
  }
}

export class UserController {
  constructor(private userService: UserService) {}

  createUser = async (req: Request, res: Response) => {
    try {
      const userPayload = req.body;
      const user = await this.userService.createUser(userPayload);
      res.status(201).json({ success: true, message: 'User Created Successfully', user });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message || 'Internal Server Error' });
    }
  };

  loginUser = async (req: Request, res: Response) => {
    const loginPayload = req.body;
    const token = await this.userService.loginUser(loginPayload);
    res.cookie('token', token, { httpOnly: true }).json({ success: true, message: 'Login successful' });
  };

  logout = async (_req: Request, res: Response) => {
    res.clearCookie('token');
    res.status(200).json({ success: true });
  };
}

const controller = new UserController(new UserService());
export const router = Router();
router.post('/register', controller.createUser);
router.post('/login', controller.loginUser);
router.post('/logout', controller.logout);

export const app = express();
app.use('/users', router);
