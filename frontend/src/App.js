import React, { useState, useEffect, useRef } from "react";
import "./App.css";

function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function App() {
    const [url, setUrl] = useState("");
    const [fetching, setFetching] = useState(false);
    const [error, setError] = useState("");
    const [videoInfo, setVideoInfo] = useState(null);
    const [format, setFormat] = useState("mp4");
    const [quality, setQuality] = useState("");
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState(null);
    const [downloaded, setDownloaded] = useState(false);
    const [playlistOptions, setPlaylistOptions] = useState([]);
    const [playlistFormat, setPlaylistFormat] = useState("mp4");
    const [playlistQuality, setPlaylistQuality] = useState("");
    const [downloadingAll, setDownloadingAll] = useState(false);
    const debounceRef = useRef(null);
    const abortRef = useRef(null);

    const fetchInfo = async (videoUrl) => {
        if (!videoUrl.trim() || fetching) return;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = null;

        // Abort any previous request
        if (abortRef.current) abortRef.current.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        setError("");
        setFetching(true);
        try {
            const res = await fetch(`${process.env.REACT_APP_API_URL || "http://localhost:4000"}/info`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: videoUrl }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Failed to fetch info");
            }
            const data = await res.json();
            setVideoInfo(data);

            if (data.isPlaylist && data.entries) {
                setPlaylistOptions(
                    data.entries.map((entry) => ({
                        format: "mp4",
                        quality: entry.qualities?.[0]?.value ? String(entry.qualities[0].value) : "",
                        loading: false,
                        progress: null,
                    }))
                );
            } else if (data.qualities?.length > 0) {
                setQuality(String(data.qualities[0].value));
            }
        } catch (err) {
            if (err.name === "AbortError") return;
            setError(err.message);
        } finally {
            setFetching(false);
        }
    };

    useEffect(() => {
        setVideoInfo(null);
        setError("");
        setQuality("");
        setDownloaded(false);
        setPlaylistOptions([]);

        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
        setFetching(false);
        if (!url.trim()) return;

        debounceRef.current = setTimeout(() => fetchInfo(url), 1500);

        return () => clearTimeout(debounceRef.current);
    }, [url]);

    const downloadVideo = async (videoUrl, fmt, qual, setLoadingFn, setProgressFn, onSuccess) => {
        setError("");
        setLoadingFn(true);
        setProgressFn({ percent: 0 });

        try {
            // Step 1: Start the download job
            const startRes = await fetch(`${process.env.REACT_APP_API_URL || "http://localhost:4000"}/download`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    url: videoUrl,
                    format: fmt,
                    quality: fmt === "mp4" ? qual : undefined,
                }),
            });

            if (!startRes.ok) {
                const data = await startRes.json();
                throw new Error(data.error || "Download failed");
            }

            const { jobId } = await startRes.json();

            // Step 2: Listen to SSE for real-time yt-dlp progress
            await new Promise((resolve, reject) => {
                const evtSource = new EventSource(`${process.env.REACT_APP_API_URL || "http://localhost:4000"}/download-progress/${jobId}`);
                evtSource.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    if (data.type === "progress") {
                        setProgressFn({ percent: Math.round(data.percent) });
                    } else if (data.type === "done") {
                        evtSource.close();
                        resolve();
                    } else if (data.type === "error") {
                        evtSource.close();
                        reject(new Error(data.error));
                    }
                };
                evtSource.onerror = () => {
                    evtSource.close();
                    reject(new Error("Lost connection to server"));
                };
            });

            // Step 3: Download the finished file
            setProgressFn({ percent: 100 });
            const fileRes = await fetch(`${process.env.REACT_APP_API_URL || "http://localhost:4000"}/download-file/${jobId}`);
            const blob = await fileRes.blob();
            const blobUrl = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            const xFilename = fileRes.headers.get("X-Filename");
            a.download = xFilename
                ? decodeURIComponent(xFilename)
                : `video.${fmt}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(blobUrl);
            if (onSuccess) onSuccess();
        } catch (err) {
            setError(err.message);
        } finally {
            setLoadingFn(false);
            setTimeout(() => setProgressFn(null), 1500);
        }
    };

    const handleSingleDownload = () => {
        downloadVideo(url, format, quality, setLoading, setProgress, () => setDownloaded(true));
    };

    const handlePlaylistDownload = (index, entry) => {
        const opts = playlistOptions[index];
        downloadVideo(
            entry.url,
            opts.format,
            opts.quality,
            (val) => {
                setPlaylistOptions((prev) => {
                    const next = [...prev];
                    next[index] = { ...next[index], loading: val };
                    return next;
                });
            },
            (val) => {
                setPlaylistOptions((prev) => {
                    const next = [...prev];
                    next[index] = { ...next[index], progress: val };
                    return next;
                });
            },
            () => {
                setPlaylistOptions((prev) => {
                    const next = [...prev];
                    next[index] = { ...next[index], downloaded: true };
                    return next;
                });
            }
        );
    };

    const updatePlaylistOption = (index, key, value) => {
        setPlaylistOptions((prev) => {
            const next = [...prev];
            next[index] = { ...next[index], [key]: value };
            return next;
        });
    };

    const applyFormatToAll = (fmt) => {
        setPlaylistFormat(fmt);
        setPlaylistOptions((prev) =>
            prev.map((opt) => ({ ...opt, format: fmt }))
        );
    };

    const applyQualityToAll = (qual) => {
        setPlaylistQuality(qual);
        setPlaylistOptions((prev) =>
            prev.map((opt) => ({ ...opt, quality: qual }))
        );
    };

    const handleDownloadAll = async () => {
        if (!videoInfo?.entries || downloadingAll) return;
        setDownloadingAll(true);
        for (let i = 0; i < videoInfo.entries.length; i++) {
            const entry = videoInfo.entries[i];
            const opts = playlistOptions[i];
            if (opts?.loading) continue; // skip if already downloading
            await handlePlaylistDownload(i, entry);
        }
        setDownloadingAll(false);
    };

    return (
        <div className="container">
            <div className="header">
                <div className="logo">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="#e94560">
                        <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 4-8 4z" />
                    </svg>
                    <h1 className="title">YouTube Downloader</h1>
                </div>
                <p className="subtitle">Download videos and audio from YouTube</p>
            </div>

            <div className="input-wrapper">
                <svg className="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                <input
                    type="text"
                    placeholder="Paste YouTube link here..."
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onBlur={() => { if (url.trim() && !videoInfo && !fetching) fetchInfo(url); }}
                    className="input"
                />
                {url && (
                    <button onClick={() => setUrl("")} className="clear-btn" title="Clear">{"\u2715"}</button>
                )}
            </div>

            {fetching && (
                <div style={{ textAlign: "center" }}>
                    <div className="fetching-bar" />
                    <p className="fetching-text dot-pulse">
                        <span>Analyzing</span> <span>video</span> <span>link...</span>
                    </p>
                </div>
            )}

            {videoInfo && !videoInfo.isPlaylist && (
                <div className="preview fade-in">
                    <div className="thumb-wrap">
                        <img src={videoInfo.thumbnail} alt={videoInfo.title} className="thumbnail" />
                        {videoInfo.duration && <span className="duration-badge">{videoInfo.duration}</span>}
                    </div>
                    <div className="info-section">
                        <h2 className="video-title">{videoInfo.title}</h2>
                        <p className="channel">{videoInfo.channel}</p>
                        <div className="divider" />
                        <div className="options">
                            <div className="option-group">
                                <label className="label">Format</label>
                                <select value={format} onChange={(e) => setFormat(e.target.value)} className="select">
                                    <option value="mp4">MP4 (Video)</option>
                                    <option value="mp3">MP3 (Audio)</option>
                                </select>
                            </div>
                            {format === "mp4" && videoInfo.qualities?.length > 0 && (
                                <div className="option-group">
                                    <label className="label">Quality</label>
                                    <select value={quality} onChange={(e) => setQuality(e.target.value)} className="select">
                                        {videoInfo.qualities.map((q) => (
                                            <option key={q.value} value={q.value}>{q.label}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                        <button onClick={handleSingleDownload} disabled={loading} className="btn">
                            {loading ? (
                                <span className="btn-content">
                                    <span className="spinner" /> Downloading...
                                </span>
                            ) : downloaded ? (
                                <span className="btn-content">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                        <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                    Downloaded
                                </span>
                            ) : (
                                <span className="btn-content">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                        <polyline points="7 10 12 15 17 10" />
                                        <line x1="12" y1="15" x2="12" y2="3" />
                                    </svg>
                                    Download {format.toUpperCase()}
                                </span>
                            )}
                        </button>
                        {progress && (
                            <div className="progress-wrapper">
                                <div className="progress-bar-bg">
                                    <div
                                        className="progress-bar-fill"
                                        style={{ width: progress.percent + "%" }}
                                    />
                                </div>
                                <div className="progress-text">
                                    <span>{progress.percent}%</span>
                                    <span>{progress.percent >= 100 ? "Complete" : "Downloading..."}</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {videoInfo && videoInfo.isPlaylist && videoInfo.entries && (
                <div className="playlist-container fade-in">
                    <div className="playlist-header">
                        <div>
                            <h2 className="playlist-title">{videoInfo.title}</h2>
                            <p className="playlist-meta">{videoInfo.entries.length} videos</p>
                        </div>
                    </div>
                    <div className="playlist-controls">
                        <div className="playlist-controls-left">
                            <div className="option-group">
                                <label className="label">Format (All)</label>
                                <select
                                    value={playlistFormat}
                                    onChange={(e) => applyFormatToAll(e.target.value)}
                                    className="select"
                                >
                                    <option value="mp4">MP4 (Video)</option>
                                    <option value="mp3">MP3 (Audio)</option>
                                </select>
                            </div>
                            {playlistFormat === "mp4" && (
                                <div className="option-group">
                                    <label className="label">Quality (All)</label>
                                    <select
                                        value={playlistQuality}
                                        onChange={(e) => applyQualityToAll(e.target.value)}
                                        className="select"
                                    >
                                        {(() => {
                                            // Collect all qualities that appear in any video
                                            const qualSet = new Set();
                                            videoInfo.entries.forEach((entry) => {
                                                (entry.qualities || []).forEach((q) => qualSet.add(q.value));
                                            });
                                            const quals = [...qualSet].sort((a, b) => b - a);
                                            return quals.map((q) => (
                                                <option key={q} value={q}>{q}p</option>
                                            ));
                                        })()}
                                    </select>
                                </div>
                            )}
                        </div>
                        <button
                            onClick={handleDownloadAll}
                            disabled={downloadingAll}
                            className="btn"
                        >
                            {downloadingAll ? (
                                <span className="btn-content">
                                    <span className="spinner" /> Downloading All...
                                </span>
                            ) : (
                                <span className="btn-content">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                        <polyline points="7 10 12 15 17 10" />
                                        <line x1="12" y1="15" x2="12" y2="3" />
                                    </svg>
                                    Download All
                                </span>
                            )}
                        </button>
                    </div>
                    {videoInfo.entries.map((entry, i) => {
                        const opts = playlistOptions[i] || { format: "mp4", quality: "", loading: false, progress: null };
                        return (
                            <div key={entry.id} className="playlist-item" style={{ animationDelay: `${i * 0.05}s` }}>
                                <span className="item-index">{i + 1}</span>
                                <div className="playlist-thumb-wrap">
                                    {entry.thumbnail && (
                                        <img src={entry.thumbnail} alt={entry.title} className="playlist-thumb" />
                                    )}
                                </div>
                                <div className="playlist-info">
                                    <p className="playlist-item-title">{entry.title}</p>
                                    <p className="channel-small">
                                        {entry.channel}{entry.duration ? ` \u00b7 ${entry.duration}` : ""}
                                    </p>
                                    {opts.progress && (
                                        <div className="playlist-item-progress">
                                            <div
                                                className="playlist-item-progress-fill"
                                                style={{ width: opts.progress.percent + "%" }}
                                            />
                                        </div>
                                    )}
                                </div>
                                <div className="playlist-actions">
                                    <select
                                        value={opts.format}
                                        onChange={(e) => updatePlaylistOption(i, "format", e.target.value)}
                                        className="select-compact"
                                    >
                                        <option value="mp4">MP4</option>
                                        <option value="mp3">MP3</option>
                                    </select>
                                    {opts.format === "mp4" && entry.qualities?.length > 0 && (
                                        <select
                                            value={opts.quality}
                                            onChange={(e) => updatePlaylistOption(i, "quality", e.target.value)}
                                            className="select-compact"
                                        >
                                            {entry.qualities.map((q) => (
                                                <option key={q.value} value={q.value}>{q.label}</option>
                                            ))}
                                        </select>
                                    )}
                                    <button
                                        onClick={() => handlePlaylistDownload(i, entry)}
                                        disabled={opts.loading}
                                        className={opts.downloaded ? "btn-compact btn-downloaded" : "btn-compact"}
                                    >
                                        {opts.loading ? <span className="spinner-small" /> : opts.downloaded ? (
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                <polyline points="20 6 9 17 4 12" />
                                            </svg>
                                        ) : (
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                                <polyline points="7 10 12 15 17 10" />
                                                <line x1="12" y1="15" x2="12" y2="3" />
                                            </svg>
                                        )}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {error && (
                <div className="error-box fade-in">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e94560" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                    <span>{error}</span>
                </div>
            )}
        </div>
    );
}

export default App;
