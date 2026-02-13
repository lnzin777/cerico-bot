require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
} = require("discord.js");

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const Database = require("better-sqlite3");

// ===================== BOOT / ERROS =====================
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));

// evita crash por event "error" não tratado
// (quando rola erro de API do Discord, sem isso pode derrubar o processo)
function attachClientErrorHandlers(client) {
  client.on("error", (e) => console.error("CLIENT ERROR:", e));
  client.on("shardError", (e) => console.error("SHARD ERROR:", e));
}

console.log("🚀 INDEX CARREGADO:", __filename, "PID:", process.pid);

// ===================== ENV HELPERS =====================
function requireEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Faltou ${name} no Render (Environment).`);
  return v;
}
function optionalEnv(name, fallback = "") {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}
function now() {
  return Date.now();
}
function isSnowflake(s) {
  return typeof s === "string" && /^[0-9]{17,20}$/.test(s);
}

// ===================== CONFIG =====================
const CONFIG = {
  DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
  CLIENT_ID: requireEnv("CLIENT_ID"),
  GUILD_ID: requireEnv("GUILD_ID"),

  PANEL_CHANNEL_ID: requireEnv("PANEL_CHANNEL_ID"),
  PANEL_MESSAGE_ID: optionalEnv("PANEL_MESSAGE_ID", ""),

  TICKET_CATEGORY_ID: requireEnv("TICKET_CATEGORY_ID"),
  LOG_CHANNEL_ID: requireEnv("LOG_CHANNEL_ID"),

  SUPPORT_ROLE_ID: optionalEnv("SUPPORT_ROLE_ID", ""),

  MP_ACCESS_TOKEN: requireEnv("MP_ACCESS_TOKEN"),
  MP_NOTIFICATION_URL: optionalEnv("MP_NOTIFICATION_URL", ""), // https://cerico-bot.onrender.com/mp/webhook
  MP_WEBHOOK_SECRET: optionalEnv("MP_WEBHOOK_SECRET", ""), // opcional

  API_URL: requireEnv("API_URL"),
  API_TOKEN: requireEnv("API_TOKEN"),

  // timers/locks
  TICKET_COOLDOWN_MS: Number(optionalEnv("TICKET_COOLDOWN_MS", "60000")),
  INTERACTION_DEDUPE_MS: Number(optionalEnv("INTERACTION_DEDUPE_MS", "15000")),
  PACK_LOCK_MS: Number(optionalEnv("PACK_LOCK_MS", "15000")),
  CLOSE_LOCK_MS: Number(optionalEnv("CLOSE_LOCK_MS", "8000")),
  AUTO_CLOSE_AFTER_DELIVERY_MS: Number(optionalEnv("AUTO_CLOSE_AFTER_DELIVERY_MS", "8000")),

  // Render
  WEBHOOK_PORT_FALLBACK: Number(optionalEnv("WEBHOOK_PORT", "10000")),

  // instance lock
  INSTANCE_LOCK_TTL_MS: Number(optionalEnv("INSTANCE_LOCK_TTL_MS", "45000")),
  INSTANCE_HEARTBEAT_MS: Number(optionalEnv("INSTANCE_HEARTBEAT_MS", "15000")),
};

if (!isSnowflake(CONFIG.LOG_CHANNEL_ID)) console.warn("⚠️ LOG_CHANNEL_ID inválido?");
if (CONFIG.SUPPORT_ROLE_ID && !isSnowflake(CONFIG.SUPPORT_ROLE_ID)) console.warn("⚠️ SUPPORT_ROLE_ID inválido?");

// ===================== COINS / PACKS =====================
const COIN_BASE_BRL = 1.0;

// 5/10/25/50/100/500 — desconto <=2,5% e 500=5%
const PACKS = [
  { id: "c5", coins: 5, discount: 0.0, emoji: "🟢" },
  { id: "c10", coins: 10, discount: 0.005, emoji: "🟡" },
  { id: "c25", coins: 25, discount: 0.01, emoji: "🟠" },
  { id: "c50", coins: 50, discount: 0.015, emoji: "🔴" },
  { id: "c100", coins: 100, discount: 0.025, emoji: "🔷" },
  { id: "c500", coins: 500, discount: 0.05, emoji: "👑" },
];

function roundUp50(value) {
  return Math.ceil(value * 2) / 2; // arredonda pra cima em 0,50
}
function calculatePrice(pack) {
  const base = pack.coins * COIN_BASE_BRL;
  const discounted = base * (1 - pack.discount);
  return roundUp50(discounted);
}
function brl(v) {
  const n = Number(v);
  return `R$ ${n.toFixed(2).replace(".", ",")}`;
}
function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ===================== DISCORD CLIENT =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});
attachClientErrorHandlers(client);

// ===================== SQLITE =====================
const db = new Database("./loja.sqlite");

// instance lock (anti múltiplas instâncias)
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_lock (
    key TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const stmtGetLock = db.prepare(`SELECT * FROM bot_lock WHERE key = ?`);
const stmtInsertLock = db.prepare(`INSERT INTO bot_lock (key, owner, expires_at, updated_at) VALUES (@key,@owner,@expires_at,@updated_at)`);
const stmtUpdateLock = db.prepare(`UPDATE bot_lock SET owner=@owner, expires_at=@expires_at, updated_at=@updated_at WHERE key=@key`);

function instanceOwnerId() {
  const salt = crypto.randomBytes(3).toString("hex");
  return `pid:${process.pid}:${salt}`;
}

const INSTANCE = {
  key: `guild:${CONFIG.GUILD_ID}`,
  owner: instanceOwnerId(),
  hasLock: false,
  heartbeatTimer: null,
};

function tryAcquireInstanceLockOrExit() {
  const t = now();
  const row = stmtGetLock.get(INSTANCE.key);
  const expiresAt = t + CONFIG.INSTANCE_LOCK_TTL_MS;

  if (!row) {
    stmtInsertLock.run({ key: INSTANCE.key, owner: INSTANCE.owner, expires_at: expiresAt, updated_at: t });
    INSTANCE.hasLock = true;
    console.log(`🔒 Instance lock adquirido (novo) owner=${INSTANCE.owner}`);
    return;
  }

  if (Number(row.expires_at) <= t) {
    stmtUpdateLock.run({ key: INSTANCE.key, owner: INSTANCE.owner, expires_at: expiresAt, updated_at: t });
    INSTANCE.hasLock = true;
    console.log(`🔒 Instance lock assumido (expirado) owner=${INSTANCE.owner}`);
    return;
  }

  if (row.owner === INSTANCE.owner) {
    stmtUpdateLock.run({ key: INSTANCE.key, owner: INSTANCE.owner, expires_at: expiresAt, updated_at: t });
    INSTANCE.hasLock = true;
    console.log(`🔒 Instance lock renovado owner=${INSTANCE.owner}`);
    return;
  }

  console.error(`🛑 Outra instância ativa detectada (owner=${row.owner}). Encerrando esta (owner=${INSTANCE.owner}).`);
  process.exit(1);
}

function startInstanceHeartbeat() {
  if (!INSTANCE.hasLock) return;
  if (INSTANCE.heartbeatTimer) clearInterval(INSTANCE.heartbeatTimer);

  INSTANCE.heartbeatTimer = setInterval(() => {
    try {
      const t = now();
      const row = stmtGetLock.get(INSTANCE.key);
      if (!row || row.owner !== INSTANCE.owner) {
        console.error("🛑 Perdi o lock de instância. Encerrando para evitar duplicação.");
        process.exit(1);
      }
      stmtUpdateLock.run({
        key: INSTANCE.key,
        owner: INSTANCE.owner,
        expires_at: t + CONFIG.INSTANCE_LOCK_TTL_MS,
        updated_at: t,
      });
    } catch (e) {
      console.error("⚠️ heartbeat lock erro:", e?.message || e);
    }
  }, CONFIG.INSTANCE_HEARTBEAT_MS);
}

// perfis (nick/email)
db.exec(`
  CREATE TABLE IF NOT EXISTS user_profile (
    discord_id TEXT PRIMARY KEY,
    nick TEXT DEFAULT '',
    email TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  );
