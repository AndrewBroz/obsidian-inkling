import { StateField } from "@codemirror/state";

export const moment = {
	locale: () => {
		return "en";
	},
};

/** @public */
export interface RequestUrlParam {
	/** @public */
	url: string;
	/** @public */
	method?: string;
	/** @public */
	contentType?: string;
	/** @public */
	body?: string | ArrayBuffer;
	/** @public */
	headers?: Record<string, string>;
	/** @public */
	throw?: boolean;
}

/** @public */
export interface RequestUrlResponse {
	/** @public */
	status: number;
	/** @public */
	headers: Record<string, string>;
	/** @public */
	arrayBuffer: ArrayBuffer;
	/** @public */
	json: unknown;
	/** @public */
	text: string;
}

export async function requestUrl(request: RequestUrlParam) {
	const response = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body,
	});
	if (response.status >= 400 && request.throw)
		throw new Error(`Request failed, ${response.status}`);
	// Turn response headers into Record<string, string> object
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	const arraybuffer = await response.arrayBuffer();
	const text = arraybuffer ? new TextDecoder().decode(arraybuffer) : "";
	const json = text ? JSON.parse(text) : {};
	return {
		status: response.status,
		headers: headers,
		arrayBuffer: arraybuffer,
		json: json,
		text: text,
	} satisfies RequestUrlResponse;
}

// The real "obsidian" npm package ships type declarations only (its
// package.json "main" is ""); the runtime module provides no implementation.
// Obsidian itself injects the real objects when the plugin runs inside the
// app. Several modules import runtime *values* from "obsidian" (e.g.
// `class Foo extends Component`), which crashes under jest with
// "Class extends value undefined is not a constructor or null" unless a
// stand-in is provided here. These are minimal, inert stand-ins sufficient
// for modules to load; they are not a behavioral reimplementation of
// Obsidian's API, and code paths that actually exercise them at test
// runtime may still no-op or fail - acceptable for functionality outside
// what the test suite covers.

export class Component {
	_loaded = false;
	_children: Component[] = [];
	load() {
		this._loaded = true;
		this.onload();
	}
	onload() {}
	// EXPL: Unloading cascades, as it does in Obsidian — a component owns its children's lifetimes.
	//       Without the cascade a component could "unload" while its children stayed live, and a test
	//       could not tell a properly torn-down card from one leaking a loaded editor.
	unload() {
		this._loaded = false;
		for (const child of this._children.splice(0))
			child.unload();
		this.onunload();
	}
	onunload() {}
	addChild<T extends Component>(child: T): T {
		this._children.push(child);
		return child;
	}
	// EXPL: Detaches the child (and unloads it, as Obsidian does for a loaded child) rather than
	//       handing it straight back. The old no-op made component-teardown bugs INVISIBLE to tests:
	//       a stale child stayed on `_children` forever, so an assertion could never tell a component
	//       that had released its old child from one still holding both — which is exactly the leak
	//       `PendingAnnotationMarker.toDOM`'s `hideReplyBox()` call exists to prevent
	//       (tests/pending_card.test.ts, "toDOM twice…").
	removeChild<T extends Component>(child: T): T {
		const idx = this._children.indexOf(child);
		if (idx !== -1)
			this._children.splice(idx, 1);
		child.unload();
		return child;
	}
	register(_cb: () => any) {}
	registerEvent(_ref: any) {}
	registerDomEvent(..._args: any[]) {}
	registerInterval(id: number) {
		return id;
	}
}

export class Events {
	on(..._args: any[]) {
		return { unsubscribe: () => {} };
	}
	off(..._args: any[]) {}
	offref(..._args: any[]) {}
	trigger(..._args: any[]) {}
	tryTrigger(..._args: any[]) {}
}

export class Modal extends Component {
	constructor(public app?: any) {
		super();
	}
	contentEl: any = typeof document !== "undefined" ? document.createElement("div") : undefined;
	titleEl: any = typeof document !== "undefined" ? document.createElement("div") : undefined;
	open() {}
	close() {}
	onOpen() {}
	onClose() {}
}

export class TextComponent {
	inputEl: any = typeof document !== "undefined" ? document.createElement("input") : undefined;
	private _onChange?: (value: string) => any;
	setValue(_v: string) {
		return this;
	}
	setPlaceholder(_p: string) {
		return this;
	}
	setDisabled(_d: boolean) {
		return this;
	}
	onChange(cb: (value: string) => any) {
		this._onChange = cb;
		return this;
	}
}

export class ButtonComponent {
	buttonEl: any = typeof document !== "undefined" ? document.createElement("button") : undefined;
	setButtonText(_t: string) {
		return this;
	}
	setCta() {
		return this;
	}
	setWarning() {
		return this;
	}
	setDisabled(_d: boolean) {
		return this;
	}
	onClick(_cb: (evt: MouseEvent) => any) {
		return this;
	}
}

export class Setting {
	settingEl: any = typeof document !== "undefined" ? document.createElement("div") : undefined;
	constructor(public containerEl?: any) {}
	setName(_n: string) {
		return this;
	}
	setDesc(_d: string) {
		return this;
	}
	setClass(_c: string) {
		return this;
	}
	setHeading() {
		return this;
	}
	setDisabled(_d: boolean) {
		return this;
	}
	addButton(cb: (component: ButtonComponent) => any) {
		cb(new ButtonComponent());
		return this;
	}
	addText(cb: (component: TextComponent) => any) {
		cb(new TextComponent());
		return this;
	}
}

