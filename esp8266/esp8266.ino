// esp8266.ino
// -----------------------------------------------------------------
// ก่อนใช้งานต้องติดตั้ง library เหล่านี้ผ่าน Arduino Library Manager ก่อน:
//   1. "Adafruit GFX Library"
//   2. "Adafruit SSD1306"
//   3. "PubSubClient" ของ Nick O'Leary
// -----------------------------------------------------------------
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include "config.h"

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

unsigned long lastPublishTimeMs = 0;

// ---------------- Snooze & Permanent Mute ----------------
// สั่งงานจากปุ่มบนหน้า dashboard เท่านั้น (ผ่าน MQTT_COMMAND_TOPIC) ไม่มี
// ปุ่มกายภาพที่ตัวบอร์ด
bool snoozeActive = false;       // ปิดเสียงชั่วคราว 5 นาที (หรือเปิดคืนอัตโนมัติเมื่อเทขยะ)
bool permanentMute = false;      // ปิดเสียงถาวร (โหมดไม่อยู่บ้าน ปิดยาวๆ จนกว่าจะกดเปิดเสียงคืน)
unsigned long snoozeUntilMs = 0;

// =====================================================
// OLED 0.96" I2C
// =====================================================

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1

#define OLED_SCL D3
#define OLED_SDA D4

Adafruit_SSD1306 display(
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  &Wire,
  OLED_RESET
);


// =====================================================
// LED
// =====================================================

#define LED_RED     D1
#define LED_YELLOW  D2
#define LED_GREEN   D5


// =====================================================
// HC-SR04
// =====================================================

#define TRIG_PIN D6
#define ECHO_PIN D7


// =====================================================
// MQ-136
// =====================================================

#define MQ136_PIN A0


// =====================================================
// BUZZER
// =====================================================

#define BUZZER_PIN D0


// =====================================================
// Threshold
// =====================================================

// ค่าเริ่มต้นตอนบูต (ก่อนได้รับ config จาก MQTT_CONFIG_TOPIC) ส่วนค่าที่
// ใช้งานจริงระหว่างทำงานเก็บไว้ในตัวแปรด้านล่าง เพื่อให้ dashboard ปรับ
// เกณฑ์ "เหม็น"/"เต็ม" จากระยะไกลได้โดยไม่ต้อง flash โค้ดใหม่ทุกครั้ง

// MQ-136 RAW สำหรับทดลอง
#define MQ_DANGER_DEFAULT 600

// ระยะที่ถือว่า "เต็ม"
#define FULL_DISTANCE_DEFAULT 4.0

int mqDangerThreshold = MQ_DANGER_DEFAULT;
float fullDistanceThreshold = FULL_DISTANCE_DEFAULT;


// =====================================================
// WiFi / MQTT
// =====================================================

