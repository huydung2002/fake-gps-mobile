const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const execAsync = promisify(exec);

function logDebug(msg) {
    try {
        fs.appendFileSync(path.join(__dirname, 'gps_debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {}
}

function normalizeCliText(text = '') {
    return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function withAutoEnter(command) {
    if (process.platform !== 'win32') return command;
    return `cmd /d /s /c "echo.| ${command}"`;
}

function parseExecError(err) {
    const raw = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n');
    const text = normalizeCliText(raw);
    const lower = text.toLowerCase();

    if (lower.includes('requires admin privileges') || lower.includes('run-as administrator')) {
        return 'Cần quyền Administrator. Hãy đóng app và mở lại bằng "Run as administrator".';
    }
    if (lower.includes('device is not connected')) {
        return 'Thiết bị chưa kết nối ổn định. Hãy mở khóa iPhone, bấm Trust, rồi rút/cắm lại cáp USB.';
    }
    if (lower.includes('connection was terminated abruptly')) {
        return 'Kết nối tới iPhone bị ngắt đột ngột. Hãy mở khóa iPhone, giữ màn hình sáng và thử lại.';
    }
    if (lower.includes("'number': 183") || lower.includes('number: 183')) {
        return 'Không thể ghi pair record (Mux 183). Hãy chạy app bằng Administrator, mở khóa iPhone và bấm Trust lại.';
    }
    return text || 'Lỗi không xác định từ công cụ dòng lệnh.';
}

async function listUsbMuxDevices(py) {
    try {
        const { stdout } = await execAsync(`${py} -m pymobiledevice3 --no-color usbmux list --usb --simple`, { timeout: 6000 });
        const raw = String(stdout || '').trim();
        if (!raw) return [];

        // New pymobiledevice3 returns JSON array even in --simple mode.
        if (raw.startsWith('[')) {
            try {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    return arr
                        .map(v => String(v).trim())
                        .filter(v => /^[0-9a-fA-F-]{24,}$/.test(v));
                }
            } catch { }
        }

        return raw
            .split(/\r?\n/)
            .map(line => line.replace(/[",\[\]]/g, '').trim())
            .filter(line => /^[0-9a-fA-F-]{24,}$/.test(line));
    } catch (e) {
        logDebug(`listUsbMuxDevices failed: ${parseExecError(e)}`);
        return [];
    }
}

async function isWindowsAdmin() {
    if (process.platform !== 'win32') return true;
    try {
        const cmd = 'powershell -NoProfile -Command "[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent() | ForEach-Object { $_.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }"';
        const { stdout } = await execAsync(cmd, { timeout: 4000 });
        return String(stdout).trim().toLowerCase().includes('true');
    } catch {
        return false;
    }
}

async function relaunchAsAdmin() {
    if (process.platform !== 'win32') return false;
    try {
        const args = process.argv.slice(1).map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(', ');
        const psCommand = `Start-Process -FilePath "${process.execPath}" -ArgumentList ${args ? `@(${args})` : '@()'} -Verb RunAs`;
        await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCommand}"`, { timeout: 10000 });
        return true;
    } catch (e) {
        logDebug(`relaunchAsAdmin failed: ${parseExecError(e)}`);
        return false;
    }
}

let mainWindow;
let tunneldProc = null;

// ─── Persistent Tunnel State ───────────────────────────────────────────────
let pTunnel = {
    proc: null,
    host: null,
    port: null,
    udid: null,
    py: null,
    status: 'idle', // 'idle' | 'connecting' | 'ready' | 'error'
    error: null,
};

function getPTunnelStatus() {
    return {
        status: pTunnel.status,
        host: pTunnel.host,
        port: pTunnel.port,
        udid: pTunnel.udid,
        error: pTunnel.error,
    };
}

// ─── Location Worker (Python persistent process) ───────────────────────────────────
let lWorker = {
    proc: null,
    status: 'idle', // 'idle' | 'starting' | 'ready' | 'error'
    buf: '',
    pending: null, // { resolve, reject, timer }
    failCount: 0,  // consecutive failures
};

function teardownLocationWorker() {
    if (lWorker.pending) {
        clearTimeout(lWorker.pending.timer);
        try { lWorker.pending.reject(new Error('Worker torn down')); } catch {}
        lWorker.pending = null;
    }
    if (lWorker.proc && !lWorker.proc.killed) {
        try { lWorker.proc.stdin.write('quit\n'); } catch {}
        try { lWorker.proc.kill(); } catch {}
    }
    lWorker.proc = null;
    lWorker.status = 'idle';
    lWorker.buf = '';
    logDebug('Location worker torn down.');
}

function startLocationWorker(py, host, port) {
    // Stop retrying if worker consistently fails (wrong API/env)
    if (lWorker.failCount >= 3) {
        logDebug('Worker disabled after 3 consecutive failures.');
        return Promise.resolve({ ok: false, error: 'Worker disabled after repeated failures' });
    }
    teardownLocationWorker();
    lWorker.status = 'starting';
    const script = path.join(__dirname, 'location_worker.py');
    logDebug(`Starting worker (attempt, fails so far=${lWorker.failCount}): ${py} ${script} ${host} ${port}`);

    return new Promise((resolve) => {
        const proc = spawn(py, [script, String(host), String(port)], { windowsHide: true });
        lWorker.proc = proc;
        let resolved = false;

        const finish = (ok, err) => {
            if (resolved) return;
            resolved = true;
            resolve({ ok, error: err });
        };

        proc.stdout.on('data', (data) => {
            lWorker.buf += data.toString();
            const lines = lWorker.buf.split('\n');
            lWorker.buf = lines.pop() || '';
            for (const line of lines) {
                const t = line.trim();
                if (!t) continue;
                logDebug(`Worker out: ${t}`);
                let msg;
                try { msg = JSON.parse(t); } catch { continue; }

                if (msg.status === 'ready' && !resolved) {
                    lWorker.status = 'ready';
                    lWorker.failCount = 0; // reset on success
                    logDebug('Location worker READY ⚡');
                    if (mainWindow && !mainWindow.isDestroyed())
                        mainWindow.webContents.send('worker-ready', {});
                    finish(true);
                } else if (msg.error && !resolved) {
                    lWorker.status = 'error';
                    lWorker.failCount += 1;
                    logDebug(`Worker failed (failCount=${lWorker.failCount}): ${msg.error}`);
                    finish(false, msg.error);
                } else if (lWorker.pending) {
                    // Response to a setLocation call
                    const p = lWorker.pending;
                    lWorker.pending = null;
                    clearTimeout(p.timer);
                    p.resolve(msg);
                }
            }
        });

        proc.stderr.on('data', (d) => logDebug(`Worker err: ${d.toString().trim()}`));

        proc.on('close', (code) => {
            logDebug(`Worker closed (code ${code})`);
            lWorker.status = 'error';
            if (lWorker.pending) {
                const p = lWorker.pending;
                lWorker.pending = null;
                clearTimeout(p.timer);
                p.reject(new Error(`Worker exited code ${code}`));
            }
            if (!resolved) finish(false, `Worker exited code ${code}`);
            if (mainWindow && !mainWindow.isDestroyed())
                mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());
        });

        setTimeout(() => {
            if (!resolved) {
                lWorker.status = 'error';
                finish(false, 'Worker startup timeout');
            }
        }, 25000);
    });
}

function setLocationViaWorker(lat, lng) {
    return new Promise((resolve, reject) => {
        if (lWorker.status !== 'ready' || !lWorker.proc || lWorker.proc.killed)
            return reject(new Error('Worker not ready'));
        // Supersede any in-flight keepAlive
        if (lWorker.pending) {
            clearTimeout(lWorker.pending.timer);
            lWorker.pending.reject(new Error('Superseded'));
            lWorker.pending = null;
        }
        const timer = setTimeout(() => {
            if (lWorker.pending?.resolve === resolve) {
                lWorker.pending = null;
                lWorker.status = 'error';
                reject(new Error('Worker response timeout'));
            }
        }, 6000);
        lWorker.pending = { resolve, reject, timer };
        try {
            lWorker.proc.stdin.write(`${lat},${lng}\n`);
        } catch (e) {
            clearTimeout(timer);
            lWorker.pending = null;
            reject(e);
        }
    });
}

// Send any one-shot command to the worker and await a single JSON response line.
function sendWorkerCommand(cmd, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        if (lWorker.status !== 'ready' || !lWorker.proc || lWorker.proc.killed)
            return reject(new Error('Worker not ready'));
        if (lWorker.pending) {
            clearTimeout(lWorker.pending.timer);
            lWorker.pending.reject(new Error('Superseded'));
            lWorker.pending = null;
        }
        const timer = setTimeout(() => {
            if (lWorker.pending?.resolve === resolve) {
                lWorker.pending = null;
                reject(new Error(`Worker command "${cmd}" timeout`));
            }
        }, timeoutMs);
        lWorker.pending = { resolve, reject, timer };
        try {
            lWorker.proc.stdin.write(`${cmd}\n`);
        } catch (e) {
            clearTimeout(timer);
            lWorker.pending = null;
            reject(e);
        }
    });
}

function teardownPTunnel() {
    teardownLocationWorker();
    if (pTunnel.proc && !pTunnel.proc.killed) {
        try { pTunnel.proc.kill(); } catch {}
    }
    pTunnel.proc = null;
    pTunnel.host = null;
    pTunnel.port = null;
    pTunnel.status = 'idle';
    pTunnel.error = null;
    logDebug('Persistent tunnel torn down.');
}

function tryStartTunnelProc(py, udid, mode, includeUdid) {
    return new Promise((resolve) => {
        const args = ['-m', 'pymobiledevice3', '--no-color'];
        if (mode === 'lockdown') {
            args.push('lockdown', 'start-tunnel');
        } else {
            args.push('remote', 'start-tunnel', '--script-mode', '--connection-type', 'usb', '--protocol', 'tcp');
        }
        if (includeUdid && udid && udid !== 'auto') args.push('--udid', udid);

        logDebug(`tryStartTunnelProc [${mode},uid=${includeUdid}]: ${py} ${args.join(' ')}`);
        const proc = spawn(py, args, { windowsHide: true });
        let resolved = false;
        let buf = '';

        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            if (!result.ok && !proc.killed) try { proc.kill(); } catch {}
            resolve(result);
        };

        proc.stdout.on('data', (data) => {
            const str = data.toString();
            buf += str;
            logDebug(`tunnel[${mode}] stdout: ${str.trim()}`);
            const clean = normalizeCliText(buf);
            const jm = clean.match(/"host"\s*:\s*"([^"]+)"[\s\S]*?"port"\s*:\s*(\d+)/i);
            const rm = clean.match(/RSD Address:\s*([^\s\r\n]+)/i);
            const rp = clean.match(/RSD Port:\s*(\d+)/i);
            const pm = clean.match(/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\s+(\d+)/);
            const host = jm?.[1] || rm?.[1] || pm?.[1];
            const port = jm?.[2] || rp?.[1] || pm?.[2];
            if (host && port) finish({ ok: true, host, port, proc });
        });

        proc.stderr.on('data', (data) => {
            const str = data.toString();
            buf += str;
            logDebug(`tunnel[${mode}] stderr: ${str.trim()}`);
            if (str.includes('requires admin privileges'))
                finish({ ok: false, error: 'Cần quyền Administrator.', reason: 'admin' });
        });

        proc.on('close', (code) => {
            logDebug(`tunnel[${mode}] closed code=${code}`);
            if (!resolved) finish({ ok: false, error: `Tunnel [${mode}] đóng (code ${code})`, reason: 'closed' });
        });

        setTimeout(() => finish({ ok: false, error: `Timeout tunnel [${mode}]`, reason: 'timeout' }), 18000);
    });
}

