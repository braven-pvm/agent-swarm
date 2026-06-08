# Greeter Fixture Specification

## Functional Requirements

- FR-001: The greeter shall return a friendly greeting for a provided name.
- FR-002: The greeter shall provide an excited greeting mode for CLI users.

## Acceptance Criteria

- AC-001.1: Calling `greet("Marius")` returns `Hello, Marius!`.
- AC-002.1: Calling the new excited greeting behavior for `Marius` returns `Hello, Marius!!!`.
- AC-002.2: The fixture test command passes after the excited greeting behavior is implemented.
