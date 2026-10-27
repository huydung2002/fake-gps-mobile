# 📍 iOS GPS Pro by BraveHoang (v1.0.3)

> Ứng dụng Desktop (Electron) giả lập và điều khiển định vị GPS cho iPhone/iPad kết nối máy tính qua cáp USB hoặc Wi-Fi. 
> **Phiên bản mới nhất:** Hoạt động hoàn toàn **không cần quyền Administrator Windows (Zero-Admin)**, tích hợp ảnh vệ tinh Google Maps có đầy đủ tên đường tiếng Việt, hỗ trợ nhận diện tọa độ DMS và mô phỏng lộ trình thực tế chống phát hiện.

---

## 🌟 1. Các tính năng nổi bật (Features)

1. **⚡ Zero-Admin Architecture (Không cần quyền Admin Windows)**:
   - Sử dụng **Userspace RSD Tunnel** trực tiếp trong tiến trình (`location_worker.py`) kết nối qua giao thức socket USB native của Apple.
   - **Không cần** cài driver ảo Wintun/TAP, **không cần** chạy `Run as Administrator`, không can thiệp sâu vào card mạng Windows.
   - Tự động phát hiện thiết bị và kết nối chỉ trong **3 - 5 giây**.

2. **🌍 Bản đồ vệ tinh Google Maps Hybrid chuẩn tiếng Việt**:
   - Sử dụng lớp vệ tinh độ nét cao của Google Maps tích hợp lớp phủ tên đường, phường/xã, quận/huyện, tỉnh/thành phố và địa danh (POI) sắc nét bằng tiếng Việt.
   - Hỗ trợ chuyển đổi nhanh 3 chế độ xem: `🌍 Vệ tinh (Google)`, `🗺️ Đường phố (Google)`, `🌐 OpenStreetMap`.

3. **🧭 Nhận diện & Dịch chuyển tọa độ thông minh (DMS & Thập phân)**:
   - Dán trực tiếp tọa độ định dạng Độ - Phút - Giây (DMS): ví dụ `21°01'56.3"N 105°50'08.4"E`.
   - Dán tọa độ thập phân: `21.032306, 105.835667` hoặc link chia sẻ từ Google Maps (`https://maps.google.com/?q=...`).
   - Có thể dán tại **Thanh tìm kiếm trên cùng** hoặc ô **Nhập tọa độ nhanh** ở Sidebar bên trái.

4. **📍 Xem trước vị trí trước khi dịch chuyển (Preview Confirmation)**:
   - Khi click lên bản đồ hoặc dán tọa độ: Ứng dụng cắm cọc ghim (Marker) và mở bảng Popup hiển thị chi tiết tên địa chỉ tiếng Việt + tọa độ Lat/Lng.
   - **Chỉ dịch chuyển khi bạn bấm nút xác nhận**: Bấm `🚀 Dịch chuyển tới đây` trên bảng Popup hoặc `🚀 Dịch chuyển vị trí` ở thanh Sidebar. Tránh tình trạng dịch chuyển nhầm vị trí.

5. **🔤 Gõ tiếng Việt có dấu mượt mà (Unikey / EVKey / Telex)**:
   - Xử lý bắt trọn sự kiện IME (`compositionstart` / `compositionend`), khắc phục triệt để lỗi nuốt dấu, mất chữ hay gián đoạn con trỏ khi gõ tiếng Việt.
   - Nâng cấp bộ máy tìm kiếm với **Photon Geocoder** (hỗ trợ tìm kiếm mờ tiếng Việt theo bán kính vị trí bản đồ hiện tại) và fallback OpenStreetMap Nominatim.

6. **🛣️ Mô phỏng lộ trình di chuyển (Route Navigation A → B)**:
   - Chọn điểm A (xuất phát) và B (đích đến) trực tiếp trên bản đồ.
   - Tự động vẽ lộ trình thực tế bám theo đường bộ bằng thuật toán **OSRM**.
   - Điều chỉnh tốc độ tùy thích (Đi bộ `3.6 km/h`, Xe đạp `15 km/h`, Xe máy `45 km/h`, Ô tô `80 km/h`...).
   - **Tính năng Anti-ban (Speed Jitter)**: Tự động biến thiên vận tốc ngẫu nhiên (±10%) như người lái xe thực tế để chống thuật toán phát hiện gian lận của game/ứng dụng.

7. **🕹️ Joystick điều khiển ảo (WASD & Phím mũi tên)**:
   - Di chuyển GPS theo thời gian thực bằng các phím `W`, `A`, `S`, `D` hoặc các phím mũi tên trên bàn phím.
   - Phù hợp chơi game AR (Pokémon GO, Monster Hunter Now...) hoặc test ứng dụng giao hàng/đặt xe.