async function setupPersistentTunnel(py, udid) {
    // Reuse existing ready tunnel for same device
    if (
        pTunnel.status === 'ready' &&
        pTunnel.udid === udid &&
        pTunnel.py === py &&
        pTunnel.proc && !pTunnel.proc.killed && pTunnel.proc.exitCode === null
    ) {
        logDebug(`Reusing existing tunnel ${pTunnel.host}:${pTunnel.port}`);
        return { ok: true, host: pTunnel.host, port: pTunnel.port, reused: true };
    }

    teardownPTunnel();
    pTunnel.status = 'connecting';
    pTunnel.udid = udid;
    pTunnel.py = py;

    if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());

    const modes = [
        { mode: 'lockdown', includeUdid: true },
        { mode: 'lockdown', includeUdid: false },
        { mode: 'remote',   includeUdid: true },
        { mode: 'remote',   includeUdid: false },
    ];

    for (const { mode, includeUdid } of modes) {
        if (includeUdid && (!udid || udid === 'auto')) continue;
        const res = await tryStartTunnelProc(py, udid, mode, includeUdid);
        if (res.ok) {
            pTunnel.proc = res.proc;
            pTunnel.host = res.host;
            pTunnel.port = res.port;
            pTunnel.status = 'ready';
            pTunnel.error = null;
            logDebug(`Persistent tunnel READY: ${res.host}:${res.port} via ${mode}`);

            // Auto-start Python worker (fire-and-forget)
            startLocationWorker(py, res.host, res.port).then(r => {
                logDebug(`Worker start: ok=${r.ok} err=${r.error || ''}`);
            });

            // Watch for unexpected death
            res.proc.on('close', (code) => {
                if (pTunnel.proc === res.proc) {
                    logDebug(`Persistent tunnel died (code ${code})`);
                    pTunnel.status = 'error';
                    pTunnel.error = `Tunnel thoát bất ngờ (code ${code})`;
                    pTunnel.host = null;
                    pTunnel.port = null;
                }
                if (mainWindow && !mainWindow.isDestroyed())
                    mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());
            });

            if (mainWindow && !mainWindow.isDestroyed())
                mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());

            return { ok: true, host: res.host, port: res.port };
        }
        if (res.reason === 'admin') {
            pTunnel.status = 'error';
            pTunnel.error = res.error;
            if (mainWindow && !mainWindow.isDestroyed())
                mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());
            return { ok: false, error: res.error, reason: 'admin' };
        }
    }

    pTunnel.status = 'error';
    pTunnel.error = 'Không thể khởi tạo tunnel';
    if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());
    return { ok: false, error: 'Không thể khởi tạo tunnel tới iPhone.' };
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        frame: false,
        backgroundColor: '#0f172a',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(__dirname, 'icon.png'),
        titleBarStyle: 'hidden',
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    // mainWindow.webContents.openDevTools(); // uncomment for debug
}

