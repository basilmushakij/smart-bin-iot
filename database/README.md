# 🗄️ Database Design (MongoDB)

ระบบ **Smart Bin IoT System** ใช้ MongoDB เป็นระบบจัดการฐานข้อมูลแบบ NoSQL Document Store โดยทำงานเป็นคอนเทนเนอร์บน Docker (Port ภายใน: `27017`)

---

## 📌 1. ข้อมูลภาพรวมฐานข้อมูล (Database Overview)

* **Database Name:** `smartbin_db`
* **Default Port:** `27017` (สื่อสารภายใน Docker Network `smart_bin`)
* **Init Script:** `init-mongo.js` (รันอัตโนมัติเมื่อ mount เข้า `/docker-entrypoint-initdb.d/`)
* **Volume:** `smartbin_mongodb_data` (เก็บข้อมูลแบบถาวร)

---

## 📂 2. โครงสร้าง Collections & Schemas

### 2.1 Collection: `smartbin_readings`
ใช้สำหรับบันทึกข้อมูล Telemetry ที่เซนเซอร์วัดได้และส่งผ่าน Collector เข้ามาในแต่ละรอบ

#### Schema:
| ฟิลด์ (Field) | ชนิดข้อมูล (BSON/Type) | คำอธิบาย | ตัวอย่างข้อมูล |
| :--- | :--- | :--- | :--- |
| `_id` | `ObjectId` | รหัสอ้างอิงเอกสารอัตโนมัติ | `ObjectId("6ab8c8028c03bd97a117a2b2")` |
| `bin_id` | `String` | รหัสประจำตัวถังขยะ | `"smartbin01"` |
| `distance` | `Double` | ระยะที่วัดได้จากเซนเซอร์ HC-SR04 (ซม.) | `3.8` |
| `mq_value` | `Int32` | ค่าก๊าซ/กลิ่นจากเซนเซอร์ MQ-136 (0-1023) | `265` |
| `hc_full` | `Boolean` | สถานะขยะเต็มถัง (ระยะ $\le$ เกณฑ์) | `true` |
| `mq_danger` | `Boolean` | สถานะกลิ่นเหม็นวิกฤต (ค่า $\ge$ เกณฑ์) | `false` |
| `snoozed` | `Boolean` | สถานะปิดเสียงเตือนชั่วคราว 5 นาที | `false` |
| `permanent_mute` | `Boolean` | สถานะปิดเสียงเตือนถาวร (Away Mode) | `false` |
| `received_at` | `Date` (ISODate) | วันที่และเวลาที่ Server ได้รับข้อมูล (UTC) | `ISODate("2026-09-27T08:52:15.000Z")` |

#### Indexes:
* **Compound Index:** `{ "bin_id": 1, "received_at": -1 }`
  * **วัตถุประสงค์:** เพิ่มประสิทธิภาพสูงสุดในการ Query ข้อมูลล่าสุด (`find_one` เรียงตามเวลา) และประวัติย้อนหลังสำหรับวาดกราฟ (`history`)

---

### 2.2 Collection: `smartbin_thresholds`
ใช้สำหรับบันทึกค่าเกณฑ์แจ้งเตือนล่าสุดของแต่ละถังขยะ เพื่อให้ Web Dashboard นำไปแสดงผลบน Slider และส่งต่อไปยังบอร์ดผ่าน MQTT Retained Message

#### Schema:
| ฟิลด์ (Field) | ชนิดข้อมูล (BSON/Type) | คำอธิบาย | ค่าเริ่มต้น |
| :--- | :--- | :--- | :--- |
| `_id` | `ObjectId` | รหัสอ้างอิงเอกสารอัตโนมัติ | `ObjectId("...")` |
| `bin_id` | `String` | รหัสประจำตัวถังขยะ | `"smartbin01"` |
| `mq_danger` | `Int32` | เกณฑ์กลิ่นวิกฤต MQ-136 | `600` |
| `full_distance` | `Double` | เกณฑ์ระยะถังเต็ม (ซม.) | `4.0` |
| `updated_at` | `Date` (ISODate) | เวลาที่มีการปรับปรุงเกณฑ์ล่าสุด | `ISODate("...")` |

#### Indexes:
* **Unique Index:** `{ "bin_id": 1 }`
  * **วัตถุประสงค์:** ป้องกันการมีรายการ Threshold ซ้ำซ้อนสำหรับถังใบเดียวกัน และทำให้การ `upsert` ทำงานได้อย่างรวดเร็ว
