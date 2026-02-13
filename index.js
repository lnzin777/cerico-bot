/**
 * index.js — Discord.js v14 + Tickets + SQLite + Mercado Pago (PROD) Checkout Pro + Webhook + Entrega
 * - Sem modo teste
 * - Render-ready (PORT)
 * - Anti-duplicação (instância + idempotência + lock por ticket)
 * - Fechar ticket (buyer OU suporte OU ManageChannels)
 */

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

// ===================== BOOT / ERROS GLOBAIS =====================
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
console.log("🚀 INDEX CARREGADO:", __filename, "PID:", process.pid);

// ===================== ENV HELPERS =====================
function requireEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Faltou ${name} nas variáveis de ambiente (Render/Windows .env).`);
  return v;
}
function optionalEnv(name, fallback = "") {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}
function isSnowflake(s) {
  return typeof s === "string" && /^[0-9]{17,20}$/.test(s);
}
function now() {
  return Date.now();
}

// ===================== CONFIG =====================
const CONFIG = Object.freeze({
  // Discord
  DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
  CLIENT_ID: requireEnv("CLIENT_ID"),
  GUILD_ID: requireEnv("GUILD_ID"),
  PANEL_CHANNEL_ID: requireEnv("PANEL_CHANNEL_ID"),
  PANEL_MESSAGE_ID: optionalEnv("PANEL_MESSAGE_ID", ""),
  TICKET_CATEGORY_ID: requireEnv("TICKET_CATEGORY_ID"),
  LOG_CHANNEL_ID: requireEnv("LOG_CHANNEL_ID"),
  SUPPORT_ROLE_ID: optionalEnv("SUPPORT_ROLE_ID", ""),

  // Mercado Pago (PROD)
  MP_ACCESS_TOKEN: requireEnv("MP_ACCESS_TOKEN"),
  MP_WEBHOOK_SECRET: optionalEnv("MP_WEBHOOK_SECRET", ""), // recomendado
  MP_NOTIFICATION_URL: optionalEnv("MP_NOTIFICATION_URL", ""), // recomendado (sua URL do Render)

  // Entrega (sua API)
  API_URL: requireEnv("API_URL"),
  API_TOKEN: requireEnv("API_TOKEN"),

  // Timers
  TICKET_COOLDOWN_MS: Number(optionalEnv("TICKET_COOLDOWN_MS", "60000")),
  INACTIVITY_CLOSE_MS: Number(optionalEnv("INACTIVITY_CLOSE_MS", String(10 * 60 * 1000))), // 10 min
  DELETE_DELAY_MS: Number(optionalEnv("DELETE_DELAY_MS", "2500")),
  AUTO_CLOSE_AFTER_DELIVERY_MS: Number(optionalEnv("AUTO_CLOSE_AFTER_DELIVERY_MS", "10000")),

  // Locks
  INSTANCE_LOCK_TTL_MS: Number(optionalEnv("INSTANCE_LOCK_TTL_MS", "45000")), // lock expira se não tiver heartbeat
  INSTANCE_HEARTBEAT_MS: Number(optionalEnv("INSTANCE_HEARTBEAT_MS", "15000")),
  INTERACTION_DEDUPE_MS: Number(optionalEnv("INTERACTION_DEDUPE_MS", "12000")),
  PACK_LOCK_MS: Number(optionalEnv("PACK_LOCK_MS", "15000")),

  // Web server
  WEBHOOK_PORT_FALLBACK: Number(optionalEnv("WEBHOOK_PORT", "10000")),
});

if (!isSnowflake(CONFIG.LOG_CHANNEL_ID)) {
  console.warn("⚠️ LOG_CHANNEL_ID parece inválido. Use apenas números (snowflake).");
}
if (CONFIG.SUPPORT_ROLE_ID && !isSnowflake(CONFIG.SUPPORT_ROLE_ID)) {
  console.warn("⚠️ SUPPORT_ROLE_ID parece inválido. Use apenas números (snowflake).");
}

// ===================== PACKS =====================
const PACKS = Object.freeze([
  { id: "p25", label: "25 pontos", emoji: "🟢", price: 5.0 },
  { id: "p50", label: "50 pontos", emoji: "🟡", price: 10.0 },
  { id: "p100", label: "100 pontos", emoji: "🟠", price: 20.0 },
  { id: "p250", label: "250 pontos", emoji: "🔴", price: 45.0 },
]);

function brl(v) {
  return `R$ ${Number(v).toFixed(2).replace(".", ",")}`;
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

// ===================== SQLITE =====================
const db = new Database("./loja.sqlite");

// --- Lock de instância (anti múltiplas instâncias) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_lock (
    key TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const stmtGetLock = db.prepare(`SELECT * FROM bot_lock WHERE key = ?`);
const stmtInsertLock = db.prepare(`
  INSERT INTO bot_lock (key, owner, expires_at, updated_at)
  VALUES (@key, @owner, @expires_at, @updated_at)