async function ensureTunneld(py) {
    if (tunneldProc && !tunneldProc.killed && tunneldProc.exitCode === null) {
        return true;
    }

    return new Promise((resolve) => {
        logDebug('Starting background tunneld process...');
        const proc = spawn(py, ['-m', 'pymobiledevice3', '--no-color', 'remote', 'tunneld'], { windowsHide: true });
        tunneldProc = proc;
        let resolved = false;
        let output = '';

        const finish = (ok) => {
            if (resolved) return;
            resolved = true;
            resolve(ok);
        };

        proc.stdout.on('data', (d) => {
            const s = d.toString();
            output += s;
            logDebug(`tunneld stdout: ${s.trim()}`);
        });
        proc.stderr.on('data', (d) => {
            const s = d.toString();
            output += s;
            logDebug(`tunneld stderr: ${s.trim()}`);
        });
        proc.on('close', (code) => {
            logDebug(`tunneld closed with code ${code}`);
            if (!resolved) finish(false);
        });

        setTimeout(() => {
            if (proc.exitCode === null) {
                logDebug('tunneld appears running.');
                finish(true);
            } else {
                logDebug(`tunneld failed to stay running. output=${normalizeCliText(output)}`);
                finish(false);
            }
        }, 2500);
    });
}

app.whenReady().then(async () => {
    if (process.platform === 'win32') {
        const admin = await isWindowsAdmin();
        if (!admin && !process.argv.includes('--elevated-relaunch')) {
            const relaunched = await relaunchAsAdmin();
            if (relaunched) {
                app.quit();
                return;
            }
        }
    }

    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ─── Window controls ───────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
});
ipcMain.on('win-close', () => mainWindow?.close());

