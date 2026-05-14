/* global electronAPI, L */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────
let map, selectedMarker = null;
let selectedLat = null, selectedLng = null;
let selectedPlace = '';
let currentUdid = '';
let history = JSON.parse(localStorage.getItem('bh-gps-history') || '[]');
let isTeleporting = false;
let deviceRefreshTimer = null;
let keepAliveTimer = null;
let keepAliveFailureCount = 0;
let keepAliveInFlight = false;
const KEEP_ALIVE_MS = 3000;
let pinnedLocation = null;
const PINNED_LOCATION_KEY = 'bh-pinned-location';
const SPOOF_RADIUS_M = 45;
const SPOOF_STEP_MIN_M = 2;
const SPOOF_STEP_MAX_M = 8;
const EARTH_METERS_PER_DEG_LAT = 111320;

// Tunnel state (mirrored from main process)
let tunnelStatus = { status: 'idle', host: null, port: null, udid: null, error: null };
let tunnelSetupInProgress = false;
let workerReady = false;

// Wizard State
let wizPythonOk = false;
let wizPmdOk = false;
let wizIphoneOk = false;

// ─── Wizard Logic ────────────────────────────────────────────────────────────
function setWizRow(id, state, desc, showBtn = false) { // state: 'ok' | 'err' | 'warn' | 'wait'
    const row = document.getElementById(`req-${id}`);
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
    // 0. Check Admin
    const isAdmin = await electronAPI.checkAdmin();
    const adminWarn = document.getElementById('wizard-admin-warn');
    if (isAdmin) adminWarn.classList.add('hidden');
    else adminWarn.classList.remove('hidden');

    // 1. Check Python
    const { py } = await electronAPI.getPython();
    if (py) {
        wizPythonOk = true;
        setWizRow('python', 'ok', `Đã tìm thấy Python: ${py}`);
    } else {
        wizPythonOk = false;
        setWizRow('python', 'err', 'Chưa cài đặt Python hoặc chưa thêm vào PATH.', true);
    }

    // 2. Check pymobiledevice3
    const { tool } = await electronAPI.detectTool();
    if (tool && tool.startsWith('pymobiledevice3')) {
        wizPmdOk = true;
        setWizRow('pmd', 'ok', `Đã cài đặt công cụ (${tool})`);
    } else {
        wizPmdOk = false;
        setWizRow('pmd', 'err', 'Chưa cài đặt thư viện pymobiledevice3.', wizPythonOk);
    }

    // 3. Check iPhone
    const { ok, devices } = await electronAPI.getDevices();
    const tips = document.getElementById('wizard-iphone-tips');
    if (ok && devices && devices.length > 0) {
        wizIphoneOk = true;
        currentUdid = devices[0].udid; // default to first

        // Build device list HTML
        const listHtml = devices.map((d, i) => {
            const shortUdid = d.udid.slice(0, 8) + '...' + d.udid.slice(-4);
            const connBadge = d.connectionType === 'WiFi'
                ? '<span class="conn-badge conn-wifi">📶 WiFi</span>'
                : '<span class="conn-badge conn-usb">🔌 USB</span>';
            return `<div class="wizard-device-item${i === 0 ? ' selected' : ''}" data-udid="${d.udid}" onclick="wizardSelectDevice(this,'${d.udid}')">
                <div class="wizard-device-name">${d.name || 'iPhone'}</div>
                <div class="wizard-device-meta">${connBadge}<span class="udid-tag">${shortUdid}</span></div>
            </div>`;
        }).join('');

        setWizRow('iphone', 'ok', `${devices.length} thiết bị đã kết nối`);
        const descEl = document.getElementById('req-iphone-desc');
        descEl.innerHTML = `${devices.length} thiết bị đã kết nối — chọn thiết bị muốn dùng:`;
        // Insert device list after desc
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
        setWizRow('iphone', 'warn', 'Vui lòng cắm iPhone vào máy tính.', true);
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
        // Auto-continue if everything is perfect
        if (wizIphoneOk && !document.getElementById('wizard').classList.contains('hidden-by-user')) {
            // wizardContinue(); // Optional: uncomment for fully silent start
        }
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
    log.textContent = 'Bắt đầu cài đặt...\n';
    progBar.style.width = '10%';

    electronAPI.onInstallProgress((data) => {
        log.textContent += data;
        log.scrollTop = log.scrollHeight;
        // Simple progress simulation based on log length
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
    log.textContent = 'Bắt đầu cài đặt Python...\n';
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

    // Reset steps for connecting animation
    setStepState('step-device', '');
    setStepState('step-tunnel', '');
    setStepState('step-worker', '');

    // Start connection flow
    startFullConnection();
}

function showWizard() {
    // Hide other full-screen pages first
    document.getElementById('connecting-page').classList.add('hidden');
    document.getElementById('layout').classList.add('hidden');
    document.getElementById('wizard').classList.remove('hidden');
    document.getElementById('wizard').classList.remove('hidden-by-user');
    checkWizardRequirements();
}

// ─── Setup Phase UI (Connecting Page) ─────────────────────────────────────────
function setStepState(id, state) { // state: '' | 'step-active' | 'step-done'
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
    // Leaflet cannot measure tile bounds while container is display:none.
    // Force a re-render after the element becomes visible.
    requestAnimationFrame(() => {
        if (map) map.invalidateSize();
    });
}

function markSetupDone() {
    const page = document.getElementById('connecting-page');
    if (!page || page.classList.contains('hidden')) return;
    document.getElementById('setup-title').textContent = '⚡ Sẵn sàng! Bấm bản đồ để dịch chuyển tức thì.';
    page.classList.add('fading');
    setTimeout(() => {
        page.classList.add('hidden');
        page.classList.remove('fading');
        revealLayout();
    }, 600);
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

// Auto-skip timer for connecting page
let connectingTimeout = null;

function clearConnectingTimeout() {
    if (connectingTimeout) { clearTimeout(connectingTimeout); connectingTimeout = null; }
}

function startConnectingTimeout(ms = 45000) {
    clearConnectingTimeout();
    connectingTimeout = setTimeout(() => {
        const page = document.getElementById('connecting-page');
        if (page && !page.classList.contains('hidden')) {
            document.getElementById('setup-hint').textContent =
                'Kết nối mất quá lâu. Chuyển sang chế độ thường...';
            setTimeout(skipSetup, 1500);
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
        document.getElementById('setup-hint').textContent =
            'Đang kết nối tunnel iOS... (lần đầu có thể mất 15–30 giây)';
        // Auto-dismiss if tunnel takes too long
        startConnectingTimeout(45000);
        setupTunnel(currentUdid);
    } else {
        setStepState('step-device', '');
        document.getElementById('setup-hint').textContent =
            'Không tìm thấy iPhone. Kiểm tra cáp USB và Trust trên máy.';
        showToast('Không tìm thấy thiết bị để kết nối.', 'error');
        setTimeout(() => {
            document.getElementById('connecting-page').classList.add('hidden');
            showWizard();
        }, 2500);
    }
}

function normalizeUserError(errorText) {
    const text = String(errorText || '');
    const lower = text.toLowerCase();
    if (lower.includes('requires admin privileges') || lower.includes('administrator')) {
        return 'Cần chạy app bằng Run as Administrator.';
    }
    if (lower.includes('device is not connected') || lower.includes('không thấy iphone online')) {
        return 'iPhone chưa kết nối ổn định. Mở khóa máy, bấm Trust rồi cắm lại USB.';
    }
    if (lower.includes('connection was terminated abruptly')) {
        return 'Kết nối với iPhone bị ngắt đột ngột. Giữ máy mở khóa và thử lại.';
    }
    if (lower.includes('mux 183') || lower.includes("number': 183") || lower.includes('number: 183')) {
        return 'Lỗi ghép cặp iPhone (Mux 183). Chạy app bằng Administrator và bấm Trust lại trên iPhone.';
    }
    return text || 'Không rõ lỗi';
}

function stopLocationKeepAlive() {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
    keepAliveInFlight = false;
    keepAliveFailureCount = 0;
}

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

function toRadians(deg) {
    return (deg * Math.PI) / 180;
}

function metersToLat(meters) {
    return meters / EARTH_METERS_PER_DEG_LAT;
}

function metersToLng(meters, atLat) {
    const scale = Math.cos(toRadians(atLat));
    if (Math.abs(scale) < 0.00001) return 0;
    return meters / (EARTH_METERS_PER_DEG_LAT * scale);
}

function distanceMeters(lat1, lng1, lat2, lng2) {
    const dLatM = (lat2 - lat1) * EARTH_METERS_PER_DEG_LAT;
    const avgLat = (lat1 + lat2) / 2;
    const dLngM = (lng2 - lng1) * EARTH_METERS_PER_DEG_LAT * Math.cos(toRadians(avgLat));
    return Math.hypot(dLatM, dLngM);
}

function moveByMeters(lat, lng, dxMeters, dyMeters) {
    return {
        lat: lat + metersToLat(dyMeters),
        lng: lng + metersToLng(dxMeters, lat),
    };
}

function nextNaturalSpoofPoint(pinned) {
    const centerLat = pinned.lat;
    const centerLng = pinned.lng;
    const currentLat = Number.isFinite(pinned.cursorLat) ? pinned.cursorLat : centerLat;
    const currentLng = Number.isFinite(pinned.cursorLng) ? pinned.cursorLng : centerLng;

    const angle = randomBetween(0, Math.PI * 2);
    const step = randomBetween(SPOOF_STEP_MIN_M, SPOOF_STEP_MAX_M);
    const dx = Math.cos(angle) * step;
    const dy = Math.sin(angle) * step;
    let next = moveByMeters(currentLat, currentLng, dx, dy);

    const dist = distanceMeters(centerLat, centerLng, next.lat, next.lng);
    if (dist > SPOOF_RADIUS_M) {
        const backRatio = (dist - SPOOF_RADIUS_M * 0.6) / Math.max(dist, 1);
        const pullDx = (centerLng - next.lng) * EARTH_METERS_PER_DEG_LAT * Math.cos(toRadians((centerLat + next.lat) / 2)) * backRatio;
        const pullDy = (centerLat - next.lat) * EARTH_METERS_PER_DEG_LAT * backRatio;
        next = moveByMeters(next.lat, next.lng, pullDx, pullDy);
    }

    return {
        lat: +next.lat.toFixed(6),
        lng: +next.lng.toFixed(6),
    };
}

function startLocationKeepAlive(lat, lng, udid) {
    pinnedLocation = { lat, lng, udid, cursorLat: lat, cursorLng: lng };
    localStorage.setItem(PINNED_LOCATION_KEY, JSON.stringify(pinnedLocation));
    stopLocationKeepAlive();
    keepAliveTimer = setInterval(async () => {
        if (!pinnedLocation || isTeleporting || keepAliveInFlight) return;
        const nextPoint = nextNaturalSpoofPoint(pinnedLocation);
        keepAliveInFlight = true;
        const result = await electronAPI.setLocation(nextPoint.lat, nextPoint.lng, pinnedLocation.udid);
        keepAliveInFlight = false;
        if (result.ok) {
            pinnedLocation.cursorLat = nextPoint.lat;
            pinnedLocation.cursorLng = nextPoint.lng;
            localStorage.setItem(PINNED_LOCATION_KEY, JSON.stringify(pinnedLocation));
            keepAliveFailureCount = 0;
            return;
        }
        keepAliveFailureCount += 1;
        if (keepAliveFailureCount === 3) {
            showToast('⚠ Kết nối giữ vị trí ảo không ổn định, app đang tự thử lại.', 'error');
        }
    }, KEEP_ALIVE_MS);
}

// ─── Map init ─────────────────────────────────────────────────────────────
function initMap() {
    const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
    const satelliteLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google' });

    map = L.map('map', {
        center: [16.047, 108.206],
        zoom: 6,
        zoomControl: false,
        attributionControl: false,
        layers: [streetLayer]
    });
    
    L.control.attribution({ position: 'bottomright', prefix: false }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    
    // Custom layer toggles
    document.getElementById('btn-layer-street').onclick = () => {
        map.addLayer(streetLayer);
        map.removeLayer(satelliteLayer);
        document.getElementById('btn-layer-street').classList.add('active');
        document.getElementById('btn-layer-satellite').classList.remove('active');
    };
    document.getElementById('btn-layer-satellite').onclick = () => {
        map.addLayer(satelliteLayer);
        map.removeLayer(streetLayer);
        document.getElementById('btn-layer-satellite').classList.add('active');
        document.getElementById('btn-layer-street').classList.remove('active');
    };
    
    map.on('click', onMapClick);

    const saved = sessionStorage.getItem('bh-last-loc');
    if (saved) {
        try {
            const { lat, lng, place } = JSON.parse(saved);
            selectLocation(lat, lng, place, false);
            map.setView([lat, lng], 14);
        } catch { }
    } else {
        // Tự động lấy vị trí hiện tại (PC/Wifi) giống Google Maps khi mới mở app
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const lat = pos.coords.latitude;
                    const lng = pos.coords.longitude;
                    map.setView([lat, lng], 15, { animate: true });
                    
                    // Thêm một marker nhỏ biểu diễn vị trí hiện tại của PC
                    const pcIcon = L.divIcon({
                        className: '',
                        html: `<div style="
                            width:16px;height:16px;border-radius:50%;
                            background:rgba(34,197,94,0.3);
                            border:2px solid #22c55e;
                            box-shadow:0 0 8px rgba(34,197,94,0.4);
                            position:relative;
                        "><div style="
                            position:absolute;inset:3px;border-radius:50%;
                            background:#22c55e;
                        "></div></div>`,
                        iconSize: [16, 16],
                        iconAnchor: [8, 8],
                    });
                    L.marker([lat, lng], { icon: pcIcon })
                        .bindTooltip('Vị trí hiện tại của bạn', { permanent: false, direction: 'top' })
                        .addTo(map);
                },
                (err) => {
                    console.log("Không thể lấy vị trí PC: ", err);
                },
                { enableHighAccuracy: true, timeout: 5000 }
            );
        }
    }
}

function onMapClick(e) {
    selectLocation(e.latlng.lat, e.latlng.lng, '', true);
    reverseGeocode(e.latlng.lat, e.latlng.lng);
}

function selectLocation(lat, lng, place, fromClick) {
    selectedLat = +lat.toFixed(6);
    selectedLng = +lng.toFixed(6);
    selectedPlace = place || '';
    document.getElementById('disp-lat').textContent = selectedLat.toFixed(6);
    document.getElementById('disp-lng').textContent = selectedLng.toFixed(6);
    document.getElementById('btn-teleport').disabled = false;
    document.getElementById('map-tip').style.opacity = '0';

    if (selectedMarker) map.removeLayer(selectedMarker);
    const icon = L.divIcon({
        className: '',
        html: `<div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#6366f1);border:3px solid #fff;box-shadow:0 2px 12px rgba(59,130,246,.6);position:relative;display:flex;align-items:center;justify-content:center;"><div class="marker-pulse"></div></div>`,
        iconSize: [24, 24], iconAnchor: [12, 12],
    });
    selectedMarker = L.marker([lat, lng], { icon }).addTo(map);
    if (fromClick) sessionStorage.setItem('bh-last-loc', JSON.stringify({ lat, lng, place }));
}

async function reverseGeocode(lat, lng) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=vi`, { headers: { 'User-Agent': 'BraveHoang-GPS-Spoofer/1.0' } });
        const data = await res.json();
        const place = data.display_name || '';
        selectedPlace = place;
        const placeEl = document.getElementById('disp-place');
        const placeRow = document.getElementById('place-row');
        placeEl.textContent = place.split(',').slice(0, 3).join(', ');
        placeRow.style.display = '';
        sessionStorage.setItem('bh-last-loc', JSON.stringify({ lat, lng, place }));
    } catch { }
}

// ─── Search ───────────────────────────────────────────────────────────────
let searchTimer;
const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', e => {
    // Check native isComposing flag (handles most modern IMEs)
    if (e.isComposing) return;
    
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    
    if (q.length < 2) { 
        closeSearch(); 
        return; 
    }
    
    // Increased debounce to 600ms to give Vietnamese IMEs (Unikey/Telex) 
    // more time to finalize characters if isComposing isn't perfectly reported.
    searchTimer = setTimeout(() => {
        if (searchInput.value.trim() === q) {
            doSearch(q);
        }
    }, 600);
});

// Also trigger search on 'Enter' to finalize immediately
searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        const q = searchInput.value.trim();
        if (q.length >= 2) {
            clearTimeout(searchTimer);
            doSearch(q);
        }
    }
    if (e.key === 'Escape') closeSearch();
});
async function doSearch(q) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&accept-language=vi&countrycodes=vn`, { headers: { 'User-Agent': 'BraveHoang-GPS-Spoofer/1.0' } });
        const data = await res.json();
        renderSearch(data);
    } catch { closeSearch(); }
}
function renderSearch(results) {
    const box = document.getElementById('search-results');
    if (!results.length) { box.classList.add('hidden'); return; }
    box.innerHTML = results.map((r, i) => `<div class="search-item" data-i="${i}"><div>${r.display_name.split(',')[0]}</div><div class="search-item-sub">${r.display_name.split(',').slice(1, 3).join(',').trim()}</div></div>`).join('');
    box.classList.remove('hidden');
    results.forEach((r, i) => {
        box.querySelector(`[data-i="${i}"]`).onclick = () => {
            map.setView([+r.lat, +r.lon], 14, { animate: true });
            selectLocation(+r.lat, +r.lon, r.display_name, true);
            reverseGeocode(+r.lat, +r.lon);
            closeSearch();
            document.getElementById('search-input').value = r.display_name.split(',')[0];
        };
    });
}
function closeSearch() { document.getElementById('search-results').classList.add('hidden'); }
document.addEventListener('click', e => { if (!document.getElementById('search-bar').contains(e.target)) closeSearch(); });

// ─── Device detection ──────────────────────────────────────────────────────────
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
        document.getElementById('device-cards').innerHTML =
            '<div class="device-empty">Chưa kết nối thiết bị nào</div>';
        if (tunnelStatus.status === 'ready') {
            tunnelStatus = { status: 'idle', host: null, port: null, udid: null, error: null };
            updateTunnelBadge();
        }
        return;
    }

    dot.className = 'status-dot dot-ok';
    label.textContent = `${devices.length} thiết bị`;

    // Build rich device cards
    const cardsHtml = devices.map((d, i) => {
        const shortUdid = d.udid.slice(0, 8) + '...' + d.udid.slice(-4);
        const connLabel = d.connectionType === 'WiFi' ? '📶 WiFi' : '🔌 USB';
        const connCls   = d.connectionType === 'WiFi' ? 'conn-wifi' : 'conn-usb';
        const isActive  = d.udid === currentUdid || (i === 0 && !currentUdid);
        return `<div class="device-card${isActive ? ' active' : ''}" data-udid="${d.udid}" id="dcard-${i}" onclick="selectDeviceCard('${d.udid}')">
            <div class="device-card-name">${d.name || 'iPhone'}</div>
            <div class="device-card-meta">
                <span class="conn-badge ${connCls}">${connLabel}</span>
                <span class="udid-tag" title="${d.udid}">${shortUdid}</span>
            </div>
        </div>`;
    }).join('');
    document.getElementById('device-cards').innerHTML = cardsHtml;

    // Keep select in sync (hidden, but used by change listener)
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
    document.querySelectorAll('.device-card').forEach(c => c.classList.remove('active'));
    const card = document.querySelector(`.device-card[data-udid="${udid}"]`);
    if (card) card.classList.add('active');
    document.getElementById('device-select').value = udid;
    setupTunnel(udid);
}
window.selectDeviceCard = selectDeviceCard;

