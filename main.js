const { core, event, mpv, overlay, standaloneWindow, menu, file, utils, console } = iina;

// Change the shortcuts here; menus and on-screen hints follow. Format: mpv key names.
const ADD_KEY = "b";
const SHOW_KEY = "n"; // sits right next to B
const PREV_KEY = "j"; // J and K: previous and next, side by side
const NEXT_KEY = "k";
const LIBRARY_KEY = "l";

const THUMB_SIZE = 480; // max thumbnail dimension in px; sharp even when the stack is large
const CLIP_WIDTH = 320; // hover-preview clips are small to keep storage low
const CLIP_SECONDS = 5;

// Hover previews are short clips cut by ffmpeg straight from the video file, so playback is
// never touched. ffmpeg isn't part of macOS or IINA; without it bookmarks just have a still.
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/local/bin/ffmpeg"]
  .find((p) => utils.fileInPath(p));
// Prefer x264 (smallest files); fall back to Apple's hardware encoder for builds without it.
const ENCODERS = [
  ["-c:v", "libx264", "-crf", "28", "-preset", "veryfast"],
  ["-c:v", "h264_videotoolbox", "-b:v", "500k"],
];

let bookmarks = [];
let storePath = null;
let fileChapters = []; // the video's own chapters, kept so bookmarks are added alongside them
let stackOpen = false; // the thumbnail stack (SHOW_KEY)
let stackPeek = false; // opened automatically with the video; closes itself unless hovered
let videoFile = null; // local path of the playing video, for ffmpeg; null for streams
let overlayListening = false;
let overlayReady = false; // the overlay page has loaded and can receive messages
let sentMedia = new Set(); // thumbnails/clips the overlay page already holds: "<id>:thumb"
let makingClips = false;
let windowFocused = true; // a new window opens focused; "iina.window-main.changed" keeps it current

// FNV-1a: turns a file path/URL into a short, filesystem-safe key.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// "Shift+b" -> ["SHIFT", "B"], for showing a shortcut to the user.
function keyParts(key) {
  const names = { Meta: "CMD", Alt: "OPTION", Ctrl: "CTRL" };
  return key.split("+").map((k) => names[k] || k.toUpperCase());
}
const keyLabel = (key) => keyParts(key).join(" + ");

function formatTime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// Thumbnails and clips are large (about 90 KB per bookmark), and every message to the overlay
// is passed as text, so each is sent once; the page keeps them. Opening the stack then sends a
// few hundred bytes, and the page has its cards built already, even while hidden.
function withMedia(b, kind, item) {
  const key = `${b.id}:${kind}`;
  if (b[kind] && !sentMedia.has(key)) {
    item[kind] = b[kind];
    sentMedia.add(key);
  }
}

function render() {
  if (!bookmarks.length) stackOpen = false;
  if (!overlayReady) return;
  syncClickable();
  overlay.postMessage("stack", {
    open: stackOpen,
    peek: stackPeek,
    canDownload: canDownload(videoFile),
    keys: { prev: keyParts(PREV_KEY), next: keyParts(NEXT_KEY), library: keyParts(LIBRARY_KEY) },
    items: bookmarks.map((b) => {
      const item = { id: b.id, time: b.time, label: formatTime(b.time) };
      withMedia(b, "thumb", item);
      withMedia(b, "clip", item);
      return item;
    }),
  });
}

// A clickable overlay is risky: for every mouse move over the video, IINA asks the page what's
// under the pointer and waits for the answer, and when that wait overlaps a window change (the
// library opening) IINA 1.5 can crash. So the overlay only takes clicks while there's something
// to click: the open stack, or the "saved" note of a clip.
let overlayClickable = false;
let toastClickable = false;

function syncClickable() {
  const on = stackOpen || toastClickable;
  if (on === overlayClickable || !overlayReady) return;
  overlayClickable = on;
  overlay.setClickable(on); // when on, only elements marked data-clickable take clicks
}

// IINA ignores overlay listeners until the overlay page has loaded, so register on first use.
function listenToOverlay() {
  if (overlayListening) return;
  overlay.onMessage("seek", ({ time }) => core.seekTo(time));
  overlay.onMessage("remove", ({ id }) => removeBookmark(id));
  overlay.onMessage("stack-closed", () => {
    stackOpen = stackPeek = false;
    syncClickable();
  });
  overlay.onMessage("toast-clickable", ({ on }) => {
    toastClickable = on;
    syncClickable();
  });
  overlay.onMessage("idle", () => stackOpen || overlay.hide());
  overlay.onMessage("jump", ({ direction }) => jumpBookmark(direction)); // the stack stays open
  overlay.onMessage("show-library", () => standaloneWindow.isOpen() || toggleLibrary());
  overlay.onMessage("play-trash-sound", playTrashSoundHere);
  overlay.onMessage("download", ({ id, seconds }) => {
    const b = bookmarks.find((b) => b.id === id);
    if (!b) return;
    downloadClip(videoFile, b.time, seconds, (status) => {
      showOverlay(); // it may have been hidden since; the page fades the note out itself
      overlay.postMessage("download", status);
    });
  });
  overlay.onMessage("reveal", revealInFinder);
  overlay.onMessage("toggle-pause", () => (core.status.paused ? core.resume() : core.pause()));
  overlayListening = true;
}

