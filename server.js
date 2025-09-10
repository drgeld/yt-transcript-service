// server.js  — Transcript microservice with timedtext, yt-dlp (+cookies), and Whisper fallback.

import express from "express";
import { execFile } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const app = express();

const TOKEN = process.env.INTERNAL_TOKEN || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

// Wide language coverage; last "" means "any".
const LANGS = [
  "en","en-US","de","fr","es","pt","it","pl","nl","sv","no","da","fi",
  "ar","tr","fa","ur","hi","bn","ru","uk","cs","ro","el","he",
  "ja","ko","zh","zh-Hans","zh-Hant",
  ""
];

// -------------------- small helpers --------------------

function sh(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve({ stdout, stderr });
    });
  });
}

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
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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
      const candidates = ["embed","v","e","watch"];
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

async function tryTimedText(videoId, langs = LANGS) {
  const base = `https://www.youtube.com/api/timedtext?v=${videoId}&fmt=vtt`;
  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `https://www.youtube.com/watch?v=${videoId}`
  };
  const reasons = [];

  for (const lang of langs) {
    // Uploaded subtitles
    const u1 = lang ? `${base}&lang=${encodeURIComponent(lang)}` : base;
    const r1 = await fetchText(u1, headers);
    if (r1.ok && r1.text.includes("WEBVTT")) {
      const t = vttToText(r1.text);
      if (t.length > 30) return { text: t, source: `timedtext(${lang || "any"})` };
    } else {
      reasons.push(`timedtext uploaded ${lang || "any"} -> ${r1.status}`);
    }

    // Auto captions (ASR)
    const u2 = lang ? `${base}&lang=${encodeURIComponent(lang)}&kind=asr` : `${base}&kind=asr`;
    const r2 = await fetchText(u2, headers);
    if (r2.ok && r2.text.includes("WEBVTT")) {
      const t = vttToText(r2.text);
      if (t.length > 30) return { text: t, source: `timedtext-asr(${lang || "any"})` };
    } else {
      reasons.push(`timedtext asr ${lang || "any"} -> ${r2.status}`);
    }
  }

  return { text: "", source: "", reasons };
}

async function exists(p) { try { await readFile(p); return true; } catch { return false; } }
async function safeCleanup(paths) { await Promise.all(paths.map(p => rm(p, { force: true }).catch(() => {}))); }

async function writeCookiesFileFromEnv() {
  const b64 = process.env.YTDLP_COOKIES_B64 || "";
  if (!b64) return "";
  const path = join(tmpdir(), `cookies-${crypto.randomBytes(4).toString("hex")}.txt`);
  await writeFile(path, Buffer.from(b64, "base64"));
  return path;
}

// -------------------- route --------------------

