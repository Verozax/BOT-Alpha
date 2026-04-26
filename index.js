require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const instanceLockPath = path.join(__dirname, "bot.instance.lock");
let instanceLockFd = null;

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function acquireInstanceLock() {
  try {
    instanceLockFd = fs.openSync(instanceLockPath, "wx");
    fs.writeFileSync(instanceLockPath, String(process.pid), "utf8");
    return;
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
  }

  let previousPid = NaN;
  try {
    previousPid = Number.parseInt(fs.readFileSync(instanceLockPath, "utf8"), 10);
  } catch {}

  if (!isProcessRunning(previousPid)) {
    try {
      fs.unlinkSync(instanceLockPath);
    } catch {}
    instanceLockFd = fs.openSync(instanceLockPath, "wx");
    fs.writeFileSync(instanceLockPath, String(process.pid), "utf8");
    return;
  }

  console.error(
    "❌ Wykryto już uruchomioną instancję bota. Zamknij inne procesy node i spróbuj ponownie."
  );
  process.exit(1);
}

function releaseInstanceLock() {
  try {
    if (instanceLockFd !== null) fs.closeSync(instanceLockFd);
  } catch {}
  try {
    fs.unlinkSync(instanceLockPath);
  } catch {}
}

acquireInstanceLock();
process.on("exit", releaseInstanceLock);
process.on("SIGINT", () => {
  releaseInstanceLock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  releaseInstanceLock();
  process.exit(0);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ====== KONFIG ======
const CONFIG = {
  token: process.env.TOKEN,
  guildId: process.env.GUILD_ID, // opcjonalne
  ticketCategoryId: process.env.TICKET_CATEGORY_ID,
  ticketLogChannelId: process.env.TICKET_LOG_CHANNEL_ID,
  staffRoleId: process.env.STAFF_ROLE_ID,
  panelChannelId: process.env.PANEL_CHANNEL_ID,
  panelTitle: "Stwóż ticket!✉️",
  panelDescription: "Kliknij przycisk poniżej, aby otworzyć ticket, pamietaj żeby opisać dokladnie powód, twożenie nie potrzebnie ticketów grozi zawieszeniem",
};

// ====== ANTY-DUPLIKAT TWORZENIA ======
const creatingTickets = new Set(); // userId in progress

// Prosta pamięć claimów w pliku
const claimsFile = path.join(__dirname, "ticketClaims.json");
let ticketClaims = {};
if (fs.existsSync(claimsFile)) {
  try {
    ticketClaims = JSON.parse(fs.readFileSync(claimsFile, "utf8"));
  } catch {
    ticketClaims = {};
  }
}
function saveClaims() {
  fs.writeFileSync(claimsFile, JSON.stringify(ticketClaims, null, 2), "utf8");
}

const openTicketsFile = path.join(__dirname, "openTickets.json");
let openTickets = {};
if (fs.existsSync(openTicketsFile)) {
  try {
    openTickets = JSON.parse(fs.readFileSync(openTicketsFile, "utf8"));
  } catch {
    openTickets = {};
  }
}
function saveOpenTickets() {
  fs.writeFileSync(openTicketsFile, JSON.stringify(openTickets, null, 2), "utf8");
}

// ====== LEVEL SYSTEM ======
const LEVEL_PREFIX = process.env.LEVEL_PREFIX || "!";
const levelsFile = path.join(__dirname, "levels.json");
let levels = {};
if (fs.existsSync(levelsFile)) {
  try {
    levels = JSON.parse(fs.readFileSync(levelsFile, "utf8"));
  } catch {
    levels = {};
  }
}
function saveLevels() {
  fs.writeFileSync(levelsFile, JSON.stringify(levels, null, 2), "utf8");
}
function getLevelKey(guildId, userId) {
  return `${guildId}_${userId}`;
}
function getRequiredXp(level) {
  return 100 + level * 50;
}
function getLevelData(guildId, userId) {
  const key = getLevelKey(guildId, userId);
  if (!levels[key]) {
    levels[key] = { xp: 0, level: 0, totalXp: 0 };
  }
  return levels[key];
}
const xpCooldown = new Map();
const VC_XP_INTERVAL_MS = 60 * 1000;
const TEXT_XP_COOLDOWN_MS = 60 * 1000;
const TEXT_MIN_LENGTH_FOR_XP = 3;
const VC_MIN_HUMANS_IN_CHANNEL = 2;
const LEVEL_ROLE_SHOP = [
  { costLevel: 10, roleId: "1497920118267711550" },
  { costLevel: 20, roleId: "1497920168628719726" },
  { costLevel: 45, roleId: "1497920704618827987" },
].sort((a, b) => a.costLevel - b.costLevel);

function addXp(guildId, userId, xpAmount) {
  const userData = getLevelData(guildId, userId);
  userData.xp += xpAmount;
  userData.totalXp += xpAmount;

  let leveledUp = false;
  while (userData.xp >= getRequiredXp(userData.level)) {
    userData.xp -= getRequiredXp(userData.level);
    userData.level += 1;
    leveledUp = true;
  }

  return { userData, leveledUp };
}

function getGuildLeaderboard(guildId) {
  const guildPrefix = `${guildId}_`;
  return Object.entries(levels)
    .filter(([entryKey]) => entryKey.startsWith(guildPrefix))
    .sort(([, a], [, b]) => b.totalXp - a.totalXp);
}

function getUserRankPosition(guildId, userId) {
  const board = getGuildLeaderboard(guildId);
  const targetKey = getLevelKey(guildId, userId);
  const index = board.findIndex(([entryKey]) => entryKey === targetKey);
  return index === -1 ? null : index + 1;
}

function canGetTextXp(message) {
  if (!message.guild || message.author.bot) return false;
  const trimmed = (message.content || "").trim();
  if (!trimmed && message.attachments.size === 0) return false;
  if (trimmed.startsWith(LEVEL_PREFIX)) return false; // komendy nie dają XP
  return trimmed.length >= TEXT_MIN_LENGTH_FOR_XP || message.attachments.size > 0;
}

function canGetVoiceXp(member, channel, guild) {
  if (!member || member.user.bot) return false;
  if (guild.afkChannelId && channel.id === guild.afkChannelId) return false;
  const voiceState = member.voice;
  if (!voiceState) return false;
  if (
    voiceState.selfDeaf ||
    voiceState.serverDeaf ||
    voiceState.selfMute ||
    voiceState.serverMute
  ) {
    return false;
  }

  const nonBotMembers = channel.members.filter((m) => !m.user.bot).size;
  return nonBotMembers >= VC_MIN_HUMANS_IN_CHANNEL;
}

function resolveRoleIdFromInput(rawValue) {
  if (!rawValue) return null;
  const mentionMatch = rawValue.match(/^<@&(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  const idMatch = rawValue.match(/^\d+$/);
  if (idMatch) return rawValue;
  return null;
}

async function sendRoleShop(message) {
  if (!LEVEL_ROLE_SHOP.length) {
    await message.reply("Sklep ról jest pusty.");
    return;
  }

  const lines = LEVEL_ROLE_SHOP.map((item, index) => {
    const role = message.guild.roles.cache.get(item.roleId);
    const roleDisplay = role ? `${role}` : `Rola (${item.roleId})`;
    return `${index + 1}. ${roleDisplay} - koszt: **${item.costLevel} lvl**`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("Sklep ról (za levele)")
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Kupno: ${LEVEL_PREFIX}kup @rola` })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

async function sendTopLevels(message) {
  const sorted = getGuildLeaderboard(message.guild.id).slice(0, 10);

  if (!sorted.length) {
    await message.reply("Brak danych leveli na tym serwerze.");
    return;
  }

  const lines = sorted.map(([entryKey, value], index) => {
    const userId = entryKey.replace(guildPrefix, "");
    const member = message.guild.members.cache.get(userId);
    const username = member?.user?.tag || `Użytkownik (${userId})`;
    return `${index + 1}. **${username}** - lvl ${value.level} (${value.totalXp} XP)`;
  });

  const topEmbed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("Top 10 leveli")
    .setDescription(lines.join("\n"))
    .setTimestamp();

  await message.reply({ embeds: [topEmbed] });
}

// ====== HELPERY ======
function sanitizeName(str) {
  return str.toLowerCase().replace(/[^a-z0-9\-]/g, "").slice(0, 20) || "user";
}

function createTicketButtons(claimedById = null) {
  const claimLabel = claimedById ? "Przyjęty" : "Przyjmij ticket";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_claim")
      .setLabel(claimLabel)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(Boolean(claimedById)),
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Zamknij ticket")
      .setStyle(ButtonStyle.Danger)
  );
}

async function sendLog(guild, embed, filePath = null) {
  try {
    if (!CONFIG.ticketLogChannelId) return;
    const logChannel = guild.channels.cache.get(CONFIG.ticketLogChannelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    if (filePath && fs.existsSync(filePath)) {
      await logChannel.send({
        embeds: [embed],
        files: [filePath],
      });
      fs.unlinkSync(filePath);
    } else {
      await logChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Błąd wysyłania loga:", err);
  }
}

async function createTranscript(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  const lines = sorted.map((m) => {
    const time = new Date(m.createdTimestamp).toLocaleString("pl-PL");
    const author = `${m.author?.tag || "Unknown"} (${m.author?.id || "?"})`;
    const content = (m.content || "")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<p><strong>[${time}] ${author}:</strong> ${content}</p>`;
  });

  const html = `<!doctype html>
<html lang="pl">
<head>
<meta charset="UTF-8" />
<title>Transcript ${channel.name}</title>
<style>
body{font-family:Arial,sans-serif;background:#111;color:#eee;padding:20px}
p{background:#1e1e1e;padding:8px 10px;border-radius:8px;margin:6px 0}
strong{color:#7aa2ff}
</style>
</head>
<body>
<h2>Transcript kanału: #${channel.name}</h2>
${lines.join("\n")}
</body>
</html>`;

  const transcriptDir = path.join(__dirname, "transcripts");
  if (!fs.existsSync(transcriptDir)) fs.mkdirSync(transcriptDir);

  const filePath = path.join(transcriptDir, `${channel.id}.html`);
  fs.writeFileSync(filePath, html, "utf8");
  return filePath;
}

// ====== READY ======
client.once("ready", async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);

  if (CONFIG.panelChannelId) {
    const guild =
      client.guilds.cache.get(CONFIG.guildId) || client.guilds.cache.first();
    if (!guild) return;

    const panelChannel = guild.channels.cache.get(CONFIG.panelChannelId);
    if (panelChannel && panelChannel.isTextBased()) {
      const panelEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(CONFIG.panelTitle)
        .setDescription(CONFIG.panelDescription)
        .setFooter({ text: "Ticket System" });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket_create")
          .setLabel("Utwórz ticket✅")
          .setStyle(ButtonStyle.Success)
      );

      const recent = await panelChannel.messages.fetch({ limit: 20 });
      const existing = recent.find(
        (m) =>
          m.author.id === client.user.id &&
          m.components?.length &&
          m.components[0]?.components?.some((c) => c.customId === "ticket_create")
      );

      if (!existing) {
        await panelChannel.send({
          embeds: [panelEmbed],
          components: [row],
        });
        console.log("🟢 Panel ticketów został wysłany.");
      } else {
        console.log("ℹ️ Panel już istnieje, pomijam.");
      }
    }
  }

  // XP za siedzenie na VC
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      let changed = false;
      for (const channel of guild.channels.cache.values()) {
        if (
          channel.type !== ChannelType.GuildVoice &&
          channel.type !== ChannelType.GuildStageVoice
        ) {
          continue;
        }
        if (!channel.members || !channel.members.size) continue;

        for (const [memberId, member] of channel.members) {
          if (!canGetVoiceXp(member, channel, guild)) continue;
          const xpGain = Math.floor(Math.random() * 5) + 8; // 8-12 XP/min na VC
          addXp(guild.id, memberId, xpGain);
          changed = true;
        }
      }
      if (changed) saveLevels();
    }
  }, VC_XP_INTERVAL_MS);
});

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  if (canGetTextXp(message)) {
    const key = getLevelKey(message.guild.id, message.author.id);
    const now = Date.now();
    const cooldownUntil = xpCooldown.get(key) || 0;
    if (now >= cooldownUntil) {
      const xpGain = Math.floor(Math.random() * 11) + 15; // 15-25 XP
      const { userData, leveledUp } = addXp(
        message.guild.id,
        message.author.id,
        xpGain
      );

      if (leveledUp) {
        await message.channel.send(
          `🎉 ${message.author}, wbiłeś **${userData.level} poziom**!`
        );
      }

      xpCooldown.set(key, now + TEXT_XP_COOLDOWN_MS);
      saveLevels();
    }
  }

  if (!message.content.startsWith(LEVEL_PREFIX)) return;

  const args = message.content.slice(LEVEL_PREFIX.length).trim().split(/\s+/);
  const command = (args.shift() || "").toLowerCase();

  if (command === "lvl" || command === "rank") {
    if ((args[0] || "").toLowerCase() === "top") {
      await sendTopLevels(message);
      return;
    }

    const targetUser = message.mentions.users.first() || message.author;
    const targetData = getLevelData(message.guild.id, targetUser.id);
    const neededXp = getRequiredXp(targetData.level);
    const rankPosition = getUserRankPosition(message.guild.id, targetUser.id);

    const rankEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Statystyki poziomu")
      .setDescription(`${targetUser}`)
      .addFields(
        { name: "Poziom", value: `${targetData.level}`, inline: true },
        { name: "XP", value: `${targetData.xp}/${neededXp}`, inline: true },
        { name: "Łączne XP", value: `${targetData.totalXp}`, inline: true },
        {
          name: "Pozycja w rankingu",
          value: rankPosition ? `#${rankPosition}` : "Poza rankingiem",
          inline: true,
        }
      )
      .setTimestamp();

    await message.reply({ embeds: [rankEmbed] });
    return;
  }

  if (command === "top") {
    await sendTopLevels(message);
    return;
  }

  if (command === "sklep") {
    await sendRoleShop(message);
    return;
  }

  if (command === "kup") {
    const roleInput = args[0];
    const roleId = resolveRoleIdFromInput(roleInput);
    if (!roleId) {
      await message.reply(`Użycie: \`${LEVEL_PREFIX}kup @rola\``);
      return;
    }

    const shopItem = LEVEL_ROLE_SHOP.find((item) => item.roleId === roleId);
    if (!shopItem) {
      await message.reply("Tej roli nie ma w sklepie.");
      return;
    }

    const role = message.guild.roles.cache.get(shopItem.roleId);
    if (!role) {
      await message.reply("Nie znaleziono tej roli na serwerze.");
      return;
    }

    const member = message.member;
    if (!member) {
      await message.reply("Nie udało się pobrać Twojego profilu członka serwera.");
      return;
    }

    if (member.roles.cache.has(role.id)) {
      await message.reply("Masz już tę rolę.");
      return;
    }

    const userData = getLevelData(message.guild.id, message.author.id);
    if (userData.level < shopItem.costLevel) {
      await message.reply(
        `Masz za niski level. Potrzebujesz **${shopItem.costLevel} lvl**, a masz **${userData.level} lvl**.`
      );
      return;
    }

    userData.level -= shopItem.costLevel;
    const maxXpForCurrentLevel = getRequiredXp(userData.level) - 1;
    userData.xp = Math.max(0, Math.min(userData.xp, maxXpForCurrentLevel));
    saveLevels();

    try {
      await member.roles.add(role.id, `Zakup roli za ${shopItem.costLevel} lvl`);
      await message.reply(
        `✅ Kupiłeś rolę ${role} za **${shopItem.costLevel} lvl**. Twój nowy poziom: **${userData.level}**.`
      );
    } catch (err) {
      userData.level += shopItem.costLevel;
      saveLevels();
      console.error("Błąd przy nadawaniu roli ze sklepu:", err);
      await message.reply(
        "Nie udało się nadać roli. Sprawdź, czy bot ma uprawnienie `Manage Roles` i wyższą pozycję roli."
      );
    }
  }
});

