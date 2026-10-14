import { useEffect, useImperativeHandle } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { FontSize, TextStyle } from "@tiptap/extension-text-style";
import { ListItem } from "@tiptap/extension-list";
import { FONT_SIZES, fontSizePoints } from "../../shared/document.js";

export const editorExtensions = () => [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    blockquote: false,
    orderedList: false,
    listItem: false,
    listKeymap: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    italic: false,
    strike: false,
    underline: false,
    link: false,
    trailingNode: false,
  }),
  TextStyle,
  FontSize,
  ListItem.extend({ content: "paragraph+" }),
];

export default function DocumentEditor({ initialDocument, editing, disabled, ref }) {
  const editor = useEditor({
    extensions: editorExtensions(),
    content: initialDocument,
    editable: editing && !disabled,
    editorProps: {
      attributes: {
        "aria-label": "Report document",
        "role": "textbox",
        "aria-multiline": "true",
        "spellcheck": "true",
      },
    },
  });
  useImperativeHandle(ref, () => ({ getDocument: () => editor?.getJSON() }), [editor]);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive("bold") || false,
      size: current
        ? fontSizePoints(
            current.getAttributes("textStyle").fontSize,
            current.isActive("heading", { level: 1 })
              ? 24
              : current.isActive("heading", { level: 2 })
                ? 16
                : current.isActive("heading", { level: 3 })
                  ? 13
                  : 12,
          )
        : 12,
      undo: current?.can().undo() || false,
      redo: current?.can().redo() || false,
    }),
  });
  useEffect(() => {
    editor?.setEditable(editing && !disabled, false);
  }, [editor, editing, disabled]);
  return (
    <div className="document-editor">
      {editing && (
        <div className="format-toolbar" role="toolbar" aria-label="Text formatting">
          <button
            type="button"
            aria-label="Bold"
            aria-pressed={state?.bold || false}
            disabled={disabled || !editor}
            onMouseDown={event => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <strong>B</strong>
          </button>
          <label className="font-size-control">
            Text size
            <select
              aria-label="Text size"
              value={FONT_SIZES.includes(state?.size) ? state.size : "custom"}
              disabled={disabled || !editor}
              onChange={event =>
                editor
                  .chain()
                  .focus()
                  .setFontSize(event.target.value + "pt")
                  .run()}
            >
              {!FONT_SIZES.includes(state?.size) && (
                <option value="custom" disabled>
                  {Math.round(state?.size || 12)}
                  {" "}
                  pt
                </option>
              )}
              {FONT_SIZES.map(size => (
                <option value={size} key={size}>
                  {size}
                  {" "}
                  pt
                </option>
              ))}
            </select>
          </label>
          <span className="toolbar-divider" />
          <button
            type="button"
            disabled={disabled || !state?.undo}
            onMouseDown={event => event.preventDefault()}
            onClick={() => editor.chain().focus().undo().run()}
          >
            Undo
          </button>
          <button
            type="button"
            disabled={disabled || !state?.redo}
            onMouseDown={event => event.preventDefault()}
            onClick={() => editor.chain().focus().redo().run()}
          >
            Redo
          </button>
        </div>
      )}
      <div className="document-paper">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
