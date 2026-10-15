# MINICRAFT SURVIVAL — Máy chủ online beta 1.0.1 (chạy trên Render free)

Tính năng: tài khoản (tên + mật khẩu + email), xác nhận email, **quên mật khẩu gửi mã qua Brevo**, lưu bản đồ và dữ liệu người chơi, thấy nhau, chat, kết bạn, NPC, chống hack.

## Vì sao cần MongoDB
Render free **xóa ổ đĩa mỗi lần máy chủ khởi động lại hoặc ngủ dậy**. Nếu lưu vào file, tài khoản và đồ của người chơi sẽ mất. Vì vậy dữ liệu được lưu ở **MongoDB Atlas (gói miễn phí, không hết hạn)**.

## Bước 1 — MongoDB Atlas (miễn phí)
1. Vào mongodb.com/atlas, tạo tài khoản, tạo cluster **M0 (Free)**.
2. **Database Access**: tạo người dùng + mật khẩu (nhớ lại).
3. **Network Access**: thêm địa chỉ `0.0.0.0/0` (cho Render truy cập).
4. **Connect > Drivers**: copy chuỗi kết nối dạng `mongodb+srv://USER:PASS@cluster0.xxxx.mongodb.net/`. Đây là giá trị `MONGODB_URI`.

## Bước 2 — Brevo (gửi email mã xác nhận / quên mật khẩu)
1. Vào brevo.com, tạo tài khoản miễn phí (300 email/ngày).
2. **Senders, Domains & Dedicated IPs > Senders**: thêm email gửi của bạn và bấm xác minh qua email. Đây là `MAIL_FROM`.
3. **SMTP & API > API Keys**: tạo khóa API (v3). Đây là `BREVO_API_KEY`.
4. Lưu ý: dùng Gmail cá nhân làm người gửi thì thư dễ vào mục Spam. Có tên miền riêng và xác thực tên miền trong Brevo sẽ tốt hơn.

## Bước 3 — Render
1. Đưa thư mục `server` lên một kho GitHub (có thể dùng chung kho với `ipa-kit`, khi đó đặt **Root Directory** là `server`).
2. render.com > **New > Web Service** > chọn kho. Runtime Node. Build: `npm install`. Start: `node server.js`. Plan: **Free**.
3. Thêm **Environment Variables**: `MONGODB_URI`, `BREVO_API_KEY`, `MAIL_FROM`. (Tùy chọn: `MAIL_FROM_NAME`, `MAX_PLAYERS`, `REQUIRE_VERIFY=0` để tắt bắt buộc xác nhận email.)
4. Deploy xong, mở `https://TEN-CUA-BAN.onrender.com/health`, phải thấy `"storage":"mongo","mail":true`.
5. Trong game bấm **Chơi online**, nhập `wss://TEN-CUA-BAN.onrender.com`, **Đăng ký** (sẽ có mã gửi về email), rồi chơi.

## Render free ngủ khi không ai dùng
Sau khoảng 15 phút không có truy cập, máy chủ ngủ; lần vào sau mất khoảng 30–60 giây để thức dậy. Game tự thử kết nối lại tối đa khoảng 80 giây. Muốn giữ luôn thức: dùng dịch vụ miễn phí như UptimeRobot, ping `https://TEN-CUA-BAN.onrender.com/health` mỗi 5 phút.

## Bảo mật
- Mật khẩu được băm bằng scrypt, không lưu dạng chữ thường. Mã xác nhận/quên mật khẩu có hiệu lực 15 phút, tối đa 5 lần thử, giới hạn số lần yêu cầu.
- Đăng nhập sai quá 8 lần trong 10 phút sẽ bị khóa tạm.
- Phiên đăng nhập (nút "Vào nhanh") hết hạn sau 30 ngày; đổi mật khẩu sẽ hủy mọi phiên.

## Chống hack (phía máy chủ)
Kiểm tra tốc độ, dịch chuyển, bay lên, tầm với và tần suất đào/đặt, giới hạn nổ, bất thường khi lưu túi đồ (nhân đồ, tăng cấp, hiệu ứng nâng cấp vượt 25%), giới hạn gói tin và chat. Vi phạm: kéo về, đuổi ra, tái phạm thì cấm tạm 10 phút. Máy chủ không dựng lại địa hình nên không biết bạn có đang bay giữa không trung hay không.

## Thật thà về kiểm thử
Mình đã kiểm tra toàn bộ logic (đăng ký, xác nhận, đăng nhập, quên mật khẩu, lưu và tải lại, chống hack) bằng kết nối và dịch vụ giả lập. Mình **chưa** chạy với Render, MongoDB Atlas và Brevo thật, vì môi trường của mình không có mạng. Nếu có lỗi khi triển khai, xem tab **Logs** trên Render và gửi mình dòng lỗi.
