require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

const REQ_ID = '6a5de2eb93f18f1c9afbb6c2';

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db();

  const admin = await db.collection('users').findOne({ role: 'super_admin', status: { $ne: 'inactive' } });
  if (!admin) { console.log('No super_admin user found'); await client.close(); return; }

  const token = jwt.sign(
    { sub: String(admin._id), role: admin.role, department: admin.department ? String(admin.department) : undefined },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' },
  );

  const res = await fetch(`http://127.0.0.1:5007/api/v1/requirements/${REQ_ID}/comparison`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json();
  console.log('Status:', res.status);
  console.log(JSON.stringify(body, null, 2).slice(0, 800));

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
