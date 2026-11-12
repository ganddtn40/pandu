# Cài đặt Pandu

Pandu là máy ghi chuyến bay cục bộ và tháp điều khiển cho các tác nhân lập trình
AI. Nó chạy trên máy tính của bạn, ghi lại những gì tác nhân của bạn làm, và giữ
mọi chuyến bay, cài đặt và thiết bị đã ghép nối trên máy của bạn. Không có tài
khoản, không đồng bộ đám mây, không telemetry.

Hướng dẫn này bao gồm ứng dụng Windows, ứng dụng đồng hành Android, ứng dụng web
cài đặt được (PWA) và công cụ dòng lệnh. Mọi lệnh đều an toàn để sao chép và dán.
Hướng dẫn tiếng Anh [`en.md`](en.md) là tài liệu tham chiếu đầy đủ khi có khác
biệt.

**Mục lục**

- [Bạn cần gì](#bạn-cần-gì)
- [Ứng dụng Windows](#ứng-dụng-windows)
- [Ứng dụng đồng hành Android](#ứng-dụng-đồng-hành-android)
- [Ứng dụng web cài đặt được (PWA)](#ứng-dụng-web-cài-đặt-được-pwa)
- [Công cụ dòng lệnh](#công-cụ-dòng-lệnh)
- [Khắc phục sự cố](#khắc-phục-sự-cố)

## Bạn cần gì

| Phần | Yêu cầu |
| --- | --- |
| Ứng dụng Windows | Windows 10 hoặc 11, 64-bit. Microsoft Edge WebView2 (có sẵn trong Windows hiện đại; trình cài đặt có thể tải xuống). |
| Ứng dụng đồng hành Android | Android 10 trở lên. Đường mạng từ điện thoại đến máy tính: `tailscale serve` hoặc một đường hầm HTTPS khác. |
| PWA | Chrome, Edge, Safari hoặc Firefox hiện hành. Trang phải được phục vụ qua HTTPS. |
| Máy tính chạy Pandu | Windows, macOS hoặc Linux cho daemon và CLI. Vỏ máy tính để bàn chỉ có trên Windows trong bản phát hành này. |

Bạn **không** cần quyền quản trị cho trình cài đặt Windows được khuyến nghị, và
**không** cần tài khoản ở bất kỳ đâu.

## Ứng dụng Windows

### Chọn tệp

Tải các tệp này từ cùng một trang phát hành GitHub. Không trộn tệp từ các bản
phát hành khác nhau.

| Tệp | Dùng khi |
| --- | --- |
| `Pandu_0.2.0_x64-setup.exe` | **Khuyến nghị.** Cài đặt theo người dùng, không nhắc quyền quản trị. |
| `Pandu_0.2.0_x64_en-US.msi` | Bạn triển khai phần mềm cho một tổ chức. Cài đặt toàn máy; cần quyền quản trị. |
| `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` | Bạn không muốn trình cài đặt. Giải nén và chạy. |

Số phiên bản trong tên tệp thay đổi theo mỗi bản phát hành. Dùng bản ổn định mới
nhất trừ khi ghi chú phát hành nói khác.

### Kiểm tra bản tải xuống trước

Mỗi bản phát hành có tệp `SHA256SUMS`. Tải nó vào cùng thư mục với trình cài
đặt, rồi mở PowerShell tại đó:

```powershell
Get-FileHash .\Pandu_0.2.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS | Select-String 'Pandu_0.2.0_x64-setup.exe'
```

Hai mã băm phải khớp chính xác. Nếu không, hãy xóa tệp và tải lại. Không chạy tệp
có mã băm không khớp, kể cả khi trang trông có vẻ chính thức.

### Cài đặt (khuyến nghị, theo người dùng)

1. Nhấp đúp `Pandu_0.2.0_x64-setup.exe`.
2. Nếu Windows hiện **Windows protected your PC**, chọn **More info** rồi
   **Run anyway**. Chỉ làm vậy khi tệp đến từ trang phát hành chính thức và
   SHA-256 đã khớp ở bước trước. Bản phát hành không được ký trừ khi ghi chú phát
   hành nêu rõ chứng chỉ Authenticode.
3. Làm theo trình cài đặt. Nó cài cho tài khoản người dùng của bạn và không yêu
   cầu quyền quản trị.
4. Nếu thiếu WebView2, trình cài đặt tải Microsoft Evergreen bootstrapper. Đây là
   lần duy nhất trình cài đặt cần internet.
5. Mở Pandu từ menu Start.

Trình cài đặt không thêm mục khởi động. Tự khởi động **tắt theo mặc định**.

### Lần chạy đầu

Cửa sổ Pandu mở ra và daemon cục bộ khởi động. Daemon lắng nghe trên một cổng
loopback trống, nên chỉ truy cập được từ máy tính của bạn. Giao diện được nhúng
trong ứng dụng; Pandu không tải nội dung web từ xa.

- **Đóng cửa sổ không thoát ứng dụng.** Pandu ở lại vùng thông báo để tiếp tục
  ghi. Dùng biểu tượng khay để mở lại.
- **Thoát là hành động rõ ràng.** Nhấp chuột phải biểu tượng khay và chọn
  **Quit Pandu**. Sau khi thoát, tác nhân không được ghi cho đến khi bạn khởi
  động lại.
- **Dữ liệu của bạn** nằm trong `%USERPROFILE%\.pandu`. Cơ sở dữ liệu là
  `%USERPROFILE%\.pandu\v2\pandu.db`; cài đặt, ảnh chụp nhanh và bản sao lưu nằm
  trong cùng cây thư mục.

### Gỡ cài đặt

1. Thoát Pandu từ khay.
2. Mở **Settings > Apps > Installed apps**, tìm **Pandu** và chọn **Uninstall**.
3. Trình gỡ cài đặt hỏi có xóa `%USERPROFILE%\.pandu` không. Mặc định là **No**.
   Chọn **No** để giữ chuyến bay, cài đặt, ảnh chụp nhanh, bản sao lưu và thiết bị
   đã ghép nối. Chỉ chọn **Yes** nếu bạn muốn xóa vĩnh viễn.

Hướng dẫn đầy đủ ở [`uninstall.md`](uninstall.md).

## Ứng dụng đồng hành Android

Ứng dụng đồng hành là bảng điều khiển nhỏ, giới hạn cho điện thoại. Nó có thể xem
chuyến bay và trả lời yêu cầu phê duyệt, nhưng không thể khởi động tác nhân hay
thay đổi cài đặt. Đây là tùy chọn.

**Thử nghiệm:** ứng dụng đồng hành Android đã được xác minh trên trình giả lập,
nhưng chưa trên điện thoại thật. APK không được đính kèm vào bản phát hành cho
đến khi xác minh trên điện thoại được ghi nhận; hãy tự biên dịch từ mã nguồn nếu
muốn thử.

Bản tóm tắt:

1. Trên máy tính, mở **Settings > Remote access** và bật truy cập từ xa. Chọn chế
   độ Tailscale và chạy lệnh `tailscale serve` mà Pandu hiển thị.
2. Biên dịch APK từ mã nguồn (thử nghiệm); xem [`android.md`](android.md).
3. Cho phép trình duyệt hoặc trình quản lý tệp cài ứng dụng không rõ nguồn gốc,
   rồi mở APK.
4. Mở Pandu trên điện thoại và quét mã QR ghép nối hiển thị trên máy tính.
5. Phê duyệt thiết bị trên máy tính. Thiết bị mới bắt đầu chỉ với **Status**.

Hướng dẫn đầy đủ, gồm quyền, cài đặt pin, kênh thông báo và xác minh bằng
`apksigner`, ở [`android.md`](android.md).

## Ứng dụng web cài đặt được (PWA)

PWA là cùng bảng điều khiển từ xa, được cài từ trình duyệt. Nó cần một URL HTTPS
dẫn đến máy tính của bạn, thường tạo bằng `tailscale serve`.

1. Bật truy cập từ xa trên máy tính và khởi động `tailscale serve`.
2. Mở URL HTTPS trên điện thoại hoặc máy tính khác.
3. Trong menu trình duyệt, chọn **Install app** hoặc **Add to Home Screen**.
4. Ghép nối thiết bị bằng mã hiển thị trên máy tính.

Hướng dẫn đầy đủ, gồm quy tắc bộ nhớ đệm và giới hạn, ở [`pwa.md`](pwa.md).

## Công cụ dòng lệnh

CLI `pandu` tách biệt với ứng dụng máy tính để bàn. Cài nó nếu bạn muốn tự chạy
daemon, dùng `pandu run -- <agent>` hoặc chạy chẩn đoán.

1. Tải `pandu-cli-x86_64-pc-windows-msvc.zip` và `SHA256SUMS`.
2. Kiểm tra tệp nén bằng `Get-FileHash` như trên.
3. Giải nén. `pandu.exe` nằm ở thư mục gốc của tệp nén.
4. Thêm thư mục giải nén vào `PATH`, hoặc chạy `pandu.exe` bằng đường dẫn đầy đủ.

Bản phát hành cũng có `pandu-cli-installer.ps1`, cài CLI cho người dùng hiện tại.
Đọc tập lệnh trước khi chạy nếu bạn muốn biết chính xác nó ghi ở đâu.

Vài lệnh đầu hữu ích:

```powershell
pandu doctor
pandu serve
pandu pair
```

`pandu doctor` kiểm tra cơ sở dữ liệu, bộ chuyển đổi, trình theo dõi nhật ký và
daemon đang chạy. Nó chỉ in thông tin cục bộ. `pandu pair` in một mã ghép nối ngắn
hạn và URL từ xa để dùng trên điện thoại.

## Khắc phục sự cố

Nếu có gì không hoạt động, đọc [`troubleshooting.md`](troubleshooting.md). Tài
liệu đó bao gồm SmartScreen, WebView2, xung đột cổng, nhắc tường lửa, lỗi ghép
nối, sự cố thông báo và cách đặt lại Pandu mà không mất dữ liệu.

## Quyền riêng tư trong một đoạn

Pandu ghi cục bộ. Ứng dụng máy tính để bàn chỉ nói chuyện với daemon trên
loopback. Truy cập từ xa tắt theo mặc định và chỉ có thể bật từ máy tính. Kiểm tra
cập nhật là một yêu cầu HTTPS đến GitHub không quá một lần mỗi 24 giờ và có thể
tắt. Không có telemetry, đồng bộ đám mây hay tải lên nền. Tuyên bố đầy đủ ở
[`privacy.md`](../privacy.md).
