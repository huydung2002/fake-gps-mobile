# iOS GPS Spoofer

Đây là ứng dụng Desktop (Electron) cho phép thay đổi (fake) vị trí GPS trên thiết bị iOS thông qua kết nối USB.

## Yêu cầu hệ thống (Prerequisites)

Để có thể chạy được dự án này, máy tính của bạn cần được cài đặt các phần mềm sau:

1. **Node.js**: [Tải và cài đặt Node.js](https://nodejs.org/).
2. **Python**: [Tải và cài đặt Python](https://www.python.org/). (Nên đánh dấu vào ô "Add Python to PATH" lúc cài đặt).
3. **iTunes (Apple Drivers)**: Cần thiết để máy tính Windows có thể nhận diện và giao tiếp được với iPhone.
4. **pymobiledevice3**: Thư viện Python dùng để giao tiếp với thiết bị iOS. 
   - Cài đặt bằng lệnh: `pip install pymobiledevice3` (hoặc `pip3 install pymobiledevice3`)

## Hướng dẫn cài đặt và chạy ứng dụng

1. **Clone mã nguồn về máy** (hoặc tải file ZIP giải nén):
   ```bash
   git clone https://github.com/huydung2002/fake-gps-mobile.git
   cd fake-gps-mobile
   ```

2. **Cài đặt các thư viện cần thiết cho Node.js** (chỉ cần chạy lần đầu tiên):
   ```bash
   npm install
   ```

3. **Chạy ứng dụng**:
   ```bash
   npm start
   ```

## Hướng dẫn sử dụng cơ bản
- Kết nối iPhone với máy tính bằng cáp USB.
- Mở khóa iPhone và chọn "Tin cậy thiết bị này" (Trust this computer) nếu được hỏi.
- Chạy ứng dụng bằng lệnh `npm start`.
- Giao diện ứng dụng sẽ hiển thị bản đồ, bạn có thể click chọn vị trí muốn giả mạo và nhấn nút bắt đầu giả mạo.

## Khắc phục lỗi (Troubleshooting)
- Nếu gặp lỗi "Device is not connected" hoặc mất kết nối: Đảm bảo cáp kết nối ổn định, iTunes đã nhận ra điện thoại, và thiết bị của bạn không bị màn hình khóa lúc đang thao tác.
- Lịch sử lỗi sẽ được ghi tự động vào file `gps_debug.log` trong cùng thư mục dự án để dễ dàng theo dõi.