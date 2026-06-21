# FoliaCore — save() vs markDirty() for New User Creation

Decision: switch new-user creation in UserService from markDirty() to save() to guarantee FK ordering.

On the `feature/docker-testing` branch, `UserService.ensureUserExists()` was changed from calling `markDirty(uuid, entity)` to calling `userEntityAccessor.save(entity)`.

## Why

The `users` row must exist in the database synchronously before any FK-dependent writes (e.g., `user_ip_history` inserts with a FK to `users(id)`). The old `markDirty()` path only registered the entity for dirty tracking — the actual INSERT was deferred, which could cause FK constraint violations if a dependent write happened first.

## Trade-offs

- **Pro `save()`**: Immediate DB round-trip guarantees the row exists; eliminates FK ordering bugs.
- **Con `save()`**: Extra persistence context flush per new user; slightly slower user creation path.
- **Pro `markDirty()` (old)**: Batched writes, fewer DB round-trips.
- **Con `markDirty()` (old)**: Deferred flush — FK-dependent writes can fail silently at flush time.

## Files changed

- `src/main/java/net/luneshine/folia/core/persistence/service/UserService.java` — `save()` instead of `markDirty()`
- `src/test/java/.../UserServiceTest.java` — mocks updated to reflect `save()` behavior; new edge-case tests added

## Related

- [[foliacore-transactional-native-query]] — related JPA transaction ordering lesson on same branch

---
tags: ai/memory/decision/foliacore | source: opencode | modified: 2026-06-05
