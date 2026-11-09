# Screen OCR for Vicinae

A Vicinae version of Raycast's Screen OCR extension, built for GNOME on Wayland (Ubuntu 26.04).

| Command | What it does |
|---|---|
| **Recognize Text** | Opens GNOME's screenshot UI so you can select an area, runs OCR on it, and copies the text |
| **Recognize Text Fullscreen** | Captures the whole screen, runs OCR, and copies the text |
| **Detect Barcode / QR Code** | Select an area and copy the decoded QR code or barcode |

## How it works

GNOME Wayland blocks direct screen capture, so the extension asks for a screenshot through the
**XDG desktop portal** (`org.freedesktop.portal.Screenshot`), using a small Python/GObject helper
(`assets/portal-screenshot.py`). If the portal fails, it falls back to `gnome-screenshot`.
Text recognition is done locally by **Tesseract**. Nothing leaves your machine.

## Install

```bash
# OCR engine (add more languages as needed, e.g. tesseract-ocr-deu / -fra / -ita)
sudo apt install tesseract-ocr tesseract-ocr-eng python3-gi
# optional: better accuracy (2x upscale) and QR / barcode support
sudo apt install imagemagick zbar-tools

cd vicinae-ocr
npm install
npm run build      # installs into ~/.local/share/vicinae/…, no restart needed
```

For development with hot reload, run `npm run dev` while Vicinae is running.

To bind a hotkey, open Vicinae settings → Extensions → Screen OCR → Recognize Text.

## Preferences

- **Languages**: Tesseract language codes, e.g. `eng+deu`. Each one needs its `tesseract-ocr-<lang>` package.
- **Line Breaks**: keep the image's line breaks, or join wrapped lines into paragraphs.
- **Capture Method**: Auto, Portal only, or `gnome-screenshot` only.
- **Upscale**: enlarge area captures 2x before OCR. This needs ImageMagick and helps a lot with small UI text.
- **Screenshots**: the portal saves captures in `~/Pictures`. By default they're deleted after OCR.

## Notes

- The first fullscreen capture through the portal shows a GNOME permission prompt. Allow it once.
- If the selection UI doesn't appear, run `python3 assets/portal-screenshot.py --interactive` in a terminal. It prints a file path on success.
