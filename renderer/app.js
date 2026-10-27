/* global electronAPI, L */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────
let map, selectedMarker = null;
let selectedLat = null, selectedLng = null;
let selectedPlace = '';
let currentUdid = '';
let lastTeleportedLat = null, lastTeleportedLng = null;
let history = JSON.parse(localStorage.getItem('bh-gps-history') || '[]');
let favorites = JSON.parse(localStorage.getItem('bh-gps-favorites') || '[]');
let isTeleporting = false;
let keepAliveTimer = null;
let keepAliveInFlight = false;
const KEEP_ALIVE_MS = 3000;
const EARTH_METERS_PER_DEG_LAT = 111320;

// Active Navigation Mode: 'teleport' | 'route' | 'joystick'
let activeMode = 'teleport';

// Route Mode State
let routeStartPoint = null;
let routeEndPoint = null;
let routeStartMarker = null;
let routeEndMarker = null;
let routePolyline = null;
let routeCoords = []; // Array of [lat, lng]
let routeIndex = 0;
let routeTimer = null;
let routeIsPlaying = false;
let routeIsPaused = false;
let routeSpeedKmh = 15;
let routeMovingMarker = null;

// Joystick State
let joystickSpeedKmh = 3.6;
let currentJoyLat = null;
let currentJoyLng = null;

// Tunnel & Worker state
let tunnelStatus = { status: 'idle', host: 'userspace', port: 0, udid: null, error: null };
let workerReady = false;

// Wizard State
let wizPythonOk = false;
let wizPmdOk = false;
let wizIphoneOk = false;

// ─── Wizard Logic (Zero-Admin) ───────────────────────────────────────────────
function setWizRow(id, state, desc, showBtn = false) {
    const row = document.getElementById(`req-${id}`);
    if (!row) return;
    const icon = document.getElementById(`req-${id}-icon`);
    const descEl = document.getElementById(`req-${id}-desc`);
    const btn = row.querySelector('.req-btn');

    row.className = `req-row req-${state}`;
    icon.textContent = state === 'ok' ? '✅' : state === 'err' ? '❌' : state === 'warn' ? '⚠️' : '⏳';
    descEl.textContent = desc;

    if (btn) {
        if (showBtn) btn.classList.remove('hidden');
        else btn.classList.add('hidden');
    }
}

async function checkWizardRequirements() {
    // 1. Check Python
    const { py } = await electronAPI.getPython();
    if (py) {
        wizPythonOk = true;
        setWizRow('python', 'ok', `Đã tìm thấy: ${py}`);
    } else {
        wizPythonOk = false;
        setWizRow('python', 'err', 'Chưa cài đặt Python hoặc chưa thêm vào PATH.', true);
    }

    // 2. Check pymobiledevice3 (Zero-Admin Userspace Tunnel)
    const { tool } = await electronAPI.detectTool();
    if (tool && tool.startsWith('pymobiledevice3')) {
        wizPmdOk = true;
        setWizRow('pmd', 'ok', 'Đã cài đặt pymobiledevice3 (Zero-Admin ready)');
    } else {
        wizPmdOk = false;
        setWizRow('pmd', 'err', 'Chưa cài đặt thư viện pymobiledevice3.', wizPythonOk);
    }

    // 3. Check iPhone
    const { ok, devices } = await electronAPI.getDevices();
    const tips = document.getElementById('wizard-iphone-tips');
    if (ok && devices && devices.length > 0) {
        wizIphoneOk = true;
        currentUdid = devices[0].udid;

        const listHtml = devices.map((d, i) => {
            const shortUdid = d.udid.slice(0, 8) + '...' + d.udid.slice(-4);
            const connBadge = d.connectionType === 'WiFi'
                ? '<span class="conn-badge conn-wifi">📶 WiFi</span>'
                : '<span class="conn-badge conn-usb">🔌 USB</span>';
            const verTag = d.version ? `<span class="udid-tag">iOS ${d.version}</span>` : '';
            return `<div class="wizard-device-item${i === 0 ? ' selected' : ''}" data-udid="${d.udid}" onclick="wizardSelectDevice(this,'${d.udid}')">
                <div class="wizard-device-name">${d.name || 'iPhone'}</div>
                <div class="wizard-device-meta">${connBadge}${verTag}<span class="udid-tag">${shortUdid}</span></div>
            </div>`;
        }).join('');

        setWizRow('iphone', 'ok', `${devices.length} thiết bị đã kết nối`);
        const descEl = document.getElementById('req-iphone-desc');
        descEl.innerHTML = `${devices.length} thiết bị sẵn sàng:`;
        let devList = document.getElementById('wizard-device-list');
        if (!devList) {
            devList = document.createElement('div');
            devList.id = 'wizard-device-list';
            devList.className = 'wizard-device-list';
            descEl.parentNode.insertBefore(devList, descEl.nextSibling);
        }
        devList.innerHTML = listHtml;
        tips.classList.add('hidden');
    } else {
        wizIphoneOk = false;
        setWizRow('iphone', 'warn', 'Vui lòng cắm iPhone vào máy tính và bấm Trust.', true);
        const devList = document.getElementById('wizard-device-list');
        if (devList) devList.innerHTML = '';
        tips.classList.remove('hidden');
    }

    // Update Continue Button
    const btnCont = document.getElementById('btn-wizard-continue');
    const hint = document.getElementById('wizard-continue-hint');
    if (wizPythonOk && wizPmdOk) {
        btnCont.disabled = false;
        hint.classList.add('hidden');
    } else {
        btnCont.disabled = true;
        hint.classList.remove('hidden');
    }
}

async function wizardInstallPmd() {
    const log = document.getElementById('pmd-install-log');
    const progWrap = document.getElementById('pmd-progress-wrap');
    const progBar = document.getElementById('pmd-progress-bar');
    const btn = document.getElementById('btn-install-pmd');

    btn.disabled = true;
    btn.textContent = '⏳ Đang cài...';
    log.classList.remove('hidden');
    progWrap.classList.remove('hidden');
    log.textContent = 'Bắt đầu cài đặt pymobiledevice3...\n';
    progBar.style.width = '10%';

    electronAPI.onInstallProgress((data) => {
        log.textContent += data;
        log.scrollTop = log.scrollHeight;
        const p = Math.min(90, 10 + (log.textContent.length / 500) * 80);
        progBar.style.width = `${p}%`;
    });

    const result = await electronAPI.installTool();
    if (result.ok) {
        progBar.style.width = '100%';
        log.textContent += '\n✅ Cài đặt thành công!';
        showToast('✅ Cài pymobiledevice3 thành công!', 'success');
        setTimeout(checkWizardRequirements, 1000);
    } else {
        log.textContent += `\n❌ Lỗi: ${result.message || 'Không rõ'}`;
        showToast('❌ Cài thất bại.', 'error');
        btn.disabled = false;
        btn.textContent = '↻ Thử lại';
    }
}

