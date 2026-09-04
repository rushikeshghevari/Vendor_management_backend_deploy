import { Types } from 'mongoose';

import { ROLES } from '@/constants/roles';
import { BILL_STATUS, QUOTATION_STATUS } from '@/constants/status';
import { Department } from '@/modules/department/department.model';
import type { CreateDepartmentInput, TransferHodInput, UpdateDepartmentInput } from '@/modules/department/department.validation';
import { Bill } from '@/modules/bill/bill.model';
import { PurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import { Quotation } from '@/modules/quotation/quotation.model';
import { Requirement } from '@/modules/requirement/requirement.model';
import { User } from '@/modules/user/user.model';
import { userService } from '@/modules/user/user.service';
import { Vendor } from '@/modules/vendor/vendor.model';
import { ApiError } from '@/utils/ApiError';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';

async function getStatistics(departmentId: string) {
  const [userCount, vendorCount, requirementCount, quotationCount, purchaseOrderCount, billCount] = await Promise.all([
    User.countDocuments({ department: departmentId, role: ROLES.DEPARTMENT_USER }),
    Vendor.countDocuments({ department: departmentId }),
    Requirement.countDocuments({ department: departmentId, isDeleted: { $ne: true } }),
    Quotation.countDocuments({ department: departmentId, isDeleted: { $ne: true } }),
    PurchaseOrder.countDocuments({ department: departmentId, isDeleted: { $ne: true } }),
    Bill.countDocuments({ department: departmentId, isDeleted: { $ne: true } }),
  ]);
  return { userCount, vendorCount, requirementCount, quotationCount, purchaseOrderCount, billCount };
}

// UTC-anchored deliberately: Mongo's $dateToString below groups createdAt by UTC calendar
// day/month by default, so the gap-filled series must use the same UTC day boundaries —
// otherwise a non-UTC server timezone (e.g. IST, UTC+5:30) shifts every key by one day.
function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function monthsAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
}

interface DateCountRow { key: string; count: number }

/** Groups documents in `model` matching `department` and `createdAt >= since` by day or
 *  month, returning a dense (gap-filled) series so charts don't have to handle missing days. */
