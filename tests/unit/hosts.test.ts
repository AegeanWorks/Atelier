import { describe, expect, it } from "vitest";
import { hostAllowed, parseAllowedHosts } from "../../server/hosts";

describe("hostAllowed", () => {
  it("accepts localhost, loopback and any IP literal, with or without a port", () => {
    for (const host of ["localhost", "localhost:4317", "LOCALHOST:4317", "localhost.", "app.localhost:4317", "127.0.0.1", "127.0.0.1:5173", "0.0.0.0:4317", "192.168.1.20:4317", "[::1]:4317", "[::1]", "[fe80::1]:4317"]) {
      expect(hostAllowed(host, []), host).toBe(true);
    }
  });

  it("rejects every other DNS name, which is what a rebinding attack has to use", () => {
    for (const host of ["evil.example", "evil.example:4317", "127.0.0.1.evil.example:4317", "localhost.evil.example", "evillocalhost", "notlocalhost:4317", "a.b.c", "example.com"]) {
      expect(hostAllowed(host, []), host).toBe(false);
    }
  });

  it("rejects an empty or malformed Host header", () => {
    for (const host of ["", "   ", ":4317", "[::1", "999.1.1.1.1", "local host", "localhost:abc", "localhost:99999", "@evil.example", "evil.example/@localhost", "localhost@evil.example"]) {
      expect(hostAllowed(host, []), host).toBe(false);
    }
  });

  it("accepts a name the operator listed, ignoring case and port", () => {
    expect(hostAllowed("atelier.internal:8443", ["atelier.internal"])).toBe(true);
    expect(hostAllowed("ATELIER.Internal", ["atelier.internal"])).toBe(true);
    expect(hostAllowed("other.internal", ["atelier.internal"])).toBe(false);
  });
});

describe("parseAllowedHosts", () => {
  it("splits a comma list, trims, lowercases and drops blanks", () => {
    expect(parseAllowedHosts(" Atelier.Internal , ,box.lan ")).toEqual(["atelier.internal", "box.lan"]);
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
  });

  it("drops entries that are not plain host names, so a typo cannot open the door", () => {
    expect(parseAllowedHosts("good.lan,*,*.com,evil.example/path,user@host,host:99")).toEqual(["good.lan"]);
  });
});
