// ---------------------------------------------------------------
// ค่าตั้งต้น - ปรับให้ตรงกับ backend ของเพื่อน (app.py / esp8266.ino) แล้ว
// ---------------------------------------------------------------
const API_BASE = '';
const POLL_MS = 5000;
const HISTORY_LIMIT = 500;
const DEPTH_CM = 20;              // ใช้คำนวณ % แถบขยะแบบคร่าวๆ เพื่อความสวยงามเท่านั้น ไม่ใช่ค่าจริงจากบอร์ด
const FIXED_YELLOW_DISTANCE_CM = 10; // เกณฑ์ไฟเหลือง hardcode ไว้ใน esp8266.ino (distance <= 10.0) ปรับผ่าน dashboard ไม่ได้
const DEFAULT_TH = { gas: 600, dist: 4 }; // ต้องตรงกับ MQ_DANGER_DEFAULT / FULL_DISTANCE_DEFAULT ใน .env

// ตำแหน่งบนผังบ้าน (%), ชื่อห้อง, ชื่อเรียกสั้นๆ - ผูกกับ bin_id จริง (เช่น "smartbin01")
// เพราะ backend ส่งมาแค่ bin_id ล้วนๆ ไม่มีพิกัด/ชื่อห้องมาให้
// ตอนนี้ระบบมีบอร์ดจริงแค่ตัวเดียว (KNOWN_BINS=smartbin01) เพิ่มบอร์ดใหม่เมื่อไหร่ค่อยเพิ่ม entry ที่นี่
const BIN_META = {
  smartbin01: { label: 'ถังขยะห้องครัว', room: 'ห้องครัว', tag: '1', x: 16, y: 28 },
};

// ---------------------------------------------------------------
// state
// ---------------------------------------------------------------
const state = {
  bins: [],               // ["smartbin01", ...] ตรงตาม /api/bins
  latest: {},             // binId -> {dist, gas, full, smelly, snoozed, updatedAt}
  history: {},            // binId -> [{t, dist, gas}] เรียงเก่า -> ใหม่เสมอ
  offlineSec: 30,         // จาก /api/config (BIN_OFFLINE_THRESHOLD_SECONDS)
  th: { ...DEFAULT_TH },  // ใช้แสดงผล/preview เท่านั้น (ของจริงอ่านจากบอร์ดตรงๆ ผ่าน hc_full/mq_danger)
  draft: { ...DEFAULT_TH },
  selectedBin: null,
  events: [],             // ตรวจจับเองฝั่ง frontend จากการเปลี่ยนสถานะ (backend ยังไม่มี endpoint เหตุการณ์)
  notifications: [],      // ประวัติแจ้งเตือน (เวลา/ถัง/เหตุผล) โชว์ใน popup กระดิ่ง
  notifUnread: 0,         // จำนวนที่ยังไม่ได้เปิดดู แสดงเป็นเลขบนวงกลมแดง
  alertedOnce: new Set(), // binId ที่เคย popup แล้วในรอบไฟแดงนี้ กันเด้งซ้ำทุก poll
  alertQueue: [],
  alertMode: 'hidden',    // hidden | alert
  tableFilter: 'all',
};

// ---------------------------------------------------------------
// เรียก API
// ---------------------------------------------------------------
async function apiGet(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return res.json().catch(() => ({}));
}

// แปลง reading document จาก MongoDB (ผ่าน convert_document_for_response) ให้เป็นรูปแบบเดียวกัน
// field ตรงจาก esp8266.ino: bin_id, distance, mq_value, hc_full, mq_danger, snoozed, received_at
function normalizeLatest(raw) {
  return {
    dist: Number(raw.distance),
    gas: Number(raw.mq_value),
    full: !!raw.hc_full,      // บอร์ดคำนวณให้แล้วว่า distance <= full_distance ปัจจุบัน
    smelly: !!raw.mq_danger,  // บอร์ดคำนวณให้แล้วว่า mq_value >= mq_danger ปัจจุบัน
    snoozed: !!raw.snoozed,   // true = บอร์ดปิดเสียง buzzer อยู่ (ทั้งแบบชั่วคราว หรือถาวร)
    permanentMute: !!raw.permanent_mute, // true = ปิดเสียงถาวร (โหมดไม่อยู่บ้าน)
    updatedAt: raw.received_at || new Date().toISOString(),
  };
}
function normalizeHistoryPoint(raw) {
  return {
    t: raw.received_at || null,
    dist: Number(raw.distance),
    gas: Number(raw.mq_value),
  };
}
// GET คืน {bin_id, mq_danger, full_distance} เสมอ (ใช้ default จาก .env ถ้ายังไม่เคยตั้งเอง)
function normalizeThreshold(raw) {
  return {
    gas: Number(raw.mq_danger ?? DEFAULT_TH.gas),
    dist: Number(raw.full_distance ?? DEFAULT_TH.dist),
  };
}

// ---------------------------------------------------------------
// โหลดข้อมูลจาก backend
// ---------------------------------------------------------------
async function loadConfig() {
  try {
    const raw = await apiGet('/api/config');
    state.offlineSec = Number(raw.offline_threshold_seconds ?? 30);
  } catch (e) {
    console.warn('โหลด /api/config ไม่สำเร็จ ใช้ค่าเริ่มต้น 30 วินาที', e);
  }
}

async function loadBins() {
  // /api/bins คืน list ของ bin_id ล้วนๆ เช่น ["smartbin01"] ไม่ใช่ object
  const raw = await apiGet('/api/bins');
  state.bins = Array.isArray(raw) ? raw.map(String) : [];
  if (!state.selectedBin && state.bins.length) state.selectedBin = state.bins[0];
}

async function loadThresholdOnce() {
  if (!state.bins.length) return;
  try {
    const raw = await apiGet(`/api/bins/${state.bins[0]}/threshold`);
    state.th = normalizeThreshold(raw);
    state.draft = { ...state.th };
  } catch (e) {
    console.warn('โหลดเกณฑ์ไม่สำเร็จ ใช้ค่าเริ่มต้นแทน', e);
  }
}

