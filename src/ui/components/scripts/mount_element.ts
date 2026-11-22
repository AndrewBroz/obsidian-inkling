/**
 * Svelte action: shows `element` as the node's only child. Used instead of `{@html element.outerHTML}`, so
 * elements built with Obsidian's DOM helpers are inserted as they are rather than re-parsed from HTML.
 */
export function mountElement(node: HTMLElement, element: Element | null | undefined) {
	const show = (el: Element | null | undefined) => node.replaceChildren(...(el ? [el] : []));
	show(element);
	return { update: show };
}
