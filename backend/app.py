# app.py
# -----------------------------------------------------------------
# FastAPI application ที่เปิด API ให้หน้า dashboard ดึงข้อมูลไปแสดงผล และ
# รับค่า threshold ใหม่จากแถบเลื่อน (slider) แล้ว publish กลับไปหาบอร์ด
# ผ่าน MQTT (topic "<prefix>/<bin_id>/config") เขียนแบบตรงไปตรงมา ไม่มี
# class เพิ่มเติม (นอกจากที่ FastAPI บังคับให้ใช้) รูปแบบเดียวกับ
# weather-station/webapp/app.py
# -----------------------------------------------------------------

import os
import re
import logging
from datetime import datetime, timezone, timedelta

import paho.mqtt.client as mqtt
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pymongo import MongoClient, DESCENDING
from pymongo.errors import PyMongoError


# ===================================================================
# ตั้งค่า logging ให้มี timestamp กำกับทุกบรรทัด ระดับ INFO ขึ้นไป
# ===================================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("smartbin_webapp")


# ===================================================================
# อ่าน config จาก environment variable
# หมายเหตุ: ใช้ "or" แทน default ตัวที่สองของ .get() เพื่อกันกรณีที่
# ตัวแปรถูกส่งมาเป็น string ว่าง "" จาก docker compose (ดูคำอธิบายเต็ม
# ในไฟล์ collector/collector.py) ไม่งั้น int("") จะทำให้ import พังทันที
# ===================================================================
MONGO_URL = os.environ.get("MONGO_URL") or "mongodb://mongodb:27017"
MONGO_DB_NAME = os.environ.get("MONGO_DB_NAME") or "smartbin_db"
MONGO_COLLECTION_NAME = os.environ.get("MONGO_COLLECTION_NAME") or "smartbin_readings"
MONGO_THRESHOLD_COLLECTION_NAME = os.environ.get("MONGO_THRESHOLD_COLLECTION_NAME") or "smartbin_thresholds"

KNOWN_BINS_RAW = os.environ.get("KNOWN_BINS") or "smartbin01"
KNOWN_BINS = [bin_name.strip() for bin_name in KNOWN_BINS_RAW.split(",") if bin_name.strip()]


# bin_id ไปอยู่ใน MQTT topic และ query MongoDB จึงต้องจำกัดรูปแบบให้ตรงกัน
# (กัน topic injection เช่น "+" "#" "/" และกัน XSS ฝั่งหน้าเว็บ)
BIN_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def valid_bin_id(bin_id: str) -> str:
    if not BIN_ID_PATTERN.fullmatch(bin_id):
        raise HTTPException(status_code=400, detail="bin_id ไม่ถูกต้อง (ใช้ได้เฉพาะ A-Z a-z 0-9 _ - ไม่เกิน 32 ตัว)")
    return bin_id


def known_bin_id(bin_id: str = Depends(valid_bin_id)) -> str:
    # endpoint ที่ส่งคำสั่งหรือเขียนข้อมูล ต้องเป็นถังที่ระบบรู้จักเท่านั้น
    try:
        known = set(KNOWN_BINS) | set(readings_collection.distinct("bin_id"))
    except PyMongoError:
        known = set(KNOWN_BINS)
    if bin_id not in known:
        raise HTTPException(status_code=404, detail="ไม่รู้จักถังนี้")
    return bin_id

BIN_OFFLINE_THRESHOLD_SECONDS = int(os.environ.get("BIN_OFFLINE_THRESHOLD_SECONDS") or "30")

MQTT_BROKER = os.environ.get("MQTT_BROKER") or "host.docker.internal"
MQTT_PORT = int(os.environ.get("MQTT_PORT") or "1883")
MQTT_CONFIG_TOPIC_PREFIX = os.environ.get("MQTT_CONFIG_TOPIC_PREFIX") or "smartbin"

MQ_DANGER_DEFAULT = int(os.environ.get("MQ_DANGER_DEFAULT") or "600")
FULL_DISTANCE_DEFAULT = float(os.environ.get("FULL_DISTANCE_DEFAULT") or "4.0")

# เขตเวลาไทย (UTC+7)
THAILAND_TIMEZONE = timezone(timedelta(hours=7))


# ===================================================================
# เชื่อมต่อ MongoDB
# ===================================================================
mongo_client = MongoClient(MONGO_URL, tz_aware=True, tzinfo=THAILAND_TIMEZONE)
mongo_database = mongo_client[MONGO_DB_NAME]
readings_collection = mongo_database[MONGO_COLLECTION_NAME]
thresholds_collection = mongo_database[MONGO_THRESHOLD_COLLECTION_NAME]

