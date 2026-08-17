# security_scan

`security_scan` plans and runs OMP-native software-security reviews. It is disabled by default through `security.enabled`.

Actions:

- `preflight` — resolve the Git target, exact OAuth credential, output root, knowledge bases, and immutable plan fingerprint.
- `start` — execute a stored plan in a background OMP job.
- `status` — inspect one operation.
- `cancel` — abort one operation.

Completed and partial results are stored outside the repository in OMP's project-keyed security state. Read them through `security://scans`. The URI namespace is read-only; dispositions, imports, exports, validation, and remediation use explicit commands or tools.
