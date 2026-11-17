const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");

function converterApi() {
  const context = {
    ArrayBuffer,
    Blob,
    DataView,
    Uint8Array,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    document: {}
  };
  const source = readFileSync(path.join(__dirname, "..", "src", "offscreen", "converter.js"), "utf8");
  vm.runInNewContext(source, context);
  return context;
}

test("BMP conversion writes a valid 24-bit bitmap in bottom-up row order", async () => {
  const api = converterApi();
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255
  ]);
  const canvas = {
    width: 2,
    height: 2,
    getContext: () => ({ getImageData: () => ({ data: pixels }) })
  };

  const blob = api.canvasToBmp(canvas);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);

  assert.equal(blob.type, "image/bmp");
  assert.equal(bytes[0], 0x42);
  assert.equal(bytes[1], 0x4d);
  assert.equal(view.getUint32(2, true), 70);
  assert.equal(view.getUint32(10, true), 54);
  assert.equal(view.getInt32(18, true), 2);
  assert.equal(view.getInt32(22, true), 2);
  assert.equal(view.getUint16(28, true), 24);
  assert.deepEqual([...bytes.slice(54, 60)], [255, 0, 0, 255, 255, 255]);
  assert.deepEqual([...bytes.slice(62, 68)], [0, 0, 255, 0, 255, 0]);
});

test("conversion format validation includes BMP, ICO, and AVIF but not GIF", () => {
  const api = converterApi();
  assert.equal(api.normalizeFormat("BMP"), "bmp");
  assert.equal(api.mimeForFormat("bmp"), "image/bmp");
  assert.equal(api.normalizeFormat("ICO"), "ico");
  assert.equal(api.mimeForFormat("ico"), "image/x-icon");
  assert.equal(api.normalizeFormat("avif"), "avif");
  assert.equal(api.mimeForFormat("avif"), "image/avif");
  assert.throws(() => api.normalizeFormat("gif"), /Unsupported conversion format/);
});

test("ICO conversion wraps a PNG in a valid single-image icon container", async () => {
  const api = converterApi();
  const pngBytes = new Uint8Array([137, 80, 78, 71]);
  const canvas = {
    width: 64,
    height: 64,
    toBlob(callback, mime) {
      callback(new Blob([pngBytes], { type: mime }));
    }
  };

  const blob = await api.canvasToIco(canvas);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);

  assert.equal(blob.type, "image/x-icon");
  assert.equal(view.getUint16(0, true), 0);
  assert.equal(view.getUint16(2, true), 1);
  assert.equal(view.getUint16(4, true), 1);
  assert.equal(bytes[6], 64);
  assert.equal(bytes[7], 64);
  assert.equal(view.getUint16(12, true), 32);
  assert.equal(view.getUint32(14, true), pngBytes.byteLength);
  assert.equal(view.getUint32(18, true), 22);
  assert.deepEqual([...bytes.slice(22)], [...pngBytes]);
});
