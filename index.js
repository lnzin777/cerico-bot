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

// ================= CONFIG =================
const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,
  PANEL_CHANNEL_ID: process.env.PANEL_CHANNEL_ID,
  TICKET_CATEGORY_ID: process.env.TICKET_CATEGORY_ID,
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID,
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN,
  MP_NOTIFICATION_URL: process.env.MP_NOTIFICATION_URL,
  API_URL: process.env.API_URL,
  API_TOKEN: process.env.API_TOKEN,
};

const COIN_BASE_BRL = 1.00;

// ================= PACKS =================
const PACKS = [
  { id: "c5", coins: 5, discount: 0.00, emoji: "🟢" },
  { id: "c10", coins: 10, discount: 0.005, emoji: "🟡" },
  { id: "c25", coins: 25, discount: 0.01, emoji: "🟠" },
  { id: "c50", coins: 50, discount: 0.015, emoji: "🔴" },
  { id: "c100", coins: 100, discount: 0.025, emoji: "🔷" },
  { id: "c500", coins: 500, discount: 0.05, emoji: "👑" },
];

function roundUp50(value) {
  return Math.ceil(value * 2) / 2;
}

function calculatePrice(pack) {
  const base = pack.coins * COIN_BASE_BRL;
  const discounted = base * (1 - pack.discount);
  return roundUp50(discounted);
}

function brl(v) {
  return `R$ ${v.toFixed(2).replace(".", ",")}`;
}

// ================= DISCORD =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// ================= DATABASE =================
const db = new Database("./loja.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS purchases (
  order_id TEXT PRIMARY KEY,
  buyer_id TEXT,
  channel_id TEXT,
  pack_id TEXT,
  amount REAL,
  status TEXT,
  created_at INTEGER
);
`);

const insertPurchase = db.prepare(`
INSERT INTO purchases (order_id, buyer_id, channel_id, pack_id, amount, status, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const updateStatus = db.prepare(`
UPDATE purchases SET status=? WHERE order_id=?
`);

const getPurchase = db.prepare(`
SELECT * FROM purchases WHERE order_id=?
`);

// ================= PANEL =================
function buildPanel() {
  const embed = new EmbedBuilder()
    .setColor("#FFD700")
    .setTitle("🪙 Loja Oficial de Coins")
    .setDescription(
      "Adquira suas **Coins** com segurança.\n\n" +
      "📌 1 Coin = R$ 1,00\n" +
      "💳 Pagamento via Mercado Pago\n" +
      "⚡ Entrega automática\n\n" +
      "Clique abaixo para abrir um ticket."
    )
    .setFooter({ text: "Sistema automático • Seguro • Profissional" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("open_ticket")
      .setLabel("Abrir Ticket")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🎟️")
  );

  return { embeds: [embed], components: [row] };
}

function buildPackButtons() {
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
    );

    if (row.components.length === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
  }

  if (row.components.length) rows.push(row);

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("Fechar Ticket")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("🔒")
    )
  );

  return rows;
}

// ================= TICKET =================
async function createTicket(guild, user) {
  const channel = await guild.channels.create({
    name: `ticket-${user.username}`,
    type: ChannelType.GuildText,
    parent: CONFIG.TICKET_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ],
  });

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#00FF99")
        .setTitle("🪙 Compra de Coins")
        .setDescription(
          "Escolha abaixo o pacote desejado.\n\n" +
          "✔ Pagamento seguro\n" +
          "✔ Entrega automática\n" +
          "✔ Sistema protegido contra duplicação"
        )
    ],
    components: buildPackButtons(),
  });

  return channel;
}

// ================= MERCADO PAGO =================
async function createPreference(pack, userId, channelId) {
  const price = calculatePrice(pack);
  const orderId = `ORD-${userId}-${Date.now()}`;

  insertPurchase.run(orderId, userId, channelId, pack.id, price, "PENDING", Date.now());

  const body = {
    items: [{
      title: `${pack.coins} Coins`,
      quantity: 1,
      currency_id: "BRL",
      unit_price: price
    }],
    external_reference: orderId,
    notification_url: CONFIG.MP_NOTIFICATION_URL
  };

  const res = await axios.post(
    "https://api.mercadopago.com/checkout/preferences",
    body,
    { headers: { Authorization: `Bearer ${CONFIG.MP_ACCESS_TOKEN}` } }
  );

  return { link: res.data.init_point, orderId };
}

// ================= WEBHOOK =================
function startWebhook() {
  const app = express();
  app.use(express.json());

  app.post("/mp/webhook", async (req, res) => {
    res.sendStatus(200);

    const paymentId = req.body?.data?.id;
    if (!paymentId) return;

    const payment = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${CONFIG.MP_ACCESS_TOKEN}` } }
    );

    if (payment.data.status !== "approved") return;

    const orderId = payment.data.external_reference;
    const purchase = getPurchase.get(orderId);
    if (!purchase || purchase.status === "DELIVERED") return;

    updateStatus.run("DELIVERED", orderId);

    const channel = await client.channels.fetch(purchase.channel_id).catch(() => null);
    if (channel) {
      await channel.send("✅ Pagamento aprovado! Entregando coins...");
      await axios.get(`${CONFIG.API_URL}?token=${CONFIG.API_TOKEN}&orderId=${orderId}`);
      await channel.send("🎉 Coins entregues com sucesso!");
      setTimeout(() => channel.delete().catch(() => {}), 8000);
    }
  });

  app.listen(process.env.PORT || 10000, () =>
    console.log("🌐 Webhook rodando")
  );
}

// ================= INTERACTIONS =================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === "open_ticket") {
    const channel = await createTicket(interaction.guild, interaction.user);
    return interaction.reply({ content: `Ticket criado: ${channel}`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId.startsWith("pack:")) {
    const packId = interaction.customId.split(":")[1];
    const pack = PACKS.find(p => p.id === packId);
    if (!pack) return;

    await interaction.reply({ content: "Gerando link de pagamento...", flags: MessageFlags.Ephemeral });

    const { link } = await createPreference(pack, interaction.user.id, interaction.channel.id);

    await interaction.channel.send(
      `💳 Link de pagamento:\n${link}\n\nApós pagar, a entrega será automática.`
    );
  }

  if (interaction.customId === "close_ticket") {
    await interaction.reply({ content: "🔒 Fechando ticket...", flags: MessageFlags.Ephemeral });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
  }
});

// ================= READY =================
client.once("ready", async () => {
  console.log("🤖 Bot online");

  const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
  const channel = await guild.channels.fetch(CONFIG.PANEL_CHANNEL_ID);

  await channel.send(buildPanel());

  const commands = [
    new SlashCommandBuilder().setName("ping").setDescription("Ping test").toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(CONFIG.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID), { body: commands });

  startWebhook();
});

client.login(CONFIG.DISCORD_TOKEN);
