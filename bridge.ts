import { MeshDevice } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { WebSocket } from "ws";
import { randomUUID } from "crypto";

const SERIAL_PORT = process.env.SERIAL_PORT || "/dev/cu.usbserial-0001";
const OUTBOX_FILE = "/tmp/meshtastic-outbox.txt";
const INBOX_FILE = "/tmp/meshtastic-inbox.jsonl";
const DESTINATION_NODE = Number(process.env.DESTINATION_NODE || "0"); // Target node for DMs
const HTTP_PORT = 7331;

// OpenClaw gateway (localhost WebSocket RPC, no internet needed)
const GATEWAY_URL = "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_TOKEN || "";

const safeJson = (obj: any) =>
  JSON.stringify(obj, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value, 2);

// Node name cache from mesh
const nodeNames: Record<string, string> = {};
let meshDevice: MeshDevice | null = null;

// Wake Clyde via OpenClaw gateway WebSocket RPC (works without internet!)
async function wakeAgent(fromName: string, text: string) {
  if (!GATEWAY_TOKEN) {
    console.log("⚠️  No OPENCLAW_TOKEN set, skipping gateway wake");
    return;
  }
  try {
    const wakeText = `📡 LoRa message from ${fromName}: "${text}" — Reply by writing to /tmp/meshtastic-outbox.txt`;

    const ws = new WebSocket(GATEWAY_URL);
    let connected = false;

    const sendReq = (method: string, params: any) => {
      ws.send(JSON.stringify({
        type: "req",
        id: randomUUID(),
        method,
        params,
      }));
    };

    const connectParams = () => ({
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        version: "1.0",
        platform: "node",
        mode: "cli",
        instanceId: randomUUID(),
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
      auth: { token: GATEWAY_TOKEN },
    });

    ws.on("open", () => {
      // Wait for connect.challenge event before sending connect
      // If no challenge arrives within 2s, try connecting anyway
      setTimeout(() => {
        if (!connected) {
          console.log("⏳ No challenge received, sending connect anyway...");
          sendReq("connect", connectParams());
        }
      }, 2000);
    });

    ws.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle connect challenge — now send connect (nonce is for device crypto only, we skip it)
        if (msg.type === "event" && msg.event === "connect.challenge") {
          console.log("🔑 Got connect challenge, sending connect...");
          sendReq("connect", connectParams());
          return;
        }

        // Handle response to connect
        if (msg.type === "res" && !connected) {
          if (msg.ok !== false) {
            connected = true;
            console.log("🔗 Gateway connected, sending chat message...");
            // Send chat message to wake the agent
            const chatId = randomUUID();
            ws.send(JSON.stringify({
              type: "req",
              id: chatId,
              method: "chat.send",
              params: {
                sessionKey: "main",
                message: wakeText,
                idempotencyKey: randomUUID(),
              },
            }));
            // Listen for the response
            ws.on("message", (data: any) => {
              try {
                const msg = JSON.parse(data.toString());
                if (msg.type === "res" && msg.id === chatId) {
                  if (msg.ok !== false) {
                    console.log("✅ chat.send succeeded:", safeJson(msg.payload));
                  } else {
                    console.error("❌ chat.send failed:", safeJson(msg.error));
                  }
                }
              } catch {}
            });
            setTimeout(() => ws.close(), 5000);
          } else {
            console.error("Gateway connect failed:", safeJson(msg));
            ws.close();
          }
        }
      } catch {}
    });

    ws.on("error", (e: any) => {
      console.error("Gateway WS error:", e.message);
    });

    ws.on("close", () => {
      if (connected) console.log("🐾 Woke agent via gateway!");
    });

    // Safety timeout
    setTimeout(() => { try { ws.close(); } catch {} }, 10000);
  } catch (e) {
    console.error("Gateway wake failed:", e);
  }
}