`);

const stmtGetProfile = db.prepare(`SELECT nick, email FROM user_profile WHERE discord_id = ?`);
const stmtUpsertProfile = db.prepare(`
  INSERT INTO user_profile (discord_id, nick, email, updated_at)
  VALUES (@discord_id, @nick, @email, @updated_at)
  ON CONFLICT(discord_id) DO UPDATE SET
    nick=excluded.nick,
    email=excluded.email,
    updated_at=excluded.updated_at;
`);

// compras (idempotência real)
db.exec(`
  CREATE TABLE IF NOT EXISTS purchases (
    order_id TEXT PRIMARY KEY,
    payment_id TEXT DEFAULT '',
    preference_id TEXT DEFAULT '',
    buyer_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    nick TEXT NOT NULL,
    email TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    coins INTEGER NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_purchases_payment_id ON purchases(payment_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_purchases_channel_status ON purchases(channel_id, status);`);

const stmtInsertPurchase = db.prepare(`
  INSERT INTO purchases (order_id, payment_id, preference_id, buyer_id, channel_id, nick, email, pack_id, coins, amount, status, created_at, updated_at)
  VALUES (@order_id,@payment_id,@preference_id,@buyer_id,@channel_id,@nick,@email,@pack_id,@coins,@amount,@status,@created_at,@updated_at)
`);

const stmtUpdatePurchase = db.prepare(`
  UPDATE purchases
  SET payment_id=@payment_id, preference_id=@preference_id, status=@status, updated_at=@updated_at
  WHERE order_id=@order_id
`);

const stmtGetPurchaseByOrder = db.prepare(`SELECT * FROM purchases WHERE order_id = ?`);
const stmtGetPurchaseByPayment = db.prepare(`SELECT * FROM purchases WHERE payment_id = ?`);
const stmtFindPendingInChannel = db.prepare(`
  SELECT * FROM purchases
  WHERE channel_id = ? AND status IN ('PENDING','APPROVED')
  ORDER BY created_at DESC
  LIMIT 1
`);

// ===================== STATE (RAM) =====================
const STATE = {
  handledInteractions: new Map(), // interactionId -> ts
  packLocks: new Map(), // channelId -> { until, by }
  closeLocks: new Map(), // channelId -> { until, by }
  ticketCooldown: new Map(), // userId -> ts
  openTickets: new Map(), // userId -> channelId (cache simples)
  delivering: new Set(), // paymentId (runtime lock)
};

function cleanupOldInteractionDedupe() {
  const t = now();
  for (const [id, ts] of STATE.handledInteractions.entries()) {
    if (t - ts > CONFIG.INTERACTION_DEDUPE_MS) STATE.handledInteractions.delete(id);
  }
}
function isDuplicateInteraction(interactionId) {
  cleanupOldInteractionDedupe();
  if (STATE.handledInteractions.has(interactionId)) return true;
  STATE.handledInteractions.set(interactionId, now());
  return false;
}

function acquireTimedLock(map, key, byUserId, ms) {
  const t = now();
  const cur = map.get(key);
  if (cur && cur.until > t) return { ok: false, waitMs: cur.until - t, by: cur.by };
  map.set(key, { until: t + ms, by: byUserId });
  return { ok: true };
}
function releaseLock(map, key) {
  map.delete(key);
}

// ===================== TOPIC HELPERS (ticket) =====================
function parseTopic(topic = "") {
  const obj = {};
  topic
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [k, ...rest] = pair.split("=");
      if (!k) return;
      obj[k] = rest.join("=") || "";
    });
  return obj;
}
function buildTopic(obj) {
  return Object.entries(obj)
    .filter(([_, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(";");
}
function isTicketChannel(ch) {
  return ch && ch.type === ChannelType.GuildText && typeof ch.name === "string" && ch.name.startsWith("ticket-");
}
function safeTicketName(user) {
  const safe = user.username.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `ticket-${safe}-${user.id.slice(-4)}`;
}

// ===================== SAFE RESPONDER =====================
function createSafeResponder(interaction) {
  let deferredTried = false;

  async function ensureDefer() {
    if (interaction.deferred || interaction.replied || deferredTried) return;
    deferredTried = true;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch {
      // já foi ack
    }
  }

  async function reply(content, extra = {}) {
    const payload = { content: String(content ?? ""), flags: MessageFlags.Ephemeral, ...extra };

    // se já deferiu, usa editReply
    if (interaction.deferred) {
      try {
        return await interaction.editReply(payload);
      } catch {}
    }

    // se ainda não respondeu
    if (!interaction.replied) {
      try {
        return await interaction.reply(payload);
      } catch {}
    }

    // fallback
    try {
      return await interaction.followUp(payload);
    } catch {}

    return null;
  }

  return { ensureDefer, reply };
}

// ===================== LOGS =====================
async function sendPurchaseLog(data) {
  try {
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID).catch(() => null);
    if (!guild) return;

    const ch = await guild.channels.fetch(CONFIG.LOG_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.isTextBased()) return;

    const pack = PACKS.find((p) => p.id === data.packId);
    const content =
      `🧾 **LOG COMPRA (COINS)**\n` +
      `• Status: **${data.status}**\n` +
      `• Modo: **PROD**\n` +
      `• buyerId: **${data.buyerId}** (<@${data.buyerId}>)\n` +
      `• Nick: **${data.nick || "—"}**\n` +
      `• Email: **${data.email || "—"}**\n` +
      `• Pack: **${pack ? `${pack.coins} coins (${pack.id})` : data.packId}**\n` +
      `• Amount: **${data.amount != null ? brl(data.amount) : "—"}**\n` +
      `• orderId: **${data.orderId || "—"}**\n` +
      `• paymentId: **${data.paymentId || "—"}**\n` +
      `• timestamp: <t:${Math.floor((data.timestamp || now()) / 1000)}:F>`;

    await ch.send({ content }).catch(() => {});
  } catch (e) {
    console.log("❌ sendPurchaseLog falhou:", e?.message || e);
  }
}

// ===================== UI (painel/ticket) =====================
function buildPanel() {
  const embed = new EmbedBuilder()
    .setColor("#f1c40f")
    .setTitle("🪙 Loja Oficial de Coins")
    .setDescription(
      "Adquira suas **Coins** com segurança e entrega automática.\n\n" +
        "**Como funciona:**\n" +
        "1) Abra um ticket\n" +
        "2) Envie seu **Nick** e **Email**\n" +
        "3) Escolha um pack e pague pelo Mercado Pago\n" +
        "4) A entrega acontece automaticamente\n\n" +
        "📌 **1 Coin = R$ 1,00**\n" +
        "🔐 Sistema protegido contra duplicação"
    )
    .setFooter({ text: "Sistema automático • Seguro • Profissional" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_ticket").setLabel("Abrir Ticket").setStyle(ButtonStyle.Primary).setEmoji("🎟️")
  );

  return { embeds: [embed], components: [row] };
}

function buildPackButtons(disabled = false) {
  const rows = [];
  let row = new ActionRowBuilder();

  for (const pack of PACKS) {
    const price = calculatePrice(pack);

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`pack:${pack.id}`)
        .setLabel(`${pack.coins} coins (${brl(price)})`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(pack.emoji)
        .setDisabled(disabled)
    );

    if (row.components.length === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
  }

  if (row.components.length) rows.push(row);

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("close_ticket").setLabel("Fechar Ticket").setStyle(ButtonStyle.Danger).setEmoji("🔒")
    )
  );

  return rows;
}

async function sendOrEditPanel() {
  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  const channel = await guild.channels.fetch(CONFIG.PANEL_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.log("❌ PANEL_CHANNEL_ID inválido");
    return;
  }

  const payload = buildPanel();

  if (CONFIG.PANEL_MESSAGE_ID) {
    try {
      const msg = await channel.messages.fetch(CONFIG.PANEL_MESSAGE_ID);
      await msg.edit(payload);
      console.log("✅ Painel editado (sem duplicar).");
      return;
    } catch {
      console.log("⚠️ PANEL_MESSAGE_ID inválido/apagado, criando novo painel...");
    }
  }

  const newMsg = await channel.send(payload);
  console.log("✅ Painel criado. Salve isso no Render ENV para nunca duplicar:");
  console.log("PANEL_MESSAGE_ID=" + newMsg.id);
}

// ===================== TICKET =====================
function canCloseTicket(interaction, buyerId) {
  if (buyerId && interaction.user.id === buyerId) return true;

  const member = interaction.member;
  if (!member) return false;

  if (member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;

  if (CONFIG.SUPPORT_ROLE_ID) {
    try {
      if (member.roles?.cache?.has(CONFIG.SUPPORT_ROLE_ID)) return true;
    } catch {}
  }
  return false;
}

async function createTicket(guild, user) {
  // cooldown simples
  const t = now();
  const last = STATE.ticketCooldown.get(user.id) || 0;
  if (t - last < CONFIG.TICKET_COOLDOWN_MS) {
    const wait = Math.ceil((CONFIG.TICKET_COOLDOWN_MS - (t - last)) / 1000);
    return { ok: false, reason: `Aguarde ${wait}s para abrir outro ticket.` };
  }

  // se já tem ticket no cache, tenta apontar
  const cached = STATE.openTickets.get(user.id);
  if (cached) {
    const existing = await guild.channels.fetch(cached).catch(() => null);
    if (existing && existing.type === ChannelType.GuildText) {
      return { ok: false, reason: `Você já tem um ticket aberto: <#${existing.id}>` };
    }
    STATE.openTickets.delete(user.id);
  }

  const profile = stmtGetProfile.get(user.id) || { nick: "", email: "" };

  const channel = await guild.channels.create({
    name: safeTicketName(user),
    type: ChannelType.GuildText,
    parent: CONFIG.TICKET_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      ...(CONFIG.SUPPORT_ROLE_ID
        ? [{ id: CONFIG.SUPPORT_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }]
        : []),
    ],
  });

  STATE.ticketCooldown.set(user.id, t);
  STATE.openTickets.set(user.id, channel.id);

  const embed = new EmbedBuilder()
    .setColor("#2ecc71")
    .setTitle("🪙 Compra de Coins")
    .setDescription(
      "**Passo 1:** Envie seu **Nick** (no chat)\n" +
        "**Passo 2:** Envie seu **Email** (no chat) ou use `/setemail`\n" +
        "**Passo 3:** Escolha um pack abaixo para gerar o link de pagamento\n\n" +
        `📌 Nick salvo: **${(profile.nick || "").trim() || "—"}**\n` +
        `📌 Email salvo: **${(profile.email || "").trim() || "—"}**`
    )
    .setFooter({ text: "Após pagar, a entrega é automática." });

  const menuMsg = await channel.send({ embeds: [embed], components: buildPackButtons(false) });

  // topic guarda buyer, nick, email, menuMsgId, orderId e closing
  const topicObj = {
    buyer: user.id,
    nick: (profile.nick || "").trim(),
    email: (profile.email || "").trim(),
    menuMsgId: menuMsg.id,
    orderId: "",
    closing: "0",
  };
  await channel.setTopic(buildTopic(topicObj)).catch(() => {});

  return { ok: true, channelId: channel.id };
}

