// index.js — Discord.js v14 + Tickets + SQLite + MODO TESTE (sem Mercado Pago)
// ✅ Ticket por botão (open_ticket)
// ✅ Fecha ticket (close_ticket)
// ✅ Escolha de pack (pack:<id>)
// ✅ Botão de teste (test_paid_order_<orderId>) -> processApprovedPayment -> deliverToGame -> sendPurchaseLog -> fecha ticket
// ✅ Nick: primeiro texto no ticket salva nick + SQLite + /setnick
// ✅ Anti “pensando infinito”: interactionCreate dá ACK imediato + resposta segura (sem double reply/defer)
// ✅ Flags (sem warning de ephemeral)

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

const axios = require("axios");
const Database = require("better-sqlite3");

// ===================== BOOT + ERROS GLOBAIS =====================
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
console.log("🚀 INDEX CARREGADO:", __filename, "PID:", process.pid);

// ===================== ENV / CONFIG =====================
function requireEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Faltou ${name} no .env`);
  return v;
}
function optionalEnv(name, fallback = "") {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

const CONFIG = Object.freeze({
  DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
  CLIENT_ID: requireEnv("CLIENT_ID"),
  GUILD_ID: requireEnv("GUILD_ID"),
  PANEL_CHANNEL_ID: requireEnv("PANEL_CHANNEL_ID"),
  PANEL_MESSAGE_ID: optionalEnv("PANEL_MESSAGE_ID", ""),
  TICKET_CATEGORY_ID: requireEnv("TICKET_CATEGORY_ID"),
  LOG_CHANNEL_ID: requireEnv("LOG_CHANNEL_ID"),

  // Opcional
  SUPPORT_ROLE_ID: optionalEnv("SUPPORT_ROLE_ID", ""),

  // Admins podem clicar no botão de teste
  ADMINS: new Set(
    optionalEnv("ADMINS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  ),

  // Timers
  TICKET_COOLDOWN_MS: 60_000,
  TICKET_INACTIVITY_CLOSE_MS: 10 * 60 * 1000, // 10 min
  TICKET_DELETE_DELAY_MS: 3000,
  AUTO_CLOSE_AFTER_DELIVERY_MS: 10_000,

  // API do jogo
  API_URL: requireEnv("API_URL"),
  API_TOKEN: requireEnv("API_TOKEN"),
});

if (CONFIG.ADMINS.size === 0) {
  console.warn("⚠️ Nenhum ADMIN definido (env ADMINS=...). Botão de teste ficará bloqueado para todos.");
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

// ===================== DISCORD CLIENT =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// ===================== SQLITE (Nick) =====================
const db = new Database("./loja.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS nick_verification (
    discord_id TEXT PRIMARY KEY,
    nick TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const stmtUpsertNick = db.prepare(`
  INSERT INTO nick_verification (discord_id, nick, updated_at)
  VALUES (@discord_id, @nick, @updated_at)
  ON CONFLICT(discord_id) DO UPDATE SET
    nick=excluded.nick,
    updated_at=excluded.updated_at;
