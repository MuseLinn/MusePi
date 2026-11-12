---- MODULE IntentBeforeEffect ----
EXTENDS Integers
CONSTANTS AwaitDurableIntent
VARIABLES assistantPersisted, startCount, flushed, executed, effectBeforeDurable

Init ==
  assistantPersisted = FALSE /\ startCount = 0 /\ flushed = FALSE /\
  executed = FALSE /\ effectBeforeDurable = FALSE

EmitStart ==
  startCount = 0 /\
  assistantPersisted' = TRUE /\
  startCount' = 1 /\
  flushed' = FALSE /\
  executed' = FALSE /\
  effectBeforeDurable' = FALSE

Flush ==
  AwaitDurableIntent = TRUE /\
  startCount = 1 /\
  flushed = FALSE /\
  flushed' = TRUE /\
  UNCHANGED <<assistantPersisted, startCount, executed, effectBeforeDurable>>

Execute ==
  (AwaitDurableIntent => flushed) /\
  startCount = 1 /\
  executed = FALSE /\
  executed' = TRUE /\
  effectBeforeDurable' = FALSE /\
  UNCHANGED <<assistantPersisted, startCount, flushed>>

ExecuteWithoutFlush ==
  AwaitDurableIntent = FALSE /\
  startCount = 1 /\
  flushed = FALSE /\
  executed = FALSE /\
  executed' = TRUE /\
  effectBeforeDurable' = TRUE /\
  UNCHANGED <<assistantPersisted, startCount, flushed>>

DuplicateStart ==
  AwaitDurableIntent = FALSE /\
  startCount = 1 /\
  startCount' = 2 /\
  UNCHANGED <<assistantPersisted, flushed, executed, effectBeforeDurable>>

Skip == UNCHANGED <<assistantPersisted, startCount, flushed, executed, effectBeforeDurable>>

Next ==
  \/ EmitStart
  \/ Flush
  \/ Execute
  \/ ExecuteWithoutFlush
  \/ DuplicateStart
  \/ Skip

Spec == Init /\ [][Next]_<<assistantPersisted, startCount, flushed, executed, effectBeforeDurable>>

EffectAfterDurable == effectBeforeDurable = FALSE
StartExactlyOnce == startCount <= 1
AssistantBeforeMarker == startCount = 0 \/ assistantPersisted
====
