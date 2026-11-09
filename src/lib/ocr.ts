import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  Clipboard,
  Toast,
  closeMainWindow,
  environment,
  getPreferenceValues,
  showHUD,
  showToast,
} from "@vicinae/api";

const run = promisify(execFile);

type CaptureMethod = "auto" | "portal" | "gnome-screenshot";

interface Preferences {
  language?: string;
  keepLineBreaks?: boolean;
  captureMethod?: CaptureMethod;
  upscale?: boolean;
  keepScreenshot?: boolean;
}

type Mode = "area" | "fullscreen";

class CancelledError extends Error {}

// Make sure system binaries are found even if the launcher has a trimmed PATH.
const ENV = {
  ...process.env,
  PATH: [process.env.PATH, "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(delimiter),
};

function which(bin: string): string | undefined {
  for (const dir of ENV.PATH.split(delimiter)) {
    const candidate = join(dir, bin);
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureWithPortal(mode: Mode): Promise<string> {
  const script = join(environment.assetsPath, "portal-screenshot.py");
  const args = [script, ...(mode === "area" ? ["--interactive"] : [])];
  try {
    const { stdout } = await run("python3", args, { env: ENV, timeout: 200_000 });
    const path = stdout.trim();
    if (!path) throw new Error("Portal returned no file");
    return path;
  } catch (error) {
    const err = error as { code?: number; stderr?: string; message: string };
    if (err.code === 1) throw new CancelledError();
    throw new Error(err.stderr?.trim() || err.message);
  }
}

async function captureWithGnomeScreenshot(mode: Mode, dir: string): Promise<string> {
  const file = join(dir, "capture.png");
  const args = [...(mode === "area" ? ["-a"] : []), "-f", file];
  await run("gnome-screenshot", args, { env: ENV, timeout: 200_000 });
  if (!existsSync(file)) throw new CancelledError();
  return file;
}

async function capture(mode: Mode, method: CaptureMethod, dir: string): Promise<{ path: string; temporary: boolean }> {
  if (method === "gnome-screenshot") {
    return { path: await captureWithGnomeScreenshot(mode, dir), temporary: true };
  }
  try {
    return { path: await captureWithPortal(mode), temporary: false };
  } catch (error) {
    if (error instanceof CancelledError || method === "portal" || !which("gnome-screenshot")) throw error;
    return { path: await captureWithGnomeScreenshot(mode, dir), temporary: true };
  }
}

/** Enlarge + grayscale the image; Tesseract is far more accurate on 2x screen text. */
async function preprocess(input: string, dir: string): Promise<string> {
  const magick = which("magick") ? "magick" : which("convert") ? "convert" : undefined;
  if (!magick) return input;
  const output = join(dir, "prepared.png");
  try {
    await run(magick, [input, "-colorspace", "Gray", "-resize", "200%", output], { env: ENV, timeout: 30_000 });
    return output;
  } catch {
    return input;
  }
}

function cleanText(raw: string, keepLineBreaks: boolean): string {
  const text = raw.replace(/\f/g, "").replace(/[ \t]+$/gm, "").trim();
  if (keepLineBreaks) return text.replace(/\n{3,}/g, "\n\n");
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/-\n(?=\p{Ll})/gu, "").replace(/\s*\n\s*/g, " "))
    .join("\n\n");
}

async function recognizeText(image: string, language: string): Promise<string> {
  const { stdout } = await run("tesseract", [image, "stdout", "-l", language, "--psm", "3"], {
    env: ENV,
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function decodeBarcode(image: string): Promise<string> {
  try {
    const { stdout } = await run("zbarimg", ["--quiet", "--raw", image], { env: ENV, timeout: 30_000 });
    return stdout;
  } catch (error) {
    // zbarimg exits with 4 when no symbol was found.
    if ((error as { code?: number }).code === 4) return "";
    throw error;
  }
}

function missingDependencies(task: "text" | "barcode", method: CaptureMethod): string[] {
  const missing: string[] = [];
  if (task === "text" && !which("tesseract")) missing.push("tesseract-ocr");
  if (task === "barcode" && !which("zbarimg")) missing.push("zbar-tools");
  if (method === "gnome-screenshot" && !which("gnome-screenshot")) missing.push("gnome-screenshot");
  if (method !== "gnome-screenshot" && !which("python3")) missing.push("python3-gi");
  return missing;
}

export async function runOcr(options: { mode: Mode; task: "text" | "barcode" }): Promise<void> {
  const prefs = getPreferenceValues<Preferences>();
  const method = prefs.captureMethod ?? "auto";
  const language = (prefs.language ?? "").trim() || "eng";

  // Check dependencies while the launcher is still open so the toast is visible.
  const missing = missingDependencies(options.task, method);
  if (missing.length > 0) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Missing dependencies",
      message: `sudo apt install ${missing.join(" ")}`,
    });
    return;
  }

  // Hide the launcher so it does not end up in the screenshot.
  await closeMainWindow();
  await sleep(250);

  const workDir = mkdtempSync(join(tmpdir(), "vicinae-ocr-"));
  let shot: { path: string; temporary: boolean } | undefined;
  try {
    shot = await capture(options.mode, method, workDir);

    if (options.task === "barcode") {
      const result = (await decodeBarcode(shot.path)).trim();
      if (!result) {
        await showHUD("No QR code or barcode found");
        return;
      }
      await Clipboard.copy(result);
      await showHUD(`Copied: ${truncate(result)}`);
      return;
    }

    const shouldUpscale = (prefs.upscale ?? true) && options.mode === "area";
    const image = shouldUpscale ? await preprocess(shot.path, workDir) : shot.path;
    const text = cleanText(await recognizeText(image, language), prefs.keepLineBreaks ?? true);
    if (!text) {
      await showHUD("No text found");
      return;
    }
    await Clipboard.copy(text);
    await showHUD(`Copied ${text.length} characters`);
  } catch (error) {
    if (error instanceof CancelledError) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error("Screen OCR failed:", message);
    await showHUD(`OCR failed: ${truncate(firstLine(message), 80)}`);
  } finally {
    if (shot && !shot.temporary && !prefs.keepScreenshot) {
      try {
        unlinkSync(shot.path);
      } catch {
        // ignore
      }
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim()) ?? text;
}

function truncate(text: string, max = 40): string {
  const single = text.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