`);
const stmtUpdateLock = db.prepare(`
  UPDATE bot_lock SET owner=@owner, expires_at=@expires_at, updated_at=@updated_at
  WHERE key=@key
`);

function instanceOwnerId() {
  // identifica a instância (PID + random curto)
  const salt = crypto.randomBytes(3).toString("hex");
  return `pid:${process.pid}:${salt}`;
}

const INSTANCE = {
  key: `guild:${CONFIG.GUILD_ID}`,
  owner: instanceOwnerId(),
  heartbeatTimer: null,
  hasLock: false,
};

function tryAcquireInstanceLockOrExit() {
  const t = now();
  const row = stmtGetLock.get(INSTANCE.key);
  const expiresAt = t + CONFIG.INSTANCE_LOCK_TTL_MS;

  if (!row) {
    stmtInsertLock.run({
      key: INSTANCE.key,
      owner: INSTANCE.owner,
      expires_at: expiresAt,
      updated_at: t,
    });
    INSTANCE.hasLock = true;
    console.log(`🔒 Instance lock adquirido (novo) owner=${INSTANCE.owner}`);
    return;
  }

  // se expirou ou é nosso, pega/renova
  if (Number(row.expires_at) <= t || row.owner === INSTANCE.owner) {
    stmtUpdateLock.run({
      key: INSTANCE.key,
      owner: INSTANCE.owner,
      expires_at: expiresAt,
      updated_at: t,
    });
    INSTANCE.hasLock = true;
    console.log(`🔒 Instance lock renovado owner=${INSTANCE.owner}`);
    return;
  }

  // existe outra instância viva
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

// --- Perfil do usuário (nick + email) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS user_profile (
    discord_id TEXT PRIMARY KEY,
    nick TEXT DEFAULT '',
    email TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  );
`);

