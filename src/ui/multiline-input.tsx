import React, { useEffect, useState } from "react";
import { Text, useInput } from "ink";

type Props = {
  value: string;
  placeholder?: string;
  focus?: boolean;
  showCursor?: boolean;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
};

export default function MultilineInput({ value, placeholder = "", focus = true, showCursor = true, onChange, onSubmit }: Props): React.JSX.Element {
  const [cursor, setCursor] = useState(value.length);
  useEffect(() => setCursor((current) => Math.min(current, value.length)), [value]);

  useInput((input, key) => {
    if (!focus || key.upArrow || key.downArrow || key.tab || (key.ctrl && input === "c")) return;
    // Some terminals encode Shift+Enter as a CSI sequence instead of setting
    // Ink's key.shift flag. Consume both common encodings as a line break.
    if (/\u001b\[(?:27;2;13~|13;2u)/.test(input)) {
      const next = value.slice(0, cursor) + "\n" + value.slice(cursor);
      setCursor(cursor + 1); onChange(next);
      return;
    }
    if (key.return) {
      if (key.shift) {
        const next = value.slice(0, cursor) + "\n" + value.slice(cursor);
        setCursor(cursor + 1); onChange(next);
      } else onSubmit?.(value);
      return;
    }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(value.length, cursor + 1)); return; }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      const next = value.slice(0, cursor - 1) + value.slice(cursor);
      setCursor(cursor - 1); onChange(next); return;
    }
    if (!input) return;
    const next = value.slice(0, cursor) + input + value.slice(cursor);
    setCursor(cursor + input.length); onChange(next);
  }, { isActive: focus });

  const visible = value || placeholder;
  const before = value ? value.slice(0, cursor) : "";
  const atCursor = showCursor && focus ? (value[cursor] ?? " ") : "";
  const after = value ? value.slice(cursor + (showCursor && focus ? 1 : 0)) : "";
  return <Text color={value ? "#f6f2e8" : "#858ba8"}>
    {value ? <>{before}<Text inverse={showCursor && focus}>{atCursor}</Text>{after}</> : <>{visible}<Text inverse={showCursor && focus}> </Text></>}
  </Text>;
}