// The overlay is a full-window web view, and every visible one sets the mouse cursor on each
// move. Left shown all the time it fights other plugins' overlays (their pointer cursors flicker
// back to an arrow), so the page reports "idle" once the strip, card and stack have all faded
// out, and the overlay is hidden until something needs it again.
function showOverlay() {
  overlay.show();
}

function openStack(peek) {
  listenToOverlay();
  stackOpen = true;
  stackPeek = peek;
  showOverlay();
  render();
  flashStrip();
}

function toggleStack() {
  if (!bookmarks.length) {
    core.osd(`No bookmarks yet · press ${keyLabel(ADD_KEY)} to add one`);
  } else if (stackOpen) {
    stackOpen = stackPeek = false;
    render();
  } else {
    openStack(false);
  }
}

function countLabel() {
  return bookmarks.length === 1 ? "1 bookmark" : `${bookmarks.length} bookmarks`;
}

// Briefly show the bookmark strip over the video (see overlay.html).
function flashStrip(highlight, position = core.status.position || 0) {
  const duration = core.status.duration;
  if (!bookmarks.length || !duration) return;
  showOverlay(); // the page is transparent apart from the strip, which fades itself out
  overlay.postMessage("show", {
    times: bookmarks.map((b) => b.time),
    duration,
    position,
    label: countLabel(),
    highlight,
  });
}

// A video's file: { video: { path, name, lastOpened }, bookmarks: [...] }. `video` says where
// the file was last seen, for the library; it's refreshed every time the video opens.
let videoInfo = null;

function save() {
  if (storePath) file.write(storePath, JSON.stringify({ video: videoInfo, bookmarks }));
}

// Change this video's bookmarks starting from what's on disk now, not from this window's copy:
// another IINA window may have added or deleted some since this one loaded them.
function updateStore(change) {
  if (!storePath) return;
  const store = readForWrite(storePath);
  bookmarks = change(store.bookmarks);
  file.write(storePath, JSON.stringify({ video: videoInfo || store.video, bookmarks }));
}

// Expose bookmarks to mpv as chapters, so IINA draws them as ticks on the seek bar.
// IINA only reads chapters when a file loads, so new ticks show up the next time it opens.
const START_CHAPTER = "Start";
const isOwnChapter = (c) => /^Bookmark \d/.test(c.title) || (c.title === START_CHAPTER && c.time === 0);

function syncChapters() {
  const marks = bookmarks.map((b) => ({ title: `Bookmark ${formatTime(b.time)}`, time: b.time }));
  const chapters = fileChapters.concat(marks).sort((a, b) => a.time - b.time);
  // IINA never draws a tick for the first chapter, so make sure one starts at 0.
  if (chapters.length && chapters[0].time > 0) chapters.unshift({ title: START_CHAPTER, time: 0 });
  try {
    mpv.set("chapter-list", chapters);
  } catch (e) {
    console.log(`Bookmarks Pro: could not set chapters: ${e}`);
  }
}

// A video's file, or an empty one. A file that can't be read (cut off, or not what we wrote) comes
// back empty with `damaged` set; readForWrite() keeps a copy of it before anything replaces it.
function readStore(path) {
  const empty = { video: null, bookmarks: [] };
  if (!path || !file.exists(path)) return empty;
  try {
    const saved = JSON.parse(file.read(path)) || {};
    // earlier versions saved just the array of bookmarks
    const store = Array.isArray(saved) ? { video: null, bookmarks: saved } : { ...empty, ...saved };
    if (!Array.isArray(store.bookmarks)) throw new Error("no list of bookmarks");
    store.bookmarks = store.bookmarks.filter((b) => b && Number.isFinite(b.id) && Number.isFinite(b.time));
    store.bookmarks.forEach((b) => delete b.frames); // flipbook previews from earlier versions
    return store;
  } catch (e) {
    console.log(`Bookmarks Pro: could not read ${path}: ${e}`);
    return { ...empty, damaged: true };
  }
}

// Before a damaged file is replaced, keep it as "<name>.json.damaged-<time>" (not .json, so the
// library ignores it), so whatever is still in it can be recovered by hand.
function readForWrite(path) {
  const store = readStore(path);
  if (store.damaged) {
    const copy = `${path}.damaged-${Date.now()}`;
    try {
      file.write(copy, file.read(path));
      file.write(path, JSON.stringify({ video: null, bookmarks: [] })); // readable again: copied once
      core.osd("Bookmarks Pro: a damaged bookmarks file was set aside");
    } catch (e) {
      console.log(`Bookmarks Pro: could not keep a copy of ${path}: ${e}`);
    }
  }
  return store;
}

// `legacyPath` is where this video's bookmarks lived when they were keyed by file path;
// they're moved to `path` the first time the video opens.
function load(path, legacyPath, video) {
  storePath = path;
  videoInfo = video;
  bookmarks = readForWrite(path).bookmarks;
  if (!bookmarks.length && legacyPath && legacyPath !== path) {
    bookmarks = readStore(legacyPath).bookmarks;
    if (bookmarks.length) file.delete(legacyPath);
  }
  if (bookmarks.length) save(); // records where the video is now
  // After a plugin reload, mpv still holds the chapters we added last time; drop them.
  fileChapters = (mpv.getNative("chapter-list") || []).filter((c) => !isOwnChapter(c));
  if (bookmarks.length) syncChapters();
  stackOpen = stackPeek = false;
  render();
}