void connectToWifi() {
  Serial.println("WiFi Connecting...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("");
  Serial.println("WiFi Connected");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
}


void connectToMqttBroker() {
  // วนลูป reconnect ไปเรื่อยๆ ทุก 5 วินาทีจนกว่าจะต่อ broker ติด
  while (!mqttClient.connected()) {
    Serial.println("MQTT Connecting...");

    // ใช้ BIN_ID เป็นชื่อ client เพื่อไม่ให้ชนกับถังอื่นที่ต่อเข้า
    // broker เดียวกัน (ถ้าชื่อ client ซ้ำกัน broker จะเตะตัวเก่าออก)
    if (mqttClient.connect(BIN_ID)) {
      Serial.println("MQTT Connected");

      // subscribe topic config/command ทุกครั้งที่ (re)connect เพราะ broker
      // ไม่จำ subscription เดิมไว้ให้หลัง client หลุดแล้วต่อใหม่
      mqttClient.subscribe(MQTT_CONFIG_TOPIC);
      Serial.print("Subscribe topic: ");
      Serial.println(MQTT_CONFIG_TOPIC);

      mqttClient.subscribe(MQTT_COMMAND_TOPIC);
      Serial.print("Subscribe topic: ");
      Serial.println(MQTT_COMMAND_TOPIC);

    } else {
      Serial.print("MQTT Connect Failed, rc=");
      Serial.println(mqttClient.state());
      delay(5000);
    }
  }
}


// ดึงค่าตัวเลขของ key ที่ระบุออกจาก JSON string ง่ายๆ ด้วยการหาตำแหน่ง
// "key": แล้วอ่านตัวเลขที่ตามมา (ไม่ใช้ library แยกเพราะ payload มีแค่
// 1-2 field เท่านั้น) คืนค่า NAN ถ้าไม่เจอ key นี้ในข้อความ
float extractJsonNumber(const String &json, const String &key) {

  String searchKey = "\"" + key + "\":";
  int keyIndex = json.indexOf(searchKey);

  if (keyIndex == -1) {
    return NAN;
  }

  int valueStart = keyIndex + searchKey.length();
  int valueEnd = valueStart;

  while (valueEnd < (int)json.length() &&
         (isDigit(json[valueEnd]) || json[valueEnd] == '.' || json[valueEnd] == '-')) {
    valueEnd++;
  }

  if (valueEnd == valueStart) {
    return NAN;
  }

  return json.substring(valueStart, valueEnd).toFloat();
}


// callback นี้ถูกเรียกอัตโนมัติทุกครั้งที่มีข้อความใหม่เข้ามาจาก topic
// ที่ subscribe ไว้ (MQTT_CONFIG_TOPIC สำหรับปรับ threshold, MQTT_COMMAND_TOPIC
// สำหรับคำสั่งจากปุ่มบน dashboard เช่น Snooze) แยกการทำงานตาม topic ที่
// ข้อความนั้นเข้ามา เพราะ payload ของแต่ละ topic มีความหมายคนละแบบกัน
void onMqttMessage(char* topic, byte* payload, unsigned int length) {

  String message;
  message.reserve(length);

  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.print("ได้รับข้อความจาก topic ");
  Serial.print(topic);
  Serial.print(": ");
  Serial.println(message);

  String topicText = String(topic);

  if (topicText == MQTT_CONFIG_TOPIC) {
    handleConfigMessage(message);
  } else if (topicText == MQTT_COMMAND_TOPIC) {
    handleCommandMessage(message);
  }
}


void handleConfigMessage(const String &message) {

  float newMqDanger = extractJsonNumber(message, "mq_danger");
  float newFullDistance = extractJsonNumber(message, "full_distance");

  // MQ-136 อ่านผ่าน analogRead ของ ESP8266 ได้ค่าในช่วง 0-1023 เท่านั้น
  // ถ้าค่าที่ส่งมาเกินช่วงนี้แปลว่าผิดปกติ ไม่นำมาใช้
  if (!isnan(newMqDanger) && newMqDanger >= 0 && newMqDanger <= 1023) {
    mqDangerThreshold = (int)newMqDanger;
    Serial.print("ปรับ mq_danger threshold เป็น: ");
    Serial.println(mqDangerThreshold);
  }

  // ระยะเต็มถังต้องมากกว่า 0 และไม่เกินระยะสูงสุดที่ HC-SR04 วัดได้จริง
  if (!isnan(newFullDistance) && newFullDistance > 0 && newFullDistance <= 400) {
    fullDistanceThreshold = newFullDistance;
    Serial.print("ปรับ full_distance threshold เป็น: ");
    Serial.println(fullDistanceThreshold);
  }
}


void handleCommandMessage(const String &message) {

  // คำสั่งจาก dashboard:
  // {"action":"unsnooze"} / {"action":"unmute"} -> ยกเลิกการปิดเสียงทุกแบบ และเปิดเสียงเตือนคืนทันที
  // {"action":"permanent_mute"} / {"action":"away"} -> ปิดเสียงถาวร (โหมดไม่อยู่บ้าน)
  // {"action":"snooze"} / {"action":"mute"} -> ปิดเสียงชั่วคราว (Snooze 5 นาที)
  // หมายเหตุ: ตรวจสอบ "unsnooze" และ "permanent_mute" ก่อน "snooze"/"mute" เสมอ
  if (message.indexOf("unsnooze") != -1 || message.indexOf("cancel_snooze") != -1 || message.indexOf("unmute") != -1) {
    cancelMuteAll();
  } else if (message.indexOf("permanent_mute") != -1 || message.indexOf("mute_permanent") != -1 || message.indexOf("away") != -1) {
    activatePermanentMute();
  } else if (message.indexOf("snooze") != -1 || message.indexOf("mute") != -1) {
    activateSnooze();
  }
}


void publishSensorData(float distance, int mqValue,
                        bool hcFull, bool mqDanger) {

  // ถ้าอ่านระยะไม่ได้ (sensor error) ยังไม่ publish ค่านั้นออกไป
  // เพราะ -1 ไม่ใช่ระยะจริง จะทำให้ข้อมูลฝั่ง server เพี้ยน
  if (distance < 0) {
    Serial.println("ระยะจาก HC-SR04 อ่านไม่ได้ ข้าม publish รอบนี้ไป");
    return;
  }

  bool isMuted = (snoozeActive || permanentMute);

  String jsonMessage = "{\"bin_id\":\"" + String(BIN_ID) +
                        "\",\"distance\":" + String(distance, 1) +
                        ",\"mq_value\":" + String(mqValue) +
                        ",\"hc_full\":" + String(hcFull ? "true" : "false") +
                        ",\"mq_danger\":" + String(mqDanger ? "true" : "false") +
                        ",\"snoozed\":" + String(isMuted ? "true" : "false") +
                        ",\"permanent_mute\":" + String(permanentMute ? "true" : "false") + "}";

  mqttClient.publish(MQTT_TOPIC, jsonMessage.c_str());

  Serial.print("Publish ไปที่ topic ");
  Serial.print(MQTT_TOPIC);
  Serial.print(": ");
  Serial.println(jsonMessage);
}


// =====================================================
// อ่านระยะ HC-SR04
// =====================================================

float readDistance() {

  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);

  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration =
      pulseIn(ECHO_PIN, HIGH, 30000);

  if (duration == 0) {
    return -1;
  }

  return duration * 0.0343 / 2.0;
}


