const express = require("express");
const cors = require("cors");
const { create } = require("youtube-dl-exec");
const { spawn } = require("child_process");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const YT_DLP_PATH = process.env.YT_DLP_PATH || "yt-dlp";
const COOKIES_PATH = path.join(__dirname, "cookies.txt");
const HAS_COOKIES = fs.existsSync(COOKIES_PATH);
console.log("[startup] YT_DLP_PATH:", YT_DLP_PATH);
console.log("[startup] Cookies file:", HAS_COOKIES ? COOKIES_PATH : "NOT FOUND");
const youtubeDl = create(YT_DLP_PATH);

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = process.env.FRONTEND_URL
    ? [process.env.FRONTEND_URL]
    : ["http://localhost:3000"];
console.log("[startup] Allowed CORS origins:", allowedOrigins);

app.use(cors({
    origin: allowedOrigins,
    exposedHeaders: ["Content-Disposition", "Content-Length", "X-Filename"],
}));
app.use(express.json());

// Prevent server crash on unhandled stream errors
process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err.message);
});
process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err.message);
});

const YOUTUBE_URL_RE = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|playlist\?list=)|youtu\.be\/)[\w-]+/;

function isPlaylistUrl(url) {
    // Treat as playlist if list=PL... appears anywhere in the URL (not mix RD lists)
    return /[?&]list=PL/.test(url);
}

function isMixPlaylist(url) {
    return /[?&]list=RD/.test(url);
}

// Get video/playlist info
app.post("/info", async (req, res) => {
    const { url } = req.body;
    console.log("[/info] Request received, url:", url);

    if (!url || !YOUTUBE_URL_RE.test(url)) {
        return res.status(400).json({ error: "Invalid YouTube URL" });
    }

    try {
        const isPlaylist = isPlaylistUrl(url);
        console.log("[/info] isPlaylist:", isPlaylist);

        if (isPlaylist) {
            // Use spawn directly because youtube-dl-exec throws on stderr even with ignoreErrors
            const info = await new Promise((resolve, reject) => {
                const args = [url, "--dump-single-json", "--no-warnings", "--no-check-certificates", "--ignore-errors"];
                if (HAS_COOKIES) args.push("--cookies", COOKIES_PATH);
                const proc = spawn(YT_DLP_PATH, args);
                let stdout = "";
                let stderr = "";
                proc.stdout.on("data", (chunk) => { stdout += chunk; });
                proc.stderr.on("data", (chunk) => { stderr += chunk; });
                proc.on("close", (code) => {
                    try {
                        const parsed = JSON.parse(stdout);
                        resolve(parsed);
                    } catch (e) {
                        console.error("[/info] Failed to parse playlist JSON. stderr:", stderr);
                        reject(new Error(stderr || "Failed to parse playlist info"));
                    }
                });
            });

            const entries = [];
            for (const entry of (info.entries || [])) {
                if (!entry || !entry.id || !entry.title) continue; // skip unavailable videos
                const qualities = [];
                const seen = new Set();
                for (const f of (entry.formats || [])) {
                    if (f.height && f.vcodec !== "none" && !seen.has(f.height)) {
                        seen.add(f.height);
                        qualities.push({ label: `${f.height}p`, value: f.height });
                    }
                }
                qualities.sort((a, b) => b.value - a.value);

                entries.push({
                    id: entry.id,
                    title: entry.title,
                    thumbnail: entry.thumbnail || entry.thumbnails?.[0]?.url,
                    duration: entry.duration_string || entry.duration,
                    channel: entry.channel || entry.uploader,
                    url: `https://www.youtube.com/watch?v=${entry.id}`,
                    qualities,
                });
            }

            return res.json({
                title: info.title,
                isPlaylist: true,
                entries,
            });
        }

        // Single video (including mix list URLs — treat as single)
        console.log("[/info] Fetching single video info via yt-dlp...");
        const ytOpts = {
            dumpSingleJson: true,
            noWarnings: true,
            noCheckCertificates: true,
            noPlaylist: true,
        };
        if (HAS_COOKIES) ytOpts.cookies = COOKIES_PATH;
        const info = await youtubeDl(url, ytOpts);

        const qualities = [];
        const seen = new Set();
        for (const f of (info.formats || [])) {
            if (f.height && f.vcodec !== "none" && !seen.has(f.height)) {
                seen.add(f.height);
                qualities.push({ label: `${f.height}p`, value: f.height });
            }
        }
        qualities.sort((a, b) => b.value - a.value);

        console.log("[/info] Single video info OK, title:", info.title);
        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration_string || info.duration,
            channel: info.channel || info.uploader,
            isPlaylist: false,
            qualities,
        });
    } catch (err) {
        console.error("[/info] Error:", err.message, err.stack);
        res.status(500).json({ error: "Failed to get video info", details: err.message });
    }
});