async function toDataURI(path, type) {
  const encoded = await utils.exec("/usr/bin/base64", ["-i", path]);
  return encoded.status === 0 ? `data:${type};base64,${encoded.stdout.replace(/\s/g, "")}` : null;
}

// Grab the frame mpv is showing, shrink it with sips and return it as a data URI.
async function captureThumbnail() {
  const shot = utils.resolvePath("@tmp/bookmark-shot.jpg");
  const thumb = utils.resolvePath("@tmp/bookmark-thumb.jpg");
  try {
    mpv.command("screenshot-to-file", [shot, "video"]);
    const resized = await utils.exec("/usr/bin/sips", [
      "-Z", String(THUMB_SIZE), "-s", "format", "jpeg", "-s", "formatOptions", "60",
      shot, "--out", thumb,
    ]);
    return resized.status === 0 ? await toDataURI(thumb, "image/jpeg") : null;
  } catch (e) {
    console.log(`Bookmarks Pro: thumbnail failed: ${e}`);
    return null;
  }
}

// Cut the CLIP_SECONDS after `time` out of `source` as a small, silent mp4 data URI.
async function makeClip(source, time) {
  const out = utils.resolvePath("@tmp/bookmark-clip.mp4");
  for (const encoder of ENCODERS) {
    try {
      const done = await utils.exec(FFMPEG, [
        "-v", "error", "-y", "-ss", String(time), "-i", source, "-t", String(CLIP_SECONDS),
        "-an", "-vf", `scale=${CLIP_WIDTH}:-2`, "-pix_fmt", "yuv420p", ...encoder,
        "-movflags", "+faststart", out,
      ]);
      if (done.status === 0) return await toDataURI(out, "video/mp4");
    } catch (e) {
      console.log(`Bookmarks Pro: ffmpeg failed: ${e}`);
    }
  }
  return null;
}

// Make clips, one at a time, for every bookmark of this video that lacks one. This also
// upgrades bookmarks saved before clips existed, the next time their video opens.
async function makeMissingClips() {
  if (makingClips || !FFMPEG || !videoFile) return;
  makingClips = true;
  const path = storePath;
  const source = videoFile;
  const tried = new Set();
  try {
    let b;
    while ((b = bookmarks.find((b) => !b.clip && !tried.has(b.id)))) {
      tried.add(b.id);
      const clip = await makeClip(source, b.time);
      if (path !== storePath) return; // video changed meanwhile
      if (!clip) continue;
      updateStore((list) => list.map((x) => (x.id === b.id ? { ...x, clip } : x)));
      render();
    }
  } finally {
    makingClips = false;
    if (path !== storePath) makeMissingClips(); // start over for the video that's open now
  }
}

async function addBookmark() {
  const path = storePath;
  const time = core.status.position;
  if (!path || time == null) return;

  const thumb = await captureThumbnail();
  if (path !== storePath) return; // video changed while capturing

  updateStore((list) => list.concat({ id: Date.now(), time, thumb }).sort((a, b) => a.time - b.time));
  syncChapters();
  render();
  flashStrip(time);
  // The card sits where the stack opens; an open stack shows the new bookmark itself.
  if (!stackOpen) {
    overlay.postMessage("added", {
      thumb,
      label: `Bookmarked ${formatTime(time)}`,
      keys: keyParts(SHOW_KEY), // shown as keycaps in "Press … to see bookmarks"
    });
  }
  makeMissingClips();
}

// Jump to the closest bookmark after (direction 1) or before (-1) the current position.
// Going forward from the last one starts over at the first. Going back skips one that was
// just passed, so pressing again keeps stepping back, like "previous track".
function jumpBookmark(direction) {
  const pos = core.status.position;
  if (pos == null) return;
  const target = direction > 0
    ? bookmarks.find((b) => b.time > pos + 0.5) || bookmarks[0]
    : bookmarks.filter((b) => b.time < pos - 1.5).pop();
  if (!target) {
    core.osd(bookmarks.length ? `No ${direction > 0 ? "next" : "previous"} bookmark` : "No bookmarks yet");
    return;
  }
  core.seekTo(target.time);
  core.osd(`Bookmark ${bookmarks.indexOf(target) + 1}/${bookmarks.length} · ${formatTime(target.time)}`);
  flashStrip(target.time, target.time); // the seek hasn't landed yet, so pass where it's going
}

// ---- Library: every video's bookmarks, in a window of its own (library.html)

// ---- Downloading a clip (the ↓ on a card, in the stack and the library)
//
// A full-quality copy of the 5, 10 or 30 seconds after a bookmark, with sound, cut by ffmpeg
// from the video file and saved to Downloads as "IINA Clip - <video name> - 15m15s.mp4". Re-encoding makes it
// start on the bookmarked frame (a plain copy could only start at the keyframe before it).
const DOWNLOAD_SECONDS = [5, 10, 30];
// Apple's hardware encoder first: a 30-second 1080p clip takes a few seconds.
const DOWNLOAD_ENCODERS = [
  ["-c:v", "h264_videotoolbox", "-q:v", "65"], // constant quality; Apple silicon
  ["-c:v", "h264_videotoolbox", "-b:v", "12M"], // Intel Macs only take a bitrate
  ["-c:v", "libx264", "-crf", "18", "-preset", "veryfast"],
];
let downloadsFolder = null;

