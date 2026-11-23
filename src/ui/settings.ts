import { App, PluginSettingTab, requireApiVersion, type SettingDefinitionItem } from "obsidian";
import type CommentatorPlugin from "../main";

import { mount, unmount } from "svelte";
import { SettingsPage } from "./pages";
import { readSetting, settingDefinitions, writeSetting } from "./setting-definitions";

export class CommentatorSettings extends PluginSettingTab {
	plugin: CommentatorPlugin;
	private view: ReturnType<typeof SettingsPage> | null = null;

	constructor(app: App, plugin: CommentatorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Obsidian 1.13+ renders the tab from these (and indexes them for the settings search); display() is only
	 * called on older versions.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return settingDefinitions(this.plugin);
	}

	getControlValue(key: string): unknown {
		return readSetting(this.plugin, key);
	}

	async setControlValue(key: string, value: unknown) {
		writeSetting(this.plugin, key, value);
		// EXPL: Some settings show or hide others (the metadata fields). Obsidian only calls setControlValue on 1.13+,
		//       but the check says so explicitly: the community scan doesn't treat the hook as proof of the version.
		if (requireApiVersion("1.13.0"))
			this.refreshDomState();
		await this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.view = mount(SettingsPage, {
			target: this.containerEl,
			props: {
				plugin: this.plugin,
			},
		});
	}

	hide(): void {
		super.hide();
		if (this.view)
			void unmount(this.view);
	}
}
