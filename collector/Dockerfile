FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1

# copy แค่ requirements.txt มาติดตั้งก่อน แยกเป็น layer ต่างหาก
# เพื่อให้ docker cache layer นี้ไว้ได้ ถ้าเราแก้แค่ collector.py
# ทีหลัง จะได้ไม่ต้องมา pip install ใหม่ทั้งหมดทุกครั้ง (build เร็วขึ้นมาก)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ค่อย copy โค้ดจริงเข้ามาทีหลัง
COPY collector.py .

CMD ["python", "collector.py"]
