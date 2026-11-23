# `@musepi/client-ui-plugin-market`

Plugin-market surfaces: `MarketplaceGrid` (installed / catalog / custom-source segments, search and scroll shadow), `MarketplaceCard`, `MarketplaceVersionChoice` and the entry types.

Presentational only. The host supplies the catalog through `client` and routes `MarketplaceCardAction`; the guest-side `MarketplacePanel` adapter that binds them to `SessionClient` stays in `client-core`.