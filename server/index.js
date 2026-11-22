'use strict';
// Entry point: `npm start`. Serves the web app on the clinic LAN, runs the
// daily encrypted backup and the trash purge.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const { createApp } = require('./app');
const { startOcrSidecar } = require('./ocr/autostart');

const HOUR = 60 * 60 * 1000;

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

function main() {
  const { app, ctx, close } = createApp();
  const { config, services } = ctx;
  const servers = [];

  const httpServer = http.createServer(app).listen(config.port, config.host, () => {
    console.log(`\n  IRBY Dental Ledger v${config.version}`);
    console.log(`  Local:    http://localhost:${config.port}`);
    for (const ip of lanAddresses()) console.log(`  Network:  http://${ip}:${config.port}`);
  });
  servers.push(httpServer);

  if (config.https.enabled) {
    if (!fs.existsSync(config.https.certFile) || !fs.existsSync(config.https.keyFile)) {
      console.error(`\n  HTTPS is enabled but no certificate was found at ${config.https.certFile}. Run: npm run cert\n`);
    } else {
      const tls = { cert: fs.readFileSync(config.https.certFile), key: fs.readFileSync(config.https.keyFile) };
      servers.push(https.createServer(tls, app).listen(config.https.port, config.host, () => {
        console.log(`  HTTPS:    https://localhost:${config.https.port}`);
        for (const ip of lanAddresses()) console.log(`            https://${ip}:${config.https.port}   (use this on tablets for live camera)`);
      }));
    }
  }

  console.log(`  Data:     ${config.dataDir}`);
  console.log(`  OCR:      ${ctx.ocr.name} - ${ctx.ocr.description}`);
  const ocrSidecar = startOcrSidecar(ctx);
  if (ctx.diagnostics) {
    const watchdogMs = Number(process.env.WATCHDOG_INTERVAL_MS) > 0 ? Number(process.env.WATCHDOG_INTERVAL_MS) : 15000;
    ctx.diagnostics.startWatchdog(watchdogMs);
    ctx.diagnostics.log('INFO', 'OK', 'runtime', `Server started on port ${config.port} (watchdog ${watchdogMs}ms)`);
    console.log(`  Diag log: ${ctx.diagnostics.logFile}`);
  }
  if (services.auth.countUsers() === 0) console.log('\n  First run: open the app to create the administrator account (or run `npm run seed:demo`).');

  const housekeeping = () => {
    try {
      services.auth.purgeExpiredSessions();
      services.trash.purgeExpired();
      if (config.backupsEnabled) {
        const made = services.backup.ensureDaily();
        if (made) console.log(`  Backup:   ${made.name} (${Math.round(made.size / 1024)} KB)`);
      }
    } catch (err) {
      console.error('[housekeeping]', err);
    }
  };
  housekeeping();
  const timer = setInterval(housekeeping, HOUR);

  const shutdown = () => {
    clearInterval(timer);
    ocrSidecar.stop();
    for (const s of servers) s.close();
    close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
