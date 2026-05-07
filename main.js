const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const execAsync = promisify(exec);

function logDebug(msg) {
    try {
        fs.appendFileSync(path.join(__dirname, 'gps_debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {}
}

let mainWindow;

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
    mainWindow.webContents.openDevTools(); // uncomment for debug
}

app.whenReady().then(() => {
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

    // Method 1: idevice_id (libimobiledevice)
    try {
        const { stdout } = await execAsync('idevice_id -l', { timeout: 4000 });
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (const udid of lines) {
            let name = 'iPhone';
            try {
                const { stdout: info } = await execAsync(`ideviceinfo -u ${udid.trim()} -k DeviceName`, { timeout: 3000 });
                name = info.trim() || 'iPhone';
            } catch { }
            devices.push({ udid: udid.trim(), name, source: 'idevice_id' });
        }
        if (devices.length) return devices;
    } catch { }

    // Method 2: pymobiledevice3
    try {
        const { stdout } = await execAsync('python -m pymobiledevice3 usbmux list', { timeout: 5000 });
        const data = JSON.parse(stdout);
        data.forEach(d => devices.push({
            udid: d.UniqueDeviceID || d.udid,
            name: d.DeviceName || 'iPhone',
            source: 'pymobiledevice3'
        }));
        if (devices.length) return devices;
    } catch { }

    // Method 3: Windows Apple Mobile Device Service / Lockdown folder
    // iTunes tạo folder chứa UDID của từng thiết bị đã trust
    if (process.platform === 'win32') {
        const lockdownPaths = [
            `${process.env.ALLUSERSPROFILE}\\Apple\\Lockdown`,
            `${process.env.PROGRAMDATA}\\Apple\\Lockdown`,
            `${process.env.CommonProgramFiles}\\Apple\\Mobile Device Support\\Lockdown`,
        ];
        const fs = require('fs');
        for (const dir of lockdownPaths) {
            try {
                if (!fs.existsSync(dir)) continue;
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    if (f.endsWith('.plist') || /^[0-9a-f-]{40}/i.test(f)) {
                        const udid = f.replace('.plist', '').trim();
                        if (udid.length >= 40) {
                            devices.push({ udid, name: 'iPhone (kết nối)', source: 'lockdown' });
                        }
                    }
                }
                if (devices.length) return devices;
            } catch { }
        }

        // Method 4: Registry check for Apple Mobile Device
        try {
            const { stdout } = await execAsync(
                'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Enum\\USB" /s /f "Apple Mobile Device" /d 2>nul',
                { timeout: 5000 }
            );
            if (stdout.includes('Apple Mobile Device')) {
                devices.push({ udid: 'auto', name: 'iPhone (đã kết nối)', source: 'registry' });
            }
        } catch { }
    }

    return devices;
}

// ─── Set location ──────────────────────────────────────────────────────────
async function setLocation(lat, lng, udid) {
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

        // 1. Thử dùng lệnh cho iOS 16 trở xuống trước
        try {
            const cmd16 = `${py} -m pymobiledevice3 developer simulate-location set ${udidFlag} -- ${lat} ${lng}`;
            logDebug(`Chạy cmd16: ${cmd16}`);
            const { stdout, stderr } = await execAsync(cmd16, { timeout: 15000 });
            const out16 = stdout || stderr || '';
            logDebug(`cmd16 output:\n${out16}`);

            // MuxException 183 = AMDS conflict (Apple Mobile Device Service đang chiếm usbmuxd)
            if (out16.includes('Number: 183') || out16.includes('Number\']: 183') || out16.includes("'Number': 183")) {
                return { ok: false, error: '❌ Xung đột Apple Mobile Device Service (AMDS). Vui lòng tắt iTunes / Apple Devices và thử lại, hoặc chạy app bằng Run as Administrator.' };
            }
            
            // Nếu không có chữ ERROR, nghĩa là lệnh đã chạy thành công (kể cả khi có WARNING)
            if (!out16.includes('ERROR') && !out16.includes('Failed')) {
                return { ok: true, method: 'pymobiledevice3 (iOS < 17 hoặc Tunnel auto)', output: out16 };
            }
        } catch (e) {
            logDebug(`cmd16 catch error: ${e.message}`);
            // MuxException 183 đến từ exception message
            if (e.message.includes("'Number': 183") || e.message.includes('Number: 183')) {
                return { ok: false, error: '❌ Xung đột Apple Mobile Device Service (AMDS). Vui lòng tắt iTunes / Apple Devices và thử lại, hoặc chạy app bằng Run as Administrator.' };
            }
        }

        logDebug(`Chuyển sang iOS 17 Tunnel...`);
        // 2. Nếu iOS 17+, cần tạo Tunnel trước khi set
        return new Promise((resolve) => {
            const args = ['-m', 'pymobiledevice3', 'remote', 'start-tunnel', '--script-mode'];
            // Truyền udid để pymobiledevice3 tìm đúng thiết bị
            if (udid && udid !== 'auto') args.push('--udid', udid);

            logDebug(`Spawn start-tunnel: ${py} ${args.join(' ')}`);
            const tunnelProc = spawn(py, args);
            let resolved = false;
            let output = '';

            tunnelProc.stdout.on('data', async (data) => {
                const str = data.toString();
                output += str;
                logDebug(`tunnel stdout: ${str.trim()}`);
                const match = str.match(/([0-9\.]+)\s+(\d+)/);
                if (match && !resolved) {
                    resolved = true;
                    const rsdHost = match[1];
                    const rsdPort = match[2];
                    try {
                        const cmd17 = `${py} -m pymobiledevice3 developer dvt simulate-location set --rsd ${rsdHost} ${rsdPort} ${udidFlag} -- ${lat} ${lng}`;
                        logDebug(`Chạy cmd17: ${cmd17}`);
                        const { stdout, stderr } = await execAsync(cmd17, { timeout: 15000 });
                        const out17 = stdout || stderr || '';
                        logDebug(`cmd17 output:\n${out17}`);
                        
                        if (out17.includes('ERROR') || out17.includes('InvalidServiceError')) {
                            resolve({ ok: false, error: 'Lỗi iOS 17: ' + out17 });
                        } else {
                            resolve({ ok: true, method: 'pymobiledevice3 (iOS 17+)', output: out17 });
                        }
                    } catch (e) {
                        logDebug(`cmd17 catch error: ${e.message}`);
                        resolve({ ok: false, error: e.message });
                    } finally {
                        tunnelProc.kill();
                    }
                }
            });

            tunnelProc.stderr.on('data', (data) => {
                const str = data.toString();
                output += str;
                logDebug(`tunnel stderr: ${str.trim()}`);
                if (str.includes('requires admin privileges') && !resolved) {
                    resolved = true;
                    resolve({ ok: false, error: '❌ Cần quyền Administrator. Vui lòng chạy app bằng Run as Administrator.' });
                    tunnelProc.kill();
                }
            });

            tunnelProc.on('close', (code) => {
                logDebug(`tunnel closed with code ${code}`);
                if (!resolved) {
                    resolved = true;
                    resolve({ ok: false, error: 'Tunnel đóng đột ngột (code ' + code + '): ' + output });
                }
            });

            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve({ ok: false, error: 'Timeout kết nối Tunnel iOS 17+.' });
                    tunnelProc.kill();
                }
            }, 20000);
        });
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

