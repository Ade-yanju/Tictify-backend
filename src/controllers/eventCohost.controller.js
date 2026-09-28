import Event from "../models/Event.js";
import User from "../models/User.js";
import { findEventByIdOrSlug } from "../utils/resolveEvent.js";
import {
  createCohostToken,
  hashCohostToken,
  isEventSalesOrganizer,
  publicCohost,
} from "../services/eventCohost.service.js";

const FRONTEND = process.env.FRONTEND_URL || "https://www.tictify.ng";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function safeEvent(event) {
  return {
    _id: event._id,
    title: event.title,
    slug: event.slug,
    date: event.date,
    location: event.location,
    banner: event.banner,
    organizer: event.organizer,
  };
}

async function loadEventForOwner(id, ownerId) {
  const event = await findEventByIdOrSlug(id);
  if (!event) return { error: { status: 404, message: "Event not found" } };
  if (String(event.organizer) !== String(ownerId)) {
    return { error: { status: 403, message: "Only the event owner can manage co-hosts" } };
  }
  return { event };
}

async function loadEventWithSecrets(id) {
  const base = await findEventByIdOrSlug(id);
  if (!base) return null;
  return Event.findById(base._id).select(
    "+coHosts.inviteTokenHash +coHosts.salesTokenHash",
  );
}

function inviteUrl(token) {
  return `${FRONTEND}/organizer/cohost/accept/${token}`;
}

function salesUrl(event, token) {
  const key = event.slug || event._id;
  return `${FRONTEND}/events/${key}?host=${token}`;
}

export async function getCohostInvite(req, res) {
  try {
    const hash = hashCohostToken(req.params.token);
    const event = await Event.findOne({ "coHosts.inviteTokenHash": hash })
      .select("title slug date location banner organizer coHosts +coHosts.inviteTokenHash")
      .populate("organizer", "name avatar");
    const host = event?.coHosts?.find(
      (entry) => entry.inviteTokenHash === hash && entry.status === "PENDING",
    );
    if (!event || !host) {
      return res.status(410).json({ message: "This co-host invitation is no longer available." });
    }
    return res.json({
      event: safeEvent(event),
      invitedEmail: host.email,
      invitedBy: event.organizer,
      status: host.status,
    });
  } catch (error) {
    console.error("COHOST INVITE PREVIEW ERROR:", error);
    return res.status(500).json({ message: "Unable to load this invitation." });
  }
}

export async function inviteCohost(req, res) {
  try {
    const { event, error } = await loadEventForOwner(req.params.id, req.user._id);
    if (error) return res.status(error.status).json({ message: error.message });

    const email = normalizeEmail(req.body?.email);
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ message: "Enter a valid organizer email." });
    }

    const cohost = await User.findOne({ email, role: "organizer", isActive: true })
      .select("name email avatar");
    if (!cohost) {
      return res.status(404).json({ message: "That email does not belong to an active organizer." });
    }
    if (String(cohost._id) === String(req.user._id)) {
      return res.status(400).json({ message: "You cannot invite yourself as a co-host." });
    }

    const existing = event.coHosts?.find(
      (entry) => String(entry.organizer) === String(cohost._id),
    );
    if (existing?.status === "ACCEPTED") {
      return res.status(409).json({ message: "This organizer is already a co-host." });
    }

    const rawToken = createCohostToken();
    if (existing) {
      existing.status = "PENDING";
      existing.email = email;
      existing.inviteTokenHash = hashCohostToken(rawToken);
      existing.salesTokenHash = undefined;
      existing.invitedBy = req.user._id;
      existing.invitedAt = new Date();
      existing.acceptedAt = undefined;
      existing.revokedAt = undefined;
    } else {
      event.coHosts.push({
        organizer: cohost._id,
        email,
        status: "PENDING",
        inviteTokenHash: hashCohostToken(rawToken),
        invitedBy: req.user._id,
        invitedAt: new Date(),
      });
    }
    await event.save();
    const created = event.coHosts[event.coHosts.length - 1];
    const selected = existing || created;
    return res.status(existing ? 200 : 201).json({
      coHost: publicCohost(selected),
      organizer: cohost,
      inviteUrl: inviteUrl(rawToken),
    });
  } catch (error) {
    console.error("COHOST INVITE ERROR:", error);
    return res.status(500).json({ message: "Unable to create the co-host invitation." });
  }
}

