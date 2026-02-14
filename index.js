/**
 * index.js — Discord.js v14 + Tickets + SQLite + Mercado Pago (PROD) Checkout Pro + Webhook + Entrega
 * Fixes:
 *  - Nunca "pensando infinito" (ACK único + safe reply)
 *  - Anti-duplicação (dedupe interaction + lock por usuário/canal)
 *  - close_ticket (buyer OU suporte OU ManageChannels)
 *  - Anti-spam pack (bloqueia duplo clique + não gera 2 links se tiver PENDING)
 *  - Painel não duplica (usa PANEL_MESSAGE_ID)
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
  MessageFlags, // ✅ usar flags (evita warning do ephemeral deprecated)
} = require("discord.js");

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const Database = require("better-sqlite3");

// ===================== BOOT =====================
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
console.log("🚀 INDEX CARREGADO:", __filename, "PID:", process.pid);

// ===================== ENV =====================
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
  PANEL_MESSAGE_ID: optionalEnv("PANEL_MESSAGE_ID", ""), // importante p/ não duplicar
  TICKET_CATEGORY_ID: requireEnv("TICKET_CATEGORY_ID"),
  LOG_CHANNEL_ID: requireEnv("LOG_CHANNEL_ID"),
  SUPPORT_ROLE_ID: optionalEnv("SUPPORT_ROLE_ID", ""),

  // Mercado Pago
  MP_ACCESS_TOKEN: requireEnv("MP_ACCESS_TOKEN"),
  MP_NOTIFICATION_URL: optionalEnv("MP_NOTIFICATION_URL", ""), // https://cerico-bot.onrender.com/mp/webhook
  MP_WEBHOOK_SECRET: optionalEnv("MP_WEBHOOK_SECRET", ""), // se não tiver, signature OFF

  // Entrega (sua API)
  API_URL: requireEnv("API_URL"),
  API_TOKEN: requireEnv("API_TOKEN"),

  // Render
  PORT_FALLBACK: Number(optionalEnv("WEBHOOK_PORT", "10000")),

  // Timers / Locks
  TICKET_COOLDOWN_MS: Number(optionalEnv("TICKET_COOLDOWN_MS", "60000")),
  INACTIVITY_CLOSE_MS: Number(optionalEnv("INACTIVITY_CLOSE_MS", String(10 * 60 * 1000))), // 10 min
  DELETE_DELAY_MS: Number(optionalEnv("DELETE_DELAY_MS", "2500")),
  AUTO_CLOSE_AFTER_DELIVERY_MS: Number(optionalEnv("AUTO_CLOSE_AFTER_DELIVERY_MS", "10000")),

  DEDUPE_TTL_MS: Number(optionalEnv("DEDUP_TTL_MS", "15000")),
  PACK_LOCK_MS: Number(optionalEnv("PACK_LOCK_MS", "15000")),
});

if (!isSnowflake(CONFIG.LOG_CHANNEL_ID)) console.warn("⚠️ LOG_CHANNEL_ID inválido (precisa ser snowflake numérico).");
if (CONFIG.SUPPORT_ROLE_ID && !isSnowflake(CONFIG.SUPPORT_ROLE_ID))
  console.warn("⚠️ SUPPORT_ROLE_ID inválido (precisa ser snowflake numérico).");

console.log(`🔎 MP signature check: ${CONFIG.MP_WEBHOOK_SECRET ? "ON" : "OFF"}`);

// ===================== COINS / PACKS =====================
// 1 coin = R$ 1,00
const COIN_BASE_BRL = 1.0;

// descontos: até 2,5% nos comuns; 5% no 500
const PACKS = Object.freeze([
  { id: "c5", coins: 5, discount: 0.0, emoji: "🟢" },
  { id: "c10", coins: 10, discount: 0.0, emoji: "🟡" },
  { id: "c25", coins: 25, discount: 0.01, emoji: "🟠" },
  { id: "c50", coins: 50, discount: 0.01, emoji: "🔴" },
  { id: "c100", coins: 100, discount: 0.025, emoji: "🔷" },
  { id: "c500", coins: 500, discount: 0.05, emoji: "👑" },
]);

function roundUpTo50Cents(value) {
  // arredonda pra cima para 0,50
  return Math.ceil(value * 2) / 2;
}
function calcPackPrice(pack) {
  const base = pack.coins * COIN_BASE_BRL;
  const discounted = base * (1 - pack.discount);
  return roundUpTo50Cents(discounted);
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

// perfil usuário
db.exec(`
  CREATE TABLE IF NOT EXISTS user_profile (
    discord_id TEXT PRIMARY KEY,
    nick TEXT DEFAULT '',
    email TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  );
`);

// compras
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
    status TEXT NOT NULL, -- PENDING / APPROVED / DELIVERED / DELIVERY_ERROR / ...
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

  handledInteractions: new Map(), // interactionId -> ts
  creatingTicket: new Set(), // userId
  packLocks: new Map(), // channelId -> { until, by }
  delivering: new Set(), // paymentId runtime lock
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
  const safe = (user.username || "user")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `ticket-${safe}-${user.id.slice(-4)}`;
}
function makeOrderId(userId) {
  return `DISCORD-${userId}-${Date.now()}`;
}

// ===================== SAFE REPLY (NUNCA trava) =====================
// Regra obrigatória: deferReply({ flags: Ephemeral }) no começo; depois só editReply.
// Se interaction morrer (10062), faz fallback mandando msg no canal (pra não ficar travado).
function createSafeResponder(interaction) {
  let acked = false;
  let triedAck = false;

  function canChannelFallback() {
    return interaction?.channel && typeof interaction.channel.send === "function";
  }

  async function channelFallback(text) {
    try {
      if (!canChannelFallback()) return;
      // evita spam: manda uma só e menciona o usuário
      await interaction.channel.send(`⚠️ <@${interaction.user.id}> ${text}`).catch(() => {});
    } catch {}
  }

  async function ack() {
    if (interaction.deferred || interaction.replied || acked || triedAck) return;
    triedAck = true;

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // ✅ padrão estável no seu ambiente
      acked = true;
    } catch (e) {
      const code = e?.code;
      const msg = String(e?.message || "");

      // já foi ack -> ok
      if (code === 40060 || msg.includes("already been acknowledged")) {
        acked = true;
        return;
      }

      // interaction morreu -> não tem como responder via interaction
      if (code === 10062 || msg.includes("Unknown interaction")) {
        await channelFallback("não consegui responder o comando (interaction expirou). Tente novamente.");
        return;
      }

      console.log("⚠️ deferReply falhou:", code, msg);
    }
  }

  async function done(content) {
    const text = String(content ?? "");

    // Se já reconheceu, só editReply
    if (interaction.deferred || interaction.replied || acked) {
      try {
        await interaction.editReply({ content: text });
        return;
      } catch (e) {
        const code = e?.code;
        const msg = String(e?.message || "");

        if (code === 10062 || msg.includes("Unknown interaction")) {
          await channelFallback(text);
          return;
        }

        // tenta followUp ephemeral (não vira 2º ack)
        try {
          await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
          return;
        } catch (e2) {
          const code2 = e2?.code;
          const msg2 = String(e2?.message || "");
          if (code2 === 10062 || msg2.includes("Unknown interaction")) {
            await channelFallback(text);
          }
          return;
        }
      }
    }

    // Se ainda não ackou, tenta reply ephemeral
    try {
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      acked = true;
      return;
    } catch (e) {
      const code = e?.code;
      const msg = String(e?.message || "");

      if (code === 40060 || msg.includes("already been acknowledged")) {
        try {
          await interaction.editReply({ content: text });
          return;
        } catch {}
      }

      if (code === 10062 || msg.includes("Unknown interaction")) {
        await channelFallback(text);
        return;
      }

      // último fallback
      try {
        await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
      } catch {
        await channelFallback(text);
      }
    }
  }

  return { ack, done };
}

// ===================== DEDUPE interaction.id =====================
function isDupInteraction(interactionId) {
  const t = now();
  for (const [id, ts] of STATE.handledInteractions.entries()) {
    if (t - ts > CONFIG.DEDUPE_TTL_MS) STATE.handledInteractions.delete(id);
  }
  if (STATE.handledInteractions.has(interactionId)) return true;
  STATE.handledInteractions.set(interactionId, t);
  return false;
}

// ===================== INACTIVITY =====================
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

      await fresh.send("⏳ Ticket sem atividade por **10 minutos**. Fechando automaticamente.").catch(() => {});
      cleanupChannelState(fresh.id);
      await fresh.delete().catch(() => {});
    } catch (e) {
      console.log("⚠️ inactivity close error:", e?.message || e);
    }
  }, CONFIG.INACTIVITY_CLOSE_MS);

  STATE.inactivityTimers.set(channel.id, t);
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
      `• Pack: **${pack?.coins ?? coins ?? "—"} coins** (${packId})\n` +
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
async function deliverToGame({ nick, packId, coins, orderId }) {
  const url =
    `${CONFIG.API_URL}?token=${encodeURIComponent(CONFIG.API_TOKEN)}` +
    `&player=${encodeURIComponent(nick)}` +
    `&pack=${encodeURIComponent(packId)}` +
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
  const price = calcPackPrice(pack);

  const body = {
    items: [
      {
        title: `${pack.coins} Coins`,
        description: `Nick: ${nick} | Coins: ${pack.coins}`,
        quantity: 1,
        unit_price: Number(price),
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

// ===================== WEBHOOK PROCESS =====================
async function processPaymentFromWebhook(paymentId) {
  const pid = String(paymentId);

  if (STATE.delivering.has(pid)) {
    console.log("🟨 delivery lock ativo:", pid);
    return;
  }
  STATE.delivering.add(pid);

  try {
    const already = stmtGetPurchaseByPayment.get(pid);
    if (already && already.status === "DELIVERED") {
      console.log("🟨 Já entregue (DB) paymentId:", pid);
      return;
    }

    const payment = await getPayment(pid);
    const status = String(payment?.status || "unknown");
    const orderId = String(payment?.external_reference || "");

    console.log("[MP] payment", pid, "status", status, "orderId", orderId);

    if (!orderId) return;

    const purchase = stmtGetPurchaseByOrder.get(orderId);
    if (!purchase) {
      console.log("⚠️ Compra não encontrada no DB (orderId):", orderId);
      return;
    }

    stmtUpdatePurchase.run({
      order_id: orderId,
      payment_id: pid,
      preference_id: purchase.preference_id || "",
      status: status.toUpperCase(),
      updated_at: now(),
    });

    if (status !== "approved") {
      await sendPurchaseLog({
        mode: "PROD",
        status: status.toUpperCase(),
        buyerId: purchase.buyer_id,
        nick: purchase.nick,
        email: purchase.email,
        packId: purchase.pack_id,
        coins: purchase.coins,
        amount: purchase.amount,
        orderId,
        paymentId: pid,
        timestamp: now(),
      });
      return;
    }

    const refreshed = stmtGetPurchaseByOrder.get(orderId);
    if (refreshed && refreshed.status === "DELIVERED") return;

    const channel = await client.channels.fetch(purchase.channel_id).catch(() => null);
    if (channel?.isTextBased()) {
      await channel
        .send(
          `✅ **Pagamento aprovado!**\n` +
            `🧾 Pedido: **${orderId}**\n` +
            `🧾 PaymentId: **${pid}**\n` +
            `⚡ Iniciando entrega automática...`
        )
        .catch(() => {});
    }

    const result = await deliverToGame({
      nick: purchase.nick,
      packId: purchase.pack_id,
      coins: purchase.coins,
      orderId,
    });

    const ok = result && (result.ok === true || result.success === true);

    if (ok) {
      stmtUpdatePurchase.run({
        order_id: orderId,
        payment_id: pid,
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
        paymentId: pid,
        timestamp: now(),
      });

      if (channel?.isTextBased()) {
        await channel.send("🎉 **Coins entregues com sucesso!**").catch(() => {});
        await channel
          .send(`🔒 Ticket será fechado em ${Math.floor(CONFIG.AUTO_CLOSE_AFTER_DELIVERY_MS / 1000)}s...`)
          .catch(() => {});
        cleanupChannelState(channel.id);
        setTimeout(() => channel.delete().catch(() => {}), CONFIG.AUTO_CLOSE_AFTER_DELIVERY_MS);
      }
      return;
    }

    stmtUpdatePurchase.run({
      order_id: orderId,
      payment_id: pid,
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
      paymentId: pid,
      timestamp: now(),
    });

    if (channel?.isTextBased()) {
      await channel.send(`❌ Erro na entrega: \`${String(JSON.stringify(result))}\``).catch(() => {});
    }
  } catch (e) {
    console.log("❌ processPaymentFromWebhook erro:", e?.response?.data || e?.message || e);
  } finally {
    STATE.delivering.delete(pid);
  }
}

// ===================== UI (PAINEL / MENU TICKET) =====================
function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("🪙 Loja Oficial de Coins")
    .setDescription(
      "**Compre Coins com segurança e entrega automática.**\n\n" +
        "✅ **1 Coin = R$ 1,00**\n" +
        "💳 Pagamento via **Mercado Pago (Checkout Pro)**\n" +
        "⚡ Entrega automática após aprovação\n\n" +
        "Clique no botão abaixo para abrir um ticket."
    )
    .setFooter({ text: "Sistema automático • Seguro • Profissional" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_ticket").setLabel("Abrir Ticket").setStyle(ButtonStyle.Primary).setEmoji("🎟️")
  );

  return { embeds: [embed], components: [row] };
}

function buildTicketMenuEmbed({ nick, email }) {
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("🪙 Compra de Coins")
    .setDescription(
      "**Passo 1:** Envie seu **nick** (mensagem) ou use **/setnick**\n" +
        "**Passo 2:** Envie seu **email** (mensagem) ou use **/setemail**\n" +
        "**Passo 3:** Clique no pack para gerar o **link de pagamento**\n\n" +
        `📌 **Nick salvo:** ${nick ? `**${nick}**` : "—"}\n` +
        `📌 **Email salvo:** ${email ? `**${email}**` : "—"}`
    )
    .setFooter({ text: "Dica: se já existir pedido pendente, não gera outro link." });
}

