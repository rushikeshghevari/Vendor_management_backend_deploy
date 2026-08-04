import { connectDB, disconnectDB } from '@/config/db';
import { env } from '@/config/env';
import { ROLES } from '@/constants/roles';
import { User } from '@/modules/user/user.model';
import { logger } from '@/utils/logger';

async function seed(): Promise<void> {
  await connectDB();

  const { name, email, password } = env.seedSuperAdmin;
  const existing = await User.findOne({ $or: [{ email }, { role: ROLES.SUPER_ADMIN }] });

  if (existing) {
    existing.name = name;
    existing.email = email;
    existing.password = password;
    existing.role = ROLES.SUPER_ADMIN;
    existing.isActive = true;
    await existing.save();
    logger.info(`Super Admin updated: ${email}`);
  } else {
    await User.create({ name, email, password, role: ROLES.SUPER_ADMIN });
    logger.info(`Super Admin created: ${email}`);
  }

  await disconnectDB();
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Seed failed', error);
    process.exit(1);
  });
