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
// none of the covered test paths actually instantiate an editor.
export class EmbeddableMarkdownEditor {
	constructor(..._args: any[]) {}
	register() {}
	unload() {}
	set() {}
	showEditor() {}
	setEditable(_editable: boolean) {}
}

export const defaultMarkdownEditorProps = {
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
