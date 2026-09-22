import { z } from "zod";

const finiteNumber = z.number().finite();
const nonNegative = finiteNumber.nonnegative();
const cssColor = z
  .string()
  .regex(/^(?:#[0-9a-fA-F]{6}|rgba\([^\r\n]+\))$/, "expected #RRGGBB or rgba(...)");

export const vaultLayoutSchema = z.object({
  mode: z.enum(["none", "row", "column"]),
  x: finiteNumber,
  y: finiteNumber,
  w: nonNegative,
  h: nonNegative,
  gap: finiteNumber.optional(),
  padding: z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]).optional(),
  align: z.enum(["start", "center", "end", "stretch"]).optional(),
  justify: z.enum(["start", "center", "end", "between"]).optional(),
  grow: finiteNumber.optional(),
  wrap: z.boolean().optional(),
}).strict();

/**
 * Градиент описывается тремя ручками Figma, а не углом: у радиального угла нет.
 * Координаты нормализованы относительно рамки узла.
 */
const gradientPoint = z.object({ x: finiteNumber, y: finiteNumber }).strict();

export const vaultGradientSchema = z.object({
  type: z.enum(["linear", "radial", "angular", "diamond"]),
  handles: z.tuple([gradientPoint, gradientPoint, gradientPoint]),
  stops: z
    .array(z.object({ at: finiteNumber.min(0).max(1), color: cssColor }).strict())
    .min(1),
}).strict();

const paint = z.union([cssColor, vaultGradientSchema]);

export const vaultStyleSchema = z.object({
  fill: paint.optional(),
  stroke: paint.optional(),
  strokeWidth: nonNegative.optional(),
  radius: z.tuple([nonNegative, nonNegative, nonNegative, nonNegative]).optional(),
  opacity: finiteNumber.min(0).max(1).optional(),
  shadow: z.string().min(1).optional(),
  blur: nonNegative.optional(),
}).strict();

export const vaultTextSchema = z.object({
  content: z.string(),
  token: z.string().min(1).optional(),
  color: cssColor.optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  font: z.string().min(1).optional(),
  size: nonNegative.optional(),
  weight: finiteNumber.optional(),
  lineHeight: nonNegative.optional(),
  letterSpacing: finiteNumber.optional(),
}).strict();

export interface ValidVaultNode {
  id: string;
  name: string;
  type: "frame" | "text" | "image" | "vector" | "group" | "instance";
  component?: string;
  layout: z.infer<typeof vaultLayoutSchema>;
  style?: z.infer<typeof vaultStyleSchema>;
  text?: z.infer<typeof vaultTextSchema>;
  asset?: { path: string; w: number; h: number };
  children: ValidVaultNode[];
}

export const vaultNodeSchema: z.ZodType<ValidVaultNode> = z.lazy(() => z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.enum(["frame", "text", "image", "vector", "group", "instance"]),
  component: z.string().min(1).optional(),
  layout: vaultLayoutSchema,
  style: vaultStyleSchema.optional(),
  text: vaultTextSchema.optional(),
  asset: z.object({
    path: z.string().regex(/^assets\/[a-zA-Z0-9_.-]+\.(?:png|svg)$/),
    w: nonNegative,
    h: nonNegative,
  }).strict().optional(),
  children: z.array(vaultNodeSchema),
}).strict());

export const vaultTokensSchema = z.object({
  colors: z.record(cssColor),
  text: z.record(z.object({
    font: z.string().min(1).optional(),
    size: nonNegative.optional(),
    weight: finiteNumber.optional(),
    lineHeight: nonNegative.optional(),
    letterSpacing: finiteNumber.optional(),
  }).strict()),
  effects: z.record(z.string().min(1)),
}).strict();

export const vaultDocumentSchema = z.object({
  schema: z.literal("figma-vault/doc@0"),
  source: z.object({
    fileKey: z.string().min(1),
    nodeId: z.string().min(1),
    fileName: z.string(),
    nodeName: z.string(),
    exportedAt: z.string().datetime(),
    figmaVersion: z.string(),
  }).strict(),
  tokens: vaultTokensSchema,
  root: vaultNodeSchema,
}).strict();

export const vaultIndexEntrySchema = z.object({
  docId: z.string().min(1),
  fileKey: z.string().min(1),
  nodeId: z.string().min(1),
  fileName: z.string(),
  nodeName: z.string(),
  exportedAt: z.string().datetime(),
  nodeCount: z.number().int().nonnegative(),
}).strict();

export const vaultIndexSchema = z.object({
  schema: z.literal("figma-vault/index@0"),
  docs: z.array(vaultIndexEntrySchema),
}).strict();

export type ValidVaultDocument = z.infer<typeof vaultDocumentSchema>;
export type ValidVaultIndex = z.infer<typeof vaultIndexSchema>;

