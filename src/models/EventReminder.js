import mongoose from "mongoose";
const schema = new mongoose.Schema({ event: { type: mongoose.Schema.Types.ObjectId, ref: "Event", unique: true }, sentAt: { type: Date, default: Date.now } });
export default mongoose.model("EventReminder", schema);
