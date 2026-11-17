# Image Inspector

A Manifest V3 Chrome extension for inspecting images in-page. Click the extension action to enable inspect mode, hover images for quick metadata, then click an image to choose a discovered source and save it in the format you want.

## Current features

- MV3 service worker architecture.
- Click extension icon or press `Alt+Shift+I` to toggle inspect mode.
- Hover overlays for visible page images.
- Click an image to open a pinned detail panel.
- Detects:
  - `img` and `picture` images.
  - `srcset` candidates.
  - CSS `background-image` URLs.
  - `video` poster images.
  - SVG `image` references.
- Shows natural dimensions, rendered dimensions, file type, estimated or probed file size, and quick resolution badges.
- Lets you choose a discovered source candidate from the detail panel before saving.
- Checks for larger originals when opening image details or saving from the page scan:
  - Removes common resize, crop, and quality query parameters (including Imgix).
  - Tries original Twitter/X media sizes and removes common thumbnail filename suffixes, such as `-300x300`.
  - Looks for explicit original/large/zoom image attributes.
  - Tries at most six extra URLs per selection, caches image measurements, and times out each load after 10 seconds. Only successfully loaded images with a larger pixel area are added; the original stays available.
  - Preserves unrelated query parameters and skips URL rewrites for common signed/authenticated URLs. Failed probes are reported in the detail panel; hovering and scanning alone do not trigger speculative loads.
- Ranks measured sources by pixel area, automatically preferring larger images unless you manually choose a source.
- Defaults to saving the original file without recompression, preserving source formats such as GIF, SVG, AVIF, BMP, ICO, JPEG, PNG, and WebP.
- Converts selected sources to WebP, PNG, JPG, BMP, and ICO through an MV3 offscreen document, and offers AVIF when the current browser can encode it.
- Adds context menu actions for toggling the inspector and downloading right-clicked images.

## Load locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Visit a page with images and click the Image Inspector extension icon.

## Permission note

This prototype uses `<all_urls>` host permissions so the service worker and offscreen converter can fetch image headers and blobs from CDN origins. A store-ready version could move this to optional host permissions, but that adds permission prompts during hover/download flows.

## Tests

Run the higher-resolution discovery regression tests with Node.js:

```powershell
node --test tests\higher-quality.test.cjs
```

## Project layout

```text
manifest.json
assets/
  icons/
    icon-16.png
    icon-32.png
    icon-48.png
    icon-128.png
src/
  background/
    service-worker.js
  content/
    inspector.js
  offscreen/
    offscreen.html
    converter.js
```
