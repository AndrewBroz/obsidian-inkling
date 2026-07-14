import { Compartment } from "@codemirror/state";
import { Menu } from "obsidian";

import { acceptSuggestions, rejectSuggestions } from "../../../base";
import { pluginEditAnnotation } from "../../../uix/extensions/editing-modes";
import { diff_gutter, diffGutterHideEmptyAnnotation } from "./diff-gutter";
import { diffGutterMarkers } from "./marker";

export const diffGutter = /*(plugin: CommentatorPlugin) => */ [
	diffGutterMarkers,
	diff_gutter({
		class: "cmtr-diff-gutter", /* + (plugin.app.vault.getConfig('cssTheme') === 'Minimal' ? ' is-minimal' : '')*/
		markers: v => v.plugin(diffGutterMarkers)!.markers,
		domEventHandlers: {
			click: (view, line, event: Event) => {
				const menu = new Menu();
				menu.addItem(item => {
					item.setTitle("Accept changes")
						.setIcon("check")
						.onClick(() => {
							view.dispatch({
								changes: acceptSuggestions(view.state, line.from, line.to),
								annotations: [pluginEditAnnotation.of(true)],
							});
						});
				});
				menu.addItem(item => {
					item.setTitle("Reject changes")
						.setIcon("cross")
						.onClick(() => {
							view.dispatch({
								changes: rejectSuggestions(view.state, line.from, line.to),
								annotations: [pluginEditAnnotation.of(true)],
							});
						});
				});

				menu.showAtMouseEvent(<MouseEvent> event);
				return false;
			},
		},
	}),
];

export const diffGutterCompartment = new Compartment();

export { diffGutterHideEmptyAnnotation, diffGutterMarkers };