export async function listCohosts(req, res) {
  try {
    const { event, error } = await loadEventForOwner(req.params.id, req.user._id);
    if (error) return res.status(error.status).json({ message: error.message });
    await event.populate("coHosts.organizer", "name email avatar");
    return res.json({
      event: safeEvent(event),
      coHosts: (event.coHosts || []).map(publicCohost),
    });
  } catch (error) {
    console.error("COHOST LIST ERROR:", error);
    return res.status(500).json({ message: "Unable to load co-hosts." });
  }
}

export async function regenerateInviteLink(req, res) {
  try {
    const { event, error } = await loadEventForOwner(req.params.id, req.user._id);
    if (error) return res.status(error.status).json({ message: error.message });
    const entry = event.coHosts?.id(req.params.cohostId);
    if (!entry || entry.status !== "PENDING") {
      return res.status(404).json({ message: "Pending co-host invitation not found." });
    }
    const rawToken = createCohostToken();
    entry.inviteTokenHash = hashCohostToken(rawToken);
    entry.invitedAt = new Date();
    await event.save();
    return res.json({ inviteUrl: inviteUrl(rawToken) });
  } catch (error) {
    console.error("COHOST INVITE REGENERATE ERROR:", error);
    return res.status(500).json({ message: "Unable to regenerate the invitation." });
  }
}

export async function acceptCohostInvite(req, res) {
  try {
    const event = await loadEventWithSecrets(req.params.token);
    const hash = hashCohostToken(req.params.token);
    const entry = event?.coHosts?.find(
      (candidate) => candidate.inviteTokenHash === hash && candidate.status === "PENDING",
    );
    if (!event || !entry) {
      return res.status(410).json({ message: "This co-host invitation is no longer available." });
    }
    if (String(entry.organizer) !== String(req.user._id)) {
      return res.status(403).json({ message: "This invitation was sent to another organizer." });
    }

    const rawSalesToken = createCohostToken();
    entry.status = "ACCEPTED";
    entry.acceptedAt = new Date();
    entry.inviteTokenHash = undefined;
    entry.salesTokenHash = hashCohostToken(rawSalesToken);
    await event.save();

    return res.json({
      message: "You are now a co-host for this event.",
      event: safeEvent(event),
      salesUrl: salesUrl(event, rawSalesToken),
    });
  } catch (error) {
    console.error("COHOST ACCEPT ERROR:", error);
    return res.status(500).json({ message: "Unable to accept this invitation." });
  }
}

export async function generateCohostSalesLink(req, res) {
  try {
    const event = await loadEventWithSecrets(req.params.id);
    if (!event) return res.status(404).json({ message: "Event not found" });
    const canManage = String(event.organizer) === String(req.user._id);
    const entry = event.coHosts?.id(req.params.cohostId);
    if (!entry || entry.status !== "ACCEPTED") {
      return res.status(404).json({ message: "Accepted co-host not found." });
    }
    if (!canManage && String(entry.organizer) !== String(req.user._id)) {
      return res.status(403).json({ message: "You cannot generate this sales link." });
    }
    const rawSalesToken = createCohostToken();
    entry.salesTokenHash = hashCohostToken(rawSalesToken);
    await event.save();
    return res.json({ salesUrl: salesUrl(event, rawSalesToken) });
  } catch (error) {
    console.error("COHOST SALES LINK ERROR:", error);
    return res.status(500).json({ message: "Unable to create the sales link." });
  }
}

export async function revokeCohost(req, res) {
  try {
    const { event, error } = await loadEventForOwner(req.params.id, req.user._id);
    if (error) return res.status(error.status).json({ message: error.message });
    const entry = event.coHosts?.id(req.params.cohostId);
    if (!entry) return res.status(404).json({ message: "Co-host not found." });
    entry.status = "REVOKED";
    entry.inviteTokenHash = undefined;
    entry.salesTokenHash = undefined;
    entry.revokedAt = new Date();
    await event.save();
    return res.json({ message: "Co-host access revoked." });
  } catch (error) {
    console.error("COHOST REVOKE ERROR:", error);
    return res.status(500).json({ message: "Unable to revoke this co-host." });
  }
}
