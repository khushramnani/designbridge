import { describe, expect, it } from "vitest";
import { assertSafeUrl, BlockedUrlError, isBlockedIp, type DnsLookup } from "../src/ssrf.js";

describe("isBlockedIp", () => {
  it("blocks private, loopback, link-local, and metadata addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv4-mapped IPv6 to a private address", () => {
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  const publicLookup: DnsLookup = async () => ["93.184.216.34"];

  it("rejects non-https protocols", async () => {
    await expect(assertSafeUrl("http://example.com", publicLookup)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(assertSafeUrl("file:///etc/passwd", publicLookup)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it("rejects hosts that resolve to private ranges (DNS rebinding)", async () => {
    const rebind: DnsLookup = async () => ["10.0.0.5"];
    await expect(assertSafeUrl("https://evil.example", rebind)).rejects.toMatchObject({
      code: "nav_blocked",
    });
  });

  it("rejects literal private IP hosts without a DNS lookup", async () => {
    let looked = false;
    const lookup: DnsLookup = async () => {
      looked = true;
      return [];
    };
    await expect(
      assertSafeUrl("https://169.254.169.254/latest/meta-data", lookup),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    expect(looked).toBe(false);
  });

  it("allows a public https URL", async () => {
    const url = await assertSafeUrl("https://example.com/page", publicLookup);
    expect(url.hostname).toBe("example.com");
  });
});
