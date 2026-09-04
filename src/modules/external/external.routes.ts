import { Router } from 'express';

import { apiKeyAuth } from '@/middleware/apiKey.middleware';
import { validate } from '@/middleware/validate.middleware';
import { externalController } from '@/modules/external/external.controller';
import { externalBillListQuerySchema, externalUpcomingPaymentsQuerySchema } from '@/modules/external/external.validation';

const router = Router();

/**
 * @openapi
 * tags:
 *   name: External
 *   description: Read-only API for other, separate projects (e.g. a Payment-department calendar-reminder integration). Authenticated by a shared X-API-Key header, not user login.
 */

router.use(apiKeyAuth);

router.get('/bills', validate({ query: externalBillListQuerySchema }), externalController.listBills);

/**
 * @openapi
 * /external/payments/upcoming:
 *   get:
 *     tags: [External]
 *     summary: Payments coming due within N days (default 7) — confirmed Bills plus tentative RecurringExpense cycles, with Director approval info
 *     security: [{ apiKeyAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: withinDays
 *         schema: { type: integer, minimum: 0, maximum: 365, default: 7 }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Upcoming payments fetched
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Upcoming payments fetched }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       type: { type: string, enum: [bill, recurring_expense, prepared_quotation] }
 *                       reference: { type: string, description: Bill code, recurring expense's title, or "requirementNumber — title" for a prepared quotation }
 *                       payee: { type: string }
 *                       amount: { type: number }
 *                       advanceAmount: { type: number, description: "prepared_quotation only — how much of amount the vendor wants paid before the PO/goods (0 if none). May be a Director-overridden quotation's own advance, not necessarily the department's original pick." }
 *                       balanceAmount: { type: number, description: "prepared_quotation only — amount minus advanceAmount, due per the quotation's own credit period once the PO is raised" }
 *                       expectedDeliveryDate: { type: string, format: date-time, nullable: true, description: "prepared_quotation only — the vendor's own promised delivery date for this quotation, or null if never set" }
 *                       isTentative: { type: boolean, description: true for a recurring cycle or a prepared quotation, where the real invoice/approval doesn't exist yet }
 *                       dueDate: { type: string, format: date-time, description: For prepared_quotation this is the Requirement's requiredDate (goods needed by), not a real payment due date — no such date exists this early }
 *                       daysRemaining: { type: integer, description: Negative means overdue }
 *                       status: { type: string }
 *                       quotationApproval: { type: string, description: Which Director(s) approved the originating quotation, and when }
 *                       approvedAt: { type: string, format: date-time, nullable: true, description: Raw timestamp of the first Director approval on record, or null if not yet approved }
 *                       preparedAt: { type: string, format: date-time, nullable: true, description: prepared_quotation only — when the department marked this quotation as prepared }
 *       401:
 *         description: Missing or invalid X-API-Key header
 */
router.get('/payments/upcoming', validate({ query: externalUpcomingPaymentsQuerySchema }), externalController.listUpcomingPayments);

export default router;