document.getElementById('device-select').addEventListener('change', e => {
    currentUdid = e.target.value;
    setupTunnel(currentUdid);
});

document.getElementById('btn-refresh').onclick = () => {
    refreshDevices();
    showToast('Đang làm mới danh sách...', 'info');
};

// ─── Persistent Tunnel ────────────────────────────────────────────────────
function updateTunnelBadge() {
    const badge = document.getElementById('tunnel-badge');
    if (!badge) return;
    const s = tunnelStatus.status;
    if (s === 'ready') { badge.className = 'tunnel-badge tunnel-ready'; badge.textContent = '⚡ Tunnel sẵn sàng'; }
    else if (s === 'connecting') { badge.className = 'tunnel-badge tunnel-connecting'; badge.textContent = '⏳ Đang kết nối tunnel...'; }
    else if (s === 'error') { badge.className = 'tunnel-badge tunnel-error'; badge.textContent = '⚠ Tunnel lỗi'; }
    else { badge.className = 'tunnel-badge tunnel-idle'; badge.textContent = '○ Tunnel chưa kết nối'; }
}

async function setupTunnel(udid) {
    if (tunnelSetupInProgress || !udid) return;
    // Skip if already ready for the same device
    if (tunnelStatus.status === 'ready' && tunnelStatus.udid === udid) return;
    tunnelSetupInProgress = true;
    tunnelStatus = { ...tunnelStatus, status: 'connecting' };
    updateTunnelBadge();
    try {
        const result = await electronAPI.setupTunnel(udid);
        tunnelStatus = result.ok
            ? { status: 'ready', host: result.host, port: result.port, udid, error: null }
            : { status: 'error', host: null, port: null, udid, error: result.error };
    } catch (e) {
        tunnelStatus = { status: 'error', host: null, port: null, udid, error: e.message };
    } finally {
        tunnelSetupInProgress = false;
        updateTunnelBadge();
    }
}