// ─── Detect available tool ─────────────────────────────────────────────────
async function detectTool() {
    // 1. idevicesetlocation (libimobiledevice)
    try {
        await execAsync('idevicesetlocation --help', { timeout: 3000 });
        return 'idevicesetlocation';
    } catch { }

    // Check bundled binary
    const bundled = path.join(__dirname, 'bin', 'idevicesetlocation.exe');
    const fs = require('fs');
    if (fs.existsSync(bundled)) return 'bundled';

    // 2. pymobiledevice3
    try {
        await execAsync('python -m pymobiledevice3 --help', { timeout: 5000 });
        return 'pymobiledevice3';
    } catch { }

    try {
        await execAsync('python3 -m pymobiledevice3 --help', { timeout: 5000 });
        return 'pymobiledevice3-3';
    } catch { }

    return null;
}

// ─── Auto-install pymobiledevice3 ────────────────────────────────────────────
async function getPythonCmd() {
    for (const cmd of ['python', 'python3', 'py']) {
        try {
            const { stdout } = await execAsync(`${cmd} --version`, { timeout: 3000 });
            if (stdout.includes('Python') || (await execAsync(`${cmd} --version 2>&1`)).stderr?.includes('Python')) {
                return cmd;
            }
        } catch { }
    }
    return null;
}

async function installTool(win) {
    const py = await getPythonCmd();
    if (!py) return { ok: false, step: 'python', message: 'Chưa cài Python. Tải tại python.org' };
    return new Promise((resolve) => {
        const proc = spawn(py, ['-m', 'pip', 'install', 'pymobiledevice3', '--upgrade'], {
            shell: true, windowsHide: true
        });
        let output = '';
        proc.stdout.on('data', d => {
            output += d.toString();
            win.webContents.send('install-progress', d.toString());
        });
        proc.stderr.on('data', d => {
            output += d.toString();
            win.webContents.send('install-progress', d.toString());
        });
        proc.on('close', code => {
            resolve({ ok: code === 0, output, code });
        });
    });
}