async function wizardInstallPython() {
    const log = document.getElementById('python-install-log');
    const progWrap = document.getElementById('python-progress-wrap');
    const progBar = document.getElementById('python-progress-bar');
    const btn = document.getElementById('btn-install-python');

    btn.disabled = true;
    btn.textContent = '⏳ Đang cài...';
    log.classList.remove('hidden');
    progWrap.classList.remove('hidden');
    log.textContent = 'Bắt đầu tải và cài đặt Python...\n';
    progBar.style.width = '10%';

    electronAPI.onPythonInstallProgress((data) => {
        log.textContent += data;
        log.scrollTop = log.scrollHeight;
        const p = Math.min(90, 10 + (log.textContent.length / 200) * 80);
        progBar.style.width = `${p}%`;
    });

    const result = await electronAPI.installPython();
    if (result.ok) {
        progBar.style.width = '100%';
        log.textContent += '\n✅ Cài đặt thành công!';
        showToast('✅ Cài Python thành công!', 'success');
        setTimeout(checkWizardRequirements, 1500);
    } else {
        log.textContent += `\n❌ Lỗi: ${result.error || 'Không rõ'}`;
        showToast('❌ Cài thất bại.', 'error');
        btn.disabled = false;
        btn.textContent = '↻ Thử lại';
    }
}

function wizardRefreshIphone() {
    checkWizardRequirements();
}

function wizardSelectDevice(el, udid) {
    currentUdid = udid;
    document.querySelectorAll('.wizard-device-item').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
}
window.wizardSelectDevice = wizardSelectDevice;

function wizardContinue() {
    document.getElementById('wizard').classList.add('hidden');
    document.getElementById('connecting-page').classList.remove('hidden');
    document.getElementById('layout').classList.add('hidden');

    setStepState('step-device', '');
    setStepState('step-tunnel', '');
    setStepState('step-worker', '');

    startFullConnection();
}

function showWizard() {
    document.getElementById('connecting-page').classList.add('hidden');
    document.getElementById('layout').classList.add('hidden');
    document.getElementById('wizard').classList.remove('hidden');
    document.getElementById('wizard').classList.remove('hidden-by-user');
    checkWizardRequirements();
}

// ─── Setup Phase UI ──────────────────────────────────────────────────────────
function setStepState(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `setup-step ${state}`;
    const icon = el.querySelector('.step-icon');
    if (icon) {
        icon.textContent = state === 'step-done' ? '✓' : state === 'step-active' ? '⏳' : '○';
    }
}

function revealLayout() {
    document.getElementById('layout').classList.remove('hidden');
    requestAnimationFrame(() => {
        if (map) map.invalidateSize();
    });
}

function markSetupDone() {
    const page = document.getElementById('connecting-page');
    if (!page || page.classList.contains('hidden')) return;
    document.getElementById('setup-title').textContent = '⚡ Userspace Tunnel sẵn sàng! Bắt đầu sử dụng.';
    page.classList.add('fading');
    setTimeout(() => {
        page.classList.add('hidden');
        page.classList.remove('fading');
        revealLayout();
    }, 500);
}

function skipSetup() {
    clearConnectingTimeout();
    const page = document.getElementById('connecting-page');
    if (page) {
        page.classList.add('fading');
        setTimeout(() => {
            page.classList.add('hidden');
            page.classList.remove('fading');
            revealLayout();
        }, 400);
    }
}
window.skipSetup = skipSetup;

let connectingTimeout = null;
function clearConnectingTimeout() {
    if (connectingTimeout) { clearTimeout(connectingTimeout); connectingTimeout = null; }
}

function startConnectingTimeout(ms = 35000) {
    clearConnectingTimeout();
    connectingTimeout = setTimeout(() => {
        const page = document.getElementById('connecting-page');
        if (page && !page.classList.contains('hidden')) {
            document.getElementById('setup-hint').textContent = 'Chuyển thẳng vào giao diện bản đồ...';
            setTimeout(skipSetup, 1200);
        }
    }, ms);
}

async function startFullConnection() {
    setStepState('step-device', 'step-active');
    const { ok, devices } = await electronAPI.getDevices();
    if (ok && devices.length > 0) {
        currentUdid = devices[0].udid;
        setStepState('step-device', 'step-done');
        setStepState('step-tunnel', 'step-active');
        document.getElementById('setup-hint').textContent = 'Khởi tạo Userspace Tunnel (Zero-Admin)...';
        startConnectingTimeout(35000);
        setupTunnel(currentUdid);
    } else {
        setStepState('step-device', '');
        document.getElementById('setup-hint').textContent = 'Không tìm thấy iPhone. Kiểm tra cáp USB và Trust trên máy.';
        showToast('Vui lòng kết nối iPhone qua USB.', 'info');
        setTimeout(() => {
            document.getElementById('connecting-page').classList.add('hidden');
            showWizard();
        }, 2000);
    }
}

// ─── Math & Geodesy Helpers ──────────────────────────────────────────────────
function toRadians(deg) { return (deg * Math.PI) / 180; }
function toDegrees(rad) { return (rad * 180) / Math.PI; }

function distanceMeters(lat1, lng1, lat2, lng2) {
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 6371000 * c;
}

function calculateCooldown(distKm) {
    if (distKm <= 0.2) return 0;
    if (distKm <= 1) return 1;
    if (distKm <= 5) return 3;
    if (distKm <= 10) return 7;
    if (distKm <= 25) return 15;
    if (distKm <= 50) return 30;
    if (distKm <= 100) return 45;
    if (distKm <= 250) return 60;
    if (distKm <= 500) return 90;
    return 120; // 2 hours max
}

function updateCooldownDisplay(targetLat, targetLng) {
    const box = document.getElementById('cooldown-box');
    const valEl = document.getElementById('cooldown-val');
    const distEl = document.getElementById('cooldown-dist');

    if (lastTeleportedLat === null || lastTeleportedLng === null) {
        box.classList.add('hidden');
        return;
    }

    const distM = distanceMeters(lastTeleportedLat, lastTeleportedLng, targetLat, targetLng);
    const distKm = distM / 1000;
    const cooldownMins = calculateCooldown(distKm);

    if (distKm < 0.2) {
        box.classList.add('hidden');
        return;
    }

    box.classList.remove('hidden');
    distEl.textContent = `Khoảng cách từ điểm trước: ${distKm >= 10 ? distKm.toFixed(1) : distKm.toFixed(2)} km`;
    valEl.textContent = cooldownMins > 0 ? `${cooldownMins} phút` : 'An toàn (0 phút)';
}

// ─── Mode Switching ──────────────────────────────────────────────────────────
function initModeTabs() {
    const tabs = document.querySelectorAll('.mode-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const mode = tab.dataset.mode;
            setMode(mode);
        });
    });
}

