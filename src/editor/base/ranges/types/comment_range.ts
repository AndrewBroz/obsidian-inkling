import { CriticMarkupRange, type MetadataFields, type MetaLocation } from "../base_range";
import { SuggestionType } from "../definitions";

export class CommentRange extends CriticMarkupRange {
	reply_depth = 0;
	attached_comment: CriticMarkupRange | null = null;

	// EXPL: Thread rule 1: `done` lives on the thread's base. A reply's copy (written by older versions) is ignored.
	get fields(): MetadataFields {
		if (!this.attached_comment || !("done" in this.own_fields)) return this.own_fields;
		const rest = { ...this.own_fields };
		delete rest.done;
		return rest;
	}

	get base_range(): CriticMarkupRange {
		return this.attached_comment || this;
	}

	get thread(): CommentRange[] {
		return this.attached_comment ? [...this.attached_comment.thread] : [this, ...this.replies];
	}

	accept(removeComments: boolean = true): string {
		if (removeComments)
			return "";
		else
			return this.unwrap();
	}

	reject(removeComments: boolean = true): string {
		if (removeComments)
			return "";
		else
			return this.unwrap();
	}

	clear_references() {
		this.attached_comment = null;
		this.reply_depth = 0;
	}

	add_reply(range: CriticMarkupRange) {
		this.attach_to_range(range.type === SuggestionType.COMMENT ? (range as CommentRange).base_range : range);
	}

	attach_to_range(range: CriticMarkupRange) {
		range.replies.push(this);
		this.reply_depth = range.replies.length - (range.type === SuggestionType.COMMENT ? 0 : 1);
		this.attached_comment = range;
	}

	constructor(from: number, to: number, text: string, meta?: MetaLocation) {
		super(from, to, SuggestionType.COMMENT, "Comment", text, meta);
	}
}
