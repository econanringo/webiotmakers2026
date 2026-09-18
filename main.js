import { requestGPIOAccess } from "node-web-gpio";
import { requestI2CAccess } from "node-web-i2c";
import SHT30 from "@chirimen/sht30";
import BH1750 from "@chirimen/bh1750";
import PCA9685 from "@chirimen/pca9685";
import { SerialPort } from "serialport";
import readline from "readline";
import nodeWebSocketLib from "websocket";
import { RelayServer } from "./RelayServer.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHANNEL_NAME = "webiotmakers2026-team-a";
const LUX_THRESHOLD = 10;
const HIGH_HOLD_MS = 5000;
const REST_ANGLE = 30;
const ACTION_ANGLE = -15;
const HOLD_MS = 1000;
const READ_INTERVAL = 500;
const LUX_SEND_INTERVAL = 1000;
const FAN_ON_TEMP = 27.0;
const FAN_OFF_TEMP = 25.0;

// ---- GPIO 初期化（ファン=GPIO17, ボタン=GPIO5入力, 出力=GPIO26）----
const gpioAccess = await requestGPIOAccess();
const fanPort = gpioAccess.ports.get(17);
await fanPort.export("out");
const button = gpioAccess.ports.get(5);
await button.export("in");
const output = gpioAccess.ports.get(26);
await output.export("out");
await output.write(0);

// ---- I2C 初期化（SHT30 + BH1750 + PCA9685）----
const i2cAccess = await requestI2CAccess();
const i2cPort = i2cAccess.ports.get(1);

const sht30 = new SHT30(i2cPort, 0x44);
await sht30.init();

const bh1750 = new BH1750(i2cPort, 0x23);
await bh1750.init();

const pca9685 = new PCA9685(i2cPort, 0x40);
await pca9685.init(0.001, 0.002, 30);
await pca9685.setServo(0, REST_ANGLE);

let i2cChain = Promise.resolve();
function withI2c(task) {
  const run = i2cChain.then(task, task);
  i2cChain = run.then(() => undefined, () => undefined);
  return run;
}

async function setServoAngle(angle) {
  await withI2c(() => pca9685.setServo(0, angle));
}

async function readLux() {
  return withI2c(() => bh1750.measure_high_res());
}

async function readClimate() {
  return withI2c(() => sht30.readData());
}

// ---- DFPlayer シリアル ----
const musicPort = new SerialPort({
  path: "/dev/serial0",
  baudRate: 9600,
});

function sendCommand(command, param1, param2) {
  const buffer = Buffer.alloc(10);
  buffer[0] = 0x7e;
  buffer[1] = 0xff;
  buffer[2] = 0x06;
  buffer[3] = command;
  buffer[4] = 0x00;
  buffer[5] = param1;
  buffer[6] = param2;

  let sum = -(buffer[1] + buffer[2] + buffer[3] + buffer[4] + buffer[5] + buffer[6]);
  buffer[7] = (sum >> 8) & 0xff;
  buffer[8] = sum & 0xff;
  buffer[9] = 0xef;

  musicPort.write(buffer);
}

function playTrack(trackNumber) {
  console.log(`サウンド${trackNumber}を再生するコマンドを送信しました`);
  sendCommand(0x03, 0x00, trackNumber);
  lastTrack = trackNumber;
  sendMusicState();
}

musicPort.on("open", () => {
  console.log("シリアルポート接続成功。初期音量を20に設定します。");
  sendCommand(0x06, 0x00, 0x1e);

  console.log("【操作方法】");
  console.log("1〜6の数字キーを押してEnterを押すと、対応する音が鳴ります。");
  console.log("プログラムを終了するには Ctrl+C を押してください。");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("line", (input) => {
    const num = parseInt(input.trim(), 10);
    if (num >= 1 && num <= 6) {
      playTrack(num);
    } else {
      console.log("エラー: 1〜6の数字を入力してください");
    }
  });
});

// ---- 状態 ----
let fanOn = false;
let fanMode = "AUTO";
let lastTemperature = null;
let lastHumidity = null;
let lastTrack = null;

let count = 0;
let busy = false;
let highSince = null;
let isUnlocked = false;
let channel;
let lastSensor = "OFF";
let lastLux = null;
let lastLuxSentAt = 0;
let servoState = "IDLE";

function lockStateLabel() {
  return isUnlocked ? "UNLOCK" : "LOCK";
}

function kindLabel() {
  return count % 2 === 1 ? "ON" : "OFF";
}

function sendMessage(payload) {
  if (!channel) return;
  channel.send(payload);
}

function sendLockState() {
  sendMessage({ type: "lock", state: lockStateLabel() });
}

function sendSensorState() {
  sendMessage({ type: "sensor", state: lastSensor });
}

function sendLuxState(force = false) {
  if (lastLux == null) return;
  const now = Date.now();
  if (!force && now - lastLuxSentAt < LUX_SEND_INTERVAL) return;
  lastLuxSentAt = now;
  sendMessage({ type: "lux", value: lastLux });
}

function sendServoState() {
  sendMessage({
    type: "servo",
    state: servoState,
    kind: kindLabel(),
    count,
  });
}

function sendFanState() {
  sendMessage({
    type: "fan",
    on: fanOn,
    mode: fanMode,
  });
}

function sendClimateState() {
  if (lastTemperature == null || lastHumidity == null) return;
  sendMessage({
    type: "climate",
    temperature: lastTemperature,
    humidity: lastHumidity,
  });
}

function sendMusicState() {
  sendMessage({
    type: "music",
    lastTrack,
  });
}

