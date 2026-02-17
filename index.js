import { Telegraf, Markup } from "telegraf";
import dayjs from "dayjs";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

// ====== НАСТРОЙКИ ======
const BOT_TOKEN = "8468701098:AAGGGusodS2eE3dWxEDs4Bo8uzd3ya7yGbU"; // export BOT_TOKEN="xxx"
if (!BOT_TOKEN) {
  console.error("❌ Укажи BOT_TOKEN в env: export BOT_TOKEN='xxx'");
  process.exit(1);
}

// Старт Рамадана (чтобы показывать "день Рамадана")
const RAMADAN_START = process.env.RAMADAN_START || "2026-02-18"; // YYYY-MM-DD
const ramadanStart = RAMADAN_START ? dayjs(RAMADAN_START) : null;

// Константы целей
const JUZ_PAGES = 20;

const GOALS = {
  quranPages: JUZ_PAGES,
  istighfar: 500,
  dhikr: 100,
  sadaqaRub: 100,
  duaCount: 3,
};

// ====== DB ======
const adapter = new JSONFile("db.json");
const db = new Low(adapter, { users: {} });
await db.read();
await db.write();

// ====== HELPERS ======
const todayKey = () => dayjs().format("YYYY-MM-DD");

function getRamadanDay() {
  if (!ramadanStart) return null;
  const diff =
    dayjs().startOf("day").diff(ramadanStart.startOf("day"), "day") + 1;
  return diff >= 1 ? diff : null;
}

function emptyDay() {
  return {
    quranPages: 0,
    mosque: {
      fajr: false,
      dhuhr: false,
      asr: false,
      maghrib: false,
      isha: false,
    },
    taraweeh: false,
    tahajjud: false,
    istighfar: 0,
    dhikr: 0,
    sadaqaRub: 0,
    duaCount: 0,
    updatedAt: Date.now(),
  };
}

function ensureUser(userId) {
  if (!db.data.users[userId]) {
    db.data.users[userId] = { days: {}, bestStreak: 0 };
  }
  if (!db.data.users[userId].days[todayKey()]) {
    db.data.users[userId].days[todayKey()] = emptyDay();
  }
  return db.data.users[userId];
}

