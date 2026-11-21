import { ApiError } from '@/utils/ApiError';

export interface StateRecord {
  uuid4: string;
  state_name: string;
  name: string;
}

export interface DistrictRecord {
  uuid4: string;
  district_name: string;
  name: string;
  frgn_state_uuid4?: string;
}

export interface TalukaRecord {
  uuid4: string;
  sub_district_name: string;
  taluka_name: string;
  name: string;
  frgn_district_uuid4: string;
}

const EKAM_ADDRESS_BASE_URL = 'https://ekambackend.genericartmedicine.com/api/address';
// India's state/district/taluka master data effectively never changes — cache a day so every
// Vendor-form keystroke doesn't round-trip to a third-party service we don't control.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

function isFresh<T>(entry: CacheEntry<T> | undefined | null): entry is CacheEntry<T> {
  return !!entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

let statesCache: CacheEntry<StateRecord[]> | null = null;
let allDistrictsCache: CacheEntry<DistrictRecord[]> | null = null;
const districtsByStateCache = new Map<string, CacheEntry<DistrictRecord[]>>();
const talukasByDistrictCache = new Map<string, CacheEntry<TalukaRecord[]>>();

async function fetchUpstream<T>(path: string): Promise<T[]> {
  let res: globalThis.Response;
  try {
    res = await fetch(`${EKAM_ADDRESS_BASE_URL}${path}`);
  } catch {
    throw ApiError.internal('Could not reach the address lookup service. Please try again.');
  }
  if (!res.ok) {
    throw ApiError.internal(`Address lookup service returned ${res.status}`);
  }
  const json = (await res.json()) as { data?: T[] } | T[];
  return Array.isArray(json) ? json : (json.data ?? []);
}

export const addressService = {
  async getStates(): Promise<StateRecord[]> {
    if (isFresh(statesCache)) return statesCache.data;
    const raw = await fetchUpstream<Omit<StateRecord, 'name'>>('/state');
    const data = raw.map((s) => ({ ...s, name: s.state_name }));
    statesCache = { data, fetchedAt: Date.now() };
    return data;
  },

  async getStateById(uuid4: string): Promise<StateRecord | undefined> {
    const states = await addressService.getStates();
    return states.find((s) => s.uuid4 === uuid4 || s.state_name.toLowerCase() === uuid4.toLowerCase());
  },

  // Accepts either a state uuid4 or a state name (matching the Vendor form, which stores the
  // human-readable name on the vendor record rather than the upstream id) — resolves a name to
  // its uuid4 first since that's what the upstream API actually keys districts on.
  async getDistrictsByState(stateIdOrName: string): Promise<DistrictRecord[]> {
    const states = await addressService.getStates();
    const match = states.find(
      (s) => s.uuid4 === stateIdOrName || s.state_name.toLowerCase() === stateIdOrName.toLowerCase(),
    );
    const stateUuid = match ? match.uuid4 : stateIdOrName;

    const cached = districtsByStateCache.get(stateUuid);
    if (isFresh(cached)) return cached.data;
    const raw = await fetchUpstream<Omit<DistrictRecord, 'name'>>(`/districts/${encodeURIComponent(stateUuid)}`);
    const data = raw.map((d) => ({ ...d, name: d.district_name }));
    districtsByStateCache.set(stateUuid, { data, fetchedAt: Date.now() });
    return data;
  },

  async getAllDistricts(): Promise<DistrictRecord[]> {
    if (isFresh(allDistrictsCache)) return allDistrictsCache.data;
    const raw = await fetchUpstream<Omit<DistrictRecord, 'name'>>('/all-districts');
    const data = raw.map((d) => ({ ...d, name: d.district_name }));
    allDistrictsCache = { data, fetchedAt: Date.now() };
    return data;
  },

  async getDistrictById(uuid4: string): Promise<DistrictRecord | undefined> {
    const districts = await addressService.getAllDistricts();
    return districts.find((d) => d.uuid4 === uuid4 || d.district_name.toLowerCase() === uuid4.toLowerCase());
  },

  // Same uuid4-or-name acceptance as getDistrictsByState, resolved against the full district
  // list since talukas are keyed upstream by district uuid4.
  async getTalukasByDistrict(districtIdOrName: string): Promise<TalukaRecord[]> {
    const districts = await addressService.getAllDistricts();
    const match = districts.find(
      (d) => d.uuid4 === districtIdOrName || d.district_name.toLowerCase() === districtIdOrName.toLowerCase(),
    );
    const districtUuid = match ? match.uuid4 : districtIdOrName;

    const cached = talukasByDistrictCache.get(districtUuid);
    if (isFresh(cached)) return cached.data;
    const raw = await fetchUpstream<{ uuid4: string; sub_district_name: string; frgn_district_uuid4: string }>(
      `/taluka/${encodeURIComponent(districtUuid)}`,
    );
    const data = raw.map((t) => ({ ...t, taluka_name: t.sub_district_name, name: t.sub_district_name }));
    talukasByDistrictCache.set(districtUuid, { data, fetchedAt: Date.now() });
    return data;
  },

  // Unused by the app today (no screen looks up a single taluka by id) — the upstream API has
  // no "all talukas" endpoint to back a proper lookup, so this only finds a match among
  // districts already fetched via getTalukasByDistrict in this process's lifetime.
  async getSubDistrictById(uuid4: string): Promise<TalukaRecord | undefined> {
    for (const entry of talukasByDistrictCache.values()) {
      const found = entry.data.find((t) => t.uuid4 === uuid4);
      if (found) return found;
    }
    return undefined;
  },
};
