# collector.py
# -----------------------------------------------------------------
# หน้าที่ของไฟล์นี้: เป็นตัวกลางที่ subscribe ข้อมูลจาก MQTT broker
# แล้วนำมาตรวจสอบความถูกต้อง (validate) ก่อนบันทึกลง MongoDB
# เขียนแบบตรงไปตรงมา ไม่มี class ไม่มี decorator เพื่อให้อ่านง่าย
# (รูปแบบเดียวกับ weather-station/collector/collector.py)
# -----------------------------------------------------------------

import os
import json
import time
from datetime import datetime, timezone, timedelta

import paho.mqtt.client as mqtt
from pymongo import MongoClient
from pymongo.errors import PyMongoError


# ===================================================================
# ส่วนอ่าน config จาก environment variable
# ===================================================================
# หมายเหตุสำคัญ: ที่ต้องเขียนเป็น os.environ.get("KEY") or "default"
# แทนที่จะเขียน os.environ.get("KEY", "default") เฉยๆ เพราะถ้า
# docker compose หาไฟล์ .env ไม่เจอ หรือตัวแปรนั้นถูกตั้งเป็นค่าว่าง
# มันจะยัด environment variable ที่ "มีอยู่จริงแต่ค่าว่าง" (KEY="")
# เข้ามาใน container แทนที่จะไม่ตั้งค่าตัวแปรนั้นเลย ทำให้ .get("KEY", "default")
# เจอ key แล้วคืนค่าว่างกลับมา (ไม่ได้ไปใช้ default ตามที่ตั้งใจ) พอเอาไป
# int("") จะ error ทันทีตอน import ทำให้ container ทั้งตัวขึ้นไม่ได้เลย
# การใช้ "or" จะช่วยดักกรณีค่าว่าง (falsy) ให้ไปใช้ default แทนโดยอัตโนมัติ
MQTT_BROKER = os.environ.get("MQTT_BROKER") or "host.docker.internal"
MQTT_PORT = int(os.environ.get("MQTT_PORT") or "1883")
MQTT_TOPIC = os.environ.get("MQTT_TOPIC") or "smartbin/+/data"

MONGO_URL = os.environ.get("MONGO_URL") or "mongodb://mongodb:27017"
MONGO_DB_NAME = os.environ.get("MONGO_DB_NAME") or "smartbin_db"
MONGO_COLLECTION_NAME = os.environ.get("MONGO_COLLECTION_NAME") or "smartbin_readings"

# เขตเวลาไทย (UTC+7) เก็บไว้เป็นค่าคงที่เพื่อใช้ซ้ำได้หลายจุด
THAILAND_TIMEZONE = timezone(timedelta(hours=7))

# รายชื่อ field ตัวเลขที่ระบบรองรับ ใช้เช็คทั้งชนิดข้อมูลและช่วงค่าที่
# สมเหตุสมผล (อ้างอิงจากช่วงการทำงานจริงของ HC-SR04 กับ MQ-136 บนบอร์ด)
SENSOR_FIELDS_TO_CHECK = ["distance", "mq_value"]

SENSOR_VALID_RANGES = {
    # HC-SR04 ทางร้านระบุระยะวัดได้จริง 2-400 ซม. ค่านอกช่วงนี้ถือว่าผิดปกติ
    "distance": (0.0, 400.0),
    # MQ-136 อ่านผ่าน analogRead ของ ESP8266 ได้ค่าในช่วง 0-1023 เท่านั้น
    "mq_value": (0, 1023),
}

# field ที่เป็น boolean ต้องเช็คแยกจาก field ตัวเลข เพราะ True/False ใน
# python เป็น subclass ของ int ถ้าเอาไปปนกับ SENSOR_FIELDS_TO_CHECK จะ
# ทำให้ค่า boolean หลุดผ่าน is_valid_number() ไปได้โดยไม่ตั้งใจ
BOOLEAN_FIELDS_TO_CHECK = ["hc_full", "mq_danger", "snoozed", "permanent_mute"]


# ===================================================================
# เชื่อมต่อ MongoDB (ทำครั้งเดียวตอนเริ่มโปรแกรม แล้วใช้ connection นี้ซ้ำ)
# ===================================================================
mongo_client = MongoClient(MONGO_URL)
mongo_database = mongo_client[MONGO_DB_NAME]
readings_collection = mongo_database[MONGO_COLLECTION_NAME]

# index ผสม (bin_id, received_at ย้อนหลัง) เพราะทุก query ที่ webapp ยิงมา
# (/latest, /history) กรองด้วย bin_id ก่อนแล้วเรียงตาม received_at จากใหม่
# ไปเก่าเสมอ ถ้าไม่มี index นี้ mongo ต้องกวาดทั้ง collection ทุกครั้งที่
# เรียก ช้าลงเรื่อยๆ ตามจำนวนข้อมูลที่สะสม สร้างซ้ำได้ไม่มีผลเสีย (idempotent)
readings_collection.create_index([("bin_id", 1), ("received_at", -1)])