// Job storage for tracking download progress
const jobs = new Map();

// Start a download job — returns jobId, progress is tracked via SSE
app.post("/download", async (req, res) => {
    const { url, format = "mp4", quality } = req.body;
    console.log("[/download] Request received, url:", url, "format:", format, "quality:", quality);

    if (!url || !YOUTUBE_URL_RE.test(url)) {
        return res.status(400).json({ error: "Invalid YouTube URL" });
    }

    const jobId = crypto.randomUUID();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));

    // Build yt-dlp args
    let formatStr;
    if (format === "mp3") {
        formatStr = "bestaudio/best";
    } else if (quality) {
        formatStr = `bestvideo[height<=${quality}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
    } else {
        formatStr = "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best";
    }

    const args = [
        url,
        "-f", formatStr,
        "-o", path.join(tmpDir, "%(title)s.%(ext)s"),
        "--no-check-certificates",
        "--no-playlist",
        "--newline",  // Force progress on new lines instead of \r
    ];

    if (HAS_COOKIES) args.push("--cookies", COOKIES_PATH);

    if (format === "mp3") {
        args.push("-x", "--audio-format", "mp3");
    } else {
        args.push("--merge-output-format", "mp4");
    }

    const job = {
        status: "downloading",
        progress: 0,
        tmpDir,
        format,
        error: null,
        fileName: null,
        filePath: null,
        listeners: new Set(),
        downloadPhase: 0,  // 0 = first stream (video), 1 = second stream (audio)
        _lastRawPct: 0,
    };
    jobs.set(jobId, job);

    console.log("[/download] Spawning yt-dlp, jobId:", jobId, "args:", args.join(" "));
    // Spawn yt-dlp process
    const proc = spawn(YT_DLP_PATH, args);
    let stderrData = "";

    const sendToListeners = (data) => {
        for (const listener of job.listeners) {
            listener(data);
        }
    };

    // Map progress: video download = 0-45%, audio download = 45-90%, merge = 90-100%
    const handleOutput = (chunk) => {
        const text = chunk.toString();
        // console.log("[yt-dlp]", text.trim());

        // Detect merge phase
        if (text.includes("[Merger]") || text.includes("[ExtractAudio]")) {
            job.progress = 95;
            sendToListeners({ type: "progress", percent: 95 });
            return;
        }

        const match = text.match(/\[download\]\s+([\d.]+)%/);
        if (match) {
            const pct = parseFloat(match[1]);

            // Detect new download phase (percentage drops back)
            if (pct < job._lastRawPct - 5) {
                job.downloadPhase = 1;
            }
            job._lastRawPct = pct;

            let overall;
            if (format === "mp3") {
                // MP3: single download, no merge
                overall = pct;
            } else if (job.downloadPhase === 0) {
                // Video stream: 0-45%
                overall = pct * 0.45;
            } else {
                // Audio stream: 45-90%
                overall = 45 + pct * 0.45;
            }

            job.progress = Math.round(overall);
            sendToListeners({ type: "progress", percent: job.progress });
        }
    };

    proc.stdout.on("data", handleOutput);
    proc.stderr.on("data", (chunk) => {
        stderrData += chunk.toString();
        handleOutput(chunk);
    });

    proc.on("close", (code) => {
        const files = fs.readdirSync(tmpDir);
        console.log("[/download] yt-dlp exited, code:", code, "files in tmpDir:", files);
        if (code !== 0 || files.length === 0) {
            console.error("[/download] Download failed, stderr:", stderrData);
            job.status = "error";
            job.error = stderrData || "Download failed";
            sendToListeners({ type: "error", error: job.error });
        } else {
            console.log("[/download] Download complete, file:", files[0]);
            job.status = "done";
            job.progress = 100;
            job.fileName = files[0];
            job.filePath = path.join(tmpDir, files[0]);
            sendToListeners({ type: "done", percent: 100 });
        }

        // Auto-cleanup after 5 minutes
        setTimeout(() => {
            fs.rm(tmpDir, { recursive: true, force: true }, () => { });
            jobs.delete(jobId);
        }, 5 * 60 * 1000);
    });

    res.json({ jobId });
});

// SSE endpoint for download progress
app.get("/download-progress/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: "Job not found" });
    }

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
    });

    // Send current progress immediately
    res.write(`data: ${JSON.stringify({ type: "progress", percent: job.progress })}\n\n`);

    if (job.status === "done") {
        res.write(`data: ${JSON.stringify({ type: "done", percent: 100 })}\n\n`);
        res.end();
        return;
    }
    if (job.status === "error") {
        res.write(`data: ${JSON.stringify({ type: "error", error: job.error })}\n\n`);
        res.end();
        return;
    }

    const listener = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (data.type === "done" || data.type === "error") {
            res.end();
        }
    };

    job.listeners.add(listener);
    req.on("close", () => {
        job.listeners.delete(listener);
    });
});

// Serve the downloaded file
app.get("/download-file/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.status !== "done" || !job.filePath) {
        return res.status(404).json({ error: "File not ready" });
    }

    const ext = path.extname(job.fileName).slice(1);
    const title = path.basename(job.fileName, path.extname(job.fileName));
    const safeTitle = title.replace(/[^\w\s.-]/g, "").trim() || "download";
    const fullName = `${safeTitle}.${ext}`;

    res.set("Content-Disposition", "attachment");
    res.set("X-Filename", encodeURIComponent(fullName));
    res.set("Content-Type", job.format === "mp3" ? "audio/mpeg" : "video/mp4");
    res.sendFile(job.filePath);
});

// Download a playlist as a zip
async function downloadPlaylist(url, res, format = "mp4", quality) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));

    try {
        const info = await youtubeDl(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCheckCertificates: true,
            flatPlaylist: true,
        });

        const playlistTitle = (info.title || "playlist").replace(/[^\w\s-]/g, "");
        console.log(`Downloading playlist: ${playlistTitle} (${info.entries?.length || 0} videos)`);

        let formatStr;
        if (format === "mp3") {
            formatStr = "bestaudio/best";
        } else if (quality) {
            formatStr = `bestvideo[height<=${quality}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
        } else {
            formatStr = "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best";
        }

        const opts = {
            output: path.join(tmpDir, "%(title)s.%(ext)s"),
            format: formatStr,
            noCheckCertificates: true,
            noWarnings: true,
            ignoreErrors: true,
        };

        if (format === "mp3") {
            opts.extractAudio = true;
            opts.audioFormat = "mp3";
        } else {
            opts.mergeOutputFormat = "mp4";
        }

        // Download all videos to temp directory
        await youtubeDl(url, opts);

        // Zip all downloaded files
        const files = fs.readdirSync(tmpDir);
        if (files.length === 0) {
            return res.status(500).json({ error: "No videos were downloaded" });
        }

        res.header("Content-Disposition", `attachment; filename="${playlistTitle}.zip"`);
        res.header("Content-Type", "application/zip");

        const archive = archiver("zip", { zlib: { level: 0 } }); // no compression for speed
        archive.pipe(res);

        for (const file of files) {
            archive.file(path.join(tmpDir, file), { name: file });
        }

        archive.on("error", (err) => {
            console.error("Archive error:", err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: "Failed to create zip" });
            }
        });

        await archive.finalize();
    } catch (err) {
        console.error("Playlist download failed:", err.message, err.stack);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to download playlist", details: err.message });
        }
    } finally {
        // Clean up temp directory
        fs.rm(tmpDir, { recursive: true, force: true }, () => { });
    }
}

app.listen(PORT, () => {
    console.log(`[startup] Server running on port ${PORT}`);
    const { execSync } = require("child_process");
    try {
        const ytdlpVersion = execSync(`${YT_DLP_PATH} --version`).toString().trim();
        console.log("[startup] yt-dlp version:", ytdlpVersion);
    } catch (e) {
        console.error("[startup] yt-dlp NOT found at path:", YT_DLP_PATH, "-", e.message);
    }
    try {
        const ffmpegVersion = execSync("ffmpeg -version").toString().split("\n")[0];
        console.log("[startup] ffmpeg:", ffmpegVersion);
    } catch (e) {
        console.error("[startup] ffmpeg NOT found:", e.message);
    }
});
