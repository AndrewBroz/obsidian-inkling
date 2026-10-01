import { type App, MarkdownRenderer, MarkdownView, resolveSubpath, TFile } from "obsidian";

import { hasCriticMarkup, toOriginalText } from "../../../api/original-text";
import type CommentatorPlugin from "../../../main";
import { embedSlice, type EmbedTarget } from "./embed-slice";

const EMBED_SELECTOR = ".internal-embed.markdown-embed[src]";
const RENDERED_CLASS = "inkling-original-embed";

/**
 * EXPL: Transclusions are rendered by Obsidian as read-only HTML, outside Inkling's editor extensions, so raw
 *       CriticMarkup leaks into them. This observer re-renders the content of any transclusion whose source
 *       contains CriticMarkup from the note's original text (suggestions rejected, comments removed).
 *       Display only: no file is ever written.
 */
export function registerOriginalTextEmbeds(plugin: CommentatorPlugin): void {
	let frame: number | null = null;
	const in_flight = new WeakSet<HTMLElement>();

	const scan = async () => {
		for (const embed of Array.from(document.body.querySelectorAll<HTMLElement>(EMBED_SELECTOR))) {
			if (in_flight.has(embed)) continue;
			in_flight.add(embed);
			try {
				await renderOriginal(plugin, embed);
			} catch (e) {
				console.error("Inkling: could not render transclusion as original text", e);
			} finally {
				in_flight.delete(embed);
			}
		}
	};

	const schedule = () => {
		if (frame !== null) return;
		frame = window.requestAnimationFrame(() => {
			frame = null;
			void scan();
		});
	};

	const observer = new MutationObserver(schedule);
	observer.observe(document.body, { childList: true, subtree: true });
	plugin.register(() => {
		observer.disconnect();
		if (frame !== null) window.cancelAnimationFrame(frame);
	});
	plugin.app.workspace.onLayoutReady(schedule);
}

async function renderOriginal(plugin: CommentatorPlugin, embed: HTMLElement): Promise<void> {
	const app = plugin.app;
	const content = embed.querySelector<HTMLElement>(":scope > .markdown-embed-content");
	if (!content) return;
	const host = hostPath(app, embed);
	if (!host) return;

	const src = embed.getAttribute("src") ?? "";
	const hash = src.indexOf("#");
	const linkpath = hash === -1 ? src : src.slice(0, hash);
	const subpath = hash === -1 ? "" : src.slice(hash);
	const file = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, host) : app.vault.getFileByPath(host);
	if (!(file instanceof TFile) || file.extension !== "md") return;

	// EXPL: Lets nested transclusions resolve their links relative to this note.
	embed.dataset.inklingPath = file.path;

	const signature = `${file.path}${subpath}@${file.stat.mtime}`;
	const container = content.querySelector<HTMLElement>(".markdown-preview-sizer") ??
		content.querySelector<HTMLElement>(".markdown-preview-view") ??
		content;
	const rendered = container.querySelector<HTMLElement>(`:scope > .${RENDERED_CLASS}`);
	if (rendered?.dataset.signature === signature) return;
	if (content.dataset.inklingPlain === signature) return;

	const target = embedTarget(app, file, subpath);
	if (!target) return;
	const slice = embedSlice(await app.vault.cachedRead(file), target);
	if (!hasCriticMarkup(slice, plugin.settings)) {
		// EXPL: Leave Obsidian's own rendering untouched when there is nothing to clean.
		content.dataset.inklingPlain = signature;
		return;
	}

	const wrapper = createDiv({ cls: RENDERED_CLASS });
	wrapper.dataset.signature = signature;
	await MarkdownRenderer.render(app, toOriginalText(slice, plugin.settings), wrapper, file.path, plugin);
	container.empty();
	container.appendChild(wrapper);
}

function hostPath(app: App, embed: HTMLElement): string | null {
	const parent = embed.parentElement?.closest<HTMLElement>(".internal-embed[data-inkling-path]");
	if (parent?.dataset.inklingPath) return parent.dataset.inklingPath;
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file && view.containerEl.contains(embed)) return view.file.path;
	}
	return null;
}

function embedTarget(app: App, file: TFile, subpath: string): EmbedTarget | null {
	const cache = app.metadataCache.getFileCache(file);
	if (!subpath) return { kind: "note", frontmatter_end: cache?.frontmatterPosition?.end.offset ?? null };
	if (!cache) return null;
	const sub = resolveSubpath(cache, subpath);
	if (!sub) return null;
	if (sub.type === "heading") {
		const headings = cache.headings ?? [];
		const index = headings.findIndex(h => h.position.start.offset === sub.current.position.start.offset);
		return index === -1 ? null : { kind: "heading", headings, index };
	}
	if (sub.type === "block") {
		return {
			kind: "block",
			start: sub.block.position.start.offset,
			end: sub.block.position.end.offset,
			list_items: sub.list ? cache.listItems : undefined,
			list_line: sub.list?.position.start.line,
		};
	}
	return null;
}