async function getDevices() {
    const devices = [];
    const seenUdids = new Set();
    const pushUniqueDevice = (device) => {
        const udid = String(device?.udid || '').trim();
        if (!udid || seenUdids.has(udid)) return;
        seenUdids.add(udid);
        devices.push({ ...device, udid });
    };

    // Method 1: idevice_id (libimobiledevice)
    try {
        const { stdout } = await execAsync('idevice_id -l', { timeout: 4000 });
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const udid = parts[0];
            const connType = parts[1] ? (parts[1].toLowerCase().includes('network') ? 'WiFi' : 'USB') : 'USB';
            let name = 'iPhone';
            try {
                const { stdout: info } = await execAsync(`ideviceinfo -u ${udid} -k DeviceName`, { timeout: 3000 });
                name = info.trim() || 'iPhone';
            } catch { }
            pushUniqueDevice({ udid, name, connectionType: connType, source: 'idevice_id' });
        }
        if (devices.length) return devices;
    } catch { }

    // Method 2: pymobiledevice3 usbmux list (full JSON — has ConnectionType, DeviceName)
    try {
        const py = await getPythonCmd();
        if (py) {
            // Try full JSON list first (has ConnectionType + product info)
            try {
                const { stdout } = await execAsync(
                    `${py} -m pymobiledevice3 --no-color usbmux list`,
                    { timeout: 7000 }
                );
                const raw = normalizeCliText(stdout || '').trim();
                // May be a JSON array of device objects
                const jsonStart = raw.indexOf('[');
                if (jsonStart !== -1) {
                    const arr = JSON.parse(raw.slice(jsonStart));
                    if (Array.isArray(arr)) {
                        for (const item of arr) {
                            const udid = item?.SerialNumber || item?.udid || item?.UDID || '';
                            if (!udid || !/^[0-9a-fA-F-]{8,}/.test(udid)) continue;
                            const connType = String(item?.ConnectionType || 'USB').includes('Network') ? 'WiFi' : 'USB';
                            const name = item?.DeviceName || item?.ProductType || 'iPhone';
                            const model = item?.ProductType || '';
                            pushUniqueDevice({ udid, name, connectionType: connType, model, source: 'pymobiledevice3-full' });
                        }
                    }
                }
                if (devices.length) return devices;
            } catch { }

            // Fallback: simple UDID list
            const fallbackUdids = await listUsbMuxDevices(py);
            fallbackUdids.forEach(udid =>
                pushUniqueDevice({ udid, name: 'iPhone', connectionType: 'USB', model: '', source: 'pymobiledevice3-simple' })
            );
        }
    } catch { }

    return devices;
}

// ─── Set location ──────────────────────────────────────────────────────────
async function setLocation(lat, lng, udid) {
    const tool = await detectTool();

    if (tool === 'pymobiledevice3' || tool === 'pymobiledevice3-3') {
        const py = tool === 'pymobiledevice3-3' ? 'python3' : 'python';

        if (process.platform === 'win32') {
            const admin = await isWindowsAdmin();
            if (!admin) return { ok: false, error: 'Ứng dụng chưa chạy quyền Administrator. Hãy đóng app và mở lại bằng Run as administrator.' };
        }

        // ── FASTEST PATH: Python worker (persistent DVT connection, ~100ms) ────
        if (lWorker.status === 'ready' && lWorker.proc && !lWorker.proc.killed) {
            logDebug(`Worker path → ${lat},${lng}`);
            try {
                const res = await setLocationViaWorker(lat, lng);
                if (res.ok) return { ok: true, method: 'worker', output: '' };
                logDebug(`Worker error: ${res.error} — falling back`);
                lWorker.status = 'error';
            } catch (e) {
                logDebug(`Worker exception: ${e.message} — falling back`);
                lWorker.status = 'error';
            }
        }

        // ── FAST PATH: reuse tunnel, spawn only simulate-location cmd (~1.5s) ──
        const tunnelAlive =
            pTunnel.status === 'ready' &&
            pTunnel.host && pTunnel.port &&
            pTunnel.proc && !pTunnel.proc.killed && pTunnel.proc.exitCode === null;

        if (tunnelAlive) {
            logDebug(`Tunnel exec path → rsd ${pTunnel.host}:${pTunnel.port} — ${lat},${lng}`);
            const cmd = `${py} -m pymobiledevice3 --no-color developer dvt simulate-location set --rsd ${pTunnel.host} ${pTunnel.port} -- ${lat} ${lng}`;
            try {
                const { stdout, stderr } = await execAsync(withAutoEnter(cmd), { timeout: 12000 });
                const out = stdout || stderr || '';
                if (!out.includes('ERROR') && !out.includes('InvalidServiceError') && !out.includes('Traceback')) {
                    // Worker died/never started — try restarting it
                    if (lWorker.status !== 'starting')
                        startLocationWorker(py, pTunnel.host, pTunnel.port);
                    return { ok: true, method: 'fast-tunnel', output: out };
                }
                pTunnel.status = 'error';
                pTunnel.error = 'Phản hồi lỗi từ tunnel';
                if (mainWindow && !mainWindow.isDestroyed())
                    mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());
            } catch (e) {
                pTunnel.status = 'error';
                pTunnel.error = parseExecError(e);
                if (mainWindow && !mainWindow.isDestroyed())
                    mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());
            }
        }
    }
    // Fall through to original slow-path logic below
    return setLocationSlow(lat, lng, udid);
}

