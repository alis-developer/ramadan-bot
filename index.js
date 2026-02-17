import { Telegraf, Markup } from "telegraf";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import admin from "firebase-admin";
import cron from "node-cron";
import { FieldValue } from "firebase-admin/firestore";
import http from "http";

// ========= TIMEZONE =========
dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = process.env.TZ || "Europe/Moscow";
dayjs.tz.setDefault(TZ);

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ Укажи BOT_TOKEN в env");
  process.exit(1);
}

const RAMADAN_START = process.env.RAMADAN_START || "2026-02-18"; // YYYY-MM-DD
const ramadanStart = RAMADAN_START ? dayjs.tz(RAMADAN_START, TZ).startOf("day") : null;

const SA_B64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
if (!SA_B64) {
  console.error("❌ Укажи FIREBASE_SERVICE_ACCOUNT_B64 в env");
  process.exit(1);
}

// ========= FIREBASE INIT =========
const serviceAccount = JSON.parse(Buffer.from(SA_B64, "base64").toString("utf8"));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ========= DEFAULT GOALS =========
const DEFAULT_GOALS = {
  quranPages: 20,
  istighfar: 500,
  dhikr: 100,
  sadaqaRub: 100,
  duaCount: 3,
};

// ========= HELPERS =========
const now = () => dayjs().tz(TZ);
const todayKey = () => now().format("YYYY-MM-DD");

