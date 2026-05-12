const CONTENT_SCRIPT = "src/content/inspector.js";
const OFFSCREEN_DOCUMENT = "src/offscreen/offscreen.html";
const DOWNLOAD_DIR = "ImageInspector";
const SUPPORTED_CONVERSIONS = new Set(["webp", "png", "jpg", "gif"]);

const activeTabs = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "image-inspector-toggle",
      title: "Toggle Image Inspector",
      contexts: ["page", "image", "video"]
    });

    chrome.contextMenus.create({
      id: "image-inspector-download-image",
      title: "Download image with Image Inspector",
      contexts: ["image"]
    });
  });
});

chrome.action.onClicked.addListener((tab) => {
  toggleInspector(tab).catch((error) => {
    console.warn("Image Inspector toggle failed:", error);
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-inspector") {
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab) {
      return toggleInspector(tab);
    }
    return null;
  }).catch((error) => {
    console.warn("Image Inspector command failed:", error);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "image-inspector-toggle" && tab) {
    toggleInspector(tab).catch((error) => {
      console.warn("Image Inspector context toggle failed:", error);
    });
  }

  if (info.menuItemId === "image-inspector-download-image" && info.srcUrl) {
    handleDownload({
      url: info.srcUrl,
      filenameBase: "context-image"
    }).catch((error) => {
      console.warn("Image Inspector context download failed:", error);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    activeTabs.delete(tabId);
    updateBadge(tabId, false).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string" || message.target === "IMAGE_INSPECTOR_OFFSCREEN") {
    return false;
  }

  if (message.type === "IMAGE_INSPECTOR_CONTENT_DISABLED") {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId === "number") {
      activeTabs.set(tabId, false);
      updateBadge(tabId, false).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "IMAGE_INSPECTOR_PROBE":
      return { info: await probeImage(message.url) };
    case "IMAGE_INSPECTOR_DOWNLOAD":
      return handleDownload(message);
    case "IMAGE_INSPECTOR_CONVERT_AND_DOWNLOAD":
      return handleConvertAndDownload(message);
    default:
      throw new Error(`Unknown Image Inspector message: ${message.type}`);
  }
}

async function toggleInspector(tab) {
  if (!tab || typeof tab.id !== "number") {
    throw new Error("No active tab is available.");
  }

  if (!isInjectableUrl(tab.url || "")) {
    await flashBadge(tab.id, "!");
    throw new Error("Image Inspector cannot run on this page.");
  }

  await ensureContentScript(tab.id);
  const current = await getContentState(tab.id);
  const next = !current.enabled;
  await chrome.tabs.sendMessage(tab.id, {
    type: "IMAGE_INSPECTOR_SET_ENABLED",
    enabled: next
  });

  activeTabs.set(tab.id, next);
  await updateBadge(tab.id, next);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "IMAGE_INSPECTOR_PING" });
    return;
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT]
    });
  }
}

async function getContentState(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "IMAGE_INSPECTOR_PING" });
    return {
      enabled: Boolean(response && response.enabled)
    };
  } catch (_error) {
    return {
      enabled: Boolean(activeTabs.get(tabId))
    };
  }
}

async function updateBadge(tabId, enabled) {
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: enabled ? "#10b981" : "#475569"
  });
  await chrome.action.setBadgeText({
    tabId,
    text: enabled ? "ON" : ""
  });
  await chrome.action.setTitle({
    tabId,
    title: enabled ? "Image Inspector is on" : "Toggle Image Inspector"
  });
}

async function flashBadge(tabId, text) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#ef4444" });
  await chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => {
    updateBadge(tabId, false).catch(() => {});
  }, 1400);
}

async function probeImage(url) {
  assertFetchableUrl(url);

  if (url.startsWith("data:")) {
    return probeDataUrl(url);
  }

  const head = await tryHead(url);
  if (head.contentLength || head.contentType) {
    return head;
  }

  const range = await tryRange(url);
  return {
    ...head,
    ...Object.fromEntries(Object.entries(range).filter(([, value]) => value))
  };
}

