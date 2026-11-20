import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import { transaction } from "../../../infrastructure/database/index.js";
import {
  catalogCategories,
  catalogProducts,
  catalogProperties,
  catalogPropertyValues,
  listingProperties,
} from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import { isUuid } from "../../../shared/validation.js";
import { audit } from "../../../infrastructure/database/index.js";
import { slugify } from "./catalog.service.js";


export const INPUT_TYPES = ["select", "number", "text"] as const;

const attributeInput = z.object({
  category_id: z.string().trim().min(1),
  product_id: z.string().trim().min(1).nullish(),
  name: z.string().trim().min(2).max(60),
  name_am: z.string().trim().max(60).nullish(),
  input_type: z.enum(INPUT_TYPES).default("select"),
  required: z.boolean().default(false),
});

const valueInput = z.object({
  name: z.string().trim().min(1).max(80),
  name_am: z.string().trim().max(80).nullish(),
  aliases: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});

const valueResponse = (value: typeof catalogPropertyValues.$inferSelect) => ({
  id: value.id,
  property_id: value.propertyId,
  key: value.key,
  name: value.name,
  name_am: value.nameAm,
  aliases: value.aliases,
  sort_order: value.sortOrder,
  active: value.active,
});

/** Every attribute with its values (list attributes only), in display order. */
export async function listAttributes(database: Database) {
  const attributes = await database
    .select()
    .from(catalogProperties)
    .orderBy(asc(catalogProperties.categoryId), asc(catalogProperties.sortOrder), asc(catalogProperties.name));
  const values = await database
    .select()
    .from(catalogPropertyValues)
    .orderBy(asc(catalogPropertyValues.sortOrder), asc(catalogPropertyValues.name));
  return attributes.map((attribute) => ({
    id: attribute.id,
    category_id: attribute.categoryId,
    product_id: attribute.productId,
    key: attribute.key,
    name: attribute.name,
    name_am: attribute.nameAm,
    input_type: attribute.inputType,
    required: attribute.required,
    sort_order: attribute.sortOrder,
    active: attribute.active,
    values: values.filter((value) => value.propertyId === attribute.id).map(valueResponse),
  }));
}

/** Adds an attribute to a category, or to one product in it. */
export async function createAttribute(database: Database, adminId: string, body: Record<string, unknown>) {
  const parsed = attributeInput.safeParse(body);
  if (!parsed.success)
    throw new ApiError(400, "invalid_attribute", "Give the attribute a category and a name of 2 to 60 characters.");
  const input = parsed.data;
  const productId = input.product_id || null;
  const key = slugify(productId ? `${productId.split("-").pop()}-${input.name}` : input.name);
  if (!key) throw new ApiError(400, "invalid_attribute", "The name needs at least one letter or digit.");

  const createdId = await transaction(database, async (tx) => {
    const [category] = await tx
      .select({ id: catalogCategories.id })
      .from(catalogCategories)
      .where(eq(catalogCategories.id, input.category_id));
    if (!category) throw new ApiError(404, "category_not_found", "Category not found.");
    if (productId) {
      const [product] = await tx
        .select({ id: catalogProducts.id })
        .from(catalogProducts)
        .where(and(eq(catalogProducts.id, productId), eq(catalogProducts.categoryId, category.id)));
      if (!product) throw new ApiError(404, "product_not_found", "That product is not in this category.");
    }
    const [taken] = await tx
      .select({ id: catalogProperties.id })
      .from(catalogProperties)
      .where(and(eq(catalogProperties.categoryId, category.id), eq(catalogProperties.key, key)));
    if (taken) throw new ApiError(409, "attribute_exists", "This commodity already has an attribute with that name.");
    const [sortRow] = await tx
      .select({ next: sql<number>`coalesce(max(${catalogProperties.sortOrder}), 0) + 1` })
      .from(catalogProperties)
      .where(eq(catalogProperties.categoryId, category.id));
    const [created] = await tx
      .insert(catalogProperties)
      .values({
        categoryId: category.id,
        productId,
        key,
        name: input.name,
        nameAm: input.name_am || null,
        inputType: input.input_type,
        required: input.required,
        sortOrder: sortRow?.next ?? 1,
      })
      .returning();
    await audit(tx, adminId, "attribute.created", "attribute", created!.id);
    return created!.id;
  });
  return (await listAttributes(database)).find((item) => item.id === createdId)!;
}