async function loadLatestAll() {
  await Promise.all(state.bins.map(async (id) => {
    try {
      const raw = await apiGet(`/api/bins/${id}/latest`);
      state.latest[id] = normalizeLatest(raw);
    } catch (e) {
      console.warn('โหลดค่าล่าสุดถัง', id, 'ไม่สำเร็จ (ยังไม่มีข้อมูล?)', e);
    }
  }));
}

async function loadHistoryAll() {
  await Promise.all(state.bins.map(async (id) => {
    try {
      const raw = await apiGet(`/api/bins/${id}/history?limit=${HISTORY_LIMIT}`);
      const list = (Array.isArray(raw) ? raw : []).map(normalizeHistoryPoint).filter((p) => p.t);
      // webapp เรียงจากใหม่ -> เก่าเสมอ (DESCENDING) เรียงกลับให้เป็นเก่า -> ใหม่ที่นี่
      list.sort((a, b) => new Date(a.t) - new Date(b.t));
      state.history[id] = list;
    } catch (e) {
      console.warn('โหลดประวัติถัง', id, 'ไม่สำเร็จ', e);
      state.history[id] = state.history[id] || [];
    }
  }));
}

// วนยิง POST ให้ทุกถัง เพราะ backend รับ threshold เป็นรายถัง (ยังไม่มี endpoint ตั้งรวมทีเดียว)
// body ต้องมี field ชื่อ "mq_danger" (int 0-1023) กับ "full_distance" (float, cm) ตรงตาม app.py
async function saveThresholdAll(th) {
  await Promise.all(state.bins.map((id) =>
    apiPost(`/api/bins/${id}/threshold`, { mq_danger: th.gas, full_distance: th.dist })
      .catch((e) => console.warn('บันทึกเกณฑ์ถัง', id, 'ไม่สำเร็จ', e))
  ));
}

// backend รับคำสั่ง snooze, mute_permanent, และ unsnooze ผ่าน MQTT
async function sendSnooze(binId) {
  return apiPost(`/api/bins/${binId}/snooze`, { action: 'snooze' });
}

async function sendPermanentMute(binId) {
  try {
    return await apiPost(`/api/bins/${binId}/mute_permanent`);
  } catch (err) {
    return await apiPost(`/api/bins/${binId}/snooze`, { action: 'permanent_mute' });
  }
}

async function sendUnsnooze(binId) {
  try {
    return await apiPost(`/api/bins/${binId}/unsnooze`);
  } catch (err) {
    return await apiPost(`/api/bins/${binId}/snooze`, { action: 'unsnooze' });
  }
}

async function handleSnoozeClick(binId) {
  try {
    await sendSnooze(binId);
    if (state.latest[binId]) {
      state.latest[binId].snoozed = true;
      state.latest[binId].permanentMute = false;
    }
    renderAll();
    pushNotification(binId, 'ปิดเสียงบอร์ด (Snooze 5 นาที) · หากนำขยะไปทิ้งจะเปิดเสียงคืนทันที');
    showToast(`ปิดเสียง ${binLabel(binId)} แล้ว (5 นาที) · ไฟแดงยังแสดงตามปกติ และจะเปิดคืนเมื่อเทขยะ`);
  } catch (err) {
    showToast('สั่งปิดเสียงไม่สำเร็จ (ต่อ MQTT broker ไม่ได้?)');
  }
}

async function handlePermanentMuteClick(binId) {
  try {
    await sendPermanentMute(binId);
    if (state.latest[binId]) {
      state.latest[binId].snoozed = true;
      state.latest[binId].permanentMute = true;
    }
    renderAll();
    pushNotification(binId, 'ปิดเสียงถาวร (โหมดไม่อยู่บ้าน) · ไฟสีและการแจ้งเตือนบนเว็บยังทำงานตามปกติ');
    showToast(`ปิดเสียง ${binLabel(binId)} ถาวรแล้ว (โหมดไม่อยู่บ้าน) · จะไม่มีเสียงเตือนจนกว่าจะกดเปิดคืน`);
  } catch (err) {
    showToast('สั่งปิดเสียงถาวรไม่สำเร็จ (ต่อ MQTT broker ไม่ได้?)');
  }
}

async function handleUnsnoozeClick(binId) {
  try {
    await sendUnsnooze(binId);
    if (state.latest[binId]) {
      state.latest[binId].snoozed = false;
      state.latest[binId].permanentMute = false;
    }
    renderAll();
    pushNotification(binId, 'เปิดเสียงแจ้งเตือนคืนทันที');
    showToast(`เปิดเสียงแจ้งเตือน ${binLabel(binId)} คืนทันที`);
  } catch (err) {
    showToast('สั่งเปิดเสียงคืนไม่สำเร็จ (ต่อ MQTT broker ไม่ได้?)');
  }
}

// ---------------------------------------------------------------
// ประเมินสถานะถัง - ใช้ค่าที่บอร์ดคำนวณมาให้แล้ว (hc_full / mq_danger) ไม่คำนวณซ้ำฝั่ง frontend
// ยกเว้นเส้นไฟเหลืองที่ fix ไว้ 10 cm ตรงในเฟิร์มแวร์ ไม่ผูกกับ threshold ที่ปรับได้
// ---------------------------------------------------------------
function isOnline(latest) {
  if (!latest) return false;
  return (Date.now() - new Date(latest.updatedAt).getTime()) / 1000 < state.offlineSec;
}

