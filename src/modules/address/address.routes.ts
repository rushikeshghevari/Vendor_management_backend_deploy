import { Router } from 'express';
import { addressController } from '@/modules/address/address.controller';

const router = Router();

router.get('/state', addressController.getStates);
router.get('/state/:uuid4', addressController.getStateById);

router.get('/districts/:id', addressController.getDistricts);
router.get('/all-districts', addressController.getAllDistricts);
router.get('/district/:uuid4', addressController.getDistrictById);

router.get('/taluka/:id', addressController.getTalukas);
router.get('/sub_district/:uuid4', addressController.getSubDistrictById);

export default router;
