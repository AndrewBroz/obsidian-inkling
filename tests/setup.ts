import { App } from "obsidian";

// @ts-ignore Mock createDiv for obsidian functions
global.createDiv = (tag?: string, cls?: string) => document.createElement(tag || 'div');

// Create mock editor classes with proper prototype chain
class MockEditorBase {
	app: any;
	container: HTMLElement;
	options: any;
	editable: boolean;
	editMode: MockEditorMode;

	constructor(app: any, container?: HTMLElement, options?: any) {
		this.app = app;
		this.container = container || document.createElement('div');
		this.options = options;
		this.editable = false;
		this.editMode = new MockEditorMode();
	}

	showEditor() {}
	unload() {}
	set() {}
	register() {}
}

class MockEditorMode {}
Object.defineProperty(MockEditorMode.prototype, 'constructor', {
	value: MockEditorBase,
	writable: true,
	configurable: true
});

// Create a mock class that serves as the base for EmbeddableMarkdownEditor
class MockMarkdownScrollableEditView {
	app: any;
	constructor(app: any, container: HTMLElement, options: any) {
		this.app = app;
	}
}

// Explicitly ensure the constructor property is set
Object.defineProperty(MockMarkdownScrollableEditView.prototype, 'constructor', {
	value: MockMarkdownScrollableEditView,
	writable: true,
	configurable: true
});

// @ts-ignore (Doesn't like me assigning partial app to App)
global.app = <Partial<App>> {
	workspace: {
		activeEditor: null,
	},
	embedRegistry: {
		embedByExtension: {
			md: (options: any, file: any, text: any) => new MockEditorBase(global.app, options?.containerEl)
		}
	},
	scope: {
		register: () => {},
	},
	vault: {
		getConfig: () => undefined,
	},
};

// Patch Object.getPrototypeOf to handle the mock properly for the embeddable-editor class definition
const OriginalGetPrototypeOf = Object.getPrototypeOf;

// @ts-ignore
Object.getPrototypeOf = function(obj: any) {
	if (obj instanceof MockEditorMode) {
		// First getPrototypeOf call
		return MockEditorBase.prototype;
	}
	if (obj === MockEditorBase.prototype) {
		// Second getPrototypeOf call - return the prototype of MockMarkdownScrollableEditView
		return MockMarkdownScrollableEditView.prototype;
	}
	return OriginalGetPrototypeOf.call(this, obj);
};
