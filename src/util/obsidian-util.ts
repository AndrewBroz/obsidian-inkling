import { apiVersion, App, type Menu, MenuItem, Notice, Platform } from "obsidian";
import { PLUGIN_ID } from "../plugin-id";

/**
 * Helper function for opening the settings tab of the plugin
 *
 * @param app - Obsidian app instance
 * @param plugin_id - ID of the tab to open
 * @remark prevents the plugin tab to be opened again, despite already being open (otherwise, some nasty bugs can occur due to settings mount logic of settings page unnecessarily being executed twice)
 */
export function openSettingTab(app: App, plugin_id: string = PLUGIN_ID) {
	app.setting.open();
	if (app.setting.lastTabId !== plugin_id)
		app.setting.openTabById(plugin_id);
}

/**
 * Link to a new bug report on GitHub, with the Obsidian and Inkling versions and the platform filled in
 * @param app - Obsidian app instance
 * @param title - Title of the bug report
 */
export function generateGithubIssueLink(app: App, title: string): string {
	const platform = Platform.isAndroidApp ?
		"Android" :
		Platform.isIosApp ?
		"iOS" :
		Platform.isMacOS ?
		"macOS" :
		Platform.isWin ?
		"Windows" :
		Platform.isLinux ?
		"Linux" :
		"";
	const params = new URLSearchParams({
		title,
		template: "bug-report.yml",
		"app-version": apiVersion,
		"inkling-version": app.plugins.plugins[PLUGIN_ID]?.manifest.version ?? "",
		"operating-systems": platform,
	});
	return `https://github.com/AndrewBroz/obsidian-inkling/issues/new?${params.toString()}`;
}

/**
 * Open a new bug report on GitHub for the user
 * @param app - Obsidian app instance
 * @param title - Title of the bug report
 */
export function openGithubIssueLink(app: App, title: string = "") {
	window.open(generateGithubIssueLink(app, title), "_blank");
}

/**
 * Helper function to overwrite a method of a view whose prototype is not directly accessible
 * @param app - Obsidian app instance
 * @param viewType - Type of the view (should exist in app.viewRegistry.viewByType)
 * @param getChildPrototype - Function to get the prototype of the child view (if the view is a composite view)
 * @tutorial
 * ```ts
 * this.app.workspace.onLayoutReady(async () => {
 *    const uninstall = around(getPrototype('outline'), {
 *    createItemDom: (oldMethod, view) => {
 *        return (call_args: any[]) => {
 *            const output = oldMethod(call_args);
 *            return output;
 *        }
 *    }
 * });
 * ```
 */
export function getViewPrototype<T>(
	app: App,
	viewType: string,
	getChildPrototype: (view: unknown) => unknown = (view) => view,
): T {
	const leafOfType = app.workspace.getLeavesOfType(viewType)[0];
	let prototype: T;
	if (leafOfType)
		prototype = Object.getPrototypeOf(getChildPrototype(leafOfType.view)) as T;
	else {
		const leaf = app.workspace.getLeaf("split");
		const constructed_leaf = app.viewRegistry.getViewCreatorByType(viewType)?.(leaf);
		prototype = Object.getPrototypeOf(getChildPrototype(constructed_leaf)) as T;
		leaf.detach();
	}
	return prototype;
}

/**
 * Show a progress bar notice in Obsidian, supports ratio's
 * @param initialMessage - The initial message to display in the notice
 * @param finishedMessage - The message to display when the progress is complete
 * @param numOperations - The total number of operations to track progress for
 * @param duration - The duration in milliseconds to keep the notice visible after completion (default is 300ms)
 * @param description - Optional small description to display in the notice
 */
export function showProgressBarNotice(
	initialMessage: string,
	finishedMessage: string,
	numOperations: number = 100,
	duration: number = 3000,
	description?: string,
) {
	const notice = new Notice("", 0);
	notice.messageEl.appendChild(createSpan({ text: initialMessage }));

	if (description) {
		notice.messageEl.appendChild(createEl("br"));
		notice.messageEl.appendChild(createSpan({ cls: "u-small", text: description }));
	}

	let progressBar = createEl("progress");
	progressBar.value = 0;
	progressBar.max = numOperations;
	notice.messageEl.appendChild(progressBar);

	return (val: number) => {
		if (val >= numOperations) {
			notice.setMessage(finishedMessage);
			notice.containerEl.addClass("mod-success");
			window.setTimeout(() => {
				notice.hide();
			}, duration);
		} else {
			progressBar.value = Math.round(val);
		}
	};
}

export function menuSingleChoiceExclusive<T>(
	menu: Menu,
	current_value: T,
	options: { icon: string; value: T; tooltip: string }[],
	onChange: (value: T) => void,
) {
	for (const { icon, tooltip, value } of options) {
		menu.addItem((item) => {
			item
				.setTitle(tooltip)
				.setIcon(icon)
				.setChecked(current_value === value)
				.onClick(() => {
					onChange(value);
					for (const subitem of menu.items) {
						if (subitem instanceof MenuItem) {
							const is_active = subitem === item;
							subitem.dom.classList.toggle("mod-checked", is_active);
							subitem.setChecked(is_active);
						}
					}
				});
		});
	}
}