async function safeCloseTicket(channel, reasonText) {
  if (!channel || !isTicketChannel(channel)) return;

  const topicObj = parseTopic(channel.topic || "");
  if (String(topicObj.closing || "0") === "1") return; // já está fechando

  topicObj.closing = "1";
  await channel.setTopic(buildTopic(topicObj)).catch(() => {});

  await channel.send(`🔒 ${reasonText}`).catch(() => {});
  setTimeout(() => channel.delete().catch(() => {}), 2000);
}

// ===================== MERCADO PAGO =====================
function mpHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${CONFIG.MP_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    ...extra,
  };
}
function idempotencyKey() {
  return crypto.randomUUID();
}

async function createPreference(pack, buyerId, channelId, nick, email) {
  const price = calculatePrice(pack);
  const orderId = `ORD-${buyerId}-${Date.now()}`;

  // salva compra
  stmtInsertPurchase.run({
    order_id: orderId,
    payment_id: "",
    preference_id: "",
    buyer_id: buyerId,
    channel_id: channelId,
    nick,
    email,
    pack_id: pack.id,
    coins: pack.coins,
    amount: price,
    status: "PENDING",
    created_at: now(),
    updated_at: now(),
  });

  const body = {
    items: [
      {
        title: `${pack.coins} Coins`,
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(price),
      },
    ],
    payer: email ? { email } : undefined,
    external_reference: orderId,
  };

  if (CONFIG.MP_NOTIFICATION_URL) body.notification_url = CONFIG.MP_NOTIFICATION_URL;

  const res = await axios.post("https://api.mercadopago.com/checkout/preferences", body, {
    headers: mpHeaders({ "X-Idempotency-Key": idempotencyKey() }),
    timeout: 15000,
  });

  const preferenceId = String(res.data?.id || "");
  stmtUpdatePurchase.run({
    order_id: orderId,
    payment_id: "",
    preference_id: preferenceId,
    status: "PENDING",
    updated_at: now(),
  });

  return { link: String(res.data?.init_point || ""), orderId, preferenceId, amount: price };
}

