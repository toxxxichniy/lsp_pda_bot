STALKERNET PDA -> Discord Bot (only one-way Global chat)
==========================================================

WHAT THIS BOT DOES
------------------
- Receives batches from the STALKERNET server every 30 seconds.
- Sends only PDA Global chat messages to one Discord text channel.
- Does NOT read Discord messages.
- Does NOT send messages back into DayZ.
- Does NOT receive or publish Group chat or Private chat.
- Blocks Discord mentions from PDA text (@everyone, roles, users do not ping anyone).
- Keeps processed message IDs to avoid duplicates during retries.

1. CREATE A NEW DISCORD BOT
---------------------------
1) Open Discord Developer Portal -> Applications -> New Application.
2) Open the Bot page and create/reset the bot token.
3) Copy the token only into DISCORD_TOKEN. Do not post it in chat or store it in the PBO.
4) Invite this NEW bot to your Discord server with the bot scope.
5) In the target text channel give the bot only:
   - View Channel
   - Send Messages
   - Read Message History (optional, only for Discord UI consistency)
6) Enable Developer Mode in Discord, right-click the target channel and copy its ID.

This bot does not read user messages, so it has no reverse sync and does not need Message Content intent.

2. DEPLOY ON RAILWAY
--------------------
1) Create a new GitHub repository for this folder. Do NOT replace the existing workshop-update bot repository.
2) Upload all files from this folder to the new repository.
3) Railway -> New Project -> Deploy from GitHub Repo -> select the new repository.
4) Add Railway Variables:
   DISCORD_TOKEN
   DISCORD_GUILD_ID=1453504952025747468
   PDA_CHANNEL_ID=1523642255045562500
   STALKERNET_BRIDGE_SECRET
   PDA_SERVER_LABEL=L.S.P. TEST
5) The bot validates that the channel belongs specifically to the configured Discord server.
6) Deploy. Railway assigns HTTPS domain, for example:
   https://your-new-pda-bot.up.railway.app
7) Open this URL with /health at the end. It must return:
   {"ok":true,...}

3. CONNECT DAYZ SERVER
----------------------
The STALKERNET server patch creates this server config after first start:
$profile:STALKERNET/DiscordBridge.json

Fill it like this:
{
  "Enabled": 1,
  "EndpointUrl": "https://YOUR-RAILWAY-DOMAIN/v1/pda/messages",
  "Secret": "THE_SAME_VALUE_AS_STALKERNET_BRIDGE_SECRET",
  "FlushIntervalSeconds": 30,
  "MaxMessagesPerBatch": 10,
  "ServerLabel": "L.S.P."
}

IMPORTANT
---------
- The bot's bridge secret must be identical to the server config Secret.
- Do not put a Discord token or the bridge secret into client PBOs.
- Keep HTTPS in EndpointUrl.
- The server queue retries automatically when the bot is offline. It removes a message only after the bot returns HTTP success.
