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
// EXPL: Matches Obsidian's own transclusion depth limit.
const MAX_DEPTH = 5;
// EXPL: Added nodes that can introduce or populate a transclusion; Obsidian appends `.markdown-embed-content`
//       to an already-inserted `.internal-embed` once the embedded file has loaded.
const EMBED_NODE_SELECTOR = ".markdown-embed, .internal-embed, .markdown-embed-content";

// EXPL: Keyed by file path; bumped whenever MetadataCache reparses a file, because mtime alone updates
//       before the cache does and would otherwise let a render run against stale headings/blocks.
const generation = new Map<string, number>();

interface EmbedState {
	disposed: boolean;
	/** The live MarkdownRenderChild currently showing original text for a given embed element, if any. */
	children: WeakMap<HTMLElement, MarkdownRenderChild>;
	/** Mirrors the values of `children`, so stale entries (containerEl detached) can be swept each scan. */
	live: Set<MarkdownRenderChild>;
	/** The file an embed element's `src` resolved to, so steady-state scans skip host and link resolution. */
	resolved: WeakMap<HTMLElement, { src: string; path: string }>;
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
	const state: EmbedState = { disposed: false, children: new WeakMap(), live: new Set(), resolved: new WeakMap() };
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
		let rendered = false;
		for (const embed of Array.from(document.body.querySelectorAll<HTMLElement>(EMBED_SELECTOR))) {
			if (state.disposed) return;
			if (in_flight.has(embed)) continue;
			in_flight.add(embed);
			try {
				if (await renderOriginal(plugin, state, embed)) rendered = true;
			} catch (e) {
				console.error("Inkling: could not render transclusion as original text", e);
			} finally {
				in_flight.delete(embed);
			}
		}
		// EXPL: Transclusions nested in a new wrapper were populated while it was hidden (and so skipped);
		//       unhiding it is not a childList mutation, so rescan explicitly.
		if (rendered) schedule();
	};

	const schedule = () => {
		if (state.disposed || frame !== null) return;
		frame = window.requestAnimationFrame(() => {
			frame = null;
			void scan();
		});
	};

	// EXPL: Only mutations that add a transclusion matter; anything else (typing, scrolling) would otherwise
	//       rescan every embed on every DOM change.
	const observer = new MutationObserver((records) => {
		const adds_embed = records.some(record =>
			Array.from(record.addedNodes).some(node =>
				node instanceof Element &&
				(node.matches(EMBED_NODE_SELECTOR) || node.querySelector(EMBED_NODE_SELECTOR) !== null)
			)
		);
		if (adds_embed) schedule();
	});
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

