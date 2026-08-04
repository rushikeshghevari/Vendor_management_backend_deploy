import { Router } from 'express';

import { authenticate } from '@/middleware/auth.middleware';
import { authRateLimiter } from '@/middleware/rateLimiter.middleware';
import { validate } from '@/middleware/validate.middleware';
import { authController } from '@/modules/auth/auth.controller';
import { loginSchema, refreshTokenSchema } from '@/modules/auth/auth.validation';

const router = Router();

/**
 * @openapi
 * tags:
 *   name: Auth
 *   description: Authentication — login, token refresh, logout, current user
 */

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in with email and password
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email, example: superadmin@gmail.com }
 *               password: { type: string, format: password, example: "1" }
 *     responses:
 *       200:
 *         description: Login successful — returns access/refresh tokens and the user profile.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   allOf:
 *                     - $ref: '#/components/schemas/AuthTokens'
 *                     - type: object
 *                       properties:
 *                         user: { $ref: '#/components/schemas/User' }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Invalid email or password
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       429:
 *         description: Too many login attempts
 */
router.post('/login', authRateLimiter, validate({ body: loginSchema }), authController.login);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Exchange a valid refresh token for a new access/refresh token pair (rotation)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: New token pair issued. The previous refresh token is revoked.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/AuthTokens' }
 *       401:
 *         description: Refresh token is invalid, expired, or has already been revoked
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post('/refresh', authRateLimiter, validate({ body: refreshTokenSchema }), authController.refresh);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Revoke a refresh token (logout from this device/session)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: Logged out. Always succeeds, even if the token was already invalid.
 */
router.post('/logout', authRateLimiter, validate({ body: refreshTokenSchema }), authController.logout);

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get the currently authenticated user's profile
 *     responses:
 *       200:
 *         description: Current user profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/User' }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/me', authenticate, authController.me);

export default router;
