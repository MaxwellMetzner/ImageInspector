chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "IMAGE_INSPECTOR_OFFSCREEN") {
    return false;
  }

  if (message.type === "IMAGE_INSPECTOR_GET_FORMATS") {
    supportedFormats()
      .then((formats) => sendResponse({ ok: true, formats }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type !== "IMAGE_INSPECTOR_CONVERT") {
    return false;
  }

  convertImage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function convertImage(message) {
  const format = normalizeFormat(message.format);
  const response = await fetchWithTimeout(message.url, {
    credentials: "include",
    cache: "no-store",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Could not fetch image: HTTP ${response.status}`);
  }

  const blob = await response.blob();
  const source = await drawableFromBlob(blob);
  const width = source.width;
  const height = source.height;

  if (!width || !height) {
    source.close();
    throw new Error("Could not determine image dimensions.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", {
    alpha: format !== "jpg",
    willReadFrequently: false
  });

  if (!context) {
    source.close();
    throw new Error("Canvas is unavailable.");
  }

  if (format === "jpg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }

  context.drawImage(source.drawable, 0, 0, width, height);
  source.close();

  const outputCanvas = format === "ico" ? createIconCanvas(canvas) : canvas;
  const mime = mimeForFormat(format);
  const quality = format === "png" ? undefined : 0.92;
  const outputBlob = await encodeCanvas(outputCanvas, format, mime, quality);

  if (!outputBlob) {
    throw new Error(`Could not encode ${format.toUpperCase()}.`);
  }

  const outputMime = cleanMime(outputBlob.type);
  if (outputMime && outputMime !== mime) {
    throw new Error(`${format.toUpperCase()} encoding is not available in this browser.`);
  }

  return {
    dataUrl: await blobToDataUrl(outputBlob),
    mime,
    extension: format,
    width: outputCanvas.width,
    height: outputCanvas.height,
    bytes: outputBlob.size
  };
}

async function encodeCanvas(canvas, format, mime, quality) {
  if (format === "bmp") {
    return canvasToBmp(canvas);
  }
  if (format === "ico") {
    return canvasToIco(canvas);
  }
  return canvasToBlob(canvas, mime, quality);
}

function createIconCanvas(sourceCanvas) {
  const size = Math.min(256, Math.max(sourceCanvas.width, sourceCanvas.height));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    throw new Error("Canvas is unavailable.");
  }

  const scale = Math.min(size / sourceCanvas.width, size / sourceCanvas.height);
  const width = Math.max(1, Math.round(sourceCanvas.width * scale));
  const height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const x = Math.round((size - width) / 2);
  const y = Math.round((size - height) / 2);
  context.drawImage(sourceCanvas, x, y, width, height);
  return canvas;
}

async function drawableFromBlob(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        drawable: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close()
      };
    } catch (_error) {
      // Fall through to HTMLImageElement for SVGs and other browser edge cases.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImage(objectUrl);
    return {
      drawable: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(objectUrl)
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image decode failed."));
    image.src = url;
  });
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, mime, quality);
  });
}

function canvasToBmp(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas is unavailable.");
  }

  const { width, height } = canvas;
  const pixels = context.getImageData(0, 0, width, height).data;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const buffer = new ArrayBuffer(54 + pixelBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, buffer.byteLength, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);

  for (let y = 0; y < height; y += 1) {
    const sourceY = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const source = (sourceY * width + x) * 4;
      const target = 54 + y * rowSize + x * 3;
      bytes[target] = pixels[source + 2];
      bytes[target + 1] = pixels[source + 1];
      bytes[target + 2] = pixels[source];
    }
  }

  return new Blob([buffer], { type: "image/bmp" });
}

async function canvasToIco(canvas) {
  const png = await canvasToBlob(canvas, "image/png");
  if (!png || cleanMime(png.type) !== "image/png") {
    throw new Error("Could not encode the icon image.");
  }

  const pngBytes = new Uint8Array(await png.arrayBuffer());
  const header = new ArrayBuffer(22);
  const view = new DataView(header);
  const bytes = new Uint8Array(header);

  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  bytes[6] = canvas.width >= 256 ? 0 : canvas.width;
  bytes[7] = canvas.height >= 256 ? 0 : canvas.height;
  bytes[8] = 0;
  bytes[9] = 0;
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, pngBytes.byteLength, true);
  view.setUint32(18, 22, true);

  return new Blob([header, pngBytes], { type: "image/x-icon" });
}

async function supportedFormats() {
  const formats = ["webp", "png", "jpg", "bmp", "ico"];
  if (await canEncode("image/avif")) {
    formats.push("avif");
  }
  return formats;
}

async function canEncode(mime) {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const blob = await canvasToBlob(canvas, mime, 0.8);
  return Boolean(blob && cleanMime(blob.type) === mime);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read converted image."));
    reader.readAsDataURL(blob);
  });
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeFormat(format) {
  const normalized = String(format || "").toLowerCase();
  if (!["webp", "png", "jpg", "bmp", "ico", "avif"].includes(normalized)) {
    throw new Error(`Unsupported conversion format: ${format}`);
  }
  return normalized;
}

function mimeForFormat(format) {
  switch (format) {
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
    case "jpg":
      return "image/jpeg";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "avif":
      return "image/avif";
    default:
      throw new Error(`Unsupported conversion format: ${format}`);
  }
}

function cleanMime(mime) {
  return String(mime || "").split(";")[0].trim().toLowerCase();
}