function evalBin(latest) {
  if (!latest || Number.isNaN(latest.dist)) {
    return { level: 'unknown', badge: 'ไม่มีข้อมูล', reason: 'รอข้อมูลจากเซนเซอร์', pct: 0, full: false, smelly: false, online: false };
  }
  const online = isOnline(latest);
  if (!online) {
    return { level: 'unknown', badge: 'ออฟไลน์', reason: 'ไม่ได้รับข้อมูลจากบอร์ดเกิน ' + state.offlineSec + ' วินาที', pct: 0, full: latest.full, smelly: latest.smelly, online: false };
  }
  const { full, smelly } = latest;
  const pct = Math.max(0, Math.min(100, Math.round((DEPTH_CM - latest.dist) / DEPTH_CM * 100)));
  let level = 'green', badge = 'ปกติ', reason = 'ปริมาณขยะยังน้อย';
  if (full || smelly) {
    level = 'red';
    if (full && smelly) { badge = 'เต็ม + กลิ่น'; reason = 'ใกล้เต็มและมีกลิ่นเหม็น'; }
    else if (full) { badge = 'ใกล้เต็ม'; reason = 'ใกล้เต็ม ควรนำไปทิ้ง'; }
    else { badge = 'มีกลิ่น'; reason = 'ตรวจพบกลิ่นเหม็น'; }
  } else if (latest.dist <= FIXED_YELLOW_DISTANCE_CM) {
    level = 'yellow'; badge = 'เกินครึ่ง'; reason = 'ขยะเกินครึ่งถังแล้ว';
  }
  return { level, badge, reason, pct, full, smelly, online: true };
}

function countLevels() {
  const c = { green: 0, yellow: 0, red: 0, unknown: 0 };
  state.bins.forEach((id) => { c[evalBin(state.latest[id]).level] += 1; });
  return c;
}
function countOnline() {
  return state.bins.filter((id) => isOnline(state.latest[id])).length;
}

// ---------------------------------------------------------------
// ETA (คาดว่าจะเต็มเมื่อไหร่) - จากอัตราการลดลงของระยะในข้อมูลย้อนหลัง
// ---------------------------------------------------------------
function estimateRateCmPerHour(hist) {
  if (!hist || hist.length < 2) return null;
  const first = hist[0], last = hist[hist.length - 1]; // เก่าสุด -> ใหม่สุด (เรียงไว้แล้วใน loadHistoryAll)
  const hours = (new Date(last.t) - new Date(first.t)) / 3_600_000;
  if (hours <= 0) return null;
  const rate = (first.dist - last.dist) / hours;
  return rate > 0.05 ? rate : null;
}

function etaFor(binId, latest, e) {
  if (!latest || Number.isNaN(latest.dist)) return { main: '-', sub: 'ไม่มีข้อมูล' };
  if (!e.online) return { main: '-', sub: 'บอร์ดออฟไลน์' };
  if (e.full) return { main: 'ตอนนี้', sub: 'เต็มแล้ว' };
  const rate = estimateRateCmPerHour(state.history[binId]);
  if (!rate) return { main: 'ไม่ทราบ', sub: 'ข้อมูลย้อนหลังไม่พอประมาณ' };
  const hours = (latest.dist - state.th.dist) / rate;
  const totalH = Math.round(hours);
  let main;
  if (hours < 1) main = '< 1 ชม.';
  else if (totalH < 24) main = '~' + totalH + ' ชม.';
  else main = '~' + Math.floor(totalH / 24) + ' วัน ' + (totalH % 24) + ' ชม.';
  const eta = new Date(Date.now() + hours * 3_600_000);
  const sub = eta.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }) +
    ' ~' + eta.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  return { main, sub };
}

// ---------------------------------------------------------------
// สถิติช่วงที่มีข้อมูล (จำนวนครั้งที่ "เข้าสู่" ไฟแดง แยกเหตุ เต็ม/กลิ่น)
// ---------------------------------------------------------------
// escape ก่อนใส่ลง innerHTML ทุกครั้ง (bin_id/ข้อความมาจาก MQTT/DB ซึ่งเชื่อถือไม่ได้)
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function binLabel(id) { return (BIN_META[id] || {}).label || ('ถัง ' + id); }
function binRoom(id) { return (BIN_META[id] || {}).room || '-'; }
function binTag(id, idx) { return (BIN_META[id] || {}).tag || String(idx + 1); }

function buildStats() {
  let earliest = null;
  const rows = state.bins.map((id) => {
    const hist = state.history[id] || [];
    let wFull = 0, wSmell = 0, prevRed = false;
    hist.forEach((p) => {
      if (Number.isNaN(p.dist)) return;
      const full = p.dist <= state.th.dist;
      const smelly = p.gas >= state.th.gas;
      const isRed = full || smelly;
      if (isRed && !prevRed) { if (full) wFull++; else wSmell++; }
      prevRed = isRed;
      if (p.t && (!earliest || new Date(p.t) < earliest)) earliest = new Date(p.t);
    });
    return { name: binLabel(id), room: binRoom(id), wFull, wSmell, total: wFull + wSmell };
  }).sort((a, b) => b.total - a.total);

  const rangeLabel = earliest
    ? 'ย้อนหลัง ~' + Math.max(1, Math.round((Date.now() - earliest) / 3_600_000)) + ' ชั่วโมง'
    : 'ยังไม่มีข้อมูลย้อนหลัง';
  const top = rows[0];
  const insight = top && top.total > 0
    ? `${top.name} (${top.room}) ต้องทิ้งบ่อยที่สุด ${top.total} ครั้งในช่วงนี้ ลองพิจารณาเปลี่ยนถังใบใหญ่ขึ้นหรือย้ายตำแหน่ง`
    : 'ยังไม่พบรูปแบบที่ต้องจัดการเป็นพิเศษ';
  return { rows, rangeLabel, insight };
}

// ---------------------------------------------------------------
// เหตุการณ์ล่าสุด - ตรวจจากการเปลี่ยนสถานะระหว่าง poll (backend ยังไม่มี endpoint เหตุการณ์โดยตรง)
// เก็บใน memory เท่านั้น รีเฟรชหน้าแล้วหาย ถ้าอยากให้อยู่ถาวรต้องให้ backend เพิ่ม endpoint
// ---------------------------------------------------------------
const prevLevel = {};
const prevSnoozed = {};

