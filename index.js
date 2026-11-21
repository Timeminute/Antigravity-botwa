const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile, spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const qrcode = require('qrcode-terminal');

// ---------------------------------------------------------------------------
// Bot WA All-in-One (Baileys) - tanpa Chromium, ringan untuk Termux Android
// ---------------------------------------------------------------------------

const termuxPrefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
const termuxBinDir = path.join(termuxPrefix, 'bin');
const homeDir = process.env.HOME || '';

const ffmpegCandidates = [
    path.join(termuxBinDir, 'ffmpeg'),
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
];
const ffmpegPath = ffmpegCandidates.find((p) => fs.existsSync(p)) || 'ffmpeg';

const ytDlpCandidates = [
    path.join(termuxBinDir, 'yt-dlp'),
    homeDir ? path.join(homeDir, '.local', 'bin', 'yt-dlp') : '',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp'
];
const ytDlpPath = ytDlpCandidates.find((p) => p && fs.existsSync(p)) || 'yt-dlp';

const agyCandidates = [
    path.join(termuxBinDir, 'agy'),
    homeDir ? path.join(homeDir, '.local', 'bin', 'agy') : '',
    '/usr/local/bin/agy',
    '/usr/bin/agy'
];
const agyPath = process.env.AGY_PATH || agyCandidates.find((p) => p && fs.existsSync(p)) || 'agy';

// Konversi format Markdown standar AI ke format WhatsApp
function formatKeWhatsApp(teks) {
    if (!teks) return '';
    return teks
        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') // Hapus ANSI escape sequences
        .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')   // Markdown header -> *BOLD*
        .replace(/\*\*(.+?)\*\*/g, '*$1*')     // **bold** -> *bold*
        .replace(/~~(.+?)~~/g, '~$1~')         // ~~strikethrough~~ -> ~strikethrough~
        .trim();
}

// Menjalankan perintah Antigravity (agy -p "<pertanyaan>") secara headless
function tanyaAgy(pertanyaan, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const proses = spawn(agyPath, ['-p', pertanyaan]);
        let output = '';
        let errorOutput = '';

        const timer = setTimeout(() => {
            try {
                proses.kill();
            } catch {}
            reject(new Error('Waktu tunggu balasan AI habis (Timeout 120 detik).'));
        }, timeoutMs);

        proses.stdout.on('data', (data) => {
            output += data.toString();
        });

        proses.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        proses.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(new Error(errorOutput.trim() || `Proses agy keluar dengan kode ${code}`));
            }
        });

        proses.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

const tempDir = path.join(__dirname, 'temp_downloads');
const authDir = path.join(__dirname, 'auth_info');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
for (const file of fs.readdirSync(tempDir)) {
    try {
        fs.unlinkSync(path.join(tempDir, file));
    } catch {}
}

const pendingYoutubeChoices = new Map();
const CHOICE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

let sock = null;
let baileys = null;
let baileysLogger = null;

function isSafePublicUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;

        const hostname = parsed.hostname.toLowerCase();
        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '::1' ||
            hostname.startsWith('192.168.') ||
            hostname.startsWith('10.') ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
        ) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

function getCleanHostname(rawUrl) {
    try {
        return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return '';
    }
}

function isYoutubeUrl(rawUrl) {
    const h = getCleanHostname(rawUrl);
    return h === 'youtube.com' || h === 'm.youtube.com' || h === 'music.youtube.com' || h === 'youtu.be';
}

function isInstagramUrl(rawUrl) {
    const h = getCleanHostname(rawUrl);
    return h === 'instagram.com' || h === 'instagr.am';
}

function isTikTokUrl(rawUrl) {
    const h = getCleanHostname(rawUrl);
    return h === 'tiktok.com' || h.endsWith('.tiktok.com');
}

function isFacebookUrl(rawUrl) {
    const h = getCleanHostname(rawUrl);
    return (
        h === 'facebook.com' ||
        h.endsWith('.facebook.com') ||
        h === 'fb.watch' ||
        h === 'fb.com' ||
        h === 'fb.gg'
    );
}

function isTwitterUrl(rawUrl) {
    const h = getCleanHostname(rawUrl);
    return h === 'x.com' || h === 'twitter.com' || h === 'mobile.twitter.com' || h === 't.co';
}

function isThreadsUrl(rawUrl) {
    const h = getCleanHostname(rawUrl);
    return h === 'threads.net' || h === 'threads.com';
}

function safeUnlink(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch {}
    }
}

// Memastikan video berformat MP4 (H.264 + AAC + yuv420p) agar tidak melempar "Error: t" di WhatsApp Web
function ensureWhatsAppCompatibleVideo(inputPath) {
    return new Promise((resolve) => {
        execFile(ffmpegPath, ['-i', inputPath], (err, stdout, stderr) => {
            const info = (stderr || '') + (stdout || '');
            const isH264 = /Video:\s*h264/i.test(info);
            const isYuv420p = /yuv420p/i.test(info);
            const isMp4Ext = inputPath.toLowerCase().endsWith('.mp4');

            if (isH264 && isYuv420p && isMp4Ext) {
                return resolve(inputPath);
            }

            console.log('[FFmpeg] Mengonversi codec video ke H.264 agar kompatibel dengan WhatsApp...');
            const outputPath = path.join(
                tempDir,
                `wa_h264_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`
            );

            const args = [
                '-y',
                '-i', inputPath,
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '26',
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart',
                outputPath
            ];

            execFile(ffmpegPath, args, { timeout: 120000 }, (convErr) => {
                if (!convErr && fs.existsSync(outputPath)) {
                    safeUnlink(inputPath);
                    resolve(outputPath);
                } else {
                    resolve(inputPath);
                }
            });
        });
    });
}

