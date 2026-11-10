# 🧪 Test Report & Verification Specification

เอกสารรายงานผลการทดสอบระบบ **Smart Bin IoT System** เพื่อยืนยันการทำงานของระบบครบวงจร (End-to-End Verification) ตามข้อกำหนดในเอกสารความต้องการ (Requirement Specification) และใบงานโครงงาน

---

## 📑 1. ภาพรวมการทดสอบ (Test Overview)

การทดสอบแบ่งออกเป็น 2 ส่วนหลัก:
1. **Functional Testing (T01 – T10):** การทดสอบความถูกต้องของแต่ละฟังก์ชันตาม Functional Requirements
2. **End-to-End Integration Testing:** การทดสอบการไหลของข้อมูลตั้งแต่ระดับเซนเซอร์ไปจนถึงหน้าจอแสดงผล และการควบคุมจากหน้าจอแสดงผลกลับมายังอุปกรณ์จริง

---

## 🔗 2. ตารางเชื่อมโยงความต้องการกับการทดสอบ (Requirement Traceability Matrix)

| Requirement ID | รายละเอียดความต้องการ | รหัสการทดสอบ (Test ID) | สถานะ (Status) |
| :---: | :--- | :---: | :---: |
| **FR-01** | ระบบต้องสามารถอ่านระยะจาก HC-SR04 ได้ | **T01** | ✅ **Pass** |
| **FR-02** | ระบบต้องสามารถอ่านค่าจาก MQ-136 ได้ | **T02** | ✅ **Pass** |
| **FR-03** | ระบบต้องสามารถระบุสถานะขยะเต็มจากค่า Distance ได้ | **T01**, **T03** | ✅ **Pass** |
| **FR-04** | ระบบต้องสามารถระบุสถานะกลิ่นจากค่า MQ-136 ได้ | **T02**, **T03** | ✅ **Pass** |
| **FR-05** | LED ต้องสามารถแสดงสถานะ Green / Yellow / Red ได้ | **T03** | ✅ **Pass** |
| **FR-06** | OLED ต้องสามารถแสดงค่า Distance และค่า MQ ได้ | **T01**, **T02** | ✅ **Pass** |
| **FR-07** | Buzzer ต้องแจ้งเตือนเมื่อขยะเต็มหรือมีกลิ่น | **T04** | ✅ **Pass** |
| **FR-08** | ESP8266 ต้องสามารถ Publish ข้อมูล Sensor ผ่าน MQTT ได้ | **T05** | ✅ **Pass** |
| **FR-09** | Collector ต้องสามารถรับข้อมูล MQTT และบันทึก MongoDB ได้ | **T06** | ✅ **Pass** |
| **FR-10** | Dashboard ต้องสามารถแสดงข้อมูลล่าสุดของถังขยะได้ | **T07** | ✅ **Pass** |
| **FR-11** | ระบบต้องสามารถแสดงข้อมูลย้อนหลังและกราฟได้ | **T07** | ✅ **Pass** |
| **FR-12** | ผู้ใช้ต้องสามารถตั้งค่าเกณฑ์กลิ่นและระยะเต็มจาก Dashboard ได้ | **T08** | ✅ **Pass** |
| **FR-13** | ค่า Threshold ต้องถูกส่งกลับไปยัง ESP8266 ผ่าน MQTT | **T08** | ✅ **Pass** |
| **FR-14** | Dashboard ต้องสามารถแจ้งเตือนเมื่อถังเต็มหรือมีกลิ่นได้ | **T04**, **T07** | ✅ **Pass** |
| **FR-15** | ผู้ใช้ต้องสามารถสั่ง Snooze Buzzer จาก Dashboard ได้ | **T09** | ✅ **Pass** |
| **FR-16** | ระบบต้องสามารถแสดงสถานะ Online/Offline ของถังได้ | **T07** | ✅ **Pass** |
| **FR-17** | ระบบต้องสามารถประมาณเวลาที่ถังจะเต็ม (ETA) ได้ | **T10** | ✅ **Pass** |
| **FR-18** | Dashboard ต้องสามารถแสดงประวัติการแจ้งเตือนได้ | **T07** | ✅ **Pass** |

