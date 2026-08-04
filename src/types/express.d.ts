import type { Role } from '@/constants/roles';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: Role;
        department?: string;
      };
    }
  }
}

export {};