function getRamadanDay() {
  if (!ramadanStart) return null;
  const diff = now().startOf("day").diff(ramadanStart, "day") + 1;
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

function completedCount(d, goals) {
  const g = goals || DEFAULT_GOALS;
  const checks = [
    (d.quranPages || 0) >= (g.quranPages || 0),
    mosqueCount(d) === 5,
    !!d.taraweeh,
    !!d.tahajjud,
    (d.istighfar || 0) >= (g.istighfar || 0),
    (d.dhikr || 0) >= (g.dhikr || 0),
    (d.sadaqaRub || 0) >= (g.sadaqaRub || 0),
    (d.duaCount || 0) >= (g.duaCount || 0),
  ];
  return checks.filter(Boolean).length;
}

function heatEmoji(done) {
  if (done >= 7) return "🟩";
  if (done >= 4) return "🟨";
  return "🟥";
}

function formatTodayReport(d, goals) {
  const g = goals || DEFAULT_GOALS;
  const rd = getRamadanDay();
  const title = rd ? `🌙 Рамадан — день ${rd}` : `🌙 Сегодня`;

  const done = completedCount(d, g);

  return [
    `${title}`,
    ``,
    `📖 Коран: ${d.quranPages} стр ${d.quranPages >= g.quranPages ? "✅" : "❌"} (цель ${g.quranPages})`,
    `🕌 Мечеть: ${mosqueCount(d)}/5 ${progressBar(mosqueCount(d), 5)} ${mosqueCount(d) === 5 ? "✅" : "❌"}`,
    `🌙 Таравих: ${d.taraweeh ? "✅" : "❌"}`,
    `🕯 Тахаджуд: ${d.tahajjud ? "✅" : "❌"}`,
    `🤍 Истигфар: ${d.istighfar} ${d.istighfar >= g.istighfar ? "✅" : "❌"} (цель ${g.istighfar})`,
    `📿 Зикр: ${d.dhikr} ${d.dhikr >= g.dhikr ? "✅" : "❌"} (цель ${g.dhikr})`,
    `💰 Садака: ${d.sadaqaRub}₽ ${d.sadaqaRub >= g.sadaqaRub ? "✅" : "❌"} (цель ${g.sadaqaRub}₽)`,
    `🤲 Дуа: ${d.duaCount} ${d.duaCount >= g.duaCount ? "✅" : "❌"} (цель ${g.duaCount})`,
    ``,
    `⭐️ Выполнено: ${done}/8 ${heatEmoji(done)}`,
  ].join("\n");
}

function remainingText(d, goals) {
  const g = goals || DEFAULT_GOALS;

  const rem = {
    quranPages: Math.max(0, (g.quranPages || 0) - (d.quranPages || 0)),
    istighfar: Math.max(0, (g.istighfar || 0) - (d.istighfar || 0)),
    dhikr: Math.max(0, (g.dhikr || 0) - (d.dhikr || 0)),
    sadaqaRub: Math.max(0, (g.sadaqaRub || 0) - (d.sadaqaRub || 0)),
    duaCount: Math.max(0, (g.duaCount || 0) - (d.duaCount || 0)),
  };

  const lines = [];
  if (rem.quranPages > 0) lines.push(`📖 Коран: осталось ${rem.quranPages} стр`);
  if (rem.istighfar > 0) lines.push(`🤍 Истигфар: осталось ${rem.istighfar}`);
  if (rem.dhikr > 0) lines.push(`📿 Зикр: осталось ${rem.dhikr}`);
  if (rem.sadaqaRub > 0) lines.push(`💰 Садака: осталось ${rem.sadaqaRub}₽`);
  if (rem.duaCount > 0) lines.push(`🤲 Дуа: осталось ${rem.duaCount}`);

  return lines.length ? lines.join("\n") : "✅ Всё по целям выполнено (кроме намазов/таравиха — без напоминаний).";
}

// ========= FIRESTORE PATHS =========
const userRef = (userId) => db.collection("users").doc(String(userId));
const dayRef = (userId, dateKey) => userRef(userId).collection("days").doc(dateKey);

async function ensureUserAndDay(userId, chatId) {
  const uRef = userRef(userId);
  const dRef = dayRef(userId, todayKey());

  const [uSnap, dSnap] = await Promise.all([uRef.get(), dRef.get()]);

  if (!uSnap.exists) {
    await uRef.set(
      {
        createdAt: Date.now(),
        chatId: chatId ?? null,
        tz: TZ,
        goals: null,
        setupDone: false,
      },
      { merge: true }
    );
  } else if (chatId) {
    await uRef.set({ chatId }, { merge: true });
  }

  if (!dSnap.exists) {
    await dRef.set(emptyDay(), { merge: true });
  }

  const u = (await uRef.get()).data();
  const d = (await dRef.get()).data();
  return { user: u, day: d };
}

async function getToday(userId) {
  const snap = await dayRef(userId, todayKey()).get();
  if (!snap.exists) return emptyDay();
  return snap.data();
}

async function getUser(userId) {
  const snap = await userRef(userId).get();
  return snap.exists ? snap.data() : null;
}

async function setToday(userId, patch) {
  const dRef = dayRef(userId, todayKey());
  await dRef.set({ ...patch, updatedAt: Date.now() }, { merge: true });
  return (await dRef.get()).data();
}

async function resetToday(userId) {
  const dRef = dayRef(userId, todayKey());
  await dRef.set(emptyDay(), { merge: false });
  return (await dRef.get()).data();
}

async function incrementToday(userId, field, amount) {
  const dRef = dayRef(userId, todayKey());
  await dRef.set({ [field]: FieldValue.increment(amount), updatedAt: Date.now() }, { merge: true });
  return (await dRef.get()).data();
}

// ✅ фикс: обновляем вложенный объект mosque целиком (чтобы UI всегда совпадал)
async function toggleMosque(userId, key) {
  const dRef = dayRef(userId, todayKey());
  const snap = await dRef.get();
  const d = snap.exists ? snap.data() : emptyDay();

  const nextMosque = { ...(d.mosque || {}) };
  nextMosque[key] = !nextMosque[key];

  await dRef.set({ mosque: nextMosque, updatedAt: Date.now() }, { merge: true });
  return (await dRef.get()).data();
}

async function toggleBool(userId, field) {
  const dRef = dayRef(userId, todayKey());
  const snap = await dRef.get();
  const d = snap.exists ? snap.data() : emptyDay();
  const next = !d[field];

  await dRef.set({ [field]: next, updatedAt: Date.now() }, { merge: true });
  return (await dRef.get()).data();
}

// ========= UI =========
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

// ========= BOT =========
const bot = new Telegraf(BOT_TOKEN);

// мастер настройки целей
const setupState = new Map(); // userId -> step
const inputState = new Map(); // userId -> field

const SETUP_STEPS = [
  { key: "quranPages", label: "📖 Сколько страниц Корана в день?", def: DEFAULT_GOALS.quranPages },
  { key: "istighfar", label: "🤍 Истигфар в день (кол-во)?", def: DEFAULT_GOALS.istighfar },
  { key: "dhikr", label: "📿 Зикр в день (кол-во)?", def: DEFAULT_GOALS.dhikr },
  { key: "sadaqaRub", label: "💰 Садака в день (₽)?", def: DEFAULT_GOALS.sadaqaRub },
  { key: "duaCount", label: "🤲 Дуа в день (раз)?", def: DEFAULT_GOALS.duaCount },
];

function setupPrompt(step) {
  const s = SETUP_STEPS[step];
  return `${s.label}\nНапиши число.\nИли напиши: по умолчанию (=${s.def})`;
}

async function startSetup(ctx, userId) {
  setupState.set(userId, 0);
  await ctx.reply(
    "Настроим твои цели на Рамадан ✅\n(потом можно будет добавить команду /goals для изменения)",
    mainKeyboard()
  );
  return ctx.reply(setupPrompt(0));
}

async function saveGoal(userId, key, value) {
  await userRef(userId).set(
    {
      goals: { [key]: value },
    },
    { merge: true }
  );
}

async function getGoalsForUser(userId) {
  const u = await getUser(userId);
  const g = u?.goals || null;
  return {
    quranPages: g?.quranPages ?? DEFAULT_GOALS.quranPages,
    istighfar: g?.istighfar ?? DEFAULT_GOALS.istighfar,
    dhikr: g?.dhikr ?? DEFAULT_GOALS.dhikr,
    sadaqaRub: g?.sadaqaRub ?? DEFAULT_GOALS.sadaqaRub,
    duaCount: g?.duaCount ?? DEFAULT_GOALS.duaCount,
  };
}

// ===== start =====
bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const chatId = ctx.chat?.id;

  const { user } = await ensureUserAndDay(userId, chatId);

  // если целей нет — запускаем мастер
  if (!user?.setupDone) {
    return startSetup(ctx, userId);
  }

  const hint = ramadanStart
    ? `Старт Рамадана: ${ramadanStart.format("YYYY-MM-DD")} (${TZ})`
    : `Если хочешь "день Рамадана", задай RAMADAN_START.`;

  return ctx.reply(
    `Ассаляму алейкум!\nТрекер поклонения.\n${hint}\n\nНажми "✅ Отметить сегодня".`,
    mainKeyboard()
  );
});

