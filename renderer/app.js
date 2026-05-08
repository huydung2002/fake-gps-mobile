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

function startLocationKeepAlive(lat, lng, udid) {
    pinnedLocation = { lat, lng, udid };
    localStorage.setItem(PINNED_LOCATION_KEY, JSON.stringify(pinnedLocation));
    stopLocationKeepAlive();
    keepAliveTimer = setInterval(async () => {
        if (!pinnedLocation || isTeleporting || keepAliveInFlight) return;
        keepAliveInFlight = true;
        const result = await electronAPI.setLocation(pinnedLocation.lat, pinnedLocation.lng, pinnedLocation.udid);
        keepAliveInFlight = false;
        if (result.ok) {
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
    map = L.map('map', {
        center: [16.047, 108.206], // Đà Nẵng (trung tâm Việt Nam)
        zoom: 6,
        zoomControl: false,
        attributionControl: false,
    });

    // OSM tile layer - chi tiết như Google Maps
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
    }).addTo(map);

    // Attribution nhỏ
    L.control.attribution({ position: 'bottomright', prefix: false }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Click handler
    map.on('click', onMapClick);

    // Restore previous marker if any
    const saved = sessionStorage.getItem('bh-last-loc');
    if (saved) {
        try {
            const { lat, lng, place } = JSON.parse(saved);
            selectLocation(lat, lng, place, false);
        } catch { }
    }
}

// ─── Click map ────────────────────────────────────────────────────────────
function onMapClick(e) {
    selectLocation(e.latlng.lat, e.latlng.lng, '', true);
    // Reverse geocode
    reverseGeocode(e.latlng.lat, e.latlng.lng);
}

function selectLocation(lat, lng, place, fromClick) {
    selectedLat = +lat.toFixed(6);
    selectedLng = +lng.toFixed(6);
    selectedPlace = place || '';

    // Update display
    document.getElementById('disp-lat').textContent = selectedLat.toFixed(6);
    document.getElementById('disp-lng').textContent = selectedLng.toFixed(6);
    document.getElementById('btn-teleport').disabled = false;
    document.getElementById('map-tip').style.opacity = '0';

    // Marker
    if (selectedMarker) map.removeLayer(selectedMarker);
    const icon = L.divIcon({
        className: '',
        html: `<div style="
            width:24px;height:24px;border-radius:50%;
            background:linear-gradient(135deg,#3b82f6,#6366f1);
            border:3px solid #fff;
            box-shadow:0 2px 12px rgba(59,130,246,.6);
            position:relative;
            display:flex;align-items:center;justify-content:center;
        ">
            <div class="marker-pulse"></div>
        </div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
    });
    selectedMarker = L.marker([lat, lng], { icon }).addTo(map);

    if (fromClick) {
        sessionStorage.setItem('bh-last-loc', JSON.stringify({ lat, lng, place }));
    }
}

async function reverseGeocode(lat, lng) {
    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=vi`,
            { headers: { 'User-Agent': 'BraveHoang-GPS-Spoofer/1.0' } }
        );
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
document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) {
        closeSearch();
        return;
    }
    searchTimer = setTimeout(() => doSearch(q), 400);
});

document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSearch();
});