electronAPI.onTunnelStatus((data) => {
    tunnelStatus = data;
    updateTunnelBadge();
    if (data.status === 'ready') {
        clearConnectingTimeout();
        setStepState('step-tunnel', 'step-done');
        setStepState('step-worker', 'step-active');
        document.getElementById('setup-hint').textContent =
            'Tunnel kết nối thành công! Đang khởi động worker dịch chuyển tức thì...';
    } else if (data.status === 'error') {
        setStepState('step-tunnel', '');
        const page = document.getElementById('connecting-page');
        if (page && !page.classList.contains('hidden')) {
            const errMsg = data.error || 'Không rõ lỗi';
            document.getElementById('setup-hint').textContent =
                `Tunnel thất bại: ${errMsg.slice(0, 80)}. Chuyển sang chế độ thường...`;
            clearConnectingTimeout();
            setTimeout(skipSetup, 3000);
        }
    }
});

electronAPI.onWorkerReady(() => {
    clearConnectingTimeout();
    workerReady = true;
    setStepState('step-worker', 'step-done');
    markSetupDone();
    updateTunnelBadge();
    showToast('⚡ Chế độ tức thì đã sẵn sàng!', 'success');
});

// ─── Teleport ─────────────────────────────────────────────────────────────
document.getElementById('btn-teleport').onclick = async () => {
    if (selectedLat === null) return;

    // INSTANT MODE: worker ready → fire-and-forget, no overlay
    if (workerReady) {
        startLocationKeepAlive(selectedLat, selectedLng, currentUdid);
        addHistory(selectedLat, selectedLng, selectedPlace);
        electronAPI.setLocation(selectedLat, selectedLng, currentUdid).then(result => {
            if (result.ok) showToast('⚡ Đã dịch chuyển!', 'success');
            else {
                showToast(`❌ Lỗi: ${normalizeUserError(result.error)}`, 'error');
                workerReady = false;
                updateTunnelBadge();
            }
        });
        return;
    }

    // SLOW PATH
    if (isTeleporting) return;
    isTeleporting = true;
    const btnTp = document.getElementById('btn-teleport');
    btnTp.disabled = true;
    showOverlay('Đang dịch chuyển...');
    const result = await electronAPI.setLocation(selectedLat, selectedLng, currentUdid);
    hideOverlay();
    if (result.ok) {
        startLocationKeepAlive(selectedLat, selectedLng, currentUdid);
        showToast('✅ Thành công!', 'success');
        addHistory(selectedLat, selectedLng, selectedPlace);
    } else {
        showToast(`❌ Lỗi: ${normalizeUserError(result.error)}`, 'error');
    }
    isTeleporting = false;
    btnTp.disabled = false;
};