// --- Compras ---
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
    amount REAL NOT NULL,
    status TEXT NOT NULL, -- PENDING / APPROVED / DELIVERED / DELIVERY_ERROR / CANCELLED...
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_purchases_payment_id ON purchases(payment_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_purchases_channel_status ON purchases(channel_id, status);`);

const stmtGetProfile = db.prepare(`SELECT nick, email FROM user_profile WHERE discord_id = ?`);
const stmtUpsertProfile = db.prepare(`
  INSERT INTO user_profile (discord_id, nick, email, updated_at)
  VALUES (@discord_id, @nick, @email, @updated_at)
  ON CONFLICT(discord_id) DO UPDATE SET
    nick=excluded.nick,
    email=excluded.email,
    updated_at=excluded.updated_at;
`);

const stmtInsertPurchase = db.prepare(`
  INSERT INTO purchases (order_id, payment_id, preference_id, buyer_id, channel_id, nick, email, pack_id, amount, status, created_at, updated_at)
  VALUES (@order_id, @payment_id, @preference_id, @buyer_id, @channel_id, @nick, @email, @pack_id, @amount, @status, @created_at, @updated_at)
`);

const stmtGetPurchaseByOrder = db.prepare(`SELECT * FROM purchases WHERE order_id = ?`);
const stmtGetPurchaseByPayment = db.prepare(`SELECT * FROM purchases WHERE payment_id = ?`);

const stmtUpdatePurchase = db.prepare(`
  UPDATE purchases
  SET payment_id=@payment_id, preference_id=@preference_id, status=@status, updated_at=@updated_at
  WHERE order_id=@order_id
`);

const stmtFindPendingInChannel = db.prepare(`
  SELECT * FROM purchases
  WHERE channel_id = ? AND status IN ('PENDING','APPROVED')
  ORDER BY created_at DESC
  LIMIT 1
`);

// ===================== STATE (RAM) =====================
const STATE = {
  openTickets: new Map(),       // buyerId -> channelId
  cooldown: new Map(),          // buyerId -> ts
  inactivityTimers: new Map(),  // channelId -> timeout
  generatingTicket: new Set(),  // "GEN:userId"
  delivering: new Set(),        // paymentId (runtime lock)
  handledInteractions: new Map(), // interactionId -> ts (dedupe)
  packLocks: new Map(),         // channelId -> { until, by }
};

// ===================== HELPERS: TOPIC =====================
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
function safeChannelNameFromUser(user) {
  const safe = user.username
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `ticket-${safe}-${user.id.slice(-4)}`;
}
function makeOrderId(userId) {
  return `DISCORD-${userId}-${Date.now()}`;
}

// ===================== INACTIVITY TIMER =====================
function cleanupChannelState(channelId) {
  for (const [uid, chId] of STATE.openTickets.entries()) {
    if (chId === channelId) STATE.openTickets.delete(uid);
  }
  const t = STATE.inactivityTimers.get(channelId);
  if (t) clearTimeout(t);
  STATE.inactivityTimers.delete(channelId);

  STATE.packLocks.delete(channelId);
}

function resetInactivityTimer(channel) {
  if (!isTicketChannel(channel)) return;

  const old = STATE.inactivityTimers.get(channel.id);
  if (old) clearTimeout(old);

  const t = setTimeout(async () => {
    try {
      const fresh = await channel.guild.channels.fetch(channel.id).catch(() => null);
      if (!fresh || !fresh.isTextBased() || !isTicketChannel(fresh)) return;

      await fresh.send("⏳ Ticket sem atividade por **10 minutos**. Vou fechar automaticamente.").catch(() => {});
      cleanupChannelState(fresh.id);
      await fresh.delete().catch(() => {});
    } catch (e) {
      console.log("⚠️ inactivity close error:", e?.message || e);
    }
  }, CONFIG.INACTIVITY_CLOSE_MS);

  STATE.inactivityTimers.set(channel.id, t);
}

// ===================== SAFE RESPONDER (evita thinking infinito) =====================
function createSafeResponder(interaction) {
  let deferred = false;

  async function ensureDefer() {
    if (interaction.deferred || interaction.replied || deferred) return;
    deferred = true;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch {
      // ignorar
    }
  }

  async function replyEphemeral(content, extra = {}) {
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

  return { ensureDefer, replyEphemeral };
}

// ===================== DEDUPE INTERACTION (idempotência) =====================
function isDuplicateInteraction(interactionId) {
  const t = now();
  // limpa antigos
  for (const [id, ts] of STATE.handledInteractions.entries()) {
    if (t - ts > CONFIG.INTERACTION_DEDUPE_MS) STATE.handledInteractions.delete(id);
  }
  if (STATE.handledInteractions.has(interactionId)) return true;
  STATE.handledInteractions.set(interactionId, t);
  return false;
}

// ===================== LOG =====================
async function sendPurchaseLog({ status, mode, buyerId, nick, email, packId, amount, orderId, paymentId, timestamp }) {
  try {
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID).catch(() => null);
    if (!guild) return;

    const ch = await guild.channels.fetch(CONFIG.LOG_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.isTextBased()) return;

    const pack = PACKS.find((p) => p.id === packId);

    const content =
      `🧾 **LOG COMPRA**\n` +
      `• Status: **${status}**\n` +
      `• Modo: **${mode}**\n` +
      `• buyerId: **${buyerId}** (<@${buyerId}>)\n` +
      `• Nick: **${nick || "—"}**\n` +
      `• Email: **${email || "—"}**\n` +
      `• Pack: **${pack?.label || packId || "—"}**\n` +
      `• Amount: **${amount != null ? brl(amount) : "—"}**\n` +
      `• orderId: **${orderId || "—"}**\n` +
      `• paymentId: **${paymentId || "—"}**\n` +
      `• timestamp: <t:${Math.floor((timestamp || now()) / 1000)}:F>`;

    await ch.send({ content }).catch(() => {});
  } catch (e) {
    console.log("❌ sendPurchaseLog falhou:", e?.message || e);
  }
}

// ===================== ENTREGA (SUA API) =====================
async function deliverToGame({ nick, packId, orderId }) {
  const url =
    `${CONFIG.API_URL}?token=${encodeURIComponent(CONFIG.API_TOKEN)}` +
    `&player=${encodeURIComponent(nick)}` +
    `&pack=${encodeURIComponent(packId)}` +
    `&orderId=${encodeURIComponent(orderId)}`;

  console.log("🎮 [GAME] chamando API:", url.replace(CONFIG.API_TOKEN, "***"));
  const res = await axios.get(url, { timeout: 12000 });
  console.log("🎮 [GAME] resposta:", res.data);
  return res.data;
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

async function createCheckoutPreference({ pack, buyerId, nick, email, orderId }) {
  const body = {
    items: [
      {
        title: `Coins - ${pack.label}`,
        description: `Nick: ${nick} | Pack: ${pack.id}`,
        quantity: 1,
        unit_price: Number(pack.price),
        currency_id: "BRL",
      },
    ],
    payer: { email },
    external_reference: orderId,
    metadata: { buyerId, nick, packId: pack.id, orderId },
  };

  if (CONFIG.MP_NOTIFICATION_URL) body.notification_url = CONFIG.MP_NOTIFICATION_URL;

  const res = await axios.post("https://api.mercadopago.com/checkout/preferences", body, {
    headers: mpHeaders({ "X-Idempotency-Key": idempotencyKey() }),
    timeout: 15000,
  });

  return res.data; // { id, init_point, ... }
}

async function getPayment(paymentId) {
  const res = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: mpHeaders(),
    timeout: 15000,
  });
  return res.data;
}

// Validação assinatura webhook (opcional)
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

// ===================== PROCESSA PAGAMENTO (WEBHOOK) =====================
async function processPaymentFromWebhook(paymentId) {
  if (STATE.delivering.has(paymentId)) {
    console.log("🟨 delivery runtime lock ativo p/ paymentId:", paymentId);
    return;
  }
  STATE.delivering.add(paymentId);

  try {
    const existingByPay = stmtGetPurchaseByPayment.get(paymentId);
    if (existingByPay && existingByPay.status === "DELIVERED") {
      console.log("🟨 Já entregue (DB) paymentId:", paymentId);
      return;
    }

    const payment = await getPayment(paymentId);
    const status = String(payment?.status || "unknown");
    const orderId = String(payment?.external_reference || "");

    console.log("[MP] payment", paymentId, "status", status, "orderId", orderId);

    if (!orderId) return;

    const purchase = stmtGetPurchaseByOrder.get(orderId);
    if (!purchase) {
      console.log("⚠️ Compra não encontrada no DB (orderId):", orderId);
      return;
    }

    // atualiza status/payment no DB
    stmtUpdatePurchase.run({
      order_id: orderId,
      payment_id: String(paymentId),
      preference_id: purchase.preference_id || "",
      status: status.toUpperCase(),
      updated_at: now(),
    });

    // se não aprovado, só registra e sai
    if (status !== "approved") {
      await sendPurchaseLog({
        mode: "PROD",
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

    // idempotência de entrega (DB)
    const refreshed = stmtGetPurchaseByOrder.get(orderId);
    if (refreshed && refreshed.status === "DELIVERED") return;

    const channel = await client.channels.fetch(purchase.channel_id).catch(() => null);
    if (channel?.isTextBased()) {
      await channel
        .send(
          `✅ Pagamento aprovado!\n` +
            `🧾 PaymentId: **${paymentId}**\n` +
            `🧾 Pedido: **${orderId}**\n` +
            `🚀 Enviando para o jogo...`
        )
        .catch(() => {});
    }

    const result = await deliverToGame({ nick: purchase.nick, packId: purchase.pack_id, orderId });
    const ok = result && (result.ok === true || result.success === true);

    if (ok) {
      stmtUpdatePurchase.run({
        order_id: orderId,
        payment_id: String(paymentId),
        preference_id: purchase.preference_id || "",
        status: "DELIVERED",
        updated_at: now(),
      });

      await sendPurchaseLog({
        mode: "PROD",
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
        await channel.send("✅ **Entrega concluída no jogo!**").catch(() => {});
        await channel
          .send(`🔒 Ticket será fechado automaticamente em ${Math.floor(CONFIG.AUTO_CLOSE_AFTER_DELIVERY_MS / 1000)}s...`)
          .catch(() => {});
        cleanupChannelState(channel.id);
        setTimeout(() => channel.delete().catch(() => {}), CONFIG.AUTO_CLOSE_AFTER_DELIVERY_MS);
      }
      return;
    }

    stmtUpdatePurchase.run({
      order_id: orderId,
      payment_id: String(paymentId),
      preference_id: purchase.preference_id || "",
      status: "DELIVERY_ERROR",
      updated_at: now(),
    });

    await sendPurchaseLog({
      mode: "PROD",
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
    STATE.delivering.delete(paymentId);
  }
}

// ===================== UI: PAINEL + PACKS =====================
function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle("🛒 Loja (Checkout Pro)")
    .setDescription(
      "Clique no botão abaixo para abrir um ticket.\n\n" +
        "📌 No ticket:\n" +
        "1) Envie seu **nick** (primeira mensagem salva automaticamente)\n" +
        "2) Envie seu **email** (necessário pro pagamento) ou use /setemail\n" +
        "3) Escolha o pack e pague pelo link"
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_ticket").setLabel("🧾 Abrir Ticket").setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

function buildPackRows(disabled = false) {
  const rows = [];
  let current = new ActionRowBuilder();

  for (const p of PACKS) {
    const btn = new ButtonBuilder()
      .setCustomId(`pack:${p.id}`)
      .setLabel(`${p.emoji} ${p.label} (${brl(p.price)})`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);

    if (current.components.length >= 5) {
      rows.push(current);
      current = new ActionRowBuilder();
    }
    current.addComponents(btn);
  }
  if (current.components.length) rows.push(current);

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("close_ticket").setLabel("🔒 Fechar Ticket").setStyle(ButtonStyle.Danger)
    )
  );

  return rows;
}

async function sendOrEditPanel() {
  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  const channel = await guild.channels.fetch(CONFIG.PANEL_CHANNEL_ID).catch(() => null);

  if (!channel || !channel.isTextBased()) {
    console.log("❌ PANEL_CHANNEL_ID não é um canal de texto válido.");
    return;
  }

  const payload = buildPanelMessage();

  if (CONFIG.PANEL_MESSAGE_ID) {
    try {
      const msg = await channel.messages.fetch(CONFIG.PANEL_MESSAGE_ID);
      await msg.edit(payload);
      console.log("✅ Painel editado (sem duplicar).");
      return;
    } catch {
      console.log("⚠️ PANEL_MESSAGE_ID inválido/apagado. Vou criar um novo painel...");
    }
  }

  const newMsg = await channel.send(payload);
  console.log("✅ Painel criado. Coloque no Render ENV pra não duplicar:");
  console.log("PANEL_MESSAGE_ID=" + newMsg.id);
}

// ===================== SLASH COMMANDS =====================
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("setnick")
      .setDescription("Define/atualiza seu nick para entrega.")
      .addStringOption((opt) => opt.setName("nick").setDescription("Seu nick no jogo").setRequired(true))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("setemail")
      .setDescription("Define/atualiza seu email para pagamento.")
      .addStringOption((opt) => opt.setName("email").setDescription("Seu email").setRequired(true))
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(CONFIG.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID), { body: commands });
  console.log("✅ Slash commands registrados: /setnick /setemail");
}

// ===================== CACHE OPEN TICKETS =====================
async function rebuildOpenTicketsCache(guild) {
  const channels = await guild.channels.fetch();
  STATE.openTickets.clear();

  for (const ch of channels.values()) {
    if (!ch || ch.type !== ChannelType.GuildText) continue;
    if (!ch.name?.startsWith("ticket-")) continue;
    const t = parseTopic(ch.topic || "");
    if (t.buyer) STATE.openTickets.set(t.buyer, ch.id);
  }

  console.log(`🧠 Cache openTickets reconstruído: ${STATE.openTickets.size} tickets.`);
}

// ===================== PERMISSIONS: CLOSE TICKET =====================
function canCloseTicket(interaction, buyerId) {
  // buyer
  if (buyerId && interaction.user.id === buyerId) return true;

  const member = interaction.member;
  if (!member) return false;

  // ManageChannels
  if (member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;

  // Support role
  if (CONFIG.SUPPORT_ROLE_ID) {
    try {
      if (member.roles?.cache?.has(CONFIG.SUPPORT_ROLE_ID)) return true;
    } catch {}
  }

  return false;
}

// ===================== TICKET CREATE / CLOSE =====================
async function createTicketChannel({ guild, user }) {
  const ts = now();
  const last = STATE.cooldown.get(user.id) || 0;

  if (ts - last < CONFIG.TICKET_COOLDOWN_MS) {
    const wait = Math.ceil((CONFIG.TICKET_COOLDOWN_MS - (ts - last)) / 1000);
    return { ok: false, reason: `Aguarde ${wait}s para abrir outro ticket.` };
  }

  const cached = STATE.openTickets.get(user.id);
  if (cached) {
    const existing = await guild.channels.fetch(cached).catch(() => null);
    if (existing && existing.type === ChannelType.GuildText) {
      return { ok: false, reason: `Você já tem um ticket aberto: <#${existing.id}>` };
    }
    STATE.openTickets.delete(user.id);
  }

  const genKey = `GEN:${user.id}`;
  if (STATE.generatingTicket.has(genKey)) {
    return { ok: false, reason: "Estou criando seu ticket… aguarde um instante e tente de novo." };
  }
  STATE.generatingTicket.add(genKey);

  try {
    const category = await guild.channels.fetch(CONFIG.TICKET_CATEGORY_ID).catch(() => null);
    if (!category) return { ok: false, reason: "Categoria inválida (TICKET_CATEGORY_ID)." };

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
    ];

    if (CONFIG.SUPPORT_ROLE_ID) {
      overwrites.push({
        id: CONFIG.SUPPORT_ROLE_ID,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      });
    }

    const profile = stmtGetProfile.get(user.id) || { nick: "", email: "" };

    // guardamos menuMsgId no topic depois do send
    const topicObj = {
      buyer: user.id,
      nick: (profile.nick || "").trim(),
      email: (profile.email || "").trim(),
      pack: "",
      orderId: "",
      paymentId: "",
      menuMsgId: "",
    };

    const channel = await guild.channels.create({
      name: safeChannelNameFromUser(user),
      type: ChannelType.GuildText,
      parent: category.id,
      topic: buildTopic(topicObj),
      permissionOverwrites: overwrites,
      reason: `Ticket aberto por ${user.tag} (${user.id})`,
    });

    STATE.openTickets.set(user.id, channel.id);
    STATE.cooldown.set(user.id, ts);

    resetInactivityTimer(channel);

    const menuMsg = await channel.send({
      content:
        `👋 Olá, <@${user.id}>!\n\n` +
        `✅ **Passo 1:** Envie seu **nick** (se ainda não estiver salvo)\n` +
        `✅ **Passo 2:** Envie seu **email** (para pagamento) ou use /setemail\n` +
        `✅ **Passo 3:** Clique no pack para gerar o **LINK de pagamento**\n\n` +
        `📌 Nick salvo: **${topicObj.nick || "—"}**\n` +
        `📌 Email salvo: **${topicObj.email || "—"}**`,
      components: buildPackRows(false),
    });

    topicObj.menuMsgId = menuMsg.id;
    await channel.setTopic(buildTopic(topicObj)).catch(() => {});

    return { ok: true, channelId: channel.id };
  } catch (e) {
    console.log("❌ createTicketChannel erro:", e?.message || e);
    return { ok: false, reason: "Não consegui criar o ticket (erro interno)." };
  } finally {
    STATE.generatingTicket.delete(genKey);
  }
}