function pushNotification(binId, reason) {
  state.notifications.unshift({
    time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
    bin: binLabel(binId),
    room: binRoom(binId),
    reason,
  });
  state.notifications = state.notifications.slice(0, 30);
  state.notifUnread += 1;
  renderNotifBadge();
  renderNotifPanel();
}

function detectEvents() {
  state.bins.forEach((id) => {
    const e = evalBin(state.latest[id]);
    const latest = state.latest[id];
    const prev = prevLevel[id];
    const wasSnoozed = prevSnoozed[id];
    const nowSnoozed = !!(latest && latest.snoozed);

    if (prev !== undefined && prev !== e.level && e.level !== 'unknown') {
      state.events.unshift({
        time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
        bin: binLabel(id),
        room: binRoom(id),
        dist: latest ? latest.dist.toFixed(1) : '-',
        gas: latest ? latest.gas : '-',
        level: e.level,
        text: e.level === 'green' ? 'กลับสู่ปกติ' : e.reason,
      });
      state.events = state.events.slice(0, 50);

      // ถ้าเดิมเป็นสีแดง แล้วตอนนี้ "พ้นสีแดง" แล้ว (เช่น นำขยะไปทิ้งแล้ว หรือกลิ่นหายแล้ว)
      if (prev === 'red' && e.level !== 'red') {
        state.alertedOnce.delete(id);

        // ถ้าเคยปิดเสียงชั่วคราวไว้ (snooze) และไม่ได้อยู่ในโหมดปิดเสียงถาวร (ไม่อยู่บ้าน) ให้เปิดเสียงคืนทันที
        if ((wasSnoozed || nowSnoozed) && !(latest && latest.permanentMute)) {
          if (latest) {
            latest.snoozed = false;
            latest.permanentMute = false;
          }
          sendUnsnooze(id).catch(() => {});
          pushNotification(id, 'พ้นสถานะสีแดงแล้ว (นำขยะไปทิ้งแล้ว) -> เปิดเสียงแจ้งเตือนคืนทันที');
          showToast(`ถัง ${esc(binLabel(id))} พ้นสถานะสีแดงแล้ว · เปิดเสียงแจ้งเตือนคืนทันที (ไม่ต้องรอครบเวลา)`);
        }
      }

      if (e.level === 'red') queueAlert(id, e.reason);
    } else if (e.level === 'red' && wasSnoozed && !nowSnoozed) {
      // ยังแดงอยู่ แต่เพิ่งหมดเวลา snooze (5 นาที) หรือเปิดเสียงคืน - ต้องแจ้งเตือนซ้ำ เหมือนบอร์ดจริงที่บัซเซอร์ดังใหม่
      state.alertedOnce.delete(id);
      queueAlert(id, 'ครบกำหนด Snooze แล้ว ยังต้องจัดการอยู่');
      showToast(`ถัง ${esc(binLabel(id))} ครบกำหนด Snooze แล้ว แต่ขยะยังอยู่ · บอร์ดส่งเสียงเตือนต่อ`);
    }
    prevLevel[id] = e.level;
    prevSnoozed[id] = nowSnoozed;
  });
}

function queueAlert(binId, reason) {
  const latest = state.latest[binId];
  if ((latest && latest.snoozed) || state.alertedOnce.has(binId)) return;
  state.alertedOnce.add(binId);
  state.alertQueue.push(binId);
  pushNotification(binId, reason);
  if (state.alertMode === 'hidden') openAlertFor(state.alertQueue.shift());
}
function clearAlertedIfGreen() {
  state.bins.forEach((id) => { if (evalBin(state.latest[id]).level !== 'red') state.alertedOnce.delete(id); });
}

// ---------------------------------------------------------------
// render: สรุปด้านบน
// ---------------------------------------------------------------
function renderSummary() {
  const c = countLevels();
  const onlineCount = countOnline();
  $('#kpi-total').textContent = state.bins.length;
  $('#kpi-green').textContent = c.green;
  $('#kpi-yellow').textContent = c.yellow;
  $('#kpi-red').textContent = c.red;
  $('#kpi-red-card').classList.toggle('kpi-red', c.red > 0);
  const now = new Date().toLocaleTimeString('th-TH');
  $('#stat-updated').textContent = now;
  $('#stat-updated-2').textContent = now;
  $('#stat-online').textContent = `${onlineCount}/${state.bins.length}`;
  $('#stat-online-2').textContent = `${onlineCount}/${state.bins.length}`;
  $('#th-gas-label').textContent = state.th.gas;
  $('#th-dist-label').textContent = state.th.dist;

  const banner = $('#banner-red');
  if (c.red > 0) {
    banner.classList.remove('hidden');
    const firstRed = state.bins.find((id) => evalBin(state.latest[id]).level === 'red');
    $('#banner-title').textContent = `มี ${c.red} ถังต้องจัดการตอนนี้`;
    $('#banner-sub').textContent = firstRed ? binLabel(firstRed) + ' · แตะเพื่อดู' : '';
  } else {
    banner.classList.add('hidden');
  }
}

// ---------------------------------------------------------------
// render: ผังบ้าน + รายการถัง
// ---------------------------------------------------------------
function binFig(fillPct, color) {
  const h = Math.round(42 * fillPct / 100);
  const y = 58 - h;
  return `<svg class="bin-fig" viewBox="0 0 48 64">
    <rect x="18" y="2" width="12" height="5" rx="2" fill="none" stroke="#9C9E96" stroke-width="2"/>
    <rect x="4" y="7" width="40" height="5" rx="2.5" fill="#1D1F1C"/>
    <rect x="7" y="14" width="34" height="46" rx="5" fill="#F4F4F1" stroke="#CFCDC4" stroke-width="1.5"/>
    <rect x="9.5" y="${y}" width="29" height="${h}" rx="3" fill="${color}"/>
  </svg>`;
}
const LEVEL_COLOR = { green: '#3DAA6A', yellow: '#E8AE1F', red: '#DE5656', unknown: '#C9C7BE' };
const LEVEL_MARKER = { green: '#23874C', yellow: '#E3A008', red: '#C93A3A', unknown: '#9C9E96' };

