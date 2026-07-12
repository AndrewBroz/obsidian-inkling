import { Compartment } from "@codemirror/state";
import type CommentatorPlugin from "../../../../main";
import {
	annotation_gutter,
	annotationGutterFocusAnnotation,
	annotationGutterFocusThreadAnnotation,
	annotationGutterFoldAnnotation,
	annotationGutterFoldButtonAnnotation,
	annotationGutterHideEmptyAnnotation,
	annotationGutterResizeHandleAnnotation,
	AnnotationGutterView,
	annotationGutterView,
	annotationGutterWidthAnnotation,
} from "./annotation-gutter";
import { annotationGutterMarkers, AnnotationMarker } from "./marker";

export {
	annotationGutterFocusAnnotation,
	annotationGutterFocusThreadAnnotation,
	annotationGutterFoldAnnotation,
	annotationGutterFoldButtonAnnotation,
	annotationGutterHideEmptyAnnotation,
	annotationGutterMarkers,
	annotationGutterResizeHandleAnnotation,
	AnnotationGutterView,
	annotationGutterView,
	annotationGutterWidthAnnotation,
	AnnotationMarker,
};

// NOTE: Keep the gutter here, as Obsidian *really* does not like the circular reference
// 		 between Markers and Gutters (which is required for calling the moveGutter function)
export const annotationGutter = (plugin: CommentatorPlugin) => {
	const { extension, config } = annotation_gutter({
		class: "cmtr-anno-gutter " + (plugin.app.vault.getConfig("cssTheme") === "Minimal" ? " is-minimal" : ""),
		markers: v => v.state.field(annotationGutterMarkers),
		foldState: plugin.settings.annotation_gutter_default_fold_state,
		width: plugin.settings.annotation_gutter_width,
		hideOnEmpty: plugin.settings.annotation_gutter_hide_empty,
		includeFoldButton: plugin.settings.annotation_gutter_fold_button,
		includeResizeHandle: plugin.settings.annotation_gutter_resize_handle,
	});
	return { extension: [annotationGutterMarkers, extension], config };
};

export const annotationGutterCompartment = new Compartment();
