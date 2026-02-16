import { SerialPort } from "serialport";

const port = new SerialPort({ path: "/dev/cu.usbserial-0001", baudRate: 115200 });

console.log("🐾 Raw serial listener — watching ALL bytes...\n");

port.on("open", () => {
  console.log("✅ Port open");
});

port.on("data", (data: Buffer) => {
  const hex = data.toString("hex");
  const ascii = data.toString("utf8").replace(/[^\x20-\x7e]/g, ".");
  console.log(`📡 [${data.length} bytes] hex: ${hex}`);
  console.log(`   ascii: ${ascii}`);
});

port.on("error", (err: Error) => {
  console.error("❌ Error:", err.message);
});

process.on("SIGINT", () => {
  port.close();
  process.exit(0);
});
