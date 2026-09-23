import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Демо-макет едет внутри пакета. Он нужен, чтобы проверить всю цепочку
 * на машине, где нет и не может быть токена Figma.
 */
function packagedExample(): string {
  // dist/cli/demo.js → корень пакета; в dev через tsx: src/cli/demo.ts → корень репозитория.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "vault", "example");
}

interface IndexFile {
  schema: string;
  docs: { docId: string; [key: string]: unknown }[];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function runDemo(cwd: string, vaultDir: string): Promise<void> {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const source = packagedExample();

  const sourceIndex = await readJson<IndexFile>(path.join(source, "index.json"));
  if (!sourceIndex || sourceIndex.docs.length === 0) {
    throw new Error(
      `The demo design is not next to the package (${source}).\n` +
        "If the package came from npm, the vault/example directory may be missing from the build.",
    );
  }

  const target = path.resolve(cwd, vaultDir);
  await mkdir(target, { recursive: true });

  for (const doc of sourceIndex.docs) {
    await cp(path.join(source, doc.docId), path.join(target, doc.docId), { recursive: true });
    out(`Design copied: ${doc.docId}`);
  }

  // Индекс сливаем, чтобы не затереть уже выгруженные макеты.
  const existing = (await readJson<IndexFile>(path.join(target, "index.json"))) ?? {
    schema: sourceIndex.schema,
    docs: [],
  };
  const byId = new Map(existing.docs.map((d) => [d.docId, d]));
  for (const doc of sourceIndex.docs) byId.set(doc.docId, doc);
  await writeFile(
    path.join(target, "index.json"),
    `${JSON.stringify({ schema: sourceIndex.schema, docs: [...byId.values()] }, null, 2)}\n`,
    "utf8",
  );

  out("");
  out(`The demo design is in ${vaultDir}/ — no Figma token needed for it.`);
  out("Check the whole chain:  npx figma-vault check");
}
