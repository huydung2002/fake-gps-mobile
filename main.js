const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const execAsync = promisify(exec);

function logDebug(msg) {
    try {
        const baseDir = (app && app.isPackaged) ? app.getPath('userData') : __dirname;
        fs.appendFileSync(path.join(baseDir, 'gps_debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {}
}

function normalizeCliText(text = '') {
    return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseExecError(err) {
    const raw = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n');
    const text = normalizeCliText(raw);
    const lower = text.toLowerCase();

    if (lower.includes('requires admin privileges') || lower.includes('run-as administrator')) {
        return 'Cần quyền Administrator cho tác vụ mạng cấp thấp.';
    }
    if (lower.includes('device is not connected')) {
        return 'Thiết bị chưa kết nối. Hãy mở khóa iPhone, bấm Trust và cắm lại cáp USB.';
    }
    if (lower.includes('connection was terminated abruptly')) {
        return 'Kết nối tới iPhone bị ngắt. Hãy giữ màn hình sáng và kiểm tra cáp.';
    }
    if (lower.includes("'number': 183") || lower.includes('number: 183')) {
        return 'Lỗi ghép cặp iPhone (Mux 183). Hãy mở khóa iPhone và chọn Trust lại.';
    }
    return text || 'Lỗi không xác định.';
}

// Zero-Admin: Modern pymobiledevice3 userspace tunnel needs 0 elevated privileges
async function isWindowsAdmin() {
    return true;
}

let mainWindow;

// ─── Persistent Tunnel State (Mirrored to renderer) ─────────────────────────
let pTunnel = {
    proc: null,
    host: 'userspace',
    port: 0,
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

// ─── Location Worker (Python persistent userspace process) ───────────────────
let lWorker = {
    proc: null,
    status: 'idle', // 'idle' | 'starting' | 'ready' | 'error'
    buf: '',
    pending: null, // { resolve, reject, timer }
    failCount: 0,
    udid: null,
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

function getLocationWorkerScriptPath() {
    // 1. Unpacked asar path
    const unpacked = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'location_worker.py');
    if (fs.existsSync(unpacked)) return unpacked;

    // 2. ExtraResources path
    if (process.resourcesPath) {
        const resPath = path.join(process.resourcesPath, 'location_worker.py');
        if (fs.existsSync(resPath)) return resPath;
    }

    // 3. Dev direct path
    return path.join(__dirname, 'location_worker.py');
}

function startLocationWorker(py, target, port) {
    if (lWorker.failCount >= 5) {
        logDebug('Worker disabled after repeated failures.');
        return Promise.resolve({ ok: false, error: 'Worker disabled after repeated failures' });
    }
    teardownLocationWorker();
    lWorker.status = 'starting';
    lWorker.udid = (!port && target && target !== 'auto') ? target : null;
    const script = getLocationWorkerScriptPath();
    const args = [script];
    if (target && target !== 'auto') args.push(String(target));
    if (port) args.push(String(port));

    logDebug(`Starting worker: ${py} ${args.join(' ')}`);

    return new Promise((resolve) => {
        const proc = spawn(py, args, { windowsHide: true });
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
                    lWorker.failCount = 0;
                    pTunnel.status = 'ready';
                    pTunnel.error = null;
                    logDebug(`Location worker READY ⚡ [mode=${msg.mode || 'userspace'}]`);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('worker-ready', {});
                        mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());
                    }
                    finish(true);
                } else if (msg.error && !resolved) {
                    lWorker.status = 'error';
                    lWorker.failCount += 1;
                    pTunnel.status = 'error';
                    pTunnel.error = msg.error;
                    logDebug(`Worker failed (failCount=${lWorker.failCount}): ${msg.error}`);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());
                    }
                    finish(false, msg.error);
                } else if (lWorker.pending) {
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
            pTunnel.status = 'error';
            pTunnel.error = `Worker đóng (code ${code})`;
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
                pTunnel.status = 'error';
                pTunnel.error = 'Worker timeout khi khởi động';
                finish(false, 'Worker startup timeout');
            }
        }, 25000);
    });
}

