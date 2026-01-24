import { getToken } from "./authService";

export async function scanTicket(code) {
  const res = await fetch(`${import.meta.env.VITE_API_URL}/api/tickets/scan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify({ code }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.message || "Scan failed");
  }

  return data;
}
