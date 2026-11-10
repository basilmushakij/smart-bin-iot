# 🌐 Web API Design (RESTful API Specification)

เอกสารฉบับนี้อธิบายรายละเอียดของ RESTful API ที่พัฒนาด้วย **FastAPI** ซึ่งทำงานอยู่บนพอร์ต `8081` (Host) เพื่อให้บริการแก่ Web Dashboard ในการดึงข้อมูลสถานะ, ดูประวัติย้อนหลัง, ปรับแต่งเกณฑ์แจ้งเตือน และส่งคำสั่งควบคุมไปยังอุปกรณ์ถังขยะอัจฉริยะ

---

## 📌 1. ข้อมูลทั่วไป (API Overview)

* **Base URL:** `http://<SERVER_IP>:8081`
* **Localhost URL:** `http://localhost:8081`
* **Content-Type:** `application/json`
* **CORS / Caching:** ปิด Cache บนหน้า Dashboard (`Cache-Control: no-cache, no-store, must-revalidate`)

---

## 📋 2. สรุปรายการ Endpoint ทั้งหมด (Endpoints Summary)

| Method | Endpoint | คำอธิบายสั้น | สิทธิ์ / การใช้งาน |
| :---: | :--- | :--- | :--- |
| `GET` | `/` | ส่งคืนหน้าเว็บแดชบอร์ดหลัก (`index.html`) | ผู้ใช้เปิดหน้าเว็บ |
| `GET` | `/api/config` | ดึงค่าคอนฟิกเริ่มต้น (เช่น Offline threshold) | Web Dashboard Init |
| `GET` | `/api/bins` | ดึงรายชื่อถังขยะทั้งหมดในระบบ | รายการถัง / Dropdown |
| `GET` | `/api/bins/{bin_id}/latest` | ดึงข้อมูลเซนเซอร์ล่าสุดของถัง | Real-time Polling (1 วินาที) |
| `GET` | `/api/bins/{bin_id}/history` | ดึงข้อมูลย้อนหลังสำหรับพล็อตกราฟ | Real-time Chart (5 วินาที) |
| `GET` | `/api/bins/{bin_id}/threshold` | ดึงค่าเกณฑ์แจ้งเตือนปัจจุบันของถัง | โหลดค่าใส่ Modal ตั้งค่า |
| `POST` | `/api/bins/{bin_id}/threshold` | อัปเดตเกณฑ์แจ้งเตือนและส่งไปยังบอร์ด | เมื่อผู้ใช้กดบันทึกเกณฑ์ |
| `POST` | `/api/bins/{bin_id}/snooze` | สั่งปิดเสียงเตือนชั่วคราว 5 นาที | กดปุ่ม Snooze |
| `POST` | `/api/bins/{bin_id}/mute_permanent` | สั่งปิดเสียงเตือนถาวร (โหมดไม่อยู่บ้าน) | กดปุ่ม Away Mode |
| `POST` | `/api/bins/{bin_id}/unsnooze` | สั่งยกเลิกการปิดเสียงและเปิดเสียงคืน | กดปุ่ม Unmute |

---

## 🔍 3. รายละเอียดแต่ละ Endpoint

### 3.1 `GET /api/config`
ดึงค่าคอนฟิกส่วนกลางที่จำเป็นสำหรับหน้าเว็บแดชบอร์ด

* **Request Parameters:** ไม่มี
* **Response:** `200 OK`
```json
{
  "offline_threshold_seconds": 30
}
```

---

### 3.2 `GET /api/bins`
ดึงรายชื่อรหัสถังขยะทั้งหมดที่มีการลงทะเบียนไว้และตรวจพบในระบบ

* **Request Parameters:** ไม่มี
* **Response:** `200 OK`
```json
[
  "smartbin01"
]
```

---

### 3.3 `GET /api/bins/{bin_id}/latest`
ดึงสถานะและค่าเซนเซอร์ล่าสุดของถังขยะใบที่ระบุ

* **Path Parameters:**
  * `bin_id` (string, required): รหัสประจำตัวถัง เช่น `smartbin01`
