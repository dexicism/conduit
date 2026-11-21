"use client";

import { javascript } from "@codemirror/lang-javascript";
import CodeMirror from "@uiw/react-codemirror";
import { useTheme } from "next-themes";

const extensions = [javascript()];

/** JavaScript editor for the Code step (CodeMirror 6, bundled locally). */
export function CodeEditor({
  id,
  value,
  onChange,
  invalid,
  label,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  label: string;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <div
      className="overflow-hidden rounded-lg border text-[12px] aria-invalid:border-destructive"
      aria-invalid={invalid || undefined}
      data-testid="code-editor"
    >
      <CodeMirror
        id={id}
        value={value}
        height="260px"
        theme={resolvedTheme === "light" ? "light" : "dark"}
        extensions={extensions}
        onChange={onChange}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, autocompletion: true }}
        aria-label={label}
      />
    </div>
  );
}