async function setLocationSlow(lat, lng, udid) {
    const tool = await detectTool();

    if (tool === 'idevicesetlocation' || tool === 'bundled') {
        const bin = tool === 'bundled'
            ? `"${path.join(__dirname, 'bin', 'idevicesetlocation.exe')}"`
            : 'idevicesetlocation';
        const udidFlag = udid ? `-u ${udid}` : '';
        const cmd = `${bin} ${udidFlag} -- ${lat} ${lng}`;
        try {
            const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
            const out = stdout || stderr || '';
            if (out.includes('ERROR') || out.includes('Failed')) return { ok: false, error: out };
            return { ok: true, method: 'idevicesetlocation', output: out };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    if (tool === 'pymobiledevice3' || tool === 'pymobiledevice3-3') {
        const py = tool === 'pymobiledevice3-3' ? 'python3' : 'python';
        const udidFlag = (udid && udid !== 'auto') ? `--udid ${udid}` : '';

        logDebug(`--- Bắt đầu setLocation tới ${lat}, ${lng} ---`);

        if (process.platform === 'win32') {
            const admin = await isWindowsAdmin();
            if (!admin) {
                logDebug('Abort setLocation: process is not running as Administrator.');
                return {
                    ok: false,
                    error: 'Ứng dụng chưa chạy quyền Administrator. Hãy đóng app và mở lại terminal bằng Run as administrator.'
                };
            }
        }

        const onlineUdids = await listUsbMuxDevices(py);
        if (!onlineUdids.length) {
            return {
                ok: false,
                error: 'Không thấy iPhone online qua USB. Hãy mở khóa máy, bấm Trust, rồi nhấn làm mới thiết bị.'
            };
        }
        if (udid && udid !== 'auto' && !onlineUdids.includes(udid)) {
            return {
                ok: false,
                error: 'Thiết bị đã chọn không còn online. Hãy chọn lại thiết bị rồi thử dịch chuyển lại.'
            };
        }

        logDebug('Sử dụng tunnel mode cho pymobiledevice3.');

        const runTunnelAttempt = (mode, includeUdid) => new Promise((resolve) => {
            const args = ['-m', 'pymobiledevice3', '--no-color'];
            if (mode === 'lockdown') {
                args.push('lockdown', 'start-tunnel');
            } else {
                args.push('remote', 'start-tunnel', '--script-mode', '--connection-type', 'usb', '--protocol', 'tcp');
            }
            if (includeUdid && udid && udid !== 'auto') args.push('--udid', udid);

            logDebug(`Spawn ${mode} start-tunnel: ${py} ${args.join(' ')}`);
            const tunnelProc = spawn(py, args);
            let resolved = false;
            let output = '';
            let tunnelBuffer = '';

            const tryResolveTunnel = async (text) => {
                if (resolved) return false;
                const clean = normalizeCliText(text);
                const jsonMatch = clean.match(/"host"\s*:\s*"([^"]+)"[\s\S]*?"port"\s*:\s*(\d+)/i);
                const pairMatch = clean.match(/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\s+(\d+)/);
                const rsdHostMatch = clean.match(/RSD Address:\s*([^\s\r\n]+)/i);
                const rsdPortMatch = clean.match(/RSD Port:\s*(\d+)/i);
                const host = jsonMatch?.[1] || pairMatch?.[1] || rsdHostMatch?.[1];
                const port = jsonMatch?.[2] || pairMatch?.[2] || rsdPortMatch?.[1];
                if (!host || !port) return false;
                resolved = true;
                try {
                    // Tunnel may report ready slightly before the virtual route is usable on Windows.
                    await delay(1500);
                    let lastErr = '';
                    let ok = false;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        const cmd17 = `${py} -m pymobiledevice3 --no-color developer dvt simulate-location set --rsd ${host} ${port} -- ${lat} ${lng}`;
                        logDebug(`Chạy cmd17 (attempt ${attempt}/3): ${cmd17}`);
                        try {
                            const { stdout, stderr } = await execAsync(withAutoEnter(cmd17), { timeout: 20000 });
                            const out17 = stdout || stderr || '';
                            logDebug(`cmd17 output (attempt ${attempt}):\n${out17}`);
                            if (!out17.includes('ERROR') && !out17.includes('InvalidServiceError') && !out17.includes('Traceback')) {
                                resolve({ ok: true, method: 'pymobiledevice3 (tunnel)', output: out17 });
                                ok = true;
                                break;
                            }
                            lastErr = out17 || 'Unknown DVT error';
                        } catch (e) {
                            const errText = parseExecError(e);
                            const errRaw = normalizeCliText([e?.stdout, e?.stderr, e?.message].filter(Boolean).join('\n'));
                            lastErr = errRaw || errText;
                            logDebug(`cmd17 catch error (attempt ${attempt}): ${lastErr}`);
                        }
                        await delay(1200);
                    }
                    if (!ok) {
                        const lowerErr = String(lastErr || '').toLowerCase();
                        const isRouteIssue = lowerErr.includes('winerror 1231') || lowerErr.includes('network location cannot be reached') || lowerErr.includes('press enter to exit');

                        if (isRouteIssue && udid && udid !== 'auto') {
                            logDebug('RSD route issue detected, fallback to --tunnel mode...');
                            const tunneldOk = await ensureTunneld(py);
                            if (tunneldOk) {
                                const cmdTunnel = `${py} -m pymobiledevice3 --no-color developer dvt simulate-location set --tunnel ${udid} -- ${lat} ${lng}`;
                                logDebug(`Chạy fallback cmdTunnel: ${cmdTunnel}`);
                                try {
                                    const { stdout, stderr } = await execAsync(withAutoEnter(cmdTunnel), { timeout: 25000 });
                                    const outTunnel = stdout || stderr || '';
                                    logDebug(`cmdTunnel output:\n${outTunnel}`);
                                    if (!outTunnel.includes('ERROR') && !outTunnel.includes('Traceback')) {
                                        resolve({ ok: true, method: 'pymobiledevice3 (tunnel-daemon)', output: outTunnel });
                                        return true;
                                    }
                                    lastErr = outTunnel || lastErr;
                                } catch (e) {
                                    const errText = normalizeCliText([e?.stdout, e?.stderr, e?.message].filter(Boolean).join('\n'));
                                    logDebug(`cmdTunnel catch error: ${errText}`);
                                    lastErr = errText || lastErr;
                                }
                            } else {
                                logDebug('tunneld fallback unavailable.');
                            }
                        }

                        resolve({ ok: false, error: 'Lỗi iOS 17: ' + (lastErr || 'Không thể set vị trí qua DVT.'), reason: 'cmd17_error' });
                    }
                } catch (e) {
                    const errText = parseExecError(e);
                    logDebug(`cmd17 catch error: ${errText}`);
                    resolve({ ok: false, error: errText, reason: 'cmd17_exception' });
                } finally {
                    tunnelProc.kill();
                }
                return true;
            };

            tunnelProc.stdout.on('data', async (data) => {
                const str = data.toString();
                output += str;
                tunnelBuffer += str;
                logDebug(`tunnel stdout: ${str.trim()}`);
                await tryResolveTunnel(tunnelBuffer);
            });

            tunnelProc.stderr.on('data', (data) => {
                const str = data.toString();
                output += str;
                logDebug(`tunnel stderr: ${str.trim()}`);
                if (str.includes('requires admin privileges') && !resolved) {
                    resolved = true;
                    resolve({ ok: false, error: 'Cần quyền Administrator. Vui lòng chạy app bằng Run as Administrator.', reason: 'admin' });
                    tunnelProc.kill();
                }
            });

            tunnelProc.on('close', (code) => {
                logDebug(`tunnel closed with code ${code}`);
                if (!resolved) {
                    resolved = true;
                    const text = normalizeCliText(output).toLowerCase();
                    if (text.includes('requires admin privileges')) {
                        resolve({ ok: false, error: 'Ứng dụng chưa chạy quyền Administrator. Hãy đóng app và mở lại terminal bằng Run as administrator.', reason: 'admin' });
                        return;
                    }
                    if (text.includes('device is not connected')) {
                        resolve({ ok: false, error: 'Thiết bị chưa kết nối ổn định. Hãy mở khóa iPhone, bấm Trust và cắm lại cáp.', reason: 'device_not_connected' });
                        return;
                    }
                    if (text.includes('connection was terminated abruptly')) {
                        resolve({ ok: false, error: 'Kết nối USB với iPhone bị ngắt đột ngột. Hãy đổi cáp/port USB và giữ máy mở khóa.', reason: 'connection_abrupt' });
                        return;
                    }
                    resolve({ ok: false, error: 'Tunnel đóng đột ngột (code ' + code + '): ' + normalizeCliText(output), reason: 'tunnel_closed' });
                }
            });

            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve({ ok: false, error: 'Timeout kết nối Tunnel iOS 17+.', reason: 'timeout' });
                    tunnelProc.kill();
                }
            }, 20000);
        });

        const attempts = [
            { mode: 'lockdown', includeUdid: true },
            { mode: 'lockdown', includeUdid: false },
            { mode: 'remote', includeUdid: true },
            { mode: 'remote', includeUdid: false },
        ];

        let lastResult = null;
        for (const attempt of attempts) {
            if (attempt.includeUdid && (!udid || udid === 'auto')) continue;
            if (attempt.mode === 'remote' && attempt.includeUdid && udid && udid !== 'auto') {
                logDebug('Retry remote tunnel with explicit UDID...');
            }
            if (attempt.mode === 'remote' && !attempt.includeUdid) {
                logDebug('Retry remote tunnel without explicit UDID...');
            }
            if (attempt.mode === 'lockdown' && attempt.includeUdid) {
                logDebug('Try lockdown tunnel with explicit UDID...');
            }
            if (attempt.mode === 'lockdown' && !attempt.includeUdid) {
                logDebug('Retry lockdown tunnel without explicit UDID...');
            }
            const result = await runTunnelAttempt(attempt.mode, attempt.includeUdid);
            lastResult = result;
            if (result.ok) return result;
            if (result.reason === 'admin') return result;
        }
        return lastResult || { ok: false, error: 'Không thể tạo tunnel tới iPhone.' };
    }

    return {
        ok: false,
        error: 'no_tool',
        message: 'Chưa cài đặt công cụ cần thiết. Xem hướng dẫn trong app.'
    };
}