const canDownload = (path) => !!FFMPEG && !!path && !path.includes("://");

async function findDownloadsFolder() {
  if (downloadsFolder) return downloadsFolder;
  const asked = await utils.exec("/usr/bin/osascript", ["-e", "POSIX path of (path to downloads folder)"]).catch(() => null);
  let dir = asked?.status === 0 && asked.stdout.trim();
  if (!dir) {
    const home = await utils.exec("/bin/sh", ["-c", 'printf %s "$HOME"']).catch(() => null);
    dir = home?.status === 0 && home.stdout ? `${home.stdout}/Downloads` : null;
  }
  return (downloadsFolder = dir ? dir.replace(/\/$/, "") : null);
}

// "1h02m15s", "15m15s", "42s": readable, and safe in a file name (Finder shows ":" as "/").
function fileTime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  if (h) return `${h}h${pad(m)}m${pad(s % 60)}s`;
  return m ? `${m}m${pad(s % 60)}s` : `${s}s`;
}

// `post` sends progress to the page that asked: { job, state: "saving" | "done" | "error", ... }
async function downloadClip(source, time, seconds, post) {
  const job = Date.now() + Math.random();
  if (!canDownload(source) || !DOWNLOAD_SECONDS.includes(seconds)) return;
  post({ job, state: "saving", text: `Saving ${seconds}s clip` });
  try {
    if (!file.exists(source)) throw new Error("the video file isn't there anymore");
    const dir = await findDownloadsFolder();
    if (!dir) throw new Error("no Downloads folder");
    // "IINA Clip - " first, so typing "iina clip" in Finder finds every saved clip
    const base = `IINA Clip - ${source.split("/").pop().replace(/\.[^.]+$/, "").replace(/[/:]/g, "-")} - ${fileTime(time)}`;
    let out = `${dir}/${base}.mp4`;
    for (let n = 2; file.exists(out); n++) out = `${dir}/${base} (${n}).mp4`;
    const partial = `${dir}/.${base}.part-${Math.floor(job)}.mp4`; // hidden until it's complete
    let saved = false;
    for (const encoder of DOWNLOAD_ENCODERS) {
      const done = await utils.exec(FFMPEG, [
        "-v", "error", "-y", "-ss", String(time), "-i", source, "-t", String(seconds),
        "-map", "0:v:0", "-map", "0:a:0?", "-map_chapters", "-1", "-sn",
        ...encoder, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", partial,
      ]).catch((e) => ({ status: 1, stderr: String(e) }));
      if (done.status === 0) {
        saved = true;
        break;
      }
      console.log(`Bookmarks Pro: ffmpeg (${encoder[1]}) failed: ${(done.stderr || "").trim()}`);
    }
    // ffmpeg also "succeeds" with an empty file when there's no video left after `time`
    const size = saved && (await utils.exec("/usr/bin/stat", ["-f", "%z", partial]).catch(() => null));
    if (!size || size.status !== 0 || Number(size.stdout) < 4096) {
      await utils.exec("/bin/rm", ["-f", partial]).catch(() => {});
      throw new Error(saved ? "nothing left to cut after the bookmark" : "ffmpeg could not cut the clip");
    }
    await run("/bin/mv", ["-n", partial, out]);
    post({ job, state: "done", text: "Saved to Downloads", path: out });
  } catch (e) {
    console.log(`Bookmarks Pro: could not save the clip: ${e.message || e}`);
    post({ job, state: "error", text: "Couldn't save the clip" });
  }
}

// Clicking the "saved" note: show the clip in Finder (only ever a file in Downloads).
const revealInFinder = ({ path }) =>
  downloadsFolder && typeof path === "string" && path.startsWith(`${downloadsFolder}/`) && !path.includes("/../")
    && utils.exec("/usr/bin/open", ["-R", path]).catch(() => {});

// A video opened from the library plays in a new IINA window, which runs its own copy of this
// plugin. This note tells that copy where to jump once the video has loaded. (No .json
// extension, so the library doesn't take it for a video's bookmarks.)
const PENDING_SEEK = "@data/pending-seek";

function libraryVideos() {
  return (file.list("@data/", {}) || [])
    .filter((f) => f.filename.endsWith(".json"))
    .map((f) => ({ key: `@data/${f.filename}`, ...readStore(`@data/${f.filename}`) }))
    .filter((v) => v.bookmarks.length)
    .sort((a, b) => (b.video?.lastOpened || 0) - (a.video?.lastOpened || 0));
}

// The list goes first, then each video's thumbnails, so the window fills in quickly; clips are
// only sent when a card is hovered.
function sendLibrary() {
  const all = libraryVideos();
  standaloneWindow.postMessage("videos", all.map(({ key, video, bookmarks: list }) => ({
    key,
    name: video?.name || null,
    path: video?.path || null,
    // a stream can always be opened again; a file only if it's still where it was last seen
    exists: !!video?.path && (video.path.includes("://") || file.exists(video.path)),
    lastOpened: video?.lastOpened || 0,
    canDownload: canDownload(video?.path),
    bookmarks: list.map((b) => ({ id: b.id, time: b.time, label: formatTime(b.time) })),
  })));
  for (const { key, bookmarks: list } of all) {
    standaloneWindow.postMessage("thumbs", { key, thumbs: Object.fromEntries(list.map((b) => [b.id, b.thumb || null])) });
  }
}