async function tryHead(url) {
  try {
    const response = await fetchWithTimeout(url, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store",
      redirect: "follow"
    });
    return infoFromResponse(response);
  } catch (_error) {
    return emptyProbe(url);
  }
}

async function tryRange(url) {
  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: {
        Range: "bytes=0-0"
      }
    });

    if (response.body) {
      response.body.cancel().catch(() => {});
    }

    return infoFromResponse(response);
  } catch (_error) {
    return emptyProbe(url);
  }
}

async function handleDownload(message) {
  const url = message.url || "";
  assertDownloadableUrl(url);

  const info = url.startsWith("data:") ? probeDataUrl(url) : await probeImage(url).catch(() => emptyProbe(url));
  const extension = extensionFromUrl(url) || extensionFromMime(info.contentType) || "img";
  const filename = makeDownloadFilename({
    url,
    filenameBase: message.filenameBase,
    extension
  });

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });

  return { downloadId, filename };
}

async function handleConvertAndDownload(message) {
  const url = message.url || "";
  const format = normalizeFormat(message.format);
  assertFetchableUrl(url);

  const sourceInfo = await probeImage(url).catch(() => emptyProbe(url));

  if (format === "gif") {
    const sourceExt = extensionFromUrl(url);
    if (sourceInfo.contentType === "image/gif" || sourceExt === "gif") {
      return handleDownload({
        url,
        filenameBase: message.filenameBase
      });
    }

    throw new Error("GIF output is not available for non-GIF sources in this browser-native build.");
  }

  await ensureOffscreenDocument();
  const converted = await sendOffscreenMessage({
    type: "IMAGE_INSPECTOR_CONVERT",
    target: "IMAGE_INSPECTOR_OFFSCREEN",
    url,
    format
  });

  if (!converted || converted.ok === false || !converted.dataUrl) {
    throw new Error((converted && converted.error) || "Image conversion failed.");
  }

  const filename = makeDownloadFilename({
    url,
    filenameBase: message.filenameBase,
    extension: converted.extension || format
  });

  const downloadId = await chrome.downloads.download({
    url: converted.dataUrl,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });

  return {
    downloadId,
    filename,
    width: converted.width,
    height: converted.height,
    mime: converted.mime
  };
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT,
    reasons: ["BLOBS"],
    justification: "Convert selected page images with browser canvas APIs before download."
  });
}

async function hasOffscreenDocument() {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === "function") {
    return chrome.offscreen.hasDocument();
  }

  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  const matchedClients = await self.clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

function sendOffscreenMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function infoFromResponse(response) {
  const contentRange = response.headers.get("content-range") || "";
  const contentLength = parseContentLength(response.headers.get("content-length"), contentRange);
  const contentType = cleanMime(response.headers.get("content-type") || "");

  return {
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    contentType,
    contentLength,
    acceptRanges: response.headers.get("accept-ranges") || ""
  };
}

function parseContentLength(contentLengthHeader, contentRangeHeader) {
  const rangeMatch = /\/(\d+)\s*$/i.exec(contentRangeHeader || "");
  if (rangeMatch) {
    return Number.parseInt(rangeMatch[1], 10) || null;
  }

  const length = Number.parseInt(contentLengthHeader || "", 10);
  return Number.isFinite(length) && length > 0 ? length : null;
}

function probeDataUrl(url) {
  const headerEnd = url.indexOf(",");
  const header = headerEnd >= 0 ? url.slice(0, headerEnd) : "data:";
  const payload = headerEnd >= 0 ? url.slice(headerEnd + 1) : "";
  const mimeMatch = /^data:([^;,]+)/i.exec(header);
  const base64 = /;base64/i.test(header);
  const contentLength = base64 ? Math.floor((payload.length * 3) / 4) : decodeURIComponent(payload).length;

  return {
    ok: true,
    status: 200,
    finalUrl: url,
    contentType: mimeMatch ? cleanMime(mimeMatch[1]) : "",
    contentLength,
    acceptRanges: ""
  };
}

