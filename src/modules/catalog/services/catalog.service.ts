import { and, asc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import { transaction } from "../../../infrastructure/database/index.js";
import {
  catalogCategories,
  catalogProducts,
  catalogProperties,
  listings,
} from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import { audit } from "../../admin/services/audit.service.js";

/** "White Sesame (Humera)" → "white-sesame-humera". */
export function slugify(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export const PRODUCT_UNITS = ["Quintal", "MT", "kg", "Bag", "Piece"] as const;

const productInput = z.object({
  category_id: z.string().trim().min(1),
  name: z.string().trim().min(2).max(100),
  name_am: z.string().trim().max(100).nullish(),
  key: z.string().trim().max(60).nullish(),
  sort_order: z.number().int().min(0).max(10_000).optional(),
  unit: z.enum(PRODUCT_UNITS).optional(),
  description: z.string().trim().max(1000).optional(),
});

const productUpdate = z
  .object({
    name: z.string().trim().min(2).max(100),
    name_am: z.string().trim().max(100).nullable(),
    sort_order: z.number().int().min(0).max(10_000),
    active: z.boolean(),
    unit: z.enum(PRODUCT_UNITS),
    description: z.string().trim().max(1000),
  })
  .partial();

/** Listings that use a product, matched by catalog id or by category and key. */
const usesProduct = (productId: string, categoryId: string, key: string) =>
  or(
    eq(listings.productId, productId),
    and(eq(listings.category, categoryId), eq(listings.product, key)),
  );

/**
 * Categories with their products, in display order. The public catalog holds
 * only active entries; staff also see retired ones and how many listings use each.
 */
export async function listCatalog(database: Database, { staff = false } = {}) {
  const categories = await database
    .select()
    .from(catalogCategories)
    .where(staff ? undefined : eq(catalogCategories.active, true))
    .orderBy(asc(catalogCategories.sortOrder), asc(catalogCategories.name));
  const products = await database
    .select({
      id: catalogProducts.id,
      categoryId: catalogProducts.categoryId,
      key: catalogProducts.key,
      name: catalogProducts.name,
      nameAm: catalogProducts.nameAm,
      sortOrder: catalogProducts.sortOrder,
      active: catalogProducts.active,
      unit: catalogProducts.unit,
      description: catalogProducts.description,
      createdAt: catalogProducts.createdAt,
      listingCount: staff
        ? // Qualified by hand: inside a subquery a bare "id" would mean the listing's.
          sql<number>`(select count(*)::int from listings l where l.product_id = "catalog_products"."id" or (l.category = "catalog_products"."category_id" and l.product = "catalog_products"."key"))`
        : sql<number>`0`,
    })
    .from(catalogProducts)
    .where(staff ? undefined : eq(catalogProducts.active, true))
    .orderBy(asc(catalogProducts.sortOrder), asc(catalogProducts.name));

  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    name_am: category.nameAm,
    sort_order: category.sortOrder,
    active: category.active,
    products: products
      .filter((product) => product.categoryId === category.id)
      .map((product) => ({
        id: product.id,
        key: product.key,
        name: product.name,
        name_am: product.nameAm,
        sort_order: product.sortOrder,
        active: product.active,
        unit: product.unit,
        description: product.description,
        ...(staff
          ? { listing_count: product.listingCount, created_at: product.createdAt.toISOString() }
          : {}),
      })),
  }));
}

async function findProduct(database: Database, productId: string) {
  const [product] = await database
    .select()
    .from(catalogProducts)
    .where(eq(catalogProducts.id, productId));
  if (!product) throw new ApiError(404, "product_not_found", "Product not found.");
  return product;
}

const toResponse = (product: typeof catalogProducts.$inferSelect) => ({
  id: product.id,
  category_id: product.categoryId,
  key: product.key,
  name: product.name,
  name_am: product.nameAm,
  sort_order: product.sortOrder,
  active: product.active,
  unit: product.unit,
  description: product.description,
  created_at: product.createdAt.toISOString(),
});