async function closeTicketChannel(channel, reasonText = "Ticket fechado.") {
  if (!channel || !isTicketChannel(channel)) return;
  await channel.send(`🔒 ${reasonText}`).catch(() => {});
  cleanupChannelState(channel.id);
  setTimeout(() => channel.delete().catch(() => {}), CONFIG.DELETE_DELAY_MS);
}

// ===================== LOCK POR TICKET (ANTI-SPAM PACK) =====================
function acquirePackLock(channelId, byUserId) {
  const t = now();
  const cur = STATE.packLocks.get(channelId);

  if (cur && cur.until > t) return { ok: false, waitMs: cur.until - t, by: cur.by };

  STATE.packLocks.set(channelId, { until: t + CONFIG.PACK_LOCK_MS, by: byUserId });
  return { ok: true };
}
function releasePackLock(channelId) {
  STATE.packLocks.delete(channelId);
}

// ===================== BOTÕES =====================
async function handleButton(interaction) {
  // dedupe (se o Discord reenviar a mesma interaction)
  if (isDuplicateInteraction(interaction.id)) {
    console.log("🟨 DEDUPE interaction:", interaction.id, interaction.customId);
    // não responde de novo (evita "Unknown interaction" / duplicação)
    return;
  }

  const { ensureDefer, replyEphemeral } = createSafeResponder(interaction);

  try {
    await ensureDefer();

    const customId = interaction.customId;
    console.log("[BTN]", customId, "by", interaction.user.id, "in", interaction.channelId);

    const guild = interaction.guild;
    if (!guild) return replyEphemeral("❌ Use isso dentro do servidor.");

    // ---- OPEN TICKET ----
    if (customId === "open_ticket") {
      const result = await createTicketChannel({ guild, user: interaction.user });
      if (!result.ok) return replyEphemeral(`⚠️ ${result.reason}`);
      return replyEphemeral(`✅ Ticket criado! Vá para: <#${result.channelId}>`);
    }

    // daqui pra baixo: precisa ser ticket
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return replyEphemeral("❌ Canal inválido.");
    if (!isTicketChannel(channel)) return replyEphemeral("⚠️ Use isso dentro de um ticket válido.");

    resetInactivityTimer(channel);

    const topicObj = parseTopic(channel.topic || "");
    const buyerId = topicObj.buyer || "";
    const isBuyer = buyerId && interaction.user.id === buyerId;

    // ---- CLOSE TICKET ----
    if (customId === "close_ticket") {
      if (!canCloseTicket(interaction, buyerId)) {
        return replyEphemeral("⚠️ Você não tem permissão para fechar este ticket.");
      }
      await replyEphemeral("🔒 Fechando em instantes...");
      await closeTicketChannel(channel, "Ticket fechado.");
      return;
    }

    // ---- PACK ----
    if (customId.startsWith("pack:")) {
      if (!isBuyer) return replyEphemeral("⚠️ Só quem abriu o ticket pode escolher o pack.");

      // lock por canal (anti clique duplo)
      const lock = acquirePackLock(channel.id, interaction.user.id);
      if (!lock.ok) {
        const s = Math.ceil(lock.waitMs / 1000);
        return replyEphemeral(`⏳ Aguarde ${s}s... estou processando um pedido neste ticket.`);
      }

      try {
        // resposta imediata pro usuário (evita “pensando infinito”)
        await replyEphemeral("⏳ Gerando link de pagamento...");

        // não gerar outro link se já existe pendente nesse ticket
        const pending = stmtFindPendingInChannel.get(channel.id);
        if (pending) {
          return replyEphemeral(
            `⚠️ Já existe um pedido **pendente** neste ticket.\n` +
              `🧾 orderId: **${pending.order_id}**\n` +
              `Aguarde o pagamento, ou feche/cancele antes de gerar outro link.`
          );
        }

        // também respeita topic (caso tenha ficado gravado)
        const topicOrderId = String(topicObj.orderId || "").trim();
        if (topicOrderId) {
          const existing = stmtGetPurchaseByOrder.get(topicOrderId);
          if (existing && (existing.status === "PENDING" || existing.status === "APPROVED")) {
            return replyEphemeral(
              `⚠️ Já existe um pedido pendente no ticket.\n` +
                `🧾 orderId: **${existing.order_id}** (status: **${existing.status}**)`
            );
          }
        }

        const packId = customId.split(":")[1];
        const pack = PACKS.find((p) => p.id === packId);
        if (!pack) return replyEphemeral("❌ Pack inválido.");

        const nick = (topicObj.nick || "").trim();
        const email = (topicObj.email || "").trim();

        if (!nick) return replyEphemeral("❌ Envie seu nick (primeira mensagem) ou use /setnick.");
        if (!email) return replyEphemeral("❌ Envie seu email (mensagem) ou use /setemail.");

        const orderId = makeOrderId(interaction.user.id);

        let pref;
        try {
          pref = await createCheckoutPreference({
            pack,
            buyerId: interaction.user.id,
            nick,
            email,
            orderId,
          });
        } catch (e) {
          console.log("❌ MP createPreference erro:", e?.response?.data || e?.message || e);
          return replyEphemeral("❌ Não consegui gerar o link de pagamento agora (Mercado Pago).");
        }

        const payLink = String(pref?.init_point || "");
        const preferenceId = String(pref?.id || "");
        if (!payLink) return replyEphemeral("❌ Mercado Pago não retornou o link (init_point).");

        // salva compra no DB (PENDING)
        stmtInsertPurchase.run({
          order_id: orderId,
          payment_id: "",
          preference_id: preferenceId,
          buyer_id: interaction.user.id,
          channel_id: channel.id,
          nick,
          email,
          pack_id: pack.id,
          amount: pack.price,
          status: "PENDING",
          created_at: now(),
          updated_at: now(),
        });

        // atualiza topic
        topicObj.pack = pack.id;
        topicObj.orderId = orderId;
        topicObj.paymentId = "";
        await channel.setTopic(buildTopic(topicObj)).catch(() => {});

        // desabilita botões do menu original (se existir)
        const menuMsgId = String(topicObj.menuMsgId || "").trim();
        if (menuMsgId) {
          try {
            const menuMsg = await channel.messages.fetch(menuMsgId);
            await menuMsg.edit({ components: buildPackRows(true) });
          } catch {
            // fallback: manda uma mensagem com botões desativados
            await channel.send({ content: "🔒 Packs bloqueados (aguardando pagamento).", components: buildPackRows(true) }).catch(() => {});
          }
        } else {
          await channel.send({ content: "🔒 Packs bloqueados (aguardando pagamento).", components: buildPackRows(true) }).catch(() => {});
        }

        // mensagem com o link
        await channel
          .send(
            `✅ **Link de pagamento gerado!**\n` +
              `📦 Pack: **${pack.label} (${brl(pack.price)})**\n` +
              `👤 Nick: **${nick}**\n` +
              `🧾 Pedido: **${orderId}**\n\n` +
              `👉 **Clique para pagar:** ${payLink}\n\n` +
              `✅ Assim que o pagamento for aprovado, a entrega acontece automaticamente.`
          )
          .catch(() => {});

        await sendPurchaseLog({
          mode: "PROD",
          status: "PENDING",
          buyerId: interaction.user.id,
          nick,
          email,
          packId: pack.id,
          amount: pack.price,
          orderId,
          paymentId: "—",
          timestamp: now(),
        });

        return; // já respondeu via replyEphemeral antes
      } finally {
        // solta lock (mesmo com erro)
        releasePackLock(channel.id);
      }
    }

    return replyEphemeral("⚠️ Botão desconhecido/antigo. Abra um ticket novo no painel.");
  } catch (err) {
    console.error("❌ handleButton crash:", err);
    try {
      return replyEphemeral("❌ Erro interno ao processar o botão.");
    } catch {}
  }
}

