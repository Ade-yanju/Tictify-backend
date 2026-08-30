export const getEventTemplates = (req, res) => res.json([
  { id: "concert", name: "Concert", category: "Music", ticketTypes: [{ name: "Regular", price: 5000, quantity: 100 }, { name: "VIP", price: 15000, quantity: 30 }] },
  { id: "conference", name: "Conference", category: "Conference", ticketTypes: [{ name: "General Admission", price: 10000, quantity: 100 }, { name: "Early Bird", price: 7000, quantity: 50 }] },
  { id: "campus", name: "Campus Event", category: "Campus", ticketTypes: [{ name: "Student", price: 2000, quantity: 200 }, { name: "VIP", price: 5000, quantity: 20 }] },
  { id: "party", name: "Party", category: "Lifestyle", ticketTypes: [{ name: "Regular", price: 5000, quantity: 150 }, { name: "VIP", price: 12000, quantity: 30 }] },
]);