function extractJsonStringLiteral(text, keyName) {
    const keyIdx = text.indexOf(`"${keyName}"`);
    if (keyIdx === -1) return null;

    const colonIdx = text.indexOf(':', keyIdx + keyName.length + 2);
    if (colonIdx === -1) return null;

    const startQuote = text.indexOf('"', colonIdx + 1);
    if (startQuote === -1) return null;

    let i = startQuote + 1;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '"') {
            const rawLiteral = text.slice(startQuote, i + 1);
            return JSON.parse(rawLiteral);
        }
        i++;
    }
    return null;
}

function extractBalancedJsonObject(text, startSearchIdx) {
    const firstBrace = text.indexOf('{', startSearchIdx);
    if (firstBrace === -1) return null;

    let depth = 0;
    let inString = false;
    let i = firstBrace;

    while (i < text.length) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
        } else {
            if (ch === '"') {
                inString = true;
            } else if (ch === '{') {
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    return text.slice(firstBrace, i + 1);
                }
            }
        }
        i++;
    }
    return null;
}

function parseInstagramShortcodeMedia(media) {
    if (!media) return [];
    const results = [];

    const extractNode = (node) => {
        if (!node) return;
        const videoUrl =
            node.video_url ||
            (Array.isArray(node.video_versions) && node.video_versions[0]?.url) ||
            (Array.isArray(node.video_resources) && node.video_resources[0]?.src);

        if ((node.is_video || node.media_type === 2) && videoUrl) {
            results.push({ type: 'video', url: videoUrl });
            return;
        }

        const resources = node.display_resources;
        const highResImg =
            node.display_url ||
            (Array.isArray(resources) && resources.length > 0
                ? resources[resources.length - 1].src
                : null) ||
            (Array.isArray(node.image_versions2?.candidates) && node.image_versions2.candidates[0]?.url) ||
            node.thumbnail_src;

        if (highResImg) {
            results.push({ type: 'image', url: highResImg });
        }
    };

    const sidecarEdges = media.edge_sidecar_to_children?.edges;
    if (Array.isArray(sidecarEdges) && sidecarEdges.length > 0) {
        for (const edge of sidecarEdges) {
            extractNode(edge?.node || edge);
        }
    } else if (Array.isArray(media.carousel_media) && media.carousel_media.length > 0) {
        for (const item of media.carousel_media) {
            extractNode(item);
        }
    } else {
        extractNode(media);
    }

    return results;
}

function parseEmbedHtmlForMedia(html) {
    const addIdx = html.indexOf('__additionalDataLoaded');
    if (addIdx !== -1) {
        const jsonStr = extractBalancedJsonObject(html, addIdx);
        if (jsonStr) {
            try {
                const parsed = JSON.parse(jsonStr);
                const media = parsed?.shortcode_media || parsed?.gql_data?.shortcode_media || parsed;
                const items = parseInstagramShortcodeMedia(media);
                if (items.length > 0) return items;
            } catch {}
        }
    }

    try {
        const unescapedContext = extractJsonStringLiteral(html, 'contextJSON');
        if (unescapedContext) {
            const contextData = JSON.parse(unescapedContext);
            const shortcodeMedia =
                contextData?.gql_data?.shortcode_media ||
                contextData?.gql_data?.xdt_shortcode_media ||
                contextData?.shortcode_media;
            const items = parseInstagramShortcodeMedia(shortcodeMedia);
            if (items.length > 0) return items;
        }
    } catch {}

    return [];
}

