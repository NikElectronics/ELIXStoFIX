/* ESP32-C3 firmware uploader — single-button wizard.
   Flashes firmware/firmware.bin (merged bootloader + partitions + app) to an
   ESP32-C3 SuperMini using esptool.js over Web Serial. */

const $ = (id) => document.getElementById(id);

const els = {
  flashBtn: $("flash-btn"),
  progressBar: $("progress-bar"),
  statusText: $("status-text"),
  spinner: $("spinner"),
  flashDoneMsg: $("flash-done-msg"),
  flowItems: { 1: $("flow-1"), 2: $("flow-2"), 3: $("flow-3") },
};

let myPort = null;

function appendLog(text, cls) {
  console.log((cls ? "[" + cls + "] " : "") + text);
}

function setStatus(text, kind) {
  els.statusText.textContent = text;
  els.statusText.className = "status-text" + (kind ? " " + kind : "");
  els.spinner.hidden = kind !== "busy";
}

function setProgress(pct) {
  els.progressBar.style.width = pct + "%";
}

function resetFlow() {
  for (const k in els.flowItems) {
    els.flowItems[k].classList.remove("active", "done");
  }
  els.flowItems[1].classList.add("active");
}

function markFlow(n, state) {
  const el = els.flowItems[n];
  if (!el) return;
  el.classList.remove("active", "done");
  el.classList.add(state === "done" ? "done" : "active");
}

function portInfo(port) {
  const info = port.getInfo ? port.getInfo() : {};
  const parts = [];
  if (info.usbVendorId) parts.push("VID " + info.usbVendorId.toString(16).padStart(4, "0"));
  if (info.usbProductId) parts.push("PID " + info.usbProductId.toString(16).padStart(4, "0"));
  return parts.length ? parts.join(" ") : "последовательный порт";
}

function hasWebSerial() {
  return "serial" in navigator;
}

