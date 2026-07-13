import { Editor, type EventRef, type MarkdownFileInfo, MarkdownView, Menu, setIcon } from "obsidian";
import type CommentatorPlugin from "../../main";

export class StatusBarButton {
	button: HTMLElement | null = null;
	value: number;
	changeEvent: EventRef | null = null;
	currentView: MarkdownFileInfo | null = null;

	constructor(
		// EXPL: States carry their own mode `value` rather than being indexed by array position:
		//       the EditMode enum no longer starts at 0 (the unprotected `OFF = 0` mode was removed,
		//       its value retired rather than renumbered, since modes are persisted in data.json).
		private states: { value: number; icon: string; text: string }[],
		private onchange: (view: MarkdownFileInfo | null, value: number) => void,
		private getvalue: (editor: Editor) => number,
		private plugin: CommentatorPlugin,
		render = false,
	) {
		this.value = states[0].value;
		this.setRendering(render);

		this.plugin.app.workspace.onLayoutReady(() => this.currentView = this.plugin.app.workspace.activeEditor);
	}

	/**
	 * Position of a mode value in `states`, or -1 if the value is not a live mode (e.g. a stale
	 * value persisted for a mode that no longer exists).
	 */
	private stateIndex(value: number) {
		return this.states.findIndex(state => state.value === value);
	}

	showMenu(e: MouseEvent) {
		const menu = new Menu();
		for (const state of this.states) {
			menu.addItem((item) => {
				item.setTitle(state.text);
				item.setIcon(state.icon);
				item.setChecked(state.value === this.value);
				item.onClick(() => this.onchange(this.currentView, state.value));
			});
		}
		menu.showAtMouseEvent(e);
		e.preventDefault();
	}

	setRendering(render?: boolean) {
		if (render === undefined || render === !!this.button) return;

		render ? this.renderButton() : this.detachButton();
	}

	updateButton(value: number) {
		if (!this.button || value === undefined) return;

		const index = this.stateIndex(value);
		if (index === -1) return;

		this.value = value;
		const { icon, text } = this.states[index];
		setIcon(this.button, icon);
		this.button.setAttribute("aria-label", text);
	}

	renderButton() {
		const { icon, text } = this.states[this.stateIndex(this.value)];

		this.changeEvent = this.plugin.app.workspace.on("active-leaf-change", (leaf) => {
			if (leaf && leaf.view instanceof MarkdownView) {
				this.currentView = leaf.view;
				this.updateButton(this.getvalue(leaf.view.editor));
				this.button!.style.display = "";
			} else {
				this.currentView = null;
				this.button!.style.display = "none";
			}
		});

		this.button = this.plugin.addStatusBarItem();
		const span = this.button.createSpan({ cls: "status-bar-item-icon" });

		setIcon(span, icon);
		this.button.classList.add("mod-clickable");
		this.button.setAttribute("aria-label", text);
		this.button.setAttribute("data-tooltip-position", "top");
		this.button.addEventListener("click", (e) => this.showMenu(e));
		this.button.addEventListener("contextmenu", (e) => this.showMenu(e));
	}

	detachButton() {
		if (!this.button) return;

		this.button.detach();
		this.button = null;
		this.plugin.app.workspace.offref(this.changeEvent!);
	}
}