function setMode(mode) {
    activeMode = mode;
    document.querySelectorAll('.mode-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.mode === mode);
    });

    document.getElementById('panel-tab-teleport').classList.toggle('hidden', mode !== 'teleport');
    document.getElementById('panel-tab-route').classList.toggle('hidden', mode !== 'route');
    document.getElementById('panel-tab-joystick').classList.toggle('hidden', mode !== 'joystick');

    const mapTip = document.getElementById('map-tip');
    if (mode === 'teleport') {
        mapTip.textContent = 'Click vào bản đồ để chọn vị trí dịch chuyển tức thời';
    } else if (mode === 'route') {
        mapTip.textContent = 'Click 2 điểm trên bản đồ để vẽ lộ trình thực tế (A → B)';
    } else if (mode === 'joystick') {
        mapTip.textContent = 'Dùng phím W-A-S-D hoặc các nút mũi tên để di chuyển';
    }
}

// ─── Leaflet Map Setup with Google Maps (Hybrid / Street) & OSM ──────────────
let googleHybridLayer, googleStreetLayer, osmLayer;

function initMap() {
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false
    }).setView([21.0285, 105.8542], 14);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Google Hybrid: Vệ tinh độ nét cao + lớp phủ đường phố, tên địa điểm tiếng Việt đầy đủ
    googleHybridLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
        subdomains: ['0', '1', '2', '3'],
        maxZoom: 21
    });

    // Google Street: Bản đồ đường phố Google Maps
    googleStreetLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        subdomains: ['0', '1', '2', '3'],
        maxZoom: 21
    });

    // OpenStreetMap: Bản đồ mã nguồn mở OSM
    osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
    });

    // Mặc định dùng Google Hybrid (Vệ tinh có tên đường & địa danh)
    googleHybridLayer.addTo(map);

    const btnHybrid = document.getElementById('btn-layer-google-hybrid');
    const btnStreet = document.getElementById('btn-layer-google-street');
    const btnOsm = document.getElementById('btn-layer-osm');

    function switchLayer(layerToActivate, activeBtn) {
        [googleHybridLayer, googleStreetLayer, osmLayer].forEach(l => {
            if (map.hasLayer(l)) map.removeLayer(l);
        });
        layerToActivate.addTo(map);
        [btnHybrid, btnStreet, btnOsm].forEach(b => {
            if (b) b.classList.remove('active');
        });
        if (activeBtn) activeBtn.classList.add('active');
    }

    if (btnHybrid) btnHybrid.onclick = () => switchLayer(googleHybridLayer, btnHybrid);
    if (btnStreet) btnStreet.onclick = () => switchLayer(googleStreetLayer, btnStreet);
    if (btnOsm) btnOsm.onclick = () => switchLayer(osmLayer, btnOsm);

    map.on('click', onMapClick);

    // Auto-locate PC for convenience on initial open
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                map.setView([lat, lng], 15, { animate: true });
                selectLocation(lat, lng, 'Vị trí mạng của bạn', false);
            },
            () => {},
            { enableHighAccuracy: true, timeout: 4000 }
        );
    }
}

function onMapClick(e) {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;

    if (activeMode === 'teleport' || activeMode === 'joystick') {
        selectLocation(lat, lng, '', true);
        reverseGeocode(lat, lng);
    } else if (activeMode === 'route') {
        handleRouteMapClick(lat, lng);
    }
}

function selectLocation(lat, lng, place, fromClick, openPopup = true) {
    selectedLat = +lat.toFixed(6);
    selectedLng = +lng.toFixed(6);
    selectedPlace = place || '';
    currentJoyLat = selectedLat;
    currentJoyLng = selectedLng;

    const latEl = document.getElementById('disp-lat');
    const lngEl = document.getElementById('disp-lng');
    if (latEl) latEl.textContent = selectedLat.toFixed(6);
    if (lngEl) lngEl.textContent = selectedLng.toFixed(6);

    const placeEl = document.getElementById('disp-place');
    const placeRow = document.getElementById('place-row');
    if (place) {
        if (placeEl) placeEl.textContent = place.split(',').slice(0, 3).join(', ');
        if (placeRow) placeRow.style.display = '';
    } else {
        if (placeEl) placeEl.textContent = '⏳ Đang xác định địa chỉ...';
        if (placeRow) placeRow.style.display = '';
    }

    const btnTp = document.getElementById('btn-teleport');
    const btnFav = document.getElementById('btn-save-fav');
    if (btnTp) btnTp.disabled = false;
    if (btnFav) btnFav.disabled = false;

    const tipEl = document.getElementById('map-tip');
    if (tipEl) tipEl.style.opacity = '0';

    updateCooldownDisplay(selectedLat, selectedLng);

    if (selectedMarker) map.removeLayer(selectedMarker);
    const icon = L.divIcon({
        className: '',
        html: `<div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#6366f1);border:3px solid #fff;box-shadow:0 2px 14px rgba(59,130,246,.7);position:relative;display:flex;align-items:center;justify-content:center;"><div class="marker-pulse"></div></div>`,
        iconSize: [24, 24], iconAnchor: [12, 12],
    });
    selectedMarker = L.marker([lat, lng], { icon }).addTo(map);

    const displayName = place ? (place.split(',').slice(0, 3).join(', ') || place) : '⏳ Đang lấy tên địa điểm...';
    const popupHtml = `
        <div class="map-marker-popup">
            <div class="popup-place-name" id="popup-place-name">${displayName}</div>
            <div class="popup-coord-row">
                <span class="popup-coord-tag">Lat: ${selectedLat}</span>
                <span class="popup-coord-tag">Lng: ${selectedLng}</span>
            </div>
            <button class="popup-teleport-btn" id="btn-popup-teleport" onclick="executeTeleport()">
                <span>🚀</span> Dịch chuyển tới đây
            </button>
        </div>
    `;

    selectedMarker.bindPopup(popupHtml, {
        offset: [0, -10],
        closeButton: true,
        autoPan: true
    });

    if (openPopup) {
        selectedMarker.openPopup();
    }

    if (fromClick) sessionStorage.setItem('bh-last-loc', JSON.stringify({ lat, lng, place }));
}