---

## 📊 3. ผลการทดสอบฟังก์ชันการทำงาน (Test Cases & Results)

| Test ID | Requirement | เงื่อนไขการทดสอบ (Input) | ผลลัพธ์ที่คาดหวัง (Expected Result) | ผลการทดสอบจริง (Actual Result) | สถานะ |
| :---: | :---: | :--- | :--- | :--- | :---: |
| **T01** | FR-01 | วัตถุที่ระยะต่างกันหน้าเซนเซอร์ (2 – 40 ซม.) | HC-SR04 อ่านระยะได้ถูกต้องตามจริง | อ่านระยะได้ถูกต้อง แม่นยำตามการขยับวัตถุ | **Pass** |
| **T02** | FR-02 | นำก๊าซ/กลิ่นทดสอบเข้าใกล้เซนเซอร์ MQ-136 | MQ-136 เปลี่ยนค่าตามความเข้มข้นของก๊าซ | ค่าแอนะล็อกเปลี่ยนขึ้นตามระดับความเข้มข้น | **Pass** |
| **T03** | FR-05 | ปรับระดับสิ่งกีดขวาง (เขียว >10cm, เหลือง $\le$10cm, แดง $\le$4cm) | LED เปลี่ยนสี เขียว / เหลือง / แดง ตามเกณฑ์ | LED สลับสีถูกต้องตามเกณฑ์ระยะที่ตั้งไว้ | **Pass** |
| **T04** | FR-07 | ขยะเต็มถัง ($\le$ 4 cm) หรือกลิ่นสูง ($\ge$ 600) | Buzzer ส่งเสียงร้องเตือนอย่างต่อเนื่อง | มีเสียงเตือนความถี่ 2.5 kHz ทันทีเมื่อเข้าเกณฑ์แดง | **Pass** |
| **T05** | FR-08 | บอร์ดต่อ Wi-Fi และเริ่มอ่านข้อมูลเซนเซอร์ | MQTT Broker ได้รับข้อความ JSON ที่ Topic `smartbin/+/data` | Broker ได้รับข้อมูล JSON ครบถ้วนทุก ~300ms | **Pass** |
| **T06** | FR-09 | มีข้อความ Telemetry ส่งเข้ามายัง Broker | Collector ตรวจสอบและบันทึกลง MongoDB | Collection `smartbin_readings` มีข้อมูลเพิ่มขึ้นถูกต้อง | **Pass** |
| **T07** | FR-10 | เปิดเบราว์เซอร์เข้าหน้า `http://localhost:8081` | Dashboard แสดงผลข้อมูลเซนเซอร์ล่าสุด Real-time | แดชบอร์ดแสดงผลค่าระยะ, กลิ่น, %, สถานะสี และผังบ้าน | **Pass** |
| **T08** | FR-12 | ปรับเกณฑ์ผ่านหน้าเว็บ แล้วกด "บันทึกเกณฑ์" | ESP8266 ได้รับค่า Threshold ใหม่ทันที | บอร์ดรับ MQTT Config ใหม่และนำไปใช้ตัดสินสถานะทันที | **Pass** |
| **T09** | FR-15 | ขณะบัซเซอร์ดัง กดปุ่ม Snooze บน Dashboard | Buzzer หยุดส่งเสียง 5 นาที แต่ไฟแดงยังเตือน | เสียงเตือนเงียบลงทันที ไฟแดงและสถานะบนเว็บยังคงเตือน | **Pass** |
| **T10** | FR-17 | มีข้อมูลการเปลี่ยนแปลงระยะย้อนหลังในฐานข้อมูล | Dashboard แสดงเวลาคาดการณ์ (ETA) ที่ถังจะเต็ม | คำนวณอัตราการสะสมขยะและแสดงผล ETA ได้ถูกต้อง | **Pass** |

---

## 🔄 4. ผลการทดสอบระบบแบบครบวงจร (End-to-End Integration Testing)

