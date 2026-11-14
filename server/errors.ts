import { AtelierError } from "./config.js";

export interface Report {
  code: string;
  what: string;
  why: string;
  fix: string;
}

export function toReport(error: unknown): Report {
  if (error instanceof AtelierError) {
    return { code: error.code, what: error.message, why: error.why, fix: error.fix };
  }
  if (error instanceof Error) {
    return {
      code: "INTERNAL",
      what: error.message,
      why: "An unexpected error reached the process boundary.",
      fix: "Run `atelier doctor` and report the failure with the log.",
    };
  }
  return {
    code: "INTERNAL",
    what: String(error),
    why: "An unexpected value reached the process boundary.",
    fix: "Run `atelier doctor` and report the failure with the log.",
  };
}

export function printReport(error: unknown): number {
  const report = toReport(error);
  console.error(`What: ${report.what}`);
  console.error(`Why: ${report.why}`);
  console.error(`Fix: ${report.fix}`);
  if (error instanceof AtelierError) return error.exitCode;
  return 1;
}