async function reverseGeocode(lat, lng) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=vi`, {
            headers: { 'User-Agent': 'BraveHoang-GPS-Spoofer/2.0' }
        });
        const data = await res.json();
        const place = data.display_name || '';
        selectedPlace = place;
        const placeText = place.split(',').slice(0, 3).join(', ') || place || `Tọa độ ${lat}, ${lng}`;

        const placeEl = document.getElementById('disp-place');
        const placeRow = document.getElementById('place-row');
        if (placeEl) placeEl.textContent = placeText;
        if (placeRow) placeRow.style.display = '';

        const popupPlace = document.getElementById('popup-place-name');
        if (popupPlace) popupPlace.textContent = placeText;
    } catch {
        const popupPlace = document.getElementById('popup-place-name');
        if (popupPlace && popupPlace.textContent.includes('Đang lấy')) {
            popupPlace.textContent = `Vị trí: ${lat}, ${lng}`;
        }
    }
}

// ─── Teleport Action (Reusable) ─────────────────────────────────────────────
async function executeTeleport(targetLat = selectedLat, targetLng = selectedLng) {
    if (targetLat === null || targetLng === null) return;
    isTeleporting = true;
    const btnTp = document.getElementById('btn-teleport');
    if (btnTp) btnTp.disabled = true;

    const popupBtn = document.getElementById('btn-popup-teleport');
    if (popupBtn) {
        popupBtn.disabled = true;
        popupBtn.innerHTML = '<span>⏳</span> Đang dịch chuyển...';
    }

    showToast(`⚡ Đang dịch chuyển tới [${targetLat}, ${targetLng}]...`, 'info');
    const result = await electronAPI.setLocation(targetLat, targetLng, currentUdid);

    if (result.ok) {
        lastTeleportedLat = targetLat;
        lastTeleportedLng = targetLng;
        showToast('✅ Đã dịch chuyển thành công!', 'success');
        addHistory(targetLat, targetLng, selectedPlace || `Tọa độ ${targetLat}, ${targetLng}`);
        updateCooldownDisplay(targetLat, targetLng);

        if (popupBtn) {
            popupBtn.style.background = '#22c55e';
            popupBtn.innerHTML = '<span>✓</span> Đã dịch chuyển!';
            setTimeout(() => {
                if (popupBtn) {
                    popupBtn.disabled = false;
                    popupBtn.style.background = '';
                    popupBtn.innerHTML = '<span>🚀</span> Dịch chuyển tới đây';
                }
            }, 2500);
        }
    } else {
        showToast(`❌ Lỗi dịch chuyển: ${result.error}`, 'error');
        if (popupBtn) {
            popupBtn.disabled = false;
            popupBtn.innerHTML = '<span>🚀</span> Dịch chuyển tới đây';
        }
    }

    isTeleporting = false;
    if (btnTp) btnTp.disabled = false;
}
window.executeTeleport = executeTeleport;

// ─── Coordinate Parser (DMS, Decimal, Google Maps URL) ──────────────────────
function parseCoordinates(input) {
    if (!input || typeof input !== 'string') return null;
    const str = input.trim();

    // 1. Google Maps URL: @21.032306,105.835667 or ?q=21.032306,105.835667
    const urlMatch = str.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || str.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (urlMatch) {
        const lat = parseFloat(urlMatch[1]);
        const lng = parseFloat(urlMatch[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            return { lat: +lat.toFixed(6), lng: +lng.toFixed(6), format: 'url' };
        }
    }

    // 2. DMS format: e.g. 21°01'56.3"N 105°50'08.4"E or 21° 01' 56.3" N, 105° 50' 08.4" E
    const dmsRegex = /([0-9]+(?:\.[0-9]+)?)[°\s]+([0-9]+(?:\.[0-9]+)?)[′'\s]+([0-9]+(?:\.[0-9]+)?)[″"]?\s*([NSEWnsew])[\s,;]+([0-9]+(?:\.[0-9]+)?)[°\s]+([0-9]+(?:\.[0-9]+)?)[′'\s]+([0-9]+(?:\.[0-9]+)?)[″"]?\s*([NSEWnsew])/i;
    const dmsMatch = str.match(dmsRegex);
    if (dmsMatch) {
        let lat = parseFloat(dmsMatch[1]) + parseFloat(dmsMatch[2]) / 60 + parseFloat(dmsMatch[3]) / 3600;
        if (dmsMatch[4].toUpperCase() === 'S') lat = -lat;

        let lng = parseFloat(dmsMatch[5]) + parseFloat(dmsMatch[6]) / 60 + parseFloat(dmsMatch[7]) / 3600;
        if (dmsMatch[8].toUpperCase() === 'W') lng = -lng;

        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            return { lat: +lat.toFixed(6), lng: +lng.toFixed(6), format: 'dms' };
        }
    }

    // 3. Decimal coordinates: e.g. "21.032306, 105.835667" or "21.032306 105.835667" or "21.032306N, 105.835667E"
    const decRegex = /^(-?\d+(?:\.\d+)?)\s*([NSns])?[\s,;]+(-?\d+(?:\.\d+)?)\s*([EWew])?$/;
    const decMatch = str.match(decRegex);
    if (decMatch) {
        let lat = parseFloat(decMatch[1]);
        if (decMatch[2] && decMatch[2].toUpperCase() === 'S') lat = -Math.abs(lat);
        let lng = parseFloat(decMatch[3]);
        if (decMatch[4] && decMatch[4].toUpperCase() === 'W') lng = -Math.abs(lng);

        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            return { lat: +lat.toFixed(6), lng: +lng.toFixed(6), format: 'decimal' };
        }
    }

    return null;
}

// ─── Jump to Coordinates (Show Marker & Name, wait for user to Teleport) ───
function jumpToCoordinates(coords) {
    if (!coords) return;
    const { lat, lng } = coords;

    map.setView([lat, lng], 17, { animate: true });
    selectLocation(lat, lng, `Tọa độ ${lat}, ${lng}`, true, true);
    reverseGeocode(lat, lng);
    showToast(`📍 Đã định vị [${lat}, ${lng}]. Bấm "Dịch chuyển" để áp dụng.`, 'info');
}

// ─── Quick Coordinate Input (Sidebar) ────────────────────────────────────────
const quickCoordInput = document.getElementById('coord-quick-input');
const quickCoordBtn = document.getElementById('btn-coord-quick-go');

function handleQuickCoordGo() {
    if (!quickCoordInput) return;
    const val = quickCoordInput.value.trim();
    if (!val) {
        showToast('Vui lòng dán hoặc nhập tọa độ (VD: 21°01\'56.3"N 105°50\'08.4"E)', 'warn');
        return;
    }
    const coords = parseCoordinates(val);
    if (coords) {
        jumpToCoordinates(coords);
    } else {
        showToast('Định dạng tọa độ không hợp lệ. Vui lòng kiểm tra lại.', 'error');
    }
}

if (quickCoordBtn) {
    quickCoordBtn.onclick = handleQuickCoordGo;
}
if (quickCoordInput) {
    quickCoordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleQuickCoordGo();
    });
}

// ─── Search & Autocomplete (Vietnamese IME + Fuzzy Search + Coords) ──────────
let searchTimer = null;
let isImeComposing = false;
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

if (searchInput) {
    // Không làm gián đoạn Unikey / EVKey khi đang gõ tiếng Việt có dấu
    searchInput.addEventListener('compositionstart', () => {
        isImeComposing = true;
    });

    searchInput.addEventListener('compositionend', () => {
        isImeComposing = false;
        scheduleSearch();
    });

    searchInput.addEventListener('input', (e) => {
        if (isImeComposing || e.isComposing) return;
        scheduleSearch();
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const q = searchInput.value.trim();
            const coords = parseCoordinates(q);
            if (coords) {
                closeSearch();
                jumpToCoordinates(coords);
                return;
            }
            if (q.length >= 2) {
                clearTimeout(searchTimer);
                doSearch(q);
            }
        } else if (e.key === 'Escape') {
            closeSearch();
        }
    });
}

function scheduleSearch() {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
        closeSearch();
        return;
    }

    // Kiểm tra nếu người dùng dán hoặc gõ tọa độ trực tiếp vào ô tìm kiếm
    const coords = parseCoordinates(q);
    if (coords) {
        renderCoordinateJumpOption(coords);
        return;
    }

    if (q.length < 2) {
        closeSearch();
        return;
    }

    searchTimer = setTimeout(() => {
        if (searchInput.value.trim() === q && !isImeComposing) {
            doSearch(q);
        }
    }, 380);
}

function renderCoordinateJumpOption(coords) {
    if (!searchResults) return;
    searchResults.innerHTML = `
        <div class="search-item search-item-coord" id="jump-coord-item">
            <div style="display:flex;align-items:center;justify-content:space-between;">
                <span style="font-weight:700;color:#60a5fa;display:flex;align-items:center;gap:6px;">
                    🎯 Phát hiện tọa độ: Xem vị trí
                </span>
                <span class="coord-jump-badge">Xem trên bản đồ ➔</span>
            </div>
            <div class="search-item-sub" style="font-size:12px;color:#94a3b8;margin-top:4px;">
                Vĩ độ (Lat): <strong>${coords.lat}</strong> | Kinh độ (Lng): <strong>${coords.lng}</strong>
            </div>
        </div>
    `;
    searchResults.classList.remove('hidden');

    const jumpBtn = document.getElementById('jump-coord-item');
    if (jumpBtn) {
        jumpBtn.onclick = () => {
            closeSearch();
            jumpToCoordinates(coords);
        };
    }
}

async function doSearch(q) {
    if (!searchResults) return;

    // 1. Ưu tiên Photon API (Fuzzy search nhanh, hỗ trợ gõ có dấu và ưu tiên theo vị trí bản đồ hiện tại)
    try {
        const center = map.getCenter();
        const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${center.lat}&lon=${center.lng}&limit=6&lang=default`;
        const res = await fetch(photonUrl);
        const data = await res.json();

        if (data && data.features && data.features.length > 0) {
            const items = data.features.map(f => {
                const p = f.properties;
                const name = p.name || p.street || q;
                const details = [p.street, p.district || p.suburb, p.city || p.county, p.state, p.country]
                    .filter(Boolean)
                    .join(', ');
                return {
                    name: name,
                    sub: details || `${f.geometry.coordinates[1].toFixed(5)}, ${f.geometry.coordinates[0].toFixed(5)}`,
                    lat: f.geometry.coordinates[1],
                    lng: f.geometry.coordinates[0]
                };
            });
            renderSearchResultsList(items);
            return;
        }
    } catch (e) {
        console.warn('Photon fallback:', e);
    }

    // 2. Fallback sang OpenStreetMap Nominatim
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&accept-language=vi,en`, {
            headers: { 'User-Agent': 'BraveHoang-GPS-Spoofer/2.0' }
        });
        const data = await res.json();
        const items = data.map(r => ({
            name: r.display_name.split(',')[0],
            sub: r.display_name.split(',').slice(1, 4).join(',').trim(),
            lat: +r.lat,
            lng: +r.lon
        }));
        renderSearchResultsList(items);
    } catch {
        closeSearch();
    }
}

function renderSearchResultsList(items) {
    if (!searchResults) return;
    if (!items || !items.length) {
        searchResults.innerHTML = `<div class="search-item" style="color:#94a3b8;cursor:default;">Không tìm thấy địa điểm phù hợp</div>`;
        searchResults.classList.remove('hidden');
        return;
    }

    searchResults.innerHTML = items.map((item, i) => `
        <div class="search-item" data-i="${i}">
            <div style="font-weight:600;">${item.name}</div>
            <div class="search-item-sub">${item.sub}</div>
        </div>
    `).join('');
    searchResults.classList.remove('hidden');

    items.forEach((item, i) => {
        const el = searchResults.querySelector(`[data-i="${i}"]`);
        if (el) {
            el.onclick = () => {
                closeSearch();
                map.setView([item.lat, item.lng], 16, { animate: true });
                selectLocation(item.lat, item.lng, `${item.name}, ${item.sub}`, true, true);
                reverseGeocode(item.lat, item.lng);
                searchInput.value = item.name;
                showToast(`📍 Đã chọn "${item.name}". Bấm "Dịch chuyển" để áp dụng.`, 'info');
            };
        }
    });
}

function closeSearch() {
    if (searchResults) searchResults.classList.add('hidden');
}

document.addEventListener('click', e => {
    const searchBar = document.getElementById('search-bar');
    if (searchBar && !searchBar.contains(e.target)) closeSearch();
});

// ─── Device Detection & Tunnel Management ────────────────────────────────────
async function refreshDevices() {
    if (isTeleporting) return;
    const dot = document.getElementById('device-dot');
    const label = document.getElementById('device-label');
    const sel = document.getElementById('device-select');
    const { ok, devices } = await electronAPI.getDevices();

    if (!ok || !devices.length) {
        dot.className = 'status-dot dot-error';
        label.textContent = 'Chưa thấy iPhone';
        sel.classList.add('hidden');
        document.getElementById('device-cards').innerHTML = '<div class="device-empty">Chưa kết nối thiết bị nào qua USB</div>';
        return;
    }

    dot.className = 'status-dot dot-ok';
    label.textContent = `${devices.length} thiết bị online`;

    const cardsHtml = devices.map((d, i) => {
        const shortUdid = d.udid.slice(0, 8) + '...' + d.udid.slice(-4);
        const connLabel = d.connectionType === 'WiFi' ? '📶 WiFi' : '🔌 USB';
        const connCls   = d.connectionType === 'WiFi' ? 'conn-wifi' : 'conn-usb';
        const isActive  = d.udid === currentUdid || (i === 0 && !currentUdid);
        const verTag    = d.version ? `<span class="udid-tag" style="color:#60a5fa;">iOS ${d.version}</span>` : '';
        return `<div class="device-card${isActive ? ' active' : ''}" data-udid="${d.udid}" onclick="selectDeviceCard('${d.udid}')">
            <div class="device-card-name">${d.name || 'iPhone'}</div>
            <div class="device-card-meta">
                <span class="conn-badge ${connCls}">${connLabel}</span>
                ${verTag}
                <span class="udid-tag" title="${d.udid}">${shortUdid}</span>
            </div>
        </div>`;
    }).join('');
    document.getElementById('device-cards').innerHTML = cardsHtml;

    sel.innerHTML = devices.map(d => `<option value="${d.udid}">${d.name}</option>`).join('');

    const prevUdid = currentUdid;
    if (!currentUdid || !devices.find(d => d.udid === currentUdid)) {
        currentUdid = devices[0].udid;
        sel.value = currentUdid;
    }

    if (prevUdid !== currentUdid || tunnelStatus.status === 'idle' || tunnelStatus.status === 'error') {
        setupTunnel(currentUdid);
    }
}

function selectDeviceCard(udid) {
    currentUdid = udid;
    document.querySelectorAll('.device-card').forEach(c => c.classList.toggle('active', c.dataset.udid === udid));
    setupTunnel(udid);
}
window.selectDeviceCard = selectDeviceCard;

async function setupTunnel(udid) {
    if (tunnelStatus.status === 'ready' && workerReady) return;
    tunnelStatus.status = 'connecting';
    updateTunnelBadge();

    const result = await electronAPI.setupTunnel(udid);
    if (!result.ok) {
        tunnelStatus.status = 'error';
        tunnelStatus.error = result.error || 'Lỗi kết nối';
        updateTunnelBadge();
    }
}

function updateTunnelBadge() {
    const b = document.getElementById('tunnel-badge');
    if (!b) return;
    if (tunnelStatus.status === 'ready' || workerReady) {
        b.className = 'tunnel-badge tunnel-ready';
        b.textContent = '● Userspace Tunnel sẵn sàng ⚡';
    } else if (tunnelStatus.status === 'connecting') {
        b.className = 'tunnel-badge tunnel-connecting';
        b.textContent = '◌ Đang kết nối Userspace Tunnel...';
    } else if (tunnelStatus.status === 'error') {
        b.className = 'tunnel-badge tunnel-error';
        b.textContent = '✕ Lỗi kết nối tunnel';
    } else {
        b.className = 'tunnel-badge tunnel-idle';
        b.textContent = '○ Tunnel chưa kết nối';
    }
}

electronAPI.onTunnelStatus((status) => {
    tunnelStatus = status;
    updateTunnelBadge();
});

electronAPI.onWorkerReady(() => {
    clearConnectingTimeout();
    workerReady = true;
    setStepState('step-worker', 'step-done');
    markSetupDone();
    updateTunnelBadge();
    showToast('⚡ Userspace Tunnel đã kết nối!', 'success');
});

// ─── Teleport Action ─────────────────────────────────────────────────────────
document.getElementById('btn-teleport').onclick = () => executeTeleport();

// ─── Reset Location (Back to Real GPS) ───────────────────────────────────────
document.getElementById('btn-reset-gps').onclick = async () => {
    stopRoute();
    showToast('🔄 Đang khôi phục GPS thật...', 'info');
    const result = await electronAPI.resetLocation(currentUdid);
    if (result.ok) {
        lastTeleportedLat = null;
        lastTeleportedLng = null;
        document.getElementById('cooldown-box').classList.add('hidden');
        showToast('✅ Đã khôi phục định vị GPS thực tế!', 'success');
    } else {
        showToast(`❌ Lỗi khôi phục: ${result.error}`, 'error');
    }
};

// ─── Route Navigation Mode (OSRM API) ────────────────────────────────────────
function handleRouteMapClick(lat, lng) {
    if (routeIsPlaying) {
        showToast('Vui lòng dừng lộ trình hiện tại trước khi tạo mới.', 'warn');
        return;
    }

    if (!routeStartPoint) {
        // Set point A
        routeStartPoint = [lat, lng];
        if (routeStartMarker) map.removeLayer(routeStartMarker);
        const iconA = L.divIcon({
            className: '',
            html: `<div style="width:28px;height:28px;border-radius:50%;background:#22c55e;color:#fff;border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;box-shadow:0 2px 10px rgba(34,197,94,0.6);">A</div>`,
            iconSize: [28, 28], iconAnchor: [14, 14]
        });
        routeStartMarker = L.marker([lat, lng], { icon: iconA }).addTo(map);
        document.getElementById('route-hint').textContent = 'Đã chọn Điểm A. Hãy nhấp điểm thứ hai trên bản đồ để làm Điểm B.';
        showToast('📍 Đã chọn Điểm A (Xuất phát)', 'info');
    } else if (!routeEndPoint) {
        // Set point B
        routeEndPoint = [lat, lng];
        if (routeEndMarker) map.removeLayer(routeEndMarker);
        const iconB = L.divIcon({
            className: '',
            html: `<div style="width:28px;height:28px;border-radius:50%;background:#ef4444;color:#fff;border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;box-shadow:0 2px 10px rgba(239,68,68,0.6);">B</div>`,
            iconSize: [28, 28], iconAnchor: [14, 14]
        });
        routeEndMarker = L.marker([lat, lng], { icon: iconB }).addTo(map);
        document.getElementById('route-hint').textContent = 'Đang tính toán tuyến đường tối ưu...';
        fetchOSRMRoute(routeStartPoint, routeEndPoint);
    } else {
        // Reset and start with new point A
        clearRoute();
        handleRouteMapClick(lat, lng);
    }
}

async function fetchOSRMRoute(pA, pB) {
    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${pA[1]},${pA[0]};${pB[1]},${pB[0]}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        const data = await res.json();

        if (!data.routes || !data.routes.length) {
            document.getElementById('route-hint').textContent = 'Không tìm thấy đường đi giữa 2 điểm này. Vui lòng thử lại.';
            return;
        }

        const route = data.routes[0];
        // OSRM coordinates are [lng, lat], convert to Leaflet [lat, lng]
        routeCoords = route.geometry.coordinates.map(c => [c[1], c[0]]);

        if (routePolyline) map.removeLayer(routePolyline);
        routePolyline = L.polyline(routeCoords, {
            color: '#4f8cff',
            weight: 5,
            opacity: 0.85,
            lineJoin: 'round'
        }).addTo(map);

        map.fitBounds(routePolyline.getBounds(), { padding: [50, 50] });

        const distKm = (route.distance / 1000).toFixed(2);
        const durationMin = Math.round(route.duration / 60);

        document.getElementById('route-dist').textContent = `${distKm} km`;
        document.getElementById('route-time').textContent = `${durationMin} phút (${routeSpeedKmh} km/h)`;
        document.getElementById('route-info-box').classList.remove('hidden');
        document.getElementById('route-hint').textContent = `Tuyến đường ${distKm} km đã sẵn sàng. Bấm "Bắt đầu di chuyển" để khởi hành.`;
        document.getElementById('btn-route-start').disabled = false;
        showToast(`🛣️ Tuyến đường ${distKm} km đã sẵn sàng!`, 'success');
    } catch (e) {
        document.getElementById('route-hint').textContent = 'Lỗi tính toán đường đi. Vui lòng thử lại.';
    }
}

function clearRoute() {
    stopRoute();
    if (routeStartMarker) { map.removeLayer(routeStartMarker); routeStartMarker = null; }
    if (routeEndMarker) { map.removeLayer(routeEndMarker); routeEndMarker = null; }
    if (routePolyline) { map.removeLayer(routePolyline); routePolyline = null; }
    if (routeMovingMarker) { map.removeLayer(routeMovingMarker); routeMovingMarker = null; }
    routeStartPoint = null;
    routeEndPoint = null;
    routeCoords = [];
    routeIndex = 0;
    document.getElementById('route-info-box').classList.add('hidden');
    document.getElementById('btn-route-start').disabled = true;
    document.getElementById('route-hint').textContent = 'Nhấp 2 điểm trên bản đồ để tạo điểm xuất phát (A) và điểm đến (B).';
}
document.getElementById('btn-clear-route').onclick = clearRoute;

// Speed slider & presets
const speedSlider = document.getElementById('speed-slider');
const speedDisplay = document.getElementById('speed-display');
speedSlider.addEventListener('input', e => {
    routeSpeedKmh = parseFloat(e.target.value);
    speedDisplay.textContent = `${routeSpeedKmh} km/h`;
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.speed) === routeSpeedKmh));
});

document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        routeSpeedKmh = parseFloat(btn.dataset.speed);
        speedSlider.value = routeSpeedKmh;
        speedDisplay.textContent = `${routeSpeedKmh} km/h`;
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

// Route start/pause/stop
document.getElementById('btn-route-start').onclick = startRoute;
document.getElementById('btn-route-pause').onclick = togglePauseRoute;
document.getElementById('btn-route-stop').onclick = stopRoute;

function startRoute() {
    if (!routeCoords.length) return;
    routeIsPlaying = true;
    routeIsPaused = false;
    routeIndex = 0;

    document.getElementById('btn-route-start').classList.add('hidden');
    document.getElementById('btn-route-pause').classList.remove('hidden');
    document.getElementById('btn-route-pause').innerHTML = '<span class="btn-icon">⏸</span> Tạm dừng';
    document.getElementById('btn-route-stop').classList.remove('hidden');

    const floatingBadge = document.getElementById('floating-route-status');
    floatingBadge.classList.remove('hidden');

    if (!routeMovingMarker) {
        const moveIcon = L.divIcon({
            className: '',
            html: `<div style="width:22px;height:22px;border-radius:50%;background:#3b82f6;border:3px solid #fff;box-shadow:0 0 12px rgba(59,130,246,0.9);"><div class="marker-pulse"></div></div>`,
            iconSize: [22, 22], iconAnchor: [11, 11]
        });
        routeMovingMarker = L.marker(routeCoords[0], { icon: moveIcon }).addTo(map);
    }

    advanceRouteStep();
}

function advanceRouteStep() {
    if (!routeIsPlaying || routeIsPaused) return;

    if (routeIndex >= routeCoords.length) {
        finishRoute();
        return;
    }

    const currentPos = routeCoords[routeIndex];
    let nextPos = routeCoords[Math.min(routeIndex + 1, routeCoords.length - 1)];

    // Apply anti-ban jitter if enabled
    const jitterEnabled = document.getElementById('check-speed-jitter').checked;
    let actualSpeed = routeSpeedKmh;
    if (jitterEnabled) {
        const jitter = (Math.random() - 0.5) * 0.2; // +/- 10%
        actualSpeed = Math.max(1, routeSpeedKmh * (1 + jitter));
    }

    document.getElementById('floating-route-text').textContent = `Đang di chuyển: ${actualSpeed.toFixed(1)} km/h`;

    // Send location to iPhone
    electronAPI.setLocation(currentPos[0], currentPos[1], currentUdid);
    lastTeleportedLat = currentPos[0];
    lastTeleportedLng = currentPos[1];

    if (routeMovingMarker) {
        routeMovingMarker.setLatLng(currentPos);
    }

    // Interval based on speed and distance to next node
    const segDistM = distanceMeters(currentPos[0], currentPos[1], nextPos[0], nextPos[1]);
    const speedMs = (actualSpeed * 1000) / 3600;
    const intervalMs = Math.max(800, Math.min(3000, (segDistM / Math.max(speedMs, 0.5)) * 1000));

    routeIndex++;
    routeTimer = setTimeout(advanceRouteStep, intervalMs);
}

function togglePauseRoute() {
    if (!routeIsPlaying) return;
    routeIsPaused = !routeIsPaused;
    const btn = document.getElementById('btn-route-pause');
    if (routeIsPaused) {
        clearTimeout(routeTimer);
        btn.innerHTML = '<span class="btn-icon">▶</span> Tiếp tục';
        showToast('⏸ Đã tạm dừng lộ trình', 'info');
    } else {
        btn.innerHTML = '<span class="btn-icon">⏸</span> Tạm dừng';
        showToast('▶ Tiếp tục di chuyển', 'info');
        advanceRouteStep();
    }
}

function stopRoute() {
    clearTimeout(routeTimer);
    routeIsPlaying = false;
    routeIsPaused = false;
    document.getElementById('btn-route-start').classList.remove('hidden');
    document.getElementById('btn-route-pause').classList.add('hidden');
    document.getElementById('btn-route-stop').classList.add('hidden');
    document.getElementById('floating-route-status').classList.add('hidden');
}

function finishRoute() {
    stopRoute();
    showToast('🎉 Đã hoàn thành lộ trình di chuyển!', 'success');
}

// ─── Virtual Joystick Controller (WASD & D-Pad) ──────────────────────────────
document.querySelectorAll('.joy-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        joystickSpeedKmh = parseFloat(btn.dataset.speed);
        document.getElementById('joy-speed-display').textContent = `${joystickSpeedKmh} km/h`;
        document.querySelectorAll('.joy-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

function moveJoystick(dxMeters, dyMeters) {
    if (currentJoyLat === null || currentJoyLng === null) {
        if (selectedLat !== null && selectedLng !== null) {
            currentJoyLat = selectedLat;
            currentJoyLng = selectedLng;
        } else {
            showToast('Vui lòng chọn 1 điểm trên bản đồ trước khi dùng Joystick.', 'info');
            return;
        }
    }

    const dLat = dyMeters / EARTH_METERS_PER_DEG_LAT;
    const dLng = dxMeters / (EARTH_METERS_PER_DEG_LAT * Math.cos(toRadians(currentJoyLat)));

    currentJoyLat += dLat;
    currentJoyLng += dLng;

    selectLocation(currentJoyLat, currentJoyLng, '', false);
    map.panTo([currentJoyLat, currentJoyLng], { animate: true });
    electronAPI.setLocation(currentJoyLat, currentJoyLng, currentUdid);
}

// D-Pad Buttons
const STEP_DISTANCE_M = 10;
document.getElementById('btn-joy-up').onclick = () => moveJoystick(0, (joystickSpeedKmh * 1000 / 3600) * 1.5);
document.getElementById('btn-joy-down').onclick = () => moveJoystick(0, -(joystickSpeedKmh * 1000 / 3600) * 1.5);
document.getElementById('btn-joy-left').onclick = () => moveJoystick(-(joystickSpeedKmh * 1000 / 3600) * 1.5, 0);
document.getElementById('btn-joy-right').onclick = () => moveJoystick((joystickSpeedKmh * 1000 / 3600) * 1.5, 0);

// Keyboard WASD & Arrow Key Navigation
window.addEventListener('keydown', e => {
    if (activeMode !== 'joystick') return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;

    const stepM = (joystickSpeedKmh * 1000 / 3600) * 1.5;
    if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') {
        moveJoystick(0, stepM);
        e.preventDefault();
    } else if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') {
        moveJoystick(0, -stepM);
        e.preventDefault();
    } else if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') {
        moveJoystick(-stepM, 0);
        e.preventDefault();
    } else if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') {
        moveJoystick(stepM, 0);
        e.preventDefault();
    }
});

// ─── Favorites System ────────────────────────────────────────────────────────
document.getElementById('btn-save-fav').onclick = () => {
    if (selectedLat === null || selectedLng === null) return;
    const name = prompt('Nhập tên cho địa điểm yêu thích:', selectedPlace.split(',')[0] || `Vị trí ${selectedLat.toFixed(4)}, ${selectedLng.toFixed(4)}`);
    if (!name || !name.trim()) return;

    favorites.unshift({ name: name.trim(), lat: selectedLat, lng: selectedLng });
    localStorage.setItem('bh-gps-favorites', JSON.stringify(favorites));
    renderFavorites();
    showToast(`⭐ Đã lưu: ${name}`, 'success');
};

function renderFavorites() {
    const list = document.getElementById('favorites-list');
    if (!favorites.length) {
        list.innerHTML = '<div class="empty-hint">Chưa lưu địa điểm nào</div>';
        return;
    }
    list.innerHTML = favorites.map((f, i) => `
        <div class="fav-item" data-i="${i}">
            <div>
                <div class="fav-name">${f.name}</div>
                <div class="fav-coords">${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}</div>
            </div>
            <button class="fav-del" data-del="${i}" title="Xóa">✕</button>
        </div>
    `).join('');

    list.querySelectorAll('.fav-item').forEach(el => {
        const i = +el.dataset.i;
        el.onclick = (e) => {
            if (e.target.matches('.fav-del')) return;
            const f = favorites[i];
            map.setView([f.lat, f.lng], 15, { animate: true });
            selectLocation(f.lat, f.lng, f.name, true);
        };
        el.querySelector('.fav-del').onclick = () => {
            favorites.splice(i, 1);
            localStorage.setItem('bh-gps-favorites', JSON.stringify(favorites));
            renderFavorites();
        };
    });
}

// ─── History ─────────────────────────────────────────────────────────────────
function addHistory(lat, lng, place) {
    const item = { lat, lng, place: place ? place.split(',').slice(0, 2).join(',').trim() : `${lat}, ${lng}`, time: Date.now() };
    history = [item, ...history.filter(h => !(Math.abs(h.lat - lat) < 0.001 && Math.abs(h.lng - lng) < 0.001))].slice(0, 25);
    localStorage.setItem('bh-gps-history', JSON.stringify(history));
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById('history-list');
    if (!history.length) { list.innerHTML = '<div class="empty-hint">Chưa có lịch sử</div>'; return; }
    list.innerHTML = history.map((h, i) => `<div class="history-item" data-i="${i}"><span class="history-icon">📍</span><div class="history-info"><div class="history-place">${h.place}</div><div class="history-coords">${h.lat.toFixed(4)}, ${h.lng.toFixed(4)}</div></div><button class="history-del" data-del="${i}">✕</button></div>`).join('');
    list.querySelectorAll('.history-item').forEach(el => {
        const i = +el.dataset.i;
        el.onclick = (e) => { if (e.target.matches('.history-del')) return; const h = history[i]; map.setView([h.lat, h.lng], 15, { animate: true }); selectLocation(h.lat, h.lng, h.place, true); };
        el.querySelector('.history-del').onclick = () => { history.splice(i, 1); localStorage.setItem('bh-gps-history', JSON.stringify(history)); renderHistory(); };
    });
}
document.getElementById('btn-clear-history').onclick = () => { history = []; localStorage.setItem('bh-gps-history', '[]'); renderHistory(); };

// ─── UI Helpers & Window Controls ────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = `show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = ''; }, 3200);
}

