import { FigmaApiError, type FigmaClient } from "./client.js";
import type { FigmaNode } from "./types.js";

/** Что считается экраном среди детей SECTION/CANVAS. */
const SCREEN_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);
export const CONTAINER_TYPES = new Set(["SECTION", "CANVAS"]);
/** Сколько уровней вложенных SECTION обходить: каждый уровень — ещё один вызов `/nodes`. */
const MAX_NESTING = 3;
export const DEFAULT_MAX_SCREENS = 20;

function listIds(ids: string[]): string {
  return `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", …" : ""}`;
}

/** Не сбой, а отчёт: часть экранов контейнера сознательно не выгружена. */
export class ScreensSkippedError extends Error {
  readonly skipped: string[];

  constructor(readonly containerId: string, expansion: ContainerExpansion, maxScreens: number) {
    const parts: string[] = [];
    if (expansion.overLimit.length > 0) {
      parts.push(
        `${expansion.overLimit.length} screen(s) beyond the limit of ${maxScreens} per run ` +
          `were not exported: ${listIds(expansion.overLimit)}`,
      );
    }
    if (expansion.tooDeep.length > 0) {
      parts.push(
        `${expansion.tooDeep.length} nested section(s) were not expanded: ${listIds(expansion.tooDeep)}`,
      );
    }
    super(`${containerId}: ${parts.join("; ")}. Pass their links explicitly or raise the screen limit.`);
    this.name = "ScreensSkippedError";
    this.skipped = [...expansion.overLimit, ...expansion.tooDeep];
  }
}

export interface ContainerExpansion {
  /** Экраны в визуальном порядке: сверху вниз, слева направо. */
  screens: string[];
  /** Уже переданы явной ссылкой или найдены в другом контейнере. */
  repeated: string[];
  overLimit: string[];
  /** SECTION глубже `MAX_NESTING` или без ответа на обзор. */
  tooDeep: string[];
}

function visualOrder(a: FigmaNode, b: FigmaNode): number {
  const boxA = a.absoluteBoundingBox;
  const boxB = b.absoluteBoundingBox;
  if (!boxA || !boxB) return 0;
  return boxA.y - boxB.y || boxA.x - boxB.x;
}

/**
 * Обзор узлов с `depth=1`. Отказ пачки, кроме 401/403/429, делит её пополам,
 * чтобы один плохой id не лишил обзора остальные.
 */
async function outline(
  client: FigmaClient,
  fileKey: string,
  ids: string[],
  found: Map<string, FigmaNode>,
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const response = await client.getNodes(fileKey, ids, { depth: 1 });
    for (const id of ids) {
      const node = response.nodes?.[id]?.document;
      if (node) found.set(id, node);
    }
  } catch (error) {
    // Сеть, доступ и лимит пачкой не лечатся — отдаём наверх, иначе дробление сожжёт лимит.
    if (!(error instanceof FigmaApiError) || [401, 403, 429].includes(error.status ?? 0)) throw error;
    // Отказ по одному id сообщит обычная выгрузка этого узла.
    if (ids.length === 1) return;
    const midpoint = Math.floor(ids.length / 2);
    await outline(client, fileKey, ids.slice(0, midpoint), found);
    await outline(client, fileKey, ids.slice(midpoint), found);
  }
}

/**
 * Раскрывает переданные узлы одного файла. Не-контейнеры и узлы, которых нет
 * в обзоре, в результат не попадают: их выгрузка идёт обычным путём и там же
 * получает свою ошибку. `taken` — уже занятые экраны, пополняется по ходу.
 */
export async function expandContainers(
  client: FigmaClient,
  fileKey: string,
  nodeIds: string[],
  maxScreens: number,
  taken: Set<string>,
): Promise<Map<string, ContainerExpansion>> {
  const nodes = new Map<string, FigmaNode>();
  await outline(client, fileKey, nodeIds, nodes);

  const containers = nodeIds.filter((id) => CONTAINER_TYPES.has(nodes.get(id)?.type ?? ""));
  const sectionsAt = new Map<string, number>();
  let pending = containers;
  for (let level = 1; level <= MAX_NESTING && pending.length > 0; level += 1) {
    const next: string[] = [];
    for (const id of pending) {
      for (const child of nodes.get(id)?.children ?? []) {
        if (child.visible === false || child.type !== "SECTION" || sectionsAt.has(child.id)) continue;
        sectionsAt.set(child.id, level);
        if (level < MAX_NESTING) next.push(child.id);
      }
    }
    await outline(client, fileKey, next, nodes);
    pending = next;
  }

  const result = new Map<string, ContainerExpansion>();
  let budget = Math.max(0, Math.floor(maxScreens));
  const walk = (id: string, into: ContainerExpansion): void => {
    const children = [...(nodes.get(id)?.children ?? [])]
      .filter((child) => child.visible !== false)
      .sort(visualOrder);
    for (const child of children) {
      if (child.type === "SECTION") {
        if (nodes.has(child.id)) walk(child.id, into);
        else into.tooDeep.push(child.id);
      } else if (SCREEN_TYPES.has(child.type)) {
        if (taken.has(child.id)) {
          into.repeated.push(child.id);
          continue;
        }
        taken.add(child.id);
        if (budget > 0) {
          into.screens.push(child.id);
          budget -= 1;
        } else {
          into.overLimit.push(child.id);
        }
      }
    }
  };
  for (const id of containers) {
    const expansion: ContainerExpansion = { screens: [], repeated: [], overLimit: [], tooDeep: [] };
    walk(id, expansion);
    result.set(id, expansion);
  }
  return result;
}
