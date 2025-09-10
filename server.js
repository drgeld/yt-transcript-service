import express from "express";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const app = express();
const TOKEN = process.env.INTERNAL_TOKEN || "";

function sh(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve({ stdout, stderr });
    });
  });
}

// Very simple converter: WebVTT -> plain text
function vttToText(vtt) {
  return vtt
    .replace(/\r/g, "")
    .split("\n")
    .filter(line =>
      line &&
      !/^\d+$/.test(line) &&
      !/^\d{2}:\d{2}:\d{2}\.\d{3}/.test(line) &&
      !/-->/.test(line) &&
      !/^WEBVTT/.test(line)
    )
    .join(" ");
}

async function exists(p) {
  try { await readFile(p); return true; } catch { return false; }
}

async function safeCleanup(paths) {
  await Promise.all(paths.map(p => rm(p, { force: true }).catch(() => {})));
}

app.get("/transcript", async (req, res) => {
    if (TOKEN) {
    const header = req.get("Authorization") || "";
    if (header !== `Bearer ${TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url=YOUTUBE_URL" });

  const id = crypto.randomBytes(6).toString("hex");
  const outBase = join(tmpdir(), `yt-${id}`);
  const tryLangs = ["en", "en-US", ""]; // "" means "any language"

  try {
    let vttPath;

    for (const lang of tryLangs) {
      const args = [
        url,
        "--skip-download",
        "--no-warnings",
        "--write-auto-sub",
        "--write-sub",
        "--sub-format", "vtt",
        "-o", `${outBase}.%(ext)s`
      ];
      if (lang) args.push("--sub-langs", lang);

      // Run yt-dlp (ignore errors; we’ll try next language)
      await sh("yt-dlp", args).catch(() => {});

      // Try file names in common order
      const candidates = [
        `${outBase}.en.vtt`,
        `${outBase}.en-US.vtt`,
        `${outBase}.vtt`
      ];
      for (const p of candidates) {
        if (await exists(p)) { vttPath = p; break; }
      }
      if (vttPath) break;
    }

    if (!vttPath) {
      return res.status(422).json({ error: "No captions available for this video." });
    }

    const vtt = await readFile(vttPath, "utf8");
    const text = vttToText(vtt);
    await safeCleanup([`${outBase}.en.vtt`, `${outBase}.en-US.vtt`, `${outBase}.vtt`]);

    if (!text || text.length < 30) {
      return res.status(422).json({ error: "Transcript too short or empty." });
    }

    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: "yt-dlp failed", detail: String(e?.stderr || e?.message || e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("yt-dlp transcript service on :" + port));

