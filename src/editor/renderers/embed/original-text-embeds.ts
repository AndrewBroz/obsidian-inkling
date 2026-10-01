import {
	type App,
	Keymap,
	MarkdownRenderChild,
	MarkdownRenderer,
	MarkdownView,
	resolveSubpath,
	TFile,
} from "obsidian";

import { hasCriticMarkup, toOriginalText } from "../../../api/original-text";
import type CommentatorPlugin from "../../../main";
import { embedSlice, type EmbedTarget } from "./embed-slice";

const EMBED_SELECTOR = ".internal-embed.markdown-embed[src]";
const RENDERED_CLASS = "inkling-original-embed";
const HIDDEN_CLASS = "inkling-original-hidden";

// EXPL: Keyed by file path; bumped whenever MetadataCache reparses a file, because mtime alone updates
//       before the cache does and would otherwise let a render run against stale headings/blocks.
const generation = new Map<string, number>();

interface EmbedState {
	disposed: boolean;
	/** The live MarkdownRenderChild currently showing original text for a given embed element, if any. */
	children: WeakMap<HTMLElement, MarkdownRenderChild>;
	/** Mirrors the values of `children`, so stale entries (containerEl detached) can be swept each scan. */
	live: Set<MarkdownRenderChild>;
}

/**
 * EXPL: Transclusions are rendered by Obsidian as read-only HTML, outside Inkling's editor extensions, so raw
 *       CriticMarkup leaks into them. This observer re-renders the content of any transclusion whose source
 *       contains CriticMarkup from the note's original text (suggestions rejected, comments removed).
 *       Display only: no file is ever written.
 *
 *       Obsidian's own embed renderer owns `.markdown-preview-view` (and, in some views, a
 *       `.markdown-preview-sizer` inside it) and periodically rewrites its children, so our rendered wrapper
 *       is never inserted inside it — it is hidden and our wrapper is placed as its next sibling instead.
 */
export function registerOriginalTextEmbeds(plugin: CommentatorPlugin): void {
	const state: EmbedState = { disposed: false, children: new WeakMap(), live: new Set() };
	let frame: number | null = null;
	const in_flight = new WeakSet<HTMLElement>();

	const scan = async () => {
		if (state.disposed) return;
		for (const child of Array.from(state.live)) {
			if (!child.containerEl.isConnected) {
				state.live.delete(child);
				plugin.removeChild(child);
			}
		}
		for (const embed of Array.from(document.body.querySelectorAll<HTMLElement>(EMBED_SELECTOR))) {
			if (state.disposed) return;
			if (in_flight.has(embed)) continue;
			in_flight.add(embed);
			try {
				await renderOriginal(plugin, state, embed);
			} catch (e) {
				console.error("Inkling: could not render transclusion as original text", e);
			} finally {
				in_flight.delete(embed);
			}
		}
	};

	const schedule = () => {
		if (state.disposed || frame !== null) return;
		frame = window.requestAnimationFrame(() => {
			frame = null;
			void scan();
		});
	};

	const observer = new MutationObserver(schedule);
	observer.observe(document.body, { childList: true, subtree: true });
	plugin.registerEvent(plugin.app.metadataCache.on("changed", (file) => {
		generation.set(file.path, (generation.get(file.path) ?? 0) + 1);
		schedule();
	}));
	plugin.register(() => {
		state.disposed = true;
		observer.disconnect();
		if (frame !== null) window.cancelAnimationFrame(frame);
		for (const el of Array.from(document.querySelectorAll<HTMLElement>(`.${RENDERED_CLASS}`))) el.remove();
		for (const el of Array.from(document.querySelectorAll<HTMLElement>(`.${HIDDEN_CLASS}`)))
			el.classList.remove(HIDDEN_CLASS);
		for (const child of Array.from(state.live)) {
			state.live.delete(child);
			plugin.removeChild(child);
		}
	});
	plugin.app.workspace.onLayoutReady(schedule);
}