function setLocationViaWorker(lat, lng) {
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
    pTunnel.status = 'idle';
    pTunnel.error = null;
    logDebug('Persistent tunnel torn down.');
}

async function setupPersistentTunnel(py, udid) {
    if (lWorker.status === 'ready' && lWorker.proc && !lWorker.proc.killed && (!udid || lWorker.udid === udid)) {
        logDebug('Reusing existing ready userspace worker');
        return { ok: true, host: 'userspace', port: 0, reused: true };
    }

    teardownPTunnel();
    pTunnel.status = 'connecting';
    pTunnel.udid = udid;
    pTunnel.py = py;

    if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());

    // 1. Direct Userspace Worker connection (NO ADMIN REQUIRED!)
    const targetUdid = (udid && udid !== 'auto') ? udid : '';
    const res = await startLocationWorker(py, targetUdid);
    if (res.ok) {
        pTunnel.status = 'ready';
        pTunnel.host = 'userspace';
        pTunnel.port = 0;
        pTunnel.error = null;
        logDebug(`Userspace worker ready for ${udid || 'auto'}!`);
        if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());
        return { ok: true, host: 'userspace', port: 0 };
    }

    pTunnel.status = 'error';
    pTunnel.error = res.error || 'Không thể kết nối tới iPhone';
    if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('tunnel-status-changed', getPTunnelStatus());
    return { ok: false, error: pTunnel.error };
}

function createWindow() {
    logDebug('createWindow() invoked');
    mainWindow = new BrowserWindow({
        title: 'iOS GPS Pro by BraveHoang',
        width: 1320,
        height: 840,
        minWidth: 960,
        minHeight: 640,
        center: true,
        show: true,
        frame: false,
        backgroundColor: '#060b18',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(__dirname, 'iconapp.png'),
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setAlwaysOnTop(false);
        }
    }, 1500);

    mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
        logDebug(`did-fail-load: ${desc}`);
    });

    mainWindow.webContents.on('render-process-gone', (e, details) => {
        logDebug(`render-process-gone: ${JSON.stringify(details)}`);
    });
}

app.whenReady().then(async () => {
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

// ─── Python & Tool Detection ───────────────────────────────────────────────
async function getPythonCmd() {
    const cmds = ['python', 'python3', 'py'];

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE + '\\AppData\\Local');
        for (let minor = 14; minor >= 10; minor--) {
            cmds.push(`${localAppData}\\Programs\\Python\\Python3${minor}\\python.exe`);
        }
        cmds.push('C:\\Program Files\\Python314\\python.exe');
        cmds.push('C:\\Program Files\\Python313\\python.exe');
        cmds.push('C:\\Program Files\\Python312\\python.exe');
        cmds.push('C:\\Program Files\\Python311\\python.exe');
    }

    for (const cmd of cmds) {
        try {
            const { stdout } = await execAsync(`"${cmd}" --version`, { timeout: 3000 });
            if (stdout.includes('Python')) {
                return cmd;
            }
        } catch { }
    }
    return null;
}

async function detectTool() {
    const py = await getPythonCmd();
    if (py) {
        try {
            await execAsync(`"${py}" -c "import pymobiledevice3"`, { timeout: 15000 });
            return 'pymobiledevice3';
        } catch { }
    }

    try {
        await execAsync('python -c "import pymobiledevice3"', { timeout: 15000 });
        return 'pymobiledevice3';
    } catch { }

    try {
        await execAsync('python3 -c "import pymobiledevice3"', { timeout: 15000 });
        return 'pymobiledevice3-3';
    } catch { }

    // Fallback: bundled or idevicesetlocation
    const bundled = path.join(__dirname, 'bin', 'idevicesetlocation.exe');
    if (fs.existsSync(bundled)) return 'bundled';

    try {
        await execAsync('idevicesetlocation --help', { timeout: 3000 });
        return 'idevicesetlocation';
    } catch { }

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
            win?.webContents?.send('install-progress', d.toString());
        });
        proc.stderr.on('data', d => {
            output += d.toString();
            win?.webContents?.send('install-progress', d.toString());
        });
        proc.on('close', code => {
            resolve({ ok: code === 0, output, code });
        });
    });
}