# index ผสมตัวเดียวกับที่ collector.py สร้างไว้ (สร้างซ้ำได้ไม่มีผลเสีย
# idempotent) กันไว้เผื่อ webapp ถูก deploy ก่อน collector รอบแรก
readings_collection.create_index([("bin_id", 1), ("received_at", -1)])

# thresholds ต้องมี bin_id ไม่ซ้ำกันเสมอ (เราใช้ upsert ตาม bin_id อยู่แล้ว
# ใน update_bin_threshold() ด้านล่าง) ใส่ unique index ไว้กันไว้อีกชั้น
# เผื่อมี path อื่นในอนาคตที่ insert ตรงๆ โดยไม่ผ่าน upsert
thresholds_collection.create_index("bin_id", unique=True)


# ===================================================================
# ต่อ MQTT client ไว้สำหรับ "publish" ค่า threshold ใหม่กลับไปหาบอร์ด
# เท่านั้น (webapp ไม่ subscribe อะไรเลย หน้าที่ subscribe/บันทึกข้อมูล
# เป็นของ collector.py) ลองต่อครั้งเดียวตอน startup แบบไม่ block นาน
# เกินไป ถ้าต่อไม่ติดตอนนี้ ให้ publish_bin_threshold() ลองต่อใหม่อีกที
# ตอนมีคนกดบันทึกค่าจริงๆ แทน เพราะ endpoint ไม่ควรรอ broker เป็นนาที
# ===================================================================
mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

try:
    mqtt_client.connect(MQTT_BROKER, MQTT_PORT)
    mqtt_client.loop_start()
    logger.info("เชื่อมต่อ MQTT broker สำเร็จ (%s:%s)", MQTT_BROKER, MQTT_PORT)
except Exception as connect_error:
    logger.warning("เชื่อมต่อ MQTT broker ตอน startup ไม่สำเร็จ: %s (จะลองใหม่ตอน publish)", connect_error)


def publish_bin_threshold(bin_id, mq_danger_value, full_distance_value):
    # คืนค่า True ถ้า publish สำเร็จ, False ถ้าไม่สำเร็จ (เช่น broker ล่ม)
    # การบันทึกค่าลง MongoDB ยังทำต่อได้ตามปกติแม้ publish จะไม่สำเร็จ
    # เพราะบอร์ดจะได้ค่านี้อัตโนมัติจาก retained message ตอนมันต่อ broker
    # ติดครั้งถัดไปอยู่ดี (ดู retain=True ด้านล่าง)
    if not mqtt_client.is_connected():
        try:
            mqtt_client.reconnect()
        except Exception as reconnect_error:
            logger.error("reconnect MQTT broker ไม่สำเร็จ: %s", reconnect_error)
            return False

    config_topic = "%s/%s/config" % (MQTT_CONFIG_TOPIC_PREFIX, bin_id)
    payload = "{\"mq_danger\":%s,\"full_distance\":%s}" % (mq_danger_value, full_distance_value)

    # retain=True เพื่อให้ broker เก็บข้อความล่าสุดไว้ให้ ถ้าตอนที่กดบันทึก
    # บอร์ดปิดอยู่หรือหลุดการเชื่อมต่อพอดี บอร์ดจะได้รับค่านี้ทันทีที่มัน
    # subscribe topic นี้สำเร็จในครั้งถัดไป ไม่ต้องรอให้มีคนกดบันทึกซ้ำ
    publish_result = mqtt_client.publish(config_topic, payload, retain=True)
    publish_result.wait_for_publish(timeout=5)

    logger.info("publish ไปที่ topic %s: %s", config_topic, payload)
    return publish_result.is_published()


def publish_bin_command(bin_id, action):
    # ต่างจาก publish_bin_threshold() ตรงที่ "ไม่" ใช้ retain=True เพราะ
    # นี่คือคำสั่งให้ทำทันทีครั้งเดียว (เช่น Snooze) ไม่ใช่ค่า config ที่
    # ต้องจำไว้ใช้ต่อเนื่อง ถ้าตอนกดปุ่มบอร์ดออฟไลน์อยู่พอดี คำสั่งนี้ก็ควร
    # หายไปเฉยๆ ไม่ควรค้างรอส่งซ้ำตอนบอร์ดกลับมาออนไลน์ทีหลัง (ตอนนั้น
    # เสียงอาจไม่ได้ดังอยู่แล้วก็ได้ ไม่มีอะไรให้ snooze อีกต่อไป)
    if not mqtt_client.is_connected():
        try:
            mqtt_client.reconnect()
        except Exception as reconnect_error:
            logger.error("reconnect MQTT broker ไม่สำเร็จ: %s", reconnect_error)
            return False

    command_topic = "%s/%s/command" % (MQTT_CONFIG_TOPIC_PREFIX, bin_id)
    payload = "{\"action\":\"%s\"}" % action

    publish_result = mqtt_client.publish(command_topic, payload, retain=False)
    publish_result.wait_for_publish(timeout=5)

    logger.info("publish ไปที่ topic %s: %s", command_topic, payload)
    return publish_result.is_published()


