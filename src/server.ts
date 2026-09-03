import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';

// Node 18+ defaults to 'verbatim' DNS ordering, which can pick a broken IPv6
// route to Atlas on some networks and cause TLS handshake ECONNRESET errors.
dns.setDefaultResultOrder('ipv4first');

import { createApp } from '@/app';
import { connectDB, disconnectDB } from '@/config/db';
import { env } from '@/config/env';
import { startEscalationScheduler, stopEscalationScheduler } from '@/services/escalation/escalation.service';
import { startPaymentDueReminderScheduler, stopPaymentDueReminderScheduler } from '@/services/payment/paymentDueReminder.service';
import { startQueueProcessor, stopQueueProcessor } from '@/services/push/notificationQueue.service';
import { startRecurringExpenseReminderScheduler, stopRecurringExpenseReminderScheduler } from '@/services/recurringExpense/recurringExpenseReminder.service';
import { startReminderScheduler, stopReminderScheduler } from '@/services/reminder/reminder.service';
import { logger } from '@/utils/logger';

function ensureUploadDirs(): void {
  const dirs = [
    path.join(process.cwd(), 'uploads', 'quotations'),
    path.join(process.cwd(), 'uploads', 'bills'),
    path.join(process.cwd(), 'uploads', 'vendors'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function main(): Promise<void> {
  ensureUploadDirs();
  await connectDB();

  const app = createApp();
  const server = app.listen(env.port, '0.0.0.0', () => {
    logger.info(`Server listening on 0.0.0.0:${env.port} [${env.nodeEnv}]`);
  });

  startEscalationScheduler();
  startQueueProcessor();
  startReminderScheduler();
  startRecurringExpenseReminderScheduler();
  startPaymentDueReminderScheduler();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    stopEscalationScheduler();
    stopQueueProcessor();
    stopReminderScheduler();
    stopRecurringExpenseReminderScheduler();
    stopPaymentDueReminderScheduler();
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('Failed to start server', error);
  process.exit(1);
});
