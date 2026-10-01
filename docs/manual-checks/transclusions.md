# Manual check: transclusions show original text

Create `Reviewed.md`:

    # Reviewed

    The {~~cat~>dog~~} sat on the {++red ++}mat. ^r1

    {==Important==}{>>Is this right?<<}{>>Yes.<<} findings were {--not --}confirmed.

and `Host.md`:

    ![[Reviewed]]

    ![[Reviewed#^r1]]

    ![[Reviewed#Reviewed]]

Check:

- **Reading view and Live Preview of `Host.md`:** every transclusion shows "The cat sat on the mat." and "Important findings were not confirmed." There are no braces, comment icons or highlight colours.
- **`Reviewed.md` itself:** it still shows suggestions and comments exactly as before (the editor and Reading view are unchanged).
- **Live updates:** edit `Reviewed.md` (accept the substitution). `Host.md` updates and shows "The dog sat on the mat."
- **Plain notes:** transclude a note without CriticMarkup. It renders exactly as before, including its internal links.
- **Nested transclusions:** a transclusion inside a transcluded note also shows original text.
- **Source unchanged:** `git diff` (or File recovery) shows `Reviewed.md` was never modified by viewing `Host.md`.
