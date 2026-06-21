# FoliaCore — @Transactional on Native Delete Queries

Lesson: native repository queries need explicit @Transactional — Spring Data JPA doesn't add it automatically.

`UserIpHistoryRepository.pruneOldRecordsByUser()` runs a native SQL `DELETE` with a CTE to prune old IP history records. It was missing `@Transactional` despite already having `@Modifying`.

## What went wrong

Without `@Transactional`, the native query executes outside a Spring-managed persistence context. Consequences include:

- LazyInitializationException on associated entity reads
- Stale entity state during cascade operations
- Auto-flush ambiguities when the caller's transaction commits
- Inconsistent flush order between native and derived queries

## Fix

Added `@Transactional` to the method. The `@Modifying` annotation was already present.

## Pattern to remember

| Query type | Auto-transactional? | Needs @Transactional? |
|---|---|---|
| Derived (Spring Data method name) | Yes | No |
| `@Query` with JPQL + `@Modifying` | **No** | Yes |
| Native SQL `@Query` + `@Modifying` | **No** | Yes |
| `@Transactional` on class | Inherits to all methods | Depends |

Any repository method that performs a write via native SQL must be annotated `@Transactional` (or inherit it from a class-level annotation).

## Related

- [[foliacore-user-save-vs-markdirty]] — same branch, same data-access ordering theme

---
tags: ai/memory/lesson/foliacore | ai/memory/lesson/jpa | source: opencode | modified: 2026-06-05