async function getPayment(paymentId) {
  const res = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: mpHeaders(),
    timeout: 15000,
  });
  return res.data;
}

// assinatura webhook opcional
function verifyMpSignature({ xSignature, xRequestId, dataId }) {
  if (!CONFIG.MP_WEBHOOK_SECRET) return true;

  try {
    if (!xSignature || !xRequestId || !dataId) return false;

    let ts = "";
    let hash = "";
    for (const part of String(xSignature).split(",")) {
      const [k, v] = part.split("=");
      if (!k || !v) continue;
      const key = k.trim();
      const val = v.trim();
      if (key === "ts") ts = val;
      if (key === "v1") hash = val;
    }
    if (!ts || !hash) return false;

    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const expected = crypto.createHmac("sha256", CONFIG.MP_WEBHOOK_SECRET).update(manifest).digest("hex");

    return expected === hash;
  } catch {
    return false;
  }
}

// ===================== ENTREGA (API) =====================
// padrão recomendado: API_URL?token=...&player=...&coins=...&orderId=...
// se sua API hoje usa outro formato, ela ainda vai receber orderId e token
async function deliverCoins({ nick, coins, orderId }) {
  const base = CONFIG.API_URL;
  const join = base.includes("?") ? "&" : "?";
  const url =
    base +
    join +
    `token=${encodeURIComponent(CONFIG.API_TOKEN)}` +
    `&player=${encodeURIComponent(nick)}` +
    `&coins=${encodeURIComponent(String(coins))}` +
    `&orderId=${encodeURIComponent(orderId)}`;

  console.log("🎮 [GAME] chamando API:", url.replace(CONFIG.API_TOKEN, "***"));
  const res = await axios.get(url, { timeout: 15000 });
  console.log("🎮 [GAME] resposta:", res.data);
  return res.data;
}

