import { isProduction } from '@/config/env';

type LogMeta = unknown;

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(message: string, meta?: LogMeta): void {
    console.log(`[${timestamp()}] INFO: ${message}`, meta ?? '');
  },
  warn(message: string, meta?: LogMeta): void {
    console.warn(`[${timestamp()}] WARN: ${message}`, meta ?? '');
  },
  error(message: string, meta?: LogMeta): void {
    console.error(`[${timestamp()}] ERROR: ${message}`, meta ?? '');
  },
  debug(message: string, meta?: LogMeta): void {
    if (!isProduction) {
      console.debug(`[${timestamp()}] DEBUG: ${message}`, meta ?? '');
    }
  },
};