function buildPackRows(disabled = false) {
  const rows = [];
  let row = new ActionRowBuilder();

  for (const pack of PACKS) {
    const price = calcPackPrice(pack);

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`pack:${pack.id}`)
        .setLabel(`${pack.coins} coins (${brl(price)})`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(pack.emoji)
        .setDisabled(disabled)
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

async function refreshTicketMenuMessage(channel, topicObj) {
  if (!channel || !channel.isTextBased() || !isTicketChannel(channel)) return;

  const nick = String(topicObj.nick || "").trim();
  const email = String(topicObj.email || "").trim();
  const menuMsgId = String(topicObj.menuMsgId || "").trim();

  const pending = stmtFindPendingInChannel.get(channel.id);
  const disablePacks = !!pending;

  if (!menuMsgId) return;
  try {
    const menuMsg = await channel.messages.fetch(menuMsgId);
    await menuMsg.edit({
      embeds: [buildTicketMenuEmbed({ nick, email })],
      components: buildPackRows(disablePacks),
    });
  } catch {}
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
      console.log("⚠️ PANEL_MESSAGE_ID inválido/apagado. Criando painel novo...");
    }
  }

  const newMsg = await channel.send(payload);
  console.log("✅ Painel criado. Copie e coloque no Render ENV:");
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

// ===================== PERMISSÃO CLOSE =====================
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

  if (STATE.creatingTicket.has(user.id)) {
    return { ok: false, reason: "Estou criando seu ticket… aguarde um instante." };
  }
  STATE.creatingTicket.add(user.id);

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
      email: (profile.email || "").trim().toLowerCase(),
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
      embeds: [buildTicketMenuEmbed({ nick: topicObj.nick, email: topicObj.email })],
      components: buildPackRows(false),
    });

    topicObj.menuMsgId = menuMsg.id;
    await channel.setTopic(buildTopic(topicObj)).catch(() => {});

    return { ok: true, channelId: channel.id };
  } catch (e) {
    console.log("❌ createTicketChannel erro:", e?.message || e);
    return { ok: false, reason: "Não consegui criar o ticket (erro interno)." };
  } finally {
    STATE.creatingTicket.delete(user.id);
  }
}

