import express, { Router } from 'express';

const environment = {} as { API_PREFIX?: string };
const config = { api: { prefix: environment.API_PREFIX || 'api' } };

const users = Router();
users.get('/:id', (_req, res) => res.json({}));

const grouped = Router();
const routeTable = [{ path: '/users', route: users }];
routeTable.forEach((entry) => grouped.use(entry.path, entry.route));

abstract class BaseRoutes {
  protected app: express.Application;
  protected router = Router();
  protected path: string;

  constructor(app: express.Application, path: string) {
    this.app = app;
    this.path = path;
  }
}

class AdminRoutes extends BaseRoutes {
  constructor(app: express.Application) {
    super(app, '/admin');
    this.router.get('/health', (_req, res) => res.json({ ok: true }));
  }

  register() {
    this.app.use(this.path, this.router);
  }
}

const app = express();
const baseApiUrl = '/' + config.api.prefix.replace('/', '');
app.use(baseApiUrl, grouped);
new AdminRoutes(app).register();

export default app;
