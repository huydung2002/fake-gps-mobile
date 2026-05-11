# iOS GPS Spoofer (Windows + USB)

Ứng dụng Desktop (Electron) giúp dịch chuyển vị trí iPhone qua USB bằng `pymobiledevice3`.

## 1) Yêu cầu hệ thống

Trên máy Windows cần có:

1. **Node.js**: [https://nodejs.org/](https://nodejs.org/)
2. **Python 3** (đã add PATH): [https://python.org/](https://python.org/)
3. **Apple driver/service** để giao tiếp iPhone:
   - iTunes bản desktop, hoặc
   - `Apple Mobile Device Support`
4. **pymobiledevice3**:
   ```bash
   pip install -U pymobiledevice3
   ```

## 2) Cài đặt & Phát triển

Nếu bạn muốn clone project về để phát triển hoặc tự build:

```bash
# 1. Clone repository
git clone https://github.com/huydung2002/fake-gps-mobile.git
cd fake-gps-mobile

# 2. Cài đặt các thư viện Node.js
npm install

# 3. Chạy ứng dụng ở chế độ development
npm start
```

## 3) Đóng gói ứng dụng (Build)

Để tạo file cài đặt (`.exe`) cho Windows:

```bash
# Build bản cài đặt (NSIS) và bản Portable
npm run dist

# Hoặc chỉ build bản Portable nhanh (không cần cài đặt)
npm run dist -- --win portable
```

Sau khi build xong, sản phẩm sẽ nằm trong thư mục `build/`.

## 4) Tạo bản phát hành trên GitHub (Dành cho Dev)

Để tự động đẩy bản build lên mục **Releases** trên GitHub:

1. Tạo một [GitHub Token (Classic)](https://github.com/settings/tokens) với quyền `repo`.
2. Trong terminal (PowerShell), thiết lập token:
   ```powershell
   $env:GH_TOKEN = "your_github_token_here"
   ```
3. Chạy lệnh phát hành:
   ```powershell
   npm run dist -- --publish always
   ```

## 5) Cách dùng

1. Cắm iPhone qua USB.
2. Mở khóa iPhone và bấm **Trust this computer**.
3. Mở app, chọn thiết bị.
4. Chọn vị trí trên bản đồ.
5. Bấm **Dịch chuyển**.
6. App sẽ giữ vị trí ảo định kỳ (keep-alive) để hạn chế rơi session.

Khi muốn trả về vị trí thật:

- Bấm **Đặt lại vị trí thật** trên app, hoặc
- Khởi động lại thiết bị / reset session.

## 5) Lưu ý quan trọng

- Đây là cơ chế simulated location qua developer service, không phải thay GPS phần cứng thực.
- Trên một số phiên bản iOS, Google Maps có thể hiển thị trạng thái vị trí xám khi session giả lập bị hệ thống refresh.
- App đã có cơ chế retry tunnel + keep-alive để tăng độ ổn định, nhưng hành vi phụ thuộc iOS và driver Windows.

## 6) Khắc phục lỗi nhanh

### A. `Device is not connected`

- Đổi cáp/đổi cổng USB.
- Mở khóa màn hình iPhone.
- Rút cáp cắm lại, xác nhận Trust.

### B. `requires admin privileges`

- Đóng app.
- Mở terminal bằng **Run as administrator**.
- Chạy lại `npm start`.

### C. `MuxException Number 183` / `Connection was terminated abruptly`

1. Đóng app + iTunes/Apple Devices.
2. Cắm lại cáp, mở khóa iPhone.
3. Nếu cần, reset trust:
   - iPhone: Reset Location & Privacy
   - Windows: xóa file pair record cũ trong `C:\ProgramData\Apple\Lockdown`
4. Chạy lại app.

### D. Kiểm tra log

Toàn bộ log debug ghi tại:

- `gps_debug.log`

## 7) Ghi chú cho dev

- App đang ưu tiên nhánh iOS mới (`developer dvt simulate-location`) và tunnel.
- Có fallback nhiều tầng:
  - `lockdown start-tunnel`
  - `remote start-tunnel`
  - `--rsd`
  - `--tunnel`
- Trên Windows, lệnh DVT có prompt `Press ENTER to exit>` đã được auto-handle trong code.