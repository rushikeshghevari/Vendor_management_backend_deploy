import swaggerJsdoc from 'swagger-jsdoc';

import { env } from '@/config/env';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Vendor Management System API',
      version: '1.0.0',
      description: 'REST API for the Vendor Management System backend.',
    },
    servers: [{ url: `http://localhost:${env.port}/api/v1`, description: 'Local' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ApiError: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', example: 'Invalid email or password' },
            errors: {
              type: 'object',
              additionalProperties: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '665f1c2b9b1d4c1a2c8e4a10' },
            name: { type: 'string', example: 'Jane Doe' },
            email: { type: 'string', example: 'jane@vms.local' },
            role: {
              type: 'string',
              enum: ['super_admin', 'department_user', 'director', 'accounts', 'payment_department'],
            },
            department: { type: 'string', nullable: true },
          },
        },
        AuthTokens: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  // Glob covers both the TS source (dev, run via tsx) and the compiled JS (prod, run from dist/)
  // — JSDoc comments survive compilation, so whichever of these exists gets picked up.
  apis: ['./src/modules/**/*.routes.ts', './dist/modules/**/*.routes.js'],
};

export const swaggerSpec = swaggerJsdoc(options);