`);

const stmtGetNick = db.prepare(`SELECT nick FROM nick_verification WHERE discord_id = ?`);

// ===================== MEMÓRIA (RAM) =====================
const STATE = {
  pendingOrders: new Map(), // orderId -> { packId, nick, buyerId, channelId, orderId, amount }
  openTickets: new Map(), // buyerId -> channelId
  ticketCooldown: new Map(), // buyerId -> timestamp
  ticketInactivityTimers: new Map(), // channelId -> timeout
  generatingTickets: new Set(), // "GEN:userId"
};

// ===================== UTIL TOPIC =====================
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

function cleanupChannelState(channelId) {
  for (const [oid, data] of STATE.pendingOrders.entries()) {
    if (data.channelId === channelId) STATE.pendingOrders.delete(oid);
  }
  for (const [uid, chId] of STATE.openTickets.entries()) {
    if (chId === channelId) STATE.openTickets.delete(uid);
  }
  const t = STATE.ticketInactivityTimers.get(channelId);
  if (t) clearTimeout(t);
  STATE.ticketInactivityTimers.delete(channelId);
}

// ===================== INATIVIDADE =====================
function resetTicketInactivityTimer(channel) {
  if (!isTicketChannel(channel)) return;

  const old = STATE.ticketInactivityTimers.get(channel.id);
  if (old) clearTimeout(old);

  const timeout = setTimeout(async () => {
    try {
      const fresh = await channel.guild.channels.fetch(channel.id).catch(() => null);
      if (!fresh || !fresh.isTextBased() || !isTicketChannel(fresh)) return;

      await fresh.send("⏳ Ticket sem atividade por **10 minutos**. Vou fechar automaticamente.").catch(() => {});
      cleanupChannelState(fresh.id);
      await fresh.delete().catch(() => {});
    } catch (e) {
      console.log("⚠️ auto-close inactivity error:", e?.message || e);
    }
  }, CONFIG.TICKET_INACTIVITY_CLOSE_MS);

  STATE.ticketInactivityTimers.set(channel.id, timeout);
}

// ===================== LOG (com DEBUG) =====================
async function sendPurchaseLog({ status, mode, buyerId, nick, packId, amount, orderId, paymentId, timestamp }) {
  const ts = timestamp || Date.now();

  try {
    console.log("[LOG] tentando enviar log...", {
      status,
      mode,
      buyerId,
      nick,
      packId,
      amount,
      orderId,
      paymentId,
      ts,
      guildId: CONFIG.GUILD_ID,
      logChannelId: CONFIG.LOG_CHANNEL_ID,
    });

    const guild = await client.guilds.fetch(CONFIG.GUILD_ID).catch((e) => {
      console.log("[LOG] não consegui fetch guild:", e?.message || e);
      return null;
    });
    if (!guild) return;

    const ch = await guild.channels.fetch(CONFIG.LOG_CHANNEL_ID).catch((e) => {
      console.log("[LOG] não consegui fetch canal log:", e?.message || e);
      return null;
    });
    if (!ch) return;

    if (!ch.isTextBased()) {
      console.log("[LOG] canal de log NÃO é textBased. type:", ch.type);
      return;
    }

    const pack = PACKS.find((p) => p.id === packId);

    const content =
      `🧾 **LOG COMPRA**\n` +
      `• Status: **${status}**\n` +
      `• Modo: **${mode}**\n` +
      `• buyerId: **${buyerId}** (<@${buyerId}>)\n` +
      `• Nick: **${nick || "—"}**\n` +
      `• Pack: **${pack?.label || packId || "—"}**\n` +
      `• Amount: **${amount != null ? brl(amount) : "—"}**\n` +
      `• orderId: **${orderId || "—"}**\n` +
      `• paymentId: **${paymentId || "—"}**\n` +
      `• timestamp: <t:${Math.floor(ts / 1000)}:F>`;

    const sent = await ch.send({ content }).catch((e) => {
      console.log("[LOG] falhou ao enviar mensagem no canal:", e?.message || e);
      return null;
    });

    if (sent) console.log("[LOG] enviado com sucesso. msgId:", sent.id);
  } catch (e) {
    console.log("❌ sendPurchaseLog crash:", e?.message || e);
  }
}

// ===================== ENTREGA NO JOGO =====================
async function deliverToGame({ nick, packId, orderId }) {
  const url =
    `${CONFIG.API_URL}?token=${encodeURIComponent(CONFIG.API_TOKEN)}` +
    `&player=${encodeURIComponent(nick)}` +
    `&pack=${encodeURIComponent(packId)}` +
    `&orderId=${encodeURIComponent(orderId)}`;

  console.log("🎮 [GAME] chamando API:", url.replace(CONFIG.API_TOKEN, "***"));
  const res = await axios.get(url, { timeout: 10_000 });
  console.log("🎮 [GAME] resposta:", res?.data);
  return res?.data;
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ===================== PROCESSA “APROVADO” (TESTE) =====================
async function processApprovedPayment({ paymentId, packId, nick, buyerId, amount, channelId, orderId, isTest }) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  await channel
    .send(
      `✅ Pagamento **${paymentId}** aprovado ${isTest ? "(TESTE)" : ""}!\n` +
        `📦 Pack: **${packId}**\n` +
        `👤 Nick: **${nick}**\n` +
        `🧾 Pedido: **${orderId}**\n` +
        `🚀 Enviando para o jogo agora...`
    )
    .catch(() => {});

  const baseLog = {
    mode: isTest ? "TESTE" : "REAL",
    buyerId,
    nick,
    packId,
    amount,
    orderId,
    paymentId,
    timestamp: Date.now(),
  };

  try {
    const result = await deliverToGame({ nick, packId, orderId });
    const ok = result && (result.ok === true || result.success === true);

    if (ok) {
      await sendPurchaseLog({ ...baseLog, status: "APROVADO" });

      await channel.send("✅ **Entrega concluída no jogo!**").catch(() => {});
      await channel
        .send(`🔒 Ticket será fechado automaticamente em ${Math.floor(CONFIG.AUTO_CLOSE_AFTER_DELIVERY_MS / 1000)}s...`)
        .catch(() => {});

      cleanupChannelState(channelId);
      setTimeout(() => channel.delete().catch(() => {}), CONFIG.AUTO_CLOSE_AFTER_DELIVERY_MS);
      return;
    }

    await sendPurchaseLog({ ...baseLog, status: "API_ERRO" });
    await channel.send(`❌ API do jogo respondeu erro: \`${safeJson(result)}\``).catch(() => {});
  } catch (e) {
    console.log("❌ [GAME] erro:", e?.response?.data || e?.message || e);
    await sendPurchaseLog({ ...baseLog, status: "API_OFFLINE" });
    await channel.send("❌ Não consegui enviar para o jogo (API offline/erro). Veja o console.").catch(() => {});
  }
}

