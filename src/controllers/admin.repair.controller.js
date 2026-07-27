/* =====================================================
   UNATTRIBUTED-SALE REPAIR
   A SUCCESS payment whose `event` no longer resolves to an
   existing Event is "unattributed": the sale is real (money
   moved, a guest holds a QR) but it points at a stale event
   id. Left alone it (a) shows as "Unknown/deleted" in admin,
   (b) leaves the real live event reporting fewer sales than
   it made, and (c) — worst — the guest's Ticket carries the
   same stale event id, so the gate scanner rejects it as
   "wrong event".

   This does NOT guess-move money: relinking is only ever
   allowed to an event owned by the SAME organizer the payment
   was already recorded against (payment.organizer is set at
   checkout from the event and is trustworthy). The admin
   confirms each link; we suggest the obvious match.
===================================================== */

import mongoose from "mongoose";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";
import User from "../models/User.js";
import { reconcileEventSold } from "../services/soldReconcile.service.js";
import { computeAvailability } from "../utils/availability.js";

const norm = (s) => String(s ?? "").trim().toLowerCase();

/* Events owned by this organizer that could plausibly own the sale:
   a tier name matching the payment's ticketType wins; LIVE ranks
   first, then most recent. */
function rankCandidates(events, ticketType) {
  const want = norm(ticketType);
  return events
    .map((e) => {
      const tierMatch = (e.ticketTypes || []).some((t) => norm(t.name) === want);
      return { e, tierMatch };
    })
    .sort((a, b) => {
      if (a.tierMatch !== b.tierMatch) return a.tierMatch ? -1 : 1;
      if ((a.e.status === "LIVE") !== (b.e.status === "LIVE"))
        return a.e.status === "LIVE" ? -1 : 1;
      return new Date(b.e.createdAt) - new Date(a.e.createdAt);
    });
}

/* GET /api/admin/unattributed-sales */
export const getUnattributedSales = async (req, res) => {
  try {
    const liveIds = new Set(
      (await Event.find({}, "_id")).map((e) => String(e._id)),
    );

    const success = await Payment.find({ status: "SUCCESS" }).sort("-createdAt");
    const orphans = success.filter((p) => !liveIds.has(String(p.event)));

    /* Pre-load each involved organizer's events once. */
    const orgIds = [...new Set(orphans.map((p) => String(p.organizer)))];
    const eventsByOrg = new Map();
    await Promise.all(
      orgIds.map(async (id) => {
        eventsByOrg.set(
          id,
          await Event.find({ organizer: id }).select(
            "title slug status ticketTypes createdAt",
          ),
        );
      }),
    );
    const organizers = await User.find({ _id: { $in: orgIds } }).select(
      "name email",
    );
    const orgName = new Map(organizers.map((u) => [String(u._id), u.name]));

    const rows = orphans.map((p) => {
      const evs = eventsByOrg.get(String(p.organizer)) || [];
      const ranked = rankCandidates(evs, p.ticketType);
      const suggested = ranked[0]?.tierMatch ? ranked[0].e : null;
      return {
        paymentId: p._id,
        reference: p.reference,
        snapshotTitle: p.eventTitle || "",
        staleEventRef: String(p.event),
        organizerId: p.organizer,
        organizerName: orgName.get(String(p.organizer)) || "Unknown",
        ticketType: p.ticketType,
        quantity: p.quantity || 1,
        amount: p.amount || 0,
        createdAt: p.createdAt,
        suggestedEvent: suggested
          ? { _id: suggested._id, title: suggested.title, status: suggested.status }
          : null,
        candidates: ranked.map(({ e }) => ({
          _id: e._id,
          title: e.title,
          status: e.status,
        })),
      };
    });

    res.json({ count: rows.length, sales: rows });
  } catch (err) {
    console.error("UNATTRIBUTED SALES ERROR:", err);
    res.status(500).json({ message: "Failed to load unattributed sales" });
  }
};

/* POST /api/admin/unattributed-sales/:paymentId/relink  { eventId } */
export const relinkSale = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { eventId } = req.body;
    if (!mongoose.isValidObjectId(paymentId) || !mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ message: "Invalid id" });
    }

    const payment = await Payment.findById(paymentId);
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    if (payment.status !== "SUCCESS") {
      return res.status(400).json({ message: "Only successful sales can be relinked" });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: "Target event not found" });

    /* SAFETY: never move a sale to another organizer's event — that
       would misattribute money. The payment's organizer is the truth. */
    if (String(event.organizer) !== String(payment.organizer)) {
      return res.status(400).json({
        message:
          "That event belongs to a different organizer — a sale can only be linked to its own organizer's event.",
      });
    }

    const from = String(payment.event);
    payment.event = event._id;
    payment.eventTitle = event.title;
    await payment.save();

    /* Repair the guest's ticket(s) too, or the gate scanner will still
       reject the QR as belonging to the wrong event. */
    const ticketRes = await Ticket.updateMany(
      { paymentRef: payment.reference },
      { $set: { event: event._id, organizer: event.organizer } },
    );

    /* Recount the target event so its sold/remaining reflect this sale. */
    const { drifts } = await reconcileEventSold(event);

    res.json({
      message: "Sale relinked",
      from,
      to: String(event._id),
      eventTitle: event.title,
      ticketsRepaired: ticketRes.modifiedCount ?? ticketRes.nModified ?? 0,
      drifts,
      availability: computeAvailability(event),
    });
  } catch (err) {
    console.error("RELINK SALE ERROR:", err);
    res.status(500).json({ message: "Relink failed" });
  }
};
