import { Telegraf, Markup } from "telegraf";
import dayjs from "dayjs";
import admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

// ================== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ Укажи BOT_TOKEN в env");
  process.exit(1);
}

const RAMADAN_START = process.env.RAMADAN_START || "2026-02-18";
const ramadanStart = RAMADAN_START ? dayjs(RAMADAN_START) : null;

const SA_B64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
if (!SA_B64) {
  console.error("❌ Укажи FIREBASE_SERVICE_ACCOUNT_B64 в env");
  process.exit(1);
}

// ================== FIREBASE INIT ==================
const serviceAccount = JSON.parse(Buffer.from(SA_B64, "base64").toString("utf8"));
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ================== GOALS ==================
const JUZ_PAGES = 20;
const GOALS = {
  quranPages: JUZ_PAGES,
  istighfar: 500,
  dhikr: 100,
  sadaqaRub: 100,
  duaCount: 3,
};

// ================== HELPERS ==================
const todayKey = () => dayjs().format("YYYY-MM-DD");

function getRamadanDay() {
  if (!ramadanStart) return null;
  const diff = dayjs().startOf("day").diff(ramadanStart.startOf("day"), "day") + 1;
  return diff >= 1 ? diff : null;
}

function emptyDay() {
  return {
    quranPages: 0,
    mosque: { fajr: false, dhuhr: false, asr: false, maghrib: false, isha: false },
    taraweeh: false,
    tahajjud: false,
    istighfar: 0,
    dhikr: 0,
    sadaqaRub: 0,
    duaCount: 0,
    updatedAt: Date.now(),
  };
}

