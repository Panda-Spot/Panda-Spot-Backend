/// Payment gateway layer (Phase 12, structure-ready): a tiny provider
/// registry behind one interface. No provider is bundled or hardcoded —
/// every call resolves to "not configured" until a gateway module that
/// calls registerGateway() is added with real credentials. Booking flows
/// record advances against billing-module Bills today; gateways will
/// create/collect linked Payments later without route changes.

const providers = new Map();

export function registerGateway(name, impl) {
  providers.set(name, impl);
}

export function configuredGateways() {
  return [...providers.keys()];
}

/// Intent to collect `amountMinor` (paise/cents) for a booking. Throws
/// { status:501 } when no provider of that name is registered.
export async function createPaymentIntent({ provider, bookingId, amountMinor, currency = "INR", meta = {} }) {
  const impl = providers.get(provider);
  if (!impl?.createIntent) {
    throw Object.assign(new Error(`Payment provider "${provider}" is not configured.`), { status: 501 });
  }
  return impl.createIntent({ bookingId, amountMinor, currency, meta });
}

/// Verify an inbound webhook payload. Same 501 contract when unconfigured.
export async function verifyGatewayWebhook({ provider, headers, body }) {
  const impl = providers.get(provider);
  if (!impl?.verifyWebhook) {
    throw Object.assign(new Error(`Payment provider "${provider}" is not configured.`), { status: 501 });
  }
  return impl.verifyWebhook({ headers, body });
}
