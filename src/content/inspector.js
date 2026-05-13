(() => {
  const existing = window.__imageInspectorController;
  if (existing) {
    existing.setEnabled(!existing.isEnabled());
    return;
  }

  const ROOT_ID = "image-inspector-root";
  const MAX_SCAN_ITEMS = 80;
  const MAX_BACKGROUND_SCAN_NODES = 2500;
  const DIRECT_IMAGE_RE = /\.(avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;
  const MIME_BY_EXT = new Map([
    ["avif", "image/avif"],
    ["bmp", "image/bmp"],
    ["gif", "image/gif"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["svg", "image/svg+xml"],
    ["webp", "image/webp"]
  ]);

  const state = {
    enabled: false,
    hoverSelection: null,
    pinnedSelection: null,
    pointer: { x: 0, y: 0 },
    raf: 0,
    listenersAttached: false,
    scanResults: []
  };

  const probeCache = new Map();
  const dimensionCache = new Map();

  const host = document.createElement("div");
  host.id = ROOT_ID;
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      [hidden] {
        display: none !important;
      }

      button {
        appearance: none;
        border: 1px solid rgba(229, 231, 235, 0.16);
        background: rgba(17, 24, 39, 0.92);
        color: #f8fafc;
        border-radius: 7px;
        font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
        min-height: 28px;
        padding: 7px 9px;
        cursor: pointer;
      }

      button:hover {
        border-color: rgba(110, 231, 183, 0.72);
        background: rgba(6, 78, 59, 0.94);
      }

      button:active {
        transform: translateY(1px);
      }

      .ii-toolbar {
        position: fixed;
        top: 14px;
        right: 14px;
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 40px;
        padding: 7px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.94);
        box-shadow: 0 14px 36px rgba(2, 6, 23, 0.34);
        color: #f8fafc;
        pointer-events: auto;
      }

      .ii-brand {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 0 6px 0 4px;
        font-size: 12px;
        font-weight: 750;
        white-space: nowrap;
      }

      .ii-dot {
        width: 9px;
        height: 9px;
        border-radius: 999px;
        background: #34d399;
        box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.16);
      }

      .ii-hover {
        position: fixed;
        width: 292px;
        border: 1px solid rgba(148, 163, 184, 0.26);
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.96);
        color: #e5e7eb;
        box-shadow: 0 16px 40px rgba(2, 6, 23, 0.38);
        overflow: hidden;
        pointer-events: none;
      }

      .ii-hover-inner {
        padding: 10px;
      }

      .ii-hover-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 9px;
      }

      .ii-title {
        min-width: 0;
        font-size: 13px;
        font-weight: 760;
        line-height: 1.2;
        color: #f8fafc;
      }

      .ii-subtitle {
        margin-top: 3px;
        color: #94a3b8;
        font-size: 11px;
        line-height: 1.25;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ii-badge-row {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-bottom: 8px;
      }

      .ii-badge {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 4px 6px;
        border-radius: 6px;
        background: rgba(30, 41, 59, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.18);
        color: #e2e8f0;
        font-size: 11px;
        font-weight: 700;
      }

      .ii-badge.ii-res-fhd { color: #bfdbfe; border-color: rgba(96, 165, 250, 0.34); }
      .ii-badge.ii-res-qhd { color: #bbf7d0; border-color: rgba(74, 222, 128, 0.34); }
      .ii-badge.ii-res-4k { color: #fde68a; border-color: rgba(251, 191, 36, 0.38); }
      .ii-badge.ii-res-8k { color: #fecdd3; border-color: rgba(251, 113, 133, 0.42); }

      .ii-meta {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      .ii-metric {
        min-width: 0;
        border: 1px solid rgba(148, 163, 184, 0.16);
        border-radius: 7px;
        background: rgba(2, 6, 23, 0.24);
        padding: 7px;
      }

      .ii-label {
        color: #94a3b8;
        font-size: 10px;
        font-weight: 700;
        line-height: 1;
        text-transform: uppercase;
      }

      .ii-value {
        margin-top: 5px;
        min-width: 0;
        color: #f8fafc;
        font-size: 12px;
        line-height: 1.1;
        overflow-wrap: anywhere;
      }

      .ii-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 9px;
      }

      .ii-actions button,
      .ii-actions select,
      .ii-panel input,
      .ii-panel select,
      .ii-panel button,
      .ii-toolbar button {
        pointer-events: auto;
      }

      .ii-save-menu {
        display: inline-flex;
        align-items: stretch;
        min-width: 0;
      }

      .ii-save-menu button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0;
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
        min-width: 60px;
        padding-inline: 10px;
        border-color: rgba(110, 231, 183, 0.56);
        background: rgba(5, 150, 105, 0.9);
        color: #ecfdf5;
      }

      .ii-save-menu button:hover {
        border-color: rgba(167, 243, 208, 0.82);
        background: rgba(4, 120, 87, 0.98);
      }

      .ii-save-menu select {
        appearance: none;
        border: 1px solid rgba(229, 231, 235, 0.16);
        border-left: 0;
        border-radius: 0 7px 7px 0;
        background:
          linear-gradient(45deg, transparent 50%, #cbd5e1 50%) right 10px center / 5px 5px no-repeat,
          linear-gradient(135deg, #cbd5e1 50%, transparent 50%) right 6px center / 5px 5px no-repeat,
          rgba(17, 24, 39, 0.92);
        color: #f8fafc;
        cursor: pointer;
        font: 650 12px/1 ui-sans-serif, system-ui, sans-serif;
        min-height: 28px;
        max-width: 92px;
        padding: 7px 22px 7px 8px;
      }

      .ii-save-menu select:hover {
        border-color: rgba(110, 231, 183, 0.72);
        background-color: rgba(6, 78, 59, 0.94);
      }

      .ii-panel {
        position: fixed;
        top: 64px;
        right: 14px;
        width: 380px;
        max-height: calc(100vh - 82px);
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(148, 163, 184, 0.26);
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.97);
        color: #e5e7eb;
        box-shadow: 0 18px 48px rgba(2, 6, 23, 0.44);
        overflow: hidden;
        pointer-events: auto;
      }

      .ii-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
      }

      .ii-panel-title {
        min-width: 0;
        color: #f8fafc;
        font-size: 14px;
        font-weight: 780;
        line-height: 1.2;
      }

      .ii-panel-body {
        overflow: auto;
        padding: 10px;
      }

      .ii-preview {
        display: block;
        width: 100%;
        max-height: 220px;
        object-fit: contain;
        background:
          linear-gradient(45deg, rgba(148, 163, 184, 0.14) 25%, transparent 25%),
          linear-gradient(-45deg, rgba(148, 163, 184, 0.14) 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, rgba(148, 163, 184, 0.14) 75%),
          linear-gradient(-45deg, transparent 75%, rgba(148, 163, 184, 0.14) 75%);
        background-size: 18px 18px;
        background-position: 0 0, 0 9px, 9px -9px, -9px 0;
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 7px;
      }

      .ii-section {
        margin-top: 10px;
      }

      .ii-section-title {
        color: #cbd5e1;
        font-size: 11px;
        font-weight: 780;
        margin-bottom: 7px;
        text-transform: uppercase;
      }

      .ii-button-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
      }

      .ii-button-grid button {
        min-width: 0;
      }

      .ii-source-list,
      .ii-candidates {
        display: grid;
        gap: 6px;
      }

      .ii-source-option {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 8px;
        align-items: start;
        padding: 7px;
        border: 1px solid rgba(148, 163, 184, 0.16);
        border-radius: 7px;
        background: rgba(2, 6, 23, 0.24);
        cursor: pointer;
      }

      .ii-source-option:hover,
      .ii-source-option.ii-selected {
        border-color: rgba(110, 231, 183, 0.52);
        background: rgba(6, 78, 59, 0.28);
      }

      .ii-source-option input {
        width: 14px;
        height: 14px;
        margin: 1px 0 0;
        accent-color: #34d399;
        cursor: pointer;
      }

      .ii-source-copy {
        min-width: 0;
      }

      .ii-save-options {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
      }

      .ii-save-option {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 30px;
        padding: 7px 8px;
        border: 1px solid rgba(229, 231, 235, 0.16);
        border-radius: 7px;
        background: rgba(17, 24, 39, 0.92);
        color: #f8fafc;
        cursor: pointer;
        font: 700 12px/1 ui-sans-serif, system-ui, sans-serif;
      }

      .ii-save-option:hover,
      .ii-save-option.ii-selected {
        border-color: rgba(110, 231, 183, 0.72);
        background: rgba(6, 78, 59, 0.94);
      }

      .ii-save-option input {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
      }

      .ii-save-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-top: 8px;
      }

      .ii-save-actions button {
        min-width: 0;
      }

      .ii-candidate {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: center;
        padding: 7px;
        border: 1px solid rgba(148, 163, 184, 0.16);
        border-radius: 7px;
        background: rgba(2, 6, 23, 0.24);
      }

      .ii-candidate-title {
        color: #f8fafc;
        font-size: 12px;
        font-weight: 720;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ii-candidate-subtitle {
        margin-top: 3px;
        color: #94a3b8;
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ii-list {
        display: grid;
        gap: 8px;
      }

      .ii-list-item {
        display: grid;
        grid-template-columns: 58px minmax(0, 1fr);
        gap: 8px;
        align-items: center;
        padding: 7px;
        border: 1px solid rgba(148, 163, 184, 0.16);
        border-radius: 7px;
        background: rgba(2, 6, 23, 0.24);
      }

      .ii-list-item img {
        width: 58px;
        height: 42px;
        object-fit: cover;
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.8);
      }

      .ii-row-actions {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        flex-wrap: wrap;
        gap: 6px;
        grid-column: 2;
        min-width: 0;
      }

      .ii-toast {
        position: fixed;
        left: 50%;
        bottom: 18px;
        max-width: min(520px, calc(100vw - 28px));
        transform: translateX(-50%);
        padding: 10px 12px;
        border: 1px solid rgba(148, 163, 184, 0.24);
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.96);
        color: #f8fafc;
        font: 650 13px/1.35 ui-sans-serif, system-ui, sans-serif;
        box-shadow: 0 14px 34px rgba(2, 6, 23, 0.36);
        pointer-events: none;
      }

      @media (max-width: 520px) {
        .ii-toolbar {
          left: 10px;
          right: 10px;
          justify-content: space-between;
        }

        .ii-panel {
          left: 10px;
          right: 10px;
          top: 62px;
          width: auto;
          max-height: calc(100vh - 72px);
        }

        .ii-hover {
          width: min(292px, calc(100vw - 20px));
        }
      }
    </style>

    <div class="ii-toolbar" data-part="toolbar" hidden>
      <div class="ii-brand">
        <span class="ii-dot"></span>
        <span>Image Inspector</span>
      </div>
      <button type="button" data-action="scan">Scan</button>
      <button type="button" data-action="disable">Close</button>
    </div>

    <div class="ii-hover" data-part="hover" hidden></div>

    <section class="ii-panel" data-part="panel" hidden>
      <header class="ii-panel-header">
        <div class="ii-panel-title" data-part="panel-title">Image Inspector</div>
        <button type="button" data-action="close-panel">Close</button>
      </header>
      <div class="ii-panel-body" data-part="panel-body"></div>
    </section>

    <div class="ii-toast" data-part="toast" hidden></div>
  `;

  const parts = {
    toolbar: shadow.querySelector('[data-part="toolbar"]'),
    hover: shadow.querySelector('[data-part="hover"]'),
    panel: shadow.querySelector('[data-part="panel"]'),
    panelTitle: shadow.querySelector('[data-part="panel-title"]'),
    panelBody: shadow.querySelector('[data-part="panel-body"]'),
    toast: shadow.querySelector('[data-part="toast"]')
  };

  shadow.addEventListener("click", onShadowClick);
  shadow.addEventListener("change", onShadowChange);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }

    if (message.type === "IMAGE_INSPECTOR_PING") {
      sendResponse({ ok: true, enabled: state.enabled });
      return false;
    }

    if (message.type === "IMAGE_INSPECTOR_SET_ENABLED") {
      setEnabled(Boolean(message.enabled));
      sendResponse({ ok: true, enabled: state.enabled });
      return false;
    }

    return false;
  });

  window.__imageInspectorController = {
    setEnabled,
    isEnabled: () => state.enabled
  };

  function setEnabled(enabled) {
    if (enabled === state.enabled) {
      return;
    }

    state.enabled = enabled;

    if (enabled) {
      ensureHost();
      attachListeners();
      parts.toolbar.hidden = false;
      showToast("Image Inspector enabled. Hover an image, then click to grab it.");
      scheduleHoverUpdate();
    } else {
      detachListeners();
      parts.toolbar.hidden = true;
      parts.hover.hidden = true;
      parts.panel.hidden = true;
      state.hoverSelection = null;
      state.pinnedSelection = null;
      notifyDisabled();
    }
  }

  function ensureHost() {
    if (host.isConnected) {
      return;
    }

    const parent = document.body || document.documentElement;
    parent.appendChild(host);
  }

  function attachListeners() {
    if (state.listenersAttached) {
      return;
    }

    state.listenersAttached = true;
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerleave", onPointerLeave, true);
    document.addEventListener("click", onDocumentClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", scheduleHoverUpdate, true);
    window.addEventListener("resize", scheduleHoverUpdate, true);
  }

  function detachListeners() {
    if (!state.listenersAttached) {
      return;
    }

    state.listenersAttached = false;
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerleave", onPointerLeave, true);
    document.removeEventListener("click", onDocumentClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", scheduleHoverUpdate, true);
    window.removeEventListener("resize", scheduleHoverUpdate, true);
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
  }

  function notifyDisabled() {
    sendMessage({ type: "IMAGE_INSPECTOR_CONTENT_DISABLED" }).catch(() => {});
  }

  function onPointerMove(event) {
    if (!state.enabled || isInspectorEvent(event)) {
      return;
    }

    state.pointer.x = event.clientX;
    state.pointer.y = event.clientY;
    scheduleHoverUpdate();
  }

  function onPointerLeave() {
    parts.hover.hidden = true;
    state.hoverSelection = null;
  }

  function onKeyDown(event) {
    if (!state.enabled) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setEnabled(false);
    }
  }

  function onDocumentClick(event) {
    if (!state.enabled || isInspectorEvent(event)) {
      return;
    }

    const selection = findInspectableAt(event.clientX, event.clientY);
    if (!selection) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    pinSelection(selection);
  }

  function onShadowClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const action = button.dataset.action;
    if (action === "disable") {
      setEnabled(false);
      return;
    }

    if (action === "close-panel") {
      parts.panel.hidden = true;
      state.pinnedSelection = null;
      return;
    }

    if (action === "scan") {
      renderScanPanel();
      return;
    }

    if (action === "save-selected-choice" && state.pinnedSelection) {
      saveSelectionWithChoice(state.pinnedSelection, selectedSaveFormat(button));
      return;
    }

    if (action === "download-selected-format" && state.pinnedSelection) {
      const candidate = getSelectedCandidate(state.pinnedSelection);
      convertSelection(state.pinnedSelection, selectedDetailFormat(button), candidate.url);
      return;
    }

    if (action === "download-selected-url" && state.pinnedSelection) {
      const candidate = getSelectedCandidate(state.pinnedSelection);
      downloadUrl(candidate.url, state.pinnedSelection);
      return;
    }

    if (action === "download-candidate") {
      const selection = state.pinnedSelection || state.hoverSelection;
      const url = button.dataset.url;
      if (selection && url) {
        downloadUrl(url, selection);
      }
      return;
    }

    if (action === "details-scan") {
      const item = state.scanResults.find((entry) => entry.id === button.dataset.id);
      if (item) {
        pinSelection(item);
      }
      return;
    }

    if (action === "save-scan-choice") {
      const item = state.scanResults.find((entry) => entry.id === button.dataset.id);
      if (item) {
        saveSelectionWithChoice(item, selectedSaveFormat(button));
      }
    }
  }

  function onShadowChange(event) {
    const sourceInput = event.target.closest('input[data-part="source-choice"]');
    if (sourceInput && state.pinnedSelection) {
      updateSelectedSource(sourceInput);
      return;
    }

    const formatInput = event.target.closest('input[data-part="format-choice"]');
    if (formatInput && state.pinnedSelection) {
      updateSelectedFormat(formatInput);
      return;
    }

    const select = event.target.closest('select[data-part="save-choice"]');
    if (!select) {
      return;
    }

    updateSaveControlLabel(select.closest(".ii-save-menu"));
  }

  function scheduleHoverUpdate() {
    if (!state.enabled || state.raf) {
      return;
    }

    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      updateHover();
    });
  }

  function updateHover() {
    if (!state.enabled) {
      return;
    }

    const selection = findInspectableAt(state.pointer.x, state.pointer.y);
    if (!selection) {
      parts.hover.hidden = true;
      state.hoverSelection = null;
      return;
    }

    state.hoverSelection = selection;
    renderHover(selection);
    enrichSelection(selection);
  }

  function findInspectableAt(x, y) {
    const elements = document.elementsFromPoint(x, y).filter((element) => element !== host);

    for (const element of elements) {
      const selection = inspectElementOrAncestors(element);
      if (selection) {
        return selection;
      }
    }

    return null;
  }

  function inspectElementOrAncestors(element) {
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      if (!(node instanceof Element)) {
        continue;
      }

      if (node === host || node.id === ROOT_ID) {
        continue;
      }

      const selection = inspectElement(node);
      if (selection) {
        return selection;
      }
    }

    return null;
  }

  function inspectElement(element) {
    if (element instanceof HTMLImageElement) {
      return selectionFromImage(element);
    }

    if (element instanceof HTMLVideoElement && element.poster) {
      return selectionFromPoster(element);
    }

    if (typeof SVGImageElement !== "undefined" && element instanceof SVGImageElement) {
      return selectionFromSvgImage(element);
    }

    return selectionFromBackground(element);
  }

  function selectionFromImage(img) {
    const rect = visibleRect(img);
    if (!rect) {
      return null;
    }

    const url = resolveUrl(img.currentSrc || img.src);
    if (!url) {
      return null;
    }

    const candidates = [];
    addCandidate(candidates, url, { source: "current", label: "Current source" });
    addCandidate(candidates, resolveUrl(img.src), { source: "src", label: "Source" });

    if (img.srcset) {
      for (const candidate of parseSrcset(img.srcset)) {
        addCandidate(candidates, candidate.url, {
          source: "img srcset",
          label: candidate.descriptor || "srcset",
          width: candidate.width,
          density: candidate.density
        });
      }
    }

    const picture = img.closest("picture");
    if (picture) {
      for (const source of picture.querySelectorAll("source[srcset]")) {
        for (const candidate of parseSrcset(source.srcset)) {
          addCandidate(candidates, candidate.url, {
            source: "picture",
            label: candidate.descriptor || source.media || "picture source",
            width: candidate.width,
            density: candidate.density
          });
        }
      }
    }

    const anchor = img.closest("a[href]");
    const anchorUrl = anchor ? resolveUrl(anchor.getAttribute("href")) : "";
    if (anchorUrl && isProbablyDirectImage(anchorUrl)) {
      addCandidate(candidates, anchorUrl, { source: "link", label: "Linked image", priority: 2 });
    }

    return finalizeSelection({
      kind: "img",
      element: img,
      url,
      rect,
      naturalWidth: img.naturalWidth || null,
      naturalHeight: img.naturalHeight || null,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      alt: img.alt || "",
      candidates
    });
  }

  function selectionFromPoster(video) {
    const rect = visibleRect(video);
    const url = resolveUrl(video.poster);
    if (!rect || !url) {
      return null;
    }

    return finalizeSelection({
      kind: "poster",
      element: video,
      url,
      rect,
      naturalWidth: video.videoWidth || null,
      naturalHeight: video.videoHeight || null,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      alt: "",
      candidates: [{ url, source: "poster", label: "Video poster", priority: 1 }]
    });
  }

  function selectionFromSvgImage(svgImage) {
    const rect = visibleRect(svgImage);
    const rawUrl =
      svgImage.href && svgImage.href.baseVal
        ? svgImage.href.baseVal
        : svgImage.getAttribute("href") || svgImage.getAttribute("xlink:href");
    const url = resolveUrl(rawUrl);
    if (!rect || !url) {
      return null;
    }

    return finalizeSelection({
      kind: "svg-image",
      element: svgImage,
      url,
      rect,
      naturalWidth: null,
      naturalHeight: null,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      alt: "",
      candidates: [{ url, source: "svg", label: "SVG image", priority: 1 }]
    });
  }

  function selectionFromBackground(element) {
    if (element === document.body || element === document.documentElement) {
      return null;
    }

    const rect = visibleRect(element);
    if (!rect) {
      return null;
    }

    const style = getComputedStyle(element);
    const backgroundCandidates = extractCssImageCandidates(style.backgroundImage);
    if (!backgroundCandidates.length) {
      return null;
    }

    const candidates = backgroundCandidates.map((candidate, index) => ({
      ...candidate,
      source: "css",
      label: candidate.descriptor || (index === 0 ? "Background image" : `Background layer ${index + 1}`),
      priority: index === 0 ? 1 : 0
    }));

    return finalizeSelection({
      kind: "background",
      element,
      url: backgroundCandidates[0].url,
      rect,
      naturalWidth: null,
      naturalHeight: null,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      alt: "",
      candidates
    });
  }

  function finalizeSelection(selection) {
    selection.id = selectionId(selection);
    selection.renderedWidth = Math.round(selection.renderedWidth);
    selection.renderedHeight = Math.round(selection.renderedHeight);
    selection.naturalWidth = normalizeDimension(selection.naturalWidth);
    selection.naturalHeight = normalizeDimension(selection.naturalHeight);
    selection.candidates = dedupeCandidates(selection.candidates);
    seedCurrentCandidateDimensions(selection);
    selection.mime = inferMimeFromUrl(selection.url);
    selection.fileSize = null;
    selection.sizeSource = "";

    const perf = performanceInfoForUrl(selection.url);
    if (perf.size) {
      selection.fileSize = perf.size;
      selection.sizeSource = perf.source;
    }

    return selection;
  }

  function seedCurrentCandidateDimensions(selection) {
    if (!selection.naturalWidth || !selection.naturalHeight) {
      return;
    }

    for (const candidate of selection.candidates) {
      if (candidate.url !== selection.url) {
        continue;
      }

      candidate.naturalWidth = candidate.naturalWidth || selection.naturalWidth;
      candidate.naturalHeight = candidate.naturalHeight || selection.naturalHeight;
      candidate.dimensionChecked = true;
    }
  }

  function renderHover(selection) {
    const hover = parts.hover;
    hover.replaceChildren();

    const inner = el("div", "ii-hover-inner");
    const head = el("div", "ii-hover-head");
    const titleWrap = el("div");
    titleWrap.append(
      el("div", "ii-title", `${kindLabel(selection.kind)} ${dimensionLabel(selection.naturalWidth, selection.naturalHeight)}`),
      el("div", "ii-subtitle", hostLabel(selection.url))
    );
    head.append(titleWrap, resolutionBadge(selection));
    inner.append(head);

    const meta = el("div", "ii-meta");
    meta.append(
      metric("Natural", dimensionLabel(selection.naturalWidth, selection.naturalHeight)),
      metric("Rendered", `${selection.renderedWidth}x${selection.renderedHeight}`),
      metric("Type", typeLabel(selection.mime || inferMimeFromUrl(selection.url))),
      metric("Size", sizeLabel(selection.fileSize))
    );
    inner.append(meta);

    hover.hidden = false;
    hover.append(inner);
    positionHover(selection.rect);
  }

  function positionHover(rect) {
    const hover = parts.hover;
    const width = Math.min(292, window.innerWidth - 20);
    const measuredHeight = hover.getBoundingClientRect().height || 210;
    let left = Math.min(Math.max(10, rect.left), Math.max(10, window.innerWidth - width - 10));
    let top = rect.top - measuredHeight - 8;

    if (top < 10) {
      top = Math.min(rect.bottom + 8, window.innerHeight - measuredHeight - 10);
    }

    if (top < 10) {
      top = 10;
    }

    hover.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function pinSelection(selection) {
    state.pinnedSelection = selection;
    renderSelectionPanel(selection);
    enrichSelection(selection);
  }

  function renderSelectionPanel(selection) {
    parts.panelTitle.textContent = "Selected image";
    parts.panelBody.replaceChildren();

    const preview = document.createElement("img");
    preview.className = "ii-preview";
    preview.src = selection.url;
    preview.alt = selection.alt || "";
    preview.referrerPolicy = "no-referrer";
    parts.panelBody.append(preview);

    const badgeRow = el("div", "ii-badge-row ii-section");
    badgeRow.append(
      resolutionBadge(selection),
      badge(typeLabel(selection.mime || inferMimeFromUrl(selection.url))),
      badge(sizeLabel(selection.fileSize))
    );
    parts.panelBody.append(badgeRow);

    const meta = el("div", "ii-meta");
    meta.append(
      metric("Natural", dimensionLabel(selection.naturalWidth, selection.naturalHeight)),
      metric("Rendered", `${selection.renderedWidth}x${selection.renderedHeight}`),
      metric("Candidates", String(selection.candidates.length)),
      metric("Host", hostLabel(selection.url))
    );
    parts.panelBody.append(meta);

    const candidates = getSortedCandidates(selection);
    ensureDetailSelection(selection, candidates);
    enrichCandidateDimensions(selection);

    if (candidates.length) {
      const candidateSection = section("Sources");
      const list = el("div", "ii-source-list");
      for (const candidate of candidates) {
        const item = el("label", "ii-source-option");
        if (candidate.url === selection.selectedCandidateUrl) {
          item.classList.add("ii-selected");
        }

        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.part = "source-choice";
        input.value = candidate.url;
        input.checked = candidate.url === selection.selectedCandidateUrl;
        input.setAttribute("aria-label", sourceChoiceLabel(candidate));

        const text = el("div", "ii-source-copy");
        text.append(
          el("div", "ii-candidate-title", candidateTitle(candidate)),
          el("div", "ii-candidate-subtitle", candidateSummary(candidate))
        );
        item.append(input, text);
        list.append(item);
      }
      candidateSection.append(list);
      parts.panelBody.append(candidateSection);
    }

    const saveSection = section("Save as:");
    const formats = el("div", "ii-save-options");
    for (const format of ["webp", "png", "jpg", "gif"]) {
      const option = el("label", "ii-save-option", format.toUpperCase());
      if (format === selection.selectedFormat) {
        option.classList.add("ii-selected");
      }

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "ii-save-format";
      input.value = format;
      input.dataset.part = "format-choice";
      input.checked = format === selection.selectedFormat;
      option.prepend(input);
      formats.append(option);
    }

    const saveActions = el("div", "ii-save-actions");
    saveActions.append(
      actionButton("Download", "download-selected-format"),
      actionButton("Save as URL", "download-selected-url")
    );
    saveSection.append(formats, saveActions);
    parts.panelBody.append(saveSection);

    parts.panel.hidden = false;
  }

  function renderScanPanel() {
    parts.panelTitle.textContent = "Page images";
    parts.panelBody.replaceChildren();
    showToast("Scanning visible page images...");

    const results = collectPageImages();
    state.scanResults = results;

    const top = el("div", "ii-section");
    const count = results.length === MAX_SCAN_ITEMS ? `${MAX_SCAN_ITEMS}+` : String(results.length);
    top.append(el("div", "ii-section-title", `${count} found`));
    parts.panelBody.append(top);

    if (!results.length) {
      parts.panelBody.append(el("div", "ii-value", "No inspectable images found on this page."));
      parts.panel.hidden = false;
      return;
    }

    const list = el("div", "ii-list");
    for (const item of results) {
      const row = el("div", "ii-list-item");
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      const text = el("div");
      text.append(
        el("div", "ii-candidate-title", dimensionLabel(item.naturalWidth, item.naturalHeight)),
        el("div", "ii-candidate-subtitle", hostLabel(item.url))
      );
      const actions = el("div", "ii-row-actions");
      const details = actionButton("Details", "details-scan");
      details.dataset.id = item.id;
      actions.append(details, saveControl("save-scan-choice", item.id));
      row.append(img, text, actions);
      list.append(row);
    }
    parts.panelBody.append(list);
    parts.panel.hidden = false;
  }

  function collectPageImages() {
    const seen = new Set();
    const results = [];

    const add = (selection) => {
      if (!selection || seen.has(selection.url) || results.length >= MAX_SCAN_ITEMS) {
        return;
      }
      seen.add(selection.url);
      results.push(selection);
      enrichSelection(selection);
    };

    for (const img of document.images) {
      add(selectionFromImage(img));
    }

    for (const video of document.querySelectorAll("video[poster]")) {
      add(selectionFromPoster(video));
    }

    if (typeof SVGImageElement !== "undefined") {
      for (const image of document.querySelectorAll("svg image")) {
        add(selectionFromSvgImage(image));
      }
    }

    let scanned = 0;
    for (const element of document.querySelectorAll("body *")) {
      if (results.length >= MAX_SCAN_ITEMS || scanned >= MAX_BACKGROUND_SCAN_NODES) {
        break;
      }
      scanned += 1;
      add(selectionFromBackground(element));
    }

    return results.sort((a, b) => candidateScore(getBestCandidate(b)) - candidateScore(getBestCandidate(a)));
  }

  async function enrichSelection(selection) {
    if (!selection || !selection.url) {
      return;
    }

    if (!selection.naturalWidth || !selection.naturalHeight) {
      measureImage(selection.url)
        .then((dimensions) => {
          if (!dimensions) {
            return;
          }
          selection.naturalWidth = dimensions.width;
          selection.naturalHeight = dimensions.height;
          rerenderIfVisible(selection);
        })
        .catch(() => {});
    }

    probeUrl(selection.url)
      .then((info) => {
        if (!info) {
          return;
        }

        selection.mime = info.contentType || selection.mime || inferMimeFromUrl(selection.url);
        selection.fileSize = info.contentLength || selection.fileSize;
        selection.sizeSource = info.contentLength ? "headers" : selection.sizeSource;
        rerenderIfVisible(selection);
      })
      .catch(() => {});
  }

  function enrichCandidateDimensions(selection) {
    if (!selection || !selection.candidates) {
      return;
    }

    for (const candidate of selection.candidates) {
      if (!candidate.url || candidate.dimensionChecked || (candidate.naturalWidth && candidate.naturalHeight)) {
        continue;
      }

      candidate.dimensionChecked = true;
      measureImage(candidate.url)
        .then((dimensions) => {
          if (!dimensions || !dimensions.width || !dimensions.height) {
            return;
          }

          candidate.naturalWidth = dimensions.width;
          candidate.naturalHeight = dimensions.height;
          if (candidate.url === selection.url && (!selection.naturalWidth || !selection.naturalHeight)) {
            selection.naturalWidth = dimensions.width;
            selection.naturalHeight = dimensions.height;
          }
          rerenderIfVisible(selection);
        })
        .catch(() => {});
    }
  }

  function rerenderIfVisible(selection) {
    if (state.hoverSelection && state.hoverSelection.id === selection.id && !parts.hover.hidden) {
      renderHover(selection);
    }

    if (state.pinnedSelection && state.pinnedSelection.id === selection.id && !parts.panel.hidden) {
      renderSelectionPanel(selection);
    }
  }

  async function probeUrl(url) {
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
      return null;
    }

    if (probeCache.has(url)) {
      return probeCache.get(url);
    }

    const task = sendMessage({ type: "IMAGE_INSPECTOR_PROBE", url })
      .then((response) => response.info || null)
      .catch(() => null);
    probeCache.set(url, task);
    return task;
  }

  async function measureImage(url) {
    if (!url) {
      return null;
    }

    if (dimensionCache.has(url)) {
      return dimensionCache.get(url);
    }

    const task = new Promise((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        resolve({
          width: img.naturalWidth || null,
          height: img.naturalHeight || null
        });
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });

    dimensionCache.set(url, task);
    return task;
  }

  async function downloadSelection(selection) {
    const candidate = getBestCandidate(selection);
    await downloadUrl(candidate.url, selection);
  }

  async function saveSelectionWithChoice(selection, choice) {
    if (choice === "source") {
      await downloadSelection(selection);
      return;
    }

    await convertSelection(selection, choice || "png");
  }

  async function downloadUrl(url, selection) {
    try {
      showToast("Starting download...");
      const response = await sendMessage({
        type: "IMAGE_INSPECTOR_DOWNLOAD",
        url,
        filenameBase: filenameBase(selection, url)
      });
      showToast(response.filename ? `Downloaded ${response.filename}` : "Download started.");
    } catch (error) {
      showToast(error.message || "Download failed.");
    }
  }

  async function convertSelection(selection, format, sourceUrl = "") {
    const candidate = sourceUrl ? { url: sourceUrl } : getBestCandidate(selection);
    try {
      showToast(`Converting to ${format.toUpperCase()}...`);
      const response = await sendMessage({
        type: "IMAGE_INSPECTOR_CONVERT_AND_DOWNLOAD",
        url: candidate.url,
        format,
        filenameBase: filenameBase(selection, candidate.url)
      });
      showToast(response.filename ? `Downloaded ${response.filename}` : "Converted download started.");
    } catch (error) {
      showToast(error.message || "Conversion failed.");
    }
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        if (!response || response.ok === false) {
          reject(new Error((response && response.error) || "Extension request failed."));
          return;
        }

        resolve(response);
      });
    });
  }

  function visibleRect(element) {
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 8 || rect.height < 8) {
      return null;
    }

    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      return null;
    }

    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
      return null;
    }

    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  function parseSrcset(srcset) {
    return splitSrcset(srcset)
      .map((part) => {
        const tokens = part.trim().split(/\s+/);
        const url = resolveUrl(tokens.shift());
        if (!url) {
          return null;
        }

        const descriptor = tokens.join(" ");
        const widthToken = tokens.find((token) => /^\d+w$/.test(token));
        const densityToken = tokens.find((token) => /^\d*\.?\d+x$/.test(token));
        return {
          url,
          descriptor,
          width: widthToken ? Number.parseInt(widthToken, 10) : null,
          density: densityToken ? Number.parseFloat(densityToken) : null
        };
      })
      .filter(Boolean);
  }

  function splitSrcset(srcset) {
    const parts = [];
    let current = "";
    let depth = 0;

    for (const char of srcset) {
      if (char === "(") {
        depth += 1;
      } else if (char === ")" && depth > 0) {
        depth -= 1;
      }

      if (char === "," && depth === 0) {
        if (current.trim()) {
          parts.push(current.trim());
        }
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts;
  }

  function extractCssImageCandidates(value) {
    if (!value || value === "none") {
      return [];
    }

    const candidates = [];
    const seen = new Set();
    const regex = /url\((?:"([^"]+)"|'([^']+)'|([^)]*?))\)\s*([0-9]*\.?[0-9]+x|\d+w)?/g;
    let match;
    while ((match = regex.exec(value))) {
      const raw = (match[1] || match[2] || match[3] || "").trim();
      const url = resolveUrl(raw);
      if (!url || seen.has(url)) {
        continue;
      }

      seen.add(url);
      const descriptor = match[4] || "";
      candidates.push({
        url,
        descriptor,
        width: descriptor.endsWith("w") ? Number.parseInt(descriptor, 10) : null,
        density: descriptor.endsWith("x") ? Number.parseFloat(descriptor) : null
      });
    }

    return candidates;
  }

  function addCandidate(candidates, url, details = {}) {
    if (!url) {
      return;
    }

    candidates.push({
      url,
      source: details.source || "",
      label: details.label || "",
      width: details.width || null,
      density: details.density || null,
      naturalWidth: details.naturalWidth || null,
      naturalHeight: details.naturalHeight || null,
      priority: details.priority || 0
    });
  }

  function dedupeCandidates(candidates) {
    const byUrl = new Map();
    for (const candidate of candidates.filter((item) => item && item.url)) {
      if (!byUrl.has(candidate.url)) {
        byUrl.set(candidate.url, candidate);
        continue;
      }

      const existing = byUrl.get(candidate.url);
      existing.width = Math.max(existing.width || 0, candidate.width || 0) || null;
      existing.density = Math.max(existing.density || 0, candidate.density || 0) || null;
      existing.naturalWidth = existing.naturalWidth || candidate.naturalWidth || null;
      existing.naturalHeight = existing.naturalHeight || candidate.naturalHeight || null;
      existing.priority = Math.max(existing.priority || 0, candidate.priority || 0);
      existing.label = existing.label || candidate.label;
      existing.source = existing.source || candidate.source;
    }

    return Array.from(byUrl.values());
  }

  function getSortedCandidates(selection) {
    return [...selection.candidates].sort((a, b) => candidateScore(b) - candidateScore(a));
  }

  function getBestCandidate(selection) {
    return getSortedCandidates(selection)[0] || { url: selection.url, source: "current", label: "Current source" };
  }

  function getSelectedCandidate(selection) {
    const candidates = getSortedCandidates(selection);
    const selected = candidates.find((candidate) => candidate.url === selection.selectedCandidateUrl);
    return selected || candidates[0] || getBestCandidate(selection);
  }

  function ensureDetailSelection(selection, candidates) {
    const options = candidates.length ? candidates : [getBestCandidate(selection)];
    if (!selection.selectedCandidateUrl || !options.some((candidate) => candidate.url === selection.selectedCandidateUrl)) {
      selection.selectedCandidateUrl = options[0].url;
    }

    if (!selection.selectedFormat) {
      selection.selectedFormat = "png";
    }
  }

  function updateSelectedSource(input) {
    input.checked = true;
    state.pinnedSelection.selectedCandidateUrl = input.value;

    const list = input.closest(".ii-source-list");
    if (!list) {
      return;
    }

    for (const option of list.querySelectorAll(".ii-source-option")) {
      const optionInput = option.querySelector('input[data-part="source-choice"]');
      const selected = optionInput === input;
      if (optionInput) {
        optionInput.checked = selected;
      }
      option.classList.toggle("ii-selected", selected);
    }
  }

  function updateSelectedFormat(input) {
    if (!input.checked) {
      return;
    }

    state.pinnedSelection.selectedFormat = input.value;
    const options = input.closest(".ii-save-options");
    if (!options) {
      return;
    }

    for (const option of options.querySelectorAll(".ii-save-option")) {
      const optionInput = option.querySelector('input[data-part="format-choice"]');
      option.classList.toggle("ii-selected", optionInput === input);
    }
  }

  function candidateScore(candidate) {
    return (
      (candidate.priority || 0) * 100000000 +
      (candidate.width || 0) * 1000 +
      (candidate.density || 0) * 100 +
      (isProbablyDirectImage(candidate.url) ? 10 : 0)
    );
  }

  function candidateTitle(candidate) {
    return candidateResolutionLabel(candidate) || candidate.label || candidate.source || "Image source";
  }

  function sourceChoiceLabel(candidate) {
    const title = candidateTitle(candidate);
    const summary = candidateSummary(candidate);
    return summary ? `${title}, ${summary}` : title;
  }

  function candidateSummary(candidate) {
    const bits = [];
    const descriptor = candidateDescriptorLabel(candidate);
    if (descriptor && descriptor !== candidateTitle(candidate)) {
      bits.push(descriptor);
    }
    if (candidate.source) {
      bits.push(candidate.source);
    }
    bits.push(hostLabel(candidate.url));
    return bits.join(" | ");
  }

  function candidateResolutionLabel(candidate) {
    if (candidate.naturalWidth && candidate.naturalHeight) {
      return dimensionLabel(candidate.naturalWidth, candidate.naturalHeight);
    }
    return candidateDescriptorLabel(candidate);
  }

  function candidateDescriptorLabel(candidate) {
    if (candidate.label && (/^\d+w$/i.test(candidate.label) || /^\d*\.?\d+x$/i.test(candidate.label))) {
      return candidate.label;
    }
    if (candidate.width) {
      return `${candidate.width}w`;
    }
    if (candidate.density) {
      return `${candidate.density}x`;
    }
    return "";
  }

  function performanceInfoForUrl(url) {
    try {
      const entries = performance.getEntriesByName(url, "resource");
      const entry = entries[entries.length - 1];
      if (!entry) {
        return { size: null, source: "" };
      }

      const size = entry.encodedBodySize || entry.transferSize || entry.decodedBodySize || null;
      return { size, source: size ? "performance" : "" };
    } catch (_error) {
      return { size: null, source: "" };
    }
  }

  function resolutionBadge(selection) {
    const width = selection.naturalWidth || selection.renderedWidth || 0;
    const height = selection.naturalHeight || selection.renderedHeight || 0;
    const max = Math.max(width, height);
    const min = Math.min(width, height);

    if (max >= 7680 || min >= 4320) {
      return badge("8K", "ii-res-8k");
    }
    if (max >= 3840 || min >= 2160) {
      return badge("4K", "ii-res-4k");
    }
    if (max >= 2560 || min >= 1440) {
      return badge("QHD", "ii-res-qhd");
    }
    if (max >= 1920 || min >= 1080) {
      return badge("FHD", "ii-res-fhd");
    }
    return badge("Below FHD");
  }

  function metric(label, value) {
    const wrapper = el("div", "ii-metric");
    wrapper.append(el("div", "ii-label", label), el("div", "ii-value", value || "Unknown"));
    return wrapper;
  }

  function section(title) {
    const wrapper = el("div", "ii-section");
    wrapper.append(el("div", "ii-section-title", title));
    return wrapper;
  }

  function badge(text, extraClass = "") {
    return el("span", `ii-badge ${extraClass}`.trim(), text || "Unknown");
  }

  function actionButton(text, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.textContent = text;
    return button;
  }

  function saveControl(action, id = "") {
    const wrapper = el("div", "ii-save-menu");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    if (id) {
      button.dataset.id = id;
    }
    const label = el("span", "", "SAVE");
    label.dataset.part = "save-label";
    button.append(label);

    const select = document.createElement("select");
    select.dataset.part = "save-choice";
    select.setAttribute("aria-label", "Save format");
    select.append(
      option("png", "PNG", true),
      option("jpg", "JPG"),
      option("source", "Source")
    );

    wrapper.append(button, select);
    return wrapper;
  }

  function selectedSaveFormat(button) {
    const wrapper = button.closest(".ii-save-menu");
    const select = wrapper ? wrapper.querySelector('select[data-part="save-choice"]') : null;
    return select ? select.value : "png";
  }

  function selectedDetailFormat(button) {
    const section = button.closest(".ii-section");
    const input = section ? section.querySelector('input[data-part="format-choice"]:checked') : null;
    return input ? input.value : (state.pinnedSelection && state.pinnedSelection.selectedFormat) || "png";
  }

  function updateSaveControlLabel(wrapper) {
    if (!wrapper) {
      return;
    }

    const label = wrapper.querySelector('[data-part="save-label"]');
    if (label) {
      label.textContent = "SAVE";
    }
  }

  function option(value, text, selected = false) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = text;
    node.selected = selected;
    return node;
  }

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== "") {
      node.textContent = text;
    }
    return node;
  }

  function showToast(message) {
    parts.toast.textContent = message;
    parts.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      parts.toast.hidden = true;
    }, 2400);
  }

  function isInspectorEvent(event) {
    const path = event.composedPath ? event.composedPath() : [];
    return path.includes(host);
  }

  function resolveUrl(raw) {
    if (!raw || typeof raw !== "string") {
      return "";
    }

    const trimmed = raw.trim();
    if (!trimmed || trimmed === "none") {
      return "";
    }

    if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
      return trimmed;
    }

    try {
      return new URL(trimmed, document.baseURI).href;
    } catch (_error) {
      return "";
    }
  }

  function isProbablyDirectImage(url) {
    return DIRECT_IMAGE_RE.test(url.split("#")[0]);
  }

  function inferMimeFromUrl(url) {
    if (!url) {
      return "";
    }

    if (url.startsWith("data:")) {
      const match = /^data:([^;,]+)/i.exec(url);
      return match ? match[1].toLowerCase() : "";
    }

    try {
      const pathname = new URL(url).pathname;
      const ext = pathname.split(".").pop().toLowerCase();
      return MIME_BY_EXT.get(ext) || "";
    } catch (_error) {
      return "";
    }
  }

  function typeLabel(mime) {
    if (!mime) {
      return "Unknown";
    }

    const clean = mime.split(";")[0].trim().toLowerCase();
    if (clean === "image/jpeg") {
      return "JPG";
    }
    if (clean === "image/svg+xml") {
      return "SVG";
    }
    if (clean.startsWith("image/")) {
      return clean.slice("image/".length).toUpperCase();
    }
    return clean.toUpperCase();
  }

  function sizeLabel(bytes) {
    if (!bytes || !Number.isFinite(bytes)) {
      return "Unknown";
    }

    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
  }

  function dimensionLabel(width, height) {
    if (!width || !height) {
      return "Unknown";
    }
    return `${Math.round(width)}x${Math.round(height)}`;
  }

  function hostLabel(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "data:") {
        return "data URL";
      }
      if (parsed.protocol === "blob:") {
        return "blob URL";
      }
      return parsed.hostname.replace(/^www\./, "");
    } catch (_error) {
      return "local";
    }
  }

  function kindLabel(kind) {
    if (kind === "background") {
      return "CSS";
    }
    if (kind === "poster") {
      return "Poster";
    }
    if (kind === "svg-image") {
      return "SVG";
    }
    return "Image";
  }

  function filenameBase(selection, url) {
    const hostName = hostLabel(url || selection.url).replace(/[^a-z0-9.-]+/gi, "-");
    const candidate = (selection.candidates || []).find((item) => item.url === url);
    const dims = dimensionLabel(
      candidate && candidate.naturalWidth ? candidate.naturalWidth : selection.naturalWidth,
      candidate && candidate.naturalHeight ? candidate.naturalHeight : selection.naturalHeight
    ).replace("Unknown", "image");
    return `${hostName}-${dims}`;
  }

  function normalizeDimension(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
  }

  function selectionId(selection) {
    return `${selection.kind}:${selection.url}:${Math.round(selection.rect.left)}:${Math.round(selection.rect.top)}:${Math.round(selection.rect.width)}x${Math.round(selection.rect.height)}`;
  }
})();