export class ItemView extends Component {
	constructor(public leaf?: any) {
		super();
	}
	containerEl: any = typeof document !== "undefined" ? document.createElement("div") : undefined;
	getViewType() {
		return "";
	}
	getDisplayText() {
		return "";
	}
	getIcon() {
		return "";
	}
	onOpen() {
		return Promise.resolve();
	}
	onClose() {
		return Promise.resolve();
	}
}

export class PluginSettingTab {
	constructor(public app?: any, public plugin?: any) {}
	containerEl: any = typeof document !== "undefined" ? document.createElement("div") : undefined;
	display() {}
	hide() {}
}

export class MenuItem {
	setTitle(_t: string) {
		return this;
	}
	setIcon(_i: string) {
		return this;
	}
	setChecked(_c: boolean) {
		return this;
	}
	setDisabled(_d: boolean) {
		return this;
	}
	onClick(_cb: (evt: MouseEvent | KeyboardEvent) => any) {
		return this;
	}
}

export class Menu {
	addItem(cb: (item: MenuItem) => any) {
		cb(new MenuItem());
		return this;
	}
	addSeparator() {
		return this;
	}
	showAtMouseEvent(_evt: MouseEvent) {
		return this;
	}
	showAtPosition(_pos: { x: number; y: number }) {
		return this;
	}
	onHide(_cb: () => any) {
		return this;
	}
	hide() {
		return this;
	}
}

export class Notice {
	constructor(_message?: string | DocumentFragment, _timeout?: number) {}
	setMessage(_message: string | DocumentFragment) {
		return this;
	}
	hide() {}
}

export class Scope {
	register(..._args: any[]) {
		return {};
	}
	unregister(..._args: any[]) {}
}

export class TFile {
	path = "";
	name = "";
	basename = "";
	extension = "";
}

export class WorkspaceLeaf {
	view: any;
	openFile(..._args: any[]) {
		return Promise.resolve();
	}
	setViewState(..._args: any[]) {
		return Promise.resolve();
	}
}

export const MarkdownRenderer = {
	render: (..._args: any[]) => Promise.resolve(),
	renderMarkdown: (..._args: any[]) => Promise.resolve(),
};

export const Platform = {
	isMobile: false,
	isMobileApp: false,
	isDesktopApp: true,
	isAndroidApp: false,
	isIosApp: false,
	isMacOS: false,
	isWin: false,
	isLinux: false,
};

export const apiVersion = "0.0.0-jest";

export function setIcon(..._args: any[]) {}

// EXPL: Mirrors the real setTooltip's DOM contract (extracted from Obsidian's shipped
//       app.js: functions Ix/Ox/Nx) closely enough for headless assertions — it sets
//       aria-label for the accessible name, and only writes data-tooltip-position when the
//       placement differs from the implicit default ("bottom"), exactly like the real
//       Nx(): `i && "bottom" !== i && e.setAttribute("data-tooltip-position", i)`.
export interface TooltipOptions {
	placement?: "top" | "bottom" | "left" | "right";
	classes?: string[];
	gap?: number;
	delay?: number;
}

export function setTooltip(el: HTMLElement, tooltip: string, options?: TooltipOptions) {
	el.setAttribute("aria-label", tooltip);
	const placement = options?.placement ?? "bottom";
	if (placement !== "bottom")
		el.setAttribute("data-tooltip-position", placement);
	else
		el.removeAttribute("data-tooltip-position");
}

export function debounce<T extends (...args: any[]) => any>(
	fn: T,
	_timeout?: number,
	_resetTimer?: boolean,
): T & { cancel?: () => void } {
	const wrapped = ((...args: any[]) => fn(...args)) as T & { cancel?: () => void };
	wrapped.cancel = () => {};
	return wrapped;
}

export function sanitizeHTMLToDom(html: string) {
	const template = document.createElement("template");
	template.innerHTML = html;
	return template.content;
}

export function prepareSimpleSearch(query: string) {
	return (text: string) => (text.includes(query) ? { score: 0, matches: [] } : null);
}

export function requireApiVersion(..._args: any[]) {
	return true;
}

// Only used as arguments to `state.field(...)`. Unless a test explicitly
// includes them among a state's `extensions`, code that reads them at
// runtime will throw "Field is not present in this state" - a pre-existing
// gap between the isolated CodeMirror test harness and Obsidian's real
// editor state (which always installs the real fields), not something
// introduced by this mock. `editorEditorField` is defined as a real
// StateField (rather than a plain object) so tests that *do* need to
// satisfy `suggestionMode`'s unconditional read of it can add it to their
// state's extensions.
// `editorInfoField` is likewise a real StateField so tests that exercise code reading
// `state.field(editorInfoField)` (e.g. the annotation gutter's preview rendering) can add it to
// their state's extensions; its value only needs an `app` for the mocked MarkdownRenderer.
export const editorInfoField = StateField.define<{ app: App }>({
	create: () => ({ app: new App() }),
	update: (value) => value,
});
export const editorEditorField = StateField.define<{ cm?: unknown }>({
	create: () => ({}),
	update: (value) => value,
});
export const editorLivePreviewField = {};

export class App {
	workspace: any = {};
	vault: any = {};
	metadataCache: any = {};
	embedRegistry: any = {};
	scope: any = new Scope();
}
