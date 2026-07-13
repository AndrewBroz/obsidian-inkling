import { DEFAULT_SETTINGS } from "../src/constants";
import { getEditMode } from "../src/editor/uix/extensions/editing-modes";
import { EditMode } from "../src/types";

// EXPL: editMode/suggestionMode/commentMode all return `EditorState.transactionFilter.of(fn)`, i.e.
// the same shared FacetProvider/Facet shape (same facet id) — real CodeMirror Extension objects from
// different modes are otherwise structurally indistinguishable. The wrapped `fn`'s source text
// (via Function.prototype.toString, which returns the original source) is the one place the three
// modes actually differ, so it's used below as the "shape" identity check.
function extensionSource(extensions: unknown[]): string {
	return (extensions[0] as { value: () => void }).value.toString();
}

// EXPL: getEditMode used to fall through to `return [];` for any unrecognized EditMode value,
// i.e. ZERO installed extensions — an editor with no protection at all against corrupting
// CriticMarkup syntax, the exact hazard the EditMode.OFF removal exists to eliminate. It must
// instead fail CLOSED into the protected CORRECTED extension set.
describe("getEditMode fails closed on unrecognized values", () => {
	test("SUGGEST and COMMENT differ in shape from CORRECTED (sanity check for the discriminator)", () => {
		const corrected = extensionSource(getEditMode(EditMode.CORRECTED, DEFAULT_SETTINGS));
		const suggest = extensionSource(getEditMode(EditMode.SUGGEST, DEFAULT_SETTINGS));
		const comment = extensionSource(getEditMode(EditMode.COMMENT, DEFAULT_SETTINGS));

		expect(suggest).not.toBe(corrected);
		expect(comment).not.toBe(corrected);
		expect(comment).not.toBe(suggest);
	});

	test.each([0, 4, -1])("out-of-range value %i yields a non-empty, CORRECTED-shaped extension set", (value) => {
		const corrected = getEditMode(EditMode.CORRECTED, DEFAULT_SETTINGS);
		const result = getEditMode(value as EditMode, DEFAULT_SETTINGS);

		expect(result).not.toEqual([]);
		expect(result).toHaveLength(corrected.length);
		expect(extensionSource(result)).toBe(extensionSource(corrected));
	});
});
