# Claims

Claim acquisition is serialized; implementation may be parallel.

A claim must be merged/recorded before product-code work starts. The repository validator rejects conflicting active claims based on path, contract, resource and migration ownership.

Reassignment increments `claimEpoch`; stale epochs cannot merge.

No active implementation claim exists at the P000 bootstrap checkpoint.
