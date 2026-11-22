# `@musepi/ui-conversation`

The conversation capability's seat contract. `src/contract/slots.ts` names the composer, input, hero and session-info seats; the desktop host registers components for them and Cordis contributions arrive by slot id.

Components for this capability move here incrementally; until then the host keeps the implementations and imports only the contract.
