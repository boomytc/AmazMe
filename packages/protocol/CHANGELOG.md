# Changelog

## [Unreleased]

## [1.2.0] - 2026-10-18

### Breaking Changes

- Public protocol 10 requires Chord link protocol 2, rejecting stale consumers at the authenticated byte handshake before opening incompatible native channels.
- Public protocol 11 uses Chord protocol 4, rejecting stale consumers before opening native channels. Remote domain services declare the services: host family in their contract input; ServiceScope selects it with { host }, and createServiceHost creates its owner.

### Changed

- Application service owners use Chord host lifetimes, remote variants and reference types. Channel bridges preserve compressed payloads across JSON/CBOR instead of serializing opaque packed objects as ordinary values.
- ServiceScope holds UI references synchronously and waits for Chord's own hydration barrier, without a second snapshot-readiness subscription.

## [1.1.1] - 2026-10-18

### Breaking Changes

- Public protocol 9 routes native Chord frames through authenticated attachment channels. Domain contracts and Host resources replace the old service invocation and state wire format.

统一版本号前 @amazme/protocol 自己的编号

## [1.1.0] - 2026-10-07

## [1.0.4] - 2026-10-05

## [1.0.3] - 2026-10-05

## [1.0.2] - 2026-10-04

## [1.0.1] - 2026-10-03

## [1.0.0] - 2026-10-01

## [0.99.2] - 2026-09-30

## [0.99.1] - 2026-09-29

## [0.99.0] - 2026-09-29

## [0.87.1] - 2026-09-22

## [0.87.0] - 2026-09-21

## [0.86.1] - 2026-09-20

## [0.86.0] - 2026-09-19

## [0.85.1] - 2026-09-05

## [0.85.0] - 2026-09-04

## [0.84.4] - 2026-08-28

## [0.84.3] - 2026-08-24

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Restricted assistant and tool transcript lifecycle schemas to valid state combinations and terminal items.
- Replaced `SessionSummarySchema` and `SessionSummary` with durable `SessionMetadataSchema` and `SessionMetadata` for session lists; runtime state remains in acquired `SessionSnapshot` values ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added transport-neutral CBOR protocol schemas, codecs, and length-prefixed framing for remote pi sessions.
- Added `not_implemented` and `internal_error` protocol error codes for sanitized server failures ([#7644](https://github.com/earendil-works/pi/pull/7644)).
