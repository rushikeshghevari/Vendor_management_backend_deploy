import { ROLES, type Role } from '@/constants/roles';
import { Department, type IDepartment } from '@/modules/department/department.model';
import { User, type IUser } from '@/modules/user/user.model';

interface CreateTestUserOptions {
  name?: string;
  email?: string;
  password?: string;
  role?: Role;
  department?: string;
  isActive?: boolean;
}

export async function createTestUser(options: CreateTestUserOptions = {}): Promise<IUser> {
  return User.create({
    name: options.name ?? 'Test User',
    email: options.email ?? 'test.user@vms.local',
    password: options.password ?? 'Password123!',
    role: options.role ?? ROLES.SUPER_ADMIN,
    department: options.department,
    isActive: options.isActive ?? true,
  });
}

interface CreateTestDepartmentOptions {
  name?: string;
  code?: string;
  createdBy: string;
  hod?: string;
}

export async function createTestDepartment(options: CreateTestDepartmentOptions): Promise<IDepartment> {
  return Department.create({
    name: options.name ?? 'Test Department',
    code: options.code ?? 'TDPT',
    createdBy: options.createdBy,
    hod: options.hod,
  });
}
