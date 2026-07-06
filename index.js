"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const {
  Client,
  Events,
  GatewayIntentBits,
} = require("discord.js");

const MAX_HTTP_BODY_BYTES = 96 * 1024;
const MAX_BATCH_MESSAGES = 25;
const MAX_MESSAGE_TEXT_LENGTH = 1500;
const MAX_SEEN_IDS = 5000;

function requireEnv(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

const CONFIG = {
  token: requireEnv("DISCORD_TOKEN"),
  guildId: requireEnv("DISCORD_GUILD_ID"),
  channelId: requireEnv("PDA_CHANNEL_ID"),
  sharedSecret: requireEnv("STALKERNET_BRIDGE_SECRET"),
  port: Number.parseInt(process.env.PORT || "3000", 10),
  dataDir: path.resolve(
    process.env.DATA_DIR || path.join(process.cwd(), "data")
  ),
};

if (!Number.isInteger(CONFIG.port) || CONFIG.port < 1 || CONFIG.port > 65535) {
  throw new Error("PORT must be a valid TCP port number.");
}

const seenIdsPath = path.join(CONFIG.dataDir, "seen_message_ids.json");
const seenIds = new Map();

let targetChannel = null;
let shuttingDown = false;

function log(message) {
  console.log(`[STALKERNET-DISCORD] ${new Date().toISOString()} ${message}`);
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function ensureDataDir() {
  await fs.mkdir(CONFIG.dataDir, { recursive: true });
}

function trimSeenIds() {
  const ordered = [...seenIds.entries()].sort((a, b) => a[1] - b[1]);
  const removeCount = Math.max(0, ordered.length - MAX_SEEN_IDS);

  for (let index = 0; index < removeCount; index += 1) {
    seenIds.delete(ordered[index][0]);
  }
}

async function loadSeenIds() {
  try {
    const parsed = JSON.parse(await fs.readFile(seenIdsPath, "utf8"));

    if (!Array.isArray(parsed?.ids)) {
      return;
    }

    for (const item of parsed.ids) {
      if (typeof item?.id === "string" && typeof item?.at === "number") {
        seenIds.set(item.id, item.at);
      }
    }

    trimSeenIds();
    log(`Loaded ${seenIds.size} processed PDA message IDs.`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      log(`Could not load processed message IDs: ${error.message}`);
    }
  }
}

async function saveSeenIds() {
  trimSeenIds();

  const ids = [...seenIds.entries()]
    .map(([id, at]) => ({ id, at }))
    .sort((a, b) => a.at - b.at);

  const tempPath = `${seenIdsPath}.tmp`;

  await fs.writeFile(
    tempPath,
    JSON.stringify({ ids }, null, 2),
    "utf8"
  );

  await fs.rename(tempPath, seenIdsPath);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      received += chunk.length;

      if (received > MAX_HTTP_BODY_BYTES) {
        reject(new Error("Request body exceeds the allowed size."));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", reject);
  });
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);

  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });

  response.end(payload);
}

function cleanText(value, maximumLength) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maximumLength);
}

function normalizeIncomingMessage(message) {
  const id = cleanText(message?.Id ?? message?.id, 160);
  const author = cleanText(message?.Author ?? message?.author, 80);
  const text = cleanText(
    message?.Text ?? message?.text,
    MAX_MESSAGE_TEXT_LENGTH
  );
  const timeLabel = cleanText(
    message?.TimeLabel ?? message?.timeLabel,
    32
  );

  if (!id || !author || !text) {
    return null;
  }

  return {
    id,
    author,
    text,
    timeLabel,
  };
}

function formatDiscordMessage(message) {
  const time = message.timeLabel || new Date().toISOString().slice(11, 16);

  return `☢️ STALKERNET • ${time}\n**${message.author}**\n> ${message.text}`;
}

async function ensureTargetChannel(client) {
  const channel = await client.channels.fetch(CONFIG.channelId);

  if (!channel || !channel.isTextBased() || typeof channel.send !== "function") {
    throw new Error("PDA_CHANNEL_ID is not a writable text channel.");
  }

  if (!channel.guildId || channel.guildId !== CONFIG.guildId) {
    throw new Error(
      `PDA_CHANNEL_ID does not belong to DISCORD_GUILD_ID. Expected ${CONFIG.guildId}, got ${channel.guildId || "DM/unknown"}.`
    );
  }

  targetChannel = channel;

  log(
    `Discord target channel connected: guild=${channel.guildId}, channel=${channel.id}`
  );
}