async function countGrouped(
  model: typeof Quotation | typeof Bill | typeof Vendor | typeof Requirement | typeof PurchaseOrder,
  departmentId: string,
  since: Date,
  granularity: 'day' | 'month',
): Promise<DateCountRow[]> {
  const format = granularity === 'day' ? '%Y-%m-%d' : '%Y-%m';
  const rows = await model.aggregate<{ _id: string; count: number }>([
    {
      $match: {
        department: new Types.ObjectId(departmentId),
        createdAt: { $gte: since },
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: { $dateToString: { format, date: '$createdAt' } }, count: { $sum: 1 } } },
  ]);
  const rowMap = new Map(rows.map((r) => [r._id, r.count]));

  const series: DateCountRow[] = [];
  const cursor = new Date(since);
  const now = new Date();
  while (cursor <= now) {
    const key = granularity === 'day'
      ? cursor.toISOString().slice(0, 10)
      : cursor.toISOString().slice(0, 7);
    series.push({ key, count: rowMap.get(key) ?? 0 });
    if (granularity === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return series;
}

async function statusBreakdown(
  model: typeof Quotation | typeof Bill,
  departmentId: string,
): Promise<Array<{ status: string; count: number }>> {
  const rows = await model.aggregate<{ _id: string; count: number }>([
    { $match: { department: new Types.ObjectId(departmentId), isDeleted: { $ne: true } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return rows.map((r) => ({ status: r._id, count: r.count }));
}

/** Loads the user referenced by `hodId`, validating they aren't already the active HOD of a
 *  *different* department — that case must go through `transferHod`, not a plain assignment. */
async function loadAssignableHod(hodId: string, excludeDepartmentId?: string) {
  const user = await User.findById(hodId);
  if (!user) throw ApiError.notFound('HOD user not found');

  const conflictingDept = await Department.findOne({
    hod: hodId,
    isActive: true,
    ...(excludeDepartmentId ? { _id: { $ne: excludeDepartmentId } } : {}),
  }).select('_id');
  if (conflictingDept) {
    throw ApiError.conflict('This user is already the active HOD of another department — use transfer-hod instead');
  }

  return user;
}

export const departmentService = {
  async create(input: CreateDepartmentInput, createdBy: string) {
    const { createHod, hod, hodId, ...departmentFields } = input;

    const department = await Department.create({ ...departmentFields, createdBy });

    if (createHod && hod) {
      const newHod = await userService.create({
        name: hod.name,
        email: hod.email,
        password: hod.password,
        phone: hod.phone,
        role: ROLES.HOD,
        department: department.id,
      });
      department.hod = newHod._id as typeof department.hod;
      await department.save();
    } else if (hodId) {
      const user = await loadAssignableHod(hodId);
      if (user.role !== ROLES.HOD) {
        user.role = ROLES.HOD;
      }
      user.department = department._id as typeof user.department;
      await user.save();
      department.hod = user._id as typeof department.hod;
      await department.save();
    }

    return department;
  },

  async list(query: Record<string, unknown>) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> = {};
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';

    const [items, total] = await Promise.all([
      Department.find(filter)
        .populate('hod', 'name email phone isActive')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit),
      Department.countDocuments(filter),
    ]);

    const itemsWithStats = await Promise.all(
      items.map(async (item) => Object.assign(item.toObject(), await getStatistics(item.id))),
    );

    return { items: itemsWithStats, meta: buildPaginationMeta(total, pagination) };
  },

  async getById(id: string) {
    const department = await Department.findById(id).populate('hod', 'name email phone isActive');
    if (!department) throw ApiError.notFound('Department not found');

    const statistics = await getStatistics(id);
    return Object.assign(department.toObject(), statistics);
  },

  async getAnalytics(departmentId: string) {
    const department = await Department.findById(departmentId).select('_id');
    if (!department) throw ApiError.notFound('Department not found');

    const [
      activeUsers,
      inactiveUsers,
      pendingQuotations,
      pendingBills,
      rejectedQuotations,
      rejectedBills,
      completedBills,
      weeklyQuotations,
      weeklyBills,
      monthlyRequirements,
      monthlyQuotations,
      monthlyPurchaseOrders,
      monthlyBills,
      vendorGrowth,
      quotationStatusBreakdown,
      billStatusBreakdown,
    ] = await Promise.all([
      User.countDocuments({ department: departmentId, role: ROLES.DEPARTMENT_USER, isActive: true }),
      User.countDocuments({ department: departmentId, role: ROLES.DEPARTMENT_USER, isActive: false }),
      Quotation.countDocuments({
        department: departmentId,
        isDeleted: { $ne: true },
        status: { $in: [QUOTATION_STATUS.SUBMITTED, QUOTATION_STATUS.NEGOTIATION, QUOTATION_STATUS.RESUBMITTED] },
      }),
      Bill.countDocuments({
        department: departmentId,
        isDeleted: { $ne: true },
        status: { $in: [BILL_STATUS.SUBMITTED, BILL_STATUS.AI_VERIFIED, BILL_STATUS.DIRECTOR_APPROVED] },
      }),
      Quotation.countDocuments({ department: departmentId, isDeleted: { $ne: true }, status: QUOTATION_STATUS.REJECTED }),
      Bill.countDocuments({
        department: departmentId,
        isDeleted: { $ne: true },
        status: { $in: [BILL_STATUS.DIRECTOR_REJECTED, BILL_STATUS.REJECTED] },
      }),
      Bill.countDocuments({
        department: departmentId,
        isDeleted: { $ne: true },
        status: { $in: [BILL_STATUS.PAID, BILL_STATUS.COMPLETED] },
      }),
      countGrouped(Quotation, departmentId, daysAgo(6), 'day'),
      countGrouped(Bill, departmentId, daysAgo(6), 'day'),
      countGrouped(Requirement, departmentId, monthsAgo(5), 'month'),
      countGrouped(Quotation, departmentId, monthsAgo(5), 'month'),
      countGrouped(PurchaseOrder, departmentId, monthsAgo(5), 'month'),
      countGrouped(Bill, departmentId, monthsAgo(5), 'month'),
      countGrouped(Vendor, departmentId, monthsAgo(5), 'month'),
      statusBreakdown(Quotation, departmentId),
      statusBreakdown(Bill, departmentId),
    ]);

    const weeklyActivity = weeklyQuotations.map((row, i) => ({
      date: row.key,
      quotations: row.count,
      bills: weeklyBills[i]?.count ?? 0,
    }));

    const monthlyTrend = monthlyQuotations.map((row, i) => ({
      month: row.key,
      quotations: row.count,
      bills: monthlyBills[i]?.count ?? 0,
    }));

    return {
      activeUsers,
      inactiveUsers,
      pendingApprovals: pendingQuotations + pendingBills,
      rejected: rejectedQuotations + rejectedBills,
      completed: completedBills,
      weeklyActivity,
      monthlyTrend,
      vendorGrowth: vendorGrowth.map((row) => ({ month: row.key, count: row.count })),
      requirementTrend: monthlyRequirements.map((row) => row.count),
      quotationTrend: monthlyQuotations.map((row) => row.count),
      purchaseOrderTrend: monthlyPurchaseOrders.map((row) => row.count),
      billTrend: monthlyBills.map((row) => row.count),
      quotationStatusBreakdown,
      billStatusBreakdown,
    };
  },

  async update(id: string, input: UpdateDepartmentInput) {
    const department = await Department.findByIdAndUpdate(id, input, {
      new: true,
      runValidators: true,
    });
    if (!department) throw ApiError.notFound('Department not found');
    return department;
  },

  async remove(id: string) {
    const department = await Department.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!department) throw ApiError.notFound('Department not found');
    return department;
  },

  /** Assigns, replaces, or moves a HOD onto `departmentId` — the single entry point for all
   *  post-creation HOD ownership changes (see plan §5). */
  async transferHod(departmentId: string, input: TransferHodInput) {
    const targetDept = await Department.findById(departmentId);
    if (!targetDept) throw ApiError.notFound('Department not found');

    const newHodUser = await User.findById(input.newHodId);
    if (!newHodUser) throw ApiError.notFound('HOD user not found');

    // Moving them off whatever department they were previously heading, if any.
    const sourceDept = await Department.findOne({ hod: newHodUser.id, isActive: true, _id: { $ne: departmentId } });
    if (sourceDept) {
      sourceDept.hod = undefined;
      await sourceDept.save();
    }

    // Replacing the target department's current HOD, if it has one.
    if (targetDept.hod && String(targetDept.hod) !== String(newHodUser.id)) {
      const previousHod = await User.findById(targetDept.hod);
      if (previousHod && input.demoteOldHod) {
        previousHod.role = ROLES.DEPARTMENT_USER;
        await previousHod.save();
      }
    }

    newHodUser.role = ROLES.HOD;
    newHodUser.department = targetDept._id as typeof newHodUser.department;
    await newHodUser.save();

    targetDept.hod = newHodUser._id as typeof targetDept.hod;
    await targetDept.save();

    return departmentService.getById(departmentId);
  },
};