// ─── Device Detection ──────────────────────────────────────────────────────
async function getDevices() {
    const devices = [];
    const seenUdids = new Set();
    const pushUniqueDevice = (device) => {
        const udid = String(device?.udid || '').trim();
        if (!udid || seenUdids.has(udid)) return;
        seenUdids.add(udid);
        devices.push({ ...device, udid });
    };

    // Method 1: pymobiledevice3 usbmux list
    try {
        const py = await getPythonCmd();
        if (py) {
            try {
                const { stdout } = await execAsync(`"${py}" -m pymobiledevice3 --no-color usbmux list`, { timeout: 8000 });
                const raw = normalizeCliText(stdout || '').trim();
                const jsonStart = raw.indexOf('[');
                if (jsonStart !== -1) {
                    const arr = JSON.parse(raw.slice(jsonStart));
                    if (Array.isArray(arr)) {
                        for (const item of arr) {
                            const udid = item?.UniqueDeviceID || item?.Identifier || item?.SerialNumber || item?.udid || '';
                            if (!udid || !/^[0-9a-fA-F-]{8,}/.test(udid)) continue;
                            const connType = String(item?.ConnectionType || 'USB').includes('Network') ? 'WiFi' : 'USB';
                            const name = item?.DeviceName || 'iPhone';
                            const model = item?.ProductType || '';
                            const version = item?.ProductVersion || '';
                            pushUniqueDevice({ udid, name, connectionType: connType, model, version, source: 'pymobiledevice3' });
                        }
                    }
                }
            } catch (e) {
                logDebug(`usbmux list error: ${e.message}`);
            }
        }
    } catch { }

    // Method 2: idevice_id fallback
    if (!devices.length) {
        try {
            const { stdout } = await execAsync('idevice_id -l', { timeout: 3000 });
            const lines = stdout.trim().split('\n').filter(Boolean);
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const udid = parts[0];
                const connType = parts[1] && parts[1].toLowerCase().includes('network') ? 'WiFi' : 'USB';
                pushUniqueDevice({ udid, name: 'iPhone', connectionType: connType, source: 'idevice_id' });
            }
        } catch { }
    }

    return devices;
}

