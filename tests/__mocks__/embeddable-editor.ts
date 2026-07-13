import type { App } from "obsidian";

import type { MarkdownEditorProps } from "../../src/ui/embeddable-editor";

// Jest stub for src/ui/embeddable-editor.ts.
//
// The real module extends a class resolved at MODULE LOAD TIME via
// `resolveEditorPrototype(app)`, which reaches into the live Obsidian app
// (app.embedRegistry...) to grab a prototype. That is unavailable under
// jest and throws `Class extends value undefined is not a constructor or
// null` as soon as anything transitively imports the real module.
//
// This stub is wired in via jest.config.cjs `moduleNameMapper` so nothing
// that imports "*/embeddable-editor" ever loads the real file under test.
// It only needs to satisfy the runtime names other modules import from it;
// most covered test paths don't instantiate an editor at all.
//
// EXPL: reply_box.test.ts DOES instantiate one, to pin the Enter/Shift+Enter/Escape/blur contract
//       (the actual subject of the reply-box feature) against real code instead of just reading
//       it. The real editor drives those hooks from a CodeMirror keymap and a native DOM "blur"
//       listener (embeddable-editor.ts buildLocalExtensions / constructor) — both invisible to
//       jsdom — so pressEnter/pressEscape/triggerBlur below call the exact same `options.onEnter`
//       /`onEscape`/`onBlur` hooks those real bindings call, standing in for the keypress/blur
//       instead of re-deriving the contract by hand.
export class EmbeddableMarkdownEditor {
	// EXPL: Lets tests confirm how many editors got created for a card, without a real DOM
	//       insertion to count (this stub never touches `container`, unlike the real editor).
	static instances: EmbeddableMarkdownEditor[] = [];

	options: MarkdownEditorProps;
	value: string;
	destroyed = false;

	constructor(public app: App, public container: HTMLElement, options: Partial<MarkdownEditorProps> = {}) {
		this.options = { ...defaultMarkdownEditorProps, ...options };
		this.value = this.options.value;
		EmbeddableMarkdownEditor.instances.push(this);
	}

	register() {}

	unload() {
		this.destroyed = true;
	}

	get() {
		return this.value;
	}

	set(value: string, _focus?: boolean) {
		this.value = value;
	}

	showEditor() {}
	setEditable(_editable: boolean) {}

	// EXPL: This stub deliberately doesn't extend the real EmbeddableMarkdownEditor (see file
	//       header), so it isn't assignable to the `editor` parameter type these hooks declare;
	//       the cast bridges that, same as `MarkdownEditorProps`'s "this stub stands in for the
	//       real class" contract everywhere else in this file.
	pressEnter(shift = false): boolean {
		return this.options.onEnter(this as unknown as Parameters<MarkdownEditorProps["onEnter"]>[0], false, shift);
	}

	pressEscape(): void {
		this.options.onEscape(this as unknown as Parameters<MarkdownEditorProps["onEscape"]>[0]);
	}

	triggerBlur(): void {
		this.options.onBlur(this as unknown as Parameters<MarkdownEditorProps["onBlur"]>[0]);
	}
}

export const defaultMarkdownEditorProps: MarkdownEditorProps = {
	cursorLocation: { anchor: 0, head: 0 },
	value: "",
	cls: "",
	placeholder: "",
	focus: true,
	filteredExtensions: [],
	onEnter: () => false,
	onEscape: () => {},
	onSubmit: () => {},
	onBlur: () => {},
	onPaste: () => {},
	onChange: () => {},
};