function progressBar(value, max, width = 10) {
  const v = Math.max(0, Math.min(value, max));
  const filled = Math.round((v / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function mosqueCount(d) {
  const m = d.mosque || {};
  return ["fajr", "dhuhr", "asr", "maghrib", "isha"].filter((k) => !!m[k]).length;
}

function goalChecks(d) {
  return [
    (d.quranPages || 0) >= GOALS.quranPages,
    mosqueCount(d) === 5,
    !!d.taraweeh,
    !!d.tahajjud,
    (d.istighfar || 0) >= GOALS.istighfar,
    (d.dhikr || 0) >= GOALS.dhikr,
    (d.sadaqaRub || 0) >= GOALS.sadaqaRub,
    (d.duaCount || 0) >= GOALS.duaCount,
  ];
}

function completedCount(d) {
  return goalChecks(d).filter(Boolean).length;
}

function heatEmoji(done) {
  if (done >= 7) return "🟩";
  if (done >= 4) return "🟨";
  return "🟥";
}

function formatTodayReport(d) {
  const rd = getRamadanDay();
  const title = rd ? `🌙 Рамадан — день ${rd}` : `🌙 Сегодня`;
  const done = completedCount(d);

  return [
    `${title}`,
    ``,
    `📖 Коран: ${d.quranPages} стр ${d.quranPages >= GOALS.quranPages ? "✅" : "❌"} (цель ${GOALS.quranPages})`,
    `🕌 Мечеть: ${mosqueCount(d)}/5 ${progressBar(mosqueCount(d), 5)} ${mosqueCount(d) === 5 ? "✅" : "❌"}`,
    `🌙 Таравих: ${d.taraweeh ? "✅" : "❌"}`,
    `🕯 Тахаджуд: ${d.tahajjud ? "✅" : "❌"}`,
    `🤍 Истигфар: ${d.istighfar} ${d.istighfar >= GOALS.istighfar ? "✅" : "❌"} (цель ${GOALS.istighfar})`,
    `📿 Зикр: ${d.dhikr} ${d.dhikr >= GOALS.dhikr ? "✅" : "❌"} (цель ${GOALS.dhikr})`,
    `💰 Садака: ${d.sadaqaRub}₽ ${d.sadaqaRub >= GOALS.sadaqaRub ? "✅" : "❌"} (цель ${GOALS.sadaqaRub}₽)`,
    `🤲 Дуа: ${d.duaCount} ${d.duaCount >= GOALS.duaCount ? "✅" : "❌"} (цель ${GOALS.duaCount})`,
    ``,
    `⭐️ Выполнено: ${done}/8 ${heatEmoji(done)}`,
  ].join("\n");
}

// ================== FIRESTORE PATHS ==================
const userRef = (userId) => db.collection("users").doc(String(userId));
const dayRef = (userId, dateKey) => userRef(userId).collection("days").doc(dateKey);

async function ensureUserAndDay(userId, dateKey = todayKey()) {
  const uRef = userRef(userId);
  const dRef = dayRef(userId, dateKey);

  const [uSnap, dSnap] = await Promise.all([uRef.get(), dRef.get()]);

  if (!uSnap.exists) {
    await uRef.set({ createdAt: Date.now(), bestStreak: 0 }, { merge: true });
  }
  if (!dSnap.exists) {
    await dRef.set(emptyDay(), { merge: true });
  }

  const fresh = await dRef.get();
  return fresh.data();
}

async function getToday(userId) {
  return ensureUserAndDay(userId, todayKey());
}

async function setToday(userId, patch) {
  const dRef = dayRef(userId, todayKey());
  await dRef.set({ ...patch, updatedAt: Date.now() }, { merge: true });
  const snap = await dRef.get();
  return snap.data();
}

async function resetToday(userId) {
  const dRef = dayRef(userId, todayKey());
  await dRef.set(emptyDay(), { merge: false });
  const snap = await dRef.get();
  return snap.data();
}

async function incrementToday(userId, field, amount) {
  const dRef = dayRef(userId, todayKey());
  await ensureUserAndDay(userId, todayKey());
  await dRef.set(
    { [field]: FieldValue.increment(amount), updatedAt: Date.now() },
    { merge: true }
  );
  const snap = await dRef.get();
  return snap.data();
}

async function toggleToday(userId, fieldPath) {
  const dRef = dayRef(userId, todayKey());
  const d = await ensureUserAndDay(userId, todayKey());
  // fieldPath типа "taraweeh" или "mosque.fajr"
  const parts = fieldPath.split(".");
  let cur = d;
  for (const p of parts) cur = cur?.[p];
  const nextVal = !cur;

  await dRef.set({ [fieldPath]: nextVal, updatedAt: Date.now() }, { merge: true });
  const snap = await dRef.get();
  return snap.data();
}

async function getAllDays(userId) {
  const snap = await userRef(userId).collection("days").get();
  const map = {};
  snap.forEach((doc) => (map[doc.id] = doc.data()));
  const keys = Object.keys(map).sort();
  return { keys, map };
}

async function wipeAllUserData(userId) {
  const daysCol = userRef(userId).collection("days");
  const snap = await daysCol.get();

  // батчим удаление
  const batchSize = 400;
  let batch = db.batch();
  let i = 0;

  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    i++;
    if (i % batchSize === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  await batch.commit();

  await userRef(userId).set({ bestStreak: 0, wipedAt: Date.now() }, { merge: true });
}

// ================== UI ==================
function mainKeyboard() {
  return Markup.keyboard([
    ["✅ Отметить сегодня", "📊 Статистика"],
    ["♻️ Сбросить сегодня", "🗑 Очистить всю БД"],
  ]).resize();
}

function todayInlineKeyboard(d) {
  const m = d.mosque || {};
  const p = (key, label) => `${m[key] ? "✅" : "☐"} ${label}`;

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(p("fajr", "Фаджр"), "mosque_fajr"),
      Markup.button.callback(p("dhuhr", "Зухр"), "mosque_dhuhr"),
    ],
    [
      Markup.button.callback(p("asr", "Аср"), "mosque_asr"),
      Markup.button.callback(p("maghrib", "Магриб"), "mosque_maghrib"),
    ],
    [Markup.button.callback(p("isha", "Иша"), "mosque_isha")],
    [
      Markup.button.callback(`${d.taraweeh ? "✅" : "☐"} 🌙 Таравих`, "toggle_taraweeh"),
      Markup.button.callback(`${d.tahajjud ? "✅" : "☐"} 🕯 Тахаджуд`, "toggle_tahajjud"),
    ],
    [
      Markup.button.callback("📖 Коран (+стр)", "edit_quran"),
      Markup.button.callback("🤍 Истигфар (+)", "edit_istighfar"),
    ],
    [
      Markup.button.callback("📿 Зикр (+)", "edit_dhikr"),
      Markup.button.callback("💰 Садака (+₽)", "edit_sadaqa"),
    ],
    [Markup.button.callback("🤲 Дуа (+раз)", "edit_dua")],
    [Markup.button.callback("📩 Показать отчет", "show_report")],
  ]);
}

// ================== BOT ==================
const bot = new Telegraf(BOT_TOKEN);

// ожидание ввода числа
const inputState = new Map(); // userId -> fieldName

function askNumber(ctx, field, prompt) {
  inputState.set(String(ctx.from.id), field);
  return ctx.reply(prompt);
}

// подтверждение wipe
const wipeConfirm = new Map(); // userId -> timestamp

bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  await ensureUserAndDay(userId);

  const hint = ramadanStart
    ? `Старт Рамадана: ${ramadanStart.format("YYYY-MM-DD")}`
    : `Если хочешь "день Рамадана", задай RAMADAN_START (YYYY-MM-DD).`;

  await ctx.reply(
    `Ассаляму алейкум!\nЭто трекер поклонения (Firestore = вечные данные).\n${hint}\n\nНажми "✅ Отметить сегодня".`,
    mainKeyboard()
  );
});

