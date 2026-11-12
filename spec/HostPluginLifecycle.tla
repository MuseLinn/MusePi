---- MODULE HostPluginLifecycle ----
CONSTANTS HMR, Memory, SerializeLifecycle, SelectiveConfig, RejectServiceConflict, AtomicReplace
VARIABLES mounted, services, spuriousRestart, duplicateMount, serviceConflict, rollbackLost

Init ==
  mounted = {} /\ services = {} /\ spuriousRestart = FALSE /\
  duplicateMount = FALSE /\ serviceConflict = FALSE /\ rollbackLost = FALSE

EnsureSerialized(plugin) ==
  SerializeLifecycle /\
  mounted' = mounted \cup {plugin} /\
  UNCHANGED <<services, spuriousRestart, duplicateMount, serviceConflict, rollbackLost>>

EnsureUnserializedNew(plugin) ==
  SerializeLifecycle = FALSE /\
  plugin \notin mounted /\
  mounted' = mounted \cup {plugin} /\
  duplicateMount' = duplicateMount /\
  UNCHANGED <<services, spuriousRestart, serviceConflict, rollbackLost>>

EnsureDuplicate(plugin) ==
  SerializeLifecycle = FALSE /\
  plugin \in mounted /\
  mounted' = mounted /\
  duplicateMount' = TRUE /\
  UNCHANGED <<services, spuriousRestart, serviceConflict, rollbackLost>>

Reset ==
  SerializeLifecycle = FALSE /\
  mounted' = {} /\
  UNCHANGED <<services, spuriousRestart, duplicateMount, serviceConflict, rollbackLost>>

ConfigSelective ==
  SelectiveConfig /\
  spuriousRestart' = FALSE /\
  UNCHANGED <<mounted, services, duplicateMount, serviceConflict, rollbackLost>>

ConfigUnrelated(plugin) ==
  SelectiveConfig = FALSE /\
  spuriousRestart' = (plugin /= HMR) /\
  UNCHANGED <<mounted, services, duplicateMount, serviceConflict, rollbackLost>>

PublishConflict(service) ==
  RejectServiceConflict = FALSE /\
  service \in services /\
  serviceConflict' = TRUE /\
  services' = services \cup {service} /\
  UNCHANGED <<mounted, spuriousRestart, duplicateMount, rollbackLost>>

PublishNew(service) ==
  service \notin services /\
  services' = services \cup {service} /\
  serviceConflict' = serviceConflict /\
  UNCHANGED <<mounted, spuriousRestart, duplicateMount, rollbackLost>>

ReplaceFailure ==
  AtomicReplace = FALSE /\
  mounted' = {} /\
  rollbackLost' = TRUE /\
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
    \/ ReplaceFailure

Spec == Init /\ [][Next]_<<mounted, services, spuriousRestart, duplicateMount, serviceConflict, rollbackLost>>

NoDuplicateMount == duplicateMount = FALSE
NoServiceConflict == serviceConflict = FALSE
NoSpuriousRestart == spuriousRestart = FALSE
NoRollbackLoss == rollbackLost = FALSE
====