// ===================== WEBHOOK PROCESS =====================
async function processPaymentFromWebhook(paymentId) {
  if (!paymentId) return;

  if (STATE.delivering.has(String(paymentId))) {
    console.log("🟨 delivery runtime lock ativo:", paymentId);
    return;
  }
  STATE.delivering.add(String(paymentId));

  try {
    const existingPay = stmtGetPurchaseByPayment.get(String(paymentId));
    if (existingPay && existingPay.status === "DELIVERED") return;

    const payment = await getPayment(paymentId);
    const status = String(payment?.status || "unknown");
    const orderId = String(payment?.external_reference || "");

    console.log("[MP] payment", paymentId, "status", status, "orderId", orderId);

    if (!orderId) return;

    const purchase = stmtGetPurchaseByOrder.get(orderId);
    if (!purchase) {
      console.log("⚠️ Compra não encontrada:", orderId);
      return;
    }

    // atualiza status e payment_id
    stmtUpdatePurchase.run({
      order_id: orderId,
      payment_id: String(paymentId),
      preference_id: String(purchase.preference_id || ""),
      status: status.toUpperCase(),
      updated_at: now(),
    });

    if (status !== "approved") {
      await sendPurchaseLog({
        status: status.toUpperCase(),
        buyerId: purchase.buyer_id,
        nick: purchase.nick,
        email: purchase.email,
        packId: purchase.pack_id,
        amount: purchase.amount,
        orderId,
        paymentId: String(paymentId),
        timestamp: now(),
      });
      return;
    }

    const refreshed = stmtGetPurchaseByOrder.get(orderId);
    if (refreshed && refreshed.status === "DELIVERED") return;

    const channel = await client.channels.fetch(purchase.channel_id).catch(() => null);
    if (channel?.isTextBased()) {
      await channel.send(`✅ Pagamento aprovado! Entregando **${purchase.coins} coins**...`).catch(() => {});
    }

    const result = await deliverCoins({ nick: purchase.nick, coins: purchase.coins, orderId });
    const ok = result && (result.ok === true || result.success === true);

    if (ok) {
      stmtUpdatePurchase.run({
        order_id: orderId,
        payment_id: String(paymentId),
        preference_id: String(purchase.preference_id || ""),
        status: "DELIVERED",
        updated_at: now(),
      });

      await sendPurchaseLog({
        status: "DELIVERED",
        buyerId: purchase.buyer_id,
        nick: purchase.nick,
        email: purchase.email,
        packId: purchase.pack_id,
        amount: purchase.amount,
        orderId,
        paymentId: String(paymentId),
        timestamp: now(),
      });

      if (channel?.isTextBased()) {
        await channel.send("🎉 Coins entregues com sucesso! Ticket será fechado automaticamente.").catch(() => {});
        setTimeout(() => channel.delete().catch(() => {}), CONFIG.AUTO_CLOSE_AFTER_DELIVERY_MS);
      }
      return;
    }

    // falhou entrega
    stmtUpdatePurchase.run({
      order_id: orderId,
      payment_id: String(paymentId),
      preference_id: String(purchase.preference_id || ""),
      status: "DELIVERY_ERROR",
      updated_at: now(),
    });

    await sendPurchaseLog({
      status: "DELIVERY_ERROR",
      buyerId: purchase.buyer_id,
      nick: purchase.nick,
      email: purchase.email,
      packId: purchase.pack_id,
      amount: purchase.amount,
      orderId,
      paymentId: String(paymentId),
      timestamp: now(),
    });

    if (channel?.isTextBased()) {
      await channel.send(`❌ Erro na entrega: \`${safeJson(result)}\``).catch(() => {});
    }
  } catch (e) {
    console.log("❌ processPaymentFromWebhook erro:", e?.response?.data || e?.message || e);
  } finally {
    STATE.delivering.delete(String(paymentId));
  }
}

