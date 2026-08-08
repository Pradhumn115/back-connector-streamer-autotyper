import { networkInterfaces } from "node:os";

export interface LocalAddresses {
  /** Private-LAN IPv4 addresses (192.168/10/172.16-31). */
  lan: string[];
  /** Tailscale / CGNAT IPv4 addresses (100.64.0.0/10). */
  tailscale: string[];
  /**
   * Publicly routable IPv4 addresses assigned directly to an interface.
   *
   * Empty on the usual home setup: behind a router this machine only ever
   * holds the private address DHCP gave it, and the public address lives on
   * the router's WAN interface — a different device this process cannot see.
   * Non-empty on a VPS, or an ISP that hands out a real address without NAT.
   */
  publicV4: string[];
  /**
   * Globally routable IPv6 addresses (2000::/3).
   *
   * Worth surfacing because IPv6 has no NAT: on a dual-stack connection this
   * address belongs to the machine itself and is reachable from the internet
   * directly, with no port-forward — subject only to the firewall in front
   * of it. That makes it the one address here that can work remotely without
   * Tailscale or a tunnel, and equally the one that needs a warning.
   */
  ipv6: string[];
}

/** Parse an IPv4 string into its four octets, or null if it isn't one. */
function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

/** True if an IPv4 string is in the CGNAT range Tailscale uses (100.64.0.0/10). */
export function isTailscaleAddress(ip: string): boolean {
  const octets = ipv4Octets(ip);
  if (!octets) return false;
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

/** True if an IPv4 string is in a private LAN range (RFC1918). */
export function isPrivateLanAddress(ip: string): boolean {
  const octets = ipv4Octets(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * True if an IPv4 string is one the outside world could route to.
 *
 * Defined by exclusion rather than as an allowlist: everything that isn't
 * private, carrier-NAT, loopback, link-local, multicast or reserved is public.
 * The reverse — listing the public ranges — is what used to make a real public
 * address fall through every branch and get dropped.
 */
export function isPublicIpv4Address(ip: string): boolean {
  const octets = ipv4Octets(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (isPrivateLanAddress(ip) || isTailscaleAddress(ip)) return false;
  if (a === 0 || a === 127) return false; // "this network" and loopback
  if (a === 169 && b === 254) return false; // link-local: DHCP failed
  if (a >= 224) return false; // multicast (224/4) and reserved (240/4)
  return true;
}

/**
 * True if an IPv6 string is global unicast (2000::/3) and usable in a URL.
 *
 * Everything else on a typical interface is unreachable from another machine:
 * link-local (fe80::/10) is per-interface, unique-local (fc00::/7) is the v6
 * equivalent of RFC1918 — and is where Tailscale's own v6 addresses live —
 * and a zone index (`%en0`) is meaningful only on the host that printed it.
 */
export function isGlobalIpv6Address(ip: string): boolean {
  if (ip.includes("%")) return false;
  if (!ip.includes(":")) return false;
  const first = Number.parseInt(ip.split(":")[0] || "", 16);
  if (!Number.isInteger(first)) return false;
  return first >= 0x2000 && first <= 0x3fff;
}

/** The shape of `os.networkInterfaces()`, narrowed to what classification needs. */
type InterfaceAddress = { address: string; family: string | number; internal: boolean };
type InterfaceMap = Record<string, InterfaceAddress[] | undefined>;

/**
 * Sort a set of interface addresses into the buckets the banner prints.
 *
 * Split out from `localAddresses()` so the classification can be tested
 * against fabricated interfaces — the real ones vary by machine, so a test
 * that read them could only assert things that are true of every network.
 */
export function classifyAddresses(ifaces: InterfaceMap): LocalAddresses {
  const lan = new Set<string>();
  const tailscale = new Set<string>();
  const publicV4 = new Set<string>();
  const ipv6 = new Set<string>();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      // Node reports the family as "IPv4"/"IPv6"; older versions used 4/6.
      const isV4 = a.family === "IPv4" || a.family === 4;
      if (isV4) {
        if (isTailscaleAddress(a.address)) tailscale.add(a.address);
        else if (isPrivateLanAddress(a.address)) lan.add(a.address);
        else if (isPublicIpv4Address(a.address)) publicV4.add(a.address);
      } else if (isGlobalIpv6Address(a.address)) {
        ipv6.add(a.address);
      }
    }
  }
  return {
    lan: [...lan],
    tailscale: [...tailscale],
    publicV4: [...publicV4],
    ipv6: [...ipv6],
  };
}

/** Enumerate this machine's reachable IPv4 and IPv6 addresses for display. */
export function localAddresses(): LocalAddresses {
  return classifyAddresses(networkInterfaces());
}

/**
 * The "connect using one of…" block of the startup banner.
 *
 * Lives here, next to the classification it renders, so the exposure warning
 * can be tested — on a NAT'd developer machine the branch that emits it never
 * runs, which is exactly the branch worth getting right.
 *
 * The router's public IPv4 is deliberately not among these. It belongs to the
 * router rather than to this machine — no API here can even read it — and
 * without a port-forward nothing reaches the agent through it, so printing it
 * would offer an address that cannot work.
 */
export function formatConnectionLines(a: LocalAddresses, port: number): string[] {
  const lines: string[] = [];
  for (const ip of a.lan) lines.push(`    LAN:       ${ip}:${port}`);
  for (const ip of a.tailscale) lines.push(`    Tailscale: ${ip}:${port}`);
  for (const ip of a.publicV4) lines.push(`    Internet:  ${ip}:${port}`);
  // An IPv6 literal must be bracketed in a URL, or the colons read as a port.
  for (const ip of a.ipv6) lines.push(`    IPv6:      [${ip}]:${port}`);
  if (lines.length === 0) lines.push("    (no reachable IPv4/IPv6 address detected)");
  if (a.publicV4.length > 0 || a.ipv6.length > 0) {
    lines.push("");
    lines.push("  ⚠ The addresses marked Internet/IPv6 are reachable from the public");
    lines.push("    internet — there is no NAT in front of them. Anyone who reaches");
    lines.push("    this port is stopped only by the shared secret above, so keep it");
    lines.push("    strong, or firewall the port and use Tailscale instead.");
  }
  return lines;
}