// ====== INTERACTION HANDLER ======
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton() && interaction.customId === "ticket_create") {
    const modal = new ModalBuilder()
      .setCustomId("ticket_create_modal")
      .setTitle("Utwórz ticket");

    const reasonInput = new TextInputBuilder()
      .setCustomId("ticket_reason")
      .setLabel("Powód zgłoszenia")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMinLength(5)
      .setMaxLength(800)
      .setPlaceholder("Napisz dokładnie, z czym potrzebujesz pomocy.");

    modal.addComponents(
      new ActionRowBuilder().addComponents(reasonInput)
    );

    await interaction.showModal(modal);
    return;
  }

  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  const { guild, member, user, customId } = interaction;
  if (!guild) return;

  // 1) TWORZENIE TICKETA
  if (customId === "ticket_create_modal") {
    const ticketReason = interaction.fields.getTextInputValue("ticket_reason");

    // Blokada wielokrotnego kliknięcia / kilku eventów naraz
    if (creatingTickets.has(user.id)) {
      return interaction.reply({
        content: "Tworzenie ticketa już trwa, poczekaj chwilę...",
        ephemeral: true,
      });
    }

    creatingTickets.add(user.id);

    try {
      await guild.channels.fetch();

      const mappedChannelId = openTickets[user.id];
      if (mappedChannelId) {
        const mappedChannel = guild.channels.cache.get(mappedChannelId);
        if (mappedChannel) {
          return interaction.reply({
            content: `Masz już otwarty ticket: ${mappedChannel}`,
            ephemeral: true,
          });
        }
        delete openTickets[user.id];
        saveOpenTickets();
      }

      // Szukamy ticketa po topic (najpewniej) i po nazwie (fallback).
      // Gdy nie ma ustawionej kategorii, sprawdzamy wszystkie kanały tekstowe.
      const existing = guild.channels.cache.find((c) => {
        if (c.type !== ChannelType.GuildText) return false;
        if (CONFIG.ticketCategoryId && c.parentId !== CONFIG.ticketCategoryId) {
          return false;
        }
        return (
          c.topic === `ticketOwner:${user.id}` ||
          c.name === `ticket-${sanitizeName(user.username)}`
        );
      });

      if (existing) {
        openTickets[user.id] = existing.id;
        saveOpenTickets();
        return interaction.reply({
          content: `Masz już otwarty ticket: ${existing}`,
          ephemeral: true,
        });
      }

      const channelName = `ticket-${sanitizeName(user.username)}`;
      const staffRole = CONFIG.staffRoleId;

      const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: CONFIG.ticketCategoryId || null,
        topic: `ticketOwner:${user.id}`, // ważne: unikalna identyfikacja właściciela
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory,
            ],
          },
          ...(staffRole
            ? [
                {
                  id: staffRole,
                  allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory,
                    PermissionsBitField.Flags.ManageMessages,
                  ],
                },
              ]
            : []),
        ],
      });

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("Nowy ticket")
        .setDescription(
          `Witaj ${user}.\n\n**Powód:**\n${ticketReason}\n\nStaff może przyjąć ticket przyciskiem poniżej.`
        )
        .addFields(
          { name: "Autor ticketu", value: `${user.tag} (${user.id})` },
          { name: "Powód", value: ticketReason.length > 1024 ? `${ticketReason.slice(0, 1021)}...` : ticketReason },
          { name: "Status", value: "🟡 Oczekuje na przyjęcie" }
        )
        .setTimestamp();

      await ticketChannel.send({
        content: `${user}${CONFIG.staffRoleId ? ` <@&${CONFIG.staffRoleId}>` : ""}`,
        embeds: [embed],
        components: [createTicketButtons()],
      });

      openTickets[user.id] = ticketChannel.id;
      saveOpenTickets();

      await interaction.reply({
        content: `✅ Ticket utworzony: ${ticketChannel}`,
        ephemeral: true,
      });

      const logEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("Ticket utworzony")
        .setDescription(`Ticket ${ticketChannel} został utworzony.`)
        .addFields({ name: "Użytkownik", value: `${user.tag} (${user.id})` })
        .setTimestamp();

      await sendLog(guild, logEmbed);
    } catch (err) {
      console.error("Błąd tworzenia ticketa:", err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Wystąpił błąd podczas tworzenia ticketa.",
          ephemeral: true,
        });
      }
    } finally {
      // krótki cooldown anty-dubel
      setTimeout(() => creatingTickets.delete(user.id), 3000);
    }
  }

  // 2) CLAIM TICKETA
  if (customId === "ticket_claim") {
    if (!CONFIG.staffRoleId || !member.roles.cache.has(CONFIG.staffRoleId)) {
      return interaction.reply({
        content: "Nie masz roli staff do przyjmowania ticketów.",
        ephemeral: true,
      });
    }

    const chId = interaction.channel.id;
    if (ticketClaims[chId]) {
      return interaction.reply({
        content: `Ticket już przyjęty przez <@${ticketClaims[chId]}>.`,
        ephemeral: true,
      });
    }

    ticketClaims[chId] = user.id;
    saveClaims();

    const claimedEmbed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle("Ticket przyjęty")
      .setDescription(`Ticket został przyjęty przez ${user}.`)
      .setTimestamp();

    await interaction.update({
      embeds: [claimedEmbed],
      components: [createTicketButtons(user.id)],
    });

    const logEmbed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle("Ticket przyjęty")
      .addFields(
        { name: "Kanał", value: `${interaction.channel}` },
        { name: "Staff", value: `${user.tag} (${user.id})` }
      )
      .setTimestamp();

    await sendLog(guild, logEmbed);
  }

  // 3) ZAMKNIĘCIE TICKETA
  if (customId === "ticket_close") {
    const ownerId = interaction.channel.topic?.startsWith("ticketOwner:")
      ? interaction.channel.topic.replace("ticketOwner:", "")
      : null;

    const isTicketOwner = ownerId === user.id;
    const isStaff = CONFIG.staffRoleId
      ? member.roles.cache.has(CONFIG.staffRoleId)
      : false;

    if (!isStaff && !isTicketOwner) {
      return interaction.reply({
        content: "Nie możesz zamknąć tego ticketa.",
        ephemeral: true,
      });
    }

    await interaction.reply({
      content: "⏳ Zamykam ticket za 3 sekundy...",
      ephemeral: false,
    });

    const transcriptPath = await createTranscript(interaction.channel);

    const logEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("Ticket zamknięty")
      .setDescription(`Kanał \`${interaction.channel.name}\` został zamknięty.`)
      .addFields({ name: "Zamknął", value: `${user.tag} (${user.id})` })
      .setTimestamp();

    await sendLog(guild, logEmbed, transcriptPath);

    if (ownerId && openTickets[ownerId] === interaction.channel.id) {
      delete openTickets[ownerId];
      saveOpenTickets();
    } else {
      for (const [ticketOwnerId, channelId] of Object.entries(openTickets)) {
        if (channelId === interaction.channel.id) {
          delete openTickets[ticketOwnerId];
          saveOpenTickets();
          break;
        }
      }
    }

    delete ticketClaims[interaction.channel.id];
    saveClaims();

    setTimeout(async () => {
      try {
        await interaction.channel.delete("Ticket closed");
      } catch (err) {
        console.error("Błąd usuwania kanału:", err);
      }
    }, 3000);
  }
});

// ====== ERROR HANDLERY ======
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

client.login(CONFIG.token);