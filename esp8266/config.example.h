// config.h
// -----------------------------------------------------------------
// รวมค่าคงที่ที่ต้องปรับแก้ตามหน้างานจริงไว้ในไฟล์เดียว จะได้ไม่ต้อง
// ไปไล่แก้ค่ากระจายอยู่ในไฟล์ .ino หลายจุด (รูปแบบเดียวกับ
// weather-station/esp8266_dht11/config.h)
// -----------------------------------------------------------------
#ifndef CONFIG_H
#define CONFIG_H

// ----- ตั้งค่า WiFi -----
// TODO: แก้ชื่อ WiFi และรหัสผ่านให้ตรงกับวงที่บอร์ดตัวนี้จะเชื่อมต่อจริง
#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// ----- ตั้งค่า MQTT broker -----
// TODO: ต้องเปลี่ยนเป็น IP ของเครื่อง PC ที่รัน "docker compose up" จริง
// เช็คได้จากคำสั่ง ipconfig (Windows) หรือ ifconfig/ip addr (Mac/Linux)
// ห้ามใส่ "localhost" หรือชื่อ service เช่น "mqtt" เด็ดขาด เพราะบอร์ดตัวนี้
// อยู่นอก docker network (ต่อผ่าน WiFi ธรรมดา) ไม่รู้จักชื่อ service ในนั้น
#define MQTT_BROKER "192.168.1.100"
#define MQTT_PORT 1883

// bin_id ตัวนี้ต้องไม่ซ้ำกับถังอื่นในระบบ ใช้แยกแยะว่าข้อมูลมาจากถังไหน
// ตอนที่ collector รับเข้าไปประมวลผล (และใช้เป็นชื่อ MQTT client ด้วย)
#define BIN_ID "smartbin01"
#define MQTT_TOPIC "smartbin/smartbin01/data"

// topic ที่บอร์ด subscribe ไว้รอรับค่า threshold ใหม่จาก dashboard (ปรับ
// เกณฑ์ "เต็ม"/"เหม็น" จาก backend ได้โดยไม่ต้อง flash โค้ดใหม่)
#define MQTT_CONFIG_TOPIC "smartbin/smartbin01/config"

// topic ที่บอร์ด subscribe ไว้รอรับ "คำสั่ง" จากปุ่มบน dashboard (เช่
น
// ปุ่ม Snooze) ต่างจาก MQTT_CONFIG_TOPIC ตรงที่ payload เป็นคำสั่งให้ทำ
// ทันทีครั้งเดียว ไม่ใช่ค่า config ที่ต้องจำไว้ใช้ต่อเนื่อง
#define MQTT_COMMAND_TOPIC "smartbin/smartbin01/command"

// ส่งข้อมูลขึ้น MQTT ทุกกี่มิลลิวินาที (แยกจากรอบอ่านเซนเซอร์/แสดงผลเดิม
// ที่ยังคงทำงานเร็วตามปกติสำหรับ LED/OLED/buzzer)
// หมายเหตุ: loop() เองก็กิน ~300-450ms/รอบอยู่แล้ว (จาก delay(300) หรือ
// delay(200+150) ในส่วนควบคุม buzzer บวกเวลาอัพเดต OLED ผ่าน I2C) การตั้ง
// ค่านี้ให้ต่ำกว่านั้นจะไม่ช่วยให้ publish ถี่ขึ้นจริง เพราะลูปเองก็ช้ากว่า
#define PUBLISH_INTERVAL_MS 300

// ----- Snooze (ปิดเสียง buzzer ชั่วคราว) -----
// สั่งจากปุ่มบนหน้า dashboard เท่านั้น (ผ่าน MQTT_COMMAND_TOPIC ด้านบน)
// ไม่มีปุ่มกายภาพที่ตัวบอร์ด กดจากหน้าเว็บ 1 ครั้ง = ปิดเสียงไปกี่
// มิลลิวินาที (ค่าเริ่มต้น 5 นาที) LED/OLED ยังคงแสดงสถานะจริงตามปกติ
// แค่ buzzer เท่านั้นที่ถูกปิดชั่วคราว
#define SNOOZE_DURATION_MS 300000UL

#endif