bot.command("today", async (ctx) => {
  const userId = String(ctx.from.id);
  const d = await getToday(userId);

  await ctx.reply("Отмечай пункты 👇", todayInlineKeyboard(d));
  await ctx.reply(formatTodayReport(d), mainKeyboard());
});

bot.command("reset_today", async (ctx) => {
  const userId = String(ctx.from.id);
  await resetToday(userId);
  await ctx.reply("♻️ Сегодняшние отметки сброшены.", mainKeyboard());
});

bot.hears("✅ Отметить сегодня", async (ctx) => {
  const userId = String(ctx.from.id);
  const d = await getToday(userId);
  return ctx.telegram.sendMessage(ctx.chat.id, "Отмечай пункты 👇", todayInlineKeyboard(d));
});
bot.hears("📊 Статистика", (ctx) => ctx.reply("/stats"));
bot.hears("♻️ Сбросить сегодня", (ctx) => ctx.reply("/reset_today"));

bot.hears("🗑 Очистить всю БД", async (ctx) => {
  const userId = String(ctx.from.id);
  wipeConfirm.set(userId, Date.now());
  return ctx.reply(
    "⚠️ Ты точно хочешь ПОЛНОСТЬЮ очистить свою базу?\n" +
      "Это удалит все дни и статистику.\n\n" +
      "Подтверди в течение 60 секунд сообщением: ✅ ОЧИСТИТЬ\n" +
      "Отмена: напиши «отмена».",
    mainKeyboard()
  );
});

// ВАЖНО: этот text handler должен быть раньше numeric input handler
bot.on("text", async (ctx, next) => {
  const userId = String(ctx.from.id);
  const text = (ctx.message.text || "").trim();

  if (text.toLowerCase() === "отмена") {
    if (wipeConfirm.has(userId)) wipeConfirm.delete(userId);
    return ctx.reply("Ок, отменил ✅", mainKeyboard());
  }

  if (text === "✅ ОЧИСТИТЬ") {
    const ts = wipeConfirm.get(userId);
    const fresh = ts && Date.now() - ts <= 60_000;
    wipeConfirm.delete(userId);

    if (!fresh) {
      return ctx.reply("Подтверждение истекло. Нажми 🗑 Очистить всю БД ещё раз.", mainKeyboard());
    }

    await wipeAllUserData(userId);
    return ctx.reply("🗑 Готово. Твоя база полностью очищена.", mainKeyboard());
  }

  return next();
});

// ====== NUMERIC INPUT (СУММИРОВАНИЕ через FieldValue.increment) ======
bot.on("text", async (ctx, next) => {
  const userId = String(ctx.from.id);
  const field = inputState.get(userId);
  if (!field) return next();

  const raw = (ctx.message.text || "").trim().replace(",", ".");
  const num = Number(raw);
  if (Number.isNaN(num) || num < 0) return ctx.reply("Введите число (0 или больше).");

  inputState.delete(userId);

  const amount = Math.round(num);
  let d;

  if (field === "quranPages") d = await incrementToday(userId, "quranPages", amount);
  if (field === "istighfar") d = await incrementToday(userId, "istighfar", amount);
  if (field === "dhikr") d = await incrementToday(userId, "dhikr", amount);
  if (field === "sadaqaRub") d = await incrementToday(userId, "sadaqaRub", amount);
  if (field === "duaCount") d = await incrementToday(userId, "duaCount", amount);

  await ctx.reply("✅ Добавил.\n\n" + formatTodayReport(d), mainKeyboard());
});

