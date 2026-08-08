import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  classifyAddresses,
  formatConnectionLines,
  isGlobalIpv6Address,
  isPrivateLanAddress,
  isPublicIpv4Address,
  isTailscaleAddress,
  type LocalAddresses,
} from "./net.js";

describe("isTailscaleAddress", () => {
  it("accepts the CGNAT range Tailscale hands out", () => {
    assert.equal(isTailscaleAddress("100.101.102.103"), true);
    assert.equal(isTailscaleAddress("100.64.0.0"), true);
    assert.equal(isTailscaleAddress("100.127.255.255"), true);
  });

  it("rejects public addresses that merely start with 100", () => {
    // 100.0.0.0–100.63.255.255 and 100.128.0.0+ are ordinary public space.
    assert.equal(isTailscaleAddress("100.63.255.255"), false);
    assert.equal(isTailscaleAddress("100.128.0.1"), false);
  });
});

describe("isPrivateLanAddress", () => {
  it("accepts the RFC1918 ranges", () => {
    assert.equal(isPrivateLanAddress("192.168.1.20"), true);
    assert.equal(isPrivateLanAddress("10.0.0.5"), true);
    assert.equal(isPrivateLanAddress("172.16.0.1"), true);
    assert.equal(isPrivateLanAddress("172.31.255.254"), true);
  });

  it("rejects the public addresses either side of 172.16/12", () => {
    assert.equal(isPrivateLanAddress("172.15.0.1"), false);
    assert.equal(isPrivateLanAddress("172.32.0.1"), false);
  });
});

describe("isPublicIpv4Address", () => {
  it("accepts a routable address", () => {
    assert.equal(isPublicIpv4Address("203.0.113.7"), true);
    assert.equal(isPublicIpv4Address("49.36.180.22"), true);
  });

  it("rejects private, CGNAT and loopback space", () => {
    assert.equal(isPublicIpv4Address("192.168.1.20"), false);
    assert.equal(isPublicIpv4Address("10.1.2.3"), false);
    assert.equal(isPublicIpv4Address("172.20.0.1"), false);
    assert.equal(isPublicIpv4Address("100.101.102.103"), false);
    assert.equal(isPublicIpv4Address("127.0.0.1"), false);
  });

  it("rejects link-local, multicast and reserved space", () => {
    // 169.254 is what an interface holds when DHCP failed — it reaches nothing.
    assert.equal(isPublicIpv4Address("169.254.1.1"), false);
    assert.equal(isPublicIpv4Address("224.0.0.1"), false);
    assert.equal(isPublicIpv4Address("255.255.255.255"), false);
    assert.equal(isPublicIpv4Address("0.0.0.0"), false);
  });

  it("rejects malformed input", () => {
    assert.equal(isPublicIpv4Address("not.an.ip.at.all"), false);
    assert.equal(isPublicIpv4Address("1.2.3"), false);
    assert.equal(isPublicIpv4Address("300.1.1.1"), false);
  });
});

describe("isGlobalIpv6Address", () => {
  it("accepts global unicast (2000::/3)", () => {
    assert.equal(isGlobalIpv6Address("2405:201:1234:5678:abcd:ef01:2345:6789"), true);
    assert.equal(isGlobalIpv6Address("2001:db8::1"), true);
    assert.equal(isGlobalIpv6Address("3fff::1"), true);
  });

  it("rejects link-local, unique-local and loopback", () => {
    assert.equal(isGlobalIpv6Address("fe80::1"), false);
    assert.equal(isGlobalIpv6Address("FE80::1"), false);
    // Unique-local, including the fd7a:115c:a1e0::/48 block Tailscale uses.
    assert.equal(isGlobalIpv6Address("fd7a:115c:a1e0::1"), false);
    assert.equal(isGlobalIpv6Address("fc00::1"), false);
    assert.equal(isGlobalIpv6Address("::1"), false);
    assert.equal(isGlobalIpv6Address("ff02::1"), false); // multicast
  });

  it("rejects an address carrying a zone index", () => {
    // A scoped address is meaningless to a browser on another machine.
    assert.equal(isGlobalIpv6Address("fe80::1%en0"), false);
    assert.equal(isGlobalIpv6Address("2405:201::1%en0"), false);
  });

  it("rejects IPv4 and malformed input", () => {
    assert.equal(isGlobalIpv6Address("192.168.1.1"), false);
    assert.equal(isGlobalIpv6Address("nonsense"), false);
  });
});