// ─── History ──────────────────────────────────────────────────────────────
function addHistory(lat, lng, place) {
    const item = { lat, lng, place: place ? place.split(',').slice(0, 2).join(',').trim() : `${lat}, ${lng}`, time: Date.now() };
    history = [item, ...history.filter(h => !(Math.abs(h.lat - lat) < 0.001 && Math.abs(h.lng - lng) < 0.001))].slice(0, 20);
    localStorage.setItem('bh-gps-history', JSON.stringify(history));
    renderHistory();
}
function renderHistory() {
    const list = document.getElementById('history-list');
    if (!history.length) { list.innerHTML = '<div class="empty-hint">Chưa có lịch sử</div>'; return; }
    list.innerHTML = history.map((h, i) => `<div class="history-item" data-i="${i}"><span class="history-icon">📍</span><div class="history-info"><div class="history-place">${h.place}</div><div class="history-coords">${h.lat.toFixed(4)}, ${h.lng.toFixed(4)}</div></div><button class="history-del" data-del="${i}">✕</button></div>`).join('');
    list.querySelectorAll('.history-item').forEach(el => {
        const i = +el.dataset.i;
        el.onclick = (e) => { if (e.target.matches('.history-del')) return; const h = history[i]; map.setView([h.lat, h.lng], 14, { animate: true }); selectLocation(h.lat, h.lng, h.place, true); };
        el.querySelector('.history-del').onclick = () => { history.splice(i, 1); localStorage.setItem('bh-gps-history', JSON.stringify(history)); renderHistory(); };
    });
}
document.getElementById('btn-clear-history').onclick = () => { history = []; localStorage.setItem('bh-gps-history', '[]'); renderHistory(); };

