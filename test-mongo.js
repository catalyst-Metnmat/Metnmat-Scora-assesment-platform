// Quick MongoDB connection test. Run:  node test-mongo.js
// Reads MONGODB_URI from .env (or the environment).
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('No MONGODB_URI set in .env'); process.exit(1); }

// show the URI with the password masked
console.log('Testing:', uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@'));

(async () => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    console.log('\n✓ SUCCESS — connection and authentication work.');
  } catch (e) {
    console.error('\n✗ FAILED:', e.codeName || e.code || '', '-', e.message.split('\n')[0]);
    if (/bad auth|Authentication failed/i.test(e.message))
      console.error('  → Username or password is wrong. Fix the DB user in Atlas → Database Access.');
    else if (/ENOTFOUND|querySrv|timed out|ETIMEDOUT/i.test(e.message))
      console.error('  → Network/host issue. Check the cluster address and Atlas → Network Access (allow 0.0.0.0/0).');
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
