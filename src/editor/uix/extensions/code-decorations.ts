import type { Range, Text } from "@codemirror/state";
import { Decoration } from "@codemirror/view";

// EXPL: How a comment on code shows what it is about: its quoted code highlighted, or the whole block outlined. Both
//       are decorations only; the code itself never changes. Shared by the draft (comment-draft.ts) and by focusing a
//       written comment (focus-renderer.ts).

const quoteDecoration = Decoration.mark({ class: "cmtr-code-quote-focus" });

/** The decoration that highlights quoted code at `from`-`to`. */
export function code_quote_decoration(from: number, to: number): Range<Decoration> {
	return quoteDecoration.range(from, to);
}

/** Line decorations that outline the block whose fence lines start at `from` and end at `to`. */
export function code_block_outline(doc: Text, from: number, to: number): Range<Decoration>[] {
	const first = doc.lineAt(from).number, last = doc.lineAt(to).number;
	const out: Range<Decoration>[] = [];
	for (let n = first; n <= last; n++) {
		const cls = ["cmtr-code-block-focus"];
		if (n === first) cls.push("cmtr-code-block-focus-first");
		if (n === last) cls.push("cmtr-code-block-focus-last");
		out.push(Decoration.line({ class: cls.join(" ") }).range(doc.line(n).from));
	}
	return out;
}
