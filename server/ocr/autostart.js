'use strict';
// Automatically starts and stops the local Python OCR model server
// (ocr-model/server.py) alongside IRBY Dental Ledger so clinic staff never
// have to launch a separate process.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function isLocalHttpUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return (u.protocol === 'http:' || u.protocol === 'https:')
      && ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

async function isReachable(healthUrl) {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function resolvePythonBin() {
  const list = [];
  if (process.env.OCR_PYTHON) list.push(process.env.OCR_PYTHON);
  if (process.platform === 'win32') {
    list.push('python', 'py');
    const local = process.env.LOCALAPPDATA || '';
    const roots = [
      local ? path.join(local, 'Programs', 'Python') : '',
      'C:\\Program Files',
      'C:\\',
    ].filter(Boolean);
    for (const r of roots) {
      for (const ver of ['Python312', 'Python311', 'Python313', 'Python310']) {
        const exe = path.join(r, ver, 'python.exe');
        if (fs.existsSync(exe)) list.push(exe);
      }
    }
  } else {
    list.push('python3', 'python', '/usr/local/bin/python3', '/opt/homebrew/bin/python3');
  }
  return [...new Set(list)];
}

function startOcrSidecar(ctx) {
  const { config, diagnostics } = ctx;
  const noop = { stop: () => {}, started: false };

  if (String(process.env.OCR_AUTOSTART || 'true').toLowerCase() === 'false') return noop;
  if (!config || !config.ocr || config.ocr.provider !== 'http') return noop;
  if (!isLocalHttpUrl(config.ocr.httpUrl)) return noop;

  const script = path.join(config.root, 'ocr-model', 'server.py');
  if (!fs.existsSync(script)) return noop;

  const parsed = new URL(config.ocr.httpUrl);
  const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
  const port = parsed.port || '8765';
  const healthUrl = config.ocr.httpHealthUrl || `http://${host}:${port}/health`;

  let child = null;
  let stopping = false;
  let startedByUs = false;

  const log = (level, msg) => {
    if (diagnostics) diagnostics.log(level, level === 'WARN' ? 'ERR-OCR-001' : 'OK', 'ocr', msg);
  };

  const launch = (bins, idx = 0) => {
    if (stopping || idx >= bins.length) return;
    const bin = bins[idx];
    const args = bin === 'py'
      ? ['-3', script, '--host', host, '--port', String(port)]
      : [script, '--host', host, '--port', String(port)];

    try {
      child = spawn(bin, args, {
        cwd: config.root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: '3', TF_ENABLE_ONEDNN_OPTS: '0', PYTHONUNBUFFERED: '1' },
      });
    } catch {
      return launch(bins, idx + 1);
    }

    startedByUs = true;
    console.log(`  OCR Auto: starting local model server on http://${host}:${port} (${bin})...`);
    log('INFO', `Auto-starting local OCR model server (${bin}) on ${host}:${port}`);

    child.stdout.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line.includes('OCR model server on')) {
        console.log(`  OCR Auto: ${line}`);
        log('INFO', line);
      }
    });

    child.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        child = null;
        launch(bins, idx + 1);
      } else {
        log('WARN', `OCR sidecar error: ${err.message}`);
      }
    });

    child.on('exit', (code) => {
      child = null;
      if (!stopping && code && code !== 0) {
        log('WARN', `OCR sidecar exited with code ${code}`);
      }
    });
  };

  // Start asynchronously so the main clinic web server is available immediately
  isReachable(healthUrl).then((up) => {
    if (up || stopping) {
      if (up) console.log(`  OCR Auto: already running at http://${host}:${port}`);
      return;
    }
    launch(resolvePythonBin());
  });

  const stop = () => {
    stopping = true;
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch { /* ignore */ }
    child = null;
  };

  return { stop, get started() { return startedByUs; } };
}

module.exports = { startOcrSidecar };