async function closeTicketChannel(channel, reasonText = "Ticket fechado.") {
  if (!channel || !isTicketChannel(channel)) return;
  await channel.send(`🔒 ${reasonText}`).catch(() => {});
  cleanupChannelState(channel.id);
  setTimeout(() => channel.delete().catch(() => {}), CONFIG.DELETE_DELAY_MS);
}

// ===================== PACK LOCK =====================
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
  if (isDupInteraction(interaction.id)) return;

  const { ack, done } = createSafeResponder(interaction);

  // ✅ ACK cedo
  await ack();

  try {
    const customId = interaction.customId;
    console.log("[BTN]", customId, "by", interaction.user.id, "in", interaction.channelId);

    const guild = interaction.guild;
    if (!guild) return await done("❌ Use isso dentro do servidor.");

    if (customId === "open_ticket") {
      const result = await createTicketChannel({ guild, user: interaction.user });
      if (!result.ok) return await done(`⚠️ ${result.reason}`);
      return await done(`✅ Ticket criado! Vá para: <#${result.channelId}>`);
    }

    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return await done("❌ Canal inválido.");
    if (!isTicketChannel(channel)) return await done("⚠️ Use isso dentro de um ticket válido.");

    resetInactivityTimer(channel);

    const topicObj = parseTopic(channel.topic || "");
    const buyerId = String(topicObj.buyer || "").trim();
    const isBuyer = buyerId && interaction.user.id === buyerId;

    if (customId === "close_ticket") {
      if (!canCloseTicket(interaction, buyerId)) {
        return await done("⚠️ Você não tem permissão para fechar este ticket.");
      }
      await done("🔒 Fechando em instantes...");
      await closeTicketChannel(channel, "Ticket fechado.");
      return;
    }

    if (customId.startsWith("pack:")) {
      if (!isBuyer) return await done("⚠️ Só quem abriu o ticket pode escolher o pack.");

      const lock = acquirePackLock(channel.id, interaction.user.id);
      if (!lock.ok) {
        const s = Math.ceil(lock.waitMs / 1000);
        return await done(`⏳ Aguarde ${s}s... já estou processando um pedido neste ticket.`);
      }

      try {
        await done("⏳ Gerando link de pagamento...");

        const pending = stmtFindPendingInChannel.get(channel.id);
        if (pending) {
          return await done(
            `⚠️ Já existe um pedido pendente neste ticket.\n🧾 orderId: **${pending.order_id}**\nAguarde o pagamento.`
          );
        }

        const packId = customId.split(":")[1];
        const pack = PACKS.find((p) => p.id === packId);
        if (!pack) return await done("❌ Pack inválido.");

        const nick = String(topicObj.nick || "").trim();
        const email = String(topicObj.email || "").trim().toLowerCase();

        if (!nick) return await done("❌ Envie seu nick (mensagem) ou use /setnick.");
        if (!email) return await done("❌ Envie seu email (mensagem) ou use /setemail.");

        const orderId = makeOrderId(interaction.user.id);

        let pref;
        try {
          pref = await createCheckoutPreference({ pack, buyerId: interaction.user.id, nick, email, orderId });
        } catch (e) {
          console.log("❌ MP createPreference erro:", e?.response?.data || e?.message || e);
          return await done("❌ Não consegui gerar o link de pagamento agora (Mercado Pago).");
        }

        const payLink = String(pref?.init_point || "");
        const preferenceId = String(pref?.id || "");
        if (!payLink) return await done("❌ Mercado Pago não retornou o link (init_point).");

        const price = calcPackPrice(pack);

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
          amount: price,
          status: "PENDING",
          created_at: now(),
          updated_at: now(),
        });

        topicObj.pack = pack.id;
        topicObj.orderId = orderId;
        topicObj.paymentId = "";
        await channel.setTopic(buildTopic(topicObj)).catch(() => {});

        await refreshTicketMenuMessage(channel, topicObj);

        await channel
          .send(
            `✅ **Link de pagamento gerado!**\n` +
              `🪙 Coins: **${pack.coins}**\n` +
              `💰 Valor: **${brl(price)}**\n` +
              `👤 Nick: **${nick}**\n` +
              `🧾 Pedido: **${orderId}**\n\n` +
              `👉 **Pagar agora:** ${payLink}\n\n` +
              `✅ Após aprovação, a entrega será automática.`
          )
          .catch(() => {});

        await sendPurchaseLog({
          mode: "PROD",
          status: "PENDING",
          buyerId: interaction.user.id,
          nick,
          email,
          packId: pack.id,
          coins: pack.coins,
          amount: price,
          orderId,
          paymentId: "—",
          timestamp: now(),
        });

        return;
      } finally {
        releasePackLock(channel.id);
      }
    }

    return await done("⚠️ Botão desconhecido/antigo. Use o painel para abrir um ticket novo.");
  } catch (err) {
    console.error("❌ handleButton crash:", err);
    try {
      await done("❌ Erro interno ao processar o botão.");
    } catch {}
  }
}

