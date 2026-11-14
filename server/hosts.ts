const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/i;
const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function split(hostHeader: string): { name: string; port: string | null } | null {
  const value = hostHeader.trim().toLowerCase();
  if (value.length === 0) return null;
  const bracket = /^(\[[^\]]*\])(?::(\d{1,5}))?$/.exec(value);
  if (bracket !== null) {
    const port = bracket[2];
    if (port !== undefined && Number(port) > 65_535) return null;
    return { name: bracket[1] ?? "", port: port ?? null };
  }
  const plain = /^([^:\s/@\[\]]+)(?::(\d{1,5}))?$/.exec(value);
  if (plain === null) return null;
  const port = plain[2];
  if (port !== undefined && Number(port) > 65_535) return null;
  return { name: (plain[1] ?? "").replace(/\.$/, ""), port: port ?? null };
}

function validIpv4(name: string): boolean {
  return IPV4.test(name) && name.split(".").every((part) => Number(part) <= 255);
}

/**
 * Whether a request's Host header names this machine rather than a DNS name an attacker controls.
 * A DNS-rebinding page reaches 127.0.0.1 under its own domain, so the Host it sends is that domain: refusing every
 * DNS name except localhost (and names the operator listed) stops it, while IP literals stay usable on a LAN.
 */
export function hostAllowed(hostHeader: string, allowed: string[]): boolean {
  const parsed = split(hostHeader);
  if (parsed === null) return false;
  const { name } = parsed;
  if (IPV6_LITERAL.test(name)) return true;
  if (validIpv4(name)) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  return allowed.includes(name);
}

/** `ATELIER_ALLOWED_HOSTS`: a comma list of plain host names. Anything else (wildcards, ports, paths) is dropped. */
export function parseAllowedHosts(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes(".") && DNS_NAME.test(entry) && !/^\d+(\.\d+)*$/.test(entry));
}
