import { type App, Modal, Setting } from "obsidian";

export interface ConfirmOptions {
	title: string;
	body: string;
	confirm: string;
	onConfirm: () => void;
}

export class ConfirmModal extends Modal {
	constructor(app: App, private options: ConfirmOptions) {
		super(app);
	}

	onOpen() {
		this.setTitle(this.options.title);
		this.contentEl.createEl("p", { text: this.options.body });
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button =>
				button.setButtonText(this.options.confirm).setCta().onClick(() => {
					this.close();
					this.options.onConfirm();
				})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