function renderFloorplan() {
  const wrap = $('#floorplan-markers');
  wrap.innerHTML = state.bins.map((id, i) => {
    const meta = BIN_META[id] || { label: 'ถังขยะห้องครัว', room: 'ห้องครัว', tag: String(i + 1), x: 16, y: 28 };
    const latest = state.latest[id];
    const e = evalBin(latest);
    const selected = state.selectedBin === id;
    const isSnoozed = !!(latest && latest.snoozed);
    return `
    <div class="marker-wrap ${selected ? 'selected' : ''}" style="left:${meta.x}%;top:${meta.y}%" data-select="${esc(id)}">
      <div style="position:relative;width:38px;height:38px;">
        ${e.level === 'red' ? `<div class="marker-ring" style="background:${LEVEL_MARKER.red}"></div>` : ''}
        <button class="marker-btn ${selected ? 'selected' : ''}" style="background:${LEVEL_MARKER[e.level]}"
          data-select="${esc(id)}" aria-label="${esc(binLabel(id))} ${esc(binRoom(id))} สถานะ ${e.badge}">${esc(binTag(id, i))}</button>
        ${isSnoozed && e.level === 'red' ? `<span class="marker-snooze-badge" title="ปิดเสียงชั่วคราว (ไฟแดงยังแสดง)">🔇</span>` : ''}
      </div>
      <div class="marker-label ${selected ? 'selected' : ''}">${esc(binRoom(id))} · ${e.badge}</div>
    </div>`;
  }).join('');
}