async function publishMessage(message) {
  if (seenIds.has(message.id)) {
    return { duplicate: true };
  }

  if (!targetChannel) {
    throw new Error("Discord target channel is not ready.");
  }

  await targetChannel.send({
    content: formatDiscordMessage(message),
    allowedMentions: {
      parse: [],
    },
  });

  seenIds.set(message.id, Date.now());
  await saveSeenIds();

  return { duplicate: false };
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

async function handlePdaBatch(request, response) {
  let rawBody;

  try {
    rawBody = await readRequestBody(request);
  } catch (error) {
    sendJson(response, 413, {
      ok: false,
      error: error.message,
    });
    return;
  }

  let payload;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    sendJson(response, 400, {
      ok: false,
      error: "Invalid JSON body.",
    });
    return;
  }

  const suppliedSecret = payload?.Secret ?? payload?.secret;

  if (!timingSafeEqualText(suppliedSecret, CONFIG.sharedSecret)) {
    sendJson(response, 401, {
      ok: false,
      error: "Unauthorized.",
    });
    return;
  }

  if (!targetChannel) {
    sendJson(response, 503, {
      ok: false,
      error: "Discord channel is not ready.",
    });
    return;
  }

  const rawMessages = payload?.Messages ?? payload?.messages;

  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    sendJson(response, 400, {
      ok: false,
      error: "Messages must be a non-empty array.",
    });
    return;
  }

  if (rawMessages.length > MAX_BATCH_MESSAGES) {
    sendJson(response, 400, {
      ok: false,
      error: `Batch limit is ${MAX_BATCH_MESSAGES}.`,
    });
    return;
  }

  const acceptedIds = [];
  let duplicateCount = 0;

  try {
    for (const rawMessage of rawMessages) {
      const message = normalizeIncomingMessage(rawMessage);

      if (!message) {
        throw new Error(
          "One or more PDA messages are missing id, author, or text."
        );
      }

      const result = await publishMessage(message);

      acceptedIds.push(message.id);

      if (result.duplicate) {
        duplicateCount += 1;
      }
    }
  } catch (error) {
    log(`PDA batch failed: ${error.message}`);

    sendJson(response, 502, {
      ok: false,
      error: "Discord publish failed. The server queue must retry this batch.",
    });

    return;
  }

  log(
    `Published PDA batch: ${acceptedIds.length} accepted, ${duplicateCount} duplicate.`
  );

  sendJson(response, 202, {
    ok: true,
    acceptedIds,
    duplicateCount,
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(
    request.url,
    `http://${request.headers.host || "localhost"}`
  );

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, targetChannel ? 200 : 503, {
      ok: Boolean(targetChannel),
      service: "stalkernet-pda-discord-bridge",
      discordReady: Boolean(targetChannel),
      guildId: CONFIG.guildId,
      channelId: CONFIG.channelId,
      seenMessageIds: seenIds.size,
    });

    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/pda/messages") {
    await handlePdaBatch(request, response);
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: "Not found.",
  });
});

client.once(Events.ClientReady, async (readyClient) => {
  try {
    await ensureTargetChannel(readyClient);

    server.listen(CONFIG.port, "0.0.0.0", () => {
      log(`HTTP bridge listening on port ${CONFIG.port}.`);
    });
  } catch (error) {
    console.error(
      `[STALKERNET-DISCORD] Startup failed: ${error.stack || error.message}`
    );

    process.exit(1);
  }
});

client.on(Events.Error, (error) => {
  console.error(
    `[STALKERNET-DISCORD] Discord client error: ${error.stack || error.message}`
  );
});

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log(`Received ${signal}; shutting down.`);

  await new Promise((resolve) => {
    server.close(resolve);
  });

  client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

(async () => {
  await ensureDataDir();
  await loadSeenIds();
  await client.login(CONFIG.token);
})().catch((error) => {
  console.error(
    `[STALKERNET-DISCORD] Fatal startup error: ${error.stack || error.message}`
  );

  process.exit(1);
});
