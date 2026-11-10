// init-mongo.js
// -------------------------------------------------------------
// สคริปต์กำหนดค่าเริ่มต้นสำหรับ MongoDB Container (smartbin_db)
// รันอัตโนมัติเมื่อสร้าง Database Volume ใหม่ผ่าน Docker
// -------------------------------------------------------------

db = db.getSiblingDB("smartbin_db");

// 1. สร้าง Collection smartbin_readings และ Index เพื่อความเร็วในการ Query ประวัติย้อนหลัง
db.createCollection("smartbin_readings");
db.smartbin_readings.createIndex({ "bin_id": 1, "received_at": -1 });

// 2. สร้าง Collection smartbin_thresholds และ Unique Index ประจำแต่ละถัง
db.createCollection("smartbin_thresholds");
db.smartbin_thresholds.createIndex({ "bin_id": 1 }, { unique: true });

// 3. กำหนดค่า Threshold เริ่มต้นให้ถัง smartbin01
db.smartbin_thresholds.updateOne(
  { bin_id: "smartbin01" },
  {
    $setOnInsert: {
      bin_id: "smartbin01",
      mq_danger: 600,
      full_distance: 4.0,
      updated_at: new Date()
    }
  },
  { upsert: true }
);

print("[init-mongo.js] Database 'smartbin_db' initialized successfully.");