function openFromLibrary({ key, time }) {
  standaloneWindow.close();
  if (key === storePath) return core.seekTo(time);
  const { video } = readStore(key);
  if (!video?.path) return;
  file.write(PENDING_SEEK, JSON.stringify({ key, time, at: Date.now() }));
  // IINA's own link format opens it in a new window, leaving this one as it is
  const link = `iina://open?url=${encodeURIComponent(video.path)}&new_window=1`;
  utils.exec("/usr/bin/open", [link]).catch((e) => console.log(`Bookmarks Pro: could not open: ${e}`));
}

// In the new window: jump if the note is for this video and was just written.
function seekIfPending() {
  if (!file.exists(PENDING_SEEK)) return;
  try {
    const { key, time, at } = JSON.parse(file.read(PENDING_SEEK));
    if (key !== storePath || Date.now() - at > 15000) return;
    file.delete(PENDING_SEEK);
    core.seekTo(time);
  } catch (e) {
    console.log(`Bookmarks Pro: could not read the pending jump: ${e}`);
  }
}

// A video that moved since it was last opened: the chosen file must have the same fingerprint.
// Bookmarks from before fingerprints (keyed by the old path) take on the chosen file's.
async function locateVideo({ key }) {
  const chosen = await utils.chooseFile("Locate the video", {});
  if (!chosen) return;
  const id = await fingerprint(chosen);
  const target = id ? `@data/video-${id}.json` : null;
  if (!target || (key.startsWith("@data/video-") && target !== key)) {
    standaloneWindow.postMessage("note", { key, text: "That's a different video" });
    return;
  }
  const store = readStore(key);
  const existing = target !== key ? readStore(target).bookmarks : [];
  const ids = new Set(existing.map((b) => b.id));
  store.bookmarks = existing.concat(store.bookmarks.filter((b) => !ids.has(b.id))).sort((a, b) => a.time - b.time);
  store.video = { path: chosen, name: chosen.split("/").pop(), lastOpened: store.video?.lastOpened || Date.now() };
  file.write(target, JSON.stringify(store));
  if (target !== key) file.delete(key);
  if (target === storePath) bookmarks = store.bookmarks; // it's the video that's playing
  sendLibrary();
}

// The library page has already taken the card away; this makes it stick.
function deleteFromLibrary(key, id) {
  if (key === storePath) return removeBookmark(id); // the playing video: also updates the stack and chapters
  const store = readStore(key);
  store.bookmarks = store.bookmarks.filter((b) => b.id !== id);
  if (store.bookmarks.length) file.write(key, JSON.stringify(store));
  else file.delete(key); // nothing left for this video
}

// ---- Export / Import (buttons in the library)
//
// An export is a zip of the data folder's video files (thumbnails included, as they're stored)
// plus a manifest.json. Clips are left out unless asked for: ffmpeg remakes them when a video
// opens. Import only ever adds: bookmarks are merged by id into what's here, nothing is deleted
// or overwritten. Videos are matched by fingerprint, so this works across Macs.

const EXPORT_FORMAT = "iina-bookmarks";
const EXPORT_VERSION = 1;
const VIDEO_FILE = /^(video-[0-9a-f]{8,64}|[0-9a-f]{1,16})\.json$/; // a fingerprint or old URL key

const libraryStatus = (text, error = false) => standaloneWindow.postMessage("status", { text, error });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function run(cmd, args) {
  const done = await utils.exec(cmd, args).catch((e) => ({ status: 1, stderr: String(e) }));
  if (done.status !== 0) throw new Error(`${cmd.split("/").pop()} failed: ${done.stderr || done.status}`);
  return done;
}

// A fresh, empty folder of our own under @tmp, removed again when `work` is done.
async function withStaging(name, work) {
  const dir = utils.resolvePath(`@tmp/${name}-${Date.now()}`);
  await run("/bin/mkdir", ["-p", dir]);
  try {
    return await work(dir);
  } finally {
    await run("/bin/rm", ["-rf", dir]).catch(() => {});
  }
}

// What each kind of export would weigh, for the choice the library shows. The zip shrinks the
// text-encoded images by about a quarter.
function exportSizes() {
  let full = 0, small = 0;
  for (const { video, bookmarks: list } of libraryVideos()) {
    full += JSON.stringify({ video, bookmarks: list }).length;
    small += JSON.stringify({ video, bookmarks: list.map(({ clip, ...b }) => b) }).length;
  }
  standaloneWindow.postMessage("export-sizes", { full: Math.round(full * 0.75), small: Math.round(small * 0.75) });
}

// IINA only gives plugins an Open dialog (no file name, an "Open" button), so the export asks
// with macOS's own Save dialog, through AppleScript. The suggested name comes in as an argument,
// never spliced into the script. Resolves to the chosen path, or null when cancelled.
const SAVE_DIALOG = [
  "on run argv",
  "activate",
  'set f to choose file name with prompt "Export bookmarks" default name (item 1 of argv) default location (path to downloads folder)',
  "return POSIX path of f",
  "end run",
];