// ─── Reset location ────────────────────────────────────────────────────────
async function resetLocation(udid) {
    const tool = await detectTool();

    if (tool === 'idevicesetlocation' || tool === 'bundled') {
        const bin = tool === 'bundled'
            ? `"${path.join(__dirname, 'bin', 'idevicesetlocation.exe')}"`
            : 'idevicesetlocation';
        const udidFlag = udid ? `-u ${udid}` : '';
        const cmd = `${bin} ${udidFlag} -- 0 0`;
        await execAsync(cmd, { timeout: 10000 });
        return { ok: true };
    }

    if (tool?.startsWith('pymobiledevice3')) {
        const py = tool === 'pymobiledevice3-3' ? 'python3' : 'python';
        const udidFlag = (udid && udid !== 'auto') ? `--udid ${udid}` : '';

        if (process.platform === 'win32') {
            const admin = await isWindowsAdmin();
            if (!admin) return { ok: false, error: 'Ứng dụng chưa chạy quyền Administrator.' };
        }
        
        // Thử iOS 16
        try {
            await execAsync(`${py} -m pymobiledevice3 developer simulate-location clear ${udidFlag}`);
        } catch(e) {}
        
        // Thử iOS 17+ qua tunnel
        return new Promise((resolve) => {
            const args = ['-m', 'pymobiledevice3', 'remote', 'start-tunnel', '--script-mode'];
            if (udid && udid !== 'auto') args.push('--udid', udid);

            const tunnelProc = spawn(py, args);
            let resolved = false;

            tunnelProc.stdout.on('data', async (data) => {
                const match = data.toString().match(/([0-9\.]+)\s+(\d+)/);
                if (match && !resolved) {
                    resolved = true;
                    try {
                        await execAsync(`${py} -m pymobiledevice3 developer dvt simulate-location clear --rsd ${match[1]} ${match[2]} ${udidFlag}`);
                    } catch (e) {} finally {
                        tunnelProc.kill();
                        resolve({ ok: true }); // Bỏ qua lỗi reset
                    }
                }
            });

            tunnelProc.stderr.on('data', (data) => {
                if (data.toString().includes('requires admin privileges') && !resolved) {
                    resolved = true;
                    resolve({ ok: false, error: 'Cần Run as Administrator.' });
                    tunnelProc.kill();
                }
            });

            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve({ ok: false, error: 'Timeout' });
                    tunnelProc.kill();
                }
            }, 10000);
        });
    }

    return { ok: false };
}