// ─── UI helpers ───────────────────────────────────────────────────────────
function showOverlay(text) { document.getElementById('overlay-text').textContent = text; document.getElementById('map-overlay').classList.remove('hidden'); }
function hideOverlay() { document.getElementById('map-overlay').classList.add('hidden'); }
let toastTimer;
function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast'); toast.textContent = msg; toast.className = `show ${type}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.className = ''; }, 3000);
}
document.getElementById('btn-min').onclick   = () => electronAPI.minimize();
document.getElementById('btn-max').onclick   = () => electronAPI.maximize();
// ─── Wi-Fi Modal ────────────────────────────────────────────────────────
function closeWifiModal() {
    document.getElementById('wifi-modal').classList.add('hidden');
}

async function scanWifi() {
    const btn = document.getElementById('btn-scan-wifi');
    const tbody = document.getElementById('wifi-table-body');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon">⏳</span> Đang quét...';
    tbody.innerHTML = '<tr><td colspan="4" class="wifi-empty">Đang tìm kiếm thiết bị trên mạng...</td></tr>';
    
    try {
        const result = await electronAPI.scanWifi();
        if (result.ok) {
            const devices = result.devices;
            if (!devices || devices.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="wifi-empty">Không tìm thấy thiết bị nào. Hãy kiểm tra kết nối Wi-Fi.</td></tr>';
            } else {
                tbody.innerHTML = devices.map((d, i) => {
                    const host = d.host || d.address || d.ip || 'Unknown';
                    const port = d.port || 'Unknown';
                    const udid = d.udid || d.SerialNumber || 'Unknown';
                    const name = d.name || d.DeviceName || d.ProductType || 'iPhone';
                    const shortUdid = udid.length > 10 ? udid.slice(0,8) + '...' : udid;
                    return `
                        <tr>
                            <td><strong>${name}</strong></td>
                            <td>${host}:${port}</td>
                            <td title="${udid}"><span class="udid-tag">${shortUdid}</span></td>
                            <td>
                                <button class="btn-connect-wifi" onclick="connectWifi('${udid}', '${name}')">Kết nối</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        } else {
            tbody.innerHTML = `<tr><td colspan="4" class="wifi-empty" style="color: #ef4444 !important;">Lỗi: ${result.error}</td></tr>`;
        }
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="wifi-empty" style="color: #ef4444 !important;">Lỗi: ${e.message}</td></tr>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">↻</span> Quét mạng';
    }
}

function connectWifi(udid, name) {
    showToast(`Đang kết nối tới ${name}...`, 'info');
    closeWifiModal();
    // Simulate selection and connect
    currentUdid = udid;
    // Append to select if not exist
    const sel = document.getElementById('device-select');
    if (!Array.from(sel.options).some(o => o.value === udid)) {
        const opt = document.createElement('option');
        opt.value = udid;
        opt.text = name;
        sel.add(opt);
    }
    sel.value = udid;
    setupTunnel(udid);
}

document.getElementById('btn-close').onclick = () => electronAPI.close();
window.openUrl = (url) => electronAPI.openUrl(url);
window.wizardInstallPmd = wizardInstallPmd;
window.wizardInstallPython = wizardInstallPython;
window.wizardRefreshIphone = wizardRefreshIphone;
window.wizardContinue = wizardContinue;
window.showWizard = showWizard;
window.closeWifiModal = closeWifiModal;
window.scanWifi = scanWifi;
window.connectWifi = connectWifi;

// ─── Boot ─────────────────────────────────────────────────────────────────
async function init() {
    initMap();
    renderHistory();

    // Requirements Check — decide which page to show first
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

    // Resume pinned keep-alive ONLY after the main layout becomes visible
    // to avoid hammering setLocation before tunnel is ready.
    // We listen for the layout becoming visible (either via markSetupDone or skipSetup).
    const resumePinned = () => {
        try {
            const savedPinned = JSON.parse(localStorage.getItem(PINNED_LOCATION_KEY) || 'null');
            if (savedPinned && Number.isFinite(savedPinned.lat) && Number.isFinite(savedPinned.lng)) {
                if (savedPinned.udid) currentUdid = savedPinned.udid;
                if (!Number.isFinite(savedPinned.cursorLat)) savedPinned.cursorLat = savedPinned.lat;
                if (!Number.isFinite(savedPinned.cursorLng)) savedPinned.cursorLng = savedPinned.lng;
                startLocationKeepAlive(savedPinned.lat, savedPinned.lng, savedPinned.udid || currentUdid);
                showToast('🔒 Đang giữ vị trí ảo đã ghim.', 'info');
            }
        } catch { }
    };

    // Watch for layout visibility
    const layoutObserver = new MutationObserver(() => {
        const layout = document.getElementById('layout');
        if (!layout.classList.contains('hidden')) {
            layoutObserver.disconnect();
            resumePinned();
            fetchAndShowIphoneLocation();
        }
    });
    layoutObserver.observe(document.getElementById('layout'), { attributes: true, attributeFilter: ['class'] });

    // Fallback: if layout is already visible (e.g. wizard skipped instantly)
    if (!document.getElementById('layout').classList.contains('hidden')) {
        layoutObserver.disconnect();
        resumePinned();
        fetchAndShowIphoneLocation();
    }

    // Helper to fetch location when map is actually visible
    function fetchAndShowIphoneLocation() {
        if (workerReady) {
            electronAPI.getIphoneLocation().then(result => {
                if (result && result.ok && result.lat && result.lng) {
                    const lat = result.lat;
                    const lng = result.lng;
                    if (map) {
                        map.invalidateSize();
                        map.setView([lat, lng], 15, { animate: true });
                        const iphoneIcon = L.divIcon({
                            className: '',
                            html: `<div style="
                                width:18px;height:18px;border-radius:50%;
                                background:rgba(59,130,246,0.25);
                                border:3px solid #3b82f6;
                                box-shadow:0 0 0 6px rgba(59,130,246,0.15);
                                position:relative;
                            "><div style="
                                position:absolute;inset:3px;border-radius:50%;
                                background:#3b82f6;
                            "></div></div>`,
                            iconSize: [18, 18],
                            iconAnchor: [9, 9],
                        });
                        L.marker([lat, lng], { icon: iphoneIcon })
                            .bindTooltip('📱 Vị trí iPhone', { permanent: false, direction: 'top' })
                            .addTo(map);
                        showToast(`📍 Vị trí iPhone: ${lat.toFixed(5)}, ${lng.toFixed(5)}`, 'success');
                    }
                }
            }).catch(() => {});
        }
    }

    setInterval(refreshDevices, 5000);
}
init();

