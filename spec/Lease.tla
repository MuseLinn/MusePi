---- MODULE Lease ----
CONSTANTS OwnerA, OwnerB, NoOwner, SerializeTransitions
VARIABLES ownerFile, active, staleWrites, lost

Init ==
  ownerFile = NoOwner /\ active = {} /\ staleWrites = {} /\ lost = FALSE

Acquire(who) ==
  ownerFile = NoOwner /\
  active' = {who} /\
  ownerFile' = who /\
  UNCHANGED <<staleWrites, lost>>

Takeover(who) ==
  ownerFile /= NoOwner /\
  who \notin active /\
  ownerFile' = who /\
  active' = active \cup {who} /\
  UNCHANGED <<staleWrites, lost>>

Heartbeat(who) ==
  who \in active /\
  ownerFile = who /\
  ownerFile' = ownerFile /\
  UNCHANGED <<active, staleWrites, lost>>

StaleHeartbeat(who) ==
  SerializeTransitions = FALSE /\
  who \in active /\
  ownerFile /= who /\
  staleWrites' = staleWrites \cup {who} /\
  ownerFile' = who /\
  UNCHANGED <<active, lost>>

Lose(who) ==
  who \in active /\
  ownerFile /= who /\
  active' = active \ {who} /\
  lost' = TRUE /\
  UNCHANGED <<ownerFile, staleWrites>>

Next ==
  \E who \in {OwnerA, OwnerB}:
    \/ Acquire(who)
    \/ Takeover(who)
    \/ Heartbeat(who)
    \/ StaleHeartbeat(who)
    \/ Lose(who)

Spec == Init /\ [][Next]_<<ownerFile, active, staleWrites, lost>>

NoStaleHeartbeat == staleWrites = {}
NoLostOwnership == lost = FALSE \/ ownerFile \in active
====
