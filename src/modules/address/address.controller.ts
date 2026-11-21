import type { Request, Response } from 'express';
import { addressService } from '@/modules/address/address.service';
import { catchAsync } from '@/utils/catchAsync';

export const addressController = {
  getStates: catchAsync(async (_req: Request, res: Response) => {
    const data = await addressService.getStates();
    res.status(200).json({ success: true, data });
  }),

  getStateById: catchAsync(async (req: Request, res: Response) => {
    const { uuid4 } = req.params;
    const data = await addressService.getStateById(uuid4 ?? '');
    if (!data) {
      return res.status(404).json({ success: false, message: 'State not found' });
    }
    res.status(200).json({ success: true, data });
  }),

  getDistricts: catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const data = await addressService.getDistrictsByState(id ?? '');
    res.status(200).json({ success: true, data });
  }),

  getAllDistricts: catchAsync(async (_req: Request, res: Response) => {
    const data = await addressService.getAllDistricts();
    res.status(200).json({ success: true, data });
  }),

  getDistrictById: catchAsync(async (req: Request, res: Response) => {
    const { uuid4 } = req.params;
    const data = await addressService.getDistrictById(uuid4 ?? '');
    if (!data) {
      return res.status(404).json({ success: false, message: 'District not found' });
    }
    res.status(200).json({ success: true, data });
  }),

  getTalukas: catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const data = await addressService.getTalukasByDistrict(id ?? '');
    res.status(200).json({ success: true, data });
  }),

  getSubDistrictById: catchAsync(async (req: Request, res: Response) => {
    const { uuid4 } = req.params;
    const data = await addressService.getSubDistrictById(uuid4 ?? '');
    if (!data) {
      return res.status(404).json({ success: false, message: 'Sub district not found' });
    }
    res.status(200).json({ success: true, data });
  }),
};