// ===== setup handler =====
bot.on("text", async (ctx, next) => {
  const userId = String(ctx.from.id);
  const step = setupState.get(userId);
  if (step === undefined) return next();

  const text = (ctx.message.text || "").trim().toLowerCase();
  const s = SETUP_STEPS[step];

  let val;
  if (text === "по умолчанию") {
    val = s.def;
  } else {
    const num = Number(text.replace(",", "."));
    if (Number.isNaN(num) || num < 0) {
      return ctx.reply("Введите число (0 или больше), или напишите: по умолчанию");
    }
    val = Math.round(num);
  }

  await saveGoal(userId, s.key, val);

  const nextStep = step + 1;
  if (nextStep >= SETUP_STEPS.length) {
    setupState.delete(userId);
    await userRef(userId).set({ setupDone: true }, { merge: true });

    const goals = await getGoalsForUser(userId);
    return ctx.reply(
      "✅ Готово! Твои цели сохранены.\n\n" +
        `📖 Коран: ${goals.quranPages} стр\n` +
        `🤍 Истигфар: ${goals.istighfar}\n` +
        `📿 Зикр: ${goals.dhikr}\n` +
        `💰 Садака: ${goals.sadaqaRub}₽\n` +
        `🤲 Дуа: ${goals.duaCount}\n\n` +
        `Теперь нажми "✅ Отметить сегодня".`,
      mainKeyboard()
    );
  }

  setupState.set(userId, nextStep);
  return ctx.reply(setupPrompt(nextStep));
});

