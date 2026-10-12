import { type App, Notice, type PluginManifest } from "obsidian";

export const PLUGIN_ID = "inkling-markup";

// EXPL: This plugin shipped as `inkling` up to 0.11.x. That id now belongs to an unrelated
//       plugin in the community registry (bluewolf135/Inkling), so Obsidian offers its releases
//       as "updates" to our install, which would overwrite it. Everything below only touches
//       an `inkling` install whose manifest proves it is ours.
export const LEGACY_PLUGIN_ID = "inkling";
// EXPL: The id before that. Its settings schema is our ancestor, so it is imported unconditionally.
const COMMENTATOR_PLUGIN_ID = "commentator";

export function isOwnLegacyManifest(manifest: Partial<PluginManifest> | null | undefined): boolean {
	if (!manifest || manifest.id !== LEGACY_PLUGIN_ID)
		return false;
	return !!manifest.authorUrl?.includes("github.com/AndrewBroz/") ||
		manifest.author?.normalize("NFC") === "Andrew Brož".normalize("NFC");
}

async function readJson(app: App, path: string): Promise<unknown> {
	if (!(await app.vault.adapter.exists(path)))
		return null;
	return JSON.parse(await app.vault.adapter.read(path));
}

async function hasOwnLegacyInstall(app: App): Promise<boolean> {
	try {
		const manifest = await readJson(app, `${app.vault.configDir}/plugins/${LEGACY_PLUGIN_ID}/manifest.json`);
		return isOwnLegacyManifest(manifest as Partial<PluginManifest> | null);
	} catch {
		return false;
	}
}

/**
 * Settings saved under a previous plugin id, for a first load under the current id.
 * @returns the legacy settings and the id they came from, or null if there are none
 */
export async function readLegacySettings(app: App): Promise<{ id: string; settings: unknown } | null> {
	const candidates = [COMMENTATOR_PLUGIN_ID];
	if (await hasOwnLegacyInstall(app))
		candidates.unshift(LEGACY_PLUGIN_ID);

	for (const id of candidates) {
		try {
			const settings = await readJson(app, `${app.vault.configDir}/plugins/${id}/data.json`);
			if (settings != null)
				return { id, settings };
		} catch (e) {
			console.error(`Inkling: failed to import settings from legacy plugin id "${id}"`, e);
		}
	}
	return null;
}

/**
 * Copy custom hotkeys bound to `inkling:*` commands onto the matching `inkling-markup:*` commands,
 * without overriding any binding already made for the new id.
 * @returns the number of commands whose hotkeys were copied
 */
export function migrateLegacyHotkeys(app: App): number {
	const manager = app.hotkeyManager;
	const prefix = `${LEGACY_PLUGIN_ID}:`;
	let migrated = 0;
	for (const [command, keys] of Object.entries(manager.customKeys)) {
		if (!command.startsWith(prefix))
			continue;
		const target = `${PLUGIN_ID}:${command.slice(prefix.length)}`;
		if (target in manager.customKeys)
			continue;
		manager.setHotkeys(target, keys);
		migrated++;
	}
	if (migrated)
		manager.save();
	return migrated;
}

/**
 * Disable our own pre-rename copy if it is enabled; two copies running at once collide on
 * view types and editor extensions. Must run before this plugin registers anything.
 * @returns whether a legacy copy was disabled
 */
export async function disableLegacyPlugin(app: App): Promise<boolean> {
	if (!isOwnLegacyManifest(app.plugins.manifests[LEGACY_PLUGIN_ID]))
		return false;
	if (!app.plugins.enabledPlugins.has(LEGACY_PLUGIN_ID))
		return false;
	await app.plugins.disablePluginAndSave(LEGACY_PLUGIN_ID);
	return true;
}

/**
 * While our pre-rename copy is still installed, explain the rename and offer to remove it:
 * leaving it around means "Update all" in the community plugins tab replaces it with an
 * unrelated plugin that would then read Inkling's old data.json.
 */
export function noticeLegacyInstall(app: App) {
	if (!isOwnLegacyManifest(app.plugins.manifests[LEGACY_PLUGIN_ID]))
		return;

	const fragment = document.createDocumentFragment();
	const message = fragment.appendChild(document.createElement("div"));
	message.textContent = "Inkling now uses the plugin id \"inkling-markup\". Your settings and hotkeys were " +
		"carried over and the old copy (\"inkling\") was disabled. Uninstall the old copy: the community plugin " +
		"store will otherwise offer an unrelated plugin as its \"update\".";
	const button = fragment.appendChild(document.createElement("button"));
	button.textContent = "Uninstall old copy";
	button.style.marginTop = "8px";

	const notice = new Notice(fragment, 0);
	button.addEventListener("click", async (evt) => {
		evt.stopPropagation();
		notice.hide();
		try {
			await app.plugins.uninstallPlugin(LEGACY_PLUGIN_ID);
			new Notice("Inkling: removed the old \"inkling\" copy", 5000);
		} catch (e) {
			console.error("Inkling: failed to uninstall legacy plugin", e);
			new Notice("Inkling: could not remove the old copy, uninstall \"Inkling\" (0.11 or older) manually", 0);
		}
	});
}