// ===================== UI: PAINEL / PACKS =====================
function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle("🛒 Loja de Pontos")
    .setDescription("Clique no botão abaixo para abrir um ticket privado.\n\n✅ Depois, envie seu **nick** e escolha o pack.");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_ticket").setLabel("🧾 Abrir Ticket").setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

function buildPackRows() {
  const rows = [];
  let current = new ActionRowBuilder();

  for (const p of PACKS) {
    const btn = new ButtonBuilder()
      .setCustomId(`pack:${p.id}`)
      .setLabel(`${p.emoji} ${p.label} (${brl(p.price)})`)
      .setStyle(ButtonStyle.Secondary);

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
  console.log("✅ Painel criado. Coloque no .env para não duplicar:");
  console.log("PANEL_MESSAGE_ID=" + newMsg.id);
}

// ===================== SLASH /setnick =====================
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("setnick")
      .setDescription("Define/atualiza seu nick para entrega.")
      .addStringOption((opt) => opt.setName("nick").setDescription("Seu nick no jogo").setRequired(true))
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(CONFIG.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID), { body: commands });

  console.log("✅ Slash commands registrados: /setnick");
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

// ===================== TICKET: CREATE/CLOSE =====================
async function createTicketChannel({ guild, user }) {
  const now = Date.now();
  const last = STATE.ticketCooldown.get(user.id) || 0;

  if (now - last < CONFIG.TICKET_COOLDOWN_MS) {
    return {
      ok: false,
      reason: `Aguarde ${Math.ceil((CONFIG.TICKET_COOLDOWN_MS - (now - last)) / 1000)}s para abrir outro ticket.`,
    };
  }

  const cachedId = STATE.openTickets.get(user.id);
  if (cachedId) {
    const existing = await guild.channels.fetch(cachedId).catch(() => null);
    if (existing && existing.type === ChannelType.GuildText) {
      return { ok: false, reason: `Você já tem um ticket aberto: <#${existing.id}>` };
    }
    STATE.openTickets.delete(user.id);
  }

  const genKey = `GEN:${user.id}`;
  if (STATE.generatingTickets.has(genKey)) {
    return { ok: false, reason: "Estou criando seu ticket… aguarde 1 instante e tente de novo." };
  }
  STATE.generatingTickets.add(genKey);

  try {
    const category = await guild.channels.fetch(CONFIG.TICKET_CATEGORY_ID).catch(() => null);
    if (!category) return { ok: false, reason: "Categoria de tickets inválida. Verifique TICKET_CATEGORY_ID." };

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
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }

    const channel = await guild.channels.create({
      name: safeChannelNameFromUser(user),
      type: ChannelType.GuildText,
      parent: category.id,
      topic: buildTopic({ buyer: user.id, nick: "", pack: "", orderId: "", waitingPay: "" }),
      permissionOverwrites: overwrites,
      reason: `Ticket aberto por ${user.tag} (${user.id})`,
    });

    STATE.openTickets.set(user.id, channel.id);
    STATE.ticketCooldown.set(user.id, now);

    resetTicketInactivityTimer(channel);

    await channel.send({
      content:
        `👋 Olá, <@${user.id}>!\n\n` +
        `1) Envie seu **nick** (a primeira mensagem salva automaticamente)\n` +
        `2) Depois escolha um **pack**\n\n` +
        `🧪 MODO TESTE (sem Mercado Pago)`,
      components: buildPackRows(),
    });

    return { ok: true, channelId: channel.id };
  } catch (e) {
    console.log("❌ createTicketChannel erro:", e?.message || e);
    return { ok: false, reason: "Não consegui criar o ticket (erro interno). Veja o console." };
  } finally {
    STATE.generatingTickets.delete(genKey);
  }
}