* **Response:** `200 OK`
```json
{
  "_id": "6ab8c8028c03bd97a117a2b2",
  "bin_id": "smartbin01",
  "distance": 3.8,
  "mq_value": 265,
  "hc_full": true,
  "mq_danger": false,
  "snoozed": false,
  "permanent_mute": false,
  "received_at": "2026-09-27T08:52:15.000Z"
}
```
* **Error Responses:**
  * `404 Not Found`: ไม่พบข้อมูลเซนเซอร์ของถังนี้ในฐานข้อมูล

---

### 3.4 `GET /api/bins/{bin_id}/history`
ดึงข้อมูลบันทึกย้อนหลัง เรียงจากใหม่ไปเก่า สำหรับนำไปพล็อตกราฟเส้นหรือตารางประวัติ

* **Path Parameters:**
  * `bin_id` (string, required): รหัสประจำตัวถัง
* **Query Parameters:**
  * `limit` (integer, optional, default: 120, max: 500): จำนวนรายการย้อนหลังที่ต้องการ
* **Response:** `200 OK`
```json
[
  {
    "_id": "6ab8c8028c03bd97a117a2b2",
    "bin_id": "smartbin01",
    "distance": 3.8,
    "mq_value": 265,
    "hc_full": true,
    "mq_danger": false,
    "snoozed": false,
    "permanent_mute": false,
    "received_at": "2026-09-27T08:52:15.000Z"
  }
]
```

---

### 3.5 `GET /api/bins/{bin_id}/threshold`
ดึงค่าเกณฑ์ตัดสินสถานะล่าสุดของถังใบที่ระบุ

* **Path Parameters:**
  * `bin_id` (string, required): รหัสประจำตัวถัง
* **Response:** `200 OK`
```json
{
  "bin_id": "smartbin01",
  "mq_danger": 600,
  "full_distance": 4.0,
  "source": "database",
  "updated_at": "2026-09-27T07:15:00.000Z"
}
```

---

### 3.6 `POST /api/bins/{bin_id}/threshold`
ปรับแต่งค่าเกณฑ์แจ้งเตือนใหม่ บันทึกลง MongoDB และ Publish ไปยัง Topic `smartbin/{bin_id}/config` ด้วย flag `retain=True`

* **Path Parameters:**
  * `bin_id` (string, required): รหัสประจำตัวถัง
* **Request Body:**
```json
{
  "mq_danger": 650,
  "full_distance": 5.0
}
```
* **Validation Rules:**
  * `mq_danger`: ตัวเลขจำนวนเต็ม ในช่วง 0 ถึง 1023
  * `full_distance`: ตัวเลขทศนิยม ในช่วง 0.0 ถึง 400.0 ซม.
* **Response:** `200 OK`
```json
{
  "saved": true,
  "bin_id": "smartbin01",
  "mq_danger": 650,
  "full_distance": 5.0,
  "published_to_device": true
}
```
* **Error Responses:**
  * `400 Bad Request`: รูปแบบข้อมูลไม่ถูกต้อง หรือค่านอกช่วงที่กำหนด
  * `503 Service Unavailable`: ไม่สามารถติดต่อ MQTT Broker เพื่อส่งข้อความได้

---

### 3.7 `POST /api/bins/{bin_id}/snooze`
สั่งปิดเสียง Buzzer ชั่วคราว 5 นาที

* **Path Parameters:**
  * `bin_id` (string, required): รหัสประจำตัวถัง
* **Request Body (Optional):**
```json
{"action": "snooze"}
```
* **Response:** `200 OK`
```json
{
  "sent": true,
  "bin_id": "smartbin01",
  "action": "snooze"
}
```

---

### 3.8 `POST /api/bins/{bin_id}/mute_permanent`
สั่งปิดเสียง Buzzer ถาวร (โหมดไม่อยู่บ้าน / Away Mode) เสียงจะไม่ดังจนกว่าจะกดเปิดคืน

* **Path Parameters:**
  * `bin_id` (string, required): รหัสประจำตัวถัง
* **Response:** `200 OK`
```json
{
  "sent": true,
  "bin_id": "smartbin01",
  "action": "permanent_mute"
}
```

---

### 3.9 `POST /api/bins/{bin_id}/unsnooze`
ยกเลิกการปิดเสียงทันที (ทั้ง Snooze และ Permanent Mute)

* **Path Parameters:**
  * `bin_id` (string, required): รหัสประจำตัวถัง
* **Response:** `200 OK`
```json
{
  "sent": true,
  "bin_id": "smartbin01",
  "action": "unsnooze"
}
```