### 🚀 Test A: Sensor to Dashboard Pipeline
```
[HC-SR04 / MQ-136]
       │
       ▼ (GPIO / ADC)
  [ESP8266]
       │
       ▼ (Wi-Fi 2.4 GHz / MQTT Port 1883)
[Eclipse Mosquitto Broker]
       │
       ▼ (Topic: smartbin/+/data)
[Python Collector Service]
       │
       ▼ (Data Validation: Range & Type Check)
   [MongoDB]
       │
       ▼ (REST API: /api/bins/{id}/latest)
[FastAPI Web Backend]
       │
       ▼ (HTTP / Polling 1s)
[Web Dashboard (Client UI)]
```
* **ขั้นตอนการทดสอบ:** ขยับวัตถุเข้าใกล้เซนเซอร์ HC-SR04 ให้เหลือระยะ 3.5 ซม.
* **ผลลัพธ์:**
  1. บอร์ด ESP8266 ตรวจจับระยะได้ 3.5 ซม. เปลี่ยนไฟ LED เป็นสีแดง และ OLED แสดง `CHANGE`
  2. ส่ง JSON ขึ้น MQTT Topic `smartbin/smartbin01/data`
  3. Python Collector รับข้อความ ตรวจสอบผ่านเกณฑ์ และบันทึกลง `smartbin_readings`
  4. Web Dashboard อัปเดตหน้าจอเป็นการ์ดสีแดง ถังขยะบน Floorplan กระพริบเตือนสีแดงทันที
* **สถานะ:** ✅ **PASS**

---

### 🎛️ Test B: Dashboard to Actuator Control Pipeline
```
[User บน Web Dashboard]
       │
       ▼ (คลิกปุ่ม "🔇 ปิด 5 นาที" หรือ "🏠 ปิดถาวร")
[FastAPI Web Backend]
       │
       ▼ (MQTT Publish: smartbin/{id}/command)
[Eclipse Mosquitto Broker]
       │
       ▼ (Topic: smartbin/smartbin01/command)
  [ESP8266]
       │
       ▼ (Digital Output Pin D0 / Tone)
 [Buzzer Actuator เงียบเสียง]
```
* **ขั้นตอนการทดสอบ:** เมื่อถังขยะส่งเสียงร้องเตือนสีแดง ผู้ใช้งานกดปุ่ม **"🔇 ปิด 5 นาที (Snooze)"** บนหน้าเว็บแดชบอร์ด
* **ผลลัพธ์:**
  1. แดชบอร์ดส่ง `POST /api/bins/smartbin01/snooze`
  2. Webapp ส่ง MQTT Payload `{"action": "snooze"}` ไปยังบอร์ด
  3. บอร์ดหยุดส่งสัญญาณเสียง Buzzer ทันที โดยที่ไฟ LED สีแดงยังคงติดสว่างเพื่อความปลอดภัย
  4. เมื่อนำขยะไปทิ้ง (ระยะพ้นขีดวิกฤต) บอร์ดคืนระบบเสียงให้อัตโนมัติ
* **สถานะ:** ✅ **PASS**

---

## 🏆 5. สรุปความพร้อมของระบบ (System Readiness Checklist)

- [x] **Sensors:** HC-SR04 และ MQ-136 อ่านค่าได้แม่นยำ เสถียร
- [x] **Actuators:** LED 3 สี, Buzzer และ OLED แสดงผลตรงตามสถานะ
- [x] **Firmware:** ESP8266 เชื่อมต่อ Wi-Fi และ MQTT อัตโนมัติ มีระบบ Auto-Reconnect
- [x] **MQTT Broker:** Mosquitto บริการรับ-ส่งข้อความสองทิศทางได้สมบูรณ์
- [x] **Data Collector:** คัดกรองและ Validate ชนิดข้อมูลและช่วงค่าได้ 100%
- [x] **Database:** MongoDB บันทึกข้อมูลและทำ Compound Index พร้อมใช้งาน
- [x] **Web API:** FastAPI ให้บริการ RESTful API ครบทุก Endpoint ตอบสนองรวดเร็ว
- [x] **Web Dashboard:** Interactive Floorplan, กราฟแนวโน้ม, และระบบควบคุมเสียงทำงานสมบูรณ์
