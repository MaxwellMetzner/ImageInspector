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
- Converts selected sources to WebP, PNG, and JPG through an MV3 offscreen document.
- Preserves original GIF downloads. Browser-native canvas does not encode animated GIF output, so GIF conversion is guarded.
- Adds context menu actions for toggling the inspector and downloading right-clicked images.

## Load locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Visit a page with images and click the Image Inspector extension icon.

## Permission note

This prototype uses `<all_urls>` host permissions so the service worker and offscreen converter can fetch image headers and blobs from CDN origins. A store-ready version could move this to optional host permissions, but that adds permission prompts during hover/download flows.

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
