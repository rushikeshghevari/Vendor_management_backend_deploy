import { connectDB, disconnectDB } from '@/config/db';
import { Requirement } from '@/modules/requirement/requirement.model';
import { User } from '@/modules/user/user.model';
import { logger } from '@/utils/logger';

/**
 * One-time migration for the department-routing feature: every Requirement created before
 * `requestedByDepartment` existed on the schema is missing it, which fails validation on the
 * next `.save()` (e.g. submitToDirector) since it's now required. Backfills it from each
 * requirement's actual creator's department — correct for both ordinary (own-department)
 * requirements and ones already routed via targetDepartment before this field existed.
 */
async function run(): Promise<void> {
  await connectDB();

  const docs = await Requirement.find({ requestedByDepartment: { $exists: false } }).select('department createdBy requirementNumber');
  let fixed = 0;
  let skipped = 0;

  for (const doc of docs) {
    const creator = await User.findById(doc.createdBy).select('department');
    if (!creator?.department) {
      logger.warn(`Skipping ${doc.requirementNumber} — creator or creator's department not found`);
      skipped += 1;
      continue;
    }
    await Requirement.updateOne({ _id: doc._id }, { $set: { requestedByDepartment: creator.department } });
    fixed += 1;
  }

  logger.info(`Backfilled requestedByDepartment on ${fixed} requirement(s), skipped ${skipped}`);
  await disconnectDB();
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Backfill failed', error);
    process.exit(1);
  });