// ===================== COMMANDS =====================
async function handleCommand(interaction) {
  // dedupe
  if (isDuplicateInteraction(interaction.id)) {
    console.log("🟨 DEDUPE cmd interaction:", interaction.id, interaction.commandName);
    return;
  }

  const { ensureDefer, replyEphemeral } = createSafeResponder(interaction);

  try {
    await ensureDefer();
console.log("[CMD]", interaction.commandName, "by", interaction.user.id, "in", interaction.channelId);

    if (interaction.commandName === "setemail") {
      const email = interaction.options.getString("email", true).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return replyEphemeral("❌ Email inválido.");
      }

      const current = stmtGetProfile.get(interaction.user.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: interaction.user.id,
        nick: current.nick || "",
        email,
        updated_at: now(),
      });

      if (interaction.channel && isTicketChannel(interaction.channel)) {
        const topicObj = parseTopic(interaction.channel.topic || "");
        if (topicObj.buyer === interaction.user.id) {
          topicObj.email = email;
          await interaction.channel.setTopic(buildTopic(topicObj)).catch(() => {});
        }
      }

      return replyEphemeral(`✅ Email atualizado para **${email}**.`);
    }

    if (interaction.commandName === "setnick") {
      const nick = interaction.options.getString("nick", true).trim();
      if (!nick || nick.length < 2) return replyEphemeral("❌ Nick inválido.");

      const current = stmtGetProfile.get(interaction.user.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: interaction.user.id,
        nick,
        email: current.email || "",
        updated_at: now(),
      });

      if (interaction.channel && isTicketChannel(interaction.channel)) {
        const topicObj = parseTopic(interaction.channel.topic || "");
        if (topicObj.buyer === interaction.user.id) {
          topicObj.nick = nick;
          await interaction.channel.setTopic(buildTopic(topicObj)).catch(() => {});
        }
      }

      return replyEphemeral(`✅ Nick atualizado para **${nick}**.`);
    }

    return replyEphemeral("⚠️ Comando desconhecido.");
  } catch (err) {console.error("❌ handleCommand crash FULL:", err);
try {
  return await replyEphemeral("❌ Deu erro no comando. Veja os Logs do Render agora.");
} catch {}

  }
}