async function doSearch(q) {
    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&accept-language=vi&countrycodes=vn`,
            { headers: { 'User-Agent': 'BraveHoang-GPS-Spoofer/1.0' } }
        );
        const data = await res.json();
        renderSearch(data);
    } catch { closeSearch(); }
}

function renderSearch(results) {
    const box = document.getElementById('search-results');
    if (!results.length) { box.classList.add('hidden'); return; }
    box.innerHTML = results.map((r, i) => `
        <div class="search-item" data-i="${i}">
            <div>${r.display_name.split(',')[0]}</div>
            <div class="search-item-sub">${r.display_name.split(',').slice(1, 3).join(',').trim()}</div>
        </div>
    `).join('');
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

function closeSearch() {
    document.getElementById('search-results').classList.add('hidden');
}

document.addEventListener('click', e => {
    if (!document.getElementById('search-bar').contains(e.target)) closeSearch();
});

// ─── Device detection ─────────────────────────────────────────────────────
async function refreshDevices() {
    if (isTeleporting) return;
    const dot = document.getElementById('device-dot');
    const label = document.getElementById('device-label');
    const sel = document.getElementById('device-select');

    dot.className = 'status-dot dot-waiting';
    label.textContent = 'Đang tìm thiết bị...';

    const { ok, devices } = await electronAPI.getDevices();

    if (!ok || !devices.length) {
        dot.className = 'status-dot dot-error';
        label.textContent = 'Chưa kết nối thiết bị';
        sel.classList.add('hidden');
        return;
    }

    dot.className = 'status-dot dot-ok';
    label.textContent = `${devices.length} thiết bị`;

    sel.innerHTML = devices.map(d =>
        `<option value="${d.udid}">${d.name} — ${d.udid.slice(0, 8)}…</option>`
    ).join('');
    sel.classList.remove('hidden');
    currentUdid = devices[0].udid;
}

async function checkTool() {
    const badge = document.getElementById('tool-status');
    const btnInstall = document.getElementById('btn-install');
    const { tool } = await electronAPI.detectTool();
    if (tool) {
        badge.className = 'tool-badge tool-ok';
        badge.textContent = '✓ ' + tool;
        btnInstall.classList.add('hidden');
    } else {
        badge.className = 'tool-badge tool-error';
        badge.textContent = '✕ Chưa cài công cụ';
        btnInstall.classList.remove('hidden');
    }
    return tool;
}

// Install button
document.getElementById('btn-install').onclick = async () => {
    const btn = document.getElementById('btn-install');
    const log = document.getElementById('install-log');
    btn.disabled = true;
    btn.textContent = '⏳ Đang cài...';
    log.classList.remove('hidden');
    log.textContent = '';

    // Check Python first
    const { py } = await electronAPI.getPython();
    if (!py) {
        log.textContent = '❌ Chưa cài Python!\nTải tại: https://python.org/downloads\nSau đó khởi động lại app.';
        btn.textContent = '❌ Cần cài Python trước';
        btn.disabled = false;
        return;
    }

    log.textContent += `✓ Tìm thấy Python: ${py}\n`;
    electronAPI.onInstallProgress((data) => {
        log.textContent += data;
        log.scrollTop = log.scrollHeight;
    });

    const result = await electronAPI.installTool();
    if (result.ok) {
        log.textContent += '\n✅ Cài thành công!';
        showToast('✅ Cài pymobiledevice3 thành công!', 'success');
        await checkTool();
        await refreshDevices();
    } else {
        log.textContent += `\n❌ Lỗi: ${result.message || 'Không rõ'}`;
        showToast('❌ Cài thất bại. Xem log bên dưới.', 'error');
        btn.textContent = '↻ Thử lại';
        btn.disabled = false;
    }
};

document.getElementById('device-select').addEventListener('change', e => {
    currentUdid = e.target.value;
    if (pinnedLocation) {
        pinnedLocation.udid = currentUdid;
        localStorage.setItem(PINNED_LOCATION_KEY, JSON.stringify(pinnedLocation));
    }
});

document.getElementById('btn-refresh').onclick = () => {
    if (isTeleporting) return;
    refreshDevices();
    checkTool();
};



// ─── Teleport ─────────────────────────────────────────────────────────────
document.getElementById('btn-teleport').onclick = async () => {
    if (selectedLat === null || isTeleporting) return;
    isTeleporting = true;
    document.getElementById('btn-teleport').disabled = true;
    document.getElementById('btn-refresh').disabled = true;
    showOverlay('Đang dịch chuyển...');
    const result = await electronAPI.setLocation(selectedLat, selectedLng, currentUdid);
    hideOverlay();

    if (result.ok) {
        startLocationKeepAlive(selectedLat, selectedLng, currentUdid);
        showToast('✅ Đã dịch chuyển thành công (đang giữ vị trí ảo).', 'success');
        addHistory(selectedLat, selectedLng, selectedPlace);
    } else {
        if (result.error === 'no_tool') {
            showToast('❌ Chưa cài công cụ. Xem hướng dẫn bên trái.', 'error');
        } else {
            showToast(`❌ Lỗi: ${normalizeUserError(result.error)}`, 'error');
        }
    }
    isTeleporting = false;
    document.getElementById('btn-teleport').disabled = false;
    document.getElementById('btn-refresh').disabled = false;
    refreshDevices();
};

document.getElementById('btn-reset').onclick = async () => {
    stopLocationKeepAlive();
    pinnedLocation = null;
    localStorage.removeItem(PINNED_LOCATION_KEY);
    showOverlay('Đang đặt lại vị trí...');
    const result = await electronAPI.resetLocation(currentUdid);
    hideOverlay();
    if (result.ok) showToast('✅ Đã đặt lại vị trí gốc', 'success');
    else showToast('❌ Không thể đặt lại. Thử tắt ứng dụng.', 'error');
};

// ─── History ──────────────────────────────────────────────────────────────
function addHistory(lat, lng, place) {
    const item = {
        lat, lng,
        place: place ? place.split(',').slice(0, 2).join(',').trim() : `${lat}, ${lng}`,
        time: Date.now()
    };
    history = [item, ...history.filter(h => !(Math.abs(h.lat - lat) < 0.001 && Math.abs(h.lng - lng) < 0.001))].slice(0, 20);
    localStorage.setItem('bh-gps-history', JSON.stringify(history));
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById('history-list');
    if (!history.length) {
        list.innerHTML = '<div class="empty-hint">Chưa có lịch sử</div>';
        return;
    }
    list.innerHTML = history.map((h, i) => `
        <div class="history-item" data-i="${i}">
            <span class="history-icon">📍</span>
            <div class="history-info">
                <div class="history-place">${h.place}</div>
                <div class="history-coords">${h.lat.toFixed(4)}, ${h.lng.toFixed(4)}</div>
            </div>
            <button class="history-del" data-del="${i}">✕</button>
        </div>
    `).join('');

    list.querySelectorAll('.history-item').forEach(el => {
        const i = +el.dataset.i;
        el.onclick = (e) => {
            if (e.target.matches('.history-del')) return;
            const h = history[i];
            map.setView([h.lat, h.lng], 14, { animate: true });
            selectLocation(h.lat, h.lng, h.place, true);
        };
        el.querySelector('.history-del').onclick = () => {
            history.splice(i, 1);
            localStorage.setItem('bh-gps-history', JSON.stringify(history));
            renderHistory();
        };
    });
}

document.getElementById('btn-clear-history').onclick = () => {
    history = [];
    localStorage.setItem('bh-gps-history', '[]');
    renderHistory();
};

// ─── UI helpers ───────────────────────────────────────────────────────────
function showOverlay(text) {
    document.getElementById('overlay-text').textContent = text;
    document.getElementById('map-overlay').classList.remove('hidden');
}
function hideOverlay() {
    document.getElementById('map-overlay').classList.add('hidden');
}

let toastTimer;
function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = `show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = ''; }, 3000);
}

