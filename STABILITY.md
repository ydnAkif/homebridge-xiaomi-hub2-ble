# Stability notes

## 2026-11-07: battery freshness verified against real history

Read-only cloud history for all eight installed sensors showed repeated identical battery values with new timestamps about every 12 hours. The most recent readings were 6–11 hours old, all 100%. Therefore the existing 48-hour stale-report guard is retained. Polling remains 60 seconds; battery polling remains hourly. A stale or absent measurement is still never replaced by 0% or 100%.

The installed EU hub reports lumi.gateway.mgl001, firmware 1.0.8_0013. Local access is an architectural option, not part of this update: XiaomiGateway3 supports the EU Multimode Gateway 2 and 1.0.8 firmware, but enables gateway access and starts an additional daemon. It requires a separate integration/bridge implementation and a migration test. No hub access or firmware setting was changed.
https://github.com/AlexxIT/XiaomiGateway3#supported-firmwares