app = FastAPI(title="Smart Bin Monitoring System")


@app.middleware("http")
async def log_every_request(request: Request, call_next):
    # ต้องเป็น "async def" เพราะข้างในเรียก "await call_next(request)" ซึ่ง
    # เป็นกลไกภายในของ FastAPI/Starlette ที่บังคับให้ middleware เป็น async
    # เท่านั้น (ข้อยกเว้นจากกติกา "ไม่ต้องใช้ async/await" ของโปรเจกต์นี้
    # เพราะจุดนี้ framework บังคับ ไม่ใช่ทางเลือกของเรา)
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    logger.info(
        "%s %s -> %s",
        request.method,
        request.url.path,
        response.status_code,
    )
    return response


def is_valid_number(value):
    # เหตุผลเดียวกับ collector.py: ต้องกัน bool ไว้เป็นพิเศษ เพราะใน python
    # บูลีนเป็น subclass ของ int
    if isinstance(value, bool):
        return False
    return isinstance(value, (int, float))


def convert_document_for_response(document):
    document["_id"] = str(document["_id"])
    if "received_at" in document and document["received_at"] is not None:
        document["received_at"] = document["received_at"].isoformat()
    return document


@app.get("/")
def read_dashboard_page():
    return FileResponse("static/index.html")


@app.get("/api/config")
def get_frontend_config():
    # ส่งค่า threshold ให้หน้าเว็บใช้คำนวณสถานะ ONLINE/OFFLINE เอง
    return {"offline_threshold_seconds": BIN_OFFLINE_THRESHOLD_SECONDS}


@app.get("/api/bins")
def get_all_bins():
    try:
        bins_found_in_database = readings_collection.distinct("bin_id")
        all_bin_names = set(KNOWN_BINS) | set(bins_found_in_database)
        return sorted(all_bin_names)
    except PyMongoError as mongo_error:
        logger.error("เรียก distinct bin_id จาก MongoDB ไม่สำเร็จ: %s", mongo_error)
        return sorted(KNOWN_BINS)


@app.get("/api/bins/{bin_id}/latest")
def get_latest_reading(bin_id: str = Depends(valid_bin_id)):
    try:
        latest_document = readings_collection.find_one(
            {"bin_id": bin_id},
            sort=[("received_at", DESCENDING)],
        )
    except PyMongoError as mongo_error:
        logger.error("query ค่าล่าสุดของถัง '%s' ไม่สำเร็จ: %s", bin_id, mongo_error)
        raise HTTPException(status_code=500, detail="เกิดข้อผิดพลาดในการดึงข้อมูลจากฐานข้อมูล")

    if latest_document is None:
        raise HTTPException(status_code=404, detail="ยังไม่มีข้อมูลของถังนี้")

    return convert_document_for_response(latest_document)


@app.get("/api/bins/{bin_id}/history")
def get_reading_history(bin_id: str = Depends(valid_bin_id), limit: int = 100):
    if limit <= 0:
        raise HTTPException(status_code=400, detail="limit ต้องเป็นจำนวนเต็มบวก")

    try:
        history_cursor = (
            readings_collection.find({"bin_id": bin_id})
            .sort("received_at", DESCENDING)
            .limit(limit)
        )
        history_documents = [convert_document_for_response(document) for document in history_cursor]
    except PyMongoError as mongo_error:
        logger.error("query ประวัติของถัง '%s' ไม่สำเร็จ: %s", bin_id, mongo_error)
        raise HTTPException(status_code=500, detail="เกิดข้อผิดพลาดในการดึงข้อมูลจากฐานข้อมูล")

    return history_documents


@app.get("/api/bins/{bin_id}/threshold")
def get_bin_threshold(bin_id: str = Depends(valid_bin_id)):
    try:
        threshold_document = thresholds_collection.find_one({"bin_id": bin_id})
    except PyMongoError as mongo_error:
        logger.error("query threshold ของถัง '%s' ไม่สำเร็จ: %s", bin_id, mongo_error)
        raise HTTPException(status_code=500, detail="เกิดข้อผิดพลาดในการดึงข้อมูลจากฐานข้อมูล")

    if threshold_document is None:
        # ยังไม่เคยมีใครตั้งค่าเองมาก่อน ส่งค่า default กลับไปให้ slider ใช้
        return {"bin_id": bin_id, "mq_danger": MQ_DANGER_DEFAULT, "full_distance": FULL_DISTANCE_DEFAULT}

    return convert_document_for_response(threshold_document)


