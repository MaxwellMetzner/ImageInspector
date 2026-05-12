chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "IMAGE_INSPECTOR_OFFSCREEN") {
    return false;
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
  if (format === "gif") {
    throw new Error("GIF encoding is not supported by browser canvas APIs.");
  }

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

  const mime = mimeForFormat(format);
  const quality = format === "png" ? undefined : 0.92;
  const outputBlob = await canvasToBlob(canvas, mime, quality);

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
    width,
    height,
    bytes: outputBlob.size
  };
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
  if (!["webp", "png", "jpg", "gif"].includes(normalized)) {
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
    default:
      throw new Error(`Unsupported conversion format: ${format}`);
  }
}

function cleanMime(mime) {
  return String(mime || "").split(";")[0].trim().toLowerCase();
}
