import { networkInterfaces } from "node:os";

export interface LocalAddresses {
  /** Private-LAN IPv4 addresses (192.168/10/172.16-31). */
  lan: string[];
  /** Tailscale / CGNAT IPv4 addresses (100.64.0.0/10). */
  tailscale: string[];
}

/** True if an IPv4 string is in the CGNAT range Tailscale uses (100.64.0.0/10). */
export function isTailscaleAddress(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

/** True if an IPv4 string is in a private LAN range (RFC1918). */
export function isPrivateLanAddress(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** Enumerate this machine's LAN and Tailscale IPv4 addresses for display. */
export function localAddresses(): LocalAddresses {
  const lan: string[] = [];
  const tailscale: string[] = [];
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (isTailscaleAddress(a.address)) tailscale.push(a.address);
      else if (isPrivateLanAddress(a.address)) lan.push(a.address);
    }
  }
  return { lan, tailscale };
}