async function attributeInUse(database: Database, attributeId: string) {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(listingProperties)
    .where(eq(listingProperties.propertyId, attributeId));
  return (row?.count ?? 0) > 0;
}

/** Deletes an attribute and its values, unless listings already answered it. */
export async function deleteAttribute(database: Database, adminId: string, attributeId: string) {
  if (!isUuid(attributeId)) throw new ApiError(404, "attribute_not_found", "Attribute not found.");
  const [attribute] = await database
    .select({ id: catalogProperties.id })
    .from(catalogProperties)
    .where(eq(catalogProperties.id, attributeId));
  if (!attribute) throw new ApiError(404, "attribute_not_found", "Attribute not found.");
  if (await attributeInUse(database, attributeId))
    throw new ApiError(409, "attribute_in_use", "Listings use this attribute, so it cannot be deleted.");
  await transaction(database, async (tx) => {
    await tx.delete(catalogPropertyValues).where(eq(catalogPropertyValues.propertyId, attributeId));
    await tx.delete(catalogProperties).where(eq(catalogProperties.id, attributeId));
    await audit(tx, adminId, "attribute.deleted", "attribute", attributeId);
  });
  return { id: attributeId, deleted: true };
}

/** Adds a choice to a list attribute; other spellings help match imported listings. */
export async function createValue(
  database: Database,
  adminId: string,
  attributeId: string,
  body: Record<string, unknown>,
) {
  if (!isUuid(attributeId)) throw new ApiError(404, "attribute_not_found", "Attribute not found.");
  const parsed = valueInput.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_value", "Enter a value of 1 to 80 characters.");
  const input = parsed.data;
  const key = slugify(input.name);
  if (!key) throw new ApiError(400, "invalid_value", "The value needs at least one letter or digit.");

  return transaction(database, async (tx) => {
    const [attribute] = await tx
      .select({ id: catalogProperties.id, name: catalogProperties.name, inputType: catalogProperties.inputType })
      .from(catalogProperties)
      .where(eq(catalogProperties.id, attributeId));
    if (!attribute) throw new ApiError(404, "attribute_not_found", "Attribute not found.");
    if (attribute.inputType !== "select")
      throw new ApiError(400, "not_a_list", "Only list attributes have values.");
    const [taken] = await tx
      .select({ id: catalogPropertyValues.id })
      .from(catalogPropertyValues)
      .where(and(eq(catalogPropertyValues.propertyId, attributeId), eq(catalogPropertyValues.key, key)));
    if (taken)
      throw new ApiError(409, "value_exists", `${attribute.name} already has "${input.name}".`);
    const [sortRow] = await tx
      .select({ next: sql<number>`coalesce(max(${catalogPropertyValues.sortOrder}), 0) + 1` })
      .from(catalogPropertyValues)
      .where(eq(catalogPropertyValues.propertyId, attributeId));
    const [created] = await tx
      .insert(catalogPropertyValues)
      .values({
        propertyId: attributeId,
        key,
        name: input.name,
        nameAm: input.name_am || null,
        aliases: [...new Set(input.aliases.map((alias) => alias.toLowerCase()))],
        sortOrder: sortRow?.next ?? 1,
      })
      .returning();
    await audit(tx, adminId, "attribute_value.created", "attribute_value", created!.id);
    return valueResponse(created!);
  });
}

/** Removes a value no listing has chosen. */
export async function deleteValue(database: Database, adminId: string, valueId: string) {
  if (!isUuid(valueId)) throw new ApiError(404, "value_not_found", "Value not found.");
  const [value] = await database
    .select({ id: catalogPropertyValues.id })
    .from(catalogPropertyValues)
    .where(eq(catalogPropertyValues.id, valueId));
  if (!value) throw new ApiError(404, "value_not_found", "Value not found.");
  const [used] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(listingProperties)
    .where(eq(listingProperties.valueId, valueId));
  if ((used?.count ?? 0) > 0)
    throw new ApiError(409, "value_in_use", "Listings use this value, so it cannot be removed.");
  await transaction(database, async (tx) => {
    await tx.delete(catalogPropertyValues).where(eq(catalogPropertyValues.id, valueId));
    await audit(tx, adminId, "attribute_value.deleted", "attribute_value", valueId);
  });
  return { id: valueId, deleted: true };
}