async function askWhereToSave(name) {
  const args = SAVE_DIALOG.flatMap((line) => ["-e", line]).concat(name);
  const done = await utils.exec("/usr/bin/osascript", args).catch((e) => ({ status: 1, stderr: String(e) }));
  // The dialog belongs to osascript, which "activate" brought to the front. Give the front back
  // to IINA, or the library window can be left unable to take clicks or keys.
  utils.exec("/usr/bin/osascript", ["-e", 'tell application id "com.colliderli.iina" to activate']).catch(() => {});
  if (done.status === 0) {
    const chosen = done.stdout.trim();
    return chosen.toLowerCase().endsWith(".zip") ? chosen : `${chosen}.zip`;
  }
  if (/-128/.test(done.stderr || "")) return null; // Cancel
  throw new Error(`the save dialog failed: ${(done.stderr || "").trim() || done.status}`);
}

async function exportBookmarks({ withClips }) {
  const videos = libraryVideos();
  if (!videos.length) return libraryStatus("Nothing to export yet", true);

  const now = new Date();
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  let zip;
  try {
    zip = await askWhereToSave(`Bookmarks Pro ${date}.zip`);
  } catch (e) {
    return libraryStatus(`Export failed: ${e.message}`, true);
  }
  if (!zip) return;

  try {
    await withStaging("export", async (staging) => {
      let count = 0;
      for (const { key, video, bookmarks: list } of videos) {
        const kept = withClips ? list : list.map(({ clip, ...b }) => b);
        file.write(`${staging}/${key.slice("@data/".length)}`, JSON.stringify({ video, bookmarks: kept }));
        count += list.length;
      }
      file.write(`${staging}/manifest.json`, JSON.stringify({
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: now.toISOString(),
        videos: videos.length,
        bookmarks: count,
        clips: withClips,
      }));
      await run("/bin/rm", ["-f", zip]); // the Save dialog already asked before replacing a file
      await run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", staging, zip]);
      libraryStatus(`Exported ${plural(count, "bookmark")} of ${plural(videos.length, "video")} to ${zip.split("/").pop()}`);
    });
  } catch (e) {
    libraryStatus(`Export failed: ${e.message}`, true);
  }
}

// One video's file from an export, or null if it isn't one.
function readImported(path) {
  try {
    const data = JSON.parse(file.read(path));
    const list = Array.isArray(data) ? data : data?.bookmarks;
    if (!Array.isArray(list)) return null;
    const isData = (s, type) => typeof s === "string" && s.startsWith(`data:${type}/`);
    const bookmarks = list
      .filter((b) => Number.isFinite(b?.id) && Number.isFinite(b?.time))
      .map((b) => ({
        id: b.id,
        time: b.time,
        ...(isData(b.thumb, "image") && { thumb: b.thumb }),
        ...(isData(b.clip, "video") && { clip: b.clip }),
      }));
    const v = !Array.isArray(data) && data.video;
    const video = v && typeof v.path === "string"
      ? { path: v.path, name: String(v.name || v.path.split("/").pop()), lastOpened: Number(v.lastOpened) || 0 }
      : null;
    return { video, bookmarks };
  } catch (e) {
    return null;
  }
}

async function importBookmarks() {
  const zip = await utils.chooseFile("Choose a bookmarks export", { allowedFileTypes: ["zip"] });
  if (!zip) return;
  try {
    await withStaging("import", async (staging) => {
      await run("/usr/bin/ditto", ["-x", "-k", zip, staging]);
      let manifest = null;
      try {
        manifest = JSON.parse(file.read(`${staging}/manifest.json`));
      } catch (e) {}
      if (manifest?.format !== EXPORT_FORMAT) throw new Error("that isn't a bookmarks export");
      if (!(manifest.version <= EXPORT_VERSION)) throw new Error("it was made by a newer version of the plugin");

      // Work out every change first; only write once the whole export has been read.
      const changes = [];
      for (const { filename } of file.list(staging, {}) || []) {
        if (!VIDEO_FILE.test(filename)) continue;
        const incoming = readImported(`${staging}/${filename}`);
        if (!incoming?.bookmarks.length) continue;
        const key = `@data/${filename}`;
        const existed = file.exists(key);
        const store = readStore(key);
        const known = new Set(store.bookmarks.map((b) => b.id));
        const fresh = incoming.bookmarks.filter((b) => !known.has(b.id));
        if (!fresh.length) continue; // already all here
        store.bookmarks = store.bookmarks.concat(fresh).sort((a, b) => a.time - b.time);
        if (!store.video || (incoming.video && incoming.video.lastOpened > (store.video.lastOpened || 0))) {
          store.video = incoming.video || store.video;
        }
        changes.push({ key, store, existed, added: fresh.length });
      }

      let added = 0, newVideos = 0, merged = 0;
      for (const { key, store, existed, added: n } of changes) {
        file.write(key, JSON.stringify(store));
        added += n;
        existed ? merged++ : newVideos++;
        if (key === storePath) { // the playing video
          bookmarks = store.bookmarks;
          syncChapters();
          render();
        }
      }
      libraryStatus(added
        ? `Imported ${plural(added, "bookmark")} · ${plural(newVideos, "new video")} · ${merged} merged`
        : "Nothing new: every bookmark in that export is already here");
      sendLibrary();
    });
  } catch (e) {
    libraryStatus(`Import failed: ${e.message}. Nothing was changed.`, true);
  }
}

