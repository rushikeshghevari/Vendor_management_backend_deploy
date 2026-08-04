import mongoose from 'mongoose';
import dns from 'node:dns/promises';

import { env } from '@/config/env';
import { logger } from '@/utils/logger';

mongoose.set('strictQuery', true);

export async function connectDB(): Promise<void> {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('error', (error) => logger.error('MongoDB connection error', error));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  // Configure DNS result order to prevent IPv6/verbatim issues
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch (err: any) {
    logger.warn(`Failed to set DNS default result order: ${err.message}`);
  }

  // Fallback for querySrv ECONNREFUSED/ECONNRESET issues on Windows / certain ISPs
  if (env.mongoUri.startsWith('mongodb+srv://')) {
    try {
      const hostPart = env.mongoUri.split('@')[1]?.split('/')[0]?.split('?')[0];
      if (hostPart) {
        const srvRecord = `_mongodb._tcp.${hostPart}`;
        try {
          await dns.resolveSrv(srvRecord);
        } catch (err: any) {
          logger.warn(`DNS resolution for SRV record failed (${err.message}). Setting fallback DNS servers (8.8.8.8, 1.1.1.1)...`);
          dns.setServers(['8.8.8.8', '1.1.1.1']);
        }
      }
    } catch (err: any) {
      logger.warn(`Failed to verify or configure DNS fallback: ${err.message}`);
    }
  }

  await mongoose.connect(env.mongoUri);
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
}

