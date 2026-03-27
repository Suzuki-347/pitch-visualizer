let audioContext;
let analyser;
let microphone;
let dataArray;

let referencePitch = null;
let isRunning = false;

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusText = document.getElementById("status");

let figs = [];
let calibrateInterval = null;

function loadImages() {
  for (let i = 1; i <= 5; i++) {
    let img = new Image();
    img.src = `fig/fig${i}.png`;
    figs.push(img);
  }
}

window.onload = () => {
  loadImages();
};

// マイク初期化
async function initAudio() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioContext = new AudioContext();
  microphone = audioContext.createMediaStreamSource(stream);

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.8;

  let filter = audioContext.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 200; // 中心
  filter.Q.value = 1;

  microphone.connect(filter);
  filter.connect(analyser);

  dataArray = new Float32Array(analyser.fftSize);
}

// ピッチ検出（簡易オートコリレーション）
function getPitch() {
  analyser.getFloatTimeDomainData(dataArray);

  let bestOffset = -1;
  let bestCorrelation = 0;

  for (let offset = 20; offset < 500; offset++) {
    let correlation = 0;

    for (let i = 0; i < 500; i++) {
      correlation += Math.abs(dataArray[i] - dataArray[i + offset]);
    }

    correlation = 1 - (correlation / 500);

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestOffset = offset;
    }
  }

  if (bestOffset > 0) {
    return audioContext.sampleRate / bestOffset;
  }
  return null;
}

let pitchBuffer = [];
const BUFFER_SIZE = 5;  // 平滑化

// 音量（RMS）計算
function getVolume() {
  analyser.getFloatTimeDomainData(dataArray);

  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i] * dataArray[i];
  }

  return Math.sqrt(sum / dataArray.length);
}

function getPitchFFT() {
  let bufferLength = analyser.frequencyBinCount;
  let freqData = new Uint8Array(bufferLength);

  analyser.getByteFrequencyData(freqData);

  let minFreq = 80;
  let maxFreq = 780;

  let minIndex = Math.floor(minFreq * analyser.fftSize / audioContext.sampleRate);
  let maxIndexLimit = Math.floor(maxFreq * analyser.fftSize / audioContext.sampleRate);

  let maxVal = -1;
  let maxIndex = -1;

  for (let i = minIndex; i < maxIndexLimit; i++) {
    if (freqData[i] > maxVal) {
      maxVal = freqData[i];
      maxIndex = i;
    }
  }

  if (maxIndex <= 0) return null;

  // ★ 放物線補間（重要）
  let left = freqData[maxIndex - 1];
  let center = freqData[maxIndex];
  let right = freqData[maxIndex + 1];

  let shift = 0.5 * (left - right) / (left - 2 * center + right);

  let interpolatedIndex = maxIndex + shift;

  let freq = interpolatedIndex * audioContext.sampleRate / analyser.fftSize;

  if (maxVal < 30) return null;

  return freq;
}

// 平滑化
function smoothPitch(pitch) {
  pitchBuffer.push(pitch);
  if (pitchBuffer.length > BUFFER_SIZE) {
    pitchBuffer.shift();
  }

  let sum = pitchBuffer.reduce((a, b) => a + b, 0);
  return sum / pitchBuffer.length;
}

// 色計算
function getColor(diff) {
  // diff: Hz差
  let maxDiff = 150;

  if (Math.abs(diff) < 5) {
    return "white";
  }

  let ratio = Math.min(Math.abs(diff) / maxDiff, 1);

    if (diff > 0) {
    // 高い → 赤方向
    let g = 255 * (1 - ratio);
    let b = 255 * (1 - ratio);
    return `rgb(255, ${g}, ${b})`;
    } else {
    // 低い → 青方向
    let r = 255 * (1 - ratio);
    let g = 255 * (1 - ratio);
    return `rgb(${r}, ${g}, 255)`;
    }
}

function selectFace(diff, ratio) {
  if (diff < 0) {
    if (ratio > 0.6) return figs[0];
    if (ratio > 0.2) return figs[1];
    if (ratio > 0)   return figs[2];
  } else if (diff > 0) {
    if (ratio > 0.6) return figs[4];
    if (ratio > 0.2) return figs[3];
    if (ratio > 0)   return figs[2];
  }
  return null;
}

function draw(color, diff, ratio) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 円
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(150, 150, 80, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.7 + 0.3 * ratio;

  // 顔選択
  let img = selectFace(diff, ratio);

  if (img && img.complete) {
    ctx.drawImage(img, 70, 70, 160, 160);
  }
  ctx.globalAlpha = 1.0;
}

// ループ
function update() {
  if (!isRunning) return;

  let volume = getVolume();

  // ★ 無音除去（超重要）
  if (volume < 0.01) {
    statusText.innerText = "無音";
    draw("gray",0,0);
    requestAnimationFrame(update);
    return;
  }

  let pitch = getPitchFFT();
  let maxDiff = 150;
  if (pitch && referencePitch) {
    let smooth = smoothPitch(pitch);

    let diff = smooth - referencePitch;
    let ratio = Math.min(Math.abs(diff) / maxDiff, 1);

    let color = getColor(diff);

    draw(color, diff, ratio);

    statusText.innerText =
      `Pitch: ${smooth.toFixed(1)} Hz / Vol: ${volume.toFixed(3)}`;
  }

  requestAnimationFrame(update);
}

// 基準入力
document.getElementById("calibrate").onclick = async () => {
  if (!audioContext) await initAudio();
  
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  
  // ★ 前回リセット
  pitchBuffer = [];
  referencePitch = null;

  // ★ 既存interval停止
  if (calibrateInterval) {
    clearInterval(calibrateInterval);
  }

  statusText.innerText = "基準音を入力中...";

  let samples = [];
  let count = 0;

  calibrateInterval = setInterval(() => {
    let p = getPitchFFT();

    if (p) {
      samples.push(p);
      count++;
    }

    if (count > 20) {
      clearInterval(calibrateInterval);

      referencePitch =
        samples.reduce((a, b) => a + b, 0) / samples.length;

      statusText.innerText =
        `基準: ${referencePitch.toFixed(1)} Hz`;
    }
  }, 50);
};

// スタート
document.getElementById("start").onclick = async () => {
  if (!audioContext) await initAudio();

  // ★ これが超重要
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  isRunning = true;
  update();
};
