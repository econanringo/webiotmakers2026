import { requestGPIOAccess } from "node-web-gpio";
import { requestI2CAccess } from "node-web-i2c";
import SHT30 from "@chirimen/sht30";

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const gpioAccess = await requestGPIOAccess();
const relay = gpioAccess.ports.get(17);

await relay.export("out");

const i2cAccess = await requestI2CAccess();
const i2cPort = i2cAccess.ports.get(1);

const sht30 = new SHT30(i2cPort, 0x44);
await sht30.init();

// ファンの状態を保持
let fanOn = false;

while (true) {
  const { humidity, temperature } = await sht30.readData();

  console.log(
    `温度: ${temperature.toFixed(2)}℃ 湿度: ${humidity.toFixed(2)}%`
  );

  if (!fanOn && temperature >= 27.0) {
    await relay.write(1);
    fanOn = true;
    console.log("ファンON");
  } else if (fanOn && temperature <= 25.0) {
    await relay.write(0);
    fanOn = false;
    console.log("ファンOFF");
  }

  await sleep(1000);
}