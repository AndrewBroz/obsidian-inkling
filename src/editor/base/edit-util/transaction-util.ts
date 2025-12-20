import { Transaction } from "@codemirror/state";

export function getUserEvents(tr: Transaction) {
	// @ts-expect-error (Transaction has annotations)
	return tr.annotations.map(x => x.value).filter(x => typeof x === "string");
}

export function isUserEvent(event: string, events: string[]): boolean {
    return events.some(e => e.startsWith(event));
}

export function deriveUserEvent(tr: Transaction): string | undefined {
    if (tr.isUserEvent("input")) return "input";
    if (tr.isUserEvent("paste")) return "paste";
    if (tr.isUserEvent("delete")) return "delete";

    const events = getUserEvents(tr);
    const selectEvent = events.find((e: string) => e.startsWith("select"));

    return selectEvent;
}
