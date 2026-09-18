import { SerialPort } from 'serialport';
import readline from 'readline';

const port = new SerialPort({
  path: '/dev/serial0',
  baudRate: 9600,
});

// DFPlayerへコマンドを送信する基本関数
function sendCommand(command, param1, param2) {
  const buffer = Buffer.alloc(10);
  buffer[0] = 0x7E;
  buffer[1] = 0xFF;
  buffer[2] = 0x06;
  buffer[3] = command;
  buffer[4] = 0x00;
  buffer[5] = param1;
  buffer[6] = param2;

  let sum = -(buffer[1] + buffer[2] + buffer[3] + buffer[4] + buffer[5] + buffer[6]);
  buffer[7] = (sum >> 8) & 0xFF;
  buffer[8] = sum & 0xFF;
  buffer[9] = 0xEF;

  port.write(buffer);
}

// 指定した番号のトラックを再生する関数
function playTrack(trackNumber) {
  console.log(`サウンド${trackNumber}を再生するコマンドを送信しました`);
// コマンド0x03で、指定した番号の曲を再生
  sendCommand(0x03, 0x00, trackNumber);
}

port.on('open', () => {
  console.log('シリアルポート接続成功。初期音量を20に設定します。');
  sendCommand(0x06, 0x00, 0x1E); // 音量設定

  console.log('【操作方法】');
  console.log('1〜6の数字キーを押してEnterを押すと、対応する音が鳴ります。');
  console.log('プログラムを終了するには Ctrl+C を押してください。');

  // ターミナルからの入力を受け付ける設定
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on('line', (input) => {
    const num = parseInt(input.trim(), 10);
    // 1から6の数字が入力された場合のみ再生関数を呼び出す
    if (num >= 1 && num <= 6) {
      playTrack(num);
    } else {
      console.log('エラー: 1〜6の数字を入力してください');
    }
  });
});