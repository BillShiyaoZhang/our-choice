# Project Rules

This document outlines workspace-specific rules for coding agents. All agents MUST follow these instructions when working on this project.

## 1. Documentation-Driven Development (DDD) & UML Synchronization

- **Docs-First development**: For any new features, API updates, or database model changes, you MUST first update or write the corresponding documentation/UML designs in the `docs/` folder before making any codebase changes. Development must align to the documented specification.
- **Python Project Guidelines**: Always use `uv` for python virtual environment operations when running command line commands.

## 2. Test-Driven Development (TDD) Requirements

All feature work, behavior changes, API changes, schema changes, and bug fixes MUST follow the Red–Green–Refactor cycle. Tests are part of the specification, not a final verification step.

- **Document first**: Update the relevant design/API/UML documentation before changing implementation code. Record observable behavior, edge cases, compatibility requirements, and acceptance criteria.
- **Write the failing test first (Red)**: Add a focused, deterministic test for the smallest behavior slice. Run it and confirm that it fails because the requested behavior is missing or incorrect. Do not skip the red step by writing a test that passes against the old behavior.
- **Implement the minimum (Green)**: Make the smallest production change that satisfies the new test. Keep external services, clocks, randomness, and network calls mocked or injected so tests remain local and repeatable.
- **Refactor under protection**: After the focused test passes, improve structure, naming, and reuse without changing behavior. Re-run the focused tests after each refactor.
- **No weakened tests**: Do not delete, broaden, skip, or loosen an assertion solely to make a change pass. If the product contract changes, update the documentation and test expectation together and explain the compatibility impact in the change.
- **Determinism and isolation**: Tests must not depend on execution order, production workspace data, local model availability, wall-clock timing, or a developer's environment. Use fixtures, temporary directories, stable IDs, and explicit async synchronization.
- **Completion rule**: A task is incomplete until its new tests pass, existing tests remain green, and the documented acceptance criteria are satisfied.