document.getElementById('btn-min').onclick   = () => electronAPI.minimize();
document.getElementById('btn-max').onclick   = () => electronAPI.maximize();
document.getElementById('btn-close').onclick = () => electronAPI.close();
document.getElementById('btn-refresh').onclick = refreshDevices;

// ─── Wi-Fi Modal ─────────────────────────────────────────────────────────────
function closeWifiModal() { document.getElementById('wifi-modal').classList.add('hidden'); }
async function scanWifi() {
    const btn = document.getElementById('btn-scan-wifi');
    const tbody = document.getElementById('wifi-table-body');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon">⏳</span> Đang quét...';
    tbody.innerHTML = '<tr><td colspan="4" class="wifi-empty">Đang tìm kiếm thiết bị trên mạng Wi-Fi...</td></tr>';
    try {
        const result = await electronAPI.scanWifi();
        if (result.ok && result.devices && result.devices.length) {
            tbody.innerHTML = result.devices.map(d => `
                <tr>
                    <td><strong>${d.name || 'iPhone'}</strong></td>
                    <td>${d.host || d.ip}:${d.port}</td>
                    <td><span class="udid-tag">${(d.udid || '').slice(0, 8)}...</span></td>
                    <td><button class="btn-connect-wifi" onclick="connectWifi('${d.udid}', '${d.name}')">Kết nối</button></td>
                </tr>
            `).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="4" class="wifi-empty">Không tìm thấy thiết bị Wi-Fi nào cùng mạng.</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="wifi-empty" style="color:#ef4444 !important;">Lỗi: ${e.message}</td></tr>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">↻</span> Quét mạng';
    }
}
function connectWifi(udid, name) {
    showToast(`Đang kết nối tới ${name}...`, 'info');
    closeWifiModal();
    currentUdid = udid;
    setupTunnel(udid);
}

window.openUrl = (url) => electronAPI.openUrl(url);
window.wizardInstallPmd = wizardInstallPmd;
window.wizardInstallPython = wizardInstallPython;
window.wizardRefreshIphone = wizardRefreshIphone;
window.wizardContinue = wizardContinue;
window.showWizard = showWizard;
window.closeWifiModal = closeWifiModal;
window.scanWifi = scanWifi;
window.connectWifi = connectWifi;

// ─── Bootstrapping ───────────────────────────────────────────────────────────
async function init() {
    initMap();
    initModeTabs();
    renderFavorites();
    renderHistory();

    const { py } = await electronAPI.getPython();
    const { tool } = await electronAPI.detectTool();

    if (!py || !tool || !tool.startsWith('pymobiledevice3')) {
        showWizard();
    } else {
        document.getElementById('wizard').classList.add('hidden');
        document.getElementById('wizard').classList.add('hidden-by-user');
        document.getElementById('connecting-page').classList.remove('hidden');
        startFullConnection();
    }

    setInterval(refreshDevices, 6000);
}
init();