// ===================== CAPTURA NICK/EMAIL POR MENSAGEM =====================
// ===================== CAPTURA NICK/EMAIL POR MENSAGEM =====================
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;
    if (msg.author?.bot) return;

    const channel = msg.channel;
    if (!isTicketChannel(channel)) return;

    resetInactivityTimer(channel);

    const topicObj = parseTopic(channel.topic || "");
    const buyerId = String(topicObj.buyer || "").trim();
    if (!buyerId) return;
    if (msg.author.id !== buyerId) return;

    const text = String(msg.content || "").trim();
    if (!text) return;

    // 1) Nick (se não tiver)
    const nickTopic = String(topicObj.nick || "").trim();
    if (!nickTopic || nickTopic === "undefined" || nickTopic === "null") {
      const nick = text;
      const current = stmtGetProfile.get(msg.author.id) || { nick: "", email: "" };

      stmtUpsertProfile.run({
        discord_id: msg.author.id,
        nick,
        email: current.email || "",
        updated_at: now(),
      });

      topicObj.nick = nick;
      await channel.setTopic(buildTopic(topicObj)).catch(() => {});
      await channel
        .send(`✅ Nick salvo: **${nick}**\nAgora envie seu **email** (ou use /setemail).`)
        .catch(() => {});
      return;
    }

    // 2) Email (se não tiver e parecer email)
    const emailTopic = String(topicObj.email || "").trim().toLowerCase();
    const looksEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

    const emailIsEmpty =
      !emailTopic || emailTopic === "undefined" || emailTopic === "null" || emailTopic === "-" || emailTopic === "0";

    if (emailIsEmpty && looksEmail) {
      const email = text.toLowerCase();
      const current = stmtGetProfile.get(msg.author.id) || { nick: "", email: "" };

      stmtUpsertProfile.run({
        discord_id: msg.author.id,
        nick: current.nick || String(topicObj.nick || "").trim(),
        email,
        updated_at: now(),
      });

      topicObj.email = email;
      await channel.setTopic(buildTopic(topicObj)).catch(() => {});
      await channel
        .send(`✅ Email salvo: **${email}**\nAgora clique no pack para gerar o link.`)
        .catch(() => {});
      return;
    }
  } catch (e) {
    console.log("⚠️ messageCreate error:", e?.message || e);
  }
});

