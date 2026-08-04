import type { Role } from '@/constants/roles';

export interface Actor {
  id: string;
  role: Role;
  department?: string;
}