8. **🔄 Khôi phục GPS thật (Reset Location)**:
   - Bấm nút `🔄 Khôi phục GPS thật` ở đầu thanh bên để xóa session giả lập và trả lại định vị vệ tinh GPS gốc của iPhone ngay lập tức.

9. **⏱️ Bộ tính thời gian chờ an toàn (Cooldown Calculator)**:
   - Tự động đo khoảng cách đường chim bay giữa điểm fake trước và điểm fake mới.
   - Đưa ra thời gian chờ khuyến cáo (từ 1 phút đến 120 phút) nhằm đảm bảo an toàn tuyệt đối cho tài khoản.

10. **⭐ Địa điểm Yêu thích & Lịch sử**:
    - Lưu các tọa độ thường dùng vào mục Yêu thích và quản lý lịch sử 25 lần dịch chuyển gần nhất.

---

## 🏗️ 2. Kiến trúc kỹ thuật (Technical Architecture)

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Renderer UI                    │
│   (index.html + style.css + app.js + Leaflet Google Maps)   │
└──────────────────────────────┬──────────────────────────────┘
                               │ IPC (preload.js)
┌──────────────────────────────▼──────────────────────────────┐
│                    Electron Main Process                    │
│                          (main.js)                          │
└──────────────────────────────┬──────────────────────────────┘
                               │ stdin / stdout (JSON protocol)
┌──────────────────────────────▼──────────────────────────────┐
│              Python Worker (location_worker.py)             │
│   pymobiledevice3.remote.userspace_tunnel.establish_rsd     │
│             + DvtSimulateLocation (DVT Service)             │
└──────────────────────────────┬──────────────────────────────┘
                               │ USB Socket (usbmuxd)
┌──────────────────────────────▼──────────────────────────────┐
│                    Thiết bị Apple iPhone                    │
│             (iOS 14, 15, 16, 17, 18, 26+ Supported)         │
└─────────────────────────────────────────────────────────────┘
```

### Tại sao ứng dụng không cần quyền Administrator?
- **Phiên bản cũ**: Sử dụng lệnh CLI `pymobiledevice3 lockdown start-tunnel` tạo card mạng ảo (Wintun TAP driver), bắt buộc người dùng Windows phải mở terminal với quyền Administrator.
- **Phiên bản mới (v1.0.3)**: 
  - [location_worker.py](file:///f:/github/fake-gps-mobile/location_worker.py) import trực tiếp thư viện `pymobiledevice3.remote.userspace_tunnel.establish_userspace_rsd`.
  - Khởi tạo tunnel hoàn toàn trong userspace qua socket native của `usbmuxd`.
  - Thiết lập kênh Developer Service (`com.apple.dt.simulatelocation`) và duy trì tiến trình nền.
  - Khi cần đổi vị trí, `main.js` chỉ cần ghi chuỗi `lat,lng\n` vào `stdin` của worker, vị trí trên iPhone được cập nhật tức thì dưới **50ms**.

---

## 📁 3. Cấu trúc thư mục (Project Structure)

```
fake-gps-mobile/
├── main.js                  # Electron Main Process (quản lý cửa sổ, worker process, IPC)
├── preload.js               # ContextBridge an toàn giữa Electron và Renderer
├── location_worker.py       # Python daemon xử lý Userspace RSD Tunnel & set location
├── package.json             # Cấu hình dự án & electron-builder
├── build/                   # Thư mục xuất file cài đặt (.exe portable & setup)
│   ├── IOS GPS by BraveHoang-1.0.3-portable.exe
│   └── IOS GPS by BraveHoang Setup 1.0.3.exe
├── renderer/                # Giao diện người dùng
│   ├── index.html           # HTML cấu trúc UI (Sidebar, Map container, Modals)
│   ├── style.css            # CSS giao diện Dark Modern Glassmorphism
│   └── app.js               # Logic điều khiển Leaflet, tìm kiếm, OSRM, Joystick
├── iconapp.png              # Icon ứng dụng (PNG)
├── iconapp.ico              # Icon ứng dụng định dạng Windows ICO
└── README.md                # Tài liệu hướng dẫn sử dụng và phát triển
```

---

## 💻 4. Yêu cầu môi trường & Cài đặt phát triển

### A. Yêu cầu hệ thống:
1. **Hệ điều hành**: Windows 10 hoặc Windows 11 (64-bit).
2. **Node.js**: Phiên bản 18+ trở lên (khuyên dùng LTS).
3. **Python**: Phiên bản 3.10 - 3.14 (đã tích chọn `Add Python to PATH` khi cài đặt).
4. **Apple Driver**: Đã cài iTunes bản desktop hoặc Apple Devices app (để máy tính nhận diện được driver `usbmuxd`).
5. **pymobiledevice3**: Thư viện giao tiếp iOS:
   ```bash
   pip install -U pymobiledevice3
   ```

### B. Các bước chạy Development:
```bash
# 1. Clone mã nguồn
git clone https://github.com/huydung2002/fake-gps-mobile.git
cd fake-gps-mobile

