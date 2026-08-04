/**
 * migrateToAtlas.ts
 * Migrates all collections from local MongoDB to Atlas.
 * Run: npx tsx src/scripts/migrateToAtlas.ts
 */
import { MongoClient } from 'mongodb';
import * as fs from 'fs';
import * as path from 'path';

const LOCAL_URI  = process.env.LOCAL_MONGODB_URI  ?? 'mongodb://localhost:27017/vendor_management_system';
const ATLAS_URI  = process.env.MONGODB_URI ?? (() => { throw new Error('Set MONGODB_URI to your Atlas connection string'); })();
const DB_NAME    = 'vendor_management_system';
const BACKUP_DIR = path.join(__dirname, '../../../migration_backup');

const IMPORTANT_COLLECTIONS = [
  'users', 'vendors', 'quotations', 'purchaseorders',
  'bills', 'payments', 'notifications', 'auditlogs',
  'refreshtokens', 'settings',
];

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log('  MongoDB → Atlas Migration');
  console.log('══════════════════════════════════════════\n');

  // Setup DNS options to prevent querySrv ECONNREFUSED/ECONNRESET on Windows & IPv6
  try {
    const dns = await import('node:dns/promises');
    dns.setDefaultResultOrder('ipv4first');
    if (ATLAS_URI.startsWith('mongodb+srv://')) {
      const hostPart = ATLAS_URI.split('@')[1]?.split('/')[0]?.split('?')[0];
      if (hostPart) {
        const srvRecord = `_mongodb._tcp.${hostPart}`;
        try {
          await dns.resolveSrv(srvRecord);
        } catch (err: any) {
          console.warn(`[DNS] SRV lookup failed (${err.message}). Setting fallback DNS (8.8.8.8, 1.1.1.1)...`);
          dns.setServers(['8.8.8.8', '1.1.1.1']);
        }
      }
    }
  } catch (err: any) {
    console.warn('[DNS] Failed to verify or configure DNS fallback:', err.message);
  }

  // ── 1. Connect to both ─────────────────────────────────────────────────────
  console.log('Step 1/6  Connecting…');
  const local = new MongoClient(LOCAL_URI);
  const atlas = new MongoClient(ATLAS_URI);

  try {
    await local.connect();
    console.log('  ✓ Local MongoDB connected');
    await atlas.connect();
    console.log('  ✓ Atlas connected\n');

    const localDb = local.db(DB_NAME);
    const atlasDb = atlas.db(DB_NAME);

    // ── 2. List all local collections ──────────────────────────────────────
    console.log('Step 2/6  Discovering local collections…');
    const colInfos = await localDb.listCollections().toArray();
    const colNames = colInfos.map(c => c.name).filter(n => !n.startsWith('system.'));
    console.log(`  Found ${colNames.length} collections: ${colNames.join(', ')}\n`);

    // ── 3. Backup to JSON files ────────────────────────────────────────────
    console.log('Step 3/6  Creating local JSON backup…');
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const localCounts: Record<string, number> = {};

    for (const name of colNames) {
      const docs = await localDb.collection(name).find({}).toArray();
      localCounts[name] = docs.length;
      fs.writeFileSync(
        path.join(BACKUP_DIR, `${name}.json`),
        JSON.stringify(docs, null, 2),
      );
      console.log(`  ✓ ${name}: ${docs.length} docs  →  backup/${name}.json`);
    }
    console.log(`\n  Backup saved to: ${BACKUP_DIR}\n`);

    // ── 4. Migrate to Atlas ────────────────────────────────────────────────
    console.log('Step 4/6  Migrating to Atlas…');
    const atlasCounts: Record<string, number> = {};

    for (const name of colNames) {
      const docs = await localDb.collection(name).find({}).toArray();

      if (docs.length === 0) {
        console.log(`  ⊘ ${name}: empty — skipped`);
        atlasCounts[name] = 0;
        continue;
      }

      // Drop existing Atlas collection so we don't duplicate on re-run
      try { await atlasDb.collection(name).drop(); } catch {}

      // Insert in batches of 500 to stay under Atlas free-tier limits
      const BATCH = 500;
      for (let i = 0; i < docs.length; i += BATCH) {
        await atlasDb.collection(name).insertMany(docs.slice(i, i + BATCH), { ordered: false });
      }

      const count = await atlasDb.collection(name).countDocuments();
      atlasCounts[name] = count;
      const ok = count === docs.length;
      console.log(`  ${ok ? '✓' : '✗'} ${name}: ${docs.length} → Atlas ${count} ${ok ? '' : '⚠ MISMATCH'}`);
    }

    // ── 5. Restore indexes ─────────────────────────────────────────────────
    console.log('\nStep 5/6  Copying indexes…');
    for (const name of colNames) {
      const indexes = await localDb.collection(name).indexes();
      for (const idx of indexes) {
        if (idx.name === '_id_') continue; // Atlas creates this automatically
        try {
          const { key, name: idxName, ...opts } = idx;
          await atlasDb.collection(name).createIndex(key, { name: idxName, ...opts });
        } catch {
          // Index may already exist — ignore
        }
      }
      console.log(`  ✓ ${name} indexes copied`);
    }

    // ── 6. Verification report ─────────────────────────────────────────────
    console.log('\nStep 6/6  Verification\n');
    console.log('  Collection               Local    Atlas   OK?');
    console.log('  ─────────────────────────────────────────────');

    let allOk = true;
    const allCols = new Set([...Object.keys(localCounts), ...IMPORTANT_COLLECTIONS]);

    for (const name of allCols) {
      const local = localCounts[name] ?? 0;
      const remote = atlasCounts[name] ?? (await atlasDb.collection(name).countDocuments().catch(() => 0));
      const ok = local === remote;
      if (!ok) allOk = false;
      const flag = ok ? '✓' : '✗ MISMATCH';
      console.log(`  ${name.padEnd(24)} ${String(local).padStart(5)}  ${String(remote).padStart(6)}   ${flag}`);
    }

    console.log('  ─────────────────────────────────────────────');
    console.log(allOk
      ? '\n  ✅ Migration complete — all counts match!\n'
      : '\n  ⚠  Some collections have mismatches — check above.\n',
    );

    if (!allOk) process.exit(1);

  } finally {
    await local.close();
    await atlas.close();
  }
}

main().catch(err => {
  console.error('\n❌ Migration failed:', err.message);
  process.exit(1);
});