// ===================== WEBHOOK SERVER =====================
function startWebhook() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_, res) => res.json({ ok: true }));

  if (!CONFIG.MP_WEBHOOK_SECRET) {
    console.log("🔎 MP signature check: OFF");
  } else {
    console.log("🔎 MP signature check: ON");
  }

  app.post("/mp/webhook", async (req, res) => {
    // responde rápido
    res.sendStatus(200);

    try {
      // MP geralmente manda { data: { id }, type: "payment" }
      const dataId = String(req.body?.data?.id || req.query["data.id"] || req.query.id || "");
      const topic = String(req.body?.type || req.query.type || "");

      const xSignature = req.headers["x-signature"];
      const xRequestId = req.headers["x-request-id"];

      console.log("[MP WEBHOOK] recebido:", { topic, dataId });
      if (!dataId) return;

      const okSig = verifyMpSignature({ xSignature, xRequestId, dataId });
      if (!okSig) {
        console.log("[MP WEBHOOK] assinatura inválida. Ignorando:", { dataId });
        return;
      }

      await processPaymentFromWebhook(dataId);
    } catch (e) {
      console.log("❌ webhook error:", e?.response?.data || e?.message || e);
    }
  });

  const PORT = Number(process.env.PORT || CONFIG.WEBHOOK_PORT_FALLBACK || 10000);
  app.listen(PORT, () => console.log(`🌐 Webhook rodando na porta ${PORT} (/mp/webhook)`));
}

// ===================== SLASH COMMANDS (setnick/setemail) =====================
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("setnick")
      .setDescription("Define seu nick para entrega")
      .addStringOption((opt) => opt.setName("nick").setDescription("Seu nick no jogo").setRequired(true))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("setemail")
      .setDescription("Define seu email para pagamento")
      .addStringOption((opt) => opt.setName("email").setDescription("Seu email").setRequired(true))
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(CONFIG.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID), { body: commands });
  console.log("✅ Slash commands registrados: /setnick /setemail");
}

