/**
 * index.js — Discord.js v14/v15 + Tickets + SQLite + Mercado Pago (PROD) Checkout Pro + Webhook + Entrega
 * ✅ Sem modo teste
 * ✅ Render-ready (usa process.env.PORT)
 * ✅ Painel NÃO duplica (usa PANEL_MESSAGE_ID)
 * ✅ Anti-duplicação:
 *    - Instance lock (SQLite) + heartbeat
 *    - Dedupe de interaction (id + janela)
 *    - Lock por ticket (channelId) p/ pack
 *    - Não gera novo link se já existir compra PENDING/APPROVED no ticket
 * ✅ Fechar ticket: buyer OU SUPPORT_ROLE_ID OU ManageChannels
 * ✅ Nunca fica "pensando infinito": deferReply rápido + safeReply
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

// ===================== ENV =====================
function requireEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Faltou ${name} nas variáveis de ambiente (Render / .env).`);
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
const CONFIG = Object.freeze({
  // Discord
  DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
  CLIENT_ID: requireEnv("CLIENT_ID"),
  GUILD_ID: requireEnv("GUILD_ID"),
  PANEL_CHANNEL_ID: requireEnv("PANEL_CHANNEL_ID"),
  PANEL_MESSAGE_ID: optionalEnv("PANEL_MESSAGE_ID", ""), // se existir, edita e não duplica
  TICKET_CATEGORY_ID: requireEnv("TICKET_CATEGORY_ID"),
  LOG_CHANNEL_ID: requireEnv("LOG_CHANNEL_ID"),
  SUPPORT_ROLE_ID: optionalEnv("SUPPORT_ROLE_ID", ""),

  // Mercado Pago (PROD)
  MP_ACCESS_TOKEN: requireEnv("MP_ACCESS_TOKEN"),
  MP_NOTIFICATION_URL: optionalEnv("MP_NOTIFICATION_URL", ""), // sua URL do Render /mp/webhook
  // Se você NÃO tem secret, deixe vazio. (signature check OFF automaticamente)
  MP_WEBHOOK_SECRET: optionalEnv("MP_WEBHOOK_SECRET", ""),

  // Entrega (sua API)
  API_URL: requireEnv("API_URL"),
  API_TOKEN: requireEnv("API_TOKEN"),

  // Regras
  TICKET_COOLDOWN_MS: Number(optionalEnv("TICKET_COOLDOWN_MS", "60000")), // 60s
  INACTIVITY_CLOSE_MS: Number(optionalEnv("INACTIVITY_CLOSE_MS", String(10 * 60 * 1000))), // 10 min
  DELETE_DELAY_MS: Number(optionalEnv("DELETE_DELAY_MS", "2500")),
  AUTO_CLOSE_AFTER_DELIVERY_MS: Number(optionalEnv("AUTO_CLOSE_AFTER_DELIVERY_MS", "10000")),

  // Anti-duplicação / locks
  INSTANCE_LOCK_TTL_MS: Number(optionalEnv("INSTANCE_LOCK_TTL_MS", "45000")),
  INSTANCE_HEARTBEAT_MS: Number(optionalEnv("INSTANCE_HEARTBEAT_MS", "15000")),
  INTERACTION_DEDUPE_MS: Number(optionalEnv("INTERACTION_DEDUPE_MS", "12000")),
  PACK_LOCK_MS: Number(optionalEnv("PACK_LOCK_MS", "15000")),

  // Server
  WEBHOOK_PORT_FALLBACK: Number(optionalEnv("WEBHOOK_PORT", "10000")),
});

if (!isSnowflake(CONFIG.LOG_CHANNEL_ID)) console.warn("⚠️ LOG_CHANNEL_ID parece inválido.");
if (CONFIG.SUPPORT_ROLE_ID && !isSnowflake(CONFIG.SUPPORT_ROLE_ID)) console.warn("⚠️ SUPPORT_ROLE_ID parece inválido.");

// ===================== COINS / PACKS =====================
const COIN_BASE_BRL = 1.0; // 1 coin = R$1,00

const PACKS = Object.freeze([
  { id: "c5", coins: 5, discount: 0.0, emoji: "🟢" },
  { id: "c10", coins: 10, discount: 0.005, emoji: "🟡" },  // 0,5%
  { id: "c25", coins: 25, discount: 0.01, emoji: "🟠" },   // 1%
  { id: "c50", coins: 50, discount: 0.015, emoji: "🔴" },  // 1,5%
  { id: "c100", coins: 100, discount: 0.025, emoji: "🔷" },// 2,5%
  { id: "c500", coins: 500, discount: 0.05, emoji: "👑" }, // 5%
]);

function roundUpTo050(value) {
  // arredonda pra cima em passos de 0,50
  return Math.ceil(value * 2) / 2;
}
function calculatePrice(pack) {
  const base = pack.coins * COIN_BASE_BRL;
  const discounted = base * (1 - pack.discount);
  return roundUpTo050(discounted);
}
function brl(v) {
  return `R$ ${Number(v).toFixed(2).replace(".", ",")}`;
}

// ===================== DISCORD CLIENT =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// ===================== SQLITE =====================
const db = new Database("./loja.sqlite");

// ---- Lock de instância (anti múltiplas instâncias) ----
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_lock (
    key TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
const stmtGetLock = db.prepare(`SELECT * FROM bot_lock WHERE key = ?`);
const stmtInsertLock = db.prepare(`INSERT INTO bot_lock (key, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)`);
const stmtUpdateLock = db.prepare(`UPDATE bot_lock SET owner=?, expires_at=?, updated_at=? WHERE key=?`);

function instanceOwnerId() {
  return `pid:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
}
const INSTANCE = {
  key: `guild:${CONFIG.GUILD_ID}`,
  owner: instanceOwnerId(),
  hasLock: false,
  heartbeat: null,
};
function acquireInstanceLockOrExit() {
  const t = now();
  const row = stmtGetLock.get(INSTANCE.key);
  const expiresAt = t + CONFIG.INSTANCE_LOCK_TTL_MS;

  if (!row) {
    stmtInsertLock.run(INSTANCE.key, INSTANCE.owner, expiresAt, t);
    INSTANCE.hasLock = true;
    console.log(`🔒 Instance lock adquirido (novo) owner=${INSTANCE.owner}`);
    return;
  }

  // se expirou, pode assumir
  if (Number(row.expires_at) <= t) {
    stmtUpdateLock.run(INSTANCE.owner, expiresAt, t, INSTANCE.key);
    INSTANCE.hasLock = true;
    console.log(`🔒 Instance lock assumido (expirado) owner=${INSTANCE.owner}`);
    return;
  }

  // se já é nosso, renova
  if (row.owner === INSTANCE.owner) {
    stmtUpdateLock.run(INSTANCE.owner, expiresAt, t, INSTANCE.key);
    INSTANCE.hasLock = true;
    console.log(`🔒 Instance lock renovado owner=${INSTANCE.owner}`);
    return;
  }

  console.error(`🛑 Outra instância ativa detectada (owner=${row.owner}). Encerrando esta (owner=${INSTANCE.owner}).`);
  process.exit(1);
}
function startInstanceHeartbeat() {
  if (!INSTANCE.hasLock) return;
  if (INSTANCE.heartbeat) clearInterval(INSTANCE.heartbeat);

  INSTANCE.heartbeat = setInterval(() => {
    try {
      const t = now();
      const row = stmtGetLock.get(INSTANCE.key);
      if (!row || row.owner !== INSTANCE.owner) {
        console.error("🛑 Perdi o lock de instância. Encerrando para evitar duplicação.");
        process.exit(1);
      }
      stmtUpdateLock.run(INSTANCE.owner, t + CONFIG.INSTANCE_LOCK_TTL_MS, t, INSTANCE.key);
    } catch (e) {
      console.error("⚠️ heartbeat lock erro:", e?.message || e);
    }
  }, CONFIG.INSTANCE_HEARTBEAT_MS);

  console.log("✅ Heartbeat do lock ativo");
}

// ---- Perfil (nick/email) ----
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

// ---- Compras ----
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
    status TEXT NOT NULL, -- PENDING / APPROVED / DELIVERED / DELIVERY_ERROR / CANCELLED...
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_purchases_payment_id ON purchases(payment_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_purchases_channel_status ON purchases(channel_id, status);`);

const stmtInsertPurchase = db.prepare(`
  INSERT INTO purchases (order_id, payment_id, preference_id, buyer_id, channel_id, nick, email, pack_id, coins, amount, status, created_at, updated_at)
  VALUES (@order_id, @payment_id, @preference_id, @buyer_id, @channel_id, @nick, @email, @pack_id, @coins, @amount, @status, @created_at, @updated_at)
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
  openTickets: new Map(), // buyerId -> channelId
  cooldown: new Map(), // buyerId -> ts
  inactivityTimers: new Map(), // channelId -> timeout
  generatingTicket: new Set(), // "GEN:userId"
  delivering: new Set(), // paymentId lock
  handledInteractions: new Map(), // interactionId -> ts
  packLocks: new Map(), // channelId -> { until, by }
};

// ===================== HELPERS =====================
function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

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
  return `ORD-${userId}-${Date.now()}`;
}

// ===================== DEDUPE INTERACTION =====================
function isDuplicateInteraction(interactionId) {
  const t = now();
  for (const [id, ts] of STATE.handledInteractions.entries()) {
    if (t - ts > CONFIG.INTERACTION_DEDUPE_MS) STATE.handledInteractions.delete(id);
  }
  if (STATE.handledInteractions.has(interactionId)) return true;
  STATE.handledInteractions.set(interactionId, t);
  return false;
}

// ===================== SAFE REPLY (mata "pensando infinito") =====================
async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred) return await interaction.editReply(payload);
  } catch {}
  try {
    if (!interaction.replied) return await interaction.reply(payload);
  } catch {}
  try {
    return await interaction.followUp(payload);
  } catch {}
  return null;
}
async function safeDefer(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  } catch {}
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

  const timer = setTimeout(async () => {
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

  STATE.inactivityTimers.set(channel.id, timer);
}

// ===================== LOG =====================
async function sendPurchaseLog({
  status,
  mode,
  buyerId,
  nick,
  email,
  packId,
  coins,
  amount,
  orderId,
  paymentId,
  timestamp,
}) {
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
      `• Pack: **${pack?.coins ?? coins ?? "—"} coins** (${packId || "—"})\n` +
      `• Valor: **${amount != null ? brl(amount) : "—"}**\n` +
      `• orderId: **${orderId || "—"}**\n` +
      `• paymentId: **${paymentId || "—"}**\n` +
      `• timestamp: <t:${Math.floor((timestamp || now()) / 1000)}:F>`;

    await ch.send({ content }).catch(() => {});
  } catch (e) {
    console.log("❌ sendPurchaseLog falhou:", e?.message || e);
  }
}

// ===================== ENTREGA (SUA API) =====================
async function deliverToGame({ nick, coins, orderId }) {
  const url =
    `${CONFIG.API_URL}?token=${encodeURIComponent(CONFIG.API_TOKEN)}` +
    `&player=${encodeURIComponent(nick)}` +
    `&coins=${encodeURIComponent(String(coins))}` +
    `&orderId=${encodeURIComponent(orderId)}`;

  console.log("🎮 [GAME] chamando API:", url.replace(CONFIG.API_TOKEN, "***"));
  const res = await axios.get(url, { timeout: 15000 });
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

async function createCheckoutPreference({ pack, buyerId, nick, email, orderId, amount }) {
  const body = {
    items: [
      {
        title: `${pack.coins} Coins`,
        description: `Nick: ${nick} | Pack: ${pack.id}`,
        quantity: 1,
        unit_price: Number(amount),
        currency_id: "BRL",
      },
    ],
    payer: { email },
    external_reference: orderId,
    metadata: { buyerId, nick, coins: pack.coins, packId: pack.id, orderId },
  };

  if (CONFIG.MP_NOTIFICATION_URL) body.notification_url = CONFIG.MP_NOTIFICATION_URL;

  const res = await axios.post("https://api.mercadopago.com/checkout/preferences", body, {
    headers: mpHeaders({ "X-Idempotency-Key": idempotencyKey() }),
    timeout: 20000,
  });

  return res.data; // { id, init_point }
}

async function getPayment(paymentId) {
  const res = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: mpHeaders(),
    timeout: 20000,
  });
  return res.data;
}

// Se não tiver secret, signature check OFF
const MP_SIGNATURE_ON = Boolean((CONFIG.MP_WEBHOOK_SECRET || "").trim());
console.log(`🔎 MP signature check: ${MP_SIGNATURE_ON ? "ON" : "OFF"}`);

function verifyMpSignature({ xSignature, xRequestId, dataId }) {
  if (!MP_SIGNATURE_ON) return true;
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
  if (!paymentId) return;

  if (STATE.delivering.has(paymentId)) {
    console.log("🟨 delivery lock ativo p/ paymentId:", paymentId);
    return;
  }
  STATE.delivering.add(paymentId);

  try {
    const existingByPay = stmtGetPurchaseByPayment.get(String(paymentId));
    if (existingByPay && existingByPay.status === "DELIVERED") {
      console.log("🟨 Já entregue (DB) paymentId:", paymentId);
      return;
    }

    const payment = await getPayment(paymentId);
    const status = String(payment?.status || "unknown").toLowerCase();
    const orderId = String(payment?.external_reference || "");

    console.log("[MP] payment", paymentId, "status", status, "orderId", orderId);

    if (!orderId) return;

    const purchase = stmtGetPurchaseByOrder.get(orderId);
    if (!purchase) {
      console.log("⚠️ Compra não encontrada no DB (orderId):", orderId);
      return;
    }

    // Atualiza status/payment
    const statusUp = status.toUpperCase();
    stmtUpdatePurchase.run({
      order_id: orderId,
      payment_id: String(paymentId),
      preference_id: purchase.preference_id || "",
      status: statusUp,
      updated_at: now(),
    });

    // Log status que não seja approved também
    if (status !== "approved") {
      await sendPurchaseLog({
        mode: "PROD",
        status: statusUp,
        buyerId: purchase.buyer_id,
        nick: purchase.nick,
        email: purchase.email,
        packId: purchase.pack_id,
        coins: purchase.coins,
        amount: purchase.amount,
        orderId,
        paymentId: String(paymentId),
        timestamp: now(),
      });
      return;
    }

    // Idempotência (DB) antes de entregar
    const refreshed = stmtGetPurchaseByOrder.get(orderId);
    if (refreshed && refreshed.status === "DELIVERED") return;

    const channel = await client.channels.fetch(purchase.channel_id).catch(() => null);
    if (channel?.isTextBased()) {
      await channel
        .send(
          `✅ **Pagamento aprovado!**\n` +
            `🧾 Pedido: **${orderId}**\n` +
            `🧾 PaymentId: **${paymentId}**\n` +
            `⚡ Entregando **${purchase.coins} coins** para **${purchase.nick}**...`
        )
        .catch(() => {});
    }

    const result = await deliverToGame({ nick: purchase.nick, coins: purchase.coins, orderId });
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
        coins: purchase.coins,
        amount: purchase.amount,
        orderId,
        paymentId: String(paymentId),
        timestamp: now(),
      });

      if (channel?.isTextBased()) {
        await channel.send("🎉 **Coins entregues com sucesso!**").catch(() => {});
        await channel
          .send(`🔒 Ticket será fechado automaticamente em ${Math.floor(CONFIG.AUTO_CLOSE_AFTER_DELIVERY_MS / 1000)}s...`)
          .catch(() => {});
        cleanupChannelState(channel.id);
        setTimeout(() => channel.delete().catch(() => {}), CONFIG.AUTO_CLOSE_AFTER_DELIVERY_MS);
      }
      return;
    }

    // erro entrega
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
      coins: purchase.coins,
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

// ===================== UI (PAINEL + PACKS) =====================
function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle("🪙 Loja Oficial de Coins")
    .setDescription(
      [
        "Adquira suas **Coins** com segurança e entrega automática.",
        "",
        "✅ **1 Coin = R$ 1,00**",
        "💳 **Pagamento:** Mercado Pago (Checkout Pro)",
        "⚡ **Entrega:** automática após aprovação",
        "",
        "Clique no botão abaixo para abrir um ticket.",
      ].join("\n")
    )
    .setFooter({ text: "Sistema automático • Seguro • Profissional" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_ticket").setLabel("Abrir Ticket").setStyle(ButtonStyle.Primary).setEmoji("🎟️")
  );

  return { embeds: [embed], components: [row] };
}

function buildPackRows({ disabled = false } = {}) {
  const rows = [];
  let row = new ActionRowBuilder();

  for (const p of PACKS) {
    const price = calculatePrice(p);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`pack:${p.id}`)
        .setLabel(`${p.coins} coins (${brl(price)})`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(p.emoji)
        .setDisabled(Boolean(disabled))
    );

    if (row.components.length >= 5) {
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
    console.log("❌ PANEL_CHANNEL_ID inválido (não é canal texto).");
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
      console.log("⚠️ PANEL_MESSAGE_ID inválido/apagado. Criando painel novo...");
    }
  }

  const newMsg = await channel.send(payload);
  console.log("✅ Painel criado. Salve isso no Render ENV para não duplicar:");
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

// ===================== PERMISSÕES FECHAR TICKET =====================
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
    return { ok: false, reason: "Estou criando seu ticket… aguarde e tente novamente." };
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

    const topicObj = {
      buyer: user.id,
      nick: (profile.nick || "").trim(),
      email: (profile.email || "").trim(),
      orderId: "",
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

    const embed = new EmbedBuilder()
      .setColor(0x00ff99)
      .setTitle("🪙 Compra de Coins")
      .setDescription(
        [
          "Siga os passos abaixo:",
          "",
          `1) Envie seu **nick** (ou use **/setnick**)`,
          `2) Envie seu **email** (ou use **/setemail**)`,
          `3) Clique no pack para gerar o **LINK do pagamento**`,
          "",
          `📌 Nick salvo: **${topicObj.nick || "—"}**`,
          `📌 Email salvo: **${topicObj.email || "—"}**`,
          "",
          "🔐 Sistema protegido contra duplicação e cliques repetidos.",
        ].join("\n")
      );

    const menuMsg = await channel.send({ embeds: [embed], components: buildPackRows({ disabled: false }) });

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

// ===================== LOCK PACK (ANTI-SPAM) =====================
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

// ===================== BUTTON HANDLER =====================
async function handleButton(interaction) {
  if (isDuplicateInteraction(interaction.id)) {
    console.log("🟨 DEDUPE interaction:", interaction.id, interaction.customId);
    return;
  }

  await safeDefer(interaction);

  const customId = interaction.customId;
  console.log("[BTN]", customId, "by", interaction.user.id, "in", interaction.channelId);

  const guild = interaction.guild;
  if (!guild) return safeReply(interaction, { content: "❌ Use isso dentro do servidor.", flags: MessageFlags.Ephemeral });

  // OPEN TICKET
  if (customId === "open_ticket") {
    const result = await createTicketChannel({ guild, user: interaction.user });
    if (!result.ok) return safeReply(interaction, { content: `⚠️ ${result.reason}`, flags: MessageFlags.Ephemeral });
    return safeReply(interaction, { content: `✅ Ticket criado! Vá para: <#${result.channelId}>`, flags: MessageFlags.Ephemeral });
  }

  // A partir daqui precisa ser ticket
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) return safeReply(interaction, { content: "❌ Canal inválido.", flags: MessageFlags.Ephemeral });
  if (!isTicketChannel(channel)) return safeReply(interaction, { content: "⚠️ Use isso dentro de um ticket válido.", flags: MessageFlags.Ephemeral });

  resetInactivityTimer(channel);

  const topicObj = parseTopic(channel.topic || "");
  const buyerId = String(topicObj.buyer || "").trim();
  const isBuyer = buyerId && interaction.user.id === buyerId;

  // CLOSE
  if (customId === "close_ticket") {
    if (!canCloseTicket(interaction, buyerId)) {
      return safeReply(interaction, { content: "⚠️ Você não tem permissão para fechar este ticket.", flags: MessageFlags.Ephemeral });
    }
    await safeReply(interaction, { content: "🔒 Fechando o ticket...", flags: MessageFlags.Ephemeral });
    await closeTicketChannel(channel, "Ticket fechado.");
    return;
  }

  // PACK
  if (customId.startsWith("pack:")) {
    if (!isBuyer) {
      return safeReply(interaction, { content: "⚠️ Só quem abriu o ticket pode escolher o pack.", flags: MessageFlags.Ephemeral });
    }

    const lock = acquirePackLock(channel.id, interaction.user.id);
    if (!lock.ok) {
      const s = Math.ceil(lock.waitMs / 1000);
      return safeReply(interaction, { content: `⏳ Aguarde ${s}s... estou processando um pedido neste ticket.`, flags: MessageFlags.Ephemeral });
    }

    try {
      await safeReply(interaction, { content: "⏳ Gerando link de pagamento...", flags: MessageFlags.Ephemeral });

      // Se já existe compra pendente no ticket, não gera outro link
      const pending = stmtFindPendingInChannel.get(channel.id);
      if (pending) {
        return safeReply(interaction, {
          content:
            `⚠️ Já existe um pedido **pendente** neste ticket.\n` +
            `🧾 orderId: **${pending.order_id}** (status: **${pending.status}**)\n` +
            `Aguarde o pagamento ou finalize/cancele antes de gerar outro link.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const packId = customId.split(":")[1];
      const pack = PACKS.find((p) => p.id === packId);
      if (!pack) return safeReply(interaction, { content: "❌ Pack inválido.", flags: MessageFlags.Ephemeral });

      const nick = String(topicObj.nick || "").trim();
      const email = String(topicObj.email || "").trim().toLowerCase();
      if (!nick) return safeReply(interaction, { content: "❌ Envie seu nick (mensagem) ou use /setnick.", flags: MessageFlags.Ephemeral });
      if (!email) return safeReply(interaction, { content: "❌ Envie seu email (mensagem) ou use /setemail.", flags: MessageFlags.Ephemeral });

      const amount = calculatePrice(pack);
      const orderId = makeOrderId(interaction.user.id);

      let pref;
      try {
        pref = await createCheckoutPreference({ pack, buyerId: interaction.user.id, nick, email, orderId, amount });
      } catch (e) {
        console.log("❌ MP createPreference erro:", e?.response?.data || e?.message || e);
        return safeReply(interaction, { content: "❌ Não consegui gerar o link do Mercado Pago agora.", flags: MessageFlags.Ephemeral });
      }

      const payLink = String(pref?.init_point || "");
      const preferenceId = String(pref?.id || "");
      if (!payLink) return safeReply(interaction, { content: "❌ Mercado Pago não retornou init_point.", flags: MessageFlags.Ephemeral });

      // salva compra
      stmtInsertPurchase.run({
        order_id: orderId,
        payment_id: "",
        preference_id: preferenceId,
        buyer_id: interaction.user.id,
        channel_id: channel.id,
        nick,
        email,
        pack_id: pack.id,
        coins: pack.coins,
        amount,
        status: "PENDING",
        created_at: now(),
        updated_at: now(),
      });

      // grava no topic
      topicObj.orderId = orderId;
      await channel.setTopic(buildTopic(topicObj)).catch(() => {});

      // desabilita botões do menu original (se existir)
      const menuMsgId = String(topicObj.menuMsgId || "").trim();
      if (menuMsgId) {
        try {
          const menuMsg = await channel.messages.fetch(menuMsgId);
          await menuMsg.edit({ components: buildPackRows({ disabled: true }) });
        } catch {
          await channel.send({ content: "🔒 Packs bloqueados (aguardando pagamento).", components: buildPackRows({ disabled: true }) }).catch(() => {});
        }
      }

      // manda link no ticket
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("💳 Link de Pagamento Gerado")
        .setDescription(
          [
            `📦 Pack: **${pack.coins} coins**`,
            `💰 Valor: **${brl(amount)}**`,
            `👤 Nick: **${nick}**`,
            `🧾 Pedido: **${orderId}**`,
            "",
            `👉 **Pagar agora:** ${payLink}`,
            "",
            "✅ Assim que o pagamento for aprovado, a entrega é automática.",
          ].join("\n")
        );

      await channel.send({ embeds: [embed] }).catch(() => {});

      await sendPurchaseLog({
        mode: "PROD",
        status: "PENDING",
        buyerId: interaction.user.id,
        nick,
        email,
        packId: pack.id,
        coins: pack.coins,
        amount,
        orderId,
        paymentId: "—",
        timestamp: now(),
      });

      return;
    } finally {
      // solta lock sempre
      releasePackLock(channel.id);
    }
  }

  return safeReply(interaction, { content: "⚠️ Botão desconhecido/antigo. Use o painel atualizado.", flags: MessageFlags.Ephemeral });
}

// ===================== COMMAND HANDLER (SEM THINKING INFINITO) =====================
async function handleCommand(interaction) {
  if (isDuplicateInteraction(interaction.id)) {
    console.log("🟨 DEDUPE cmd interaction:", interaction.id, interaction.commandName);
    return;
  }

  await safeDefer(interaction);
  console.log("[CMD]", interaction.commandName, "by", interaction.user.id, "in", interaction.channelId);

  try {
    if (interaction.commandName === "setemail") {
      const email = interaction.options.getString("email", true).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return safeReply(interaction, { content: "❌ Email inválido.", flags: MessageFlags.Ephemeral });
      }

      const cur = stmtGetProfile.get(interaction.user.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: interaction.user.id,
        nick: cur.nick || "",
        email,
        updated_at: now(),
      });

      if (interaction.channel && isTicketChannel(interaction.channel)) {
        const topicObj = parseTopic(interaction.channel.topic || "");
        if (String(topicObj.buyer || "") === interaction.user.id) {
          topicObj.email = email;
          await interaction.channel.setTopic(buildTopic(topicObj)).catch(() => {});
        }
      }

      return safeReply(interaction, { content: `✅ Email atualizado para **${email}**.`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "setnick") {
      const nick = interaction.options.getString("nick", true).trim();
      if (!nick || nick.length < 2) return safeReply(interaction, { content: "❌ Nick inválido.", flags: MessageFlags.Ephemeral });

      const cur = stmtGetProfile.get(interaction.user.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: interaction.user.id,
        nick,
        email: cur.email || "",
        updated_at: now(),
      });

      if (interaction.channel && isTicketChannel(interaction.channel)) {
        const topicObj = parseTopic(interaction.channel.topic || "");
        if (String(topicObj.buyer || "") === interaction.user.id) {
          topicObj.nick = nick;
          await interaction.channel.setTopic(buildTopic(topicObj)).catch(() => {});
        }
      }

      return safeReply(interaction, { content: `✅ Nick atualizado para **${nick}**.`, flags: MessageFlags.Ephemeral });
    }

    return safeReply(interaction, { content: "⚠️ Comando desconhecido.", flags: MessageFlags.Ephemeral });
  } catch (e) {
    console.error("❌ handleCommand erro:", e?.response?.data || e?.message || e);
    return safeReply(interaction, { content: "❌ Erro interno no comando. Veja os logs do Render.", flags: MessageFlags.Ephemeral });
  }
}

// ===================== CAPTURA NICK/EMAIL POR MENSAGEM (ticket) =====================
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

    // salva nick se vazio
    const nickTopic = String(topicObj.nick || "").trim();
    if (!nickTopic) {
      const nick = text;
      const cur = stmtGetProfile.get(msg.author.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: msg.author.id,
        nick,
        email: cur.email || "",
        updated_at: now(),
      });

      topicObj.nick = nick;
      await channel.setTopic(buildTopic(topicObj)).catch(() => {});
      await channel.send(`✅ Nick salvo: **${nick}**\nAgora envie seu **email** (ou use /setemail).`).catch(() => {});
      return;
    }

    // salva email se vazio e parecer email
    const emailTopic = String(topicObj.email || "").trim();
    const looksEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

    if (!emailTopic && looksEmail) {
      const email = text.toLowerCase();
      const cur = stmtGetProfile.get(msg.author.id) || { nick: "", email: "" };

      stmtUpsertProfile.run({
        discord_id: msg.author.id,
        nick: cur.nick || String(topicObj.nick || "").trim(),
        email,
        updated_at: now(),
      });

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
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (e) {
    console.error("❌ interactionCreate crash:", e);
    try {
      await safeDefer(interaction);
      await safeReply(interaction, { content: "❌ Erro interno inesperado.", flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

// ===================== READY (v14 + fallback v15) =====================
async function onReady() {
  console.log(`✅ Bot online como: ${client.user?.tag || "??"}`);

  try {
    await registerSlashCommands();
  } catch (e) {
    console.log("⚠️ Falha ao registrar slash commands:", e?.message || e);
  }

  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  await rebuildOpenTicketsCache(guild);
  await sendOrEditPanel();
}
client.once("ready", onReady);
client.once("clientReady", onReady); // caso esteja em v15

// ===================== CLEANUP =====================
client.on("channelDelete", (ch) => {
  try {
    if (!ch || ch.type !== ChannelType.GuildText) return;
    if (!ch.name?.startsWith("ticket-")) return;
    cleanupChannelState(ch.id);
    console.log("🧹 Limpeza após delete:", ch.id);
  } catch {}
});

// ===================== WEBHOOK SERVER =====================
function startWebhookServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_, res) => res.json({ ok: true }));

  app.post("/mp/webhook", async (req, res) => {
    // responde rápido pro MP
    res.sendStatus(200);

    try {
      // payload comum: { data: { id: "PAYMENT_ID" } }
      const dataId =
        String(req.body?.data?.id || "") ||
        String(req.query["data.id"] || "") ||
        String(req.query.id || "");

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

      await processPaymentFromWebhook(String(dataId));
    } catch (e) {
      console.log("❌ webhook error:", e?.response?.data || e?.message || e);
    }
  });

  const PORT = Number(process.env.PORT || CONFIG.WEBHOOK_PORT_FALLBACK || 10000);
  app.listen(PORT, () => console.log(`🌐 Webhook rodando na porta ${PORT} (/mp/webhook)`));
}

// ===================== START =====================
acquireInstanceLockOrExit();
startInstanceHeartbeat();

startWebhookServer();
client.login(CONFIG.DISCORD_TOKEN);
