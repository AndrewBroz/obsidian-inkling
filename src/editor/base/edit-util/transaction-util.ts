import { Transaction } from "@codemirror/state";

export function getUserEvents(tr: Transaction): string[] {
	// EXPL: `annotations` is internal to Transaction; the public API only reads one annotation type at a time.
	const { annotations } = tr as unknown as { annotations: readonly { value: unknown }[] };
	return annotations.map(x => x.value).filter((x): x is string => typeof x === "string");
}

export function isUserEvent(event: string, events: string[]): boolean {
	return events.some(e => e.startsWith(event));
}

export function deriveUserEvent(tr: Transaction): string | undefined {
	if (tr.isUserEvent("input")) return "input";
	if (tr.isUserEvent("paste")) return "paste";
	if (tr.isUserEvent("delete")) return "delete";

	const events = getUserEvents(tr);
	const selectEvent = events.find(e => e.startsWith("select"));

	return selectEvent;
}
