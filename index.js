/**
 * index.js — Discord.js v14 + Tickets + SQLite + Mercado Pago (PROD) Checkout Pro + Webhook + Entrega
 * - Coins (1 coin = R$1,00)
 * - Packs: 5 / 10 / 25 / 50 / 100 / 500
 * - Arredonda preço PRA CIMA em R$0,50
 * - Anti-duplicação: lock de instância (SQLite) + dedupe interação + lock por ticket/canal
 * - /setnick /setemail sem “pensando infinito” (defer + editReply seguro)
 * - Fechar ticket: buyer OU SUPPORT_ROLE_ID OU ManageChannels
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

  // Mercado Pago
  MP_ACCESS_TOKEN: requireEnv("MP_ACCESS_TOKEN"),
  MP_NOTIFICATION_URL: optionalEnv("MP_NOTIFICATION_URL", ""),
  MP_WEBHOOK_SECRET: optionalEnv("MP_WEBHOOK_SECRET", ""),

  // Entrega (sua API)
  API_URL: requireEnv("API_URL"),
  API_TOKEN: requireEnv("API_TOKEN"),

  // Timers
  TICKET_COOLDOWN_MS: Number(optionalEnv("TICKET_COOLDOWN_MS", "60000")),
  INACTIVITY_CLOSE_MS: Number(optionalEnv("INACTIVITY_CLOSE_MS", String(10 * 60 * 1000))),
  DELETE_DELAY_MS: Number(optionalEnv("DELETE_DELAY_MS", "2500")),
  AUTO_CLOSE_AFTER_DELIVERY_MS: Number(optionalEnv("AUTO_CLOSE_AFTER_DELIVERY_MS", "8000")),

  // Anti-duplicação
  INTERACTION_DEDUPE_MS: Number(optionalEnv("INTERACTION_DEDUPE_MS", "12000")),
  PACK_LOCK_MS: Number(optionalEnv("PACK_LOCK_MS", "15000")),

  // Lock de instância
  INSTANCE_LOCK_TTL_MS: Number(optionalEnv("INSTANCE_LOCK_TTL_MS", "45000")),
  INSTANCE_HEARTBEAT_MS: Number(optionalEnv("INSTANCE_HEARTBEAT_MS", "15000")),

  // Web server
  WEBHOOK_PORT_FALLBACK: Number(optionalEnv("WEBHOOK_PORT", "10000")),
});

if (!isSnowflake(CONFIG.LOG_CHANNEL_ID)) console.warn("⚠️ LOG_CHANNEL_ID parece inválido (só números).");
if (CONFIG.SUPPORT_ROLE_ID && !isSnowflake(CONFIG.SUPPORT_ROLE_ID)) console.warn("⚠️ SUPPORT_ROLE_ID parece inválido.");

console.log(`🔎 MP signature check: ${CONFIG.MP_WEBHOOK_SECRET ? "ON" : "OFF"}`);

// ===================== COINS / PACKS =====================
const COIN_BASE_BRL = 1.0;

const PACKS = Object.freeze([
  { id: "c5", coins: 5, discount: 0.0, emoji: "🟢" },
  { id: "c10", coins: 10, discount: 0.005, emoji: "🟡" },
  { id: "c25", coins: 25, discount: 0.01, emoji: "🟠" },
  { id: "c50", coins: 50, discount: 0.015, emoji: "🔴" },
  { id: "c100", coins: 100, discount: 0.025, emoji: "🔷" },
  { id: "c500", coins: 500, discount: 0.05, emoji: "👑" },
]);

function roundUpTo050(value) {
  return Math.ceil(value * 2) / 2;
}
function calculatePriceBRL(pack) {
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

// ---- lock de instância ----
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
  heartbeatTimer: null,
  hasLock: false,
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

  if (Number(row.expires_at) <= t || row.owner === INSTANCE.owner) {
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

// ---- perfil ----
db.exec(`
  CREATE TABLE IF NOT EXISTS user_profile (
    discord_id TEXT PRIMARY KEY,
    nick TEXT DEFAULT '',
    email TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  );
`);

// ---- compras ----
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
  INSERT INTO purchases (order_id, payment_id, preference_id, buyer_id, channel_id, nick, email, pack_id, coins, amount, status, created_at, updated_at)
  VALUES (@order_id, @payment_id, @preference_id, @buyer_id, @channel_id, @nick, @email, @pack_id, @coins, @amount, @status, @created_at, @updated_at)
`);

const stmtGetPurchaseByOrder = db.prepare(`SELECT * FROM purchases WHERE order_id = ?`);
const stmtGetPurchaseByPayment = db.prepare(`SELECT * FROM purchases WHERE payment_id = ?`);
const stmtUpdatePurchaseStatus = db.prepare(`UPDATE purchases SET payment_id=@payment_id, status=@status, updated_at=@updated_at WHERE order_id=@order_id`);
const stmtFindPendingInChannel = db.prepare(`
  SELECT * FROM purchases
  WHERE channel_id = ? AND status IN ('PENDING','APPROVED')
  ORDER BY created_at DESC
  LIMIT 1
`);

// ===================== STATE (RAM) =====================
const STATE = {
  openTickets: new Map(),
  cooldown: new Map(),
  inactivityTimers: new Map(),
  generatingTicket: new Set(),
  delivering: new Set(),
  handledInteractions: new Map(),
  packLocks: new Map(),
};

// ===================== TOPIC HELPERS =====================
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

// ===================== SAFE RESPONDER (BUG FIX AQUI) =====================
function createSafeResponder(interaction) {
  let didDefer = false;

  async function ensureDefer() {
    if (interaction.deferred || interaction.replied || didDefer) return;
    didDefer = true;
    try {
      // ✅ use ephemeral: true (sem flags)
      await interaction.deferReply({ ephemeral: true });
    } catch {
      // ignora
    }
  }

  async function respond(content, extra = {}) {
    const payload = { content: String(content ?? ""), ...extra };

    // ✅ editReply NÃO pode receber flags/ephemeral
    if (interaction.deferred) {
      try {
        return await interaction.editReply(payload);
      } catch {}
    }

    // ✅ reply pode ser ephemeral
    if (!interaction.replied) {
      try {
        return await interaction.reply({ ...payload, ephemeral: true });
      } catch {}
    }

    // ✅ followUp pode ser ephemeral
    try {
      return await interaction.followUp({ ...payload, ephemeral: true });
    } catch {}

    return null;
  }

  return { ensureDefer, respond };
}

// ===================== DEDUPE INTERACTION =====================
function markAndCheckDuplicate(interactionId) {
  const t = now();
  for (const [id, ts] of STATE.handledInteractions.entries()) {
    if (t - ts > CONFIG.INTERACTION_DEDUPE_MS) STATE.handledInteractions.delete(id);
  }
  if (STATE.handledInteractions.has(interactionId)) return true;
  STATE.handledInteractions.set(interactionId, t);
  return false;
}

// ===================== LOG =====================
async function sendPurchaseLog({ status, buyerId, nick, email, packId, coins, amount, orderId, paymentId, timestamp }) {
  try {
    const guild = await client.guilds.fetch(CONFIG.GUILD_ID).catch(() => null);
    if (!guild) return;

    const ch = await guild.channels.fetch(CONFIG.LOG_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.isTextBased()) return;

    const pack = PACKS.find((p) => p.id === packId);

    const content =
      `🧾 **LOG COMPRA (COINS)**\n` +
      `• Status: **${status}**\n` +
      `• buyerId: **${buyerId}** (<@${buyerId}>)\n` +
      `• Nick: **${nick || "—"}**\n` +
      `• Email: **${email || "—"}**\n` +
      `• Pack: **${pack?.coins ?? coins ?? "—"} coins**\n` +
      `• Valor: **${amount != null ? brl(Number(amount)) : "—"}**\n` +
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

async function createCheckoutPreference({ pack, buyerId, nick, email, orderId }) {
  const amount = calculatePriceBRL(pack);

  const body = {
    items: [
      {
        title: `${pack.coins} Coins`,
        description: `Nick: ${nick} | Coins: ${pack.coins}`,
        quantity: 1,
        unit_price: Number(amount),
        currency_id: "BRL",
      },
    ],
    payer: { email },
    external_reference: orderId,
    metadata: { buyerId, nick, packId: pack.id, coins: pack.coins, orderId },
  };

  if (CONFIG.MP_NOTIFICATION_URL) body.notification_url = CONFIG.MP_NOTIFICATION_URL;

  const res = await axios.post("https://api.mercadopago.com/checkout/preferences", body, {
    headers: mpHeaders({ "X-Idempotency-Key": idempotencyKey() }),
    timeout: 20000,
  });

  return res.data;
}

async function getPayment(paymentId) {
  const res = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: mpHeaders(),
    timeout: 20000,
  });
  return res.data;
}

// ===================== WEBHOOK SIGNATURE =====================
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

// ===================== PROCESSA PAGAMENTO =====================
async function processPaymentFromWebhook(paymentId) {
  if (STATE.delivering.has(paymentId)) return;
  STATE.delivering.add(paymentId);

  try {
    const existingByPay = stmtGetPurchaseByPayment.get(String(paymentId));
    if (existingByPay && existingByPay.status === "DELIVERED") return;

    const payment = await getPayment(paymentId);
    const status = String(payment?.status || "unknown");
    const orderId = String(payment?.external_reference || "");

    if (!orderId) return;

    const purchase = stmtGetPurchaseByOrder.get(orderId);
    if (!purchase) return;

    stmtUpdatePurchaseStatus.run({
      order_id: orderId,
      payment_id: String(paymentId),
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
        coins: purchase.coins,
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
      await channel.send(
        `✅ Pagamento aprovado!\n🧾 Pedido: **${orderId}**\n🧾 PaymentId: **${paymentId}**\n🚀 Entregando **${purchase.coins} coins**...`
      ).catch(() => {});
    }

    const result = await deliverToGame({ nick: purchase.nick, coins: purchase.coins, orderId });
    const ok = result && (result.ok === true || result.success === true);

    if (ok) {
      stmtUpdatePurchaseStatus.run({
        order_id: orderId,
        payment_id: String(paymentId),
        status: "DELIVERED",
        updated_at: now(),
      });

      await sendPurchaseLog({
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
        cleanupChannelState(channel.id);
        setTimeout(() => channel.delete().catch(() => {}), CONFIG.AUTO_CLOSE_AFTER_DELIVERY_MS);
      }
      return;
    }

    stmtUpdatePurchaseStatus.run({
      order_id: orderId,
      payment_id: String(paymentId),
      status: "DELIVERY_ERROR",
      updated_at: now(),
    });

    if (channel?.isTextBased()) {
      await channel.send(`❌ Erro na entrega: \`${JSON.stringify(result)}\``).catch(() => {});
    }
  } catch (e) {
    console.log("❌ processPaymentFromWebhook erro:", e?.response?.data || e?.message || e);
  } finally {
    STATE.delivering.delete(paymentId);
  }
}

// ===================== UI =====================
function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle("🪙 Loja Oficial de Coins")
    .setDescription(
      "**Compre Coins com segurança e entrega automática.**\n\n" +
      "✅ **1 Coin = R$ 1,00**\n" +
      "💳 **Pagamento:** Mercado Pago\n" +
      "⚡ **Entrega:** automática após aprovação\n\n" +
      "Clique no botão abaixo para abrir um ticket."
    )
    .setFooter({ text: "Sistema automático • Seguro • Profissional" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_ticket").setLabel("Abrir Ticket").setStyle(ButtonStyle.Primary).setEmoji("🎟️")
  );

  return { embeds: [embed], components: [row] };
}

function buildPackRows(disabled = false) {
  const rows = [];
  let current = new ActionRowBuilder();

  for (const p of PACKS) {
    const price = calculatePriceBRL(p);
    const btn = new ButtonBuilder()
      .setCustomId(`pack:${p.id}`)
      .setLabel(`${p.coins} coins (${brl(price)})`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);

    if (p.emoji) btn.setEmoji(p.emoji);

    if (current.components.length >= 5) {
      rows.push(current);
      current = new ActionRowBuilder();
    }
    current.addComponents(btn);
  }
  if (current.components.length) rows.push(current);

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
  if (!channel || !channel.isTextBased()) return;

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

// ===================== PERMISSÃO FECHAR =====================
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

// ===================== TICKET CREATE/CLOSE =====================
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
  if (STATE.generatingTicket.has(genKey)) return { ok: false, reason: "Estou criando seu ticket… tente novamente." };
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
    });

    STATE.openTickets.set(user.id, channel.id);
    STATE.cooldown.set(user.id, ts);
    resetInactivityTimer(channel);

    const embed = new EmbedBuilder()
      .setColor(0x00ff99)
      .setTitle("🪙 Compra de Coins")
      .setDescription(
        "**Passo 1:** Envie seu **nick** (mensagem) ou use `/setnick`\n" +
        "**Passo 2:** Envie seu **email** (mensagem) ou use `/setemail`\n" +
        "**Passo 3:** Clique no pack para gerar o **link de pagamento**\n\n" +
        `📌 Nick salvo: **${topicObj.nick || "—"}**\n` +
        `📌 Email salvo: **${topicObj.email || "—"}**`
      );

    const menuMsg = await channel.send({ embeds: [embed], components: buildPackRows(false) });
    topicObj.menuMsgId = menuMsg.id;
    await channel.setTopic(buildTopic(topicObj)).catch(() => {});

    return { ok: true, channelId: channel.id };
  } catch (e) {
    console.log("❌ createTicketChannel erro:", e?.message || e);
    return { ok: false, reason: "Erro interno ao criar ticket." };
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

// ===================== LOCK PACK =====================
function acquirePackLock(channelId, byUserId) {
  const t = now();
  const cur = STATE.packLocks.get(channelId);
  if (cur && cur.until > t) return { ok: false, waitMs: cur.until - t };
  STATE.packLocks.set(channelId, { until: t + CONFIG.PACK_LOCK_MS, by: byUserId });
  return { ok: true };
}
function releasePackLock(channelId) {
  STATE.packLocks.delete(channelId);
}

// ===================== BUTTON HANDLER =====================
async function handleButton(interaction) {
  const { ensureDefer, respond } = createSafeResponder(interaction);
  await ensureDefer();

  if (markAndCheckDuplicate(interaction.id)) return respond("⏳ Já estou processando isso…");

  try {
    const customId = interaction.customId;
    console.log("[BTN]", customId, "by", interaction.user.id, "in", interaction.channelId);

    const guild = interaction.guild;
    if (!guild) return respond("❌ Use isso dentro do servidor.");

    if (customId === "open_ticket") {
      const result = await createTicketChannel({ guild, user: interaction.user });
      if (!result.ok) return respond(`⚠️ ${result.reason}`);
      return respond(`✅ Ticket criado! Vá para: <#${result.channelId}>`);
    }

    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return respond("❌ Canal inválido.");
    if (!isTicketChannel(channel)) return respond("⚠️ Use isso dentro de um ticket válido.");

    resetInactivityTimer(channel);

    const topicObj = parseTopic(channel.topic || "");
    const buyerId = String(topicObj.buyer || "").trim();
    const isBuyer = buyerId && interaction.user.id === buyerId;

    if (customId === "close_ticket") {
      if (!canCloseTicket(interaction, buyerId)) return respond("⚠️ Sem permissão para fechar este ticket.");
      await respond("🔒 Fechando em instantes...");
      await closeTicketChannel(channel, "Ticket fechado.");
      return;
    }

    if (customId.startsWith("pack:")) {
      if (!isBuyer) return respond("⚠️ Só quem abriu o ticket pode escolher o pack.");

      const lock = acquirePackLock(channel.id, interaction.user.id);
      if (!lock.ok) return respond(`⏳ Aguarde ${Math.ceil(lock.waitMs / 1000)}s…`);

      try {
        await respond("⏳ Gerando link de pagamento...");

        const pending = stmtFindPendingInChannel.get(channel.id);
        if (pending) {
          return respond(`⚠️ Já existe pedido pendente neste ticket.\n🧾 orderId: **${pending.order_id}**`);
        }

        const packId = customId.split(":")[1];
        const pack = PACKS.find((p) => p.id === packId);
        if (!pack) return respond("❌ Pack inválido.");

        const nick = String(topicObj.nick || "").trim();
        const email = String(topicObj.email || "").trim();
        if (!nick) return respond("❌ Envie seu nick (mensagem) ou use /setnick.");
        if (!email) return respond("❌ Envie seu email (mensagem) ou use /setemail.");

        const orderId = makeOrderId(interaction.user.id);

        const pref = await createCheckoutPreference({ pack, buyerId: interaction.user.id, nick, email, orderId });
        const payLink = String(pref?.init_point || "");
        if (!payLink) return respond("❌ Mercado Pago não retornou o link (init_point).");

        const amount = calculatePriceBRL(pack);

        stmtInsertPurchase.run({
          order_id: orderId,
          payment_id: "",
          preference_id: String(pref?.id || ""),
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

        topicObj.orderId = orderId;
        await channel.setTopic(buildTopic(topicObj)).catch(() => {});

        const menuMsgId = String(topicObj.menuMsgId || "").trim();
        if (menuMsgId) {
          try {
            const menuMsg = await channel.messages.fetch(menuMsgId);
            await menuMsg.edit({ components: buildPackRows(true) });
          } catch {}
        }

        await channel.send(
          `✅ **Link de pagamento gerado!**\n` +
          `👤 Nick: **${nick}**\n` +
          `🪙 Coins: **${pack.coins}**\n` +
          `💰 Valor: **${brl(amount)}**\n` +
          `🧾 Pedido: **${orderId}**\n\n` +
          `👉 **Clique para pagar:** ${payLink}\n\n` +
          `✅ Após aprovação, a entrega será automática.`
        ).catch(() => {});

        await sendPurchaseLog({
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

        return respond("✅ Link enviado no ticket!");
      } finally {
        releasePackLock(channel.id);
      }
    }

    return respond("⚠️ Botão desconhecido.");
  } catch (err) {
    console.error("❌ handleButton crash:", err);
    return respond("❌ Erro interno ao processar o botão.");
  }
}

// ===================== COMMAND HANDLER =====================
async function handleCommand(interaction) {
  const { ensureDefer, respond } = createSafeResponder(interaction);
  await ensureDefer();

  if (markAndCheckDuplicate(interaction.id)) return respond("⏳ Já estou processando esse comando…");

  try {
    console.log("[CMD]", interaction.commandName, "by", interaction.user.id, "in", interaction.channelId);

    if (interaction.commandName === "setemail") {
      const email = interaction.options.getString("email", true).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respond("❌ Email inválido.");

      const current = stmtGetProfile.get(interaction.user.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: interaction.user.id,
        nick: String(current.nick || ""),
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

      return respond(`✅ Email atualizado para **${email}**.`);
    }

    if (interaction.commandName === "setnick") {
      const nick = interaction.options.getString("nick", true).trim();
      if (nick.length < 2) return respond("❌ Nick inválido.");

      const current = stmtGetProfile.get(interaction.user.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: interaction.user.id,
        nick,
        email: String(current.email || ""),
        updated_at: now(),
      });

      if (interaction.channel && isTicketChannel(interaction.channel)) {
        const topicObj = parseTopic(interaction.channel.topic || "");
        if (String(topicObj.buyer || "") === interaction.user.id) {
          topicObj.nick = nick;
          await interaction.channel.setTopic(buildTopic(topicObj)).catch(() => {});
        }
      }

      return respond(`✅ Nick atualizado para **${nick}**.`);
    }

    return respond("⚠️ Comando desconhecido.");
  } catch (err) {
    console.error("❌ handleCommand crash:", err);
    return respond("❌ Erro interno no comando (veja o log do Render).");
  }
}

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

    const nickTopic = String(topicObj.nick || "").trim();
    if (!nickTopic) {
      const nick = text;
      const current = stmtGetProfile.get(msg.author.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: msg.author.id,
        nick,
        email: String(current.email || ""),
        updated_at: now(),
      });

      topicObj.nick = nick;
      await channel.setTopic(buildTopic(topicObj)).catch(() => {});
      await channel.send(`✅ Nick salvo: **${nick}**\nAgora envie seu **email** (ou use /setemail).`).catch(() => {});
      return;
    }

    const emailTopic = String(topicObj.email || "").trim();
    const looksEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    if (!emailTopic && looksEmail) {
      const email = text.toLowerCase();
      const current = stmtGetProfile.get(msg.author.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: msg.author.id,
        nick: String(current.nick || topicObj.nick || ""),
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