async function closeTicketChannel({ channel, reasonText = "Ticket fechado." }) {
  if (!channel || !isTicketChannel(channel)) return;
  await channel.send(`🔒 ${reasonText}`).catch(() => {});
  cleanupChannelState(channel.id);
  setTimeout(() => channel.delete().catch(() => {}), CONFIG.TICKET_DELETE_DELAY_MS);
}

// ===================== SAFE RESPONDER (FLAGS) =====================
function createSafeResponder(interaction) {
  let ackAttempted = false;

  async function ensureDeferReply() {
    if (ackAttempted) return;
    ackAttempted = true;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch {
      // não trava
    }
  }

  async function respond(content, options = {}) {
    const payload = {
      content: String(content ?? ""),
      flags: MessageFlags.Ephemeral,
      ...options,
    };

    try {
      if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    } catch {}

    try {
      return await interaction.reply(payload);
    } catch {}

    try {
      return await interaction.followUp(payload);
    } catch {}

    return null;
  }

  return { ensureDeferReply, respond };
}

// ===================== HANDLERS =====================
async function handleButton(interaction) {
  const { ensureDeferReply, respond } = createSafeResponder(interaction);
  await ensureDeferReply();

  try {
    const customId = interaction.customId;
    console.log("[BTN]", customId, "by", interaction.user.id, "in", interaction.channelId);

    const guild = interaction.guild;
    if (!guild) return respond("❌ Isso só funciona dentro do servidor.");

    if (customId === "open_ticket") {
      const result = await createTicketChannel({ guild, user: interaction.user });
      if (!result.ok) return respond(`⚠️ ${result.reason}`);
      return respond(`✅ Ticket criado! Vá para: <#${result.channelId}>`);
    }

    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return respond("❌ Canal inválido.");
    if (!isTicketChannel(channel)) return respond("⚠️ Este botão só funciona dentro de um ticket válido.");

    resetTicketInactivityTimer(channel);

    const topicObj = parseTopic(channel.topic || "");
    const buyerId = topicObj.buyer;
    const isBuyer = buyerId && interaction.user.id === buyerId;

    if (customId === "close_ticket") {
      if (!isBuyer) return respond("⚠️ Só quem abriu o ticket pode fechar.");
      await respond("🔒 Fechando em 3s...");
      await closeTicketChannel({ channel, reasonText: "Ticket fechado pelo cliente." });
      return;
    }

    if (customId.startsWith("pack:")) {
      if (!isBuyer) return respond("⚠️ Só quem abriu o ticket pode escolher o pack.");

      const packId = customId.split(":")[1];
      const pack = PACKS.find((p) => p.id === packId);
      if (!pack) return respond("❌ Pack inválido.");

      const nick = (topicObj.nick || "").trim();
      if (!nick) return respond("❌ Envie seu nick primeiro (mensagem no ticket) ou use /setnick.");

      const orderId = makeOrderId(interaction.user.id);

      STATE.pendingOrders.set(String(orderId), {
        packId: pack.id,
        nick,
        buyerId: interaction.user.id,
        channelId: channel.id,
        orderId,
        amount: pack.price,
      });

      topicObj.pack = pack.id;
      topicObj.orderId = orderId;
      topicObj.waitingPay = "test";
      await channel.setTopic(buildTopic(topicObj)).catch(() => {});

      const rowTest = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`test_paid_order_${orderId}`)
          .setLabel("✅ TESTAR ENTREGA (SIMULAR PAGO)")
          .setStyle(ButtonStyle.Success)
      );

      await channel.send({
        content:
          `🧪 **MODO TESTE**\n` +
          `📦 Pack: **${pack.label} (${brl(pack.price)})**\n` +
          `🎮 Nick: **${nick}**\n` +
          `🧾 OrderId: **${orderId}**\n\n` +
          `➡️ Um ADMIN pode clicar no botão abaixo para simular pago e entregar.`,
        components: [rowTest],
      });

      return respond("✅ Pack selecionado! Botão de teste enviado no ticket.");
    }

    if (customId.startsWith("test_paid_order_")) {
      const orderId = customId.replace("test_paid_order_", "").trim();

      if (!CONFIG.ADMINS.has(interaction.user.id)) {
        return respond("⛔ Sem permissão para testar pagamento (apenas ADMINS).");
      }

      const data = STATE.pendingOrders.get(String(orderId));
      if (!data) return respond("⚠️ Pedido não encontrado. Selecione o pack novamente.");

      await respond("✅ Simulando pagamento aprovado (TESTE) e iniciando entrega...");

      // anti clique duplo
      STATE.pendingOrders.delete(String(orderId));

      await processApprovedPayment({
        paymentId: orderId,
        packId: data.packId,
        nick: data.nick,
        buyerId: data.buyerId,
        amount: data.amount,
        channelId: data.channelId,
        orderId: data.orderId,
        isTest: true,
      });

      return;
    }

    return respond("⚠️ Botão desconhecido/antigo. Abra um ticket novo no painel.");
  } catch (err) {
    console.error("❌ handleButton crash:", err);
    return respond("❌ Erro interno ao processar o botão. Veja o console.");
  }
}