function renderBinList() {
  const list = $('#bin-list');
  list.innerHTML = state.bins.map((id, i) => {
    const latest = state.latest[id];
    const e = evalBin(latest);
    const selected = state.selectedBin === id;
    const isMuted = !!(latest && latest.snoozed);
    const isPermanent = !!(latest && latest.permanentMute);
    return `
    <div class="bin-row ${e.level === 'red' ? 'red' : ''} ${selected ? 'selected' : ''}" data-select="${esc(id)}" role="button" tabindex="0">
      <div class="bin-row-top">
        ${binFig(e.pct, LEVEL_COLOR[e.level])}
        <div class="bin-main">
          <div class="bin-name-row"><span class="bin-name">${esc(binLabel(id))}</span><span class="bin-room">${esc(binRoom(id))}</span></div>
          <div class="bin-reason" style="color:${e.level === 'green' ? '#4A4C46' : LEVEL_MARKER[e.level]}">${e.reason}</div>
          <div class="bin-meta">ระดับ ~${e.pct}%</div>
        </div>
        <div class="bin-stat">
          <div class="bin-stat-label">ระยะ</div>
          <div class="bin-stat-value" style="color:${e.full ? 'var(--red-text)' : 'inherit'}">${latest ? latest.dist.toFixed(1) : '-'} <small>cm</small></div>
        </div>
        <div class="bin-stat">
          <div class="bin-stat-label">กลิ่น</div>
          <div class="bin-stat-value" style="color:${e.smelly ? 'var(--red-text)' : 'inherit'}">${latest ? esc(latest.gas) : '-'}</div>
        </div>
        <div class="badge badge-${e.level === 'unknown' ? 'yellow' : e.level} ${isMuted && e.level === 'red' ? 'badge-snoozed' : ''}">
          <span class="dot dot-${e.level === 'unknown' ? 'yellow' : e.level}"></span>${e.badge}${isPermanent ? ' (🏠🔇)' : isMuted ? ' (🔇)' : ''}
        </div>
      </div>
      ${e.level === 'red' || isMuted ? `
        <div class="bin-snooze-bar">
          <div class="snooze-bar-info">
            ${isPermanent ? `
              <span class="snooze-status-tag tag-permanent">🏠 ปิดเสียงถาวร (ไม่อยู่บ้าน)</span>
              <span class="snooze-status-desc">ไม่ส่งเสียงจนกว่าจะเปิดคืน</span>
            ` : isMuted ? `
              <span class="snooze-status-tag tag-snooze">🔇 ปิดเสียงชั่วคราว</span>
              <span class="snooze-status-desc">ไฟแดงยังแสดงปกติ · เทขยะเปิดคืน</span>
            ` : `
              <span class="snooze-status-tag tag-danger">🚨 บัซเซอร์กำลังเตือน</span>
              <span class="snooze-status-desc">กรุณานำขยะไปทิ้ง</span>
            `}
          </div>
          <div class="snooze-bar-actions">
            ${isMuted ? `
              <button type="button" class="btn-snooze-pill btn-unsnooze" data-unsnooze="${esc(id)}">🔊 เปิดเสียงคืน</button>
            ` : `
              <button type="button" class="btn-snooze-pill btn-snooze" data-snooze="${esc(id)}" title="ปิดเสียง 5 นาที หรือเปิดคืนอัตโนมัติเมื่อเทขยะ">🔇 ปิด 5 นาที</button>
              <button type="button" class="btn-snooze-pill btn-mute-perm" data-mute-permanent="${esc(id)}" title="ปิดเสียงถาวร กรณีไม่มีใครอยู่บ้าน">🏠 ปิดถาวร</button>
            `}
          </div>
        </div>
      ` : `
        <div class="bin-snooze-bar bin-snooze-bar-subtle">
          <div class="snooze-bar-info">
            <span class="snooze-status-desc-subtle">🔊 เสียงเตือนเปิดอยู่</span>
          </div>
          <div class="snooze-bar-actions">
            <button type="button" class="btn-snooze-pill btn-mute-perm-subtle" data-mute-permanent="${esc(id)}" title="กดปิดเสียงถาวรล่วงหน้า กรณีไม่มีใครอยู่บ้าน">🏠 ปิดเสียงถาวร (ไม่อยู่บ้าน)</button>
          </div>
        </div>
      `}
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------
// render: คาดการณ์ + สถิติ + เหตุการณ์
// ---------------------------------------------------------------
function renderForecastAndStats() {
  const items = state.bins.map((id) => {
    const latest = state.latest[id];
    const e = evalBin(latest);
    const eta = etaFor(id, latest, e);
    const rank = e.level === 'red' ? 0 : e.level === 'yellow' ? 1 : 2;
    return { id, e, eta, rank };
  }).sort((a, c) => a.rank - c.rank);

  $('#eta-list').innerHTML = items.map(({ id, e, eta }, i) => `
    <div class="eta-row">
      <span class="eta-chip" style="background:${LEVEL_MARKER[e.level]}">${esc(binTag(id, i))}</span>
      <div style="flex:1;min-width:0;">
        <div class="eta-title">${esc(binLabel(id))} · ${esc(binRoom(id))}</div>
        <div class="eta-note" style="color:${e.full || e.smelly ? 'var(--red-text)' : 'var(--text-dim)'}">${e.full ? 'ควรนำไปทิ้งตอนนี้' : e.smelly ? 'มีกลิ่น ควรทิ้งแม้ยังไม่เต็ม' : 'ปกติ'}</div>
      </div>
      <div class="eta-right">
        <div class="eta-main" style="color:${e.full ? 'var(--red-text)' : 'inherit'}">${eta.main}</div>
        <div class="eta-sub">${eta.sub}</div>
      </div>
    </div>`).join('');

  const stats = buildStats();
  $('#stats-range').textContent = stats.rangeLabel;
  const maxTotal = Math.max(1, ...stats.rows.map((r) => r.total));
  $('#stats-list').innerHTML = stats.rows.map((r) => `
    <div class="stat-row">
      <div class="stat-name"><div style="font-size:12.5px;font-weight:600">${esc(r.name)}</div><div style="font-size:11px;color:var(--text-dim)">${esc(r.room)}</div></div>
      <div class="stat-bar-track">
        <div class="stat-bar-full" style="width:${r.total ? r.wFull / maxTotal * 100 : 0}%"></div>
        <div class="stat-bar-smell" style="width:${r.total ? r.wSmell / maxTotal * 100 : 0}%"></div>
      </div>
      <div class="stat-total">${r.total}</div>
    </div>`).join('');
  $('#insight-text').textContent = stats.insight;
}

function renderEvents() {
  $('#events-list').innerHTML = state.events.slice(0, 5).map((ev) => `
    <div class="event-row">
      <span class="event-dot" style="background:${LEVEL_MARKER[ev.level] || '#9C9E96'}"></span>
      <div style="flex:1;min-width:0;">
        <div class="event-title">${esc(ev.bin)} · ${esc(ev.text)}</div>
        <div class="event-detail">${esc(ev.room)} · ระยะ ${esc(ev.dist)} cm · กลิ่น ${esc(ev.gas)}</div>
      </div>
      <div class="event-time">${ev.time}</div>
    </div>`).join('') || `<div style="font-size:13px;color:var(--text-dim)">ยังไม่มีเหตุการณ์</div>`;
}

function renderNotifPanel() {
  const el = $('#notif-list');
  if (!el) return;
  el.innerHTML = state.notifications.map((n) => `
    <div class="notif-row">
      <span class="notif-dot" style="background:${n.reason.includes('Snooze') || n.reason.includes('ปิดแจ้งเตือน') ? '#9C9E96' : '#C93A3A'}"></span>
      <div style="flex:1;min-width:0;">
        <div class="notif-title">${esc(n.bin)} · ${esc(n.room)}</div>
        <div class="notif-detail">${esc(n.reason)}</div>
      </div>
      <div class="notif-time">${n.time}</div>
    </div>`).join('') || `<div class="notif-empty">ยังไม่มีการแจ้งเตือน</div>`;
}

function renderNotifBadge() {
  const badge = $('#notif-badge');
  if (!badge) return;
  badge.textContent = state.notifUnread > 99 ? '99+' : String(state.notifUnread);
  badge.classList.toggle('hidden', state.notifUnread === 0);
}

function renderAll() {
  renderSummary();
  renderFloorplan();
  renderBinList();
  renderForecastAndStats();
  renderEvents();
}

// ---------------------------------------------------------------
// แผงตั้งค่าเกณฑ์ (ใช้ร่วมกันทุกถัง ฝั่ง backend ยังรับเป็นรายถังอยู่ วนยิงให้ตอนบันทึก)
// ---------------------------------------------------------------
function renderSettingsPreview() {
  const c = { green: 0, yellow: 0, red: 0 };
  state.bins.forEach((id) => {
    const latest = state.latest[id];
    if (!latest || !isOnline(latest)) return;
    const full = latest.dist <= state.draft.dist;
    const smelly = latest.gas >= state.draft.gas;
    const level = (full || smelly) ? 'red' : (latest.dist <= FIXED_YELLOW_DISTANCE_CM ? 'yellow' : 'green');
    c[level] += 1;
  });
  $('#settings-preview').innerHTML = `
    <span class="badge badge-green"><span class="dot dot-green"></span>เขียว ${c.green}</span>
    <span class="badge badge-yellow"><span class="dot dot-yellow"></span>เหลือง ${c.yellow}</span>
    <span class="badge badge-red"><span class="dot dot-red"></span>แดง ${c.red}</span>`;
}
function syncSettingsInputs() {
  $('#input-gas').value = state.draft.gas;
  $('#input-gas-num').value = state.draft.gas;
  $('#input-dist').value = state.draft.dist;
  $('#input-dist-num').value = state.draft.dist;
  $('#settings-total').textContent = state.bins.length;
  renderSettingsPreview();
}

// ---------------------------------------------------------------
// popup แจ้งเตือน + snooze
// หมายเหตุ: บอร์ด fix เวลา snooze ไว้ 5 นาทีในเฟิร์มแวร์ (SNOOZE_DURATION_MS)
// dashboard เลยมีแค่ปุ่ม "ปิดเสียง 5 นาที" ปุ่มเดียว เลือกเวลาเองไม่ได้จริง
// ---------------------------------------------------------------
function openAlertFor(binId) {
  state.selectedBin = binId;
  state.alertMode = 'alert';
  renderAlertCard();
  $('#overlay-alert').classList.remove('hidden');
}
function renderAlertCard() {
  const binId = state.selectedBin;
  if (!state.bins.includes(binId)) { closeAlertOverlay(); return; }
  const latest = state.latest[binId];
  const e = evalBin(latest);
  const room = binRoom(binId);
  const isMuted = !!(latest && latest.snoozed);
  const isPermanent = !!(latest && latest.permanentMute);

  $('#alert-card').innerHTML = `
    <div class="alert-head">
      <div class="alert-icon">${isPermanent ? '🏠' : isMuted ? '🔇' : '🚮'}</div>
      <div>
        <div class="alert-tag"><span class="dot dot-red"></span>แจ้งเตือน${isPermanent ? ' · ปิดเสียงถาวร (ไม่อยู่บ้าน)' : isMuted ? ' · ปิดเสียงชั่วคราว' : ''}</div>
        <div class="alert-title">${esc(binLabel(binId))} ${e.badge}แล้ว</div>
        <div class="alert-sub">${esc(room)} · ${isPermanent ? 'ปิดเสียงถาวร (ไม่อยู่บ้าน) ไฟแดงยังแสดงตามปกติ' : isMuted ? 'ปิดเสียงชั่วคราวแล้ว แต่ยังมีขยะอยู่ ไฟแดงยังแสดงตามปกติ' : 'กรุณานำขยะไปทิ้ง'}</div>
      </div>
    </div>
    <div class="alert-facts">
      <div class="alert-fact"><span>ระยะที่วัดได้</span><span style="text-align:right"><b style="color:${e.full ? 'var(--red-text)' : 'inherit'}">${latest ? latest.dist.toFixed(1) : '-'} cm</b><br><small style="color:var(--text-dim)">เกณฑ์เต็ม ≤ ${state.th.dist} cm</small></span></div>
      <div class="alert-fact"><span>กลิ่น MQ-136</span><span style="text-align:right"><b style="color:${e.smelly ? 'var(--red-text)' : 'inherit'}">${latest ? esc(latest.gas) : '-'}</b><br><small style="color:var(--text-dim)">เกณฑ์กลิ่น ≥ ${state.th.gas}</small></span></div>
      <div class="alert-fact"><span>สถานะเสียงบอร์ด</span><span style="text-align:right"><b style="color:${isMuted ? 'var(--red-text)' : 'var(--green-text)'}">${isPermanent ? '🏠 ปิดเสียงถาวร (โหมดไม่อยู่บ้าน)' : isMuted ? '🔇 ปิดเสียงชั่วคราว 5 นาที' : '🔊 พร้อมส่งเสียงเตือน'}</b></span></div>
    </div>
    <div class="alert-actions">
      <button class="btn btn-outline" id="btn-alert-close">ปิดหน้าต่าง</button>
      ${isMuted ? `
        <button class="btn btn-dark" id="btn-alert-unsnooze">🔊 เปิดเสียงคืนทันที</button>
      ` : `
        <button class="btn btn-outline" id="btn-alert-snooze" title="ปิดเสียง 5 นาที หรือเปิดคืนอัตโนมัติเมื่อเทขยะ">🔇 ปิด 5 นาที</button>
        <button class="btn btn-dark" id="btn-alert-permanent-mute" title="ปิดเสียงถาวร เช่น เวลาไม่อยู่บ้าน">🏠 ปิดเสียงถาวร</button>
      `}
    </div>`;

  $('#btn-alert-close').onclick = () => {
    closeAlertOverlay();
    advanceAlertQueue();
  };

  const btnSnooze = $('#btn-alert-snooze');
  if (btnSnooze) {
    btnSnooze.onclick = async () => {
      closeAlertOverlay();
      await handleSnoozeClick(binId);
      advanceAlertQueue();
    };
  }

  const btnPerm = $('#btn-alert-permanent-mute');
  if (btnPerm) {
    btnPerm.onclick = async () => {
      closeAlertOverlay();
      await handlePermanentMuteClick(binId);
      advanceAlertQueue();
    };
  }

  const btnUnsnooze = $('#btn-alert-unsnooze');
  if (btnUnsnooze) {
    btnUnsnooze.onclick = async () => {
      closeAlertOverlay();
      await handleUnsnoozeClick(binId);
      advanceAlertQueue();
    };
  }
}
function closeAlertOverlay() {
  state.alertMode = 'hidden';
  $('#overlay-alert').classList.add('hidden');
}
function advanceAlertQueue() {
  if (state.alertQueue.length) openAlertFor(state.alertQueue.shift());
}

// ---------------------------------------------------------------
// ตารางเหตุการณ์ทั้งหมด
// ---------------------------------------------------------------
function renderTable() {
  const filters = [['all', 'ทั้งหมด'], ['red', 'ไฟแดง'], ['yellow', 'ไฟเหลือง'], ['green', 'ไฟเขียว']];
  $('#table-filters').innerHTML = filters.map(([id, label]) => {
    const count = id === 'all' ? state.events.length : state.events.filter((e) => e.level === id).length;
    return `<button class="filter-chip ${state.tableFilter === id ? 'active' : ''}" data-filter="${id}">${label} ${count}</button>`;
  }).join('');
  $$('[data-filter]').forEach((el) => el.onclick = () => { state.tableFilter = el.dataset.filter; renderTable(); });

  const rows = state.tableFilter === 'all' ? state.events : state.events.filter((e) => e.level === state.tableFilter);
  const badgeClass = { green: 'badge-green', yellow: 'badge-yellow', red: 'badge-red' };
  const badgeLabel = { green: 'ไฟเขียว', yellow: 'ไฟเหลือง', red: 'ไฟแดง' };
  $('#table-rows').innerHTML = `
    <div class="table-head"><div>เวลา</div><div>ถัง</div><div>ห้อง</div><div>ระยะ</div><div>กลิ่น</div><div>เหตุการณ์</div><div>สถานะ</div></div>
    ${rows.map((r) => `
    <div class="table-row">
      <div class="time">${r.time}</div>
      <div>${esc(r.bin)}</div>
      <div>${esc(r.room)}</div>
      <div>${r.dist}</div>
      <div>${r.gas}</div>
      <div>${esc(r.text)}</div>
      <div><span class="badge ${badgeClass[r.level] || ''}" style="display:inline-flex">${badgeLabel[r.level] || '-'}</span></div>
    </div>`).join('') || '<div style="padding:20px;color:var(--text-dim)">ยังไม่มีข้อมูล</div>'}`;
}

// ---------------------------------------------------------------
// toast + overlay ทั่วไป
// ---------------------------------------------------------------
let toastTimer;
function showToast(msg) {
  clearTimeout(toastTimer);
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}
function openOverlay(name) { $('#overlay-' + name).classList.remove('hidden'); }
function closeOverlay(name) { $('#overlay-' + name).classList.add('hidden'); }

// ---------------------------------------------------------------
// helper + event listener ตอนเริ่มโปรแกรม
// ---------------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function openCurrentAlert() {
  const anyRed = state.bins.find((id) => evalBin(state.latest[id]).level === 'red');
  if (anyRed) openAlertFor(anyRed);
}

function bindStaticEvents() {
  $('#btn-open-settings').onclick = () => { state.draft = { ...state.th }; syncSettingsInputs(); openOverlay('settings'); };
  $$('[data-close="settings"]').forEach((el) => el.onclick = () => closeOverlay('settings'));
  $('#btn-reset-th').onclick = () => { state.draft = { ...DEFAULT_TH }; syncSettingsInputs(); };
  $('#btn-save-th').onclick = async () => {
    state.th = { ...state.draft };
    closeOverlay('settings');
    renderAll();
    showToast('บันทึกเกณฑ์แล้ว · ส่งค่าไปยังถังขยะทั้ง ' + state.bins.length + ' ใบ');
    await saveThresholdAll(state.th);
  };
  ['input-gas', 'input-gas-num'].forEach((id) => $('#' + id).oninput = (e) => {
    state.draft.gas = Number(e.target.value); syncSettingsInputs();
  });
  ['input-dist', 'input-dist-num'].forEach((id) => $('#' + id).oninput = (e) => {
    state.draft.dist = Number(e.target.value); syncSettingsInputs();
  });

  $('#banner-red').onclick = () => openCurrentAlert();

  $('#btn-toggle-notif').onclick = () => {
    renderNotifPanel();
    openOverlay('notif');
    state.notifUnread = 0;   // เปิดดูแล้วถือว่าอ่านหมด เลขบนวงกลมแดงหายไป
    renderNotifBadge();
  };
  $$('[data-close="notif"]').forEach((el) => el.onclick = () => closeOverlay('notif'));
  $('#btn-clear-notif').onclick = () => { state.notifications = []; renderNotifPanel(); };

  $('#btn-open-table').onclick = () => { renderTable(); openOverlay('table'); };
  $$('[data-close="table"]').forEach((el) => el.onclick = () => closeOverlay('table'));

  document.body.addEventListener('click', (ev) => {
    const unsnoozeBtn = ev.target.closest('[data-unsnooze]');
    if (unsnoozeBtn) {
      ev.stopPropagation();
      const binId = unsnoozeBtn.dataset.unsnooze;
      handleUnsnoozeClick(binId);
      return;
    }
    const permBtn = ev.target.closest('[data-mute-permanent]');
    if (permBtn) {
      ev.stopPropagation();
      const binId = permBtn.dataset.mutePermanent;
      handlePermanentMuteClick(binId);
      return;
    }
    const snoozeBtn = ev.target.closest('[data-snooze]');
    if (snoozeBtn) {
      ev.stopPropagation();
      const binId = snoozeBtn.dataset.snooze;
      handleSnoozeClick(binId);
      return;
    }
    const sel = ev.target.closest('[data-select]');
    if (sel) {
      state.selectedBin = sel.dataset.select;
      renderFloorplan();
      renderBinList();
    }
  });

  document.body.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      const row = ev.target.closest('.bin-row');
      if (row && ev.target === row) {
        state.selectedBin = row.dataset.select;
        renderFloorplan();
        renderBinList();
      }
    }
  });
}

// ---------------------------------------------------------------
// วนโหลดข้อมูลใหม่เรื่อยๆ
// ---------------------------------------------------------------
async function pollOnce() {
  await loadLatestAll();
  detectEvents();
  clearAlertedIfGreen();
  renderAll();
}

async function init() {
  bindStaticEvents();
  try {
    await loadConfig();
    await loadBins();
    await loadThresholdOnce();
    await loadLatestAll();
    await loadHistoryAll();
    state.bins.forEach((id) => { prevLevel[id] = evalBin(state.latest[id]).level; });
    renderAll();
  } catch (e) {
    console.error('โหลดข้อมูลเริ่มต้นไม่สำเร็จ', e);
    showToast('เชื่อมต่อ backend ไม่สำเร็จ ลองรีเฟรชอีกครั้ง');
  }
  setInterval(pollOnce, POLL_MS);
  setInterval(loadHistoryAll, 60000);
}

init();