// =====================================================
// LED
// =====================================================

void setLED(bool red, bool yellow, bool green) {

  digitalWrite(LED_RED, red);
  digitalWrite(LED_YELLOW, yellow);
  digitalWrite(LED_GREEN, green);
}


// =====================================================
// แสดง OLED
// =====================================================

void showOLED(float distance, int mqValue,
              bool hcFull, bool mqDanger, bool snoozed, bool permanentMuted) {

  display.clearDisplay();

  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);


  // ===================================================
  // ROW 1 : DISTANCE
  // ===================================================

  display.setCursor(0, 5);

  display.print("DIST: ");

  if (distance < 0) {

    display.print("ERROR");

  } else {

    display.print(distance, 1);
    display.print("cm");

    if (hcFull) {
      display.print(" FULL");
    }
  }


  // ===================================================
  // ROW 2 : MQ-136
  // ===================================================

  display.setCursor(0, 25);

  display.print("MQ: ");
  display.print(mqValue);

  if (mqDanger) {

    display.print(" SMELLY");

  } else {

    display.print(" OK");
  }


  // ===================================================
  // ROW 3 : STATUS
  // ===================================================

  display.setCursor(0, 45);

  display.print("STATUS: ");

  if (hcFull || mqDanger) {

    display.print("CHANGE");

  } else {

    display.print("NORMAL");
  }

  if (permanentMuted) {
    display.print(" (MUTED)");
  } else if (snoozed) {
    display.print(" (SNOOZE)");
  }


  display.display();
}


// =====================================================
// Snooze & Permanent Mute (สั่งจาก dashboard ผ่าน MQTT)
// =====================================================

void activateSnooze() {
  snoozeActive = true;
  permanentMute = false;
  snoozeUntilMs = millis() + SNOOZE_DURATION_MS;
  lastPublishTimeMs = 0; // ส่งข้อมูลสถานะ snoozed: true ออก MQTT ทันที

  noTone(BUZZER_PIN);

  Serial.print("ได้รับคำสั่ง Snooze จาก dashboard -> ปิดเสียงไปอีก ");
  Serial.print(SNOOZE_DURATION_MS / 1000);
  Serial.println(" วินาที (ไฟแดงยังแสดงตามปกติ และหากพ้นสีแดงจะเปิดเสียงคืนทันที)");
}

void activatePermanentMute() {
  permanentMute = true;
  snoozeActive = false;
  snoozeUntilMs = 0;
  lastPublishTimeMs = 0; // ส่งข้อมูลสถานะ permanent_mute: true ออก MQTT ทันที

  noTone(BUZZER_PIN);

  Serial.println("ได้รับคำสั่งปิดเสียงถาวร (โหมดไม่อยู่บ้าน) -> ปิดเสียงจนกว่าจะมีคำสั่งเปิดคืน (ไฟแดงยังแสดงตามปกติ)");
}