// ===== commands/buttons =====
bot.command("today", async (ctx) => {
  const userId = String(ctx.from.id);
  const d = await getToday(userId);
  const goals = await getGoalsForUser(userId);

  await ctx.reply("Отмечай пункты 👇", todayInlineKeyboard(d));
  await ctx.reply(formatTodayReport(d, goals), mainKeyboard());
});

bot.command("reset_today", async (ctx) => {
  const userId = String(ctx.from.id);
  await resetToday(userId);
  await ctx.reply("♻️ Сегодняшние отметки сброшены.", mainKeyboard());
});

bot.hears("✅ Отметить сегодня", async (ctx) => {
  const userId = String(ctx.from.id);
  await ensureUserAndDay(userId, ctx.chat?.id);

  const d = await getToday(userId);
  return ctx.telegram.sendMessage(ctx.chat.id, "Отмечай пункты 👇", todayInlineKeyboard(d));
});

bot.hears("📊 Статистика", (ctx) => ctx.reply("/stats"));
bot.hears("♻️ Сбросить сегодня", (ctx) => ctx.reply("/reset_today"));

// ===== numeric input (increment) =====
function askNumber(ctx, field, prompt) {
  inputState.set(String(ctx.from.id), field);
  return ctx.reply(prompt);
}

bot.on("text", async (ctx, next) => {
  const userId = String(ctx.from.id);
  const field = inputState.get(userId);
  if (!field) return next();

  const raw = (ctx.message.text || "").trim().replace(",", ".");
  const num = Number(raw);

  if (Number.isNaN(num) || num < 0) return ctx.reply("Введите число (0 или больше).");

  inputState.delete(userId);

  const amount = Math.round(num);
  const d = await incrementToday(userId, field, amount);
  const goals = await getGoalsForUser(userId);

  await ctx.reply("✅ Добавил.\n\n" + formatTodayReport(d, goals), mainKeyboard());
});

// ===== callbacks (UI fix) =====
async function refreshInline(ctx, d) {
  return ctx.editMessageReplyMarkup(todayInlineKeyboard(d).reply_markup).catch(() => {});
}

bot.action("mosque_fajr", async (ctx) => {
  await ctx.answerCbQuery();
  const d = await toggleMosque(ctx.from.id, "fajr");
  return refreshInline(ctx, d);
});
bot.action("mosque_dhuhr", async (ctx) => {
  await ctx.answerCbQuery();
  const d = await toggleMosque(ctx.from.id, "dhuhr");
  return refreshInline(ctx, d);
});
bot.action("mosque_asr", async (ctx) => {
  await ctx.answerCbQuery();
  const d = await toggleMosque(ctx.from.id, "asr");
  return refreshInline(ctx, d);
});
bot.action("mosque_maghrib", async (ctx) => {
  await ctx.answerCbQuery();
  const d = await toggleMosque(ctx.from.id, "maghrib");
  return refreshInline(ctx, d);
});
bot.action("mosque_isha", async (ctx) => {
  await ctx.answerCbQuery();
  const d = await toggleMosque(ctx.from.id, "isha");
  return refreshInline(ctx, d);
});

bot.action("toggle_taraweeh", async (ctx) => {
  await ctx.answerCbQuery();
  const d = await toggleBool(ctx.from.id, "taraweeh");
  return refreshInline(ctx, d);
});

bot.action("toggle_tahajjud", async (ctx) => {
  await ctx.answerCbQuery();
  const d = await toggleBool(ctx.from.id, "tahajjud");
  return refreshInline(ctx, d);
});