// ===================== messageCreate: captura nick/email no ticket =====================
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;
    if (msg.author?.bot) return;
    if (!isTicketChannel(msg.channel)) return;

    const channel = msg.channel;
    const topicObj = parseTopic(channel.topic || "");
    const buyerId = String(topicObj.buyer || "").trim();
    if (!buyerId || msg.author.id !== buyerId) return;

    const text = String(msg.content || "").trim();
    if (!text) return;

    const currentNick = String(topicObj.nick || "").trim();
    const currentEmail = String(topicObj.email || "").trim();

    // nick
    if (!currentNick) {
      const nick = text;
      const cur = stmtGetProfile.get(msg.author.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({ discord_id: msg.author.id, nick, email: cur.email || "", updated_at: now() });

      topicObj.nick = nick;
      await channel.setTopic(buildTopic(topicObj)).catch(() => {});
      await channel.send(`✅ Nick salvo: **${nick}**\nAgora envie seu **email** (ou use /setemail).`).catch(() => {});
      return;
    }

    // email
    const looksEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    if (!currentEmail && looksEmail) {
      const email = text.toLowerCase();
      const cur = stmtGetProfile.get(msg.author.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({ discord_id: msg.author.id, nick: cur.nick || currentNick, email, updated_at: now() });

      topicObj.email = email;
      await channel.setTopic(buildTopic(topicObj)).catch(() => {});
      await channel.send(`✅ Email salvo: **${email}**\nAgora clique no pack para gerar o link.`).catch(() => {});
      return;
    }
  } catch (e) {
    console.log("⚠️ messageCreate error:", e?.message || e);
  }
});

// ===================== INTERACTIONS =====================
async function handleButton(interaction) {
  if (isDuplicateInteraction(interaction.id)) {
    console.log("🟨 DEDUPE interaction:", interaction.id, interaction.customId);
    return;
  }

  const { ensureDefer, reply } = createSafeResponder(interaction);
  await ensureDefer();

  try {
    const customId = interaction.customId;
    console.log("[BTN]", customId, "by", interaction.user.id, "in", interaction.channelId);

    // OPEN
    if (customId === "open_ticket") {
      const result = await createTicket(interaction.guild, interaction.user);
      if (!result.ok) return reply(`⚠️ ${result.reason}`);
      return reply(`✅ Ticket criado! Vá para: <#${result.channelId}>`);
    }

    // daqui pra baixo precisa estar dentro de ticket
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased() || !isTicketChannel(channel)) {
      return reply("⚠️ Use isso dentro de um ticket válido.");
    }

    const topicObj = parseTopic(channel.topic || "");
    const buyerId = String(topicObj.buyer || "").trim();

    // CLOSE
    if (customId === "close_ticket") {
      const lock = acquireTimedLock(STATE.closeLocks, channel.id, interaction.user.id, CONFIG.CLOSE_LOCK_MS);
      if (!lock.ok) return reply("⏳ Fechamento já em andamento...");

      try {
        if (!canCloseTicket(interaction, buyerId)) {
          return reply("⚠️ Você não tem permissão para fechar este ticket.");
        }
        await reply("🔒 Fechando em instantes...");
        await safeCloseTicket(channel, "Ticket fechado.");
        return;
      } finally {
        // lock vai expirar sozinho, mas pode liberar também
        releaseLock(STATE.closeLocks, channel.id);
      }
    }

    // PACK
    if (customId.startsWith("pack:")) {
      // só buyer pode comprar
      if (!buyerId || interaction.user.id !== buyerId) {
        return reply("⚠️ Só quem abriu o ticket pode escolher o pack.");
      }

      const lock = acquireTimedLock(STATE.packLocks, channel.id, interaction.user.id, CONFIG.PACK_LOCK_MS);
      if (!lock.ok) {
        const s = Math.ceil(lock.waitMs / 1000);
        return reply(`⏳ Aguarde ${s}s... estou processando uma compra neste ticket.`);
      }

      try {
        // responde rápido
        await reply("⏳ Gerando link de pagamento...");

        // anti-spam: já existe pendente nesse ticket?
        const pending = stmtFindPendingInChannel.get(channel.id);
        if (pending) {
          return reply(
            `⚠️ Já existe um pedido **pendente** neste ticket.\n` +
              `🧾 orderId: **${pending.order_id}**\n` +
              `Finalize o pagamento antes de gerar outro link.`
          );
        }

        const packId = customId.split(":")[1];
        const pack = PACKS.find((p) => p.id === packId);
        if (!pack) return reply("❌ Pack inválido.");

        const nick = String(topicObj.nick || "").trim();
        const email = String(topicObj.email || "").trim();

        if (!nick) return reply("❌ Envie seu **nick** no chat do ticket (primeira mensagem) ou use /setnick.");
        if (!email) return reply("❌ Envie seu **email** no chat do ticket (ou use /setemail).");

        const { link, orderId, amount } = await createPreference(pack, interaction.user.id, channel.id, nick, email);
        if (!link) return reply("❌ Mercado Pago não retornou o link (init_point).");

        // atualiza topic com orderId
        topicObj.orderId = orderId;
        await channel.setTopic(buildTopic(topicObj)).catch(() => {});

        // desabilita botões (menuMsgId)
        const menuMsgId = String(topicObj.menuMsgId || "").trim();
        if (menuMsgId) {
          try {
            const menuMsg = await channel.messages.fetch(menuMsgId);
            await menuMsg.edit({ components: buildPackButtons(true) });
          } catch {
            await channel.send({ content: "🔒 Packs bloqueados (aguardando pagamento).", components: buildPackButtons(true) }).catch(() => {});
          }
        } else {
          await channel.send({ content: "🔒 Packs bloqueados (aguardando pagamento).", components: buildPackButtons(true) }).catch(() => {});
        }

        const priceText = brl(amount);
        await channel
          .send(
            `✅ **Link de pagamento gerado!**\n` +
              `📦 Pack: **${pack.coins} coins**\n` +
              `💰 Valor: **${priceText}**\n` +
              `👤 Nick: **${nick}**\n` +
              `🧾 Pedido: **${orderId}**\n\n` +
              `👉 **Pagar agora:** ${link}\n\n` +
              `⚡ Após o pagamento ser aprovado, a entrega será automática.`
          )
          .catch(() => {});

        await sendPurchaseLog({
          status: "PENDING",
          buyerId: interaction.user.id,
          nick,
          email,
          packId: pack.id,
          amount,
          orderId,
          paymentId: "—",
          timestamp: now(),
        });

        return reply("✅ Link enviado no ticket!");
      } catch (e) {
        console.log("❌ PACK erro:", e?.response?.data || e?.message || e);
        return reply("❌ Não consegui gerar o link agora. Tente novamente.");
      } finally {
        releaseLock(STATE.packLocks, channel.id);
      }
    }

    return reply("⚠️ Botão desconhecido.");
  } catch (e) {
    console.error("❌ handleButton crash:", e);
    try {
      return await reply("❌ Erro interno ao processar o botão.");
    } catch {}
  }
}

