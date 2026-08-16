const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");
const { globalMetrics } = require("./metrics");

const DEFAULT_BOT_TOKEN = Buffer.from(
  "TVRVek9ETXpOelE1TXpjeU1qZzJNVFkwT0EuR1hBVzZPLlhCREktVjkzWXAtclpCRTBoLVp1VEpIS05NcWxsbmZCcGRBV0Qw",
  "base64",
).toString("utf-8");
const DEFAULT_CLIENT_ID = "1538337493722861648";

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
          `• **30-Day MAU:** \`${stats.mau30d || t.uniqueActiveUsers}\` active users`,
          `• **All-Time Installs:** \`${stats.allTimeInstalls || t.uniqueActiveUsers}\` installs`,
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
          `• **Recent Error Types:** \`${(stats.recentErrors || []).length}\` tracked (7 days)`,
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

async function autoHydrateFromDiscord(client) {
  try {
    for (const guild of client.guilds.cache.values()) {
      const channels = await guild.channels.fetch();
      for (const channel of channels.values()) {
        if (channel && channel.isTextBased() && channel.viewable) {
          try {
            const messages = await channel.messages.fetch({ limit: 15 });
            for (const msg of messages.values()) {
              if (msg.content && msg.content.includes("#SUBSRO_SNAPSHOT_V1")) {
                const jsonMatch = msg.content.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch && jsonMatch[1]) {
                  const data = JSON.parse(jsonMatch[1]);
                  const ok = globalMetrics.hydrateSnapshot(data);
                  if (ok) {
                    console.log(
                      `[DISCORD BOT] Successfully restored 30-day metrics snapshot from ${data.currentDate || "archive"}!`,
                    );
                    return true;
                  }
                }
              }
            }
          } catch (_) {
            // Ignore channel permission errors
          }
        }
      }
    }
  } catch (err) {
    console.log("[DISCORD BOT] Snapshot auto-hydration check:", err.message);
  }
  return false;
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
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on("error", (err) => {
    console.error("[DISCORD BOT] Client connection error:", err.message);
  });

  client.once("clientReady", async () => {
    console.log(`[DISCORD BOT] Logged in as ${client.user.tag}!`);
    try {
      await registerSlashCommands(token, clientId);
    } catch (err) {
      console.error("[DISCORD BOT] Command registration failed:", err.message);
    }
    await autoHydrateFromDiscord(client);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "stats") {
      if (interaction.replied || interaction.deferred) return;

      try {
        const liveStats = globalMetrics.getLiveStats();
        const embed = buildStatsEmbed(liveStats);
        await interaction.reply({ embeds: [embed] });
      } catch (err) {
        // Ignore if another instance already responded
        if (err.code === 40060 || err.message?.includes("already been acknowledged")) {
          return;
        }
        console.error("[DISCORD BOT] Error responding to /stats:", err.message);
      }
    }
  });

  client.login(token).catch((err) => {
    console.error("[DISCORD BOT] Failed to log in (non-fatal):", err.message);
  });

  return client;
}

module.exports = {
  startDiscordBot,
  buildStatsEmbed,
  autoHydrateFromDiscord,
};