// ─── IPC handlers ──────────────────────────────────────────────────────────
ipcMain.handle('check-admin', async () => {
    return await isWindowsAdmin();
});

// Get current iPhone GPS location via worker
ipcMain.handle('get-iphone-location', async () => {
    try {
        const result = await sendWorkerCommand('get-location', 5000);
        return result;
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('install-tool', async () => {
    try { return await installTool(mainWindow); }
    catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('get-python', async () => {
    const py = await getPythonCmd();
    return { py };
});

ipcMain.handle('detect-tool', async () => {
    const tool = await detectTool();
    return { tool };
});

ipcMain.handle('get-devices', async () => {
    try {
        const devices = await getDevices();
        return { ok: true, devices };
    } catch (e) {
        return { ok: false, devices: [], error: e.message };
    }
});

ipcMain.handle('set-location', async (_, { lat, lng, udid }) => {
    try {
        const result = await setLocation(lat, lng, udid);
        return result;
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('reset-location', async (_, { udid }) => {
    try {
        return await resetLocation(udid);
    } catch (e) {
        return { ok: false, error: parseExecError(e) };
    }
});




ipcMain.handle('open-url', async (_, url) => {
    await shell.openExternal(url);
});

ipcMain.handle('setup-tunnel', async (_, { udid }) => {
    try {
        const py = await getPythonCmd();
        if (!py) return { ok: false, error: 'Không tìm thấy Python.' };
        return await setupPersistentTunnel(py, udid);
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('teardown-tunnel', async () => {
    teardownPTunnel();
    return { ok: true };
});

ipcMain.handle('get-tunnel-status', async () => {
    return getPTunnelStatus();
});