async function main() {
  console.log(`🐾 Meshtastic Bridge`);
  console.log(`📡 Connecting to ${SERIAL_PORT}...`);
  if (GATEWAY_TOKEN) {
    console.log(`🔑 Gateway token loaded — will wake agent on incoming messages`);
  } else {
    console.log(`⚠️  No OPENCLAW_TOKEN — gateway wake disabled (set env var to enable)`);
  }

  const transport = await TransportNodeSerial.create(SERIAL_PORT, 115200);
  console.log("✅ Serial transport connected!");

  const device = new MeshDevice(transport);
  meshDevice = device;

  device.events.onDeviceStatus.subscribe((status: any) => {
    console.log(`🔌 Device status: ${status}`);
  });

  // Track node info for friendly names
  device.events.onFromRadio.subscribe((data: any) => {
    try {
      if (data?.packet?.decoded?.portnum === "NODEINFO_APP" && data?.packet?.decoded?.payload) {
        const user = data.packet.decoded.payload;
        if (user.id && user.longName) {
          nodeNames[data.packet.from?.toString()] = user.longName;
          console.log(`👤 Node ${user.id}: ${user.longName}`);
        }
      }
    } catch {}
  });

  // Incoming messages → inbox file + wake Clyde
  device.events.onMessagePacket.subscribe((msg: any) => {
    const fromId = msg.from?.toString() || "unknown";
    const fromName = nodeNames[fromId] || `Node ${fromId}`;
    const text = msg.data || "(no text)";
    const type = msg.type || "unknown";
    const timestamp = new Date().toISOString();

    console.log(`\n💬 MESSAGE from ${fromName}: ${text}`);

    // Write to inbox
    const entry = JSON.stringify({ from: fromName, fromId, text, type, timestamp });
    try {
      writeFileSync(INBOX_FILE, entry + "\n", { flag: "a" });
      console.log("📥 Written to inbox");
    } catch (e) {
      console.error("Failed to write inbox:", e);
    }

    // Wake agent via localhost gateway (no internet needed!)
    wakeAgent(fromName, text);
  });

  // Configure the device — starts the read loop
  console.log("⚙️  Configuring device...");
  await device.configure();
  console.log("✅ Device configured!\n");

  // --- File-based outbox ---
  const checkOutbox = () => {
    try {
      if (existsSync(OUTBOX_FILE)) {
        const text = readFileSync(OUTBOX_FILE, "utf-8").trim();
        if (text) {
          unlinkSync(OUTBOX_FILE);
          sendMessage(text);
        }
      }
    } catch {}
  };
  setInterval(checkOutbox, 2000);

  // --- HTTP API ---
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", (chunk: any) => (body += chunk));
      req.on("end", async () => {
        try {
          const { text, to } = JSON.parse(body);
          if (!text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing 'text' field" }));
            return;
          }
          const dest = to || DESTINATION_NODE;
          await sendMessage(text, dest);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sent: text, to: dest }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/inbox") {
      try {
        const data = existsSync(INBOX_FILE) ? readFileSync(INBOX_FILE, "utf-8") : "";
        const lines = data.trim().split("\n").filter(Boolean);
        const messages = lines.map((l: string) => JSON.parse(l));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages }));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === "GET" && req.url === "/inbox/clear") {
      try {
        if (existsSync(INBOX_FILE)) unlinkSync(INBOX_FILE);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === "GET" && (req.url === "/status" || req.url === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        bridge: "Meshtastic Bridge 🐾📡",
        connected: true,
        nodes: Object.keys(nodeNames).length,
        nodeNames,
        gatewayWake: !!GATEWAY_TOKEN,
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(HTTP_PORT, "127.0.0.1", () => {
    console.log(`🌐 HTTP API running on http://127.0.0.1:${HTTP_PORT}`);
  });

  console.log(`📡 Bridge running!`);
  console.log(`📥 Incoming → ${INBOX_FILE} + gateway wake`);
  console.log(`📤 Outgoing ← ${OUTBOX_FILE} or POST /send\n`);

  process.on("SIGINT", () => {
    console.log("\n👋 Shutting down...");
    server.close();
    process.exit(0);
  });
}

async function sendMessage(text: string, to: number = DESTINATION_NODE) {
  if (!meshDevice) {
    console.error("❌ Device not connected");
    return;
  }
  console.log(`📤 Sending to ${to}: ${text}`);
  try {
    await meshDevice.sendText(text, to, true, 0);
    console.log("✅ Sent!");
  } catch (e) {
    console.error("❌ Send failed:", e);
  }
}

main().catch(console.error);