// Library window settings (for now the thumbnail size). No .json extension, so the library
// doesn't take it for a video's bookmarks.
const LIBRARY_PREFS = "@data/library-prefs";

function libraryPrefs() {
  try {
    return file.exists(LIBRARY_PREFS) ? JSON.parse(file.read(LIBRARY_PREFS)) : {};
  } catch (e) {
    return {};
  }
}

function toggleLibrary() {
  if (standaloneWindow.isOpen()) return standaloneWindow.close();
  // Close the stack and stop the overlay taking clicks first, then open the window a moment
  // later, so it never opens in the middle of the overlay's hit test (see syncClickable).
  if (overlayClickable) {
    stackOpen = stackPeek = false;
    toastClickable = false;
    render();
    return setTimeout(openLibrary, 150);
  }
  openLibrary();
}

function openLibrary() {
  if (standaloneWindow.isOpen()) return;
  standaloneWindow.loadFile("library.html"); // also clears the listeners below, so add them after
  // No title bar: the page fills the window and the window buttons float over its frosted header
  standaloneWindow.setProperty({ title: "Bookmarks Pro", fullSizeContentView: true, hideTitleBar: true });
  standaloneWindow.setFrame(960, 680);
  standaloneWindow.onMessage("ready", () => {
    standaloneWindow.postMessage("prefs", libraryPrefs());
    sendLibrary();
    sendTrashSound();
  });
  standaloneWindow.onMessage("open", openFromLibrary);
  standaloneWindow.onMessage("locate", locateVideo);
  standaloneWindow.onMessage("export-sizes", exportSizes);
  standaloneWindow.onMessage("thumb-size", ({ px }) => {
    if (Number.isFinite(px)) file.write(LIBRARY_PREFS, JSON.stringify({ ...libraryPrefs(), thumbSize: px }));
  });
  standaloneWindow.onMessage("export", exportBookmarks);
  standaloneWindow.onMessage("import", importBookmarks);
  standaloneWindow.onMessage("close", () => standaloneWindow.close());
  // Dragging by the header (library.html). macOS places windows by their bottom-left corner,
  // counted from the bottom of the main screen, the one at (0, 0).
  const mainScreen = (core.window.screens || []).find((s) => s.frame.x === 0 && s.frame.y === 0);
  standaloneWindow.onMessage("move-window", ({ left, top, height }) => {
    if (mainScreen) standaloneWindow.setFrame(null, null, left, mainScreen.frame.height - top - height);
  });
  standaloneWindow.onMessage("remove", ({ key, id }) => deleteFromLibrary(key, id));
  standaloneWindow.onMessage("play-trash-sound", playTrashSoundHere);
  standaloneWindow.onMessage("download", ({ key, id, seconds }) => {
    const { video, bookmarks: list } = readStore(key);
    const b = list.find((b) => b.id === id);
    if (b) downloadClip(video?.path, b.time, seconds, (status) => standaloneWindow.postMessage("download", status));
  });
  standaloneWindow.onMessage("reveal", revealInFinder);
  standaloneWindow.onMessage("clip", ({ key, id }) => {
    const b = readStore(key).bookmarks.find((b) => b.id === id);
    standaloneWindow.postMessage("clip", { key, id, clip: b?.clip || null });
  });
  standaloneWindow.open();
}

// The short trash sound Finder plays for Cmd+Delete, played like Finder plays it: only when the
// Mac's "Play user interface sound effects" setting is on, at the alert volume. (finder/move to
// trash.aif is the longer, 2-second one.) Starting afplay takes about half a second, so the
// sound goes to the overlay and library pages once, as WAV (afconvert), and they play it right
// in the click that deletes.
const TRASH_SOUND = "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/dock/drag to trash.aif";
let trashSound = null; // { src: WAV data URI, volume }, or null when sounds are off

// Fallback for a page that can't play the sound itself.
function playTrashSoundHere() {
  if (trashSound) utils.exec("/usr/bin/afplay", ["-v", String(trashSound.volume), TRASH_SOUND]).catch(() => {});
}

async function loadTrashSound() {
  const read = (key) => utils.exec("/usr/bin/defaults", ["read", "-g", key]).catch(() => ({ status: 1 }));
  const [uiSounds, alertVolume] = await Promise.all([read("com.apple.sound.uiaudio.enabled"), read("com.apple.sound.beep.volume")]);
  if (uiSounds.status === 0 && uiSounds.stdout.trim() === "0") return; // unset means on
  if (!utils.fileInPath(TRASH_SOUND)) return;
  const wav = utils.resolvePath("@tmp/trash.wav");
  const converted = await utils.exec("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16", TRASH_SOUND, wav]).catch(() => ({ status: 1 }));
  const src = converted.status === 0 && (await toDataURI(wav, "audio/wav"));
  const volume = alertVolume.status === 0 ? parseFloat(alertVolume.stdout) : 1;
  if (src) trashSound = { src, volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1 };
  sendTrashSound();
}

function sendTrashSound() {
  if (!trashSound) return;
  if (overlayReady) overlay.postMessage("sound", trashSound);
  if (standaloneWindow.isOpen()) standaloneWindow.postMessage("sound", trashSound);
}