@app.post("/api/bins/{bin_id}/threshold")
async def update_bin_threshold(request: Request, bin_id: str = Depends(known_bin_id)):
    # ต้องเป็น "async def" เพราะข้างในเรียก "await request.json()" (เหตุผล
    # เดียวกับ middleware ด้านบน เป็นกติกาที่ FastAPI บังคับ)
    try:
        request_body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="ต้องส่ง JSON body")

    if "mq_danger" not in request_body or "full_distance" not in request_body:
        raise HTTPException(status_code=400, detail="ต้องมี field 'mq_danger' และ 'full_distance'")

    mq_danger_value = request_body["mq_danger"]
    full_distance_value = request_body["full_distance"]

    if not is_valid_number(mq_danger_value) or mq_danger_value < 0 or mq_danger_value > 1023:
        raise HTTPException(status_code=400, detail="mq_danger ต้องเป็นตัวเลขในช่วง 0-1023")

    if not is_valid_number(full_distance_value) or full_distance_value <= 0 or full_distance_value > 400:
        raise HTTPException(status_code=400, detail="full_distance ต้องเป็นตัวเลขมากกว่า 0 และไม่เกิน 400")

    threshold_document = {
        "bin_id": bin_id,
        "mq_danger": mq_danger_value,
        "full_distance": full_distance_value,
        "updated_at": datetime.now(THAILAND_TIMEZONE),
    }

    try:
        thresholds_collection.update_one(
            {"bin_id": bin_id},
            {"$set": threshold_document},
            upsert=True,
        )
    except PyMongoError as mongo_error:
        logger.error("บันทึก threshold ของถัง '%s' ไม่สำเร็จ: %s", bin_id, mongo_error)
        raise HTTPException(status_code=500, detail="บันทึกค่าลงฐานข้อมูลไม่สำเร็จ")

    published_successfully = publish_bin_threshold(bin_id, mq_danger_value, full_distance_value)

    return {
        "saved": True,
        "published_to_device": published_successfully,
        "bin_id": bin_id,
        "mq_danger": mq_danger_value,
        "full_distance": full_distance_value,
    }


@app.post("/api/bins/{bin_id}/snooze")
async def snooze_bin(bin_id: str = Depends(known_bin_id), request: Request = None):
    # ปุ่ม Snooze หรือโหมดปิดเสียงบน dashboard เรียก endpoint นี้
    # รองรับ action ผ่าน body: "snooze", "permanent_mute", "unsnooze"
    action = "snooze"
    if request:
        try:
            body = await request.json()
            if isinstance(body, dict):
                act = body.get("action")
                if act in ["unsnooze", "cancel", "cancel_snooze", "unmute"]:
                    action = "unsnooze"
                elif act in ["permanent_mute", "mute_permanent", "away"]:
                    action = "permanent_mute"
        except Exception:
            pass

    sent_successfully = publish_bin_command(bin_id, action)

    if not sent_successfully:
        raise HTTPException(status_code=503, detail="ส่งคำสั่ง %s ไปที่บอร์ดไม่สำเร็จ (broker ไม่ตอบสนอง)" % action)

    return {"sent": True, "bin_id": bin_id, "action": action}


@app.post("/api/bins/{bin_id}/mute_permanent")
def mute_permanent_bin(bin_id: str = Depends(known_bin_id)):
    # คำสั่งปิดเสียงถาวร (โหมดไม่อยู่บ้าน) ไม่หมดเวลาจนกว่าจะกดเปิดเสียงคืน
    sent_successfully = publish_bin_command(bin_id, "permanent_mute")

    if not sent_successfully:
        raise HTTPException(status_code=503, detail="ส่งคำสั่ง permanent_mute ไปที่บอร์ดไม่สำเร็จ (broker ไม่ตอบสนอง)")

    return {"sent": True, "bin_id": bin_id, "action": "permanent_mute"}


@app.post("/api/bins/{bin_id}/unsnooze")
def unsnooze_bin(bin_id: str = Depends(known_bin_id)):
    # คำสั่งเปิดเสียงเตือนคืนทันที (ยกเลิกทั้ง Snooze และปิดเสียงถาวร)
    sent_successfully = publish_bin_command(bin_id, "unsnooze")

    if not sent_successfully:
        raise HTTPException(status_code=503, detail="ส่งคำสั่ง unsnooze ไปที่บอร์ดไม่สำเร็จ (broker ไม่ตอบสนอง)")

    return {"sent": True, "bin_id": bin_id, "action": "unsnooze"}


# mount โฟลเดอร์ static ไว้ท้ายไฟล์เสมอ เพื่อให้ browser เข้าถึงไฟล์อย่าง
# index.html และ chart.umd.js ผ่าน url ที่ขึ้นต้นด้วย /static/ ได้
app.mount("/static", StaticFiles(directory="static"), name="static")