def is_valid_number(value):
    # ฟังก์ชันนี้เช็คว่าค่าที่ส่งมาเป็นตัวเลข (int หรือ float) จริงๆ หรือไม่
    # ต้องกัน bool ไว้เป็นพิเศษ เพราะใน python บูลีน True/False จริงๆ แล้ว
    # เป็น subclass ของ int (isinstance(True, int) ได้ True) ถ้าไม่กันไว้
    # ข้อมูลที่ส่ง distance เป็น true/false มาจะหลุดผ่านการเช็คไปได้
    if isinstance(value, bool):
        return False
    return isinstance(value, (int, float))


def validate_sensor_reading(sensor_data):
    # ฟังก์ชันนี้ตรวจสอบข้อมูลที่ decode มาแล้วว่าใช้ได้หรือไม่
    # คืนค่าเป็น (True, "") ถ้าผ่าน หรือ (False, "เหตุผลที่ไม่ผ่าน") ถ้าไม่ผ่าน

    if "bin_id" not in sensor_data:
        return False, "ไม่มี field 'bin_id' ในข้อความ"

    for field_name in SENSOR_FIELDS_TO_CHECK:
        if field_name not in sensor_data:
            continue

        field_value = sensor_data[field_name]

        if not is_valid_number(field_value):
            return False, "field '%s' ไม่ใช่ตัวเลข (ได้ค่า: %r)" % (field_name, field_value)

        minimum_valid_value, maximum_valid_value = SENSOR_VALID_RANGES[field_name]
        if field_value < minimum_valid_value or field_value > maximum_valid_value:
            return False, "field '%s' มีค่า %s อยู่นอกช่วงที่สมเหตุสมผล (%s - %s)" % (
                field_name,
                field_value,
                minimum_valid_value,
                maximum_valid_value,
            )

    for field_name in BOOLEAN_FIELDS_TO_CHECK:
        if field_name not in sensor_data:
            continue

        if not isinstance(sensor_data[field_name], bool):
            return False, "field '%s' ต้องเป็น true/false (ได้ค่า: %r)" % (field_name, sensor_data[field_name])

    return True, ""


def on_connect(client, userdata, flags, reason_code, properties=None):
    print("[MQTT] เชื่อมต่อ broker สำเร็จ (reason_code=%s)" % reason_code)
    client.subscribe(MQTT_TOPIC)
    print("[MQTT] subscribe topic: %s" % MQTT_TOPIC)


def on_disconnect(client, userdata, flags, reason_code, properties=None):
    print("[MQTT] การเชื่อมต่อหลุด (reason_code=%s) กำลังรอ reconnect อัตโนมัติ..." % reason_code)


def on_message(client, userdata, message):
    print("[MQTT] ได้รับข้อความจาก topic: %s" % message.topic)

    try:
        raw_payload_text = message.payload.decode("utf-8")
    except UnicodeDecodeError as decode_error:
        print("[ERROR] decode payload เป็น utf-8 ไม่ได้: %s" % decode_error)
        return

    print("[MQTT] payload: %s" % raw_payload_text)

    try:
        sensor_data = json.loads(raw_payload_text)
    except json.JSONDecodeError as json_error:
        print("[ERROR] payload ไม่ใช่ JSON ที่ถูกต้อง: %s" % json_error)
        return

    is_valid, invalid_reason = validate_sensor_reading(sensor_data)
    if not is_valid:
        print("[VALIDATION] ข้อมูลไม่ผ่านการตรวจสอบ: %s" % invalid_reason)
        return

    print("[VALIDATION] ข้อมูลผ่านการตรวจสอบเรียบร้อย")

    sensor_data["received_at"] = datetime.now(THAILAND_TIMEZONE)

    try:
        insert_result = readings_collection.insert_one(sensor_data)
        print("[MONGO] บันทึกข้อมูลสำเร็จ (id=%s)" % insert_result.inserted_id)
    except PyMongoError as mongo_error:
        print("[ERROR] บันทึกข้อมูลลง MongoDB ไม่สำเร็จ: %s" % mongo_error)


def main():
    print("[STARTUP] กำลังเริ่ม collector...")
    print("[STARTUP] MQTT broker = %s:%s" % (MQTT_BROKER, MQTT_PORT))
    print("[STARTUP] MongoDB = %s (db=%s, collection=%s)" % (
        MONGO_URL, MONGO_DB_NAME, MONGO_COLLECTION_NAME
    ))

    mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    mqtt_client.on_connect = on_connect
    mqtt_client.on_disconnect = on_disconnect
    mqtt_client.on_message = on_message

    while True:
        try:
            mqtt_client.connect(MQTT_BROKER, MQTT_PORT)
            break
        except Exception as connect_error:
            print("[ERROR] เชื่อมต่อ MQTT broker ไม่ได้: %s (จะลองใหม่ใน 5 วินาที)" % connect_error)
            time.sleep(5)

    mqtt_client.loop_forever()


if __name__ == "__main__":
    main()
