# Day 01 — QA and security review

**Contract:** `contracts/TodoList.sol` · **Security focus:** only the owner can edit a list

## How it was checked

1. Unit tests for every function and every error (`npx hardhat test`)
2. A fuzz test with **fast-check**: 50 random sequences of add / complete / delete by two users, checked against a simple JavaScript model after every run
3. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`
4. Manual review like an attacker: access control, input validation, denial of service, ID handling, privacy

## Findings

All findings came from the manual review of the first design, before the first commit. Each one is now guarded by a test.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | Medium | Manual review | Using the array position as the task ID breaks after a delete: swap-and-pop moves the last task into the gap, so "complete task 2" could hit a different task than the user meant. | Every task gets a **stable ID** that never changes or gets reused; an `id → index` map is kept in sync on delete. | `deletes a task and keeps other ids stable`, `never reuses a deleted id`, fuzz test |
| F-02 | Medium | Manual review | An `owner` parameter on edit functions would let anyone edit anyone's list if the check were ever missed. | Edit functions take **no owner parameter**: every write uses `msg.sender` as the list key, so a caller can only ever reach their own list. | `Bob cannot complete or delete Alice's task`, `Bob's actions with the same id only touch Bob's own list` |
| F-03 | Low | Manual review | Unlimited text length and task count let one user bloat storage and make `getTasks` too expensive to read. | `MAX_TEXT_LENGTH = 280` bytes and `MAX_TASKS = 100` open tasks per user; empty text rejected. | `rejects empty text`, `accepts 280 bytes but rejects 281`, `stops at 100 tasks per user` |
| F-04 | Low | Manual review | A mapping returns 0 for missing keys, so ID 0 could look like a real task. | IDs start at 1; index map stores `index + 1`, so 0 always means "not found". | `reverts for an unknown id (including id 0)` |
| F-05 | Low | Manual review | Completing a task twice would emit duplicate `TaskCompleted` events and confuse apps that read them. | Revert with `AlreadyCompleted`. | `refuses to complete the same task twice` |
| F-06 | Info | Manual review | "Private list" means only you can **edit** it. Anyone can **read** blockchain data, even `private` variables. | Documented in the contract NatSpec and README. Known issue by design: never put secrets in a task. | — |

No high or medium issues remain open.

## Final green run

```
  TodoList
    adding tasks
      ✔ adds a task with id 1 and emits TaskAdded
      ✔ gives every user their own list and their own ids
      ✔ rejects empty text
      ✔ accepts 280 bytes but rejects 281
      ✔ stops at 100 tasks per user
    completing tasks
      ✔ marks a task done and emits TaskCompleted
      ✔ refuses to complete the same task twice
      ✔ reverts for an unknown id (including id 0)
    deleting tasks
      ✔ deletes a task and keeps other ids stable
      ✔ never reuses a deleted id
      ✔ cannot delete the same task twice
      ✔ deleting the last task works
    security: only the owner can edit a list
      ✔ Bob cannot complete or delete Alice's task
      ✔ Bob's actions with the same id only touch Bob's own list
    fuzz: random add / complete / delete sequences match a simple model
      ✔ contract state always equals the JavaScript model (50 random runs)

  15 passing (3s)
```

| Tool | Result |
|------|--------|
| `npm audit --omit=dev` | found 0 vulnerabilities |
| `solhint` (recommended) | 0 warnings, 0 errors |
| `slither` (102 detectors) | 0 results |