bot.action("edit_quran", async (ctx) => {
  await ctx.answerCbQuery();
  const goals = await getGoalsForUser(ctx.from.id);
  return askNumber(ctx, "quranPages", `Добавь страницы Корана (суммируется). Цель ${goals.quranPages}:`);
});
bot.action("edit_istighfar", async (ctx) => {
  await ctx.answerCbQuery();
  const goals = await getGoalsForUser(ctx.from.id);
  return askNumber(ctx, "istighfar", `Добавь истигфар (суммируется). Цель ${goals.istighfar}:`);
});
bot.action("edit_dhikr", async (ctx) => {
  await ctx.answerCbQuery();
  const goals = await getGoalsForUser(ctx.from.id);
  return askNumber(ctx, "dhikr", `Добавь зикр (суммируется). Цель ${goals.dhikr}:`);
});
bot.action("edit_sadaqa", async (ctx) => {
  await ctx.answerCbQuery();
  const goals = await getGoalsForUser(ctx.from.id);
  return askNumber(ctx, "sadaqaRub", `Добавь садаку в ₽ (суммируется). Цель ${goals.sadaqaRub}₽:`);
});
bot.action("edit_dua", async (ctx) => {
  await ctx.answerCbQuery();
  const goals = await getGoalsForUser(ctx.from.id);
  return askNumber(ctx, "duaCount", `Добавь дуа (суммируется). Цель ${goals.duaCount}:`);
});

bot.action("show_report", async (ctx) => {
  await ctx.answerCbQuery();
  const d = await getToday(ctx.from.id);
  const goals = await getGoalsForUser(ctx.from.id);
  return ctx.reply(formatTodayReport(d, goals), mainKeyboard());
});

// ===== reminders =====
async function sendReminderToUser(uDoc) {
  const u = uDoc.data();
  const userId = uDoc.id;
  const chatId = u.chatId;
  if (!chatId) return;

  const goals = {
    quranPages: u?.goals?.quranPages ?? DEFAULT_GOALS.quranPages,
    istighfar: u?.goals?.istighfar ?? DEFAULT_GOALS.istighfar,
    dhikr: u?.goals?.dhikr ?? DEFAULT_GOALS.dhikr,
    sadaqaRub: u?.goals?.sadaqaRub ?? DEFAULT_GOALS.sadaqaRub,
    duaCount: u?.goals?.duaCount ?? DEFAULT_GOALS.duaCount,
  };

  const d = await getToday(userId);

  const text =
    `⏰ Напоминание\n` +
    `Что осталось по целям:\n\n` +
    remainingText(d, goals);

  await bot.telegram.sendMessage(chatId, text).catch(() => {});
}

async function sendTahajjudReminder(uDoc) {
  const u = uDoc.data();
  const userId = uDoc.id;
  const chatId = u.chatId;
  if (!chatId) return;

  const d = await getToday(userId);
  if (d.tahajjud) return; // уже отмечено

  await bot.telegram
    .sendMessage(chatId, "🕯 Тахаджуд: напоминание (03:00 МСК). Если встанешь — не забудь отметить ✅")
    .catch(() => {});
}

// каждые 3 часа (в МСК), без намазов/таравиха
cron.schedule(
  "0 */3 * * *",
  async () => {
    const snap = await db.collection("users").where("setupDone", "==", true).get();
    for (const doc of snap.docs) await sendReminderToUser(doc);
  },
  { timezone: TZ }
);

// тахаджуд строго в 03:00 МСК
cron.schedule(
  "0 3 * * *",
  async () => {
    const snap = await db.collection("users").where("setupDone", "==", true).get();
    for (const doc of snap.docs) await sendTahajjudReminder(doc);
  },
  { timezone: TZ }
);

// ===== WEBHOOK RUN (без polling) =====
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL; // https://xxx.onrender.com

if (!BASE_URL) {
  console.error("❌ Укажи BASE_URL в env (https://your-service.onrender.com)");
  process.exit(1);
}

// секретный путь, чтобы никто не слал фейковые апдейты
const secretPath = `/telegraf/${BOT_TOKEN.split(":")[0]}`;

(async () => {
  // ставим webhook
  await bot.telegram.setWebhook(`${BASE_URL}${secretPath}`);
  console.log("🔗 Webhook set:", `${BASE_URL}${secretPath}`);

  // один сервер: webhook + health
  http
    .createServer((req, res) => {
      if (req.method === "POST" && req.url === secretPath) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const update = JSON.parse(body);
            bot.handleUpdate(update);
          } catch (e) {
            // ignore
          }
          res.writeHead(200);
          res.end("ok");
        });
        return;
      }

      res.writeHead(200);
      res.end("ok");
    })
    .listen(PORT, () => console.log("🌐 Server on", PORT));
})();