async function extractInstagramMedia(rawUrl) {
    let targetUrl = rawUrl;
    if (/\/share\//i.test(rawUrl)) {
        try {
            const redirRes = await fetch(rawUrl, {
                redirect: 'follow',
                signal: AbortSignal.timeout(15000),
                headers: { 'User-Agent': USER_AGENT }
            });
            targetUrl = redirRes.url;
            if (redirRes.body) await redirRes.body.cancel();
        } catch {}
    }

    const match = targetUrl.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    if (!match) return [];
    const shortcode = match[1];

    try {
        const variables = JSON.stringify({
            shortcode: shortcode,
            child_comment_count: 3,
            fetch_comment_count: 40,
            parent_comment_count: 24,
            has_threaded_comments: true
        });
        const gqlGetUrl = `https://www.instagram.com/graphql/query/?hl=en&query_hash=9f8827793ef34641b2fb195d4d41151c&variables=${encodeURIComponent(variables)}`;

        const gqlGetRes = await fetch(gqlGetUrl, {
            signal: AbortSignal.timeout(15000),
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': '*/*',
                'X-IG-App-ID': '936619743392459',
                'X-ASBD-ID': '198387',
                'X-IG-WWW-Claim': '0',
                'Origin': 'https://www.instagram.com',
                'Referer': `https://www.instagram.com/p/${shortcode}/`
            }
        });

        if (gqlGetRes.ok) {
            const json = await gqlGetRes.json();
            const media = json?.data?.shortcode_media || json?.data?.xdt_shortcode_media;
            const items = parseInstagramShortcodeMedia(media);
            if (items.length > 0) {
                console.log(`[IG] Berhasil mengekstrak ${items.length} slide via GraphQL.`);
                return items;
            }
        }
    } catch {}

    for (const suffix of ['embed/', 'embed/captioned/']) {
        try {
            const embedUrl = `https://www.instagram.com/p/${shortcode}/${suffix}`;
            const embedRes = await fetch(embedUrl, {
                signal: AbortSignal.timeout(15000),
                headers: { 'User-Agent': USER_AGENT }
            });

            if (embedRes.ok) {
                const html = await embedRes.text();
                const items = parseEmbedHtmlForMedia(html);
                if (items.length > 0) {
                    console.log(`[IG] Berhasil mengekstrak ${items.length} slide via Embed.`);
                    return items;
                }
            }
        } catch {}
    }

    return [];
}

async function extractTikTokMedia(rawUrl) {
    try {
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(rawUrl)}&hd=1`;
        const res = await fetch(apiUrl, {
            signal: AbortSignal.timeout(20000),
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'application/json'
            }
        });

        if (res.ok) {
            const json = await res.json();
            const data = json?.data;
            if (data) {
                if (Array.isArray(data.images) && data.images.length > 0) {
                    console.log(`[TikTok] Mendeteksi ${data.images.length} slide foto.`);
                    return data.images.map((imgUrl) => ({ type: 'image', url: imgUrl }));
                }

                // Prioritaskan stream H.264 play agar ringan & kompatibel
                const videoUrl = data.play || data.hdplay || data.wmplay;
                if (videoUrl) {
                    const fullVideoUrl = videoUrl.startsWith('http')
                        ? videoUrl
                        : `https://www.tikwm.com${videoUrl}`;
                    console.log('[TikTok] Berhasil mendapatkan stream video via TikWM.');
                    return [{ type: 'video', url: fullVideoUrl }];
                }
            }
        }
    } catch (err) {
        console.warn('[TikTok] TikWM API dilewati, beralih ke yt-dlp:', err.message);
    }
    return [];
}

async function extractTwitterMedia(rawUrl) {
    let targetUrl = rawUrl;
    if (getCleanHostname(rawUrl) === 't.co') {
        try {
            const redir = await fetch(rawUrl, {
                redirect: 'follow',
                signal: AbortSignal.timeout(15000),
                headers: { 'User-Agent': USER_AGENT }
            });
            targetUrl = redir.url;
            if (redir.body) await redir.body.cancel();
        } catch {}
    }

    const match = targetUrl.match(/(?:twitter\.com|x\.com)\/(?:[^/]+)\/status\/(\d+)/i);
    if (!match) return [];
    const statusId = match[1];

    try {
        const res = await fetch(`https://api.fxtwitter.com/status/${statusId}`, {
            signal: AbortSignal.timeout(15000),
            headers: { 'User-Agent': USER_AGENT }
        });
        if (res.ok) {
            const json = await res.json();
            const allMedia = json?.tweet?.media?.all;
            if (Array.isArray(allMedia) && allMedia.length > 0) {
                console.log(`[X/Twitter] Menemukan ${allMedia.length} media via FxTwitter.`);
                return allMedia.map((m) => ({
                    type: m.type === 'video' || m.type === 'gif' ? 'video' : 'image',
                    url: m.url
                }));
            }
        }
    } catch {}

    try {
        const res = await fetch(`https://api.vxtwitter.com/Twitter/status/${statusId}`, {
            signal: AbortSignal.timeout(15000),
            headers: { 'User-Agent': USER_AGENT }
        });
        if (res.ok) {
            const json = await res.json();
            const extMedia = json?.media_extended;
            if (Array.isArray(extMedia) && extMedia.length > 0) {
                console.log(`[X/Twitter] Menemukan ${extMedia.length} media via VxTwitter.`);
                return extMedia.map((m) => ({
                    type: m.type === 'video' || m.type === 'gif' ? 'video' : 'image',
                    url: m.url
                }));
            }
        }
    } catch {}

    return [];
}

async function extractThreadsMedia(rawUrl) {
    const match = rawUrl.match(/threads\.(?:net|com)\/(?:@[^/]+\/post|t)\/([A-Za-z0-9_-]+)/i);
    const shortcode = match ? match[1] : null;

    if (shortcode) {
        try {
            const embedUrl = `https://www.threads.net/@_/post/${shortcode}/embed/`;
            const res = await fetch(embedUrl, {
                signal: AbortSignal.timeout(15000),
                headers: { 'User-Agent': USER_AGENT }
            });

            if (res.ok) {
                const html = await res.text();
                const items = [];
                const seen = new Set();

                const videoMatches = html.matchAll(/<source[^>]+src=["']([^"']+)["']/gi);
                for (const m of videoMatches) {
                    const vUrl = m[1].replace(/&amp;/g, '&');
                    if (!seen.has(vUrl)) {
                        seen.add(vUrl);
                        items.push({ type: 'video', url: vUrl });
                    }
                }

                const imgMatches = html.matchAll(/<img[^>]+class=["'][^"']*SingleInnerMedia[^"']*["'][^>]+src=["']([^"']+)["']/gi);
                for (const m of imgMatches) {
                    const iUrl = m[1].replace(/&amp;/g, '&');
                    if (!seen.has(iUrl)) {
                        seen.add(iUrl);
                        items.push({ type: 'image', url: iUrl });
                    }
                }

                if (items.length > 0) {
                    console.log(`[Threads] Menemukan ${items.length} media via Embed.`);
                    return items;
                }
            }
        } catch {}
    }

    return [];
}

async function inspectUrlSafe(url) {
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(15000),
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
            }
        });

        if (!res.ok) return { type: 'unknown', directUrl: url, ogImageUrl: null };
        if (!isSafePublicUrl(res.url)) {
            if (res.body) await res.body.cancel();
            return { type: 'unknown', directUrl: url, ogImageUrl: null };
        }

        const contentType = (res.headers.get('content-type') || '').toLowerCase();

        if (contentType.startsWith('image/')) {
            if (res.body) await res.body.cancel();
            return { type: 'image', directUrl: res.url };
        }

        if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
            if (res.body) await res.body.cancel();
            return { type: 'direct_file', directUrl: res.url, contentType };
        }

        const html = await res.text();
        const ogMatch =
            html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);

        let ogImageUrl = ogMatch ? ogMatch[1].replace(/&amp;/g, '&') : null;
        if (ogImageUrl && ogImageUrl.startsWith('/')) {
            ogImageUrl = new URL(ogImageUrl, res.url).href;
        }

        return { type: 'webpage', directUrl: res.url, ogImageUrl };
    } catch {
        return { type: 'unknown', directUrl: url, ogImageUrl: null };
    }
}

function runYtDlpProcess(url, mode, allowPlaylist, extraArgs = []) {
    return new Promise((resolve, reject) => {
        const fileId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const outputTemplate = path.join(tempDir, `${fileId}_%(autonumber)s.%(ext)s`);

        const videoFormat =
            'bestvideo[vcodec^=avc1][height<=720]+bestaudio[ext=m4a]/' +
            'best[vcodec^=avc1][ext=mp4][height<=720]/' +
            'best[ext=mp4][filesize<95M]/' +
            'bestvideo[height<=720]+bestaudio/' +
            'best';

        const playlistFlag = allowPlaylist ? '--yes-playlist' : '--no-playlist';

        const commonFlags = [
            '--js-runtimes', 'node',
            '--remote-components', 'ejs:github',
            '--ffmpeg-location', ffmpegPath,
            playlistFlag,
            '--max-filesize', '100M',
            ...extraArgs,
            '-o', outputTemplate,
            url
        ];

        const args = mode === 'audio'
            ? [
                '-f', 'bestaudio/best',
                '-x',
                '--audio-format', 'mp3',
                '--audio-quality', '0',
                ...commonFlags
            ]
            : [
                '-f', videoFormat,
                '-S', 'vcodec:h264,res:720,acodec:m4a',
                '--merge-output-format', 'mp4',
                ...commonFlags
            ];

        const nodeDir = path.dirname(process.execPath);
        const envWithNode = {
            ...process.env,
            PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}`
        };

        execFile(
            ytDlpPath,
            args,
            { maxBuffer: 1024 * 1024 * 100, timeout: 150000, env: envWithNode },
            (error, stdout, stderr) => {
                const downloadedFiles = fs
                    .readdirSync(tempDir)
                    .filter((file) => file.startsWith(fileId))
                    .sort()
                    .map((file) => path.join(tempDir, file));

                if (downloadedFiles.length === 0) {
                    return reject(new Error(stderr || (error ? error.message : 'File hasil unduhan tidak ditemukan.')));
                }

                resolve(downloadedFiles);
            }
        );
    });
}

async function downloadWithYtDlp(url, mode = 'video', allowPlaylist = false) {
    try {
        return await runYtDlpProcess(url, mode, allowPlaylist);
    } catch (firstErr) {
        if (isYoutubeUrl(url)) {
            console.warn('[YouTube] Percobaan pertama gagal, mencoba ulang dengan player_client alternatif...');
            return await runYtDlpProcess(url, mode, allowPlaylist, [
                '--extractor-args', 'youtube:player_client=android_vr,tv,mweb'
            ]);
        }
        throw firstErr;
    }
}

function setYoutubeSession(chatId, url) {
    const existing = pendingYoutubeChoices.get(chatId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
        pendingYoutubeChoices.delete(chatId);
    }, CHOICE_TIMEOUT_MS);

    pendingYoutubeChoices.set(chatId, { url, timer });
}

function clearYoutubeSession(chatId) {
    const existing = pendingYoutubeChoices.get(chatId);
    if (existing) {
        clearTimeout(existing.timer);
        pendingYoutubeChoices.delete(chatId);
    }
}


// ---------------------------------------------------------------------------
// Pengiriman pesan (Baileys)
// ---------------------------------------------------------------------------

async function sendText(jid, text, quoted) {
    await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
}

async function react(msg, emoji) {
    try {
        await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });
    } catch {}
}

function runFfmpeg(args, timeout = 120000) {
    return new Promise((resolve, reject) => {
        execFile(ffmpegPath, args, { timeout }, (err, _stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message || '').slice(-400)));
            resolve();
        });
    });
}

function uid() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// Membuat stiker WebP 512x512 (gambar statis atau video/GIF animasi) memakai ffmpeg
async function makeSticker(buffer, isVideo) {
    const id = uid();
    const inPath = path.join(tempDir, `st_in_${id}`);
    const outPath = path.join(tempDir, `st_out_${id}.webp`);
    fs.writeFileSync(inPath, buffer);

    const vf =
        'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,' +
        'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0';
    const qualities = isVideo ? [45, 30, 18] : [80, 60];
    const maxBytes = isVideo ? 900 * 1024 : 1000 * 1024;

    try {
        let out = null;
        for (const q of qualities) {
            const args = ['-y', '-i', inPath];
            if (isVideo) {
                args.push('-t', '8', '-vf', `fps=12,${vf}`, '-loop', '0');
            } else {
                args.push('-frames:v', '1', '-vf', vf);
            }
            args.push('-an', '-c:v', 'libwebp', '-q:v', String(q), '-compression_level', '6', outPath);
            await runFfmpeg(args);
            out = fs.readFileSync(outPath);
            if (out.length <= maxBytes) break;
        }
        return out;
    } finally {
        safeUnlink(inPath);
        safeUnlink(outPath);
    }
}

async function toJpeg(buffer) {
    const id = uid();
    const inPath = path.join(tempDir, `img_in_${id}`);
    const outPath = path.join(tempDir, `img_out_${id}.jpg`);
    fs.writeFileSync(inPath, buffer);
    try {
        await runFfmpeg(['-y', '-i', inPath, '-frames:v', '1', '-q:v', '2', outPath], 60000);
        return fs.readFileSync(outPath);
    } finally {
        safeUnlink(inPath);
        safeUnlink(outPath);
    }
}

async function sendImageBuffer(jid, buffer, contentType, asSticker, quoted) {
    const opts = quoted ? { quoted } : undefined;
    if (asSticker) {
        const webp = await makeSticker(buffer, false);
        await sock.sendMessage(jid, { sticker: webp }, opts);
        return;
    }
    let sendBuf = buffer;
    let mime = contentType;
    if (!/image\/(jpeg|jpg|png)/i.test(contentType)) {
        try {
            sendBuf = await toJpeg(buffer);
            mime = 'image/jpeg';
        } catch {}
    }
    try {
        await sock.sendMessage(jid, { image: sendBuf, mimetype: mime }, opts);
    } catch {
        console.warn('[WA] Gagal kirim sebagai gambar, mengirim sebagai dokumen...');
        await sock.sendMessage(
            jid,
            { document: sendBuf, mimetype: mime, fileName: `gambar_${Date.now()}.jpg` },
            opts
        );
    }
}

async function sendVideoFileFromDisk(jid, rawFilePath, quoted) {
    const opts = quoted ? { quoted } : undefined;
    let finalPath = rawFilePath;
    try {
        finalPath = await ensureWhatsAppCompatibleVideo(rawFilePath);
        const sizeMB = fs.statSync(finalPath).size / (1024 * 1024);
        if (sizeMB > 60) {
            await sock.sendMessage(
                jid,
                { document: { url: finalPath }, mimetype: 'video/mp4', fileName: `video_${Date.now()}.mp4` },
                opts
            );
            return;
        }
        try {
            await sock.sendMessage(jid, { video: { url: finalPath }, mimetype: 'video/mp4' }, opts);
        } catch (err) {
            console.warn('[WA] Gagal kirim sebagai video, mengirim sebagai dokumen...', err.message);
            await sock.sendMessage(
                jid,
                { document: { url: finalPath }, mimetype: 'video/mp4', fileName: `video_${Date.now()}.mp4` },
                opts
            );
        }
    } finally {
        safeUnlink(rawFilePath);
        if (finalPath !== rawFilePath) safeUnlink(finalPath);
    }
}

async function sendAudioFileFromDisk(jid, filePath, quoted) {
    const opts = quoted ? { quoted } : undefined;
    try {
        await sock.sendMessage(jid, { audio: { url: filePath }, mimetype: 'audio/mpeg' }, opts);
    } catch {
        await sock.sendMessage(
            jid,
            { document: { url: filePath }, mimetype: 'audio/mpeg', fileName: `audio_${Date.now()}.mp3` },
            opts
        );
    }
}

async function downloadUrlToTempFile(mediaUrl, referer = '', defaultExt = 'mp4') {
    const headers = { 'User-Agent': USER_AGENT, Accept: '*/*' };
    if (referer) headers['Referer'] = referer;

    const res = await fetch(mediaUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120000),
        headers
    });
    if (!res.ok) throw new Error(`Gagal mengunduh stream media (${res.status})`);

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_DOWNLOAD_BYTES) {
        if (res.body) await res.body.cancel();
        throw new Error('File terlalu besar (maks 100 MB).');
    }

    const filePath = path.join(tempDir, `stream_${uid()}.${defaultExt}`);
    try {
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(filePath));
    } catch (err) {
        safeUnlink(filePath);
        throw err;
    }
    if (fs.statSync(filePath).size > MAX_DOWNLOAD_BYTES) {
        safeUnlink(filePath);
        throw new Error('File terlalu besar (maks 100 MB).');
    }
    return filePath;
}