/* ---------- firmware source ---------- */
async function fetchBin(path) {
  const res = await fetch("./" + path);
  if (!res.ok) {
    throw new Error(
      "Не удалось получить firmware/" + path + " (" + res.status + "). " +
      "Запустите рабочий процесс GitHub Actions firmware.yml для сборки."
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function getFirmware() {
  const [bootloader, partitions, app] = await Promise.all([
    fetchBin("bootloader.bin"),
    fetchBin("partitions.bin"),
    fetchBin("firmware.bin"),
  ]);
  return { bootloader, partitions, app };
}

/* ---------- port selection ---------- */
async function selectPort() {
  if (!hasWebSerial()) {
    throw new Error(
      "Web Serial недоступен в этом браузере. Используйте Chrome или Edge на десктопе через HTTPS (или localhost)."
    );
  }
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    setStatus("Прошивка отменена — порт не выбран.", "err");
    return null;
  }
  myPort = port;
  window.activePort = port;
  appendLog("Выбран порт: " + portInfo(port), "l-ok");
  return port;
}

/* ---------- flash ---------- */
async function flash() {
  els.flashBtn.disabled = true;
  els.flashDoneMsg.hidden = true;
  resetFlow();

  try {
    if (!hasWebSerial()) {
      setStatus(
        "Web Serial недоступен в этом браузере. Используйте Chrome или Edge на ПК через HTTPS (или localhost).",
        "err"
      );
      appendLog("Web Serial НЕ доступен в этом браузере.", "l-err");
      return;
    }
    appendLog("Web Serial доступен.", "l-ok");

    /* navigator.serial.requestPort() requires a user gesture, so ask for
       the port first - before any await consumes transient activation. */
    if (!myPort) {
      setStatus("Подключите ESP32-C3, затем нажмите, чтобы выбрать его порт...", "busy");
      const port = await selectPort();
      if (!port) return;
    } else {
      window.activePort = myPort;
    }

    markFlow(1, "done");
    markFlow(2, "active");

    setStatus("Загрузка механизма прошивки...", "busy");
    await flashEsp32();
  } catch (e) {
    setProgress(0);
    setStatus("Ошибка прошивки: " + e.message, "err");
    appendLog("Ошибка: " + e.message, "l-err");
  } finally {
    /* Always release the browser serial port (and its reader/writer) after
       every attempt — success or failure — and forget the port handle.
       Otherwise the (possibly still-open) port object is reused on the next
       flash and esptool's open() call fails with
       "The port is already open." Resetting myPort forces a fresh
       navigator.serial.requestPort() (and a clean, closed port) next time. */
    closeActiveSerialPort();
    myPort = null;
    window.activePort = null;
    els.flashBtn.disabled = false;
  }
}

/* ---------- ESP32 (esptool) flash ---------- */
async function flashEsp32() {
  const { ESPLoader, Transport } = await import("./esptool.js?v=6");
  appendLog("esptool.js загружен.", "l-ok");

  setStatus("Подготовка образов прошивки...", "busy");
  const firmware = await getFirmware();
  if (firmware.bootloader) {
    appendLog("Загрузчик: " + firmware.bootloader.length.toLocaleString() + " байт @ 0x0000.", "l-info");
  }
  if (firmware.partitions) {
    appendLog("Разделы: " + firmware.partitions.length.toLocaleString() + " байт @ 0x8000.", "l-info");
  }
  appendLog("Прошивка: " + firmware.app.length.toLocaleString() + " байт @ 0x10000.", "l-info");

  const terminal = {
    clean() {},
    write: (text) => appendLog(text, "l-info"),
    writeLine: (text) => appendLog(text, "l-info"),
    writeRaw: (text) => appendLog(text, "l-info"),
  };

  const esp = new ESPLoader({
    transport: new Transport(myPort),
    baudrate: 115200,
    terminal,
    debugLogging: false,
  });
  let connected = false;
  try {
    setStatus("Подключение к ESP32-C3 и вход в режим загрузки...", "busy");
    await esp.connect("default_reset", 7, true);
    connected = true;
    await esp.runStub();

    setStatus("Запись загрузчика, разделов и прошивки — не отключайте питание...", "busy");
    const fileArray = [];
    if (firmware.bootloader) fileArray.push({ data: firmware.bootloader, address: 0x0000 });
    if (firmware.partitions) fileArray.push({ data: firmware.partitions, address: 0x8000 });
    fileArray.push({ data: firmware.app, address: 0x10000 });
    await esp.writeFlash({
      fileArray,
      eraseAll: false,
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      compress: true,
      reportProgress: (fileIndex, bytesSent, totalBytes) => {
        if (totalBytes > 0) setProgress(Math.round((bytesSent / totalBytes) * 100));
      },
    });
    setProgress(100);

    setStatus("Перезапуск платы...", "busy");
    await esp.after("hard_reset");

    markFlow(2, "done");
    markFlow(3, "active");
    setStatus("Прошивка загружена.", "ok");
    appendLog("Прошивка загружена. Перезагрузите контроллер.", "l-ok");
    els.flashDoneMsg.hidden = false;
  } finally {
    if (connected) {
      try {
        await esp.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function closeActiveSerialPort() {
  const port = window.activePort;
  window.activePort = null;
  if (!port) return;
  try {
    if (window.__rxReader) {
      try {
        window.__rxReader.cancel().catch(() => {});
      } catch (e) {
        /* ignore */
      }
      window.__rxReader = null;
    }
    if (window.__rxWriter) {
      try {
        window.__rxWriter.releaseLock();
      } catch (e) {
        /* ignore */
      }
      window.__rxWriter = null;
    }
    if (window.__rxQueue) window.__rxQueue.length = 0;
    /* Always try to close the port, even when readable/writable are already
       nulled. A port left open here is exactly what makes the next flash fail
       with "The port is already open." close() rejects harmlessly if the port
       is not actually open (we swallow that). */
    try {
      port.close().catch(() => {});
    } catch (e) {
      /* ignore */
    }
  } catch (e) {
    /* ignore */
  }
}

/* ---------- wiring ---------- */
els.flashBtn.addEventListener("click", flash);

/* ---------- init ---------- */
(async function init() {
  if (hasWebSerial()) {
    appendLog("Web Serial доступен.", "l-ok");
  } else {
    els.flashBtn.disabled = true;
    setStatus(
      "Web Serial недоступен в этом браузере. Используйте Chrome или Edge на ПК через HTTPS (или localhost).",
      "err"
    );
    appendLog("Web Serial недоступен в этом браузере.", "l-err");
  }
})();