describe("classifyAddresses", () => {
  const iface = (address: string, family: "IPv4" | "IPv6", internal = false) => ({
    address,
    family,
    internal,
  });

  it("sorts each address into the bucket it belongs to", () => {
    const result = classifyAddresses({
      lo0: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
      en0: [
        iface("192.168.1.20", "IPv4"),
        iface("fe80::14a6:2bff:fe12:3456", "IPv6"),
        iface("2405:201:1234:5678::42", "IPv6"),
      ],
      utun4: [iface("100.101.102.103", "IPv4"), iface("fd7a:115c:a1e0::1", "IPv6")],
    });

    assert.deepEqual(result.lan, ["192.168.1.20"]);
    assert.deepEqual(result.tailscale, ["100.101.102.103"]);
    assert.deepEqual(result.publicV4, []);
    assert.deepEqual(result.ipv6, ["2405:201:1234:5678::42"]);
  });

  it("reports a directly-assigned public IPv4 instead of discarding it", () => {
    // A VPS, or an ISP that doesn't NAT — the address is real and reachable,
    // and the old allowlist-of-private-ranges dropped it on the floor.
    const result = classifyAddresses({ eth0: [iface("203.0.113.7", "IPv4")] });
    assert.deepEqual(result.publicV4, ["203.0.113.7"]);
    assert.deepEqual(result.lan, []);
  });

  it("ignores internal and link-local addresses entirely", () => {
    const result = classifyAddresses({
      lo0: [iface("127.0.0.1", "IPv4", true)],
      en5: [iface("169.254.10.1", "IPv4"), iface("fe80::1", "IPv6")],
    });
    assert.deepEqual(result, { lan: [], tailscale: [], publicV4: [], ipv6: [] });
  });

  it("survives an interface with no addresses", () => {
    const result = classifyAddresses({ en0: undefined, en1: [] });
    assert.deepEqual(result, { lan: [], tailscale: [], publicV4: [], ipv6: [] });
  });

  it("de-duplicates an address that appears on two interfaces", () => {
    const result = classifyAddresses({
      en0: [iface("192.168.1.20", "IPv4")],
      bridge0: [iface("192.168.1.20", "IPv4")],
    });
    assert.deepEqual(result.lan, ["192.168.1.20"]);
  });
});

describe("formatConnectionLines", () => {
  const addrs = (over: Partial<LocalAddresses> = {}): LocalAddresses => ({
    lan: [],
    tailscale: [],
    publicV4: [],
    ipv6: [],
    ...over,
  });

  it("lists the private addresses with no exposure warning", () => {
    const lines = formatConnectionLines(
      addrs({ lan: ["192.168.1.20"], tailscale: ["100.101.102.103"] }),
      8443,
    );
    assert.deepEqual(lines, [
      "    LAN:       192.168.1.20:8443",
      "    Tailscale: 100.101.102.103:8443",
    ]);
    // Behind NAT nothing is exposed, so the warning must stay quiet — a
    // warning that shows on every machine is one nobody reads.
    assert.equal(lines.some((l) => l.includes("⚠")), false);
  });

  it("brackets an IPv6 literal so it can be pasted into a URL", () => {
    const lines = formatConnectionLines(addrs({ ipv6: ["2405:201:1234:5678::42"] }), 8443);
    assert.equal(lines[0], "    IPv6:      [2405:201:1234:5678::42]:8443");
  });

  it("warns when an address is reachable from the internet", () => {
    for (const a of [addrs({ publicV4: ["203.0.113.7"] }), addrs({ ipv6: ["2405:201::42"] })]) {
      const text = formatConnectionLines(a, 8443).join("\n");
      assert.match(text, /⚠ The addresses marked Internet\/IPv6 are reachable/);
      assert.match(text, /stopped only by the shared secret/);
    }
  });

  it("says so plainly when there is no usable address at all", () => {
    assert.deepEqual(formatConnectionLines(addrs(), 8443), [
      "    (no reachable IPv4/IPv6 address detected)",
    ]);
  });

  it("uses the configured port everywhere, not a hardcoded 8443", () => {
    const lines = formatConnectionLines(addrs({ lan: ["10.0.0.5"], ipv6: ["2001:db8::1"] }), 9000);
    assert.equal(lines[0], "    LAN:       10.0.0.5:9000");
    assert.equal(lines[1], "    IPv6:      [2001:db8::1]:9000");
  });
});