function sendSnapshot() {
  sendMessage({
    type: "status",
    climate: {
      temperature: lastTemperature,
      humidity: lastHumidity,
    },
    fan: {
      on: fanOn,
      mode: fanMode,
    },
    music: {
      lastTrack,
    },
    lock: lockStateLabel(),
    sensor: lastSensor,
    lux: lastLux,
    servo: {
      state: servoState,
      kind: kindLabel(),
      count,
    },
  });
}

function normalizeData(data) {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (data && typeof data === "object") return data;
  return null;
}

async function setFan(on, source) {
  if (fanOn === on) return;
  await fanPort.write(on ? 1 : 0);
  fanOn = on;
  console.log(`ファン${on ? "ON" : "OFF"} (${source})`);
  sendFanState();
}

async function applyFanCommand(data) {
  const command = data.command;
  if (command !== "ON" && command !== "OFF" && command !== "AUTO") return;
  fanMode = command;
  console.log(`ファンモード: ${fanMode}`);
  if (command === "ON") {
    await setFan(true, "リモート");
  } else if (command === "OFF") {
    await setFan(false, "リモート");
  }
  sendFanState();
}

function applyMusicCommand(data) {
  if (data.command !== "PLAY") return;
  const track = Number(data.track);
  if (!Number.isInteger(track) || track < 1 || track > 6) return;
  playTrack(track);
}

async function activate(source) {
  const gated = source === "ボタン" || source === "照度";
  if (gated && !isUnlocked) {
    console.log("ロック中のためサーボを動かさない");
    servoState = "BLOCKED";
    sendServoState();
    return;
  }
  if (busy) return;
  busy = true;
  try {
    count++;
    const kind = count % 2 === 1 ? "起動(ON)" : "停止(OFF)";
    console.log(source + ": " + count + "回目 -> " + kind);
    servoState = "MOVING";
    sendServoState();
    await setServoAngle(ACTION_ANGLE);
    await sleep(HOLD_MS);
    await setServoAngle(REST_ANGLE);
    servoState = kindLabel();
    sendServoState();
  } catch (error) {
    console.error("サーボ駆動に失敗:", error);
    servoState = "ERROR";
    sendServoState();
  } finally {
    busy = false;
  }
}

function applyLockCommand(data) {
  if (data.state !== "UNLOCK" && data.state !== "LOCK") return;
  const nextUnlocked = data.state === "UNLOCK";
  if (isUnlocked === nextUnlocked) return;
  isUnlocked = nextUnlocked;
  if (!isUnlocked) highSince = null;
  console.log(`ロック状態: ${lockStateLabel()}`);
  sendLockState();
}

async function applyServoCommand(data) {
  if (data.command !== "RUN" && data.command !== "ON") return;
  console.log("リモートからサーボを動かす");
  await activate("リモート");
}

function handleMessage({ data }) {
  const payload = normalizeData(data);
  if (!payload) return;

  switch (payload.type) {
    case "lock":
      applyLockCommand(payload);
      break;
    case "servo":
      applyServoCommand(payload);
      break;
    case "fan":
      applyFanCommand(payload);
      break;
    case "music":
      applyMusicCommand(payload);
      break;
    case "sync":
      sendSnapshot();
      break;
    default:
      break;
  }
}

async function readSensorPressed() {
  const value = await button.read();
  return value === 0;
}

async function runFanLoop() {
  while (true) {
    try {
      const { humidity, temperature } = await readClimate();
      lastTemperature = temperature;
      lastHumidity = humidity;
      console.log(
        `温度: ${temperature.toFixed(2)}℃ 湿度: ${humidity.toFixed(2)}%`
      );
      sendClimateState();

      if (fanMode === "AUTO") {
        if (!fanOn && temperature >= FAN_ON_TEMP) {
          await setFan(true, "自動");
        } else if (fanOn && temperature <= FAN_OFF_TEMP) {
          await setFan(false, "自動");
        }
      }
    } catch (error) {
      console.error("温湿度の読み取りに失敗:", error);
    }
    await sleep(1000);
  }
}

async function runLuxLoop() {
  while (true) {
    try {
      const lux = await readLux();
      lastLux = Number(lux.toFixed(3));
      console.log(lastLux.toFixed(3) + "lx");
      sendLuxState();
    } catch (error) {
      console.error("照度の読み取りに失敗:", error);
      await sleep(READ_INTERVAL);
      continue;
    }

    const lightAllowed = isUnlocked && count % 2 === 0;
    const now = Date.now();

    if (lightAllowed && lastLux >= LUX_THRESHOLD) {
      if (highSince === null) highSince = now;
      if (now - highSince >= HIGH_HOLD_MS) {
        highSince = null;
        await activate("照度");
      }
    } else {
      highSince = null;
    }

    await sleep(READ_INTERVAL);
  }
}

const relay = RelayServer(
  "chirimentest",
  "chirimenSocket",
  nodeWebSocketLib,
  "https://chirimen.org",
);
channel = await relay.subscribe(CHANNEL_NAME);
console.log("web socketリレーサービスに接続しました");
channel.onmessage = handleMessage;

lastSensor = (await readSensorPressed()) ? "ON" : "OFF";
try {
  lastLux = Number((await readLux()).toFixed(3));
} catch (error) {
  console.error("照度の初回読み取りに失敗:", error);
}
try {
  const climate = await readClimate();
  lastTemperature = climate.temperature;
  lastHumidity = climate.humidity;
} catch (error) {
  console.error("温湿度の初回読み取りに失敗:", error);
}
sendSnapshot();

button.onchange = async (e) => {
  const pressed = e.value == 0;
  lastSensor = pressed ? "ON" : "OFF";
  console.log(`センサー: ${lastSensor}`);
  sendSensorState();

  if (pressed) {
    await output.write(1);
    await activate("ボタン");
    highSince = null;
  } else {
    await output.write(0);
  }
};

runFanLoop();
runLuxLoop();