async function handleCommand(interaction) {
  const { ensureDeferReply, respond } = createSafeResponder(interaction);
  await ensureDeferReply();

  try {
    if (interaction.commandName !== "setnick") return respond("⚠️ Comando desconhecido.");

    const nick = interaction.options.getString("nick", true).trim();
    if (!nick || nick.length < 2) return respond("❌ Nick inválido.");

    stmtUpsertNick.run({ discord_id: interaction.user.id, nick, updated_at: Date.now() });

    const channel = interaction.channel;
    if (channel && isTicketChannel(channel)) {
      const topicObj = parseTopic(channel.topic || "");
      if (topicObj.buyer && topicObj.buyer !== interaction.user.id) {
        return respond("⚠️ Apenas quem abriu o ticket pode alterar o nick deste ticket.");
      }
      topicObj.nick = nick;
      await channel.setTopic(buildTopic(topicObj)).catch(() => {});
      resetTicketInactivityTimer(channel);
    }

    return respond(`✅ Nick atualizado para **${nick}**.`);
  } catch (err) {
    console.error("❌ handleCommand crash:", err);
    return respond("❌ Erro interno ao executar o comando. Veja o console.");
  }
}

// ===================== READY =====================
client.once("ready", async () => {
  console.log(`✅ Bot online como: ${client.user.tag}`);

  try {
    await registerSlashCommands();
  } catch (e) {
    console.log("⚠️ Falha ao registrar slash commands. Verifique CLIENT_ID no .env:", e?.message || e);
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

// ===================== NICK AUTOMÁTICO (primeira msg do buyer) =====================
client.on("messageCreate", async (msg) => {
  try {
    if (!msg || !msg.guild) return;
    if (msg.author?.bot) return;

    const channel = msg.channel;
    if (!isTicketChannel(channel)) return;

    resetTicketInactivityTimer(channel);

    const topicObj = parseTopic(channel.topic || "");
    const buyerId = topicObj.buyer;
    if (!buyerId) return;

    // só buyer
    if (msg.author.id !== buyerId) return;

    // se já tem nick, não sobrescreve
    if ((topicObj.nick || "").trim()) return;

    const nick = msg.content.trim();
    if (!nick || nick.length < 2) return;

    stmtUpsertNick.run({ discord_id: msg.author.id, nick, updated_at: Date.now() });

    topicObj.nick = nick;
    await channel.setTopic(buildTopic(topicObj)).catch(() => {});

    await channel.send(`✅ Nick salvo: **${nick}**\nAgora escolha um pack nos botões acima.`).catch(() => {});
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
    console.error("❌ interactionCreate crash (top-level):", e);
    try {
      const { ensureDeferReply, respond } = createSafeResponder(interaction);
      await ensureDeferReply();
      await respond("❌ Erro interno inesperado. Veja o console.");
    } catch {}
  }
});

// ===================== START =====================
client.login(CONFIG.DISCORD_TOKEN);
