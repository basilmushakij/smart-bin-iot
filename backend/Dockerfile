FROM python:3.11-slim

WORKDIR /app

# copy requirements มาติดตั้งก่อนแยก layer เหมือนกับฝั่ง collector
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# copy โค้ดหลักและโฟลเดอร์ static (มีหน้า index.html อยู่ข้างใน)
COPY app.py .
COPY static/ static/

# ดาวน์โหลด Chart.js มาเก็บไว้ในอิมเมจตอน build เลย (แทนที่จะให้ browser
# ของผู้ใช้โหลดจาก CDN ตรงๆ ตอนเปิดหน้าเว็บ) เพราะระบบนี้จะใช้งานจริง
# ในวง LAN ที่อาจไม่มีการเชื่อมต่ออินเทอร์เน็ต ถ้าพึ่ง CDN ตอน runtime
# หน้าเว็บจะพังทันทีถ้าวง LAN นั้นไม่มีเน็ต แต่ถ้าดาวน์โหลดมาเก็บไว้ตอน
# build (ซึ่งปกติเครื่องที่ build มีเน็ตอยู่แล้ว) หลัง build เสร็จก็ไม่ต้อง
# พึ่งเน็ตอีกเลย ใช้ urllib ที่ติดมากับ python อยู่แล้วแทน curl/wget
# เพราะอิมเมจ python:3.11-slim นี้ไม่มี curl/wget ติดมาให้ ส่วน "|| true"
# กันไม่ให้การ build ทั้งก้อนพังถ้าหากตอน build ดันไม่มีเน็ตขึ้นมาจริงๆ
RUN python -c "import urllib.request; urllib.request.urlretrieve('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js', 'static/chart.umd.js')" || true

CMD ["uvicorn","app:app","--host","0.0.0.0","--port","8000"]