async function fetchImageBuffer(mediaUrl, referer = 'https://www.instagram.com/') {
    const res = await fetch(mediaUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
        headers: {
            'User-Agent': USER_AGENT,
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            Referer: referer
        }
    });
    if (!res.ok) throw new Error(`Gagal mengunduh file media (${res.status})`);
    const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
}

async function sendExtractedMediaItems(jid, items, referer, makeStickerFlag, quoted) {
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        console.log(`Mengirim media ${i + 1}/${items.length} (${item.type})...`);

        if (item.type === 'video') {
            const tempVideo = await downloadUrlToTempFile(item.url, referer, 'mp4');
            await sendVideoFileFromDisk(jid, tempVideo, quoted);
        } else {
            const { buffer, contentType } = await fetchImageBuffer(item.url, referer);
            await sendImageBuffer(jid, buffer, contentType, makeStickerFlag, quoted);
        }
    }
}

async function downloadAndSendViaYtDlp(jid, url, mode = 'video', allowPlaylist = true, quoted) {
    const filePaths = await downloadWithYtDlp(url, mode, allowPlaylist);
    try {
        for (const filePath of filePaths) {
            if (mode === 'audio') {
                await sendAudioFileFromDisk(jid, filePath, quoted);
                safeUnlink(filePath);
            } else {
                await sendVideoFileFromDisk(jid, filePath, quoted);
            }
        }
    } finally {
        for (const filePath of filePaths) safeUnlink(filePath);
    }
}