// ===================== COMMAND HANDLER =====================
async function handleCommand(interaction) {
  if (isDupInteraction(interaction.id)) return;

  const { ack, done } = createSafeResponder(interaction);

  await ack();
  console.log("[CMD]", interaction.commandName, "by", interaction.user.id, "in", interaction.channelId);

  try {
    if (interaction.commandName === "setemail") {
      const email = String(interaction.options.getString("email", true)).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return await done("❌ Email inválido.");
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
        if (String(topicObj.buyer || "") === interaction.user.id) {
          topicObj.email = email;
          await interaction.channel.setTopic(buildTopic(topicObj)).catch(() => {});
          await refreshTicketMenuMessage(interaction.channel, topicObj);
        }
      }

      return await done(`✅ Email atualizado para **${email}**.`);
    }

    if (interaction.commandName === "setnick") {
      const nick = String(interaction.options.getString("nick", true)).trim();
      if (!nick || nick.length < 2) return await done("❌ Nick inválido.");

      const current = stmtGetProfile.get(interaction.user.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: interaction.user.id,
        nick,
        email: current.email || "",
        updated_at: now(),
      });

      if (interaction.channel && isTicketChannel(interaction.channel)) {
        const topicObj = parseTopic(interaction.channel.topic || "");
        if (String(topicObj.buyer || "") === interaction.user.id) {
          topicObj.nick = nick;
          await interaction.channel.setTopic(buildTopic(topicObj)).catch(() => {});
          await refreshTicketMenuMessage(interaction.channel, topicObj);
        }
      }

      return await done(`✅ Nick atualizado para **${nick}**.`);
    }

    return await done("⚠️ Comando desconhecido.");
  } catch (err) {
    console.error("❌ handleCommand crash:", err);
    try {
      await done("❌ Deu erro no comando. Veja os logs do Render.");
    } catch {}
  }
}

