'use strict';
// Generates a self-signed TLS certificate for the clinic LAN (npm run cert), so
// tablets can use the live camera preview (browsers require HTTPS for it).
// Then set HTTPS=true in .env. Browsers will warn once; accept/trust the cert.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const selfsigned = require('selfsigned');
const { loadConfig } = require('../server/config');

(async () => {
  const config = loadConfig();
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4').map((i) => i.address);
  const altNames = [{ type: 2, value: 'localhost' }, { type: 2, value: os.hostname() }, ...ips.map((ip) => ({ type: 7, ip }))];
  const pems = await selfsigned.generate([{ name: 'commonName', value: `IRBY Dental Ledger (${os.hostname()})` }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 825 * 24 * 3600 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.mkdirSync(path.dirname(config.https.certFile), { recursive: true });
  fs.writeFileSync(config.https.certFile, pems.cert);
  fs.writeFileSync(config.https.keyFile, pems.private, { mode: 0o600 });
  console.log(`Certificate: ${config.https.certFile}\nKey:         ${config.https.keyFile}`);
  console.log(`Valid for: localhost, ${os.hostname()}, ${ips.join(', ')}`);
  console.log('Now set HTTPS=true in .env and restart: npm start');
})().catch((err) => { console.error(err); process.exit(1); });