// ====== CALLBACKS ======
async function refreshInline(ctx, d) {
  return ctx.editMessageReplyMarkup(todayInlineKeyboard(d).reply_markup).catch(() => {});
}

bot.action("mosque_fajr", async (ctx) => { await ctx.answerCbQuery(); const d = await toggleToday(ctx.from.id, "mosque.fajr"); return refreshInline(ctx, d); });
bot.action("mosque_dhuhr", async (ctx) => { await ctx.answerCbQuery(); const d = await toggleToday(ctx.from.id, "mosque.dhuhr"); return refreshInline(ctx, d); });
bot.action("mosque_asr", async (ctx) => { await ctx.answerCbQuery(); const d = await toggleToday(ctx.from.id, "mosque.asr"); return refreshInline(ctx, d); });
bot.action("mosque_maghrib", async (ctx) => { await ctx.answerCbQuery(); const d = await toggleToday(ctx.from.id, "mosque.maghrib"); return refreshInline(ctx, d); });
bot.action("mosque_isha", async (ctx) => { await ctx.answerCbQuery(); const d = await toggleToday(ctx.from.id, "mosque.isha"); return refreshInline(ctx, d); });

bot.action("toggle_taraweeh", async (ctx) => { await ctx.answerCbQuery(); const d = await toggleToday(ctx.from.id, "taraweeh"); return refreshInline(ctx, d); });
bot.action("toggle_tahajjud", async (ctx) => { await ctx.answerCbQuery(); const d = await toggleToday(ctx.from.id, "tahajjud"); return refreshInline(ctx, d); });

bot.action("edit_quran", (ctx) => { ctx.answerCbQuery(); return askNumber(ctx, "quranPages", `Добавь страницы Корана (суммируется). Цель ${GOALS.quranPages}:`); });
bot.action("edit_istighfar", (ctx) => { ctx.answerCbQuery(); return askNumber(ctx, "istighfar", `Добавь истигфар (суммируется). Цель ${GOALS.istighfar}:`); });
bot.action("edit_dhikr", (ctx) => { ctx.answerCbQuery(); return askNumber(ctx, "dhikr", `Добавь зикр (суммируется). Цель ${GOALS.dhikr}:`); });
bot.action("edit_sadaqa", (ctx) => { ctx.answerCbQuery(); return askNumber(ctx, "sadaqaRub", `Добавь садаку в ₽ (суммируется). Цель ${GOALS.sadaqaRub}₽:`); });
bot.action("edit_dua", (ctx) => { ctx.answerCbQuery(); return askNumber(ctx, "duaCount", `Добавь дуа (суммируется). Цель ${GOALS.duaCount}:`); });

bot.action("show_report", async (ctx) => {
  await ctx.answerCbQuery();
  const d = await getToday(ctx.from.id);
  return ctx.reply(formatTodayReport(d), mainKeyboard());
});

// ====== STATS ======
function computeStreak(sortedKeys, daysMap) {
  const active = (d) => completedCount(d) >= 1;

  let streak = 0;
  let best = 0;

  let cur = dayjs().startOf("day");
  for (let i = 0; i < 365; i++) {
    const key = cur.format("YYYY-MM-DD");
    const d = daysMap[key];
    if (d && active(d)) streak++;
    else break;
    cur = cur.subtract(1, "day");
  }

  let run = 0;
  for (const key of sortedKeys) {
    const d = daysMap[key];
    if (d && active(d)) run++;
    else run = 0;
    best = Math.max(best, run);
  }

  return { streak, best };
}

function formatHeatmap(sortedKeys, daysMap, take = 14) {
  const last = sortedKeys.slice(-take);
  if (!last.length) return "—";
  return last.map((k) => heatEmoji(completedCount(daysMap[k]))).join("");
}