function emptyProbe(url) {
  return {
    ok: false,
    status: 0,
    finalUrl: url,
    contentType: mimeFromUrl(url),
    contentLength: null,
    acceptRanges: ""
  };
}

function normalizeFormat(format) {
  const normalized = String(format || "").toLowerCase();
  if (!SUPPORTED_CONVERSIONS.has(normalized)) {
    throw new Error(`Unsupported conversion format: ${format}`);
  }
  return normalized;
}

function assertFetchableUrl(url) {
  if (!url || typeof url !== "string") {
    throw new Error("A valid image URL is required.");
  }

  const protocol = protocolForUrl(url);
  if (!["http:", "https:", "data:", "file:"].includes(protocol)) {
    throw new Error(`Unsupported image URL protocol: ${protocol || "unknown"}`);
  }
}

function assertDownloadableUrl(url) {
  if (!url || typeof url !== "string") {
    throw new Error("A valid image URL is required.");
  }

  const protocol = protocolForUrl(url);
  if (!["http:", "https:", "data:", "file:"].includes(protocol)) {
    throw new Error(`Unsupported download URL protocol: ${protocol || "unknown"}`);
  }
}

function protocolForUrl(url) {
  if (url.startsWith("data:")) {
    return "data:";
  }

  try {
    return new URL(url).protocol;
  } catch (_error) {
    return "";
  }
}

function isInjectableUrl(url) {
  return /^(https?:|file:)/i.test(url);
}

function makeDownloadFilename({ url, filenameBase, extension }) {
  const baseFromUrl = basenameFromUrl(url);
  const cleanBase = sanitizeFilename(filenameBase || baseFromUrl || "image");
  const cleanExtension = sanitizeExtension(extension || extensionFromUrl(url) || "img");
  const baseWithoutExt = cleanBase.replace(new RegExp(`\\.${escapeRegExp(cleanExtension)}$`, "i"), "");
  return `${DOWNLOAD_DIR}/${baseWithoutExt || "image"}.${cleanExtension}`;
}

function sanitizeFilename(value) {
  return String(value || "image")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, 120) || "image";
}

function sanitizeExtension(value) {
  return String(value || "img").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "img";
}

function basenameFromUrl(url) {
  if (!url || url.startsWith("data:")) {
    return "";
  }

  try {
    const pathname = new URL(url).pathname;
    const segment = pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(segment).replace(/\.[a-z0-9]{1,8}$/i, "") || "";
  } catch (_error) {
    return "";
  }
}

function extensionFromUrl(url) {
  if (!url || url.startsWith("data:")) {
    return "";
  }

  try {
    const pathname = new URL(url).pathname;
    const match = /\.([a-z0-9]{2,8})$/i.exec(pathname);
    return match ? normalizeExtension(match[1]) : "";
  } catch (_error) {
    return "";
  }
}

function extensionFromMime(mime) {
  switch (cleanMime(mime)) {
    case "image/avif":
      return "avif";
    case "image/bmp":
      return "bmp";
    case "image/gif":
      return "gif";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/svg+xml":
      return "svg";
    case "image/webp":
      return "webp";
    default:
      return "";
  }
}

function mimeFromUrl(url) {
  return extensionMime(extensionFromUrl(url));
}

function extensionMime(extension) {
  switch (normalizeExtension(extension)) {
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return "";
  }
}

function normalizeExtension(extension) {
  const clean = String(extension || "").toLowerCase();
  return clean === "jpeg" ? "jpg" : clean;
}

function cleanMime(mime) {
  return String(mime || "").split(";")[0].trim().toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readableError(error) {
  if (!error) {
    return "Unknown error.";
  }
  return error.message || String(error);
}