// ─── AMDS Service helpers ──────────────────────────────────────────────────
const AMDS_SERVICE_NAME = 'Apple Mobile Device Service';

async function amdsCheck() {
    try {
        const { stdout } = await execAsync(`sc query "${AMDS_SERVICE_NAME}"`, { timeout: 5000 });
        if (stdout.includes('RUNNING')) return { running: true };
        if (stdout.includes('STOPPED')) return { running: false };
        return { running: null }; // unknown
    } catch (e) {
        return { running: null, error: e.message };
    }
}

async function amdsStop() {
    try {
        const { stdout, stderr } = await execAsync(`net stop "${AMDS_SERVICE_NAME}"`, { timeout: 15000 });
        logDebug(`AMDS stop: ${stdout || stderr}`);
        return { ok: true };
    } catch (e) {
        logDebug(`AMDS stop error: ${e.message}`);
        // Có thể đã dừng rồi
        if (e.message.includes('not started') || e.message.includes('1062')) return { ok: true };
        return { ok: false, error: 'Cần quyền Administrator để dừng service. Chạy app bằng Run as Administrator.' };
    }
}

async function amdsStart() {
    try {
        const { stdout, stderr } = await execAsync(`net start "${AMDS_SERVICE_NAME}"`, { timeout: 15000 });
        logDebug(`AMDS start: ${stdout || stderr}`);
        return { ok: true };
    } catch (e) {
        logDebug(`AMDS start error: ${e.message}`);
        if (e.message.includes('already been started') || e.message.includes('1056')) return { ok: true };
        return { ok: false, error: e.message };
    }
}

// ─── IPC handlers ──────────────────────────────────────────────────────────
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
        // Nếu lỗi 183 (AMDS conflict), tự động thử khởi động lại AMDS (restart) rồi retry
        if (!result.ok && result.error && result.error.includes('AMDS') && !result.amdsRetried) {
            logDebug('Phát hiện lỗi AMDS 183, tự động khởi động lại service (restart) và thử lại...');
            const stopResult = await amdsStop();
            if (stopResult.ok) {
                await new Promise(r => setTimeout(r, 2000)); // Chờ service dừng hẳn
                await amdsStart(); // CẦN PHẢI BẬT LẠI SERVICE
                await new Promise(r => setTimeout(r, 5000)); // Chờ nhận diện lại thiết bị
                const retry = await setLocation(lat, lng, udid);
                retry.amdsRetried = true;
                return retry;
            } else {
                return { ok: false, error: stopResult.error || result.error };
            }
        }
        return result;
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('reset-location', async (_, { udid }) => {
    try {
        return await resetLocation(udid);
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('amds-check', async () => {
    return await amdsCheck();
});

ipcMain.handle('amds-stop', async () => {
    return await amdsStop();
});

ipcMain.handle('amds-start', async () => {
    return await amdsStart();
});


ipcMain.handle('open-url', async (_, url) => {
    await shell.openExternal(url);
});
