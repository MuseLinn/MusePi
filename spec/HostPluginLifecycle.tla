---- MODULE HostPluginLifecycle ----
CONSTANTS HMR, Memory, SerializeLifecycle, SelectiveConfig, RejectServiceConflict, PreserveOnReplaceFailure
VARIABLES mounted, services, spuriousRestart, duplicateMount, serviceConflict, rollbackLost, restartRequired

Init ==
  mounted = {} /\ services = {} /\ spuriousRestart = FALSE /\
  duplicateMount = FALSE /\ serviceConflict = FALSE /\ rollbackLost = FALSE /\
  restartRequired = FALSE

EnsureSerialized(plugin) ==
  SerializeLifecycle /\
  mounted' = mounted \cup {plugin} /\
  UNCHANGED <<services, spuriousRestart, duplicateMount, serviceConflict, rollbackLost, restartRequired>>

EnsureUnserializedNew(plugin) ==
  SerializeLifecycle = FALSE /\
  plugin \notin mounted /\
  mounted' = mounted \cup {plugin} /\
  duplicateMount' = duplicateMount /\
  UNCHANGED <<services, spuriousRestart, serviceConflict, rollbackLost, restartRequired>>

EnsureDuplicate(plugin) ==
  SerializeLifecycle = FALSE /\
  plugin \in mounted /\
  mounted' = mounted /\
  duplicateMount' = TRUE /\
  UNCHANGED <<services, spuriousRestart, serviceConflict, rollbackLost, restartRequired>>

Reset ==
  SerializeLifecycle = FALSE /\
  mounted' = {} /\
  UNCHANGED <<services, spuriousRestart, duplicateMount, serviceConflict, rollbackLost, restartRequired>>

ConfigSelective ==
  SelectiveConfig /\
  spuriousRestart' = FALSE /\
  UNCHANGED <<mounted, services, duplicateMount, serviceConflict, rollbackLost, restartRequired>>

ConfigUnrelated(plugin) ==
  SelectiveConfig = FALSE /\
  spuriousRestart' = (plugin /= HMR) /\
  UNCHANGED <<mounted, services, duplicateMount, serviceConflict, rollbackLost, restartRequired>>

PublishConflict(service) ==
  RejectServiceConflict = FALSE /\
  service \in services /\
  serviceConflict' = TRUE /\
  services' = services \cup {service} /\
  UNCHANGED <<mounted, spuriousRestart, duplicateMount, rollbackLost, restartRequired>>

PublishNew(service) ==
  service \notin services /\
  services' = services \cup {service} /\
  serviceConflict' = serviceConflict /\
  UNCHANGED <<mounted, spuriousRestart, duplicateMount, rollbackLost, restartRequired>>

ReplaceFailurePreserved ==
  PreserveOnReplaceFailure /\
  mounted' = mounted /\
  rollbackLost' = FALSE /\
  restartRequired' = FALSE /\
  UNCHANGED <<services, spuriousRestart, duplicateMount, serviceConflict>>

ReplaceFailureLost ==
  PreserveOnReplaceFailure = FALSE /\
  mounted' = {} /\
  rollbackLost' = TRUE /\
  restartRequired' = TRUE /\
  UNCHANGED <<services, spuriousRestart, duplicateMount, serviceConflict>>

Next ==
  \E plugin \in {HMR, Memory}:
    \/ EnsureSerialized(plugin)
    \/ EnsureUnserializedNew(plugin)
    \/ EnsureDuplicate(plugin)
    \/ Reset
    \/ ConfigSelective
    \/ ConfigUnrelated(plugin)
    \/ PublishConflict(plugin)
    \/ PublishNew(plugin)
    \/ ReplaceFailurePreserved
    \/ ReplaceFailureLost

Spec == Init /\ [][Next]_<<mounted, services, spuriousRestart, duplicateMount, serviceConflict, rollbackLost, restartRequired>>

NoDuplicateMount == duplicateMount = FALSE
NoServiceConflict == serviceConflict = FALSE
NoSpuriousRestart == spuriousRestart = FALSE
NoRollbackLoss == rollbackLost = FALSE
RollbackFailureReported == rollbackLost => restartRequired
====
