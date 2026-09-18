/** Terminal encodings that represent Shift+Enter in common CSI/kitty modes. */
export function isShiftEnterSequence(input: string): boolean {
  return /\u001b\[(?:27;2;13~|13;2u)/.test(input);
}

export function insertAtCursor(value: string, cursor: number, insertion: string): { value: string; cursor: number } {
  const boundedCursor = Math.max(0, Math.min(cursor, value.length));
  return {
    value: value.slice(0, boundedCursor) + insertion + value.slice(boundedCursor),
    cursor: boundedCursor + insertion.length,
  };
}
