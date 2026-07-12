import { type App, Modal, Setting } from "obsidian";

/**
 * One-time first-install prompt for the display name used in suggestion/comment attribution.
 * Skipping is fine: generate_metadata omits the author field while settings.author is empty.
 */
export class AuthorNameModal extends Modal {
	constructor(app: App, private onSubmit: (author: string) => void) {
		super(app);
	}

	onOpen() {
		let value = "";
		this.titleEl.setText("Commentator: choose your author name");
		this.contentEl.createEl("p", {
			text: "Suggestions and comments you make will be attributed to this name. " +
				"You can change it any time under Settings → Commentator → Metadata.",
		});
		new Setting(this.contentEl)
			.setName("Display name")
			.addText(text => text.onChange(v => value = v));
		new Setting(this.contentEl)
			.addButton(btn =>
				btn.setButtonText("Save").setCta().onClick(() => {
					this.onSubmit(value.trim());
					this.close();
				})
			)
			.addButton(btn => btn.setButtonText("Skip").onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}