function removeBookmark(id) {
  updateStore((list) => list.filter((b) => b.id !== id));
  syncChapters();
  render();
  flashStrip();
}

// Every IINA window runs its own copy of this plugin, but there is one Plugin menu, holding the
// shortcuts of whichever window it was last built for. If it's stale, a key press reaches the
// copy of a window in the background: do nothing there, and have the menu rebuilt.
function forFocusedWindow(action) {
  return () => {
    if (windowFocused) return action();
    menu.forceUpdate();
  };
}

menu.addItem(menu.item("Add Bookmark", forFocusedWindow(addBookmark), { keyBinding: ADD_KEY }));
menu.addItem(menu.item("Show Bookmarks", forFocusedWindow(toggleStack), { keyBinding: SHOW_KEY }));
menu.addItem(menu.item("Previous Bookmark", forFocusedWindow(() => jumpBookmark(-1)), { keyBinding: PREV_KEY }));
menu.addItem(menu.item("Next Bookmark", forFocusedWindow(() => jumpBookmark(1)), { keyBinding: NEXT_KEY }));
menu.addItem(menu.item("Bookmark Library", forFocusedWindow(toggleLibrary), { keyBinding: LIBRARY_KEY }));

function setUpWindow() {
  overlayReady = false;
  overlay.loadFile("overlay.html");
  overlayListening = false; // loadFile clears overlay listeners
}

// A freshly loaded page holds nothing yet: send it everything, so the stack is ready to show.
event.on("iina.plugin-overlay-loaded", () => {
  overlayReady = true;
  sentMedia = new Set();
  overlay.setClickable(false); // a new page starts out not taking clicks; render() turns them on
  overlayClickable = toastClickable = false;
  listenToOverlay();
  render();
  sendTrashSound();
});

// A local video is recognized by its content, so its bookmarks follow it when it's renamed or
// moved: its exact size plus a SHA-256 of its first, middle and last MiB. That's 3 MiB read
// whatever the file's size, a few milliseconds, with tools that come with macOS.
const FINGERPRINT_SH = `
  f="$1"; size=$(/usr/bin/stat -f %z "$f") || exit 1; mib=1048576
  { echo "$size"
    /usr/bin/head -c $mib "$f"
    /bin/dd if="$f" bs=$mib skip=$((size / 2 / mib)) count=1 2>/dev/null
    /usr/bin/tail -c $mib "$f"
  } | /usr/bin/shasum -a 256`;

async function fingerprint(videoPath) {
  try {
    // the path is passed as an argument ($1), never spliced into the script
    const done = await utils.exec("/bin/sh", ["-c", FINGERPRINT_SH, "sh", videoPath]);
    return done.status === 0 ? done.stdout.slice(0, 32) : null;
  } catch (e) {
    console.log(`Bookmarks Pro: fingerprint failed: ${e}`);
    return null;
  }
}

async function loadPlaying() {
  const path = mpv.getString("path");
  if (!path) return;
  // Streams have no file to fingerprint, so they keep the URL-based key, which local files used
  // too before fingerprints. It matches IINA's core.status.url ("file://" + path for local files).
  const url = path.includes("://") ? path : `file://${path}`;
  const urlKey = `@data/${hash(url)}.json`;
  const local = path.includes("://") ? null : path;
  const id = local && (await fingerprint(local));
  if (mpv.getString("path") !== path) return; // another video started meanwhile

  videoFile = local;
  const name = path.split("/").pop();
  load(id ? `@data/video-${id}.json` : urlKey, urlKey, { path, name, lastOpened: Date.now() });
  makeMissingClips();
}

event.on("iina.window-loaded", setUpWindow);

// IINA rebuilds the menu when a window gets focus; rebuild once more after the switch has
// settled, so it's this window's shortcuts that end up in it.
event.on("iina.window-main.changed", (focused) => {
  windowFocused = focused;
  if (!focused) return;
  setTimeout(() => menu.forceUpdate(), 0);
  // pick up bookmarks another window added or deleted for this video meanwhile
  const store = readStore(storePath);
  if (storePath && !store.damaged) {
    bookmarks = store.bookmarks;
    syncChapters();
    render();
  }
});

// Show a video's bookmarks for a few seconds once it starts playing.
event.on("iina.file-loaded", () => {
  seekIfPending(); // opened from the library
  if (!bookmarks.length) return;
  setTimeout(() => {
    if (bookmarks.length && !stackOpen) openStack(true);
  }, 0);
});

// Load during mpv's preload step, before IINA reads the chapter list for the seek bar.
// The hook waits for the fingerprint (but never more than 2s), so the chapters are in place
// before IINA reads them.
mpv.addHook("on_preloaded", 50, async (next) => {
  try {
    await Promise.race([loadPlaying(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  } finally {
    next();
  }
});

// "Reload All Plugins" reruns this script in a player whose window and video are already
// open, so the events above won't fire again. Catch up on both here.
if (core.window.loaded) setUpWindow();
loadPlaying();
loadTrashSound();

// A reload also empties IINA's Plugin menu, which holds the B / N shortcuts, and IINA
// doesn't rebuild it until the app is refocused. setTimeout runs after the reload has finished.
setTimeout(() => menu.forceUpdate(), 0);
