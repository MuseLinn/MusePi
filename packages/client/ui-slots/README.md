# `@musepi/ui-slots`

Typed UI slot declarations shared by the desktop shell and Cordis contributions. A capability package names its seats in `src/client/contract/slots.ts`; the host registers a component for a seat and extensions contribute by slot id.

`defineSlot(name)` validates the name against `@musepi/collab-proto/extension-slots`, the single declaration authority.