/** Unloads and forgets the child rendering `embed`, if one is still tracked as live. */
function disposeChild(plugin: CommentatorPlugin, state: EmbedState, embed: HTMLElement): void {
	const prev = state.children.get(embed);
	if (!prev) return;
	state.children.delete(embed);
	if (state.live.delete(prev)) plugin.removeChild(prev);
}

async function renderOriginal(plugin: CommentatorPlugin, state: EmbedState, embed: HTMLElement): Promise<void> {
	const app = plugin.app;
	const content = embed.querySelector<HTMLElement>(":scope > .markdown-embed-content");
	if (!content) return;
	const host = hostPath(app, embed);
	if (!host) return;

	const src = embed.getAttribute("src") ?? "";
	// EXPL: Guards against re-rendering embeds another plugin renders under a different source path than the
	//       host note's own cache records for this `src`.
	const host_file = app.vault.getFileByPath(host);
	if (!host_file || !app.metadataCache.getFileCache(host_file)?.embeds?.some(e => e.link === src)) return;

	const hash = src.indexOf("#");
	const linkpath = hash === -1 ? src : src.slice(0, hash);
	const subpath = hash === -1 ? "" : src.slice(hash);
	const file = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, host) : app.vault.getFileByPath(host);
	if (!(file instanceof TFile) || file.extension !== "md") return;

	// EXPL: Lets nested transclusions resolve their links relative to this note.
	embed.dataset.inklingPath = file.path;

	// EXPL: Obsidian owns this element's children and periodically rewrites them (on render/scroll/resize),
	//       so our wrapper is never inserted inside it; it is hidden and our wrapper sits beside it instead.
	const preview = content.querySelector<HTMLElement>(":scope > .markdown-preview-view");
	if (!preview) return;

	const signature = `${file.path}${subpath}@${file.stat.mtime}#${generation.get(file.path) ?? 0}`;
	const existing = content.querySelector<HTMLElement>(`:scope > .${RENDERED_CLASS}`);
	if (existing?.dataset.signature === signature) return;
	if (content.dataset.inklingPlain === signature) return;

	const target = embedTarget(app, file, subpath);
	if (!target) return;
	const slice = embedSlice(await app.vault.cachedRead(file), target);
	if (state.disposed || !embed.isConnected) return;

	if (!hasCriticMarkup(slice, plugin.settings)) {
		// EXPL: Leave Obsidian's own rendering untouched when there is nothing to clean; the source may have
		//       lost its markup since the last render, so drop any stale wrapper left over from that render.
		disposeChild(plugin, state, embed);
		existing?.remove();
		preview.classList.remove(HIDDEN_CLASS);
		content.dataset.inklingPlain = signature;
		return;
	}
	delete content.dataset.inklingPlain;

	const wrapper = createDiv({ cls: RENDERED_CLASS });
	wrapper.dataset.signature = signature;

	const child = new MarkdownRenderChild(wrapper);
	plugin.addChild(child);
	// EXPL: The wrapper sits outside Obsidian's own click-handling root, so internal links need their own
	//       handler; external links are plain <a> tags and work natively.
	child.registerDomEvent(wrapper, "click", (evt) => {
		const target_el = evt.target;
		const link = target_el instanceof HTMLElement ? target_el.closest<HTMLAnchorElement>("a.internal-link") : null;
		if (!link) return;
		evt.preventDefault();
		const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
		void app.workspace.openLinkText(href, file.path, Keymap.isModEvent(evt));
	});

	await MarkdownRenderer.render(app, toOriginalText(slice, plugin.settings), wrapper, file.path, child);
	if (state.disposed || !embed.isConnected) {
		plugin.removeChild(child);
		return;
	}

	disposeChild(plugin, state, embed);
	state.children.set(embed, child);
	state.live.add(child);

	existing?.remove();
	preview.classList.add(HIDDEN_CLASS);
	preview.after(wrapper);
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