void cancelMuteAll() {
  snoozeActive = false;
  permanentMute = false;
  snoozeUntilMs = 0;
  lastPublishTimeMs = 0; // ส่งข้อมูลสถานะ snoozed: false ออก MQTT ทันที
  Serial.println("ได้รับคำสั่งเปิดเสียงคืนจาก dashboard -> เปิดเสียงเตือนคืนทันที");
}

void updateSnoozeState(float distance, int mqValue, bool hcFull, bool mqDanger) {
  // หากอยู่ในโหมดปิดเสียงถาวร (ไม่อยู่บ้าน) จะไม่ยกเลิกอัตโนมัติ ต้องรอคำสั่งเปิดคืนด้วยตนเอง
  if (permanentMute) {
    return;
  }

  if (!snoozeActive) {
    return;
  }

  bool isRed = (hcFull || mqDanger);

  // เงื่อนไข 1: พ้นสีแดงก่อนครบเวลา (เช่น นำขยะไปทิ้งแล้ว หรือกลิ่นจางลงแล้ว)
  // ต้องตรวจสอบว่าระยะอ่านได้จริง (distance >= 0) เพื่อไม่ให้ sensor error (-1) ถูกนับว่าพ้นสีแดง
  if (distance >= 0 && !isRed) {
    snoozeActive = false;
    Serial.println(">> ขยะพ้นสถานะสีแดงแล้ว (นำขยะไปทิ้งแล้ว) -> เปิดเสียงคืนทันที ไม่ต้องรอครบเวลา");
    publishSensorData(distance, mqValue, hcFull, mqDanger);
  }
  // เงื่อนไข 2: ครบกำหนดเวลา Snooze แล้ว แต่ขยะยังอยู่ (ยังเป็นสีแดง)
  else if (millis() >= snoozeUntilMs) {
    snoozeActive = false;
    Serial.println(">> หมดเวลา Snooze แล้ว (ยังมีขยะอยู่) -> กลับมาส่งเสียงเตือนตามปกติ");
    publishSensorData(distance, mqValue, hcFull, mqDanger);
  }
}


// =====================================================
// SETUP
// =====================================================

void setup() {

  Serial.begin(115200);


  // ---------------- LED ----------------

  pinMode(LED_RED, OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);


  // ---------------- HC ----------------

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  digitalWrite(TRIG_PIN, LOW);


  // ---------------- BUZZER ----------------

  pinMode(BUZZER_PIN, OUTPUT);

  noTone(BUZZER_PIN);


  // ---------------- OLED ----------------

  Wire.begin(OLED_SDA, OLED_SCL);

  if (!display.begin(
        SSD1306_SWITCHCAPVCC,
        0x3C)) {

    Serial.println("OLED ERROR!");

    while (true) {
      delay(100);
    }
  }


  // OLED Start Screen

  display.clearDisplay();

  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  display.setCursor(15, 15);
  display.println("SMART BIN");

  display.setCursor(15, 35);
  display.println("SYSTEM START");

  display.display();

  delay(1500);


  Serial.println();
  Serial.println("====================");
  Serial.println(" SMART BIN START");
  Serial.println("====================");


  // ---------------- WiFi / MQTT ----------------

  connectToWifi();

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(onMqttMessage);
}


// =====================================================
// LOOP
// =====================================================