bot.command("stats", async (ctx) => {
  const userId = String(ctx.from.id);
  const { keys, map } = await getAllDays(userId);
  const totalDays = keys.length;

  if (!totalDays) return ctx.reply("Пока нет отметок. Нажми ✅ Отметить сегодня.", mainKeyboard());

  const days = keys.map((k) => map[k]);
  const sum = (fn) => days.reduce((a, d) => a + fn(d), 0);

  const totalQuran = sum((d) => Number(d.quranPages || 0));
  const totalMosque = sum((d) => mosqueCount(d));
  const totalTaraweeh = sum((d) => (d.taraweeh ? 1 : 0));
  const totalTahajjud = sum((d) => (d.tahajjud ? 1 : 0));
  const totalIst = sum((d) => Number(d.istighfar || 0));
  const totalDhikr = sum((d) => Number(d.dhikr || 0));
  const totalSadaqa = sum((d) => Number(d.sadaqaRub || 0));
  const totalDua = sum((d) => Number(d.duaCount || 0));

  const doneCounts = days.map((d) => completedCount(d));
  const perfectDays = doneCounts.filter((x) => x === 8).length;
  const avgDone = (doneCounts.reduce((a, b) => a + b, 0) / totalDays).toFixed(1);

  const hit = (predicate) => days.filter(predicate).length;
  const quranHit = hit((d) => (d.quranPages || 0) >= GOALS.quranPages);
  const mosqueHit = hit((d) => mosqueCount(d) === 5);
  const taraHit = hit((d) => !!d.taraweeh);
  const tahaHit = hit((d) => !!d.tahajjud);
  const istHit = hit((d) => (d.istighfar || 0) >= GOALS.istighfar);
  const dhikrHit = hit((d) => (d.dhikr || 0) >= GOALS.dhikr);
  const sadHit = hit((d) => (d.sadaqaRub || 0) >= GOALS.sadaqaRub);
  const duaHit = hit((d) => (d.duaCount || 0) >= GOALS.duaCount);

  const { streak, best } = computeStreak(keys, map);

  let bestDayKey = keys[0];
  let bestDayScore = -1;
  for (const k of keys) {
    const sc = completedCount(map[k]);
    if (sc > bestDayScore) { bestDayScore = sc; bestDayKey = k; }
  }

  const heat = formatHeatmap(keys, map, 14);

  const text = [
    `📊 Статистика (дней с отметками: ${totalDays})`,
    ``,
    `🔥 Стрик: ${streak} | Лучший стрик: ${best}`,
    `✅ Идеальные дни (8/8): ${perfectDays}`,
    `⭐️ Среднее выполнение: ${avgDone}/8`,
    `🏆 Лучший день: ${bestDayKey} (${bestDayScore}/8)`,
    ``,
    `🗓 Последние 14 дней: ${heat}`,
    ``,
    `— Итоги —`,
    `📖 Коран: ${totalQuran} стр (ср. ${(totalQuran / totalDays).toFixed(1)}/день)`,
    `🕌 Мечеть: ${totalMosque} намазов (из ${totalDays * 5})`,
    `🌙 Таравих: ${totalTaraweeh} дней`,
    `🕯 Тахаджуд: ${totalTahajjud} дней`,
    `🤍 Истигфар: ${totalIst} (ср. ${(totalIst / totalDays).toFixed(0)}/день)`,
    `📿 Зикр: ${totalDhikr} (ср. ${(totalDhikr / totalDays).toFixed(0)}/день)`,
    `💰 Садака: ${totalSadaqa}₽ (ср. ${(totalSadaqa / totalDays).toFixed(0)}₽/день)`,
    `🤲 Дуа: ${totalDua} (ср. ${(totalDua / totalDays).toFixed(1)}/день)`,
    ``,
    `— Выполнение целей (сколько дней достигал) —`,
    `📖 Коран ≥${GOALS.quranPages}: ${quranHit}/${totalDays}`,
    `🕌 Мечеть 5/5: ${mosqueHit}/${totalDays}`,
    `🌙 Таравих: ${taraHit}/${totalDays}`,
    `🕯 Тахаджуд: ${tahaHit}/${totalDays}`,
    `🤍 Истигфар ≥${GOALS.istighfar}: ${istHit}/${totalDays}`,
    `📿 Зикр ≥${GOALS.dhikr}: ${dhikrHit}/${totalDays}`,
    `💰 Садака ≥${GOALS.sadaqaRub}₽: ${sadHit}/${totalDays}`,
    `🤲 Дуа ≥${GOALS.duaCount}: ${duaHit}/${totalDays}`,
  ].join("\n");

  await ctx.reply(text, mainKeyboard());
});

// ================== RUN ==================
bot.launch();
console.log("🤖 Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
