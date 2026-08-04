export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  DEPARTMENT_USER: 'department_user',
  HOD: 'hod',
  DIRECTOR: 'director',
  CEO: 'ceo',
  ACCOUNTS: 'accounts',
  PAYMENT_DEPARTMENT: 'payment_department',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: Role[] = Object.values(ROLES);
