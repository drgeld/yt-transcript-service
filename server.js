import express from "express";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const app = express();
const TOKEN = process.env.INTERNAL_TOKEN || "";

// ---------- Helpers ----------
function sh(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve({ stdout, stderr });
    });
  });
}

// Convert WebVTT to plain text (simple & good enough)
function vttToText(vtt) {
  return vtt
    .replace(/\r/g, "")
    .split("\n")
    .filter(line =>
      line &&
      !/^WEBVTT/.test(line) &&
      !/^\d+$/.test(line) &&
      !/^\d{2}:\d{2}:\d{2}\.\d{3}/.test(line) &&
      !/-->/.test(line)
    )
    .join(" ");
}

function extractVideoId(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.hostname === "youtu.be") return u.pathname.split("/")[1]?.slice(0, 11) || null;
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && v.length === 11) return v;
      const parts = u.pathname.split("/");
      const i = parts.findIndex(p => p === "shorts");
      if (i !== -1 && parts[i + 1]) return parts[i + 1].slice(0, 11);
      const candidates = ["embed", "v", "e", "watch"];
      for (let j = 0; j < parts.length; j++) {
        if (candidates.includes(parts[j]) && parts[j + 1]) {
          const id = parts[j + 1].slice(0, 11);
          if (/^[\w-]{11}$/.test(id)) return id;
        }
      }
    }
    const m = String(url).match(/([A-Za-z0-9_-]{11})(?:\b|$)/);
    return m ? m[1] : null;
  } catch {
    const m = String(url).match(/([A-Za-z0-9_-]{11})(?:\b|$)/);
    return m ? m[1] : null;
  }
}

async function fetchText(url, headers = {}) {
  const r = await fetch(url, { headers });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

// Try YouTube official captions first (uploaded + AUTO "asr") in multiple languages
async function tryTimedText(videoId, langs = ["en","en-US","de","fr","es","ar","tr","pt","hi","ru",""]) {
  const base = `https://www.youtube.com/api/timedtext?v=${videoId}&fmt=vtt`;
  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `https://www.youtube.com/watch?v=${videoId}`
  };
  const reasons = [];

  for (const lang of langs) {
    // Uploaded subtitles (if any)
    const u1 = lang ? `${base}&lang=${encodeURIComponent(lang)}` : base;
    const r1 = await fetchText(u1, headers);
    if (r1.ok && r1.text.includes("WEBVTT")) {
      const t = vttToText(r1.text).trim();
      if (t.length > 30) return { text: t, source: `timedtext(${lang || "any"})` };
    } else {
      reasons.push(`timedtext uploaded ${lang || "any"} -> ${r1.status}`);
    }

    // AUTO captions (ASR)
    const u2 = lang ? `${base}&lang=${encodeURIComponent(lang)}&kind=asr` : `${base}&kind=asr`;
    const r2 = await fetchText(u2, headers);
    if (r2.ok && r2.text.includes("WEBVTT")) {
      const t = vttToText(r2.text).trim();
      if (t.length > 30) return { text: t, source: `timedtext-asr(${lang || "any"})` };
    } else {
      reasons.push(`timedtext asr ${lang || "any"} -> ${r2.status}`);
    }
  }

  return { text: "", source: "", reasons };
}

async function exists(p) { try { await readFile(p); return true; } catch { return false; } }
async function safeCleanup(paths) { await Promise.all(paths.map(p => rm(p, { force: true }).catch(() => {}))); }

// ---------- Route ----------
app.get("/transcript", async (req, res) => {
  // Auth check (token)
  if (TOKEN) {
    const header = req.get("Authorization") || "";
    if (header !== `Bearer ${TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const url = req.query.url;
  const debug = req.query.debug === "1";
  if (!url) return res.status(400).json({ error: "Missing ?url=YOUTUBE_URL" });

  const videoId = extractVideoId(String(url));
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

  const diag = { tried: [] };

  try {
    // 1) Try official timedtext (uploaded + AUTO/ASR) first
    const tt = await tryTimedText(videoId);
    if (tt.text) {
      return res.json({ text: tt.text, source: tt.source });
    }
    if (debug) diag.tried.push({ step: "timedtext", reasons: tt.reasons });

    // 2) Fallback to yt-dlp auto-subs (and any available subs)
    const id = crypto.randomBytes(6).toString("hex");
    const outBase = join(tmpdir(), `yt-${id}`);

    const langs = ["en","en-US","de","fr","es","ar","tr","pt","hi","ru",""]; // ""=any
    let vttPath;

    for (const lang of langs) {
      const args = [
        url,
        "--skip-download",
        "--no-warnings",
        "--write-auto-sub",
        "--write-sub",
        "--sub-format", "vtt",
        "--sub-langs", lang || "all",
        "-o", `${outBase}.%(ext)s`
      ];

      let err = null;
      await sh("yt-dlp", args).catch(e => { err = e?.stderr || String(e); });
      if (debug) diag.tried.push({ step: `yt-dlp ${lang || "any"}`, err });

      // Try common outputs
      const candidates = [
        `${outBase}.en.vtt`,
        `${outBase}.en-US.vtt`,
        `${outBase}.de.vtt`,
        `${outBase}.fr.vtt`,
        `${outBase}.es.vtt`,
        `${outBase}.ar.vtt`,
        `${outBase}.tr.vtt`,
        `${outBase}.pt.vtt`,
        `${outBase}.hi.vtt`,
        `${outBase}.ru.vtt`,
        `${outBase}.vtt`
      ];
      for (const p of candidates) {
        if (await exists(p)) { vttPath = p; break; }
      }
      if (vttPath) break;
    }

    if (!vttPath) {
      const resp = { error: "No captions available for this video." };
      if (debug) resp["debug"] = diag;
      return res.status(422).json(resp);
    }

    const vtt = await readFile(vttPath, "utf8");
    const text = vttToText(vtt).trim();
    await safeCleanup([
      `${outBase}.en.vtt`, `${outBase}.en-US.vtt`, `${outBase}.de.vtt`,
      `${outBase}.fr.vtt`, `${outBase}.es.vtt`, `${outBase}.ar.vtt`,
      `${outBase}.tr.vtt`, `${outBase}.pt.vtt`, `${outBase}.hi.vtt`,
      `${outBase}.ru.vtt`, `${outBase}.vtt`
    ]);

    if (!text || text.length < 30) {
      const resp = { error: "Transcript too short or empty." };
      if (debug) resp["debug"] = { ...diag, finalLength: text.length };
      return res.status(422).json(resp);
    }

    return res.json({ text, source: "yt-dlp" });
  } catch (e) {
    const resp = { error: "yt-dlp failed", detail: String(e?.stderr || e?.message || e) };
    if (debug) resp["debug"] = diag;
    return res.status(500).json(resp);
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("yt-dlp transcript service on :" + port));
