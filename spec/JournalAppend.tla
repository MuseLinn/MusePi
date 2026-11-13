---- MODULE JournalAppend ----
EXTENDS Integers, Sequences
CONSTANTS ValidateContinuity, SeedFromHighWater
VARIABLES nextSeq, records, checkpoint, nextAppend, silentCatchup, renumbered

Init ==
  nextSeq = 1 /\ records = << >> /\ checkpoint = 0 /\ nextAppend = 1 /\
  silentCatchup = FALSE /\ renumbered = FALSE

AppendRecord ==
  nextSeq <= 4 /\
  records' = records \o <<nextSeq>> /\
  nextSeq' = nextSeq + 1 /\
  nextAppend' = nextSeq + 1 /\
  UNCHANGED <<checkpoint, silentCatchup, renumbered>>

DropMiddle ==
  nextSeq <= 4 /\
  records' = records /\
  nextSeq' = nextSeq + 1 /\
  nextAppend' = nextSeq + 1 /\
  UNCHANGED <<checkpoint, silentCatchup, renumbered>>

Catchup ==
  nextSeq > 4 /\
  ValidateContinuity = FALSE /\
  silentCatchup' = TRUE /\
  records' = records /\
  nextSeq' = nextSeq /\
  nextAppend' = nextAppend /\
  UNCHANGED <<checkpoint, renumbered>>

Compact ==
  nextSeq > 1 /\
  checkpoint' = nextSeq - 1 /\
  records' = << >> /\
  nextSeq' = nextSeq /\
  nextAppend' = nextSeq /\
  silentCatchup' = FALSE /\
  renumbered' = FALSE

ReopenHighWater ==
  checkpoint > 0 /\
  SeedFromHighWater /\
  nextAppend' = checkpoint + 1 /\
  renumbered' = renumbered /\
  records' = records /\
  nextSeq' = nextSeq /\
  checkpoint' = checkpoint /\
  silentCatchup' = FALSE

ReopenLowWater ==
  checkpoint > 0 /\
  SeedFromHighWater = FALSE /\
  nextAppend' = 1 /\
  renumbered' = TRUE /\
  records' = records /\
  nextSeq' = nextSeq /\
  checkpoint' = checkpoint /\
  silentCatchup' = FALSE

Next ==
  \/ AppendRecord
  \/ DropMiddle
  \/ Catchup
  \/ Compact
  \/ ReopenHighWater
  \/ ReopenLowWater
Spec == Init /\ [][Next]_<<nextSeq, records, checkpoint, nextAppend, silentCatchup, renumbered>>

NoSilentCatchup == silentCatchup = FALSE
NoRenumber == renumbered = FALSE
HighWaterAppend == nextAppend >= checkpoint + 1
====
