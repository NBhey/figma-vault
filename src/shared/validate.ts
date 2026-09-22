import { readFile } from "node:fs/promises";
import { type ZodIssue, type ZodType } from "zod";

import {
  vaultDocumentSchema,
  vaultIndexSchema,
  type ValidVaultDocument,
  type ValidVaultIndex,
} from "./schema.js";

export class VaultValidationError extends Error {
  constructor(
    readonly source: string,
    readonly issues: ZodIssue[],
  ) {
    super(`Invalid vault data in ${source}: ${formatIssues(issues)}`);
    this.name = "VaultValidationError";
  }
}

function formatIssues(issues: ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
}

function validate<T>(schema: ZodType<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new VaultValidationError(source, result.error.issues);
  return result.data;
}

export function validateVaultDocument(value: unknown, source = "doc.json"): ValidVaultDocument {
  return validate(vaultDocumentSchema, value, source);
}

export function validateVaultIndex(value: unknown, source = "index.json"): ValidVaultIndex {
  return validate(vaultIndexSchema, value, source);
}

async function readJson(filePath: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${filePath}: ${message}`);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

export async function readVaultDocument(filePath: string): Promise<ValidVaultDocument> {
  return validateVaultDocument(await readJson(filePath), filePath);
}

export async function readVaultIndex(filePath: string): Promise<ValidVaultIndex> {
  return validateVaultIndex(await readJson(filePath), filePath);
}