app.get("/transcript", async (req, res) => {
  // Auth
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
    // 1) Official timedtext first (uploaded + ASR)
    const tt = await tryTimedText(videoId);
    if (tt.text) {
      return res.json({ text: tt.text, source: tt.source });
    }
    if (debug) diag.tried.push({ step: "timedtext", reasons: tt.reasons });

    // 2) yt-dlp subtitles with cookies (grab "all" subs; skip live chat)
    const outBase = join(tmpdir(), `yt-${crypto.randomBytes(6).toString("hex")}`);
    const cookiesPath = await writeCookiesFileFromEnv();
    const args = [
      String(url),
      "--skip-download",
      "--no-warnings",
      "--write-auto-sub",
      "--write-sub",
      "--sub-format", "vtt",
      "--sub-langs", "all,-live_chat",
      "-o", `${outBase}.%(ext)s`
    ];
    if (cookiesPath) args.push("--cookies", cookiesPath);

    let ytdlpErr = null;
    await sh("yt-dlp", args).catch(e => { ytdlpErr = e?.stderr || String(e); });
    if (debug) diag.tried.push({ step: "yt-dlp subs", usedCookies: !!cookiesPath, err: ytdlpErr });

    // Try to find any produced .vtt
    const candidates = [
      `${outBase}.en.vtt`, `${outBase}.en-US.vtt`, `${outBase}.de.vtt`, `${outBase}.fr.vtt`,
      `${outBase}.es.vtt`, `${outBase}.pt.vtt`, `${outBase}.it.vtt`, `${outBase}.pl.vtt`,
      `${outBase}.nl.vtt`, `${outBase}.sv.vtt`, `${outBase}.no.vtt`, `${outBase}.da.vtt`,
      `${outBase}.fi.vtt`, `${outBase}.ar.vtt`, `${outBase}.tr.vtt`, `${outBase}.fa.vtt`,
      `${outBase}.ur.vtt`, `${outBase}.hi.vtt`, `${outBase}.bn.vtt`, `${outBase}.ru.vtt`,
      `${outBase}.uk.vtt`, `${outBase}.cs.vtt`, `${outBase}.ro.vtt`, `${outBase}.el.vtt`,
      `${outBase}.he.vtt`, `${outBase}.ja.vtt`, `${outBase}.ko.vtt`,
      `${outBase}.zh.vtt`, `${outBase}.zh-Hans.vtt`, `${outBase}.zh-Hant.vtt`,
      `${outBase}.vtt`
    ];

    let vttPath = "";
    for (const p of candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (await exists(p)) { vttPath = p; break; }
    }

    if (cookiesPath) await rm(cookiesPath, { force: true }).catch(() => {});

    if (vttPath) {
      const vtt = await readFile(vttPath, "utf8");
      const text = vttToText(vtt);
      await safeCleanup(candidates);
      if (text && text.length > 30) {
        return res.json({ text, source: "yt-dlp" });
      }
    } else {
      // clean any leftover generic file if present
      await safeCleanup(candidates);
    }

    // 3) Whisper fallback (download audio with yt-dlp + cookies, transcribe)
    if (!OPENAI_KEY) {
      const resp = { error: "No captions available for this video." };
      if (debug) resp["debug"] = diag;
      return res.status(422).json(resp);
    }

    const audioBase = join(tmpdir(), `yt-${crypto.randomBytes(6).toString("hex")}`);
    const audioPath = `${audioBase}.mp3`;
    const cookiesPath2 = await writeCookiesFileFromEnv();
    const dlArgs = [
      String(url),
      "-x", "--audio-format", "mp3",
      "--no-warnings",
      "-o", audioPath
    ];
    if (cookiesPath2) dlArgs.push("--cookies", cookiesPath2);

    let dlErr = null;
    await sh("yt-dlp", dlArgs).catch(e => { dlErr = e?.stderr || String(e); });
    if (cookiesPath2) await rm(cookiesPath2, { force: true }).catch(() => {});
    if (debug) diag.tried.push({ step: "yt-dlp audio", usedCookies: !!cookiesPath2, err: dlErr });

    if (!dlErr && await exists(audioPath)) {
      try {
        const file = await readFile(audioPath);
        await rm(audioPath, { force: true }).catch(() => {});

        const data = new FormData();
        const BlobCtor = globalThis.Blob || (await import("buffer")).Blob; // safety
        data.append("file", new BlobCtor([file], { type: "audio/mpeg" }), "audio.mp3");
        data.append("model", "whisper-1");
        data.append("response_format", "text");

        const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${OPENAI_KEY}` },
          body: data
        });

        const stt = await resp.text();
        if (resp.ok && stt && stt.trim().length > 30) {
          return res.json({ text: stt.trim(), source: "whisper" });
        } else {
          if (debug) diag.tried.push({ step: "whisper", status: resp.status, bodyLen: (stt||"").length });
        }
      } catch (e) {
        if (debug) diag.tried.push({ step: "whisper-ex", err: String(e?.message || e) });
      }
    }

    const resp = { error: "No captions available for this video." };
    if (debug) resp["debug"] = diag;
    return res.status(422).json(resp);

  } catch (e) {
    const resp = { error: "yt-dlp failed", detail: String(e?.stderr || e?.message || e) };
    if (debug) resp["debug"] = diag;
    return res.status(500).json(resp);
  }
});

// -------------------- start --------------------

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("yt-dlp transcript service on :" + port));