// ===================== INTERACTIONS =====================
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (e) {
    console.error("❌ interactionCreate crash:", e);
    try {
      const { ensureDefer, replyEphemeral } = createSafeResponder(interaction);
      await ensureDefer();
      await replyEphemeral("❌ Erro interno inesperado.");
    } catch {}
  }
});

// ===================== READY =====================
client.once("ready", async () => {
  console.log(`✅ Bot online como: ${client.user.tag}`);

  try {
    await registerSlashCommands();
  } catch (e) {
    console.log("⚠️ Falha ao registrar slash commands:", e?.message || e);
  }

  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  await rebuildOpenTicketsCache(guild);
  await sendOrEditPanel();
});

// ===================== CLEANUP =====================
client.on("channelDelete", (ch) => {
  if (!ch || ch.type !== ChannelType.GuildText) return;
  if (!ch.name?.startsWith("ticket-")) return;
  cleanupChannelState(ch.id);
  console.log("🧹 Limpeza após delete:", ch.id);
});

// ===================== WEBHOOK SERVER =====================
function startWebhookServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_, res) => res.json({ ok: true }));

  app.post("/mp/webhook", async (req, res) => {
    // responde rápido (não travar MP)
    res.sendStatus(200);

    try {
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

// ===================== START =====================
tryAcquireInstanceLockOrExit();
startInstanceHeartbeat();
startWebhookServer();
client.login(CONFIG.DISCORD_TOKEN);