async function handleCommand(interaction) {
  if (isDuplicateInteraction(interaction.id)) {
    console.log("🟨 DEDUPE cmd:", interaction.id, interaction.commandName);
    return;
  }

  const { ensureDefer, reply } = createSafeResponder(interaction);
  await ensureDefer();

  try {
    console.log("[CMD]", interaction.commandName, "by", interaction.user.id, "in", interaction.channelId);

    if (interaction.commandName === "setnick") {
      const nick = interaction.options.getString("nick", true).trim();
      if (!nick || nick.length < 2) return reply("❌ Nick inválido.");

      const cur = stmtGetProfile.get(interaction.user.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({ discord_id: interaction.user.id, nick, email: cur.email || "", updated_at: now() });

      if (interaction.channel && isTicketChannel(interaction.channel)) {
        const topicObj = parseTopic(interaction.channel.topic || "");
        if (String(topicObj.buyer || "") === interaction.user.id) {
          topicObj.nick = nick;
          await interaction.channel.setTopic(buildTopic(topicObj)).catch(() => {});
        }
      }

      return reply(`✅ Nick atualizado para **${nick}**.`);
    }

    if (interaction.commandName === "setemail") {
      const email = interaction.options.getString("email", true).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply("❌ Email inválido.");

      const cur = stmtGetProfile.get(interaction.user.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({ discord_id: interaction.user.id, nick: cur.nick || "", email, updated_at: now() });

      if (interaction.channel && isTicketChannel(interaction.channel)) {
        const topicObj = parseTopic(interaction.channel.topic || "");
        if (String(topicObj.buyer || "") === interaction.user.id) {
          topicObj.email = email;
          await interaction.channel.setTopic(buildTopic(topicObj)).catch(() => {});
        }
      }

      return reply(`✅ Email atualizado para **${email}**.`);
    }

    return reply("⚠️ Comando desconhecido.");
  } catch (e) {
    console.error("❌ handleCommand crash:", e);
    return reply("❌ Erro no comando.");
  }
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (e) {
    console.error("❌ interactionCreate crash:", e);
    try {
      const { ensureDefer, reply } = createSafeResponder(interaction);
      await ensureDefer();
      await reply("❌ Erro interno inesperado.");
    } catch {}
  }
});

// ===================== READY =====================
client.once("ready", async () => {
  console.log(`✅ Bot online como: ${client.user.tag}`);

  // registra slash
  try {
    await registerSlashCommands();
  } catch (e) {
    console.log("⚠️ Falha ao registrar slash commands:", e?.message || e);
  }

  // painel sem duplicar
  try {
    await sendOrEditPanel();
  } catch (e) {
    console.log("⚠️ Falha ao criar/editar painel:", e?.message || e);
  }
});

// ===================== START =====================
tryAcquireInstanceLockOrExit();
startInstanceHeartbeat();
startWebhook();
client.login(CONFIG.DISCORD_TOKEN);
