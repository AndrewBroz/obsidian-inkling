import { App, Component, MarkdownRenderer } from "obsidian";
import { defaultMarkdownEditorProps, EmbeddableMarkdownEditor, type MarkdownEditorProps } from "./embeddable-editor";

interface PreviewEditorProps extends Omit<MarkdownEditorProps, "cls"> {
	/**
	 * The mode of the editor, either "preview" or "edit".
	 * - "preview": Display using MarkdownRenderer.
	 * - "edit": Displays an embeddable markdown editor for editing.
	 */
	mode: "preview" | "edit";

	/**
	 * The CSS classes to apply when in edit mode.
	 */
	editor_cls: string | string[] | undefined;
	/**
	 * The CSS classes to apply when in preview mode.
	 */
	preview_cls: string | string[] | undefined;

	/**
	 * The container to listen for click events to switch to edit mode.
	 */
	click_container?: HTMLElement;
	/**
	 * Determine what type of event to listen for to switch to edit mode when interacting with the container.
	 */
	focus_mode: "click" | "dblclick";

	/**
	 * Callback when the editor is submitted.
	 * @param editor - The preview editor instance.
	 */
	onViewSwitch: (editor: PreviewEditor) => void;

	/**
	 * Callback for determining whether the editor may be activated when in preview mode.
	 * This is useful for preventing editing in certain contexts.
	 * @param editor - The preview editor instance.
	 * @return true if the editor is editable, false otherwise.
	 */
	isEditable: (editor: PreviewEditor) => boolean;
}

const defaultPreviewEditorProps: Partial<PreviewEditorProps> = {
	mode: "preview",

	focus_mode: "click",

	onViewSwitch: () => {},
	isEditable: () => true,
};

export class PreviewEditor extends Component {
	public options: PreviewEditorProps;
	private currentMode!: "preview" | "edit";
	private clickContainer: HTMLElement;
	// EXPL: Preview mode's one-shot click-to-edit listener, while it is armed.
	private clickListener: (() => void) | null = null;

	constructor(private app: App, private container: HTMLElement, options: Partial<PreviewEditorProps> = {}) {
		super();
		this.options = {
			...defaultMarkdownEditorProps,
			...defaultPreviewEditorProps,
			...options,
		} as PreviewEditorProps;
		this.clickContainer = this.options.click_container ?? this.container;

		if (this.options.mode === "edit")
			this.renderEdit();
		else
			this.renderPreview();
	}

	cleanup() {
		if (this.container.children.length === 0)
			return;

		this.container.className = "";
		for (const child of this._children)
			child.unload();
		this._children = [];
		this.container.empty();
	}

	unload() {
		this.container.remove();
		super.unload();
	}

	getMode(): "preview" | "edit" {
		return this.currentMode;
	}

	switchMode() {
		if (this.currentMode === "edit")
			this.renderPreview();
		else
			this.renderEdit();

		this.options.onViewSwitch(this);
	}

	setMode(mode: "preview" | "edit") {
		if (mode === "edit")
			this.renderEdit();
		else
			this.renderPreview();
		this.options.onViewSwitch(this);
	}

	private renderEdit() {
		if (this.currentMode === "edit" || !this.options.isEditable(this))
			return;

		this.currentMode = "edit";
		// EXPL: Disarm preview's click-to-edit listener. When edit mode is entered some other way
		//       (setMode("edit") from the "Edit comment" menu item), it would otherwise still be
		//       listening on the click container, and the first click inside the editor would
		//       switch straight back to preview.
		this.removeClickListener();
		this.cleanup();

		if (this.options.editor_cls)
			this.container.addClass(...([] as string[]).concat(this.options.editor_cls));

		this.addChild(
			new EmbeddableMarkdownEditor(this.app, this.container, {
				...this.options,
				onSubmit: (editor) => {
					// TODO: Switch back to previewMode
					this.options.onSubmit(editor);
					this.switchMode();
				},
				onBlur: (editor) => {
					this.options.onBlur(editor);
					this.switchMode();
				},
				onEscape: (editor) => {
					this.options.onEscape(editor);
					this.switchMode();
				},
			}),
		);
	}

	private renderPreview() {
		if (this.currentMode === "preview")
			return;

		this.currentMode = "preview";
		this.cleanup();

		if (this.options.preview_cls)
			this.container.addClass(...([] as string[]).concat(this.options.preview_cls));

		MarkdownRenderer.render(this.app, this.options.value, this.container, "", this);
		this.removeClickListener();
		const click_listener = () => {
			this.removeClickListener();
			setImmediate(() => {
				this.switchMode();
			});
		};
		this.clickListener = click_listener;
		this.clickContainer.addEventListener(this.options.focus_mode, click_listener);
	}

	private removeClickListener() {
		if (!this.clickListener) return;
		this.clickContainer.removeEventListener(this.options.focus_mode, this.clickListener);
		this.clickListener = null;
	}
}
