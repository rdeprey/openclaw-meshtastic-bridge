# OpenClaw Meshtastic Bridge 📡🐾

A Node.js bridge that connects [Meshtastic](https://meshtastic.org) LoRa radios to [OpenClaw](https://openclaw.ai) AI assistants. Send and receive messages over radio waves — no internet required.

## How It Works

```
📱 Phone (Meshtastic app)
  → 📡 LoRa radio waves (915 MHz)
  → 🖥️ Heltec V3 radio (USB serial)
  → 🌉 This bridge (Node.js)
  → 📝 Write to inbox file
  → 🔌 WebSocket → OpenClaw gateway (localhost)
  → 🐾 AI wakes, reads inbox, thinks, writes reply
  → 📄 /tmp/meshtastic-outbox.txt
  → 🌉 Bridge picks it up (2s poll)
  → 📡 LoRa radio waves
  → 📱 Phone buzzes
```

~5 seconds end-to-end. All localhost, no cloud.

## Setup

### Prerequisites

- Node.js ≥ 22
- A Meshtastic-compatible LoRa radio (e.g., [Heltec V3](https://heltec.org/project/wifi-lora-32-v3/)) connected via USB
- [OpenClaw](https://openclaw.ai) running locally

### Install

```bash
npm install
```

### Configure

Edit `bridge.ts` and set:
- `SERIAL_PORT` — your radio's serial port (e.g., `/dev/cu.usbserial-0001`)
- `DESTINATION_NODE` — the destination node number for DMs

### Run

```bash
OPENCLAW_TOKEN=<your-gateway-token> npx tsx bridge.ts
```

The gateway token is in `~/.openclaw/openclaw.json` under `gateway.auth.token`.

### Run as macOS Service

```bash
# Copy the plist (edit paths/token first)
cp com.meshtastic-bridge.plist ~/Library/LaunchAgents/

# Load
launchctl load ~/Library/LaunchAgents/com.meshtastic-bridge.plist

# Check status
launchctl list | grep meshtastic
```

## Features

- **Instant wake** — Uses OpenClaw's WebSocket API to wake the AI agent immediately on incoming radio messages
- **File-based outbox** — AI writes to `/tmp/meshtastic-outbox.txt`, bridge transmits over LoRa
- **JSONL inbox** — All incoming messages logged to `/tmp/meshtastic-inbox.jsonl`
- **HTTP API** — `POST /send`, `GET /inbox`, `GET /status` on port 7331
- **No internet required** — Everything runs on localhost + radio waves

## Blog Post

Read the full build story: [How I Gave My AI Assistant a Radio](https://rebeccamdeprey.com) *(coming soon)*

## Tech Stack

- [@meshtastic/core](https://github.com/meshtastic/js) + [@meshtastic/transport-node-serial](https://github.com/meshtastic/js)
- [OpenClaw](https://openclaw.ai) gateway WebSocket API
- Node.js + TypeScript
- [ws](https://github.com/websockets/ws) (WebSocket client)

## License

MIT