function progressBar(value, max, width = 10) {
  const v = Math.max(0, Math.min(value, max));
  const filled = Math.round((v / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function mosqueCount(d) {
  const m = d.mosque || {};
  return ["fajr", "dhuhr", "asr", "maghrib", "isha"].filter((k) => !!m[k])
    .length;
}

function goalChecks(d) {
  const checks = [];
  checks.push((d.quranPages || 0) >= GOALS.quranPages);
  checks.push(mosqueCount(d) === 5);
  checks.push(!!d.taraweeh);
  checks.push(!!d.tahajjud);
  checks.push((d.istighfar || 0) >= GOALS.istighfar);
  checks.push((d.dhikr || 0) >= GOALS.dhikr);
  checks.push((d.sadaqaRub || 0) >= GOALS.sadaqaRub);
  checks.push((d.duaCount || 0) >= GOALS.duaCount);
  return checks;
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
    `📖 Коран: ${d.quranPages} стр ${
      d.quranPages >= GOALS.quranPages ? "✅" : "❌"
    } (цель ${GOALS.quranPages})`,
    `🕌 Мечеть: ${mosqueCount(d)}/5 ${progressBar(mosqueCount(d), 5)} ${
      mosqueCount(d) === 5 ? "✅" : "❌"
    }`,
    `🌙 Таравих: ${d.taraweeh ? "✅" : "❌"}`,
    `🕯 Тахаджуд: ${d.tahajjud ? "✅" : "❌"}`,
    `🤍 Истигфар: ${d.istighfar} ${
      d.istighfar >= GOALS.istighfar ? "✅" : "❌"
    } (цель ${GOALS.istighfar})`,
    `📿 Зикр: ${d.dhikr} ${d.dhikr >= GOALS.dhikr ? "✅" : "❌"} (цель ${
      GOALS.dhikr
    })`,
    `💰 Садака: ${d.sadaqaRub}₽ ${
      d.sadaqaRub >= GOALS.sadaqaRub ? "✅" : "❌"
    } (цель ${GOALS.sadaqaRub}₽)`,
    `🤲 Дуа: ${d.duaCount} ${
      d.duaCount >= GOALS.duaCount ? "✅" : "❌"
    } (цель ${GOALS.duaCount})`,
    ``,
    `⭐️ Выполнено: ${done}/8 ${heatEmoji(done)}`,
  ].join("\n");
}

// ====== UI ======
function mainKeyboard() {
  return Markup.keyboard([
    ["✅ Отметить сегодня", "📊 Статистика"],
    ["♻️ Сбросить сегодня"],
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
      Markup.button.callback(
        `${d.taraweeh ? "✅" : "☐"} 🌙 Таравих`,
        "toggle_taraweeh"
      ),
      Markup.button.callback(
        `${d.tahajjud ? "✅" : "☐"} 🕯 Тахаджуд`,
        "toggle_tahajjud"
      ),
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

// ====== BOT ======
const bot = new Telegraf(BOT_TOKEN);

// Состояние ввода чисел
const inputState = new Map(); // userId -> field

function askNumber(ctx, field, prompt) {
  inputState.set(String(ctx.from.id), field);
  return ctx.reply(prompt);
}

bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  ensureUser(userId);
  await db.write();

  const hint = ramadanStart
    ? `Старт Рамадана: ${ramadanStart.format("YYYY-MM-DD")}`
    : `Если хочешь "день Рамадана", задай RAMADAN_START (YYYY-MM-DD).`;

  await ctx.reply(
    `Ассаляму алейкум!\nЭто трекер поклонения (добавление значений + статистика).\n${hint}\n\nНажми "✅ Отметить сегодня".`,
    mainKeyboard()
  );
});

bot.command("today", async (ctx) => {
  const userId = String(ctx.from.id);
  const user = ensureUser(userId);
  const d = user.days[todayKey()];
  await db.write();

  await ctx.reply("Отмечай пункты 👇", todayInlineKeyboard(d));
  await ctx.reply(formatTodayReport(d), mainKeyboard());
});

bot.command("reset_today", async (ctx) => {
  const userId = String(ctx.from.id);
  const user = ensureUser(userId);
  user.days[todayKey()] = emptyDay();
  await db.write();
  await ctx.reply("♻️ Сегодняшние отметки сброшены.", mainKeyboard());
});

// ====== Умная статистика ======
function computeStreak(sortedKeys, daysMap) {
  // активный день = выполнено хотя бы 1 пункт
  const active = (d) => completedCount(d) >= 1;

  let streak = 0;
  let best = 0;

  // текущий стрик (сегодня назад)
  let cur = dayjs().startOf("day");
  for (let i = 0; i < 365; i++) {
    const key = cur.format("YYYY-MM-DD");
    const d = daysMap[key];
    if (d && active(d)) streak++;
    else break;
    cur = cur.subtract(1, "day");
  }

  // лучший стрик по всем дням
  let run = 0;
  for (let i = 0; i < sortedKeys.length; i++) {
    const key = sortedKeys[i];
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
  return last
    .map((k) => {
      const d = daysMap[k];
      const done = d ? completedCount(d) : 0;
      return `${heatEmoji(done)}`;
    })
    .join("");
}

bot.command("stats", async (ctx) => {
  const userId = String(ctx.from.id);
  const user = ensureUser(userId);
  const daysMap = user.days || {};

  const keys = Object.keys(daysMap).sort(); // YYYY-MM-DD
  const totalDays = keys.length;

  if (totalDays === 0) {
    return ctx.reply(
      "Пока нет отметок. Нажми ✅ Отметить сегодня.",
      mainKeyboard()
    );
  }

  const days = keys.map((k) => daysMap[k]);
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
  const avgDone = (doneCounts.reduce((a, b) => a + b, 0) / totalDays).toFixed(
    1
  );

  const hit = (predicate) => days.filter(predicate).length;

  const quranHit = hit((d) => (d.quranPages || 0) >= GOALS.quranPages);
  const mosqueHit = hit((d) => mosqueCount(d) === 5);
  const taraHit = hit((d) => !!d.taraweeh);
  const tahaHit = hit((d) => !!d.tahajjud);
  const istHit = hit((d) => (d.istighfar || 0) >= GOALS.istighfar);
  const dhikrHit = hit((d) => (d.dhikr || 0) >= GOALS.dhikr);
  const sadHit = hit((d) => (d.sadaqaRub || 0) >= GOALS.sadaqaRub);
  const duaHit = hit((d) => (d.duaCount || 0) >= GOALS.duaCount);

  const { streak, best } = computeStreak(keys, daysMap);

  // Лучший день (по количеству закрытых целей)
  let bestDayKey = keys[0];
  let bestDayScore = -1;
  for (const k of keys) {
    const d = daysMap[k];
    const sc = completedCount(d);
    if (sc > bestDayScore) {
      bestDayScore = sc;
      bestDayKey = k;
    }
  }

  const heat = formatHeatmap(keys, daysMap, 14);

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
    `📖 Коран: ${totalQuran} стр (ср. ${(totalQuran / totalDays).toFixed(
      1
    )}/день)`,
    `🕌 Мечеть: ${totalMosque} намазов (из ${totalDays * 5})`,
    `🌙 Таравих: ${totalTaraweeh} дней`,
    `🕯 Тахаджуд: ${totalTahajjud} дней`,
    `🤍 Истигфар: ${totalIst} (ср. ${(totalIst / totalDays).toFixed(0)}/день)`,
    `📿 Зикр: ${totalDhikr} (ср. ${(totalDhikr / totalDays).toFixed(0)}/день)`,
    `💰 Садака: ${totalSadaqa}₽ (ср. ${(totalSadaqa / totalDays).toFixed(
      0
    )}₽/день)`,
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

// ====== Text buttons ======
bot.hears("✅ Отметить сегодня", async (ctx) => {
  const userId = String(ctx.from.id);
  const user = ensureUser(userId);
  const d = user.days[todayKey()];
  await db.write();
  return ctx.telegram.sendMessage(
    ctx.chat.id,
    "Отмечай пункты 👇",
    todayInlineKeyboard(d)
  );
});
bot.hears("📊 Статистика", (ctx) => ctx.reply("/stats"));
bot.hears("♻️ Сбросить сегодня", (ctx) => ctx.reply("/reset_today"));

// ====== INPUT numbers (СУММИРОВАНИЕ) ======
bot.on("text", async (ctx, next) => {
  const userId = String(ctx.from.id);
  const field = inputState.get(userId);
  if (!field) return next();

  const user = ensureUser(userId);
  const d = user.days[todayKey()];

  const raw = (ctx.message.text || "").trim().replace(",", ".");
  const num = Number(raw);

  if (Number.isNaN(num) || num < 0) {
    return ctx.reply("Введите число (0 или больше).");
  }

  // ✅ ВАЖНО: тут идет суммирование (+=)
  if (field === "quranPages")
    d.quranPages = (d.quranPages || 0) + Math.round(num);
  if (field === "istighfar") d.istighfar = (d.istighfar || 0) + Math.round(num);
  if (field === "dhikr") d.dhikr = (d.dhikr || 0) + Math.round(num);
  if (field === "sadaqaRub") d.sadaqaRub = (d.sadaqaRub || 0) + Math.round(num);
  if (field === "duaCount") d.duaCount = (d.duaCount || 0) + Math.round(num);

  d.updatedAt = Date.now();
  inputState.delete(userId);
  await db.write();

  await ctx.reply("✅ Добавил.\n\n" + formatTodayReport(d), mainKeyboard());
});

// ====== CALLBACKS ======
async function toggleMosque(ctx, key) {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const user = ensureUser(userId);
  const d = user.days[todayKey()];
  d.mosque[key] = !d.mosque[key];
  d.updatedAt = Date.now();
  await db.write();
  return ctx
    .editMessageReplyMarkup(todayInlineKeyboard(d).reply_markup)
    .catch(() => {});
}

bot.action("mosque_fajr", (ctx) => toggleMosque(ctx, "fajr"));
bot.action("mosque_dhuhr", (ctx) => toggleMosque(ctx, "dhuhr"));
bot.action("mosque_asr", (ctx) => toggleMosque(ctx, "asr"));
bot.action("mosque_maghrib", (ctx) => toggleMosque(ctx, "maghrib"));
bot.action("mosque_isha", (ctx) => toggleMosque(ctx, "isha"));

bot.action("toggle_taraweeh", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const user = ensureUser(userId);
  const d = user.days[todayKey()];
  d.taraweeh = !d.taraweeh;
  d.updatedAt = Date.now();
  await db.write();
  return ctx
    .editMessageReplyMarkup(todayInlineKeyboard(d).reply_markup)
    .catch(() => {});
});

bot.action("toggle_tahajjud", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const user = ensureUser(userId);
  const d = user.days[todayKey()];
  d.tahajjud = !d.tahajjud;
  d.updatedAt = Date.now();
  await db.write();
  return ctx
    .editMessageReplyMarkup(todayInlineKeyboard(d).reply_markup)
    .catch(() => {});
});

bot.action("edit_quran", (ctx) => {
  ctx.answerCbQuery();
  return askNumber(
    ctx,
    "quranPages",
    `Добавь страницы Корана (будет суммироваться). Цель ${GOALS.quranPages}:`
  );
});
bot.action("edit_istighfar", (ctx) => {
  ctx.answerCbQuery();
  return askNumber(
    ctx,
    "istighfar",
    `Добавь истигфар (будет суммироваться). Цель ${GOALS.istighfar}:`
  );
});
bot.action("edit_dhikr", (ctx) => {
  ctx.answerCbQuery();
  return askNumber(
    ctx,
    "dhikr",
    `Добавь зикр (будет суммироваться). Цель ${GOALS.dhikr}:`
  );
});
bot.action("edit_sadaqa", (ctx) => {
  ctx.answerCbQuery();
  return askNumber(
    ctx,
    "sadaqaRub",
    `Добавь садаку в ₽ (будет суммироваться). Цель ${GOALS.sadaqaRub}₽:`
  );
});
bot.action("edit_dua", (ctx) => {
  ctx.answerCbQuery();
  return askNumber(
    ctx,
    "duaCount",
    `Добавь дуа (будет суммироваться). Цель ${GOALS.duaCount}:`
  );
});

bot.action("show_report", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const user = ensureUser(userId);
  const d = user.days[todayKey()];
  return ctx.reply(formatTodayReport(d), mainKeyboard());
});

// ====== RUN ======
bot.launch();
console.log("🤖 Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