/** Renders `embed` as original text; returns whether a new rendering was shown. */
async function renderOriginal(plugin: CommentatorPlugin, state: EmbedState, embed: HTMLElement): Promise<boolean> {
	// EXPL: Obsidian's raw nested embeds stay in the DOM under a hidden preview (see below); skip them so
	//       they are never rendered invisibly.
	if (embed.closest(`.${HIDDEN_CLASS}`)) return false;

	const app = plugin.app;
	const content = embed.querySelector<HTMLElement>(":scope > .markdown-embed-content");
	if (!content) return false;
	// EXPL: Obsidian owns this element's children and periodically rewrites them (on render/scroll/resize),
	//       so our wrapper is never inserted inside it; it is hidden and our wrapper sits beside it instead.
	const preview = content.querySelector<HTMLElement>(":scope > .markdown-preview-view");
	if (!preview) return false;

	const src = embed.getAttribute("src") ?? "";
	const file = resolveEmbedFile(app, state, embed, src);
	if (!file) return false;
	const hash = src.indexOf("#");
	const subpath = hash === -1 ? "" : src.slice(hash);
	const key = `${file.path}${subpath}`;

	// EXPL: Lets nested transclusions resolve their links relative to this note, and detect cycles.
	embed.dataset.inklingPath = file.path;
	embed.dataset.inklingKey = key;

	const signature = `${key}@${file.stat.mtime}#${generation.get(file.path) ?? 0}`;
	const existing = content.querySelector<HTMLElement>(`:scope > .${RENDERED_CLASS}`);
	if (existing?.dataset.signature === signature) return false;
	if (content.dataset.inklingPlain === signature) return false;
	if (tooDeep(embed, key)) return false;

	const target = embedTarget(app, file, subpath);
	if (!target) return false;
	const slice = embedSlice(await app.vault.cachedRead(file), target);
	if (state.disposed || !embed.isConnected) return false;

	if (!hasCriticMarkup(slice, plugin.settings)) {
		// EXPL: Leave Obsidian's own rendering untouched when there is nothing to clean; the source may have
		//       lost its markup since the last render, so drop any stale wrapper left over from that render.
		disposeChild(plugin, state, embed);
		existing?.remove();
		preview.classList.remove(HIDDEN_CLASS);
		content.dataset.inklingPlain = signature;
		return false;
	}
	delete content.dataset.inklingPlain;

	// EXPL: The wrapper sits outside `.markdown-preview-view`, so it needs `markdown-rendered` itself to pick
	//       up Obsidian's styling for headings, lists, tables, code, blockquotes, etc. (never
	//       `markdown-preview-view`, so the `:scope > .markdown-preview-view` lookup above can never match
	//       it). `rtl`/`show-indentation-guide` are copied from the hidden preview since they are state, not
	//       part of the `markdown-rendered` ruleset itself.
	const wrapper = createDiv({ cls: `${RENDERED_CLASS} markdown-rendered ${HIDDEN_CLASS}` });
	wrapper.classList.toggle("rtl", preview.classList.contains("rtl"));
	wrapper.classList.toggle("show-indentation-guide", preview.classList.contains("show-indentation-guide"));
	wrapper.dataset.signature = signature;

	const child = new MarkdownRenderChild(wrapper);
	plugin.addChild(child);
	// EXPL: The wrapper sits outside Obsidian's own click-handling root, so internal links need their own
	//       handling; external links are plain <a> tags and work natively. Propagation is stopped so the host
	//       view does not also open the link (relative to the host note rather than this one).
	const internalLinkAt = (evt: Event): HTMLAnchorElement | null => {
		const target_el = evt.target;
		return target_el instanceof HTMLElement ? target_el.closest<HTMLAnchorElement>("a.internal-link") : null;
	};
	const openInternalLink = (evt: MouseEvent, new_leaf: boolean | "tab" | "split" | "window") => {
		const link = internalLinkAt(evt);
		if (!link) return;
		evt.preventDefault();
		evt.stopPropagation();
		const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
		void app.workspace.openLinkText(href, file.path, new_leaf);
	};
	child.registerDomEvent(wrapper, "click", (evt) => openInternalLink(evt, Keymap.isModEvent(evt)));
	// EXPL: Middle-click opens in a new tab, matching Obsidian's own embed links; other aux buttons (back/
	//       forward/right) are left to the browser's defaults.
	child.registerDomEvent(wrapper, "auxclick", (evt) => {
		if (evt.button === 1) openInternalLink(evt, true);
	});
	child.registerDomEvent(wrapper, "mouseover", (evt) => {
		const link = internalLinkAt(evt);
		if (!link) return;
		evt.stopPropagation();
		const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
		// EXPL: Drives the core "Page preview" plugin's hover popover. The event payload has no exported
		//       type in obsidian.d.ts (only `registerHoverLinkSource`/`HoverLinkSource` are typed), so it is
		//       passed as a plain object; `Workspace.trigger` itself accepts `unknown[]`.
		app.workspace.trigger("hover-link", {
			event: evt,
			source: "preview",
			hoverParent: child,
			targetEl: link,
			linktext: href,
			sourcePath: file.path,
		});
	});

	// EXPL: Rendered while attached (but hidden) so Obsidian's own nesting guard, which walks up from the
	//       render target, sees how deep this transclusion is; a detached wrapper would restart it at depth 1.
	preview.after(wrapper);
	try {
		await MarkdownRenderer.render(app, toOriginalText(slice, plugin.settings), wrapper, file.path, child);
	} catch (e) {
		plugin.removeChild(child);
		wrapper.remove();
		throw e;
	}
	if (state.disposed || !embed.isConnected || !wrapper.isConnected) {
		plugin.removeChild(child);
		wrapper.remove();
		return false;
	}

	disposeChild(plugin, state, embed);
	state.children.set(embed, child);
	state.live.add(child);

	existing?.remove();
	preview.classList.add(HIDDEN_CLASS);
	wrapper.classList.remove(HIDDEN_CLASS);
	return true;
}

/** The markdown file `embed` transcludes, or null if it is not one Inkling should render. */
function resolveEmbedFile(app: App, state: EmbedState, embed: HTMLElement, src: string): TFile | null {
	const memo = state.resolved.get(embed);
	if (memo?.src === src) {
		const file = app.vault.getFileByPath(memo.path);
		if (file) return file;
	}
	state.resolved.delete(embed);

	const host = hostPath(app, embed);
	if (!host) return null;
	// EXPL: Guards against re-rendering embeds another plugin renders under a different source path than the
	//       host note's own cache records for this `src`.
	const host_file = app.vault.getFileByPath(host);
	if (!host_file || !app.metadataCache.getFileCache(host_file)?.embeds?.some(e => e.link === src)) return null;

	const hash = src.indexOf("#");
	const linkpath = hash === -1 ? src : src.slice(0, hash);
	const file = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, host) : host_file;
	if (!(file instanceof TFile) || file.extension !== "md") return null;
	state.resolved.set(embed, { src, path: file.path });
	return file;
}

/** Whether `embed` is nested too deeply, or inside a transclusion of the same note (a cycle). */
function tooDeep(embed: HTMLElement, key: string): boolean {
	let depth = 0;
	for (
		let el = embed.parentElement?.closest(`.${RENDERED_CLASS}`);
		el;
		el = el.parentElement?.closest(`.${RENDERED_CLASS}`)
	) {
		if (++depth >= MAX_DEPTH) return true;
	}
	for (
		let el = embed.parentElement?.closest<HTMLElement>(".internal-embed[data-inkling-key]");
		el;
		el = el.parentElement?.closest<HTMLElement>(".internal-embed[data-inkling-key]")
	) {
		if (el.dataset.inklingKey === key) return true;
	}
	return false;
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
