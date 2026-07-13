import { type EventRef, MarkdownView, Menu, setIcon, WorkspaceLeaf } from "obsidian";
import type CommentatorPlugin from "../../main";

/**
 * Position of `value` in `states`, or -1 if it is not a live mode (e.g. a stale value persisted
 * for a mode that no longer exists). Exported as a pure, Obsidian-free helper so the cycle
 * contract (order of `states` -> next value) is directly unit-testable.
 */
export function stateIndexOf<T extends { value: number }>(states: readonly T[], value: number): number {
	return states.findIndex(state => state.value === value);
}

/**
 * The state following `value` in the cycle (the first state if `value` is not a live mode).
 * The cycle walks `states` in ARRAY order, so it can never land on a retired/unknown value.
 */
export function nextStateOf<T extends { value: number }>(states: readonly T[], value: number): T {
	const index = stateIndexOf(states, value);
	return index === -1 ? states[0] : states[(index + 1) % states.length];
}

export class HeaderButton {
	active_mapping: WeakMap<MarkdownView, {
		button: HTMLElement;
		status: HTMLElement | null;
		event: EventRef;
	}> = new WeakMap();

	changeEvent: EventRef | null = null;

	constructor(
		// EXPL: States carry their own mode `value` rather than being indexed by array position:
		//       the EditMode enum no longer starts at 0 (the unprotected `OFF = 0` mode was removed,
		//       its value retired rather than renumbered, since modes are persisted in data.json).
		//       The button cycles through `states` in ARRAY order, so the cycle can never land on a
		//       retired value — there is no dead slot to skip.
		private states: { value: number; icon: string; tooltip: string; text: string }[],
		private has_label: boolean,
		private cls: string,
		private onchange: (view: MarkdownView, value: number) => void,
		private getvalue: (view: MarkdownView) => number,
		private plugin: CommentatorPlugin,
		render = false,
	) {
		this.setRendering(render);
	}

	private stateIndex(value: number) {
		return stateIndexOf(this.states, value);
	}

	private nextState(value: number) {
		return nextStateOf(this.states, value);
	}

	setRendering(render?: boolean) {
		if (render === undefined || render === !!this.changeEvent) return;

		render ? this.attachButtons() : this.detachButtons();
	}

	setLabelRendering(render?: boolean) {
		if (render === undefined || !this.changeEvent || render === this.has_label) return;
		this.has_label = render;

		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			if (!(leaf.view instanceof MarkdownView)) continue;
			const { view } = leaf;

			const index = this.stateIndex(this.getvalue(view));
			if (index === -1) continue;
			const { text } = this.states[index];
			const elements = this.active_mapping.get(view);
			if (!elements) continue;

			if (elements.status) {
				elements.status.detach();
				elements.status = null;
			} else {
				const status = elements.button.createSpan({ text, cls: this.cls });
				// @ts-expect-error Parent element exists
				elements.button.parentElement.insertBefore(status, elements.button);
				elements.status = status;
				// this.active_mapping.set(view, elements);
			}
		}
	}

	updateButton(view: MarkdownView, value: number) {
		const elements = this.active_mapping.get(view);
		if (elements) {
			const index = this.stateIndex(value);
			if (index !== -1) {
				const { tooltip, text } = this.states[index];
				setIcon(elements.button, this.nextState(value).icon);
				elements.button.setAttribute("aria-label", tooltip);
				elements.button.style.display = "";
				if (this.has_label)
					elements.status!.innerText = text;
			} else {
				elements.button.style.display = "none";
			}
		}
	}

	attachButtons() {
		if (!this.changeEvent)
			this.changeEvent = this.plugin.app.workspace.on("layout-change", this.attachButtons.bind(this));

		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			if (!(leaf.view instanceof MarkdownView)) continue;
			const { view } = leaf;

			if (this.active_mapping.has(view)) continue;
			const event = leaf.on("history-change", () => {
				this.updateButton(view, this.getvalue(view));
			});

			const value = this.getvalue(view);
			// FIXME: In rare cases (probably when the CM editor takes a while to instantiate)
			// 		The buttons will be added _after_ the editor has loaded
			// 		This could be addresses by finding a later `layout-change` event or delaying the function
			if (value === undefined) {
				console.error(
					"[COMMENTATOR] An attempt was made to attach the headerbutton before the CM editor instance was fully loaded",
				);
				return;
			}

			// EXPL: An unknown `value` (stateIndex === -1, e.g. a stale persisted value for a mode
			//       that no longer exists) must degrade the same way `updateButton` does — by hiding
			//       the button — rather than falling back to `states[0]` for display, which would
			//       silently mislabel the button as the first state.
			const index = this.stateIndex(value);
			const { tooltip, text } = this.states[index === -1 ? 0 : index];
			const button = view.addAction(this.nextState(value).icon, tooltip, async () => {
				this.onchange(view, this.nextState(this.getvalue(view)).value);
			});
			const status = this.has_label ? button.createSpan({ text, cls: this.cls }) : null;

			if (this.has_label) {
				// @ts-expect-error Parent element exists
				button.parentElement.insertBefore(status, button);
			}

			if (index === -1) button.style.display = "none";

			button.oncontextmenu = (e: MouseEvent) => {
				const menu = new Menu();
				const current_value = this.getvalue(view);
				for (const { value, icon, text } of this.states) {
					menu.addItem((item) => {
						item.setIcon(icon)
							.setTitle(text)
							.setChecked(value === current_value)
							.onClick(() => {
								this.onchange(view, value);
							});
					});
				}
				menu.showAtMouseEvent(e);
			};

			this.active_mapping.set(view, { button, status, event });
		}
	}

	detachButton(leaf: WorkspaceLeaf) {
		const view = leaf.view as MarkdownView;
		const elements = this.active_mapping.get(view);
		if (!elements) return;

		leaf.offref(elements.event);
		elements.button.detach();
		elements.status?.detach();

		this.active_mapping.delete(view);
	}

	detachButtons() {
		if (!this.changeEvent) return;

		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			if (!(leaf.view instanceof MarkdownView)) continue;
			this.detachButton(leaf);
		}
		this.plugin.app.workspace.offref(this.changeEvent!);
		this.changeEvent = null;
	}
}
