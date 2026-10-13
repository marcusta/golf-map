// `bun run yt <video or playlist url>... [--lang en] [--out <dir>]` — YouTube captions as readable
// Markdown under data/youtube/ (git-ignored), one file per video plus an index.md. Needs yt-dlp on
// PATH; no video is downloaded.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Info = {
    id: string;
    title: string;
    duration?: number;
    upload_date?: string;
    channel?: string;
    description?: string;
    playlist_title?: string | null;
    playlist_index?: number | null;
    chapters?: { start_time: number; title: string }[] | null;
};
type Json3 = { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };

const PARAGRAPH_SECONDS = 30;

const args = process.argv.slice(2);
const option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args.splice(i, 2)[1];
};
const lang = option("--lang") ?? "en";
const outOption = option("--out");
if (args.length === 0) {
    console.error("usage: bun run yt <video or playlist url>... [--lang en] [--out <dir>]");
    process.exit(2);
}

const clock = (seconds: number) => {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
    return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
};
const slug = (text: string) =>
    text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);

/** Caption events as paragraphs of about PARAGRAPH_SECONDS, each with its start time. */
function paragraphs(captions: Json3): { start: number; text: string }[] {
    const out: { start: number; text: string }[] = [];
    for (const event of captions.events ?? []) {
        const text = (event.segs ?? []).map((seg) => seg.utf8 ?? "").join("");
        if (!text.trim()) continue;
        const start = (event.tStartMs ?? 0) / 1000;
        const last = out[out.length - 1];
        if (last && start - last.start < PARAGRAPH_SECONDS) last.text += ` ${text}`;
        else out.push({ start, text });
    }
    return out.map((p) => ({ start: p.start, text: p.text.replace(/\s+/g, " ").trim() }));
}

function markdown(info: Info, captions: Json3 | undefined): string {
    const url = `https://www.youtube.com/watch?v=${info.id}`;
    const lines = [`# ${info.title}`, "", `${url} · ${clock(info.duration ?? 0)} · ${info.channel ?? ""} · ${info.upload_date ?? ""}`, ""];
    if (info.description?.trim()) lines.push("## Description", "", info.description.trim(), "");
    const chapters = info.chapters ?? [];
    lines.push("## Transcript", "");
    if (!captions) lines.push(`(no ${lang} captions)`);
    let next = 0;
    for (const p of captions ? paragraphs(captions) : []) {
        while (next < chapters.length && chapters[next].start_time <= p.start) lines.push(`### ${chapters[next++].title}`, "");
        lines.push(`[${clock(p.start)}] ${p.text}`, "");
    }
    return lines.join("\n");
}

const raw = mkdtempSync(join(tmpdir(), "yt-transcript-"));
const proc = Bun.spawn(
    [
        "yt-dlp",
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        `${lang}-orig,${lang}`,
        "--sub-format",
        "json3",
        "--write-info-json",
        "--no-write-playlist-metafiles",
        "--ignore-errors",
        "--no-warnings",
        "--sleep-requests",
        "1",
        "-o",
        join(raw, "%(id)s.%(ext)s"),
        ...args,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
);
const code = await proc.exited;

const files = readdirSync(raw);
const infos = files
    .filter((name) => name.endsWith(".info.json"))
    .map((name) => JSON.parse(readFileSync(join(raw, name), "utf8")) as Info)
    .sort((a, b) => (a.playlist_index ?? 0) - (b.playlist_index ?? 0));
if (infos.length === 0) {
    console.error(`yt-dlp fetched nothing (exit ${code})`);
    process.exit(1);
}

const playlist = infos[0].playlist_title;
const out = resolve(outOption ?? join(import.meta.dir, "..", "data", "youtube", playlist ? slug(playlist) : "videos"));
mkdirSync(out, { recursive: true });

const index: string[] = [];
for (const info of infos) {
    const captionFile = [`${info.id}.${lang}-orig.json3`, `${info.id}.${lang}.json3`].find((name) => files.includes(name));
    const captions = captionFile ? (JSON.parse(readFileSync(join(raw, captionFile), "utf8")) as Json3) : undefined;
    const prefix = info.playlist_index ? `${String(info.playlist_index).padStart(2, "0")}-` : "";
    const name = `${prefix}${slug(info.title)}-${info.id}.md`;
    writeFileSync(join(out, name), markdown(info, captions));
    index.push(`- [${info.title}](${name}) · ${clock(info.duration ?? 0)}${captions ? "" : " · no captions"}`);
    console.log(join(out, name));
}
if (playlist) writeFileSync(join(out, "index.md"), [`# ${playlist}`, "", ...index, ""].join("\n"));
rmSync(raw, { recursive: true, force: true });