/** Adds a product to a category. Its key, used in listings, never changes afterwards. */
export async function createProduct(
  database: Database,
  adminId: string,
  body: Record<string, unknown>,
) {
  const parsed = productInput.safeParse(body);
  if (!parsed.success)
    throw new ApiError(400, "invalid_product", "Give the product a category and a name of 2 to 100 characters.");
  const input = parsed.data;
  const key = slugify(input.key || input.name);
  if (!key) throw new ApiError(400, "invalid_product", "The name needs at least one letter or digit.");

  return transaction(database, async (tx) => {
    const [category] = await tx
      .select({ id: catalogCategories.id })
      .from(catalogCategories)
      .where(eq(catalogCategories.id, input.category_id));
    if (!category) throw new ApiError(404, "category_not_found", "Category not found.");
    const [taken] = await tx
      .select({ id: catalogProducts.id })
      .from(catalogProducts)
      .where(and(eq(catalogProducts.categoryId, category.id), eq(catalogProducts.key, key)));
    if (taken)
      throw new ApiError(409, "product_exists", "This category already has a product with that name.");
    const [sortRow] = await tx
      .select({ next: sql<number>`coalesce(max(${catalogProducts.sortOrder}), 0) + 1` })
      .from(catalogProducts)
      .where(eq(catalogProducts.categoryId, category.id));
    const [created] = await tx
      .insert(catalogProducts)
      .values({
        id: `${category.id}-${key}`.slice(0, 120),
        categoryId: category.id,
        key,
        name: input.name,
        nameAm: input.name_am || null,
        sortOrder: input.sort_order ?? sortRow?.next ?? 1,
        unit: input.unit ?? "Quintal",
        description: input.description ?? "",
      })
      .returning();
    await audit(tx, adminId, "product.created", "product", created!.id);
    return toResponse(created!);
  });
}

/** Renames, reorders, retires or restores a product. Retired products stay on old listings. */
export async function updateProduct(
  database: Database,
  adminId: string,
  productId: string,
  body: Record<string, unknown>,
) {
  const parsed = productUpdate.safeParse(body);
  if (!parsed.success || Object.keys(parsed.data).length === 0)
    throw new ApiError(400, "invalid_product", "Provide a name, Amharic name, unit, description, order or active flag.");
  const input = parsed.data;
  await findProduct(database, productId);
  return transaction(database, async (tx) => {
    const [updated] = await tx
      .update(catalogProducts)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.name_am === undefined ? {} : { nameAm: input.name_am || null }),
        ...(input.sort_order === undefined ? {} : { sortOrder: input.sort_order }),
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(input.unit === undefined ? {} : { unit: input.unit }),
        ...(input.description === undefined ? {} : { description: input.description }),
        updatedAt: new Date(),
      })
      .where(eq(catalogProducts.id, productId))
      .returning();
    await audit(
      tx,
      adminId,
      input.active === false ? "product.retired" : "product.updated",
      "product",
      productId,
    );
    return toResponse(updated!);
  });
}

/** Deletes a product no listing or property uses; otherwise retire it instead. */
export async function deleteProduct(database: Database, adminId: string, productId: string) {
  const product = await findProduct(database, productId);
  const [used] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(listings)
    .where(usesProduct(product.id, product.categoryId, product.key));
  const [properties] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(catalogProperties)
    .where(eq(catalogProperties.productId, product.id));
  if ((used?.count ?? 0) > 0 || (properties?.count ?? 0) > 0)
    throw new ApiError(409, "product_in_use", "Listings use this product. Retire it instead so they keep their history.");
  await transaction(database, async (tx) => {
    await tx.delete(catalogProducts).where(eq(catalogProducts.id, productId));
    await audit(tx, adminId, "product.deleted", "product", productId);
  });
  return { id: productId, deleted: true };
}

/**
 * The active catalog product a new listing names, by key or by name in any
 * case, so "Export Coffee" and "export-coffee" both resolve.
 */
export async function resolveProduct(database: Database, categoryId: string, product: string) {
  const [match] = await database
    .select({ id: catalogProducts.id, key: catalogProducts.key, active: catalogProducts.active })
    .from(catalogProducts)
    .where(
      and(
        eq(catalogProducts.categoryId, categoryId),
        or(
          eq(catalogProducts.key, product),
          sql`lower(${catalogProducts.name}) = lower(${product})`,
        ),
      ),
    );
  return match ?? null;
}