// ─── Set Location ──────────────────────────────────────────────────────────
async function setLocation(lat, lng, udid) {
    const py = await getPythonCmd();
    if (!py) return { ok: false, error: 'Không tìm thấy Python.' };

    // 1. FAST PATH: Worker already ready
    if (lWorker.status === 'ready' && lWorker.proc && !lWorker.proc.killed) {
        try {
            const res = await setLocationViaWorker(lat, lng);
            if (res.ok) return { ok: true, method: 'worker', output: '' };
        } catch (e) {
            logDebug(`Worker send error: ${e.message}`);
        }
    }

    // 2. Connect worker and retry
    const tunnelRes = await setupPersistentTunnel(py, udid);
    if (tunnelRes.ok && lWorker.status === 'ready') {
        try {
            const res = await setLocationViaWorker(lat, lng);
            if (res.ok) return { ok: true, method: 'worker', output: '' };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    // 3. Fallback to CLI command
    try {
        const udidFlag = (udid && udid !== 'auto') ? `--udid ${udid}` : '';
        const { stdout } = await execAsync(`"${py}" -m pymobiledevice3 --no-color developer dvt simulate-location set ${udidFlag} -- ${lat} ${lng}`, { timeout: 15000 });
        return { ok: true, method: 'cli', output: stdout };
    } catch (e) {
        return { ok: false, error: parseExecError(e) };
    }
}

// ─── Reset Location (Back to Real GPS) ───────────────────────────────────────
async function resetLocation(udid) {
    if (lWorker.status === 'ready' && lWorker.proc && !lWorker.proc.killed) {
        try {
            await sendWorkerCommand('clear', 5000);
            logDebug('Cleared location via worker');
            return { ok: true, method: 'worker-clear' };
        } catch (e) {
            logDebug(`Worker clear error: ${e.message}`);
        }
    }

    const py = await getPythonCmd();
    if (py) {
        try {
            const udidFlag = (udid && udid !== 'auto') ? `--udid ${udid}` : '';
            await execAsync(`"${py}" -m pymobiledevice3 --no-color developer dvt simulate-location clear ${udidFlag}`, { timeout: 8000 });
            return { ok: true, method: 'cli-dvt' };
        } catch {}
        try {
            const udidFlag = (udid && udid !== 'auto') ? `--udid ${udid}` : '';
            await execAsync(`"${py}" -m pymobiledevice3 developer simulate-location clear ${udidFlag}`, { timeout: 8000 });
            return { ok: true, method: 'cli-lockdown' };
        } catch {}
    }
    return { ok: true };
}

// ─── IPC Handlers ──────────────────────────────────────────────────────────
ipcMain.handle('check-admin', async () => true);

ipcMain.handle('get-iphone-location', async () => {
    try {
        const result = await sendWorkerCommand('get-location', 5000);
        return result;
    } catch (e) {
        return { ok: false, error: e.message };
    }
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
        return await setLocation(lat, lng, udid);
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

ipcMain.handle('install-tool', async () => {
    return await installTool(mainWindow);
});

ipcMain.handle('install-python', async () => {
    return new Promise((resolve) => {
        const https = require('https');
        const url = 'https://www.python.org/ftp/python/3.12.3/python-3.12.3-amd64.exe';
        const installerPath = path.join(app.getPath('temp'), 'python-installer.exe');

        mainWindow?.webContents?.send('install-python-progress', 'Đang tải Python installer...\n');

        const file = fs.createWriteStream(installerPath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                mainWindow?.webContents?.send('install-python-progress', `\nLỗi tải: HTTP ${response.statusCode}`);
                resolve({ ok: false, error: `HTTP ${response.statusCode}` });
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                mainWindow?.webContents?.send('install-python-progress', 'Tải xong, đang cài đặt ngầm...\n');
                const proc = spawn(installerPath, ['/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_test=0'], { windowsHide: true });
                proc.on('close', code => {
                    if (code === 0) {
                        mainWindow?.webContents?.send('install-python-progress', '✅ Cài đặt thành công!\n');
                        resolve({ ok: true });
                    } else {
                        mainWindow?.webContents?.send('install-python-progress', `❌ Lỗi cài đặt (code: ${code}).\n`);
                        resolve({ ok: false, error: `Installer code ${code}` });
                    }
                });
            });
        }).on('error', (err) => {
            fs.unlink(installerPath, () => {});
            mainWindow?.webContents?.send('install-python-progress', `❌ Lỗi tải: ${err.message}\n`);
            resolve({ ok: false, error: err.message });
        });
    });
});

ipcMain.handle('scan-wifi', async () => {
    const py = await getPythonCmd();
    if (!py) return { ok: false, error: 'Chưa tìm thấy Python.' };
    try {
        const { stdout } = await execAsync(`"${py}" -m pymobiledevice3 remote browse --timeout 2`, { timeout: 12000 });
        const clean = normalizeCliText(stdout);
        const start = clean.indexOf('{');
        if (start === -1) return { ok: true, devices: [] };
        const data = JSON.parse(clean.slice(start));
        return { ok: true, devices: data.wifi || [] };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('get-python', async () => {
    const py = await getPythonCmd();
    return { py };
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