// ===================== CAPTURA NICK/EMAIL POR MENSAGEM =====================
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;
    if (msg.author?.bot) return;

    const channel = msg.channel;
    if (!channel || channel.type !== ChannelType.GuildText) return;
    if (!channel.name?.startsWith("ticket-")) return;

    const topicObj = parseTopic(channel.topic || "");
    const buyerId = String(topicObj.buyer || "").trim();
    if (!buyerId) return;
    if (msg.author.id !== buyerId) return;

    resetInactivityTimer(channel);

    const text = String(msg.content || "").trim();
    if (!text) return;

    const looksEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    const nickTopic = String(topicObj.nick || "").trim();
    const emailTopicRaw = String(topicObj.email ?? "").trim();
    const emailTopic = emailTopicRaw.toLowerCase();

    const emailIsEmpty =
      !emailTopic || ["undefined", "null", "-", "—", "–", "0"].includes(emailTopic);

    // Se mandou email sem nick
    if (!nickTopic && looksEmail) {
      await channel.send("❌ Primeiro envie seu **nick**. Depois envie seu **email** (ou use /setemail).").catch(() => {});
      return;
    }

    // 1) salva nick se vazio
    if (!nickTopic) {
      const nick = text;

      const current = stmtGetProfile.get(msg.author.id) || { nick: "", email: "" };
      stmtUpsertProfile.run({
        discord_id: msg.author.id,
        nick,
        email: current.email || "",
        updated_at: now(),
      });

      topicObj.nick = nick;

      // puxa email do perfil se existir
      const refreshed = stmtGetProfile.get(msg.author.id) || { nick, email: "" };
      const profileEmail = String(refreshed.email || "").trim().toLowerCase();
      if (profileEmail && !String(topicObj.email || "").trim()) topicObj.email = profileEmail;

      await channel.setTopic(buildTopic(topicObj)).catch(() => {});
      await refreshTicketMenuMessage(channel, topicObj);

      if (topicObj.email) {
        await channel
          .send(`✅ Nick salvo: **${nick}**\n✅ Email já está salvo: **${topicObj.email}**\nAgora clique no pack para gerar o link.`)
          .catch(() => {});
      } else {
        await channel.send(`✅ Nick salvo: **${nick}**\nAgora envie seu **email** (ou use /setemail).`).catch(() => {});
      }
      return;
    }

    // 2) salva email se nick existe e email vazio
    if (looksEmail && emailIsEmpty) {
      const email = text.toLowerCase();

      const current = stmtGetProfile.get(msg.author.id) || { nick: nickTopic, email: "" };
      stmtUpsertProfile.run({
        discord_id: msg.author.id,
        nick: current.nick || nickTopic,
        email,
        updated_at: now(),
      });

      topicObj.email = email;
      await channel.setTopic(buildTopic(topicObj)).catch(() => {});
      await refreshTicketMenuMessage(channel, topicObj);

      await channel.send(`✅ Email salvo: **${email}**\nAgora clique no pack para gerar o link.`).catch(() => {});
      return;
    }

    // 3) se já tem email e mandou outro
    if (looksEmail && !emailIsEmpty) {
      await channel
        .send(`⚠️ Este ticket já tem email salvo: **${emailTopic}**\nSe quiser trocar, use **/setemail**.`)
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

  const PORT = Number(process.env.PORT || CONFIG.PORT_FALLBACK || 10000);
  app.listen(PORT, () => console.log(`🌐 Webhook rodando na porta ${PORT} (/mp/webhook)`));
}

// ===================== START =====================
startWebhookServer();
client.login(CONFIG.DISCORD_TOKEN);