# 2. Cài đặt các gói phụ thuộc Node.js
npm install

# 3. Khởi chạy ứng dụng
npm start
```

---

## 📦 5. Hướng dẫn Đóng gói (Build) & Phát hành (Release)

### A. Đóng gói file chạy cho Windows:
Lệnh sau sẽ tự động đóng gói ứng dụng bằng `electron-builder`:
```bash
npm run dist
```
Sau khi build xong, thư mục `build/` sẽ chứa:
- **`IOS GPS by BraveHoang-1.0.3-portable.exe`**: Bản Portable mở lên chạy ngay không cần cài đặt.
- **`IOS GPS by BraveHoang Setup 1.0.3.exe`**: Bộ cài đặt chuẩn Windows tạo shortcut Desktop và Start Menu.

> **Lưu ý kỹ thuật khi đóng gói**:
> File `location_worker.py` được cấu hình trong `package.json` với `asarUnpack` và `extraResources`. Hàm `getLocationWorkerScriptPath()` trong [main.js](file:///f:/github/fake-gps-mobile/main.js) sẽ tự động dò tìm vị trí file script ở cả chế độ dev lẫn khi đã nén vào thư mục cài đặt `resources/`.

### B. Phát hành phiên bản mới lên GitHub Releases:
1. Tăng version trong `package.json` (ví dụ `1.0.3`).
2. Commit và gắn tag:
   ```bash
   git add -A
   git commit -m "release: v1.0.3"
   git push origin main
   git tag -a v1.0.3 -m "Release v1.0.3"
   git push origin v1.0.3
   ```
3. Đẩy file build lên GitHub Releases bằng `electron-builder`:
   ```powershell
   $env:GH_TOKEN = "your_personal_access_token_here"
   npm run dist -- --publish always
   ```

---

## 📱 6. Hướng dẫn sử dụng cho người dùng cuối

1. **Kết nối**: Cắm cáp USB nối iPhone vào máy tính.
2. **Tin cậy**: Mở khóa màn hình iPhone, nếu có thông báo hiện lên, bấm **Tin cậy (Trust this computer)**.
3. **Developer Mode (Dành cho iOS 16+)**:
   - Mở iPhone: vào **Cài đặt** -> **Quyền riêng tư & Bảo mật** -> Kéo xuống dưới cùng chọn **Chế độ nhà phát triển (Developer Mode)** -> Bật **Bật** và khởi động lại máy nếu được yêu cầu.
4. **Mở ứng dụng**:
   - Ứng dụng sẽ tự động phát hiện thiết bị và kết nối Userspace Tunnel trong vài giây.
   - Dán tọa độ hoặc nhấp chuột lên bản đồ để chọn vị trí.
   - Xem trước thông tin và bấm **🚀 Dịch chuyển tới đây** để fake GPS.
5. **Khôi phục**: Khi không sử dụng nữa, bấm nút **🔄 Khôi phục GPS thật** ở đầu thanh bên để trả lại định vị ban đầu.

---

## 🛠️ 7. Xử lý sự cố thường gặp (Troubleshooting)

| Lỗi | Nguyên nhân | Cách khắc phục |
| :--- | :--- | :--- |
| **Chưa thấy iPhone** | Cáp kết nối lỏng hoặc máy tính chưa nhận driver | Rút cáp cắm lại, mở khóa màn hình iPhone và bấm **Tin cậy**. Đảm bảo đã cài iTunes trên Windows. |
| **Lỗi ghép cặp Mux 183** | Bản ghi Trust cũ bị lỗi hoặc bị đổi máy | Mở khóa iPhone, chọn Trust lại. Nếu cần, vào Cài đặt iPhone -> Cài đặt chung -> Đặt lại vị trí & quyền riêng tư. |
| **Developer Mode required** | iOS 16+ yêu cầu bật chế độ nhà phát triển | Vào Cài đặt iPhone -> Quyền riêng tư & Bảo mật -> Chế độ nhà phát triển -> Bật. |
| **Bản đồ không tải được** | Mất kết nối Internet trên máy tính | Kiểm tra lại kết nối mạng trên máy tính. Bản đồ dùng tile server của Google Maps và OpenStreetMap. |
| **File log chi tiết** | Cần xem log để sửa lỗi | Xem file `gps_debug.log` tại thư mục cài đặt hoặc `%APPDATA%/ios-gps-by-bravehoang/gps_debug.log`. |

---

## 📄 Bản quyền & Tác giả
- **Tác giả:** BraveHoang ([huydung2002](https://github.com/huydung2002))
- **Mã nguồn:** [https://github.com/huydung2002/fake-gps-mobile](https://github.com/huydung2002/fake-gps-mobile)
- **Giấy phép:** ISC License