// ---------------------------------------------------------------------------
// Penanganan pesan masuk
// ---------------------------------------------------------------------------

function unwrapContent(message) {
    let m = message;
    for (let i = 0; i < 5 && m; i++) {
        const inner =
            m.ephemeralMessage?.message ||
            m.viewOnceMessage?.message ||
            m.viewOnceMessageV2?.message ||
            m.viewOnceMessageV2Extension?.message ||
            m.documentWithCaptionMessage?.message ||
            m.editedMessage?.message;
        if (!inner) break;
        m = inner;
    }
    return m || {};
}

function extractText(content) {
    return (
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        ''
    ).trim();
}

async function handleMessage(msg) {
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;

    const content = unwrapContent(msg.message);
    const text = extractText(content);

    try {
        if (pendingYoutubeChoices.has(jid)) {
            const normalized = text.toLowerCase();

            if (normalized === 'batal' || normalized === 'cancel' || normalized === '0') {
                clearYoutubeSession(jid);
                await sendText(jid, 'Unduhan YouTube dibatalkan.', msg);
                return;
            }

            const isVideoChoice = normalized === '1' || normalized === 'video';
            const isMusicChoice = ['2', 'music', 'musik', 'mp3', 'audio'].includes(normalized);

            if (isVideoChoice || isMusicChoice) {
                const session = pendingYoutubeChoices.get(jid);
                clearYoutubeSession(jid);
                const mode = isMusicChoice ? 'audio' : 'video';

                await react(msg, '⏳');
                await downloadAndSendViaYtDlp(jid, session.url, mode, false, msg);
                await react(msg, '✅');
                return;
            }
        }

        // Gambar / video / GIF yang dikirim langsung -> jadikan stiker
        const mediaNode = content.imageMessage || content.videoMessage;
        if (mediaNode) {
            const isVideo = Boolean(content.videoMessage);
            console.log(`Memproses stiker ${isVideo ? 'video/GIF' : 'gambar'} dari ${jid}...`);
            const buffer = await baileys.downloadMediaMessage(
                msg,
                'buffer',
                {},
                { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage }
            );
            const webp = await makeSticker(buffer, isVideo);
            await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
            return;
        }

        const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
        if (!urlMatch) {
            // ===============================================================
            // LOGIKA CHAT BIASA (NON-LINK) -> DITERUSKAN KE ANTIGRAVITY (AGY)
            // ===============================================================
            if (!text || text.length === 0) return;

            const isGroup = jid.endsWith('@g.us');
            const botJid = sock?.user?.id ? sock.user.id.split(':')[0] : '';
            const contextInfo = content.extendedTextMessage?.contextInfo;
            const isMentioned = botJid && contextInfo?.mentionedJid?.some((m) => m.includes(botJid));
            const isReplyToBot = botJid && contextInfo?.participant?.includes(botJid);
            const prefixMatch = text.match(/^([.!\/]?(ai|agy)\b\s*)/i);

            // Di grup: proses jika bot di-mention, me-reply pesan bot, ada awalan .ai/.agy, atau jika AI_GROUP_ALL=1
            if (isGroup && process.env.AI_GROUP_ALL !== '1' && !isMentioned && !isReplyToBot && !prefixMatch) {
                return;
            }

            // Bersihkan prefix jika ada (misal: ".ai halo" -> "halo")
            let promptText = text;
            if (prefixMatch) {
                promptText = text.slice(prefixMatch[0].length).trim();
            }
            if (!promptText) promptText = text;

            console.log(`[AI agy] Pertanyaan dari ${jid}: "${promptText.slice(0, 50)}${promptText.length > 50 ? '...' : ''}"`);
            await react(msg, '🤖');

            try {
                if (sock?.sendPresenceUpdate) {
                    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
                }

                const balasan = await tanyaAgy(promptText);
                if (balasan) {
                    await sendText(jid, formatKeWhatsApp(balasan), msg);
                    await react(msg, '✅');
                } else {
                    await sendText(jid, 'Maaf, AI tidak memberikan balasan.', msg);
                    await react(msg, '⚠️');
                }
            } catch (aiErr) {
                console.error('[AI agy] Gagal merespons:', aiErr.message || aiErr);
                await react(msg, '❌');
                await sendText(
                    jid,
                    `⚠️ Terjadi kesalahan saat memproses jawaban AI:\n_${aiErr.message || 'Gagal menjalankan perintah agy'}_`,
                    msg
                );
            } finally {
                if (sock?.sendPresenceUpdate) {
                    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
                }
            }
            return;
        }

        const url = urlMatch[0];
        if (!isSafePublicUrl(url)) throw new Error('URL tidak valid.');

        if (isYoutubeUrl(url)) {
            setYoutubeSession(jid, url);
            await sendText(
                jid,
                'Link YouTube terdeteksi. Pilih format unduhan dengan membalas:\n\n' +
                    '*1* atau *video* (Unduh Video MP4)\n' +
                    '*2* atau *music* (Unduh Audio MP3)\n\n' +
                    '_(Ketik *0* untuk batal, berlaku 2 menit)_',
                msg
            );
            return;
        }

        const makeStickerFlag = /\bstiker\b/i.test(text);
        console.log(`Mendeteksi link dari ${jid}: ${url}`);
        await react(msg, '⏳');

        if (isInstagramUrl(url)) {
            const items = await extractInstagramMedia(url);
            if (items.length > 0) {
                await sendExtractedMediaItems(jid, items, 'https://www.instagram.com/', makeStickerFlag, msg);
                await react(msg, '✅');
                return;
            }
        }

        if (isTikTokUrl(url)) {
            const items = await extractTikTokMedia(url);
            if (items.length > 0) {
                await sendExtractedMediaItems(jid, items, 'https://www.tiktok.com/', makeStickerFlag, msg);
                await react(msg, '✅');
                return;
            }
            await downloadAndSendViaYtDlp(jid, url, 'video', true, msg);
            await react(msg, '✅');
            return;
        }

        if (isTwitterUrl(url)) {
            const items = await extractTwitterMedia(url);
            if (items.length > 0) {
                await sendExtractedMediaItems(jid, items, 'https://x.com/', makeStickerFlag, msg);
                await react(msg, '✅');
                return;
            }
            await downloadAndSendViaYtDlp(jid, url, 'video', true, msg);
            await react(msg, '✅');
            return;
        }

        if (isThreadsUrl(url)) {
            const items = await extractThreadsMedia(url);
            if (items.length > 0) {
                await sendExtractedMediaItems(jid, items, 'https://www.threads.net/', makeStickerFlag, msg);
                await react(msg, '✅');
                return;
            }
        }

        if (isFacebookUrl(url)) {
            await downloadAndSendViaYtDlp(jid, url, 'video', true, msg);
            await react(msg, '✅');
            return;
        }

        const info = await inspectUrlSafe(url);

        if (info.type === 'image') {
            const { buffer, contentType } = await fetchImageBuffer(info.directUrl, url);
            await sendImageBuffer(jid, buffer, contentType, makeStickerFlag, msg);
            await react(msg, '✅');
            return;
        }

        if (info.type === 'direct_file') {
            const ct = (info.contentType || '').toLowerCase();
            if (ct.startsWith('video/')) {
                const tmp = await downloadUrlToTempFile(info.directUrl, url, 'mp4');
                await sendVideoFileFromDisk(jid, tmp, msg);
            } else {
                const ext = (path.extname(new URL(info.directUrl).pathname) || '.bin').slice(1, 8);
                const tmp = await downloadUrlToTempFile(info.directUrl, url, ext);
                try {
                    await sock.sendMessage(
                        jid,
                        {
                            document: { url: tmp },
                            mimetype: ct.split(';')[0] || 'application/octet-stream',
                            fileName: `file_${Date.now()}.${ext}`
                        },
                        { quoted: msg }
                    );
                } finally {
                    safeUnlink(tmp);
                }
            }
            await react(msg, '✅');
            return;
        }

        try {
            await downloadAndSendViaYtDlp(jid, info.directUrl || url, 'video', true, msg);
            await react(msg, '✅');
        } catch (ytError) {
            if (info.ogImageUrl) {
                const { buffer, contentType } = await fetchImageBuffer(info.ogImageUrl, url);
                await sendImageBuffer(jid, buffer, contentType, makeStickerFlag, msg);
                await react(msg, '✅');
            } else {
                throw ytError;
            }
        }
    } catch (error) {
        console.error('Terjadi kesalahan:', error.message || error);
        await react(msg, '❌');
        await sendText(
            jid,
            'Gagal mengunduh media. Pastikan link bersifat publik, valid, dan bukan akun private.',
            msg
        ).catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Koneksi WhatsApp (Baileys)
// ---------------------------------------------------------------------------

function askQuestion(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

function normalizePhone(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (digits.startsWith('0')) digits = '62' + digits.slice(1);
    return digits;
}

let cachedPhone = null;
let reconnecting = false;
let messageQueue = Promise.resolve();

async function startSocket() {
    const {
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        fetchLatestBaileysVersion,
        Browsers,
        makeCacheableSignalKeyStore
    } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    let version;
    try {
        ({ version } = await fetchLatestBaileysVersion());
    } catch {}

    sock = makeWASocket({
        ...(version ? { version } : {}),
        logger: baileysLogger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
        },
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
    });

    const currentSock = sock;
    let pairingRequested = false;

    currentSock.ev.on('creds.update', saveCreds);

    currentSock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !state.creds.registered && !pairingRequested) {
            pairingRequested = true;

            if (process.env.USE_QR === '1') {
                console.log('Scan QR Code ini menggunakan WhatsApp di perangkat lain:');
                qrcode.generate(qr, { small: true });
                pairingRequested = false;
                return;
            }

            try {
                if (!cachedPhone) {
                    cachedPhone = normalizePhone(process.env.WA_NUMBER);
                }
                if (!cachedPhone && process.stdin.isTTY) {
                    console.log('');
                    cachedPhone = normalizePhone(
                        await askQuestion('Masukkan nomor WhatsApp bot (contoh 6281234567890): ')
                    );
                }
                if (!cachedPhone) {
                    console.log('Nomor tidak tersedia. Jalankan dengan: WA_NUMBER=628xxxx node index.js');
                    console.log('Atau pakai QR dari perangkat lain: USE_QR=1 node index.js');
                    process.exit(1);
                }

                const code = await currentSock.requestPairingCode(cachedPhone);
                const pretty = code.match(/.{1,4}/g).join('-');
                console.log('');
                console.log('==========================================');
                console.log(`  KODE PAIRING: ${pretty}`);
                console.log('==========================================');
                console.log('Di HP: WhatsApp > Perangkat Tertaut > Tautkan Perangkat');
                console.log('> "Tautkan dengan nomor telepon saja" > masukkan kode di atas.');
                console.log('(Kode berlaku sebentar, segera masukkan.)');
                console.log('');
            } catch (err) {
                console.error('[Bot WA] Gagal meminta kode pairing:', err.message || err);
                process.exit(1);
            }
        }

        if (connection === 'open') {
            console.log('Bot WA (All-in-One Downloader: IG, TikTok, FB, X, Threads, YouTube & Stiker) aktif!');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`[Bot WA] Koneksi terputus (kode: ${statusCode ?? 'tidak diketahui'}).`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('[Bot WA] Sesi keluar dari WhatsApp. Menghapus sesi lama, jalankan ulang untuk login.');
                fs.rmSync(authDir, { recursive: true, force: true });
                process.exit(1);
            }

            if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('[Bot WA] Sesi dipakai di tempat lain. Berhenti.');
                process.exit(1);
            }

            if (reconnecting) return;
            reconnecting = true;
            const delay = statusCode === DisconnectReason.restartRequired ? 500 : 3000;
            setTimeout(async () => {
                reconnecting = false;
                try {
                    await startSocket();
                } catch (err) {
                    console.error('[Bot WA] Gagal menyambung ulang:', err.message || err);
                    process.exit(1);
                }
            }, delay);
        }
    });

    currentSock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const m of messages) {
            // Antrian berurutan agar ffmpeg/yt-dlp tidak jalan bersamaan (hemat RAM)
            messageQueue = messageQueue
                .then(() => handleMessage(m))
                .catch((err) => console.error('[Bot WA] Error pesan:', err.message || err));
        }
    });
}

async function main() {
    baileys = await import('@whiskeysockets/baileys');
    const pino = (await import('pino')).default;
    baileysLogger = pino({ level: process.env.DEBUG_BAILEYS === '1' ? 'debug' : 'silent' });
    await startSocket();
}

process.on('uncaughtException', (err) => {
    console.error('[Bot WA] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[Bot WA] Unhandled Rejection:', reason);
});

if (require.main === module) {
    main().catch((err) => {
        console.error('[Bot WA] Gagal memulai bot:', err);
        process.exit(1);
    });
}

module.exports = { handleMessage, makeSticker, _setSock: (s, b) => { sock = s; baileys = b; } };
