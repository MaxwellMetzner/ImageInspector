const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

function inspector(images = {}, timers = {}) {
  const loads = [];
  const part = { hidden: true };
  const shadow = { querySelector: () => part, addEventListener() {} };
  const context = {
    URL, console, setTimeout, clearTimeout, ...timers,
    window: {},
    document: {
      baseURI: "https://example.com/",
      createElement: () => ({ attachShadow: () => shadow })
    },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    Image: class {
      set src(url) {
        loads.push(url);
        const dimensions = images[url];
        if (dimensions === "pending" || !url) {
          return;
        }
        queueMicrotask(() => {
          if (dimensions) {
            [this.naturalWidth, this.naturalHeight] = dimensions;
            this.onload();
          } else {
            this.onerror();
          }
        });
      }
    }
  };
  const source = readFileSync(path.join(__dirname, "..", "src", "content", "inspector.js"), "utf8");
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, `
    globalThis.api = { higherQualityUrls, discoverHigherQuality, measureImage, getBestCandidate, ensureDetailSelection, getSortedCandidates };
  })();`), context);
  return { ...context.api, loads };
}

function selection(url, attributes = {}) {
  return {
    url,
    element: { getAttribute: (name) => attributes[name] || null },
    candidates: [{ url, priority: 2, naturalWidth: 160, naturalHeight: 160 }]
  };
}

test("removes Imgix transforms, including the complete example query", () => {
  const api = inspector();
  const url = "https://partiful.imgix.net/profileImages/asdf?w=160&h=160&dpr=1&fit=clip&rect=0,0,1202,1204";
  assert.equal(api.higherQualityUrls(url)[0].url, "https://partiful.imgix.net/profileImages/asdf");
  assert.equal(api.loads.length, 0);
});

test("preserves unrelated parameters and avoids signed URL rewrites", () => {
  const api = inspector();
  assert.equal(api.higherQualityUrls("https://example.com/image?id=42&w=160")[0].url, "https://example.com/image?id=42");
  for (const key of ["s", "token", "X-Amz-Signature", "Policy"]) {
    assert.equal(api.higherQualityUrls(`https://example.com/a-160x160.jpg?w=160&${key}=secret`).length, 0);
  }
  assert.equal(api.higherQualityUrls("data:image/png;base64,abc").length, 0);
  assert.equal(api.higherQualityUrls("blob:https://example.com/id").length, 0);
});

test("tries thumbnail filenames and Twitter originals", () => {
  const api = inspector();
  assert.equal(api.higherQualityUrls("https://example.com/photo-300x300.jpg")[0].url, "https://example.com/photo.jpg");
  assert.equal(api.higherQualityUrls("https://example.com/photo-scaled.webp")[0].url, "https://example.com/photo.webp");
  assert.equal(api.higherQualityUrls("https://example.com/photo-300x300.jpg?w=160&id=42")[1].url,
    "https://example.com/photo.jpg?id=42");
  assert.equal(api.higherQualityUrls("https://pbs.twimg.com/media/id?format=jpg&name=small")[0].url,
    "https://pbs.twimg.com/media/id?format=jpg&name=orig");
  assert.equal(api.higherQualityUrls("https://example.com/photo.jpg?name=small").length, 0);
});

test("adds only verified larger images and prefers them over linked thumbnails", async () => {
  const original = "https://example.com/photo.jpg?w=160";
  const larger = "https://example.com/photo.jpg";
  const api = inspector({ [original]: [160, 160], [larger]: [1202, 1204] });
  const item = selection(original);
  await api.discoverHigherQuality(item);
  assert.equal(item.candidates.length, 2);
  assert.equal(api.getBestCandidate(item).url, larger);
  assert.equal(api.getBestCandidate(item).naturalHeight, 1204);
  await api.discoverHigherQuality(item);
  assert.equal(api.loads.length, 2);
});

test("rejects smaller, equal, and broken guesses while retaining the original", async () => {
  for (const dimensions of [[80, 80], [160, 160], null]) {
    const url = "https://example.com/image?w=160";
    const api = inspector({ [url]: [160, 160], "https://example.com/image": dimensions });
    const item = selection(url);
    await api.discoverHigherQuality(item);
    assert.equal(item.candidates.length, 1);
    assert.equal(api.getBestCandidate(item).url, url);
    if (!dimensions) {
      assert.match(item.discoveryStatus, /failed or timed out/);
    }
  }
});

test("uses explicit original hints, deduplicates, and caps speculative loads at six", async () => {
  const url = "https://example.com/current";
  const api = inspector({ [url]: [160, 160], "https://example.com/full": [800, 800] });
  const item = selection(url, { "data-original": "/full", "data-full": "/full" });
  for (let index = 0; index < 10; index += 1) {
    item.candidates.push({ url: `https://example.com/image${index}?w=160` });
  }
  await api.discoverHigherQuality(item);
  assert.equal(api.loads.length, 7);
  assert.equal(api.loads.filter((entry) => entry === "https://example.com/full").length, 1);
  assert.equal(api.getBestCandidate(item).url, "https://example.com/full");
});

test("automatic selection follows larger sources but respects manual choice", async () => {
  const url = "https://example.com/image?w=160";
  const api = inspector({ [url]: [160, 160], "https://example.com/image": [800, 800] });
  const item = selection(url);
  api.ensureDetailSelection(item, api.getSortedCandidates(item));
  assert.equal(item.selectedCandidateUrl, url);
  await api.discoverHigherQuality(item);
  api.ensureDetailSelection(item, api.getSortedCandidates(item));
  assert.equal(item.selectedCandidateUrl, "https://example.com/image");
  item.sourceChosenManually = true;
  item.selectedCandidateUrl = url;
  api.ensureDetailSelection(item, api.getSortedCandidates(item));
  assert.equal(item.selectedCandidateUrl, url);
});

test("does not accept guesses without a measurable baseline", async () => {
  const api = inspector({ "https://example.com/image": [800, 800] });
  const item = selection("https://example.com/image?w=160");
  await api.discoverHigherQuality(item);
  assert.equal(item.candidates.length, 1);
  assert.match(item.discoveryStatus, /Could not verify/);
  assert.equal(api.loads.length, 1);
});

test("times out stalled image loads after ten seconds and caches the result", async () => {
  let expire;
  let timeout;
  let cleared = false;
  const url = "https://example.com/stalled";
  const api = inspector({ [url]: "pending" }, {
    setTimeout(callback, milliseconds) {
      expire = callback;
      timeout = milliseconds;
      return 1;
    },
    clearTimeout() { cleared = true; }
  });
  const pending = api.measureImage(url);
  assert.equal(timeout, 10000);
  expire();
  assert.equal(await pending, null);
  assert.equal(cleared, true);
  assert.equal(await api.measureImage(url), null);
  assert.deepEqual(api.loads, [url, ""]);
});
