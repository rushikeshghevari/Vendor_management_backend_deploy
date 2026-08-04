import type { Request, Response } from 'express';
import { addressService } from '@/modules/address/address.service';

export const addressController = {
  getStates(_req: Request, res: Response) {
    const data = addressService.getStates();
    res.status(200).json({ success: true, data });
  },

  getStateById(req: Request, res: Response) {
    const { uuid4 } = req.params;
    const data = addressService.getStateById(uuid4 ?? '');
    if (!data) {
      return res.status(404).json({ success: false, message: 'State not found' });
    }
    res.status(200).json({ success: true, data });
  },

  getDistricts(req: Request, res: Response) {
    const { id } = req.params;
    const data = addressService.getDistrictsByState(id ?? '');
    res.status(200).json({ success: true, data });
  },

  getAllDistricts(_req: Request, res: Response) {
    const data = addressService.getAllDistricts();
    res.status(200).json({ success: true, data });
  },

  getDistrictById(req: Request, res: Response) {
    const { uuid4 } = req.params;
    const data = addressService.getDistrictById(uuid4 ?? '');
    if (!data) {
      return res.status(404).json({ success: false, message: 'District not found' });
    }
    res.status(200).json({ success: true, data });
  },

  getTalukas(req: Request, res: Response) {
    const { id } = req.params;
    const data = addressService.getTalukasByDistrict(id ?? '');
    res.status(200).json({ success: true, data });
  },

  getSubDistrictById(req: Request, res: Response) {
    const { uuid4 } = req.params;
    const data = addressService.getSubDistrictById(uuid4 ?? '');
    if (!data) {
      return res.status(404).json({ success: false, message: 'Sub district not found' });
    }
    res.status(200).json({ success: true, data });
  },
};
