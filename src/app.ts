import path from 'node:path';

import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Application } from 'express';
import mongoSanitize from 'express-mongo-sanitize';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';

import { env, isProduction } from '@/config/env';
import { swaggerSpec } from '@/config/swagger';
import { errorHandler } from '@/middleware/error.middleware';
import { notFound } from '@/middleware/notFound.middleware';
import { apiRateLimiter } from '@/middleware/rateLimiter.middleware';
import routes from '@/routes';
import addressRoutes from '@/modules/address/address.routes';

export function createApp(): Application {
  const app = express();

  // Railway (and most PaaS) sit behind a reverse proxy; trust the first hop so
  // req.ip resolves to the real client IP instead of the load-balancer address.
  // Required for correct IP-based rate limiting and security headers.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin.includes('*') ? true : env.corsOrigin,
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(mongoSanitize());
  app.use(morgan(isProduction ? 'combined' : 'dev'));
  app.use(apiRateLimiter);

  app.get('/health', (_req, res) => {
    res.status(200).json({ success: true, message: 'OK', timestamp: new Date().toISOString() });
  });

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/api-docs.json', (_req, res) => res.json(swaggerSpec));

  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
  // Vendor Public Self-Registration form — plain static HTML+JS, no build step, no auth.
  // Served at e.g. GET /vendor-registration.html?token=... (see public/vendor-registration.html).
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.use('/api/address', addressRoutes);
  app.use('/api/v1', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
