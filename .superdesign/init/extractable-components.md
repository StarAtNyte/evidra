# Extractable Evidra components

## WorkbenchHeader
- Source: `src/ui/app.tsx`
- Category: layout
- Description: ASCII logo and compact provider/mode/thinking/permission state.
- Extractable props: mode, provider, model, reasoningEffort, autonomy

## Transcript
- Source: `src/ui/app.tsx`
- Category: layout
- Description: Color-coded user, assistant, and system research conversation.
- Extractable props: messages, maxVisibleMessages

## CommandPalette
- Source: `src/ui/app.tsx`
- Category: basic
- Description: Filtered slash command list with keyboard selection and Tab completion.
- Extractable props: input, suggestions, suggestionIndex

## SelectorPanel
- Source: `src/ui/app.tsx`
- Category: basic
- Description: Modal model, thinking, mode, and permissions picker.
- Extractable props: picker, choices, pickerIndex

## ExecutionStatus
- Source: `src/ui/app.tsx`
- Category: basic
- Description: Spinner and latest command/agent progress message.
- Extractable props: busy, progress