void loop() {

  // ===================================================
  // WiFi / MQTT
  // ===================================================

  // เช็คทุกรอบว่า WiFi หรือ MQTT หลุดหรือยัง ถ้าหลุดให้ reconnect ก่อน
  // ค่อยทำงานอย่างอื่นต่อ เพื่อให้บอร์ดกลับมาส่งข้อมูลได้เองโดยไม่ต้อง
  // มีคนไป reset บอร์ดด้วยมือทุกครั้งที่ WiFi กระตุก
  if (WiFi.status() != WL_CONNECTED) {
    connectToWifi();
  }
  if (!mqttClient.connected()) {
    connectToMqttBroker();
  }
  mqttClient.loop();


  // ===================================================
  // อ่าน Sensor
  // ===================================================

  int mqValue = analogRead(MQ136_PIN);

  float distance = readDistance();


  // ===================================================
  // ตรวจสอบสถานะ
  // ===================================================

  // MQ เหม็นมาก
  bool mqDanger =
      (mqValue >= mqDangerThreshold);


  // ถังเต็ม <= threshold ปัจจุบัน (ปรับได้จาก dashboard)
  bool hcFull =
      (distance > 0 &&
       distance <= fullDistanceThreshold);


  // ===================================================
  // Snooze
  // - ถ้าพ้นสีแดงก่อนครบเวลา ให้เปิดเสียงคืนทันที ไม่ต้องรอครบเวลา
  // - ถ้าหมดเวลาแล้วแต่ยังแดงอยู่ ให้เปิดเสียงเตือนตามปกติ
  // ===================================================

  updateSnoozeState(distance, mqValue, hcFull, mqDanger);


  // ===================================================
  // LED ตามระยะและกลิ่น (แม้ปิดเสียง snooze ไฟสียังคงแสดงตามปกติ)
  // ===================================================

  if (distance < 0) {

    // Sensor Error
    setLED(LOW, LOW, LOW);

  }

  else if (distance <= fullDistanceThreshold || mqDanger) {

    // 🔴 เต็ม หรือ เหม็นมาก (แสดงไฟแดงตามปกติ แม้อยู่ในช่วงปิดเสียง snooze)
    setLED(HIGH, LOW, LOW);

  }

  else if (distance <= 10.0) {

    // 🟡 ใกล้เต็ม
    setLED(LOW, HIGH, LOW);

  }

  else {

    // 🟢 ปกติ
    setLED(LOW, LOW, HIGH);
  }


  // ===================================================
  // OLED
  // ===================================================

  showOLED(
    distance,
    mqValue,
    hcFull,
    mqDanger,
    snoozeActive,
    permanentMute
  );


  // ===================================================
  // SERIAL MONITOR
  // ===================================================

  Serial.print("Distance: ");

  if (distance < 0) {

    Serial.print("ERROR");

  } else {

    Serial.print(distance, 1);
    Serial.print(" cm");
  }


  Serial.print(" | MQ: ");
  Serial.print(mqValue);


  if (hcFull) {
    Serial.print(" | FULL");
  }

  if (mqDanger) {
    Serial.print(" | SMELLY");
  }


  // ===================================================
  // BUZZER
  // ===================================================

  // ดังเฉพาะ
  // 1. ถังเต็ม <= threshold ปัจจุบัน
  // 2. MQ เหม็นมาก >= threshold ปัจจุบัน
  // 3. ต้องไม่ได้อยู่ในช่วง snooze หรือปิดเสียงถาวร (ไม่อยู่บ้าน)
  // หมายเหตุ: ปิดแค่ "เสียง" เท่านั้น LED/OLED ยังโชว์สถานะจริง
  // ตามปกติ เพื่อให้ยังมองเห็นได้ว่าถังยังต้องเปลี่ยนอยู่แม้เสียงจะเงียบ

  bool isMuted = (snoozeActive || permanentMute);

  if ((hcFull || mqDanger) && !isMuted) {

    Serial.println(" | CHANGE!");

    tone(BUZZER_PIN, 2500);

    delay(200);

    noTone(BUZZER_PIN);

    delay(150);

  }

  else {

    if (isMuted && (hcFull || mqDanger)) {
      if (permanentMute) {
        Serial.println(" | CHANGE! (PERMANENT MUTED - AWAY)");
      } else {
        Serial.println(" | CHANGE! (SNOOZED)");
      }
    } else {
      Serial.println(" | NORMAL");
    }

    noTone(BUZZER_PIN);

    delay(300);
  }


  // ===================================================
  // MQTT PUBLISH
  // ===================================================

  // publish เป็นรอบๆ ตาม PUBLISH_INTERVAL_MS เท่านั้น (ไม่ publish ทุก
  // รอบ loop ที่วิ่งเร็วกว่านั้นมาก เพื่อไม่ให้ broker/DB โดนถล่มข้อมูล)
  unsigned long currentTimeMs = millis();
  if (currentTimeMs - lastPublishTimeMs >= PUBLISH_INTERVAL_MS) {
    lastPublishTimeMs = currentTimeMs;
    publishSensorData(distance, mqValue, hcFull, mqDanger);
  }
}