// ─── Title bar ────────────────────────────────────────────────────────────
document.getElementById('btn-min').onclick   = () => electronAPI.minimize();
document.getElementById('btn-max').onclick   = () => electronAPI.maximize();
document.getElementById('btn-close').onclick = () => electronAPI.close();

// ─── Guide link ───────────────────────────────────────────────────────────
function openUrl(url) { electronAPI.openUrl(url); }
window.openUrl = openUrl;

// ─── Boot ─────────────────────────────────────────────────────────────────
async function init() {
    initMap();
    renderHistory();
    await Promise.all([refreshDevices(), checkTool()]);

    // Resume pinned fake location keep-alive if app was restarted.
    try {
        const savedPinned = JSON.parse(localStorage.getItem(PINNED_LOCATION_KEY) || 'null');
        if (savedPinned && Number.isFinite(savedPinned.lat) && Number.isFinite(savedPinned.lng)) {
            if (savedPinned.udid) currentUdid = savedPinned.udid;
            startLocationKeepAlive(savedPinned.lat, savedPinned.lng, savedPinned.udid || currentUdid);
            showToast('🔒 Đang tự giữ vị trí ảo đã ghim trước đó.', 'info');
        }
    } catch { }

    // Auto-refresh devices every 5s
    deviceRefreshTimer = setInterval(() => {
        refreshDevices();
    }, 5000);
}

init();
