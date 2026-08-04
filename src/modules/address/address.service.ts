export interface StateRecord {
  uuid4: string;
  state_name: string;
  name: string;
}

export interface DistrictRecord {
  uuid4: string;
  district_name: string;
  name: string;
  frgn_state_uuid4: string;
}

export interface TalukaRecord {
  uuid4: string;
  sub_district_name: string;
  taluka_name: string;
  name: string;
  frgn_district_uuid4: string;
}

// Master geography data matching POS database schema
const STATES: StateRecord[] = [
  { uuid4: 'st-001', state_name: 'Maharashtra', name: 'Maharashtra' },
  { uuid4: 'st-002', state_name: 'Gujarat', name: 'Gujarat' },
  { uuid4: 'st-003', state_name: 'Karnataka', name: 'Karnataka' },
  { uuid4: 'st-004', state_name: 'Delhi', name: 'Delhi' },
  { uuid4: 'st-005', state_name: 'Tamil Nadu', name: 'Tamil Nadu' },
  { uuid4: 'st-006', state_name: 'Telangana', name: 'Telangana' },
  { uuid4: 'st-007', state_name: 'Uttar Pradesh', name: 'Uttar Pradesh' },
  { uuid4: 'st-008', state_name: 'West Bengal', name: 'West Bengal' },
];

const DISTRICTS: DistrictRecord[] = [
  // Maharashtra
  { uuid4: 'dt-001', district_name: 'Mumbai City', name: 'Mumbai City', frgn_state_uuid4: 'st-001' },
  { uuid4: 'dt-002', district_name: 'Pune', name: 'Pune', frgn_state_uuid4: 'st-001' },
  { uuid4: 'dt-003', district_name: 'Thane', name: 'Thane', frgn_state_uuid4: 'st-001' },
  { uuid4: 'dt-004', district_name: 'Nashik', name: 'Nashik', frgn_state_uuid4: 'st-001' },
  { uuid4: 'dt-005', district_name: 'Nagpur', name: 'Nagpur', frgn_state_uuid4: 'st-001' },
  // Gujarat
  { uuid4: 'dt-006', district_name: 'Ahmedabad', name: 'Ahmedabad', frgn_state_uuid4: 'st-002' },
  { uuid4: 'dt-007', district_name: 'Surat', name: 'Surat', frgn_state_uuid4: 'st-002' },
  { uuid4: 'dt-008', district_name: 'Vadodara', name: 'Vadodara', frgn_state_uuid4: 'st-002' },
  // Karnataka
  { uuid4: 'dt-009', district_name: 'Bengaluru Urban', name: 'Bengaluru Urban', frgn_state_uuid4: 'st-003' },
  { uuid4: 'dt-010', district_name: 'Mysuru', name: 'Mysuru', frgn_state_uuid4: 'st-003' },
  // Delhi
  { uuid4: 'dt-011', district_name: 'New Delhi', name: 'New Delhi', frgn_state_uuid4: 'st-004' },
  { uuid4: 'dt-012', district_name: 'South Delhi', name: 'South Delhi', frgn_state_uuid4: 'st-004' },
];

const TALUKAS: TalukaRecord[] = [
  // Mumbai City
  { uuid4: 'tl-001', sub_district_name: 'Colaba', taluka_name: 'Colaba', name: 'Colaba', frgn_district_uuid4: 'dt-001' },
  { uuid4: 'tl-002', sub_district_name: 'Dharavi', taluka_name: 'Dharavi', name: 'Dharavi', frgn_district_uuid4: 'dt-001' },
  { uuid4: 'tl-003', sub_district_name: 'Kurla', taluka_name: 'Kurla', name: 'Kurla', frgn_district_uuid4: 'dt-001' },
  // Pune
  { uuid4: 'tl-004', sub_district_name: 'Pune City', taluka_name: 'Pune City', name: 'Pune City', frgn_district_uuid4: 'dt-002' },
  { uuid4: 'tl-005', sub_district_name: 'Haveli', taluka_name: 'Haveli', name: 'Haveli', frgn_district_uuid4: 'dt-002' },
  { uuid4: 'tl-006', sub_district_name: 'Baramati', taluka_name: 'Baramati', name: 'Baramati', frgn_district_uuid4: 'dt-002' },
  // Thane
  { uuid4: 'tl-007', sub_district_name: 'Thane', taluka_name: 'Thane', name: 'Thane', frgn_district_uuid4: 'dt-003' },
  { uuid4: 'tl-008', sub_district_name: 'Kalyan', taluka_name: 'Kalyan', name: 'Kalyan', frgn_district_uuid4: 'dt-003' },
  { uuid4: 'tl-009', sub_district_name: 'Bhiwandi', taluka_name: 'Bhiwandi', name: 'Bhiwandi', frgn_district_uuid4: 'dt-003' },
  // Ahmedabad
  { uuid4: 'tl-010', sub_district_name: 'Ghatlodia', taluka_name: 'Ghatlodia', name: 'Ghatlodia', frgn_district_uuid4: 'dt-006' },
  { uuid4: 'tl-011', sub_district_name: 'Sanand', taluka_name: 'Sanand', name: 'Sanand', frgn_district_uuid4: 'dt-006' },
  // Bengaluru Urban
  { uuid4: 'tl-012', sub_district_name: 'Bengaluru North', taluka_name: 'Bengaluru North', name: 'Bengaluru North', frgn_district_uuid4: 'dt-009' },
  { uuid4: 'tl-013', sub_district_name: 'Bengaluru South', taluka_name: 'Bengaluru South', name: 'Bengaluru South', frgn_district_uuid4: 'dt-009' },
];

export const addressService = {
  getStates(): StateRecord[] {
    return STATES;
  },

  getStateById(uuid4: string): StateRecord | undefined {
    return STATES.find((s) => s.uuid4 === uuid4 || s.state_name.toLowerCase() === uuid4.toLowerCase());
  },

  getDistrictsByState(stateIdOrName: string): DistrictRecord[] {
    const state = STATES.find(
      (s) => s.uuid4 === stateIdOrName || s.state_name.toLowerCase() === stateIdOrName.toLowerCase(),
    );
    const targetId = state ? state.uuid4 : stateIdOrName;
    return DISTRICTS.filter((d) => d.frgn_state_uuid4 === targetId || d.frgn_state_uuid4 === stateIdOrName);
  },

  getAllDistricts(): DistrictRecord[] {
    return DISTRICTS;
  },

  getDistrictById(uuid4: string): DistrictRecord | undefined {
    return DISTRICTS.find((d) => d.uuid4 === uuid4 || d.district_name.toLowerCase() === uuid4.toLowerCase());
  },

  getTalukasByDistrict(districtIdOrName: string): TalukaRecord[] {
    const dist = DISTRICTS.find(
      (d) => d.uuid4 === districtIdOrName || d.district_name.toLowerCase() === districtIdOrName.toLowerCase(),
    );
    const targetId = dist ? dist.uuid4 : districtIdOrName;
    return TALUKAS.filter((t) => t.frgn_district_uuid4 === targetId || t.frgn_district_uuid4 === districtIdOrName);
  },

  getSubDistrictById(uuid4: string): TalukaRecord | undefined {
    return TALUKAS.find((t) => t.uuid4 === uuid4 || t.sub_district_name.toLowerCase() === uuid4.toLowerCase());
  },
};
