import crypto from "crypto";

export function createCohostToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function hashCohostToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function findAcceptedCohost(event, token) {
  if (!event || !token) return null;
  const hash = hashCohostToken(token);
  return (event.coHosts || []).find(
    (host) => host.status === "ACCEPTED" && host.salesTokenHash === hash,
  );
}

export function resolveSalesOrganizer(event, token) {
  if (!token) return event.organizer;
  const host = findAcceptedCohost(event, token);
  if (!host) {
    const error = new Error("Invalid or expired co-host sales link");
    error.status = 400;
    error.code = "INVALID_COHOST_LINK";
    throw error;
  }
  return host.organizer;
}

export function isEventSalesOrganizer(event, organizerId) {
  if (!event || !organizerId) return false;
  if (String(event.organizer) === String(organizerId)) return true;
  return Boolean(
    (event.coHosts || []).some(
      (host) =>
        host.status === "ACCEPTED" &&
        String(host.organizer) === String(organizerId),
    ),
  );
}

export function publicCohost(host) {
  return {
    _id: host._id,
    organizer: host.organizer,
    email: host.email,
    status: host.status,
    invitedAt: host.invitedAt,
    acceptedAt: host.acceptedAt,
    revokedAt: host.revokedAt,
  };
}
