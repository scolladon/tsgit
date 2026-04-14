# ADR-001: Hexagonal Architecture with Tiered Application Layer

## Status

Accepted (at `a5c00ad`)

## Context

tsgit must run on Node.js, browsers, and edge runtimes with zero native dependencies. The domain logic (git object parsing, delta resolution, merge) must be completely decoupled from platform-specific I/O (filesystem, HTTP, crypto). Additionally, we need both an ergonomic high-level API and composable low-level primitives.

## Decision

Adopt hexagonal architecture (ports & adapters) with the application layer split into two tiers:

- **Domain**: Pure git logic, zero outward imports
- **Application/Commands** (Tier 1): High-level use cases (clone, log, status)
- **Application/Primitives** (Tier 2): Low-level composable operations (readObject, walkCommits)
- **Ports**: Interfaces only (FileSystem, HttpTransport, HashService, Compressor)
- **Adapters**: Platform implementations (Node, Browser, Memory)

Commands are built from primitives. The repository facade wraps commands. dependency-cruiser enforces the dependency rules in CI.

## Consequences

### Positive

- Domain is testable with memory adapter alone — no filesystem, no network
- Platform swap is a single adapter change
- Two-tier API serves both casual and power users
- Architecture rules are machine-enforced, not just documented

### Negative

- More files and indirection than a flat structure
- Port interfaces add a layer of abstraction developers must understand
- New contributors need to learn the hexagonal pattern

### Neutral

- Build output maps entry points to the two tiers via package.json exports
