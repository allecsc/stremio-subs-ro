const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");
const { globalMetrics } = require("./metrics");

const DEFAULT_BOT_TOKEN =
  "MTUzODMzNzQ5MzcyMjg2MTY0OA.GXAW6O.XBDI-V93Yp-rZBE0h-ZuTJHKNMqllnfBpdAWD0";
const DEFAULT_CLIENT_ID = "1538337493722355648";

function buildStatsEmbed(stats) {
  const t = stats.today;
  const totalSearches = t.searchRequests || 1;
  const exact = t.matchTiers.exact || 0;
  const highSync = t.matchTiers.highSync || 0;
  const syncPct = Math.round(((exact + highSync) / totalSearches) * 100);
  const upstreamStatus =
    t.upstreamErrors.quota429 === 0 && t.upstreamErrors.networkErrors === 0
      ? "🟢 All systems normal"
      : `⚠️ ${t.upstreamErrors.quota429} quota hits · ${t.upstreamErrors.networkErrors} retries`;

  return new EmbedBuilder()
    .setTitle("📊 Subs.ro Addon — Operational Stats")
    .setColor(0x4f46e5) // Indigo
    .addFields(
      {
        name: "👥 User Activity",
        value: [
          `• **Active Now (15m):** \`${stats.activeNow15m}\` users`,
          `• **Today's DAU:** \`${t.uniqueActiveUsers}\` unique users`,
          `• **Total Traffic:** \`${t.totalRequests.toLocaleString()}\` requests (\`${t.searchRequests}\` searches · \`${t.proxyRequests}\` streams)`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "⚡ Performance & Sync",
        value: [
          `• **Memory Bridge Hit Rate:** \`${t.cacheHitRate}%\``,
          `• **Scene Sync Accuracy:** \`${syncPct}%\` exact / high sync`,
          `• **Response Speed:** \`${t.avgSearchLatencyMs}ms\` search · \`${t.avgProxyLatencyMs}ms\` stream`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "📦 System & Upstream Health",
        value: [
          `• **Archives Extracted:** \`${t.archiveFormats.zip}\` ZIP · \`${t.archiveFormats.rar}\` RAR`,
          `• **Upstream Subs.ro API:** ${upstreamStatus}`,
        ].join("\n"),
        inline: false,
      },
    )
    .setFooter({
      text: `UTC ${new Date().toISOString().slice(11, 19)} • Subs.ro Addon v2.0`,
    })
    .setTimestamp();
}

async function registerSlashCommands(token, clientId) {
  try {
    const rest = new REST({ version: "10" }).setToken(token);
    const commands = [
      new SlashCommandBuilder()
        .setName("stats")
        .setDescription(
          "View live telemetry and active metrics for Subs.ro Addon",
        )
        .toJSON(),
    ];

    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(
      "[DISCORD BOT] Successfully registered global /stats slash command.",
    );
  } catch (error) {
    console.error(
      "[DISCORD BOT] Failed to register slash commands:",
      error.message,
    );
  }
}

function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN || DEFAULT_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID || DEFAULT_CLIENT_ID;

  if (!token) {
    console.log(
      "[DISCORD BOT] No bot token provided. Interactive bot disabled.",
    );
    return null;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once("clientReady", async () => {
    console.log(`[DISCORD BOT] Logged in as ${client.user.tag}!`);
    await registerSlashCommands(token, clientId);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "stats") {
      try {
        const liveStats = globalMetrics.getLiveStats();
        const embed = buildStatsEmbed(liveStats);
        await interaction.reply({ embeds: [embed] });
      } catch (err) {
        console.error("[DISCORD BOT] Error responding to /stats:", err.message);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "⚠️ Failed to fetch stats. Please check server logs.",
            ephemeral: true,
          });
        }
      }
    }
  });

  client.login(token).catch((err) => {
    console.error("[DISCORD BOT] Failed to log in:", err.message);
  });

  return client;
}

module.exports = {
  startDiscordBot,
  buildStatsEmbed,
};
